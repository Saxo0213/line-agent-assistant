import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationKey } from '@line-agent/contracts';
import { NATIVE_PICTURE_ORIGINS } from '@line-agent/contracts';

const LINE_ORIGINS = new Set<string>(NATIVE_PICTURE_ORIGINS);
const STICKER_ORIGIN = 'https://stickershop.line-scdn.net';
const STICKER_ID = /^\d{1,20}$/;
const MIME_SIGNATURES = [
  { mimeType: 'image/png', valid: (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mimeType: 'image/jpeg', valid: (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mimeType: 'image/webp', valid: (bytes: Buffer) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mimeType: 'image/gif', valid: (bytes: Buffer) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) },
] as const;
type ImageMime = typeof MIME_SIGNATURES[number]['mimeType'];
type ImmutableAsset = { kind: 'sticker'; stickerId: string; animated: boolean } | { kind: 'sticon'; productId: string; sticonId: string; animated: boolean };
type MediaSource = { type: 'remote'; url: string; asset?: ImmutableAsset } | { type: 'attachment'; key: ConversationKey; attachmentId: string };
type RemoteFlight = { promise: Promise<MediaBytes | null>; controller: AbortController; waiters: number };
type MediaBytes = { bytes: Uint8Array; mimeType: string };
type Options = {
  fetch?: typeof fetch;
  loadAttachment?: (key: ConversationKey, attachmentId: string, signal: AbortSignal) => Promise<MediaBytes | null>;
  now?: () => number;
  cacheRoot?: string;
  remoteTimeoutMs?: number;
  remoteDeadlineMs?: number;
  maxRemoteRequests?: number;
  maxAttachmentBytes?: number;
  maxAttachmentStreams?: number;
  cacheFileSystem?: { open?: typeof open; writeFile?: typeof writeFile; rename?: typeof rename };
  onRemoteEnqueued?: (url: string) => void;
};
export type LineMediaSource = MediaSource;

function isAllowedRemote(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && LINE_ORIGINS.has(url.origin)
      && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function isAllowedStickerRemote(value: string, stickerId: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === STICKER_ORIGIN && !url.username && !url.password && !url.hash && !url.search
      && new RegExp(`^/stickershop/v1/sticker/${stickerId}/android/sticker(?:_animation)?\\.png$`).test(url.pathname);
  } catch { return false; }
}
function isAllowedSticonRemote(value: string, productId: string, sticonId: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === STICKER_ORIGIN && !url.username && !url.password && !url.hash && !url.search
      && new RegExp(`^/sticonshop/v1/sticon/${productId}/android/${sticonId}(?:_animation)?\\.png$`).test(url.pathname);
  } catch { return false; }
}
function isAllowedAssetRemote(value: string, asset: ImmutableAsset): boolean {
  return asset.kind === 'sticker' ? isAllowedStickerRemote(value, asset.stickerId) : isAllowedSticonRemote(value, asset.productId, asset.sticonId);
}
function assetUrl(asset: ImmutableAsset, animated = asset.animated): string {
  if (asset.kind === 'sticker') return `${STICKER_ORIGIN}/stickershop/v1/sticker/${asset.stickerId}/android/${animated ? 'sticker_animation' : 'sticker'}.png`;
  return `${STICKER_ORIGIN}/sticonshop/v1/sticon/${asset.productId}/android/${asset.sticonId}${animated ? '_animation' : ''}.png`;
}

function imageMime(bytes: Buffer, _declaredMime: string | null): ImageMime | null {
  const format = MIME_SIGNATURES.find((candidate) => candidate.valid(bytes));
  return format?.mimeType ?? null;
}

