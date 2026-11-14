// Download of one chat photo or file through the official extension (phase 3a).
// Allowed extension calls: `eB` (one call for each download) and the pure path builder `QO` (inside the verification compare).
// Allowed store access: local reads of `IA.getState().message.entities.messages`. This module never opens a chat and never pages history.
// Every call is `Runtime.callFunctionOn` on a RemoteObject id. This module never defines or patches extension code.
// The real error code of each stage is kept. It is never mapped to a generic code.

import { BridgeError } from './errors.js';
import type { CdpPipe } from './cdp-pipe.js';
import type { ExtensionHandles } from './extension-handles.js';
import { buildMessageFromNativeRow, type BridgeMessage, type NativeRowInput } from './native-message.js';
import {
  BRIDGE_COMPARE_FUNCTION, BRIDGE_VERIFY_POLL_MS, classifyBridgeComparison, isSupportedImageHead,
  type BridgeKind, type BridgeVerification,
} from './bridge-verification.js';

/** Random gap between two bridge downloads: 2 to 5 s. */
export const BRIDGE_DOWNLOAD_GAP_MIN_MS = 2000;
export const BRIDGE_DOWNLOAD_GAP_MAX_MS = 5000;
export const BRIDGE_READ_SLICE_BYTES = 1024 * 1024;
const CALL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SLICE_TIMEOUT_MS = 60_000;
/** Bytes read from the start of a photo for the format check. */
const IMAGE_HEAD_BYTES = 12;
/** Content types of the extension: IMAGE=1, FILE=14 (main.js@2071833). */
const SUPPORTED_CONTENT_TYPES: readonly number[] = [1, 14];

export type BridgeDownloadStage = 'precheck' | 'locate' | 'download' | 'read';
/** Which message goes to `eB`: `native` is the message built from the official desktop row, `store` is the extension store message. */
export type BridgeAttemptStage = 'native' | 'store';
/** Result of the one attempt. `code` is null on success. It never holds a key, an id or a metadata value. */
export interface BridgeAttempt {
  readonly stage: BridgeAttemptStage;
  readonly code: string | null;
  readonly httpStatus: number | null;
}
/** Codes that this module creates. Extension codes (for example OBJECT_NOT_EXIST) and CDP codes pass through as text. */
export type BridgeDownloadCode =
  | 'BRIDGE_NOT_LOGGED_IN'
  | 'BRIDGE_CHAT_TYPE_UNSUPPORTED'
  | 'BRIDGE_CONTENT_TYPE_UNSUPPORTED'
  | 'BRIDGE_FILE_READ_FAILED'
  | 'MESSAGE_NOT_FOUND'
  /** The built message is missing a field that the extension needs. Only the native source gives this code. */
  | 'NATIVE_MESSAGE_INCOMPLETE'
  /** The File size differs from the FILE_SIZE of the message. */
  | 'BRIDGE_SIZE_MISMATCH'
  /** A photo File does not start with a known image format. */
  | 'BRIDGE_IMAGE_FORMAT_INVALID'
  /** The store message differs from the message built from the official row. The attachment service gives this code. */
  | 'BRIDGE_MESSAGE_MISMATCH'
  | 'BRIDGE_VERIFY_FAILED'
  | 'DOWNLOAD_IN_PROGRESS'
  | 'LINE_MEDIA_SIZE_LIMIT'
  | 'DOWNLOAD_ABORTED';

export class BridgeDownloadError extends Error {
  readonly code: string;
  readonly stage: BridgeDownloadStage;
  /** HTTP status of the failed LINE request, when the extension gave one. */
  readonly httpStatus: number | null;
  /** The attempt that ran before this error. */
  attempts: readonly BridgeAttempt[] = [];

  constructor(code: string, stage: BridgeDownloadStage, message: string, options: { httpStatus?: number | null; cause?: unknown } = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeDownloadError';
    this.code = code;
    this.stage = stage;
    this.httpStatus = options.httpStatus ?? null;
  }

  /** True when the server says that the file is gone. */
  get isExpired(): boolean {
    return this.code === 'OBJECT_NOT_EXIST';
  }
}

