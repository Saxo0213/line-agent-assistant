import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import { lstat, open, realpath, type FileHandle, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatType } from '@line-agent/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_BLOB = /^att-([0-9a-f]{64})\.blob$/i;
const ATTACHMENT_HASH_DIRECTORY = /^[0-9a-f]{64}$/i;
const DANGEROUS_EXTENSION = new Set(['exe', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'mjs', 'cjs', 'msi', 'scr', 'lnk', 'url', 'hta', 'html', 'htm', 'svg', 'svgz', 'xhtml', 'xml']);

type RendererKind = 'image' | 'video' | 'audio' | 'text' | 'pdf';
type DeclaredKind = 'image' | 'video' | 'audio' | 'file';

type Format = {
  mimeType: string;
  extensions: readonly string[];
  attachmentKinds: readonly DeclaredKind[];
  renderer: RendererKind;
  signature: (bytes: Buffer) => boolean;
};

function starts(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function rejectsActivePrefix(bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 1024)).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return starts(bytes, [0x4d, 0x5a]) || prefix.startsWith('#!') || prefix.startsWith('<!doctype html')
    || prefix.startsWith('<html') || prefix.startsWith('<script') || prefix.startsWith('<svg') || prefix.startsWith('<?xml');
}

const FORMATS: readonly Format[] = [
  { mimeType: 'application/pdf', extensions: ['pdf'], attachmentKinds: ['file'], renderer: 'pdf', signature: (bytes) => bytes.subarray(0, 5).toString('ascii') === '%PDF-' },
  { mimeType: 'image/png', extensions: ['png'], attachmentKinds: ['image'], renderer: 'image', signature: (bytes) => starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) },
  { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'], attachmentKinds: ['image'], renderer: 'image', signature: (bytes) => starts(bytes, [0xff, 0xd8, 0xff]) },
  { mimeType: 'image/gif', extensions: ['gif'], attachmentKinds: ['image'], renderer: 'image', signature: (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) },
  { mimeType: 'image/webp', extensions: ['webp'], attachmentKinds: ['image'], renderer: 'image', signature: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mimeType: 'video/mp4', extensions: ['mp4'], attachmentKinds: ['video'], renderer: 'video', signature: (bytes) => bytes.subarray(4, 8).toString('ascii') === 'ftyp' },
  { mimeType: 'video/webm', extensions: ['webm'], attachmentKinds: ['video'], renderer: 'video', signature: (bytes) => starts(bytes, [0x1a, 0x45, 0xdf, 0xa3]) },
  { mimeType: 'audio/mpeg', extensions: ['mp3'], attachmentKinds: ['audio'], renderer: 'audio', signature: (bytes) => bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) },
  { mimeType: 'audio/wav', extensions: ['wav'], attachmentKinds: ['audio'], renderer: 'audio', signature: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE' },
  { mimeType: 'audio/ogg', extensions: ['ogg', 'oga'], attachmentKinds: ['audio'], renderer: 'audio', signature: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'OggS' },
  { mimeType: 'text/plain', extensions: ['txt', 'log'], attachmentKinds: ['file'], renderer: 'text', signature: isSafeUtf8Text },
  { mimeType: 'text/csv', extensions: ['csv'], attachmentKinds: ['file'], renderer: 'text', signature: isSafeUtf8Text },
] as const;

function isSafeUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0) || rejectsActivePrefix(bytes)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

export type PreviewRecord = {
  attachmentId: string;
  accountId?: string;
  chatType?: ChatType;
  chatId?: string;
  kind: DeclaredKind;
  name: string | null;
  mimeType: string | null;
  status: string;
  relativePath: string | null;
  sizeBytes: number | null;
  sha256: string | null;
};

export type PreviewRequester = { senderId: number };
export type PreviewAuthority = { lookup(attachmentId: string, requester: PreviewRequester): Promise<PreviewRecord | null> };

export type PreviewCapability = {
  token: string;
  sessionId: string;
  url: string;
  activate(): PreviewResource | null;
  close(): void;
};

export type PreviewResource = {
  read(): PreviewPayload | null;
  close(): void;
};