export class LineMediaService {
  readonly #fetch: typeof fetch;
  readonly #loadAttachment?: Options['loadAttachment'];
  readonly #now: () => number;
  readonly #cacheRoot: string;
  readonly #remoteTimeoutMs: number;
  readonly #remoteDeadlineMs: number;
  readonly #maxRemoteRequests: number;
  readonly #maxAttachmentBytes: number;
  readonly #maxAttachmentStreams: number;
  readonly #openCacheFile: typeof open;
  readonly #writeCacheFile: typeof writeFile;
  readonly #renameCacheFile: typeof rename;
  readonly #onRemoteEnqueued?: Options['onRemoteEnqueued'];
  #activeRemote = 0;
  readonly #remoteWaiters: Array<{ resolve: (value: (() => void) | null) => void; signal?: AbortSignal; abort?: () => void }> = [];
  readonly #remoteFlights = new Map<string, RemoteFlight>();
  readonly #negativeAnimated = new Map<string, number>();
  #activeAttachments = 0;
  readonly #attachmentWaiters: Array<{ resolve: (release: (() => void) | null) => void; signal?: AbortSignal; abort?: () => void }> = [];
  readonly #activeReads = new Set<AbortController>();
  #shutdown = false;
  readonly #shutdownController = new AbortController();

  constructor(options: Options = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#loadAttachment = options.loadAttachment;
    this.#now = options.now ?? Date.now;
    this.#cacheRoot = options.cacheRoot ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'LINEJS', 'avatar-cache');
    this.#remoteTimeoutMs = options.remoteTimeoutMs ?? 5_000;
    this.#remoteDeadlineMs = options.remoteDeadlineMs ?? 10_000;
    this.#maxRemoteRequests = options.maxRemoteRequests ?? 4;
    this.#maxAttachmentBytes = options.maxAttachmentBytes ?? 8 * 1024 * 1024;
    this.#maxAttachmentStreams = options.maxAttachmentStreams ?? 8;
    this.#openCacheFile = options.cacheFileSystem?.open ?? open;
    this.#writeCacheFile = options.cacheFileSystem?.writeFile ?? writeFile;
    this.#renameCacheFile = options.cacheFileSystem?.rename ?? rename;
    this.#onRemoteEnqueued = options.onRemoteEnqueued;
  }

  avatarSource(url: string): MediaSource | null {
    return isAllowedRemote(url) ? { type: 'remote', url } : null;
  }

  stickerSource(stickerId: string, animated: boolean): MediaSource | null {
    if (!STICKER_ID.test(stickerId)) return null;
    const asset: ImmutableAsset = { kind: 'sticker', stickerId, animated };
    return { type: 'remote', url: assetUrl(asset), asset };
  }

  sticonSource(productId: string, sticonId: string, animated: boolean): MediaSource | null {
    if (!/^[0-9a-f]{24}$/.test(productId) || !/^[0-9]{1,6}$/.test(sticonId) || typeof animated !== 'boolean') return null;
    const asset: ImmutableAsset = { kind: 'sticon', productId, sticonId, animated };
    return { type: 'remote', url: assetUrl(asset), asset };
  }