export interface BridgeDownloadRequest {
  readonly chatType: string;
  /** LINE server message id. It is the key of `message.entities.messages`. */
  readonly messageId: string;
  readonly kind: BridgeKind;
  /** The message that `eB` gets: the store message (by object id) or the message built from `nativeRow` (by value). */
  readonly source: BridgeAttemptStage;
  /** Plain `_message` row of the external-monitor message (`raw.native.row`). The `native` source builds the message from it. */
  readonly nativeRow?: NativeRowInput | null;
  /** Size from the attachment descriptor. A pre-check only. 0 or absent means unknown. */
  readonly expectedSizeBytes?: number | null;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface BridgeVerifyRequest {
  readonly messageId: string;
  readonly nativeRow?: NativeRowInput | null;
  /** Time to wait for the message to come into the store. 0 means one read and no wait. */
  readonly waitMs: number;
  readonly signal?: AbortSignal;
}

export interface BridgeDownloadedFile {
  readonly name: string;
  readonly size: number;
  /** The attempt that gave this file. */
  readonly attempts: readonly BridgeAttempt[];
  /** Reads the File in 1 MiB slices. It must be consumed inside the `run` callback. */
  readonly chunks: AsyncIterable<Uint8Array>;
}

export type LiveBridge = { readonly cdp: CdpPipe; readonly handles: ExtensionHandles };

export interface BridgeDownloaderOptions {
  readonly getLive: () => LiveBridge | null;
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam. Returns the gap after a download in ms. The default is random from 2 to 5 s. */
  readonly downloadGapMs?: () => number;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  objectId?: string;
  value?: unknown;
}
interface CallResult {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FILE_SIZE text of a message as an integer. Null when it is absent or not an integer. */
function parseFileSize(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

export class OfficialDownloadBridgeDownloader {
  readonly #getLive: () => LiveBridge | null;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #downloadGapMs: () => number;
  /** One download at a time for the whole bridge. */
  #tail: Promise<void> = Promise.resolve();
  /** One waiting verification at a time. This queue is separate: a verification never waits for the download lock. */
  #verifyTail: Promise<void> = Promise.resolve();

  constructor(options: BridgeDownloaderOptions) {
    this.#getLive = options.getLive;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#downloadGapMs = options.downloadGapMs
      ?? (() => BRIDGE_DOWNLOAD_GAP_MIN_MS + Math.floor(Math.random() * (BRIDGE_DOWNLOAD_GAP_MAX_MS - BRIDGE_DOWNLOAD_GAP_MIN_MS + 1)));
  }

  /** True when the bridge is logged in and Chrome is alive. */
  isLive(): boolean {
    return this.#getLive() !== null;
  }

  /**
   * Downloads the File with one `eB` call and calls `consume` while the File is readable.
   * The bridge lock stays until `consume` ends. The next download starts after a gap.
   */
  async run<T>(request: BridgeDownloadRequest, consume: (file: BridgeDownloadedFile) => Promise<T>): Promise<T> {
    this.#assertRequest(request);
    const previous = this.#tail;
    let unlock!: () => void;
    this.#tail = new Promise<void>((resolve) => { unlock = resolve; });
    try {
      await previous;
      return await this.#runLocked(request, consume);
    } finally {
      // The gap starts when the download ends. The caller does not wait for it.
      const gap = this.#downloadGapMs();
      void this.#sleep(gap).then(unlock, unlock);
    }
  }

  /**
   * Compares the store message with the message built from the official row. Memory reads only: no request goes to LINE.
   * With `waitMs` above 0 the store is read every 2 s until the message is there. These verifications run one at a time.
   * With `waitMs` 0 the store is read one time at once. The result is `not_in_store` when the message is not there.
   */
  async verify(request: BridgeVerifyRequest): Promise<BridgeVerification> {
    const built = buildMessageFromNativeRow(request.nativeRow);
    if (!built) return { result: 'native_incomplete', detail: 'native_incomplete' };
    if (request.waitMs <= 0) return this.#verifyStore(request, built, 0);
    const previous = this.#verifyTail;
    let unlock!: () => void;
    this.#verifyTail = new Promise<void>((resolve) => { unlock = resolve; });
    try {
      await previous;
      return await this.#verifyStore(request, built, request.waitMs);
    } finally {
      unlock();
    }
  }

  async #verifyStore(request: BridgeVerifyRequest, built: BridgeMessage, waitMs: number): Promise<BridgeVerification> {
    const reads = Math.floor(waitMs / BRIDGE_VERIFY_POLL_MS) + 1;
    for (let read = 0; read < reads; read += 1) {
      if (request.signal?.aborted) throw new BridgeDownloadError('DOWNLOAD_ABORTED', 'locate', 'verification was cancelled');
      const live = this.#getLive();
      if (!live) throw new BridgeDownloadError('BRIDGE_NOT_LOGGED_IN', 'precheck', 'download bridge is not logged in');
      const objectId = await this.#findStoreMessage(live, request.messageId);
      if (objectId) {
        try {
          return await this.#compareStoreMessage(live, objectId, built);
        } finally {
          await this.#release(live, objectId);
        }
      }
      if (read < reads - 1) await this.#sleep(BRIDGE_VERIFY_POLL_MS);
    }
    return { result: 'not_in_store', detail: 'not_in_store' };
  }

  /** One page call. The page gives back booleans and the words same, diff, missing_chrome and missing_official only. */
  async #compareStoreMessage(live: LiveBridge, objectId: string, built: BridgeMessage): Promise<BridgeVerification> {
    let response: RemoteObject;
    try {
      response = await this.#call(live, objectId, BRIDGE_COMPARE_FUNCTION,
        [{ value: built }, { objectId: live.handles.ids.QO }], { byValue: true });
    } catch (error) {
      throw this.#normalize(error);
    }
    const verification = classifyBridgeComparison(response.value);
    if (!verification) throw new BridgeDownloadError('BRIDGE_VERIFY_FAILED', 'locate', 'comparison result has a wrong shape');
    return verification;
  }