export type PreviewPresentationRequest = {
  displayName: string;
  mimeType: string;
  renderer: RendererKind;
  byteLength: number;
  issueCapability(viewerWebContentsId: number): PreviewCapability;
};

export type PreviewPresenter = {
  present(request: PreviewPresentationRequest): Promise<boolean>;
  closeAll(): void;
};

export type PreviewPayload = {
  displayName: string;
  mimeType: string;
  renderer: RendererKind;
  bytes: Buffer;
};

type StoredCapability = PreviewPayload & { viewerWebContentsId: number; sessionId: string; expiresAt: number; activated: boolean };
type PreviewLimits = { ttlMs: number; maxCapabilities: number; maxTotalBytes: number; maxFileBytes: number };

const DEFAULT_LIMITS: PreviewLimits = {
  ttlMs: 60_000,
  maxCapabilities: 4,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
};

export const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "media-src 'self'",
  "style-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function createPreviewWindowOptions() {
  return {
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    },
  } as const;
}

export function isAllowedPreviewNavigation(target: string, initialUrl: string): boolean {
  return target === initialUrl;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

function pathsOverlap(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  const related = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  return related(a, b) || related(b, a);
}

function safeRelativePath(relativePath: string): boolean {
  return relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.includes('\\') && !relativePath.includes(':')
    && relativePath.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function declaredFormat(record: PreviewRecord): Format | null {
  if (!record.name || !record.mimeType || /[\\/:<>"|?*\u0000-\u001f]/.test(record.name)) return null;
  const parts = record.name.toLowerCase().split('.');
  const extension = parts.at(-1) ?? '';
  if (parts.some((part) => DANGEROUS_EXTENSION.has(part))) return null;
  const mimeType = record.mimeType.toLowerCase();
  return FORMATS.find((candidate) => candidate.mimeType === mimeType && candidate.extensions.includes(extension)
    && candidate.attachmentKinds.includes(record.kind)) ?? null;
}

function imageFormat(bytes: Buffer): Format | null {
  return FORMATS.find((candidate) => candidate.renderer === 'image' && candidate.signature(bytes)) ?? null;
}

function imageDimensionsAreSafe(bytes: Buffer, format: Format): boolean {
  let width = 0, height = 0;
  if (format.mimeType === 'image/png' && bytes.length >= 24) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (format.mimeType === 'image/gif' && bytes.length >= 10) { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  else if (format.mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) { width = 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!); height = 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | (bytes[22]! >> 6)); }
    else if (chunk === 'VP8 ' && bytes.length >= 30) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
  } else if (format.mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!; const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      offset += 2 + length;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try { await handle.close(); } catch { /* best-effort cleanup */ }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); resolve(undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, () => { cleanup(); resolve(undefined); });
  });
}

async function openManagedBlob(root: string, relativePath: string, signal?: AbortSignal): Promise<{ handle: FileHandle; target: string; close(): Promise<void> } | null> {
  if (!path.isAbsolute(root) || root.includes('\0') || (process.platform === 'win32' && /^(?:\\\\|\\\\[.?]\\)/.test(root)) || !safeRelativePath(relativePath)) return null;
  const segments = relativePath.split('/');
  const filename = segments.at(-1)!;
  const legacy = OPAQUE_BLOB.test(filename);
  const nativeNamed = segments.length === 9 && segments[0] === 'accounts'
    && /^id-(?:[0-9a-f]{2})+$/i.test(segments[1]!)
    && ['direct', 'group', 'room'].includes(segments[2]!)
    && /^id-(?:[0-9a-f]{2})+$/i.test(segments[3]!)
    && /^\d{4}$/.test(segments[4]!) && /^(?:0[1-9]|1[0-2])$/.test(segments[5]!)
    && /^id-(?:[0-9a-f]{2})+$/i.test(segments[6]!)
    && ATTACHMENT_HASH_DIRECTORY.test(segments[7]!)
    && Buffer.byteLength(filename, 'utf8') <= 180 && Buffer.from(filename, 'utf8').toString('utf8') === filename
    && !/[<>"|?*\u0000-\u001f]/.test(filename)
    && !/[. ]$/.test(filename) && !/^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(filename);
  if (!legacy && !nativeNamed) return null;
  const rootStat = await lstat(root);
  const canonicalRoot = await realpath(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !samePath(await realpath(current), current)) return null;
  }
  const relation = path.relative(canonicalRoot, current);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null;
  const handle = await open(current, 'r');
  let closeOperation: Promise<void> | null = null;
  const closeHandle = () => closeOperation ??= closeQuietly(handle);
  const closeOnAbort = () => { void closeHandle(); };
  let transferred = false;
  if (signal?.aborted) { await closeHandle(); return null; }
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    if (signal?.aborted) { await closeHandle(); return null; }
    const held = await handle.stat();
    if (signal?.aborted) { await closeHandle(); return null; }
    const named = await lstat(current);
    if (signal?.aborted) { await closeHandle(); return null; }
    if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino || held.size !== named.size) {
      await closeHandle();
      return null;
    }
    transferred = true;
    return { handle, target: current, close: async () => { signal?.removeEventListener('abort', closeOnAbort); await closeHandle(); } };
  } catch (error) {
    await closeHandle();
    if (signal?.aborted) return null;
    throw error;
  } finally {
    if (!transferred) signal?.removeEventListener('abort', closeOnAbort);
  }
}

