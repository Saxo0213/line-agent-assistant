// In-process port of OkLine's okline/ltsm/ltsm_bridge.js (MIT) and the operations of okline/hmac_signer.py.
//
// The user's own ltsmSandbox.js (the extension's sandbox bundle) runs inside a `node:vm` context with the same minimal
// DOM shim, the same origin and the same postMessage command protocol the extension uses. ltsm.wasm is served to the
// bundle through the same synchronous-XHR / fetch shim. Nothing is spawned: the bridge lives in the worker process.
//
// The per-extension secret the HMAC is keyed with is NOT part of this code: the bundle selects it itself from
// `window.origin` (`SecureKey.loadToken(<table[origin]>)` inside its `init` command), so it is read at runtime from the
// user's own file. The bridge therefore only has to present the exact extension origin.

import vm from 'node:vm';
import { CHROME_EXTENSION_ORIGIN } from '../constants.js';
import { ChromeError } from '../errors.js';

/** `sandboxId` OkLine presents; the bundle only listens when `?sandboxId=` is present in `location.search`. */
const SANDBOX_ID = 'py';
const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_LOAD_TIMEOUT_MS = 60_000;

export class LtsmBridgeError extends ChromeError {}

export interface LtsmBridgeOptions {
  /** Contents of `ltsmSandbox.js`. */
  readonly sandboxSource: string | Uint8Array;
  /** Contents of `ltsm.wasm`. */
  readonly wasm: Uint8Array;
  /** Defaults to the LINE extension origin. */
  readonly origin?: string;
  /** Per-command wait for the sandbox's response. */
  readonly responseTimeoutMs?: number;
  /** Observes every message the sandbox posts to its parent (loaded, response, error). */
  readonly onParentMessage?: (message: unknown) => void;
}

type Listener = (event: unknown) => unknown;

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
}

export interface E2eeEncryptV2Params {
  readonly to: string;
  readonly from: string;
  readonly senderKeyId: number | string;
  readonly receiverKeyId: number | string;
  readonly contentType: number | string;
  readonly sequenceNumber: number | string | bigint;
  readonly plaintextB64: string;
}

export interface E2eeDecryptV2Params {
  readonly to: string;
  readonly from: string;
  readonly senderKeyId: number | string;
  readonly receiverKeyId: number | string;
  readonly contentType: number | string;
  readonly ciphertextB64: string;
}

/** uint64 Embind params want a BigInt; coerce numbers and strings safely (ltsm_bridge.js bigIntOrNum). */
function bigIntOrNum(value: number | string | bigint): bigint | number {
  try {
    return BigInt(value);
  } catch {
    return Number(value);
  }
}

function describeArgTypes(r: E2eeEncryptV2Params | E2eeDecryptV2Params): string {
  const sequence = 'sequenceNumber' in r ? r.sequenceNumber : undefined;
  return (
    `to=${typeof r.to} from=${typeof r.from} ` +
    `senderKeyId=${typeof r.senderKeyId}:${String(r.senderKeyId)} ` +
    `receiverKeyId=${typeof r.receiverKeyId}:${String(r.receiverKeyId)} ` +
    `contentType=${typeof r.contentType}:${String(r.contentType)} ` +
    `sequenceNumber=${typeof sequence}:${String(sequence)}`
  );
}