  #assertRequest(request: BridgeDownloadRequest): void {
    if (request.chatType !== 'direct' && request.chatType !== 'group' && request.chatType !== 'room') {
      throw new BridgeDownloadError('BRIDGE_CHAT_TYPE_UNSUPPORTED', 'precheck', `chat type ${request.chatType} is not supported by the extension`);
    }
    if (request.expectedSizeBytes && request.expectedSizeBytes > request.maxBytes) {
      throw new BridgeDownloadError('LINE_MEDIA_SIZE_LIMIT', 'precheck', `descriptor size ${request.expectedSizeBytes} is above ${request.maxBytes}`);
    }
  }

  async #runLocked<T>(request: BridgeDownloadRequest, consume: (file: BridgeDownloadedFile) => Promise<T>): Promise<T> {
    const live = this.#getLive();
    if (!live) throw new BridgeDownloadError('BRIDGE_NOT_LOGGED_IN', 'precheck', 'download bridge is not logged in');
    const ids: string[] = [];
    const attempts: BridgeAttempt[] = [];
    try {
      this.#checkAbort(request, 'locate');
      let file: { objectId: string; name: string; size: number };
      let expectedSize: number | null;
      // One `eB` call. There is no second attempt, no chat load and no other store action.
      try {
        let messageArgument: { objectId: string } | { value: BridgeMessage };
        if (request.source === 'store') {
          const storeId = await this.#findStoreMessage(live, request.messageId);
          if (!storeId) throw new BridgeDownloadError('MESSAGE_NOT_FOUND', 'locate', 'message is not in the extension store');
          ids.push(storeId);
          const info = await this.#readStoreInfo(live, storeId);
          if (!SUPPORTED_CONTENT_TYPES.includes(info.contentType)) {
            throw new BridgeDownloadError('BRIDGE_CONTENT_TYPE_UNSUPPORTED', 'precheck', 'content type is not image or file');
          }
          expectedSize = info.fileSize;
          messageArgument = { objectId: storeId };
        } else {
          const built = buildMessageFromNativeRow(request.nativeRow);
          if (!built) throw new BridgeDownloadError('NATIVE_MESSAGE_INCOMPLETE', 'precheck', 'the official row cannot build a message');
          expectedSize = parseFileSize(built.contentMetadata.FILE_SIZE);
          messageArgument = { value: built };
        }
        this.#checkAbort(request, 'download');
        file = await this.#download(live, messageArgument);
        attempts.push({ stage: request.source, code: null, httpStatus: null });
      } catch (error) {
        const failure = this.#normalize(error);
        attempts.push({ stage: request.source, code: failure.code, httpStatus: failure.httpStatus });
        throw failure;
      }
      ids.push(file.objectId);
      if (file.size > request.maxBytes) {
        throw new BridgeDownloadError('LINE_MEDIA_SIZE_LIMIT', 'download', 'file is above the size limit');
      }
      // These checks run before the first byte goes to the attachment store. A failed check leaves no file there.
      if (expectedSize !== null && file.size !== expectedSize) {
        throw new BridgeDownloadError('BRIDGE_SIZE_MISMATCH', 'download', 'File size differs from the message size');
      }
      if (request.kind === 'image') {
        const head = await this.#readHead(live, file.objectId, file.size);
        if (!isSupportedImageHead(head)) {
          throw new BridgeDownloadError('BRIDGE_IMAGE_FORMAT_INVALID', 'read', 'photo does not start with a known image format');
        }
      }
      return await consume({ name: file.name, size: file.size, attempts, chunks: this.#readSlices(live, file.objectId, file.size, request) });
    } catch (error) {
      const failure = this.#normalize(error);
      failure.attempts = attempts;
      throw failure;
    } finally {
      await Promise.all(ids.map((objectId) => this.#release(live, objectId)));
    }
  }

  #checkAbort(request: BridgeDownloadRequest, stage: BridgeDownloadStage): void {
    if (request.signal?.aborted) throw new BridgeDownloadError('DOWNLOAD_ABORTED', stage, 'download was cancelled');
  }

  #normalize(error: unknown): BridgeDownloadError {
    if (error instanceof BridgeDownloadError) return error;
    if (error instanceof BridgeError) return new BridgeDownloadError(error.code, 'download', error.message, { cause: error });
    return new BridgeDownloadError('BRIDGE_DOWNLOAD_FAILED', 'download', error instanceof Error ? error.message : String(error), { cause: error });
  }

  async #call(live: LiveBridge, objectId: string, functionDeclaration: string, args: unknown[], options: { awaitPromise?: boolean; byValue: boolean; timeoutMs?: number }): Promise<RemoteObject> {
    const response = (await live.cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args,
      awaitPromise: options.awaitPromise === true,
      returnByValue: options.byValue,
    }, live.handles.sessionId, options.timeoutMs ?? CALL_TIMEOUT_MS)) as CallResult;
    if (response.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'page call failed';
      throw new BridgeError('CDP_ERROR', `callFunctionOn: ${text.split('\n')[0] ?? text}`);
    }
    return response.result ?? {};
  }

  async #release(live: LiveBridge, objectId: string): Promise<void> {
    if (live.cdp.isClosed) return;
    await live.cdp.send('Runtime.releaseObject', { objectId }, live.handles.sessionId, 5_000).catch(() => undefined);
  }

  /** `IA.getState().message.entities.messages[id]` as a RemoteObject (main.js@1793740 writes this path, main.js@1819702 maps `message`). */
  async #findStoreMessage(live: LiveBridge, messageId: string): Promise<string | null> {
    const result = await this.#call(live, live.handles.ids.IA,
      "function(id){const s=this.getState();const m=s&&s.message&&s.message.entities&&s.message.entities.messages;return m&&Object.prototype.hasOwnProperty.call(m,id)&&m[id]?m[id]:null}",
      [{ value: messageId }], { byValue: false });
    return result.type === 'object' && result.subtype !== 'null' && result.objectId ? result.objectId : null;
  }

  /** Reads two numbers of the store message: the content type and the FILE_SIZE (null when it is absent or not an integer). */
  async #readStoreInfo(live: LiveBridge, objectId: string): Promise<{ contentType: number; fileSize: number | null }> {
    const result = await this.#call(live, objectId,
      "function(){const c=this.contentMetadata||{};const v=c.FILE_SIZE;const s=(v===undefined||v===null||v==='')?'':String(v);return {contentType:Number(this.contentType),fileSize:/^\\d{1,15}$/.test(s)?Number(s):null}}",
      [], { byValue: true });
    const value = result.value as { contentType?: unknown; fileSize?: unknown } | undefined;
    if (typeof value?.contentType !== 'number' || !(value.fileSize === null || (typeof value.fileSize === 'number' && Number.isSafeInteger(value.fileSize)))) {
      throw new BridgeDownloadError('BRIDGE_FILE_READ_FAILED', 'locate', 'store message info is not readable');
    }
    return { contentType: value.contentType, fileSize: value.fileSize };
  }

  /** Reads the first bytes of the File. */
  async #readHead(live: LiveBridge, fileId: string, size: number): Promise<Uint8Array> {
    const end = Math.min(size, IMAGE_HEAD_BYTES);
    let result: RemoteObject;
    try {
      result = await this.#call(live, fileId,
        "function(a,b){return this.slice(a,b).arrayBuffer().then(buf=>{const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i+=1){s+=String.fromCharCode(u[i])}return btoa(s)})}",
        [{ value: 0 }, { value: end }], { awaitPromise: true, byValue: true, timeoutMs: SLICE_TIMEOUT_MS });
    } catch (error) {
      throw new BridgeDownloadError(error instanceof BridgeError ? error.code : 'BRIDGE_FILE_READ_FAILED', 'read',
        error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (typeof result.value !== 'string') throw new BridgeDownloadError('BRIDGE_FILE_READ_FAILED', 'read', 'file head is not text');
    return new Uint8Array(Buffer.from(result.value, 'base64'));
  }

  /**
   * Calls `eB(message, "media_viewer")`. The message is a store message (by object id) or a built message (by value).
   * Returns the File as a RemoteObject id, plus its name and size.
   */
  async #download(live: LiveBridge, messageArgument: { objectId: string } | { value: BridgeMessage }): Promise<{ objectId: string; name: string; size: number }> {
    let wrapperId: string | undefined;
    try {
      const wrapper = await this.#call(live, live.handles.ids.eB,
        "function(m,c){return this(m,c).then(f=>({ok:true,file:f}),e=>({ok:false,code:String((e&&e.code)||(e&&e.name)||'UNKNOWN'),status:(e&&e.response&&e.response.status)||null}))}",
        [messageArgument, { value: 'media_viewer' }],
        { awaitPromise: true, byValue: false, timeoutMs: DOWNLOAD_TIMEOUT_MS });
      wrapperId = wrapper.objectId;
      if (!wrapperId) throw new BridgeDownloadError('BRIDGE_DOWNLOAD_FAILED', 'download', 'eB gave no result object');
      const props = (await live.cdp.send('Runtime.getProperties', { objectId: wrapperId, ownProperties: true }, live.handles.sessionId)) as {
        result?: Array<{ name: string; value?: RemoteObject }>;
      };
      const byName = new Map((props.result ?? []).map((entry) => [entry.name, entry.value] as const));
      if (byName.get('ok')?.value !== true) {
        const code = byName.get('code')?.value;
        const status = byName.get('status')?.value;
        throw new BridgeDownloadError(typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN', 'download', 'eB rejected',
          { httpStatus: typeof status === 'number' ? status : null });
      }
      const fileId = byName.get('file')?.objectId;
      // eB returns undefined when a transfer of the same message is already running.
      if (!fileId) throw new BridgeDownloadError('DOWNLOAD_IN_PROGRESS', 'download', 'extension transfer is already running');
      try {
        const info = await this.#call(live, fileId, 'function(){return {name:String(this.name),size:Number(this.size)}}', [], { byValue: true });
        const value = info.value as { name?: unknown; size?: unknown } | undefined;
        if (typeof value?.name !== 'string' || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
          throw new BridgeDownloadError('BRIDGE_FILE_READ_FAILED', 'read', 'File name or size is not readable');
        }
        return { objectId: fileId, name: value.name, size: value.size };
      } catch (error) {
        await this.#release(live, fileId);
        throw error;
      }
    } finally {
      if (wrapperId) await this.#release(live, wrapperId);
    }
  }

  async *#readSlices(live: LiveBridge, fileId: string, size: number, request: BridgeDownloadRequest): AsyncGenerator<Uint8Array> {
    for (let start = 0; start < size; start += BRIDGE_READ_SLICE_BYTES) {
      this.#checkAbort(request, 'read');
      const end = Math.min(size, start + BRIDGE_READ_SLICE_BYTES);
      let result: RemoteObject;
      try {
        result = await this.#call(live, fileId,
          `function(a,b){return this.slice(a,b).arrayBuffer().then(buf=>{const u=new Uint8Array(buf);let s='';
            for(let i=0;i<u.length;i+=0x8000){s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000))}return btoa(s)})}`,
          [{ value: start }, { value: end }], { awaitPromise: true, byValue: true, timeoutMs: SLICE_TIMEOUT_MS });
      } catch (error) {
        throw new BridgeDownloadError(error instanceof BridgeError ? error.code : 'BRIDGE_FILE_READ_FAILED', 'read',
          error instanceof Error ? error.message : String(error), { cause: error });
      }
      if (typeof result.value !== 'string') throw new BridgeDownloadError('BRIDGE_FILE_READ_FAILED', 'read', 'slice is not text');
      const bytes = Buffer.from(result.value, 'base64');
      if (bytes.length !== end - start) throw new BridgeDownloadError('BRIDGE_FILE_READ_FAILED', 'read', `slice length ${bytes.length} is not ${end - start}`);
      yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    }
  }
}