async function readHeldBytes(source: { handle: FileHandle; target: string }, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
  if (signal?.aborted) return null;
  const before = await source.handle.stat();
  if (signal?.aborted) return null;
  if (!before.isFile() || before.size <= 0 || before.size > maxBytes || !Number.isSafeInteger(before.size)) return null;
  const bytes = Buffer.alloc(before.size);
  let position = 0;
  while (position < bytes.byteLength) {
    if (signal?.aborted) return null;
    const result = await source.handle.read(bytes, position, bytes.byteLength - position, position);
    if (signal?.aborted) return null;
    if (result.bytesRead === 0) return null;
    position += result.bytesRead;
  }
  const after = await source.handle.stat();
  const named = await lstat(source.target);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || !named.isFile() || after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size) return null;
  return bytes;
}

export class AttachmentPreviewService {
  readonly #onDiagnostic: ((diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void) | undefined;
  readonly #root: string;
  readonly #cacheRoot: string | null;
  readonly #authority: PreviewAuthority;
  readonly #presenter: PreviewPresenter;
  readonly #now: () => number;
  readonly #limits: PreviewLimits;
  readonly #capabilities = new Map<string, StoredCapability>();
  #totalBytes = 0;
  #shutDown = false;
  #generation = 0;
  #cacheSerial: Promise<void> = Promise.resolve();
  #cacheCanonicalRoot: string | null = null;
  #pendingCacheWrites = 0;
  readonly #activeImageReads = new Set<AbortController>();

