// X-Hmac signer abstraction.
// The real signer (ltsm.wasm driven in-process, OkLine okline/hmac_signer.py) arrives in a later step; the gateway only
// depends on this interface.

import { createHash } from 'node:crypto';

/**
 * Signs a request. `pathWithQuery` is the request path plus `?query` for GETs (the signed text is exactly what goes on
 * the wire), `body` is the exact UTF-8 body string (`""` for GET). `accessToken` is `""` before login.
 * Returns the base64 value of the `X-Hmac` header.
 */
export interface HmacSigner {
  sign(accessToken: string, pathWithQuery: string, body: string): Promise<string>;
}

export interface SignerCall {
  readonly accessToken: string;
  readonly pathWithQuery: string;
  readonly body: string;
}

/** Deterministic test signer that records every call it receives. Not a real signature. */
export class FakeHmacSigner implements HmacSigner {
  readonly calls: SignerCall[] = [];
  private readonly produce: (call: SignerCall) => string;

  constructor(produce?: (call: SignerCall) => string) {
    this.produce = produce ?? defaultFakeSignature;
  }

  async sign(accessToken: string, pathWithQuery: string, body: string): Promise<string> {
    const call: SignerCall = { accessToken, pathWithQuery, body };
    this.calls.push(call);
    return this.produce(call);
  }
}

/** `fake-hmac:` + base64(sha256(token NUL path NUL body)). */
export function defaultFakeSignature(call: SignerCall): string {
  const digest = createHash('sha256')
    .update(call.accessToken, 'utf8')
    .update('\0')
    .update(call.pathWithQuery, 'utf8')
    .update('\0')
    .update(call.body, 'utf8')
    .digest('base64');
  return `fake-hmac:${digest}`;
}
