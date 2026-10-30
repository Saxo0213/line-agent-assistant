// Test helpers for the auth layer: a path-routed fake fetch, a recording event sink and a fake bridge. No network.

import { ChromeGateway, type GatewayOptions } from '../gateway.js';
import { FakeHmacSigner } from '../signer.js';
import type { QrLoginBridge } from './qr-login.js';
import { ChromeSessionState, type ChromeSessionEvent } from './session-state.js';

export interface Recorded {
  url: string;
  path: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | undefined;
}

export type Reply = Response | Error | (() => Response | Promise<Response>);

export const ok = (data: unknown): Response => new Response(JSON.stringify({ message: 'OK', data }), { status: 200 });
export const failure = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
/** HTTP-error envelope of a long-poll window timeout (OkLine transport.py:850). */
export const poll410 = (): Response =>
  failure(400, { code: 10052, message: 'RESPONSE_HTTP_ERROR', data: { statusCode: 410, rejectionReason: 'timeout' } });

export const headerOf = (r: Recorded, name: string): string | undefined =>
  r.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

/** Routes by path: each path has a FIFO of replies. An unrouted or exhausted path throws. */
export class FakeServer {
  readonly requests: Recorded[] = [];
  private readonly routes = new Map<string, Reply[]>();

  on(path: string, ...replies: Reply[]): this {
    const queue = this.routes.get(path) ?? [];
    queue.push(...replies);
    this.routes.set(path, queue);
    return this;
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    this.requests.push({
      url,
      path,
      method: init.method ?? 'GET',
      headers: (init.headers as Array<[string, string]>).map(([n, v]) => [n, v]),
      body: init.body as string | undefined,
    });
    const next = this.routes.get(path)?.shift();
    if (next === undefined) throw new Error(`unexpected request to ${path}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };

  to(path: string): Recorded[] {
    return this.requests.filter((r) => r.path === path);
  }
}

export const thrift = (ns: string, svc: string, method: string): string => `/api/talk/thrift/${ns}/${svc}/${method}`;
export const QR = (m: string): string => thrift('LoginQrCode', 'SecondaryQrCodeLoginService', m);
export const QR_NOTICE = (m: string): string => thrift('LoginQrCode', 'SecondaryQrCodeLoginPermitNoticeService', m);
export const TOKEN_REFRESH = '/api/auth/tokenRefresh';
export const GET_PROFILE = thrift('Talk', 'TalkService', 'getProfile');
export const LOGOUT_V2 = thrift('Talk', 'AuthService', 'logoutV2');

export function makeGateway(server: FakeServer, state: ChromeSessionState, extra: Partial<GatewayOptions> = {}) {
  const signer = new FakeHmacSigner();
  const gateway = new ChromeGateway({
    fetch: server.fetch,
    signer,
    getAccessToken: () => state.accessToken ?? undefined,
    ...extra,
  });
  return { gateway, signer };
}

const EVENTS: ChromeSessionEvent[] = ['qr', 'pin', 'token', 'qrCert', 'storage', 'credentials', 'authInvalidated', 'refreshFailure'];

/** Records every worker-facing event in order. */
export function recordEvents(state: ChromeSessionState): Array<{ event: ChromeSessionEvent; value: unknown }> {
  const log: Array<{ event: ChromeSessionEvent; value: unknown }> = [];
  for (const event of EVENTS) state.on(event, (value) => void log.push({ event, value }));
  return log;
}

export class FakeQrBridge implements QrLoginBridge {
  readonly calls: string[] = [];
  failUnwrap = false;
  async curveKeyGenerate(): Promise<number> {
    this.calls.push('curveKeyGenerate');
    return 7;
  }
  async e2eePublicKey(keyId: number): Promise<string> {
    this.calls.push(`e2eePublicKey:${keyId}`);
    return 'cHVi+/a2V5PQ=='; // base64 with '+', '/' and '=' to exercise URL encoding
  }
  async e2eeCreateChannel(keyId: number, serverPubKeyB64: string): Promise<number> {
    this.calls.push(`e2eeCreateChannel:${keyId}:${serverPubKeyB64}`);
    return 70;
  }
  async e2eeUnwrapKeychain(channelId: number, encKeyChainB64: string): Promise<number[]> {
    this.calls.push(`e2eeUnwrapKeychain:${channelId}:${encKeyChainB64}`);
    if (this.failUnwrap) throw new Error('unwrap failed');
    return [101, 102];
  }
  async e2eeGetKeyId(handle: number): Promise<number> {
    this.calls.push(`e2eeGetKeyId:${handle}`);
    return handle === 101 ? 1000 : 2000;
  }
  async e2eeExportKey(handle: number): Promise<string> {
    this.calls.push(`e2eeExportKey:${handle}`);
    return `blob-${handle}`;
  }
}

export const LOGIN_RESULT = {
  tokenV3IssueResult: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenIssueTimeEpochSec: '1700000000',
    durationUntilRefreshInSec: '3600',
    refreshApiRetryPolicy: { initialDelayInMillis: '1000', maxDelayInMillis: '30000', multiplier: '2', jitterRate: '0.1' },
  },
  certificate: 'cert-1',
  mid: 'u0123456789abcdef0123456789abcdef',
  metaData: { publicKey: 'c2VydmVy', encryptedKeyChain: 'Y2hhaW4=' },
};
