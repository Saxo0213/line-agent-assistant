import { createHash } from 'node:crypto';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { PreviewAuthority, PreviewRequester, PreviewRecord } from './attachment-preview.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

function safeRelative(value: string): boolean {
  return !!value && !path.isAbsolute(value) && !value.includes('\\') && !value.includes(':')
    && value.split('/').every((part) => !!part && part !== '.' && part !== '..');
}

function sameRecord(left: PreviewRecord, right: PreviewRecord | null): boolean {
  return !!right && right.attachmentId === left.attachmentId && right.accountId === left.accountId
    && right.chatType === left.chatType && right.chatId === left.chatId && right.status === 'ready'
    && right.relativePath === left.relativePath && right.sizeBytes === left.sizeBytes && right.sha256 === left.sha256;
}

function validRecord(record: PreviewRecord | null, id: string): record is PreviewRecord & {
  accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string;
  relativePath: string; sizeBytes: number; sha256: string;
} {
  return !!record && record.attachmentId === id && record.status === 'ready'
    && typeof record.accountId === 'string' && !!record.accountId
    && ['direct', 'group', 'room'].includes(record.chatType ?? '') && typeof record.chatId === 'string' && !!record.chatId
    && typeof record.relativePath === 'string' && safeRelative(record.relativePath)
    && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes! >= 0 && record.sizeBytes! <= MAX_FILE_BYTES
    && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(record.sha256);
}

async function closeQuietly(handle: FileHandle): Promise<void> { await handle.close().catch(() => undefined); }

type HeldSource = { handle: FileHandle; path: string; launchPath: string; dev: number; ino: number; size: number; mtimeMs: number };

/** Opens an already-managed attachment by its original path after verifying the stored bytes. */
export class AttachmentOpenService {
  readonly #root: string;
  readonly #rootDev: number;
  readonly #rootIno: number;
  readonly #authority: PreviewAuthority;
  readonly #openPath: (file: string) => Promise<string>;
  readonly #afterAcquire: (() => Promise<void>) | undefined;
  readonly #handles = new Set<FileHandle>();
  readonly #cancelSubscribers = new Set<() => void>();
  #closed = false;
  #active = 0;

