// X-Hmac signer backed by the in-process ltsm bridge.
//   X-Hmac = base64(Hmac(deriveKey(SHA256("3.7.2"), SHA256(accessToken))).digest(path + body))
// OkLine okline/hmac_signer.py:13-14, 131-138; line-cli pkg/runner.go:349-411. The key derivation and the HMAC happen
// inside ltsm.wasm; the sandbox's command protocol only exposes `get_hmac(accessToken, path, body)`, so the derived key
// itself cannot be cached here. What is cached per SHA-256 of the token is a small signing context that memoises recent
// signatures (the HMAC is deterministic), so a retried identical request does not re-enter the wasm. A context never
// keeps the raw token.

import { createHash } from 'node:crypto';
import type { HmacSigner } from '../signer.js';
import { LtsmBridge } from './bridge.js';
import { LtsmUnavailableError, type LtsmStore } from './store.js';

const DEFAULT_CONTEXT_CACHE_SIZE = 8;
const SIGNATURES_PER_CONTEXT = 32;

/** The part of the bridge the signer needs. */
export interface HmacBridge {
  hmac(accessToken: string, path: string, body: string): Promise<string>;
  close(): void;
}

export interface LtsmHmacSignerOptions {
  /** Number of per-token signing contexts kept. */
  readonly contextCacheSize?: number;
}

class SigningContext {
  private readonly signatures = new Map<string, string>();

  constructor(private readonly bridge: HmacBridge) {}

  async sign(accessToken: string, path: string, body: string): Promise<string> {
    const key = `${path}\0${body}`;
    const cached = this.signatures.get(key);
    if (cached !== undefined) {
      this.signatures.delete(key);
      this.signatures.set(key, cached);
      return cached;
    }
    const signature = await this.bridge.hmac(accessToken, path, body);
    this.signatures.set(key, signature);
    if (this.signatures.size > SIGNATURES_PER_CONTEXT) {
      const oldest = this.signatures.keys().next();
      if (!oldest.done) this.signatures.delete(oldest.value);
    }
    return signature;
  }
}

export class LtsmHmacSigner implements HmacSigner {
  private readonly contexts = new Map<string, SigningContext>();
  private readonly cacheSize: number;

  constructor(
    private readonly bridge: HmacBridge,
    options: LtsmHmacSignerOptions = {},
  ) {
    this.cacheSize = Math.max(1, options.contextCacheSize ?? DEFAULT_CONTEXT_CACHE_SIZE);
  }

  /**
   * Builds a signer from verified assets. Throws `LtsmUnavailableError` (carrying the store status) unless the store is
   * `available`; the assets are re-verified as they are read.
   */
  static async fromStore(store: LtsmStore, options: LtsmHmacSignerOptions = {}): Promise<LtsmHmacSigner> {
    const status = await store.status();
    if (status.kind !== 'available') throw new LtsmUnavailableError(status);
    const assets = await store.load();
    const bridge = await LtsmBridge.create({ sandboxSource: assets.sandbox, wasm: assets.wasm });
    return new LtsmHmacSigner(bridge, options);
  }

  /** Signs a request. An empty token is valid (login). */
  async sign(accessToken: string, pathWithQuery: string, body: string): Promise<string> {
    const tokenHash = createHash('sha256').update(accessToken, 'utf8').digest('hex');
    let context = this.contexts.get(tokenHash);
    if (context) {
      this.contexts.delete(tokenHash);
    } else {
      context = new SigningContext(this.bridge);
    }
    this.contexts.set(tokenHash, context);
    if (this.contexts.size > this.cacheSize) {
      const oldest = this.contexts.keys().next();
      if (!oldest.done) this.contexts.delete(oldest.value);
    }
    return context.sign(accessToken, pathWithQuery, body);
  }

  /** Number of live per-token contexts (for tests and diagnostics). */
  get contextCount(): number {
    return this.contexts.size;
  }

  close(): void {
    this.contexts.clear();
    this.bridge.close();
  }
}