  attachmentSource(attachmentId: string, key: ConversationKey): MediaSource | null {
    if (this.#shutdown || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)
      || !this.#loadAttachment) return null;
    return { type: 'attachment', key: { ...key }, attachmentId };
  }

  async handle(source: MediaSource | null, signal?: AbortSignal): Promise<Response> {
    if (this.#shutdown || !source || signal?.aborted) return this.#notFound();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? this.#shutdownController.signal.reason);
    this.#activeReads.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    this.#shutdownController.signal.addEventListener('abort', abort, { once: true });
    let media: MediaBytes | null;
    try {
      media = source.type === 'remote'
        ? await this.#readRemote(source.url, controller.signal, source.asset)
        : await this.#readAttachment(source, controller.signal);
    } catch { media = null; }
    signal?.removeEventListener('abort', abort);
    this.#shutdownController.signal.removeEventListener('abort', abort);
    this.#activeReads.delete(controller);
    if (!media || controller.signal.aborted || this.#shutdown) return this.#notFound();
    const body = new Uint8Array(media.bytes);
    return new Response(body, { status: 200, headers: {
      'content-type': media.mimeType, 'content-length': String(media.bytes.byteLength),
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  }

  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#shutdownController.abort(new Error('LINE media shutdown'));
    this.#negativeAnimated.clear();
    for (const flight of this.#remoteFlights.values()) flight.controller.abort(new Error('LINE media shutdown'));
    for (const waiter of this.#remoteWaiters.splice(0)) { waiter.signal?.removeEventListener('abort', waiter.abort!); waiter.resolve(null); }
    for (const waiter of this.#attachmentWaiters.splice(0)) { waiter.signal?.removeEventListener('abort', waiter.abort!); waiter.resolve(null); }
    for (const read of this.#activeReads) read.abort(new Error('LINE media shutdown'));
  }

  async #readRemote(start: string, signal?: AbortSignal, asset?: ImmutableAsset): Promise<MediaBytes | null> {
    if (this.#shutdown || signal?.aborted) return null;
    const key = createHash('sha256').update(new URL(start).href).digest('hex');
    this.#purgeExpiring(this.#negativeAnimated);
    if (asset?.animated && this.#negativeAnimated.has(key)) {
      const staticUrl = assetUrl(asset, false);
      return await this.#readRemote(staticUrl, signal, { ...asset, animated: false });
    }
    return await this.#flight(start, asset, key, signal);
  }

  #flight(start: string, asset: ImmutableAsset | undefined, key: string, signal?: AbortSignal): Promise<MediaBytes | null> {
    if (this.#shutdown || signal?.aborted) return Promise.resolve(null);
    let flight = this.#remoteFlights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: RemoteFlight = { controller, waiters: 0, promise: Promise.resolve(null) };
      created.promise = this.#fetchAndCache(start, asset, key, controller.signal).then(async (media) => {
        if (!media && asset?.animated && !controller.signal.aborted) {
          this.#negativeAnimated.set(key, this.#now() + 10 * 60_000);
          while (this.#negativeAnimated.size > 512) this.#negativeAnimated.delete(this.#negativeAnimated.keys().next().value!);
          const staticUrl = assetUrl(asset, false);
          const fallbackKey = createHash('sha256').update(staticUrl).digest('hex');
          return await this.#flight(staticUrl, { ...asset, animated: false }, fallbackKey, controller.signal);
        }
        if (media && asset?.animated) this.#negativeAnimated.delete(key);
        return media;
      }).finally(() => { if (this.#remoteFlights.get(key) === created) this.#remoteFlights.delete(key); });
      flight = created; this.#remoteFlights.set(key, created);
    }
    flight.waiters++;
    let done = false;
    return new Promise((resolve) => {
      const finish = (value: MediaBytes | null) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort);
        flight!.waiters--; if (flight!.waiters === 0 && this.#remoteFlights.get(key) === flight) flight!.controller.abort(new Error('all LINE media readers cancelled'));
        resolve(value);
      };
      const abort = () => finish(null);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      flight!.promise.then(finish, () => finish(null));
    });
  }

  async #acquireRemote(url: string, signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.#shutdown || signal?.aborted) return null;
    if (this.#activeRemote < this.#maxRemoteRequests) { this.#activeRemote++; return () => this.#releaseRemote(); }
    return await new Promise((resolve) => {
      const waiter: { resolve: (value: (() => void) | null) => void; signal?: AbortSignal; abort?: () => void } = { resolve, ...(signal ? { signal } : {}) };
      waiter.abort = () => { const index = this.#remoteWaiters.indexOf(waiter); if (index >= 0) this.#remoteWaiters.splice(index, 1); signal?.removeEventListener('abort', waiter.abort!); resolve(null); };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.#remoteWaiters.push(waiter);
      this.#onRemoteEnqueued?.(url);
    });
  }

  #releaseRemote(): void {
    const next = this.#remoteWaiters.shift();
    if (next) { next.signal?.removeEventListener('abort', next.abort!); if (!this.#shutdown && !next.signal?.aborted) next.resolve(() => this.#releaseRemote()); else { this.#activeRemote--; next.resolve(null); } }
    else this.#activeRemote--;
  }

  async #fetchAndCache(start: string, asset: ImmutableAsset | undefined, key: string, signal?: AbortSignal): Promise<MediaBytes | null> {
    if (signal?.aborted || this.#shutdown) return null;
    const release = await this.#acquireRemote(start, signal);
    if (!release) return null;
    const cached = await this.#readDisk(key, true);
    if (cached) {
      if (asset || this.#now() - cached.fetchedAt <= 7 * 86400_000) { release(); return cached.media; }
    }
    if (signal?.aborted || this.#shutdown) { release(); return cached?.media ?? null; }
    const requestController = new AbortController();
    const relay = () => requestController.abort(signal?.reason ?? this.#shutdownController.signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    this.#shutdownController.signal.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => requestController.abort(new Error('LINE media deadline exceeded')), this.#remoteDeadlineMs);
    const deadlineAt = Date.now() + this.#remoteDeadlineMs;
    let current = start;
    let temp: string | undefined;
    try {
      for (let redirects = 0; redirects <= 2; redirects++) {
        if (requestController.signal.aborted || this.#shutdown) return cached?.media ?? null;
        if (asset ? !isAllowedAssetRemote(current, asset) : !isAllowedRemote(current)) return cached?.media ?? null;
        const requestTimer = setTimeout(() => requestController.abort(new Error('LINE media request timed out')), this.#remoteTimeoutMs);
        let response: Response;
        try { response = await this.#fetch(current, { method: 'GET', redirect: 'manual', signal: requestController.signal,
          headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } }); }
        finally { clearTimeout(requestTimer); }
        if (requestController.signal.aborted || this.#shutdown) { await this.#awaitRemoteCleanup(response.body?.cancel().catch(() => undefined), deadlineAt); return cached?.media ?? null; }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); await this.#awaitRemoteCleanup(response.body?.cancel().catch(() => undefined), deadlineAt);
          if (!location || redirects === 2) return cached?.media ?? null;
          current = new URL(location, current).href; continue;
        }
        if (!response.ok || !response.body) { await this.#awaitRemoteCleanup(response.body?.cancel().catch(() => undefined), deadlineAt); return cached?.media ?? null; }
        let cancelPromise: Promise<void> | undefined;
        const cancelBody = () => { cancelPromise = response.body?.cancel().then(() => undefined).catch(() => undefined); };
        requestController.signal.addEventListener('abort', cancelBody, { once: true });
        let bytes: Buffer;
        try { bytes = Buffer.from(await response.arrayBuffer()); }
        catch (error) { if (cancelPromise) await this.#awaitRemoteCleanup(cancelPromise, deadlineAt); throw error; }
        finally { requestController.signal.removeEventListener('abort', cancelBody); }
        if (requestController.signal.aborted || this.#shutdown) {
          await this.#awaitRemoteCleanup(cancelPromise ?? response.body?.cancel().then(() => undefined).catch(() => undefined), deadlineAt);
          return cached?.media ?? null;
        }
        const mimeType = imageMime(bytes, response.headers.get('content-type'));
        if (!bytes.byteLength || !mimeType) return cached?.media ?? null;
        try {
          await mkdir(this.#cacheRoot, { recursive: true, mode: 0o700 });
          temp = path.join(this.#cacheRoot, `${key}.${randomUUID()}.tmp`);
          const target = path.join(this.#cacheRoot, `${key}.img`);
          await this.#writeCacheFile(temp, bytes, { flag: 'wx', mode: 0o600 });
          if (requestController.signal.aborted || this.#shutdown) return cached?.media ?? null;
          await this.#renameCacheFile(temp, target); temp = undefined;
          await rm(path.join(this.#cacheRoot, `${key}.json`), { force: true }).catch(() => undefined);
        } catch { /* Cache persistence is best effort; the validated image remains usable. */ }
        return { bytes, mimeType };
      }
      return cached?.media ?? null;
    } catch { return cached?.media ?? null; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); this.#shutdownController.signal.removeEventListener('abort', relay); if (temp) await rm(temp, { force: true }).catch(() => undefined); release(); }
  }

  async #readDisk(key: string, deleteCorrupt = false, signal?: AbortSignal): Promise<{ media: MediaBytes; fetchedAt: number } | null> {
    const reading = this.#readDiskHandle(key, deleteCorrupt);
    if (!signal) return await reading;
    if (signal.aborted) return null;
    let abort!: () => void;
    const cancelled = new Promise<null>((resolve) => { abort = () => resolve(null); });
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([reading, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async #readDiskHandle(key: string, deleteCorrupt: boolean): Promise<{ media: MediaBytes; fetchedAt: number } | null> {
    const filename = path.join(this.#cacheRoot, `${key}.img`);
    try {
      try { await stat(path.join(this.#cacheRoot, `${key}.json`)); return null; } catch { /* no legacy sidecar */ }
      const handle = await this.#openCacheFile(filename, 'r');
      try {
        const info = await handle.stat();
        const bytes = await handle.readFile();
        const mimeType = imageMime(bytes, null);
        if (!mimeType || info.size === 0) { if (deleteCorrupt) await rm(filename, { force: true }).catch(() => undefined); return null; }
        return { media: { bytes, mimeType }, fetchedAt: info.mtimeMs };
      } finally { await handle.close(); }
    } catch { return null; }
  }

  #purgeExpiring(entries: Map<string, number>): void {
    const now = this.#now();
    for (const [key, expiry] of entries) if (expiry <= now) entries.delete(key);
  }

  async #awaitRemoteCleanup(pending: Promise<unknown> | undefined, deadlineAt: number): Promise<void> {
    if (!pending) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  async #acquireAttachment(signal: AbortSignal): Promise<(() => void) | null> {
    if (this.#shutdown || signal.aborted) return null;
    if (this.#activeAttachments < this.#maxAttachmentStreams) { this.#activeAttachments++; return () => this.#releaseAttachment(); }
    return await new Promise((resolve) => {
      const waiter: { resolve: (release: (() => void) | null) => void; signal?: AbortSignal; abort?: () => void } = { resolve, signal };
      waiter.abort = () => {
        const index = this.#attachmentWaiters.indexOf(waiter);
        if (index >= 0) this.#attachmentWaiters.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort!);
        resolve(null);
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#attachmentWaiters.push(waiter);
      if (signal.aborted) waiter.abort();
    });
  }

  #releaseAttachment(): void {
    const next = this.#attachmentWaiters.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.abort!);
      if (!this.#shutdown && !next.signal?.aborted) next.resolve(() => this.#releaseAttachment());
      else { this.#activeAttachments--; next.resolve(null); }
    } else this.#activeAttachments--;
  }

  async #readAttachment(source: Extract<MediaSource, { type: 'attachment' }>, signal: AbortSignal): Promise<MediaBytes | null> {
    if (signal.aborted || !this.#loadAttachment) return null;
    const release = await this.#acquireAttachment(signal);
    if (!release) return null;
    const load = this.#loadAttachment;
    const loading = (async (): Promise<MediaBytes | null> => {
      try {
        const result = await load(source.key, source.attachmentId, signal);
        if (!result || signal.aborted || result.bytes.byteLength <= 0 || result.bytes.byteLength > this.#maxAttachmentBytes) return null;
        const bytes = Buffer.from(result.bytes);
        const mimeType = imageMime(bytes, result.mimeType);
        return mimeType ? { bytes, mimeType } : null;
      } catch { return null; }
    })();
    // The stream slot stays reserved until the underlying load settles; an aborted reader settles immediately.
    void loading.then(release, release);
    let abort!: () => void;
    const aborted = new Promise<null>((resolve) => { abort = () => resolve(null); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await Promise.race([loading, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  #notFound(): Response { return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }); }
}
