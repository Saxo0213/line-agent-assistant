import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttachmentStoreError,
  REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES,
  type AnchoredAttachmentStoreRequest,
  type AttachmentFilesystemSafetyBroker,
} from "./attachment-store.js";

const PROTOCOL = "line-attachment-broker/v1";
const MAX_OUTPUT = 16 * 1024;

export interface WindowsAttachmentBrokerOptions { readonly helperPath?: string; }

type HelperResult =
  | { protocol: typeof PROTOCOL; ok: true; sha256: string; size: number; idempotent: boolean }
  | { protocol: typeof PROTOCOL; ok: false; code: string };

function brokerError(code: string): AttachmentStoreError {
  const mapped = code === "MAX_BYTES_EXCEEDED" ? "MAX_BYTES_EXCEEDED"
    : code === "CONTENT_CONFLICT" ? "CONTENT_CONFLICT"
      : code === "REPARSE_POINT" ? "SYMLINK_ESCAPE"
        : code === "INVALID_ROOT" ? "INVALID_ROOT"
          : code === "TRUNCATED_INPUT" || code === "ABORTED" ? "ABORTED"
            : code === "TIMEOUT" ? "TIMEOUT" : "NATIVE_BROKER_REQUIRED";
  return new AttachmentStoreError(mapped, `Windows attachment broker failed (${code})`);
}

function parseResult(text: string): HelperResult {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw brokerError("MALFORMED_OUTPUT");
  let value: unknown;
  try { value = JSON.parse(lines[0]!); } catch { throw brokerError("MALFORMED_OUTPUT"); }
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).protocol !== PROTOCOL || typeof (value as Record<string, unknown>).ok !== "boolean") {
    throw brokerError("PROTOCOL_MISMATCH");
  }
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    if (typeof record.code !== "string" || !/^[A-Z0-9_]{2,40}$/.test(record.code)) throw brokerError("MALFORMED_OUTPUT");
    return { protocol: PROTOCOL, ok: false, code: record.code };
  }
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.size) || (record.size as number) < 0 || typeof record.idempotent !== "boolean") throw brokerError("MALFORMED_OUTPUT");
  return { protocol: PROTOCOL, ok: true, sha256: record.sha256, size: record.size as number, idempotent: record.idempotent };
}

async function write(child: ChildProcessWithoutNullStreams, data: Uint8Array): Promise<void> {
  if (child.stdin.destroyed) throw brokerError("BROKEN_PIPE");
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(data, (error) => error ? rejectWrite(brokerError("BROKEN_PIPE")) : resolveWrite());
  });
}
function frameLength(length: number): Buffer { const value = Buffer.allocUnsafe(4); value.writeUInt32LE(length); return value; }

function nextUntilCancelled(iterator: AsyncIterator<Uint8Array>, cancelled: () => "ABORTED" | "TIMEOUT" | undefined): Promise<IteratorResult<Uint8Array>> {
  return new Promise((resolveNext, rejectNext) => {
    const poll = setInterval(() => {
      const reason = cancelled();
      if (reason) { clearInterval(poll); rejectNext(brokerError(reason)); }
    }, 10);
    poll.unref();
    iterator.next().then(
      (value) => { clearInterval(poll); resolveNext(value); },
      (error: unknown) => { clearInterval(poll); rejectNext(error); },
    );
  });
}

export class WindowsAttachmentBroker implements AttachmentFilesystemSafetyBroker {
  readonly guarantees = REQUIRED_ATTACHMENT_FILESYSTEM_GUARANTEES;
  readonly #helperPath: string;
  constructor(options: WindowsAttachmentBrokerOptions = {}) {
    // The build places the helper beside either flattened `dist/*.js` or
    // preserved `dist/src/*.js` output, so the runtime lookup is layout-stable.
    this.#helperPath = options.helperPath ?? fileURLToPath(new URL("./native/AttachmentBroker.exe", import.meta.url));
  }