  constructor(options: { root: string; cacheRoot?: string; authority: PreviewAuthority; presenter: PreviewPresenter; now?: () => number; limits?: Partial<PreviewLimits>;
    onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void }) {
    if (options.cacheRoot && pathsOverlap(options.root, options.cacheRoot)) throw new Error('Preview cache must be separate from attachment storage');
    this.#root = options.root;
    this.#cacheRoot = options.cacheRoot ?? null;
    this.#authority = options.authority;
    this.#presenter = options.presenter;
    this.#onDiagnostic = options.onDiagnostic;
    this.#now = options.now ?? Date.now;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async readImage(attachmentId: string, key: { accountId: string; chatType: ChatType; chatId: string }, requester: PreviewRequester,
    maxBytes = 8 * 1024 * 1024, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string } | null> {
    maxBytes = Math.min(maxBytes, 8 * 1024 * 1024);
    if (this.#shutDown || signal?.aborted || !UUID.test(attachmentId) || !Number.isSafeInteger(requester.senderId) || requester.senderId < 0) return null;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || this.#shutDown) controller.abort();
    this.#activeImageReads.add(controller);
    const readSignal = controller.signal;
    try {
      const record = await abortable(this.#authority.lookup(attachmentId, requester), readSignal);
      if (readSignal.aborted || this.#shutDown || !record || record.attachmentId !== attachmentId || record.accountId !== key.accountId
        || record.chatType !== key.chatType || record.chatId !== key.chatId || record.status !== 'ready'
        || record.kind !== 'image' || !record.relativePath || !record.sha256 || !/^[0-9a-f]{64}$/i.test(record.sha256)
        || record.sizeBytes === null || record.sizeBytes <= 0 || record.sizeBytes > maxBytes) return null;
      const cacheKey = record.sha256.toLowerCase();
      const cached = await this.#readImageCache(cacheKey, record.sizeBytes, maxBytes, readSignal);
      if (readSignal.aborted || this.#shutDown) return null;
      if (cached) {
        const cachedFormat = imageFormat(cached);
        if (cachedFormat && imageDimensionsAreSafe(cached, cachedFormat)) return { bytes: cached, mimeType: cachedFormat.mimeType };
      }
      const source = await openManagedBlob(this.#root, record.relativePath, readSignal);
      if (!source) return null;
      if (readSignal.aborted || this.#shutDown) { await source.close(); return null; }
      let bytes: Buffer | null;
      try { bytes = await readHeldBytes(source, maxBytes, readSignal); }
      finally { await source.close(); }
      const format = bytes ? imageFormat(bytes) : null;
      if (readSignal.aborted || this.#shutDown || !bytes || bytes.byteLength !== record.sizeBytes || rejectsActivePrefix(bytes) || !format
        || !imageDimensionsAreSafe(bytes, format)
        || createHash('sha256').update(bytes).digest('hex') !== record.sha256.toLowerCase()) return null;
      await this.#writeImageCache(cacheKey, bytes, readSignal);
      if (readSignal.aborted || this.#shutDown) return null;
      return { bytes, mimeType: format.mimeType };
    } catch { return null; }
    finally { signal?.removeEventListener('abort', abort); this.#activeImageReads.delete(controller); }
  }

  async #readImageCache(key: string, expectedSize: number, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
    if (!await this.#cacheRootIsSafe() || !this.#cacheCanonicalRoot) return null;
    let handle: FileHandle | undefined;
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= handle ? closeQuietly(handle) : Promise.resolve();
    const abort = () => { void close(); };
    try {
      const target = path.join(this.#cacheCanonicalRoot, `${key}.preview`);
      const entry = await lstat(target);
      if (signal?.aborted) return null;
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== expectedSize || entry.size > maxBytes) { await unlink(target).catch(() => undefined); return null; }
      handle = await open(target, 'r');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || this.#shutDown) { await close(); return null; }
      const held = await handle.stat();
      const named = await lstat(target);
      if (!held.isFile() || held.dev !== entry.dev || held.ino !== entry.ino || named.isSymbolicLink()
        || named.dev !== held.dev || named.ino !== held.ino || !samePath(await realpath(target), target)) return null;
      const bytes = await readHeldBytes({ handle, target }, maxBytes, signal);
      if (!bytes) return null;
      if (bytes.byteLength !== expectedSize || createHash('sha256').update(bytes).digest('hex') !== key) { await unlink(target).catch(() => undefined); return null; }
      return bytes;
    } catch { return null; }
    finally { signal?.removeEventListener('abort', abort); await close(); }
  }

  async #cacheRootIsSafe(): Promise<boolean> {
    const cacheRoot = this.#cacheRoot;
    if (!cacheRoot || this.#shutDown) return false;
    try {
      await mkdir(cacheRoot, { recursive: true });
      const [cacheStat, attachmentStat] = await Promise.all([lstat(cacheRoot), lstat(this.#root)]);
      if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || !attachmentStat.isDirectory() || attachmentStat.isSymbolicLink()) return false;
      const [canonicalCache, canonicalAttachments] = await Promise.all([realpath(cacheRoot), realpath(this.#root)]);
      if (pathsOverlap(canonicalCache, canonicalAttachments)) return false;
      this.#cacheCanonicalRoot = canonicalCache;
      return true;
    } catch { return false; }
  }

  async #writeImageCache(key: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    const cacheRoot = this.#cacheRoot;
    if (!cacheRoot || signal?.aborted || this.#shutDown || this.#pendingCacheWrites >= 8) return;
    this.#pendingCacheWrites++;
    const next = this.#cacheSerial.then(async () => {
      let temporary: string | undefined;
      try {
        if (signal?.aborted || this.#shutDown || !await this.#cacheRootIsSafe() || !this.#cacheCanonicalRoot) return;
        const canonicalRoot = this.#cacheCanonicalRoot;
        const entries = await readdir(canonicalRoot, { withFileTypes: true });
        const files: Array<{ name: string; size: number; mtime: number }> = [];
        for (const item of entries) {
          if (signal?.aborted || this.#shutDown) return;
          if (!item.isFile() || !/^[0-9a-f]{64}\.preview$/i.test(item.name)) { if (item.name.includes('.tmp-')) await unlink(path.join(canonicalRoot, item.name)).catch(() => undefined); continue; }
          const full = path.join(canonicalRoot, item.name); const info = await lstat(full);
          if (info.isFile() && !info.isSymbolicLink()) files.push({ name: item.name, size: info.size, mtime: info.mtimeMs });
        }
        const targetName = `${key}.preview`;
        let total = files.reduce((sum, file) => sum + file.size, 0);
        let count = files.length;
        const existing = files.find((file) => file.name === targetName);
        if (existing) { total -= existing.size; count--; }
        for (const old of files.sort((a, b) => a.mtime - b.mtime)) {
          if (total + bytes.byteLength <= 256 * 1024 * 1024 && count < 512) break;
          if (old.name === targetName) continue;
          if (signal?.aborted || this.#shutDown) return;
          await unlink(path.join(canonicalRoot, old.name)); total -= old.size; count--;
        }
        if (total + bytes.byteLength > 256 * 1024 * 1024 || (count >= 512 && !files.some((file) => file.name === targetName))) return;
        temporary = path.join(canonicalRoot, `${targetName}.tmp-${randomBytes(8).toString('hex')}`);
        await writeFile(temporary, bytes, { flag: 'wx' });
        if (signal?.aborted || this.#shutDown || !await this.#cacheRootIsSafe() || this.#cacheCanonicalRoot !== canonicalRoot) return;
        await rename(temporary, path.join(canonicalRoot, targetName));
        temporary = undefined;
      } catch { /* cache failure must not block this verified preview */ }
      finally {
        if (temporary) await unlink(temporary).catch(() => undefined);
        this.#pendingCacheWrites--;
      }
    });
    this.#cacheSerial = next.then(() => undefined, () => undefined);
    await abortable(next, signal);
  }

  async open(attachmentId: string, requester: PreviewRequester): Promise<boolean> {
    if (this.#shutDown || !UUID.test(attachmentId) || !Number.isSafeInteger(requester.senderId) || requester.senderId < 0) return false;
    const generation = this.#generation;
    const identity = { requestId: attachmentId, correlationId: randomUUID() };
    let revokeIssued = () => {};
    try {
      const record = await this.#authority.lookup(attachmentId, requester);
      if (!this.#isCurrent(generation)) return false;
      const format = record ? declaredFormat(record) : null;
      if (!record || record.attachmentId !== attachmentId || record.status !== 'ready' || !record.relativePath || !record.sha256
        || !/^[0-9a-f]{64}$/i.test(record.sha256) || !format || record.sizeBytes === null || record.sizeBytes <= 0
        || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes > this.#limits.maxFileBytes) return false;
      const source = await openManagedBlob(this.#root, record.relativePath);
      if (!source) return false;
      if (!this.#isCurrent(generation)) { await closeQuietly(source.handle); return false; }
      let bytes: Buffer | null;
      try { bytes = await readHeldBytes(source, this.#limits.maxFileBytes); }
      finally { await closeQuietly(source.handle); }
      if (!this.#isCurrent(generation)) return false;
      if (!bytes || bytes.byteLength !== record.sizeBytes || rejectsActivePrefix(bytes) || !format.signature(bytes)
        || createHash('sha256').update(bytes).digest('hex') !== record.sha256.toLowerCase()) return false;

      let issued = false;
      const payload: PreviewPayload = { displayName: record.name!, mimeType: format.mimeType, renderer: format.renderer, bytes };
      const presented = await this.#presenter.present({
        displayName: payload.displayName,
        mimeType: payload.mimeType,
        renderer: payload.renderer,
        byteLength: bytes.byteLength,
        issueCapability: (viewerWebContentsId) => {
          if (issued || !Number.isSafeInteger(viewerWebContentsId) || viewerWebContentsId < 0) throw new Error('Preview capability already issued or viewer is invalid');
          const capability = this.#issue(payload, viewerWebContentsId, generation);
          issued = true;
          revokeIssued = capability.close;
          return capability;
        },
      });
      if (!presented || !this.#isCurrent(generation)) revokeIssued();
      return presented && issued && this.#isCurrent(generation);
    } catch (error) {
      if (this.#isCurrent(generation)) try { this.#onDiagnostic?.(diagnosticFailure('attachment', 'read', error), identity); } catch { /* observer only */ }
      revokeIssued();
      return false;
    }
  }

  activate(token: string, viewerWebContentsId: number): PreviewResource | null {
    this.#removeExpired();
    const capability = this.#capabilities.get(token);
    if (this.#shutDown || !capability || capability.activated || capability.viewerWebContentsId !== viewerWebContentsId) return null;
    capability.activated = true;
    const sessionId = capability.sessionId;
    return {
      read: () => this.#readActive(token, viewerWebContentsId, sessionId),
      close: () => this.closeSession(sessionId),
    };
  }

  closeSession(sessionId: string): void {
    for (const [token, capability] of this.#capabilities) if (capability.sessionId === sessionId) this.#delete(token);
  }

  shutdown(): void {
    if (this.#shutDown) return;
    this.#shutDown = true;
    for (const read of this.#activeImageReads) read.abort(new Error('Preview service is shutting down'));
    this.#generation++;
    this.#capabilities.clear();
    this.#totalBytes = 0;
    this.#presenter.closeAll();
  }

  #issue(payload: PreviewPayload, viewerWebContentsId: number, generation: number): PreviewCapability {
    if (!this.#isCurrent(generation)) throw new Error('Preview service is shutting down');
    this.#removeExpired();
    if (this.#capabilities.size >= this.#limits.maxCapabilities || this.#totalBytes + payload.bytes.byteLength > this.#limits.maxTotalBytes) {
      throw new Error('Preview capability capacity exceeded');
    }
    let token: string;
    do { token = randomBytes(32).toString('base64url'); } while (this.#capabilities.has(token));
    const sessionId = randomBytes(24).toString('base64url');
    this.#capabilities.set(token, { ...payload, viewerWebContentsId, sessionId, expiresAt: this.#now() + this.#limits.ttlMs, activated: false });
    this.#totalBytes += payload.bytes.byteLength;
    return {
      token,
      sessionId,
      url: `line-preview://content/${token}`,
      activate: () => this.activate(token, viewerWebContentsId),
      close: () => this.closeSession(sessionId),
    };
  }

  #readActive(token: string, viewerWebContentsId: number, sessionId: string): PreviewPayload | null {
    this.#removeExpired();
    const capability = this.#capabilities.get(token);
    if (this.#shutDown || !capability || !capability.activated || capability.viewerWebContentsId !== viewerWebContentsId
      || capability.sessionId !== sessionId) return null;
    return { displayName: capability.displayName, mimeType: capability.mimeType, renderer: capability.renderer, bytes: capability.bytes };
  }

  #isCurrent(generation: number): boolean {
    return !this.#shutDown && generation === this.#generation;
  }

  #removeExpired(): void {
    const now = this.#now();
    for (const [token, capability] of this.#capabilities) if (capability.expiresAt <= now) this.#delete(token);
  }

  #delete(token: string): void {
    const capability = this.#capabilities.get(token);
    if (!capability) return;
    this.#capabilities.delete(token);
    this.#totalBytes -= capability.bytes.byteLength;
  }
}

export function createRepositoryPreviewAuthority(repository: { getAttachment(attachmentId: string): Promise<PreviewRecord | null> }): PreviewAuthority {
  return { lookup: (attachmentId) => repository.getAttachment(attachmentId) };
}

export function bindAttachmentPreview(service: AttachmentPreviewService, senderId: number): { openAttachment(attachmentId: string): Promise<boolean> } {
  return { openAttachment: (attachmentId) => service.open(attachmentId, { senderId }) };
}