export class LtsmBridge {
  private readonly context: vm.Context;
  private readonly winListeners = new Map<string, Listener[]>();
  private readonly docListeners = new Map<string, Listener[]>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly responseTimeoutMs: number;
  private readonly onParentMessage: ((message: unknown) => void) | undefined;
  private readonly InnerUint8Array: Uint8ArrayConstructor;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(options: LtsmBridgeOptions) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.onParentMessage = options.onParentMessage;
    const origin = options.origin ?? CHROME_EXTENSION_ORIGIN;
    this.context = vm.createContext({});
    this.InnerUint8Array = vm.runInContext('Uint8Array', this.context) as Uint8ArrayConstructor;
    this.installShim(origin, options.wasm);
  }

  /**
   * Loads the sandbox bundle, fires DOMContentLoaded and sends `init`, in the order OkLine's bridge does. The returned
   * bridge is ready for commands.
   */
  static async create(options: LtsmBridgeOptions): Promise<LtsmBridge> {
    const bridge = new LtsmBridge(options);
    try {
      const source = typeof options.sandboxSource === 'string' ? options.sandboxSource : Buffer.from(options.sandboxSource).toString('utf8');
      const script = new vm.Script(source, { filename: 'ltsmSandbox.js' });
      script.runInContext(bridge.context, { timeout: DEFAULT_LOAD_TIMEOUT_MS });
      for (const listener of bridge.docListeners.get('DOMContentLoaded') ?? []) listener({});
      await bridge.send({ command: 'init' });
      return bridge;
    } catch (error) {
      bridge.close();
      if (error instanceof LtsmBridgeError) throw error;
      throw new LtsmBridgeError(`ltsm sandbox failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** Stops timers, rejects an in-flight command and drops the context. The bridge cannot be reused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
    this.winListeners.clear();
    this.docListeners.clear();
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new LtsmBridgeError('ltsm bridge closed'));
  }

  // ---- X-Hmac -------------------------------------------------------------------------------------------------------

  /** `get_hmac`: base64(Hmac(deriveKey(SHA256("3.7.2"), SHA256(accessToken))).digest(path + body)). */
  async hmac(accessToken: string, path: string, body: string): Promise<string> {
    const result = await this.send({ command: 'get_hmac', payload: { accessToken: accessToken || '', path, body: body || '' } });
    if (typeof result !== 'string' || result === '') throw new LtsmBridgeError('get_hmac returned no signature');
    return result;
  }

  // ---- Curve25519 / E2EE (QR login) ---------------------------------------------------------------------------------

  /** Generates a Curve25519 key in the module; returns its numeric handle. */
  async curveKeyGenerate(): Promise<number> {
    return this.numberResult(await this.send({ command: 'curvekey_generate' }), 'curvekey_generate');
  }

  /** Base64 public key of a handle from `curveKeyGenerate`. */
  async e2eePublicKey(keyId: number): Promise<string> {
    return this.bytesToB64(await this.send({ command: 'e2eekey_get_public_key', ltsmKeyId: keyId }));
  }

  /** Channel between our curve key and the peer's public key (QR: the server public key). */
  async e2eeCreateChannel(keyId: number, serverPubKeyB64: string): Promise<number> {
    return this.numberResult(
      await this.send({ command: 'e2eekey_create_channel', ltsmKeyId: keyId, payload: this.b64ToBytes(serverPubKeyB64) }),
      'e2eekey_create_channel',
    );
  }

  /** Unwraps the `qrCodeLoginV2` encrypted key chain; returns our unwrapped E2EE key handles. */
  async e2eeUnwrapKeychain(channelId: number, encKeyChainB64: string): Promise<number[]> {
    const result = await this.send({
      command: 'e2eechannel_unwrap_e2ee_key_chain',
      ltsmKeyId: channelId,
      payload: this.b64ToBytes(encKeyChainB64),
    });
    if (!Array.isArray(result)) throw new LtsmBridgeError('e2eechannel_unwrap_e2ee_key_chain returned no key list');
    return Array.from(result as ArrayLike<unknown>, Number);
  }

  async e2eeGetKeyId(keyHandle: number): Promise<number> {
    return this.numberResult(await this.send({ command: 'e2eekey_get_key_id', ltsmKeyId: keyHandle }), 'e2eekey_get_key_id');
  }

  async e2eePublicKeyForHandle(keyHandle: number): Promise<string> {
    return this.bytesToB64(await this.send({ command: 'e2eekey_get_public_key', ltsmKeyId: keyHandle }));
  }

  /** Channel between one of our key handles and a peer public key. */
  async e2eeCreateChannelWithPubkey(keyHandle: number, peerPubKeyB64: string): Promise<number> {
    return this.numberResult(
      await this.send({ command: 'e2eekey_create_channel', ltsmKeyId: keyHandle, payload: this.b64ToBytes(peerPubKeyB64) }),
      'e2eekey_create_channel',
    );
  }

  async e2eeEncryptV2(channelId: number, params: E2eeEncryptV2Params): Promise<string> {
    try {
      return this.bytesToB64(
        await this.send({
          command: 'e2eechannel_encrypt_v2',
          ltsmKeyId: channelId,
          payload: {
            to: params.to,
            from: params.from,
            senderKeyId: Number(params.senderKeyId),
            receiverKeyId: Number(params.receiverKeyId),
            contentType: Number(params.contentType),
            sequenceNumber: bigIntOrNum(params.sequenceNumber),
            plaintext: this.b64ToBytes(params.plaintextB64),
          },
        }),
      );
    } catch (error) {
      throw new LtsmBridgeError(`${errorMessage(error)} | args ${describeArgTypes(params)}`, { cause: error });
    }
  }

  async e2eeDecryptV2(channelId: number, params: E2eeDecryptV2Params): Promise<string> {
    try {
      return this.bytesToB64(
        await this.send({
          command: 'e2eechannel_decrypt_v2',
          ltsmKeyId: channelId,
          payload: {
            to: params.to,
            from: params.from,
            senderKeyId: Number(params.senderKeyId),
            receiverKeyId: Number(params.receiverKeyId),
            contentType: Number(params.contentType),
            ciphertext: this.b64ToBytes(params.ciphertextB64),
          },
        }),
      );
    } catch (error) {
      throw new LtsmBridgeError(`${errorMessage(error)} | args ${describeArgTypes(params)}`, { cause: error });
    }
  }

  /** V1 (old Letter Sealing) decrypt: the payload is the raw ciphertext. */
  async e2eeDecryptV1(channelId: number, ciphertextB64: string): Promise<string> {
    return this.bytesToB64(
      await this.send({ command: 'e2eechannel_decrypt_v1', ltsmKeyId: channelId, payload: this.b64ToBytes(ciphertextB64) }),
    );
  }

  /** V1 encrypt: the payload is the raw plaintext. */
  async e2eeEncryptV1(channelId: number, plaintextB64: string): Promise<string> {
    return this.bytesToB64(
      await this.send({ command: 'e2eechannel_encrypt_v1', ltsmKeyId: channelId, payload: this.b64ToBytes(plaintextB64) }),
    );
  }

  /** Wraps a group shared key (a key handle) for a member channel. The payload is the raw handle number. */
  async e2eeWrapGroupSharedKey(channelId: number, keyHandle: number): Promise<string> {
    return this.bytesToB64(
      await this.send({ command: 'e2eechannel_wrap_group_shared_key', ltsmKeyId: channelId, payload: Number(keyHandle) }),
    );
  }

  /** Serialises an unwrapped private-key handle so it can be persisted. */
  async e2eeExportKey(keyHandle: number): Promise<string> {
    return this.bytesToB64(await this.send({ command: 'e2eekey_export_key', ltsmKeyId: keyHandle }));
  }

  /** Re-imports an exported key blob; the payload sits at the top level of the command. */
  async e2eeLoadKey(exportedB64: string): Promise<number> {
    return this.numberResult(await this.send({ command: 'e2eekey_load_key', payload: this.b64ToBytes(exportedB64) }), 'e2eekey_load_key');
  }

  /** Unwraps a group's encrypted shared key into a group-key handle. */
  async e2eeUnwrapGroupSharedKey(channelId: number, encSharedKeyB64: string): Promise<number> {
    return this.numberResult(
      await this.send({ command: 'e2eechannel_unwrap_group_shared_key', ltsmKeyId: channelId, payload: this.b64ToBytes(encSharedKeyB64) }),
      'e2eechannel_unwrap_group_shared_key',
    );
  }

  /** Hash key chain for the e-mail device-confirm login flow. */
  async e2eeGenerateHashKeyChainToConfirmE2ee(channelId: number, encKeyChainB64: string): Promise<string> {
    return this.bytesToB64(
      await this.send({
        command: 'e2eechannel_generate_hash_key_chain_to_confirm_e2ee',
        ltsmKeyId: channelId,
        payload: this.b64ToBytes(encKeyChainB64),
      }),
    );
  }

  // ---- command protocol ---------------------------------------------------------------------------------------------

  /**
   * One request/response round trip over the sandbox's postMessage protocol (ltsm_bridge.js `send`). Commands are
   * serialised: the protocol correlates by order only.
   */
  private send(data: Record<string, unknown>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      if (this.closed) throw new LtsmBridgeError('ltsm bridge closed');
      const message = { data: { sandboxId: SANDBOX_ID, type: 'request', data } };
      const command = String(data.command);
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.resolve === wrappedResolve) this.pending = undefined;
          reject(new LtsmBridgeError(`no response for ${command}`));
        }, this.responseTimeoutMs);
        const wrappedResolve = (value: unknown): void => {
          clearTimeout(timer);
          resolve(value);
        };
        this.pending = {
          resolve: wrappedResolve,
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      });
      // Avoid an unhandled rejection if a listener throws before we await below.
      response.catch(() => undefined);
      try {
        for (const listener of this.winListeners.get('message') ?? []) await listener(message);
      } catch (error) {
        this.pending = undefined;
        throw new LtsmBridgeError(`${command} failed: ${errorMessage(error)}`, { cause: error });
      }
      return response;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Receives `window.parent.postMessage(...)` from the sandbox. */
  private handleParentMessage(message: unknown): void {
    this.onParentMessage?.(message);
    if (typeof message !== 'object' || message === null) return;
    const m = message as { sandboxId?: unknown; type?: unknown; data?: unknown };
    if (m.sandboxId !== SANDBOX_ID) return;
    if (m.type !== 'response' && m.type !== 'error') return;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (m.type === 'error') {
      const d = (m.data ?? {}) as { message?: unknown; name?: unknown };
      const text = (typeof d.message === 'string' && d.message) || (typeof d.name === 'string' && d.name) || String(m.data) || 'LTSM error';
      pending.reject(new LtsmBridgeError(text));
    } else {
      pending.resolve(m.data);
    }
  }

  // ---- byte helpers (ltsm_bridge.js b64ToBytes / bytesToB64) --------------------------------------------------------

  /** Typed arrays handed to the sandbox must come from its own realm (Embind checks `instanceof Uint8Array`). */
  private b64ToBytes(b64: string): Uint8Array {
    const outer = Buffer.from(String(b64), 'base64');
    const inner = new this.InnerUint8Array(outer.length);
    inner.set(outer);
    return inner;
  }

  private bytesToB64(value: unknown): string {
    if (!ArrayBuffer.isView(value)) throw new LtsmBridgeError('ltsm returned no bytes');
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
  }

  private numberResult(value: unknown, command: string): number {
    if (typeof value !== 'number') throw new LtsmBridgeError(`${command} returned no handle`);
    return value;
  }

  // ---- DOM / environment shim (ltsm_bridge.js "Minimal browser environment shims") ----------------------------------

  private installShim(origin: string, wasm: Uint8Array): void {
    const ctx = this.context as Record<string, unknown>;
    const self = this;
    const wasmBytes = Buffer.from(wasm.buffer, wasm.byteOffset, wasm.byteLength);
    const innerWasm = new this.InnerUint8Array(wasmBytes.length);
    innerWasm.set(wasmBytes);
    const wasmAB = innerWasm.buffer;

    const ATOB = (s: string): string => Buffer.from(s, 'base64').toString('binary');
    const BTOA = (s: string): string => Buffer.from(s, 'binary').toString('base64');

    const trackedTimeout = ((handler: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = setTimeout(handler, ms, ...args);
      self.timers.add(timer);
      return timer;
    }) as unknown as typeof setTimeout;
    const trackedInterval = ((handler: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = setInterval(handler, ms, ...args);
      self.timers.add(timer);
      return timer;
    }) as unknown as typeof setInterval;

    const fakeEl = (): Record<string, unknown> => ({
      setAttribute() {},
      getAttribute() {
        return null;
      },
      appendChild() {},
      removeChild() {},
      style: {},
      src: '',
    });
    const anchorEl = (): Record<string, unknown> => {
      let u: URL | null = null;
      const parse = (v: string): void => {
        try {
          u = new URL(v, `${origin}/`);
        } catch {
          u = new URL(`${origin}/`);
        }
      };
      return {
        setAttribute(k: string, v: string) {
          if (k === 'href') parse(v);
        },
        getAttribute() {
          return u ? (u as URL).href : null;
        },
        get href() {
          return u ? (u as URL).href : '';
        },
        get protocol() {
          return u ? (u as URL).protocol : '';
        },
        get host() {
          return u ? (u as URL).host : '';
        },
        get hostname() {
          return u ? (u as URL).hostname : '';
        },
        get port() {
          return u ? (u as URL).port : '';
        },
        get pathname() {
          return u ? (u as URL).pathname : '/';
        },
        get search() {
          return u ? (u as URL).search : '';
        },
        get hash() {
          return u ? (u as URL).hash : '';
        },
      };
    };

    const host = origin.replace('chrome-extension://', '');
    const location = {
      href: `${origin}/ltsmSandbox.html?sandboxId=${SANDBOX_ID}`,
      protocol: 'chrome-extension:',
      host,
      hostname: host,
      port: '',
      pathname: '/ltsmSandbox.html',
      search: `?sandboxId=${SANDBOX_ID}`,
      hash: '',
      origin,
    };

    const addTo = (map: Map<string, Listener[]>) => (type: string, cb: Listener) => {
      const list = map.get(type) ?? [];
      list.push(cb);
      map.set(type, list);
    };

    const documentShim: Record<string, unknown> = {
      addEventListener: addTo(this.docListeners),
      removeEventListener: () => {},
      createElement: (tag: unknown) => (String(tag).toLowerCase() === 'a' ? anchorEl() : fakeEl()),
      createElementNS: () => fakeEl(),
      createTextNode: () => fakeEl(),
      createComment: () => fakeEl(),
      createDocumentFragment: () => fakeEl(),
      createTreeWalker: () => ({ currentNode: null, nextNode: () => null, firstChild: () => null }),
      importNode: () => fakeEl(),
      adoptNode: () => fakeEl(),
      getElementsByTagName: () => [],
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      currentScript: { src: 'file:///ltsm/ltsmSandbox.js' },
      head: fakeEl(),
      body: fakeEl(),
      location,
    };

    const parent = { postMessage: (msg: unknown) => self.handleParentMessage(msg) };
    const navigatorShim = { userAgent: 'Mozilla/5.0 Chrome/124 LTSM-bridge', language: 'en-US' };

    // Encoders must hand back arrays of the sandbox's own realm.
    const bootstrap = vm.runInContext(
      `(function (outer) {
        class TextEncoder {
          constructor() { this._e = new outer.TextEncoder(); }
          get encoding() { return 'utf-8'; }
          encode(s) { return new Uint8Array(this._e.encode(s === undefined ? '' : s)); }
          encodeInto(s, d) { return this._e.encodeInto(s, d); }
        }
        class TextDecoder {
          constructor(label, options) { this._d = new outer.TextDecoder(label, options); }
          get encoding() { return this._d.encoding; }
          get fatal() { return this._d.fatal; }
          get ignoreBOM() { return this._d.ignoreBOM; }
          decode(input, options) { return this._d.decode(input, options); }
        }
        return { TextEncoder, TextDecoder };
      })`,
      this.context,
    ) as (outer: unknown) => { TextEncoder: unknown; TextDecoder: unknown };
    const codecs = bootstrap({ TextEncoder, TextDecoder });

    const windowShim: Record<string, unknown> = {
      origin,
      location,
      crypto: globalThis.crypto,
      atob: ATOB,
      btoa: BTOA,
      addEventListener: addTo(this.winListeners),
      removeEventListener: () => {},
      parent,
      postMessage: parent.postMessage,
      document: documentShim,
      navigator: navigatorShim,
      performance: globalThis.performance,
      screen: { width: 1280, height: 800 },
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (cb: (t: number) => void) => trackedTimeout(() => cb(performance.now()), 0),
      cancelAnimationFrame: () => {},
      requestIdleCallback: (cb: (d: unknown) => void) => trackedTimeout(() => cb({ timeRemaining: () => 0, didTimeout: false }), 0),
      cancelIdleCallback: () => {},
      setTimeout: trackedTimeout,
      clearTimeout,
      setInterval: trackedInterval,
      clearInterval,
    };

    const localStore = new Map<string, string>();
    const storage = {
      getItem: (k: string) => (localStore.has(k) ? localStore.get(k)! : null),
      setItem: (k: string, v: unknown) => {
        localStore.set(k, String(v));
      },
      removeItem: (k: string) => {
        localStore.delete(k);
      },
      clear: () => localStore.clear(),
    };

    // Emscripten fetches the wasm through a synchronous XMLHttpRequest in a web environment.
    class XMLHttpRequest {
      readyState = 0;
      status = 0;
      response: unknown = null;
      responseText = '';
      onload?: () => void;
      onerror?: () => void;
      onreadystatechange?: () => void;
      private rt = '';
      open(_method: string, _url: unknown): void {
        this.readyState = 1;
      }
      set responseType(v: string) {
        this.rt = v;
      }
      get responseType(): string {
        return this.rt;
      }
      setRequestHeader(): void {}
      addEventListener(t: string, cb: () => void): void {
        if (t === 'load') this.onload = cb;
        if (t === 'error') this.onerror = cb;
      }
      send(): void {
        if (this.rt === 'arraybuffer') this.response = wasmAB;
        else {
          this.responseText = wasmBytes.toString('binary');
          this.response = this.responseText;
        }
        this.status = 200;
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onload?.();
      }
    }

    const empty = (): Record<string, unknown> => ({
      documentElement: fakeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
    });

    const globals: Record<string, unknown> = {
      // Node-provided globals the bundle expects to find (they exist on OkLine's Node global).
      console,
      TextEncoder: codecs.TextEncoder,
      TextDecoder: codecs.TextDecoder,
      URL,
      URLSearchParams,
      AbortController,
      AbortSignal,
      EventTarget,
      Blob,
      Headers,
      Request,
      Response,
      FormData,
      MessageChannel,
      MessagePort,
      MessageEvent,
      queueMicrotask,
      structuredClone,
      setImmediate,
      clearImmediate,
      clearTimeout,
      clearInterval,
      setTimeout: trackedTimeout,
      setInterval: trackedInterval,
      // ltsm_bridge.js shims.
      window: windowShim,
      self: windowShim,
      document: documentShim,
      atob: ATOB,
      btoa: BTOA,
      crypto: globalThis.crypto,
      location,
      origin,
      history: { pushState() {}, replaceState() {}, back() {}, forward() {}, length: 0, state: null },
      parent,
      top: windowShim,
      navigator: navigatorShim,
      performance: globalThis.performance,
      // Cast: the DOM lib (desktop typecheck) does not accept Buffer as BodyInit; at runtime it is a Uint8Array.
      fetch: async () => new Response(wasmBytes as unknown as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/wasm' } }),
      localStorage: storage,
      sessionStorage: storage,
      XMLHttpRequest,
      customElements: { define() {}, get: () => undefined, whenDefined: () => Promise.resolve() },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      DOMParser: class DOMParser {
        parseFromString() {
          return empty();
        }
      },
      XMLSerializer: class XMLSerializer {
        serializeToString() {
          return '';
        }
      },
      MutationObserver: class MutationObserver {
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
      ResizeObserver: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      IntersectionObserver: class IntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    };
    for (const [name, value] of Object.entries(globals)) ctx[name] = value;

    const nodeGlobals = globalThis as unknown as Record<string, unknown>;
    for (const name of [
      'HTMLElement', 'HTMLIFrameElement', 'Element', 'CustomEvent', 'Event',
      'CSSStyleSheet', 'ShadowRoot', 'DocumentFragment', 'Text', 'Comment',
      'HTMLTemplateElement', 'HTMLStyleElement', 'HTMLDivElement', 'HTMLSpanElement',
      'HTMLInputElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLCanvasElement',
      'HTMLImageElement', 'HTMLScriptElement', 'SVGElement', 'File', 'FileReader',
      'Image', 'Notification', 'DOMException', 'Document', 'Window', 'HTMLDocument',
      'Range', 'StaticRange', 'NodeList', 'HTMLCollection', 'DOMTokenList',
      'NamedNodeMap', 'Attr', 'CharacterData', 'CSSRule', 'CSSStyleDeclaration',
      'StyleSheet', 'MediaQueryList', 'PerformanceObserver', 'NodeFilter',
      'XPathResult', 'DOMImplementation', 'Node',
    ]) {
      // ltsm_bridge.js: placeholder classes, but keep the real Node class when one exists.
      ctx[name] = typeof nodeGlobals[name] !== 'undefined' ? nodeGlobals[name] : class {};
    }
    const nodeClass = ctx.Node as { ELEMENT_NODE?: number; TEXT_NODE?: number };
    try {
      if (nodeClass && !nodeClass.ELEMENT_NODE) {
        nodeClass.ELEMENT_NODE = 1;
        nodeClass.TEXT_NODE = 3;
      }
    } catch {
      // ignore
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
