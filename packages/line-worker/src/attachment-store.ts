import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ChatType = "direct" | "group" | "room";

export interface AttachmentIdentity {
  readonly accountId: string;
  readonly chatType: ChatType;
  readonly chatId: string;
  readonly messageId: string;
  readonly externalAttachmentId: string;
}

export interface AttachmentLocation {
  readonly managedRelativePath: string;
  readonly absolutePath: string;
  readonly directoryAbsolutePath: string;
  readonly storedFileName: string;
  readonly sanitizedDisplayFileName: string;
}

export interface StoreAttachmentInput {
  readonly root: string;
  readonly identity: AttachmentIdentity;
  readonly occurredAt: Date | string;
  readonly originalFileName: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface StoredAttachment extends AttachmentLocation {
  readonly sha256: string;
  readonly size: number;
  readonly idempotent: boolean;
}

export const REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES = Object.freeze({
  rootHandleAnchored: true,
  rejectsReparsePoints: true,
  publishNoReplace: true,
} as const);

/**
 * Windows implementation boundary. A production implementation MUST open the
 * configured root as a directory handle, reject reparse points for every
 * relative component, create the temporary file relative to that handle, and
 * publish no-replace relative to the same handle. Path-based pre-checks do not
 * satisfy this contract.
 */
export interface AttachmentFilesystemSafetyBroker {
  readonly guarantees: typeof REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES;
  storeAnchored(request: AnchoredAttachmentStoreRequest): Promise<{
    readonly sha256: string;
    readonly size: number;
    readonly idempotent: boolean;
  }>;
}

export interface AnchoredAttachmentStoreRequest {
  readonly root: string;
  readonly directorySegments: readonly string[];
  readonly targetFileName: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly requiredGuarantees: typeof REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES;
}

export interface AttachmentStoreRuntime {
  readonly windowsSafetyBroker?: AttachmentFilesystemSafetyBroker;
  /** Honored only under Vitest and never when NODE_ENV=production. */
  readonly unsafeAllowPortableFilesystemOnWindowsForTests?: boolean;
}

export type AttachmentStoreErrorCode =
  | "INVALID_ROOT"
  | "INVALID_ID"
  | "INVALID_FILENAME"
  | "INVALID_DATE"
  | "INVALID_LIMIT"
  | "PATH_ESCAPE"
  | "SYMLINK_ESCAPE"
  | "MAX_BYTES_EXCEEDED"
  | "ABORTED"
  | "TIMEOUT"
  | "CONTENT_CONFLICT"
  | "NATIVE_BROKER_REQUIRED";

export class AttachmentStoreError extends Error {
  readonly code: AttachmentStoreErrorCode;

  constructor(code: AttachmentStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentStoreError";
    this.code = code;
  }
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[.?]\\|\\\?\\|\\\.\\)/;
const MAX_ID_BYTES = 100;
const MAX_FILENAME_BYTES = 180;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateUntrustedSegment(value: string, kind: "ID" | "filename"): void {
  const code = kind === "ID" ? "INVALID_ID" : "INVALID_FILENAME";
  if (
    value.length === 0
    || !isWellFormedUnicode(value)
    || value === "."
    || value === ".."
    || value.includes("\0")
    || value.includes("/")
    || value.includes("\\")
    || value.includes(":")
    || WINDOWS_DEVICE_PREFIX.test(value)
    || WINDOWS_RESERVED_NAME.test(value)
    || value.endsWith(".")
    || value.endsWith(" ")
  ) {
    throw new AttachmentStoreError(code, `Unsafe attachment ${kind}`);
  }
}

/** Reversible, lowercase-only encoding avoids Windows case-folding collisions. */
export function encodeStableId(value: string): string {
  validateUntrustedSegment(value, "ID");
  if (byteLength(value) > MAX_ID_BYTES) {
    throw new AttachmentStoreError("INVALID_ID", "Attachment ID is too long for a filesystem segment");
  }
  return `id-${Buffer.from(value, "utf8").toString("hex")}`;
}

export function decodeStableId(value: string): string {
  if (!/^id-(?:[0-9a-f]{2})+$/.test(value)) {
    throw new AttachmentStoreError("INVALID_ID", "Malformed encoded attachment ID");
  }
  const decoded = Buffer.from(value.slice(3), "hex").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("hex") !== value.slice(3)) {
    throw new AttachmentStoreError("INVALID_ID", "Encoded attachment ID is not canonical UTF-8");
  }
  validateUntrustedSegment(decoded, "ID");
  return decoded;
}

