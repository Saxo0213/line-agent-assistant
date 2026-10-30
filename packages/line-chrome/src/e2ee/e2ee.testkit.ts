// Test doubles for the E2EE manager: a deterministic fake of the ltsm module's channel crypto and a fake key service.
// The fake cipher is symmetric in the two public keys (like ECDH) and authenticates the AAD fields, so a decrypt with the
// wrong framing, key ids, contentType or addresses fails exactly like the real one would.

import { createHash } from 'node:crypto';
import { ChromeApiError } from '../errors.js';
import type { ExportedE2eeKeys } from '../auth/session-state.js';
import type {
  E2eeGroupSharedKey,
  E2eeKeyApi,
  E2eeNegotiation,
  E2eePublicKey,
  MediaMessageFlow,
} from './key-api.js';
import type { E2eeBridge, E2eeKeyStore } from './manager.js';

const sha = (...parts: Array<string | Buffer>): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

const xorStream = (secret: string, data: Buffer): Buffer => {
  const key = sha(secret);
  return Buffer.from(data.map((byte, i) => byte ^ key[i % key.length]!));
};

export class FakeE2eeBridge implements E2eeBridge {
  readonly calls: string[] = [];
  readonly encryptV2: Array<{ channel: number; to: string; from: string; sequenceNumber: unknown }> = [];
  /** handle -> public key */
  readonly pubs = new Map<number, string>();
  /** exported blob -> handle */
  readonly blobs = new Map<string, number>();
  private readonly channels = new Map<number, string>();
  private nextChannel = 1000;
  private nextCurve = 900;

  async curveKeyGenerate(): Promise<number> {
    this.calls.push('curveKeyGenerate');
    const handle = this.nextCurve++;
    this.pubs.set(handle, `pub-curve-${handle}`);
    return handle;
  }
  async e2eeGetKeyId(): Promise<number> {
    return 0;
  }
  async e2eeExportKey(handle: number): Promise<string> {
    return `blob-${handle}`;
  }
  async e2eeLoadKey(blob: string): Promise<number> {
    this.calls.push(`loadKey:${blob}`);
    const handle = this.blobs.get(blob);
    if (handle === undefined) throw new Error('illegal blob');
    return handle;
  }
  async e2eePublicKeyForHandle(handle: number): Promise<string> {
    const pub = this.pubs.get(handle);
    if (pub === undefined) throw new Error(`no key ${handle}`);
    return pub;
  }
  async e2eeCreateChannelWithPubkey(handle: number, peerPubB64: string): Promise<number> {
    this.calls.push(`channel:${handle}:${peerPubB64}`);
    const mine = this.pubs.get(handle);
    if (mine === undefined) throw new Error(`no key ${handle}`);
    const id = this.nextChannel++;
    this.channels.set(id, [mine, peerPubB64].sort().join('|'));
    return id;
  }

  private secret(channel: number): string {
    const s = this.channels.get(channel);
    if (s === undefined) throw new Error(`no channel ${channel}`);
    return s;
  }

  private aad(to: string, from: string, sk: unknown, rk: unknown, ct: unknown): string {
    return `${to}|${from}|${String(sk)}|${String(rk)}|${String(ct)}`;
  }

  async e2eeEncryptV2(
    channel: number,
    p: { to: string; from: string; senderKeyId: number | string; receiverKeyId: number | string; contentType: number | string; sequenceNumber: unknown; plaintextB64: string },
  ): Promise<string> {
    this.encryptV2.push({ channel, to: p.to, from: p.from, sequenceNumber: p.sequenceNumber });
    const secret = this.secret(channel);
    const aad = this.aad(p.to, p.from, p.senderKeyId, p.receiverKeyId, p.contentType);
    const body = xorStream(secret, Buffer.from(p.plaintextB64, 'base64'));
    const head = sha(secret, aad).subarray(0, 16);
    const tag = sha(secret, aad, body).subarray(0, 12);
    return Buffer.concat([head, tag, body]).toString('base64');
  }

  async e2eeDecryptV2(
    channel: number,
    p: { to: string; from: string; senderKeyId: number | string; receiverKeyId: number | string; contentType: number | string; ciphertextB64: string },
  ): Promise<string> {
    const secret = this.secret(channel);
    const aad = this.aad(p.to, p.from, p.senderKeyId, p.receiverKeyId, p.contentType);
    const ct = Buffer.from(p.ciphertextB64, 'base64');
    const head = ct.subarray(0, 16);
    const tag = ct.subarray(16, 28);
    const body = ct.subarray(28);
    if (!head.equals(sha(secret, aad).subarray(0, 16)) || !tag.equals(sha(secret, aad, body).subarray(0, 12))) {
      throw new Error('v2 authentication failed');
    }
    return xorStream(secret, body).toString('base64');
  }