  constructor(options: { root: string; authority: PreviewAuthority; openPath(file: string): Promise<string>; afterAcquire?: () => Promise<void> }) {
    if (!path.isAbsolute(options.root)) throw new Error('Attachment root must be absolute');
    const configuredRoot = path.resolve(options.root), rootInfo = lstatSync(configuredRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Attachment root must be a managed directory');
    this.#root = configuredRoot; this.#rootDev = rootInfo.dev; this.#rootIno = rootInfo.ino;
    this.#authority = options.authority;
    this.#openPath = options.openPath;
    this.#afterAcquire = options.afterAcquire;
  }

  open(attachmentId: string, requester: PreviewRequester): Promise<boolean> {
    if (this.#closed || this.#active >= 2 || !UUID.test(attachmentId)
      || !Number.isSafeInteger(requester.senderId) || requester.senderId < 0) return Promise.resolve(false);
    this.#active++;
    let cancel!: () => void;
    const cancelled = new Promise<boolean>((resolve) => { cancel = () => resolve(false); });
    this.#cancelSubscribers.add(cancel);
    const operation = this.#doOpen(attachmentId, requester).catch(() => false)
      .finally(() => { this.#active--; this.#cancelSubscribers.delete(cancel); });
    return Promise.race([operation, cancelled]).finally(() => this.#cancelSubscribers.delete(cancel));
  }

  inventory(): { active: number; handles: number; cancellationSubscribers: number } {
    return { active: this.#active, handles: this.#handles.size, cancellationSubscribers: this.#cancelSubscribers.size };
  }

  shutdown(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const cancel of this.#cancelSubscribers) cancel();
      this.#cancelSubscribers.clear();
      for (const handle of this.#handles) void closeQuietly(handle).finally(() => this.#handles.delete(handle));
    }
    return Promise.resolve();
  }

  async #doOpen(id: string, requester: PreviewRequester): Promise<boolean> {
    let source: HeldSource | null = null;
    try {
      const first = await this.#authority.lookup(id, requester);
      if (this.#closed || !validRecord(first, id)) return false;
      source = await this.#acquire(first.relativePath);
      if (this.#closed || !source) return false;
      await this.#afterAcquire?.();
      if (this.#closed) return false;
      const initial = await source.handle.stat();
      if (this.#closed || !this.#sameIdentity(source, initial) || initial.size !== first.sizeBytes || initial.size > MAX_FILE_BYTES) return false;
      const hash = createHash('sha256'), chunk = Buffer.alloc(HASH_CHUNK_BYTES);
      let position = 0;
      while (position < initial.size) {
        if (this.#closed) return false;
        const read = await source.handle.read(chunk, 0, Math.min(chunk.length, initial.size - position), position);
        if (this.#closed || read.bytesRead <= 0) return false;
        hash.update(chunk.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      if (this.#closed || hash.digest('hex') !== first.sha256.toLowerCase()) return false;
      const afterHash = await source.handle.stat();
      if (this.#closed || !this.#sameIdentity(source, afterHash) || !await this.#namedSourceIsSame(first.relativePath, source)) return false;
      const latest = await this.#authority.lookup(id, requester);
      if (this.#closed || !sameRecord(first, latest)) return false;
      const immediatelyBeforeLaunch = await source.handle.stat();
      if (this.#closed || !this.#sameIdentity(source, immediatelyBeforeLaunch)
        || !await this.#namedSourceIsSame(first.relativePath, source) || this.#closed) return false;
      const error = await this.#openPath(source.launchPath);
      return !this.#closed && error === '';
    } finally {
      if (source) {
        this.#handles.delete(source.handle);
        await closeQuietly(source.handle);
      }
    }
  }

  async #acquire(relative: string): Promise<HeldSource | null> {
    if (this.#closed || !safeRelative(relative)) return null;
    const rootStat = await lstat(this.#root);
    const rootReal = await realpath(this.#root);
    if (this.#closed || !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== this.#rootDev || rootStat.ino !== this.#rootIno) return null;
    let current = rootReal;
    for (const segment of relative.split('/')) {
      if (this.#closed) return null;
      current = path.join(current, segment);
      const entry = await lstat(current), canonical = await realpath(current);
      const withinRoot = path.relative(rootReal, canonical);
      if (this.#closed || entry.isSymbolicLink() || !withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) return null;
    }
    const contained = path.relative(rootReal, current);
    if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) return null;
    const handle = await open(current, 'r');
    this.#handles.add(handle);
    try {
      const held = await handle.stat(), named = await lstat(current);
      if (this.#closed || !held.isFile() || named.isSymbolicLink() || !named.isFile()
        || held.dev !== named.dev || held.ino !== named.ino || held.size !== named.size) {
        this.#handles.delete(handle);
        await closeQuietly(handle);
        return null;
      }
      return { handle, path: current, launchPath: path.resolve(this.#root, relative), dev: held.dev, ino: held.ino, size: held.size, mtimeMs: held.mtimeMs };
    } catch (error) {
      this.#handles.delete(handle);
      await closeQuietly(handle);
      throw error;
    }
  }

  #sameIdentity(source: HeldSource, stat: Awaited<ReturnType<FileHandle['stat']>>): boolean {
    return stat.isFile() && stat.dev === source.dev && stat.ino === source.ino && stat.size === source.size && stat.mtimeMs === source.mtimeMs;
  }

  async #namedSourceIsSame(relative: string, source: HeldSource): Promise<boolean> {
    try {
      if (this.#closed || !safeRelative(relative)) return false;
      const rootInfo = await lstat(this.#root), rootReal = await realpath(this.#root);
      if (this.#closed || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev !== this.#rootDev || rootInfo.ino !== this.#rootIno) return false;
      let current = rootReal;
      for (const segment of relative.split('/')) {
        current = path.join(current, segment);
        const info = await lstat(current), canonical = await realpath(current);
        const withinRoot = path.relative(rootReal, canonical);
        if (this.#closed || info.isSymbolicLink() || !withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) return false;
      }
      const named = await lstat(current), held = await source.handle.stat();
      return !this.#closed && samePath(current, source.path) && named.isFile() && !named.isSymbolicLink()
        && named.dev === source.dev && named.ino === source.ino && named.size === source.size && this.#sameIdentity(source, held);
    } catch { return false; }
  }
}