export function sanitizeAttachmentFilename(value: string): string {
  validateUntrustedSegment(value, "filename");
  if (byteLength(value) > MAX_FILENAME_BYTES) {
    throw new AttachmentStoreError("INVALID_FILENAME", "Attachment filename is too long");
  }
  const sanitized = value.replace(/[<>"|?*\u0001-\u001f]/g, "_");
  if (sanitized.length === 0 || WINDOWS_RESERVED_NAME.test(sanitized)) {
    throw new AttachmentStoreError("INVALID_FILENAME", "Unsafe attachment filename");
  }
  return sanitized;
}

function validateRoot(root: string): string {
  const windowsNormalized = root.replaceAll("/", "\\");
  if (
    root.length === 0
    || !isWellFormedUnicode(root)
    || root.includes("\0")
    || !isAbsolute(root)
    || windowsNormalized.startsWith("\\\\")
    || WINDOWS_DEVICE_PREFIX.test(windowsNormalized)
    || /:(?![\\/])/.test(root.slice(2))
  ) {
    throw new AttachmentStoreError("INVALID_ROOT", "Attachment root must be an absolute local path");
  }
  return resolve(root);
}

function dateParts(input: Date | string): { year: string; month: string } {
  const value = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (!Number.isFinite(value.getTime())) {
    throw new AttachmentStoreError("INVALID_DATE", "Attachment occurrence date is invalid");
  }
  return {
    year: String(value.getUTCFullYear()).padStart(4, "0"),
    month: String(value.getUTCMonth() + 1).padStart(2, "0"),
  };
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new AttachmentStoreError("PATH_ESCAPE", "Attachment path escaped its managed root");
}

export function buildAttachmentLocation(input: {
  readonly root: string;
  readonly identity: AttachmentIdentity;
  readonly occurredAt: Date | string;
  readonly originalFileName: string;
}): AttachmentLocation {
  const root = validateRoot(input.root);
  const { year, month } = dateParts(input.occurredAt);
  const account = encodeStableId(input.identity.accountId);
  const chat = encodeStableId(input.identity.chatId);
  const message = encodeStableId(input.identity.messageId);
  encodeStableId(input.identity.externalAttachmentId);
  if (!(["direct", "group", "room"] as const).includes(input.identity.chatType)) {
    throw new AttachmentStoreError("INVALID_ID", "Unsupported chat type");
  }
  const sanitizedDisplayFileName = sanitizeAttachmentFilename(input.originalFileName);
  // Keep each external attachment in its own directory under the message.
  // The digest is only a locator; message/chat membership remains in the
  // surrounding managed path and repository record.
  const attachmentDigest = createHash("sha256").update(input.identity.externalAttachmentId, "utf8").digest("hex");
  const storedFileName = sanitizedDisplayFileName;
  const relativeSegments = [
    "accounts",
    account,
    input.identity.chatType,
    chat,
    year,
    month,
    message,
    attachmentDigest,
    storedFileName,
  ];
  const managedRelativePath = relativeSegments.join("/");
  const absolutePath = resolve(root, ...relativeSegments);
  assertContained(root, absolutePath);
  return {
    managedRelativePath,
    absolutePath,
    directoryAbsolutePath: resolve(absolutePath, ".."),
    storedFileName,
    sanitizedDisplayFileName,
  };
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function createCanonicalDirectory(root: string, segments: readonly string[]): Promise<{ rootReal: string; directoryReal: string }> {
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new AttachmentStoreError("SYMLINK_ESCAPE", "Managed attachment root is not a real directory");
  }
  const rootReal = await realpath(root);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const before = await optionalLstat(current);
    if (before?.isSymbolicLink()) {
      throw new AttachmentStoreError("SYMLINK_ESCAPE", "Symbolic links and junctions are forbidden in attachment paths");
    }
    if (before && !before.isDirectory()) {
      throw new AttachmentStoreError("PATH_ESCAPE", "Attachment directory path contains a non-directory");
    }
    if (!before) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const after = await lstat(current);
    if (after.isSymbolicLink() || !after.isDirectory()) {
      throw new AttachmentStoreError("SYMLINK_ESCAPE", "Attachment directory changed during validation");
    }
    const currentReal = await realpath(current);
    assertContained(rootReal, currentReal);
  }
  const directoryReal = await realpath(current);
  return { rootReal, directoryReal };
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), size };
}

async function validateExistingTarget(path: string): Promise<"missing" | "file"> {
  const stat = await optionalLstat(path);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) {
    throw new AttachmentStoreError("SYMLINK_ESCAPE", "Attachment target is a symbolic link");
  }
  if (!stat.isFile()) {
    throw new AttachmentStoreError("PATH_ESCAPE", "Attachment target is not a regular file");
  }
  return "file";
}

function guardedNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  if (signal?.aborted) {
    return Promise.reject(new AttachmentStoreError("ABORTED", "Attachment download was aborted"));
  }
  if (timeoutMs <= 0) {
    return Promise.reject(new AttachmentStoreError("TIMEOUT", "Attachment download timed out"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => finishReject(new AttachmentStoreError("TIMEOUT", "Attachment download timed out")), timeoutMs);
    const onAbort = () => finishReject(new AttachmentStoreError("ABORTED", "Attachment download was aborted"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: IteratorResult<T>) => {
      cleanup();
      resolvePromise(value);
    };
    const finishReject = (error: unknown) => {
      cleanup();
      rejectPromise(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(finishResolve, finishReject);
  });
}

export async function storeAttachment(
  input: StoreAttachmentInput,
  runtime: AttachmentStoreRuntime = {},
): Promise<StoredAttachment> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new AttachmentStoreError("INVALID_LIMIT", "Attachment byte and timeout limits must be positive finite values");
  }
  const location = buildAttachmentLocation(input);
  const root = validateRoot(input.root);
  const directorySegments = relative(root, location.directoryAbsolutePath).split(sep);
  const portableWindowsTestAllowed = runtime.unsafeAllowPortableFilesystemOnWindowsForTests === true
    && process.env.VITEST === "true"
    && process.env.NODE_ENV !== "production";
  if (process.platform === "win32" && !portableWindowsTestAllowed) {
    const broker = runtime.windowsSafetyBroker;
    if (!broker
      || broker.guarantees.rootHandleAnchored !== true
      || broker.guarantees.rejectsReparsePoints !== true
      || broker.guarantees.publishNoReplace !== true) {
      throw new AttachmentStoreError(
        "NATIVE_BROKER_REQUIRED",
        "Windows attachment writes require a root-handle-anchored, reparse-safe, no-replace native broker",
      );
    }
    const brokerResult = await broker.storeAnchored({
      root,
      directorySegments,
      targetFileName: location.storedFileName,
      source: input.source,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      requiredGuarantees: REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES,
    });
    return { ...location, ...brokerResult };
  }
  const { rootReal, directoryReal } = await createCanonicalDirectory(root, directorySegments);
  assertContained(rootReal, directoryReal);
  if (!samePath(directoryReal, await realpath(location.directoryAbsolutePath))) {
    throw new AttachmentStoreError("SYMLINK_ESCAPE", "Attachment directory canonical path changed");
  }

  const target = join(directoryReal, location.storedFileName);
  assertContained(rootReal, target);
  await validateExistingTarget(target);
  const temporary = join(directoryReal, `.${location.storedFileName}.${randomUUID()}.part`);
  assertContained(rootReal, temporary);

  const iterator = input.source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  const hash = createHash("sha256");
  let size = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(temporary, flags, 0o600);
    while (true) {
      const next = await guardedNext(iterator, input.signal, input.timeoutMs - (Date.now() - startedAt));
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new AttachmentStoreError("CONTENT_CONFLICT", "Attachment source yielded a non-byte chunk");
      }
      size += next.value.byteLength;
      if (size > input.maxBytes) {
        throw new AttachmentStoreError("MAX_BYTES_EXCEEDED", "Attachment exceeded the configured byte limit");
      }
      hash.update(next.value);
      await handle.writeFile(next.value);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const sha256 = hash.digest("hex");
    const directoryAgain = await realpath(location.directoryAbsolutePath);
    if (!samePath(directoryReal, directoryAgain)) {
      throw new AttachmentStoreError("SYMLINK_ESCAPE", "Attachment directory changed before finalization");
    }
    assertContained(rootReal, directoryAgain);
    let published = false;
    try {
      // Hard-link publication is atomic and no-replace on both NTFS and POSIX.
      // The already-fsynced temporary inode becomes the final name only if no
      // concurrent writer has won.
      await link(temporary, target);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!published) {
      await validateExistingTarget(target);
      const current = await hashFile(target);
      if (current.sha256 !== sha256 || current.size !== size) {
        throw new AttachmentStoreError("CONTENT_CONFLICT", "Stable attachment target already contains different bytes");
      }
      await rm(temporary, { force: true });
      return { ...location, absolutePath: target, directoryAbsolutePath: directoryReal, sha256, size, idempotent: true };
    }
    await rm(temporary);
    const finalized = await validateExistingTarget(target);
    if (finalized !== "file") {
      throw new AttachmentStoreError("CONTENT_CONFLICT", "Attachment finalization did not create a regular file");
    }
    try {
      const directoryHandle = await open(directoryReal, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    return { ...location, absolutePath: target, directoryAbsolutePath: directoryReal, sha256, size, idempotent: false };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    // A stalled async generator may also stall `return()`. Signal cancellation
    // without making cleanup depend on cooperation from an external transport.
    if (typeof iterator.return === "function") void iterator.return().catch(() => undefined);
    throw error;
  }
}