  async #resolveAndVerifyHelper(): Promise<string> {
    if (!isAbsolute(this.#helperPath) || !this.#helperPath.toLowerCase().endsWith("attachmentbroker.exe")) throw brokerError("INVALID_HELPER");
    let helper: string;
    try { helper = await realpath(resolve(this.#helperPath)); } catch { throw brokerError("HELPER_NOT_FOUND"); }
    const child = spawn(helper, ["--version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
    const stdout: Buffer[] = []; let bytes = 0; let invalid = false;
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 1024) { invalid = true; child.kill(); } else stdout.push(Buffer.from(chunk)); });
    child.stderr.resume();
    let versionTimer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      new Promise<number | null>((resolveExit) => { child.once("error", () => resolveExit(-1)); child.once("close", resolveExit); }),
      new Promise<never>((_, reject) => { versionTimer = setTimeout(() => { child.kill(); reject(brokerError("HELPER_VERSION_TIMEOUT")); }, 2_000); versionTimer.unref(); }),
    ]).finally(() => { if (versionTimer) clearTimeout(versionTimer); });
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(stdout).toString("utf8")); } catch { throw brokerError("HELPER_VERSION_INVALID"); }
    const record = value as Record<string, unknown>;
    if (invalid || exit !== 0 || !record || record.protocol !== PROTOCOL || record.version !== "1.0.0"
      || record.rootHandleAnchored !== true || record.rejectsReparsePoints !== true || record.publishNoReplace !== true) throw brokerError("HELPER_VERSION_INVALID");
    return helper;
  }

  async storeAnchored(request: AnchoredAttachmentStoreRequest): Promise<{ sha256: string; size: number; idempotent: boolean }> {
    if (process.platform !== "win32") throw brokerError("WINDOWS_REQUIRED");
    if (request.signal?.aborted) throw new AttachmentStoreError("ABORTED", "Attachment download was aborted");
    const helper = await this.#resolveAndVerifyHelper();
    if (request.signal?.aborted) throw new AttachmentStoreError("ABORTED", "Attachment download was aborted");
    const child = spawn(helper, ["--stdio-v1"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, overflow = false;
    const collect = (target: Buffer[], which: "stdout" | "stderr") => (chunk: Buffer) => {
      const size = which === "stdout" ? (stdoutBytes += chunk.byteLength) : (stderrBytes += chunk.byteLength);
      if (size > MAX_OUTPUT) { overflow = true; child.kill(); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout, "stdout")); child.stderr.on("data", collect(stderr, "stderr"));
    child.stdin.on("error", () => {});
    const exited = new Promise<{ code: number | null }>((resolveExit) => {
      child.once("error", () => resolveExit({ code: -1 })); child.once("close", (code) => resolveExit({ code }));
    });
    let settlePromise: Promise<{ code: number | null }> | undefined;
    const settle = (graceMs = 1_000) => settlePromise ??= (async () => {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const graceful = await Promise.race([
        exited.then((exit) => ({ exited: true as const, exit })),
        new Promise<{ exited: false }>((resolveGrace) => { graceTimer = setTimeout(() => resolveGrace({ exited: false }), graceMs); graceTimer.unref(); }),
      ]).finally(() => { if (graceTimer) clearTimeout(graceTimer); });
      if (graceful.exited) return graceful.exit;
      child.kill();
      return exited;
    })();
    let timedOut = false, aborted = false;
    const stopInput = () => { if (!child.stdin.destroyed) child.stdin.end(); };
    const timer = setTimeout(() => { timedOut = true; stopInput(); }, request.timeoutMs);
    const onAbort = () => { aborted = true; stopInput(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const header = Buffer.from(JSON.stringify({ protocol: PROTOCOL, root: request.root, directorySegments: request.directorySegments, targetFileName: request.targetFileName, maxBytes: request.maxBytes }), "utf8");
      await write(child, frameLength(header.byteLength)); await write(child, header);
      const iterator = request.source[Symbol.asyncIterator]();
      let streamedBytes = 0;
      try {
        while (!aborted && !timedOut) {
          const next = await nextUntilCancelled(iterator, () => aborted ? "ABORTED" : timedOut ? "TIMEOUT" : undefined);
          if (next.done) break;
          if (!(next.value instanceof Uint8Array)) throw brokerError("INVALID_SOURCE");
          if (next.value.byteLength === 0) continue;
          streamedBytes += next.value.byteLength;
          if (!Number.isSafeInteger(streamedBytes) || streamedBytes > request.maxBytes) {
            throw new AttachmentStoreError("MAX_BYTES_EXCEEDED", "Attachment exceeded the configured byte limit");
          }
          for (let offset = 0; offset < next.value.byteLength; offset += 1024 * 1024) {
            const chunk = next.value.subarray(offset, Math.min(offset + 1024 * 1024, next.value.byteLength)); await write(child, frameLength(chunk.byteLength)); await write(child, chunk);
          }
        }
        if (!aborted && !timedOut) { await write(child, frameLength(0)); child.stdin.end(); }
      } catch (error) {
        stopInput(); if (typeof iterator.return === "function") void iterator.return().catch(() => undefined);
        await settle();
        throw error;
      }
      const exit = await settle(Math.max(1_000, request.timeoutMs));
      if (aborted) throw new AttachmentStoreError("ABORTED", "Attachment download was aborted");
      if (timedOut) throw new AttachmentStoreError("TIMEOUT", "Attachment download timed out");
      if (overflow) throw brokerError("OUTPUT_LIMIT");
      const result = parseResult(Buffer.concat(stdout).toString("utf8"));
      if (!result.ok) throw brokerError(result.code);
      if (exit.code !== 0) throw brokerError("HELPER_EXIT");
      return { sha256: result.sha256, size: result.size, idempotent: result.idempotent };
    } finally {
      clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); stopInput();
      await settle();
    }
  }
}

export function createWindowsAttachmentBroker(options?: WindowsAttachmentBrokerOptions): AttachmentFilesystemSafetyBroker {
  return new WindowsAttachmentBroker(options);
}