  async e2eeEncryptV1(channel: number, plaintextB64: string): Promise<string> {
    const secret = this.secret(channel);
    const body = xorStream(secret, Buffer.from(plaintextB64, 'base64'));
    const salt = sha(secret, 'salt').subarray(0, 8);
    const tag = sha(secret, body).subarray(0, 16);
    return Buffer.concat([salt, body, tag]).toString('base64');
  }

  async e2eeDecryptV1(channel: number, ciphertextB64: string): Promise<string> {
    const secret = this.secret(channel);
    const ct = Buffer.from(ciphertextB64, 'base64');
    const body = ct.subarray(8, ct.length - 16);
    if (!ct.subarray(ct.length - 16).equals(sha(secret, body).subarray(0, 16))) throw new Error('v1 authentication failed');
    return xorStream(secret, body).toString('base64');
  }

  async e2eeWrapGroupSharedKey(channel: number, keyHandle: number): Promise<string> {
    this.calls.push(`wrap:${keyHandle}`);
    return `wrapped:${keyHandle}:${channel}`;
  }

  async e2eeUnwrapGroupSharedKey(channel: number, encSharedKeyB64: string): Promise<number> {
    this.calls.push(`unwrapGroup:${encSharedKeyB64}`);
    const m = /^(?:gsk|wrapped):(\d+)/.exec(encSharedKeyB64);
    if (!m) throw new Error('bad group key');
    const handle = Number(m[1]);
    this.pubs.set(handle, `pub-group-${handle}`);
    void channel;
    return handle;
  }
}

export class FakeKeyApi implements E2eeKeyApi {
  readonly calls: string[] = [];
  readonly registered: Array<{ chat: string; members: readonly string[]; keyIds: ReadonlyArray<number | string>; wrapped: readonly string[] }> = [];
  readonly publicKeys = new Map<string, E2eePublicKey>();
  readonly negotiation = new Map<string, E2eeNegotiation>();
  readonly lastGroupKeys = new Map<string, E2eeGroupSharedKey | Error>();
  readonly groupKeys = new Map<string, E2eeGroupSharedKey>();
  readonly lastPublicKeys = new Map<string, Record<string, E2eePublicKey>>();
  registerResult: E2eeGroupSharedKey | undefined;
  mediaFlow: MediaMessageFlow | Error | undefined;

  async getPublicKey(mid: string, keyId: number | string): Promise<E2eePublicKey | undefined> {
    this.calls.push(`getPublicKey:${mid}:${String(keyId)}`);
    return this.publicKeys.get(`${mid}:${String(keyId)}`);
  }
  async negotiatePublicKey(mid: string): Promise<E2eeNegotiation | undefined> {
    this.calls.push(`negotiate:${mid}`);
    return this.negotiation.get(mid);
  }
  async getOwnPublicKeys(): Promise<unknown> {
    this.calls.push('getOwnPublicKeys');
    return [];
  }
  async getLastPublicKeys(chat: string): Promise<Record<string, E2eePublicKey> | undefined> {
    this.calls.push(`getLastPublicKeys:${chat}`);
    return this.lastPublicKeys.get(chat);
  }
  async getLastGroupSharedKey(chat: string): Promise<E2eeGroupSharedKey | undefined> {
    this.calls.push(`getLastGroupSharedKey:${chat}`);
    const v = this.lastGroupKeys.get(chat);
    if (v instanceof Error) throw v;
    return v;
  }
  async getGroupSharedKey(chat: string, id: number | string): Promise<E2eeGroupSharedKey | undefined> {
    this.calls.push(`getGroupSharedKey:${chat}:${String(id)}`);
    return this.groupKeys.get(`${chat}:${String(id)}`);
  }
  async registerGroupKey(
    chat: string,
    members: readonly string[],
    keyIds: ReadonlyArray<number | string>,
    wrapped: readonly string[],
  ): Promise<E2eeGroupSharedKey | undefined> {
    this.calls.push(`registerGroupKey:${chat}`);
    this.registered.push({ chat, members, keyIds, wrapped });
    return this.registerResult;
  }
  async determineMediaMessageFlow(chat: string): Promise<MediaMessageFlow | undefined> {
    this.calls.push(`mediaFlow:${chat}`);
    if (this.mediaFlow instanceof Error) throw this.mediaFlow;
    return this.mediaFlow;
  }
}

export class FakeStore implements E2eeKeyStore {
  e2eeKeys: ExportedE2eeKeys | null;
  saved = 0;
  constructor(
    readonly mid: string | null,
    keys: ExportedE2eeKeys | null = null,
  ) {
    this.e2eeKeys = keys;
  }
  setE2eeKeys(keys: ExportedE2eeKeys | null): void {
    this.e2eeKeys = keys;
    this.saved += 1;
  }
}

export const notFound = (): ChromeApiError => new ChromeApiError('not found', { code: 5, innerCode: 5 });
export const apiError = (code: number): ChromeApiError => new ChromeApiError(`E2EE ${code}`, { code, innerCode: code });
