// E2EE key endpoints (Letter Sealing). Port of OkLine okline/services/e2ee.py:19-76 (+ determineMediaMessageFlow,
// services/messaging.py:312-324). Positional Thrift arguments, exactly as OkLine sends them.
//
// Design ruling 10: keyVersion is ALWAYS 1; callers cannot pass another value. `registerE2EEPublicKey` is never called:
// it is deliberately absent from this interface and from the endpoint registry's used set.

import type { ChromeGateway } from '../gateway.js';

/** The only E2EE key version the extension negotiates (ruling 10). */
export const E2EE_KEY_VERSION = 1;
/** OkLine `SyncReason.UNKNOWN` default for getE2EEPublicKeysEx. */
const SYNC_REASON_UNKNOWN = 1;

/** `E2EEPublicKey` as returned by the gateway. */
export interface E2eePublicKey {
  keyData?: string;
  keyId?: number | string;
  [field: string]: unknown;
}

export interface E2eeNegotiation {
  publicKey?: E2eePublicKey;
  allowedTypes?: unknown;
  specVersion?: unknown;
  [field: string]: unknown;
}

export interface E2eeGroupSharedKey {
  groupKeyId?: number | string;
  receiverKeyId?: number | string;
  creator?: string;
  creatorKeyId?: number | string;
  encryptedSharedKey?: string;
  allowedTypes?: unknown;
  specVersion?: unknown;
  [field: string]: unknown;
}

export interface MediaMessageFlow {
  flowMap?: Record<string, unknown>;
  cacheTtlMillis?: number | string;
  [field: string]: unknown;
}

/** What the E2EE manager needs from the server. A fake in tests, `GatewayE2eeKeyApi` in production. */
export interface E2eeKeyApi {
  /** `getE2EEPublicKey [mid, 1, keyId]`. */
  getPublicKey(mid: string, keyId: number | string): Promise<E2eePublicKey | undefined>;
  /** `negotiateE2EEPublicKey [mid]`. */
  negotiatePublicKey(mid: string): Promise<E2eeNegotiation | undefined>;
  /** `getE2EEPublicKeysEx [ignoreGroupKey, syncReason]`: the caller's own public keys. */
  getOwnPublicKeys(ignoreGroupKey?: boolean, syncReason?: number): Promise<unknown>;
  /** `getLastE2EEPublicKeys [chatMid]`: `{mid: E2EEPublicKey}`. */
  getLastPublicKeys(chatMid: string): Promise<Record<string, E2eePublicKey> | undefined>;
  /** `getLastE2EEGroupSharedKey [1, chatMid]`. */
  getLastGroupSharedKey(chatMid: string): Promise<E2eeGroupSharedKey | undefined>;
  /** `getE2EEGroupSharedKey [1, chatMid, groupKeyId]`. */
  getGroupSharedKey(chatMid: string, groupKeyId: number | string): Promise<E2eeGroupSharedKey | undefined>;
  /** `registerE2EEGroupKey [1, chatMid, members, keyIds, encryptedSharedKeys]`. A write: never retried. */
  registerGroupKey(
    chatMid: string,
    members: readonly string[],
    keyIds: ReadonlyArray<number | string>,
    encryptedSharedKeys: readonly string[],
  ): Promise<E2eeGroupSharedKey | undefined>;
  /** `determineMediaMessageFlow [{chatMid}]` -> `{flowMap, cacheTtlMillis}`. */
  determineMediaMessageFlow(chatMid: string): Promise<MediaMessageFlow | undefined>;
}

const toId = (v: number | string): number | string => (typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : v);

export class GatewayE2eeKeyApi implements E2eeKeyApi {
  constructor(private readonly gateway: ChromeGateway) {}

  getPublicKey(mid: string, keyId: number | string): Promise<E2eePublicKey | undefined> {
    return this.gateway.call('Talk.TalkService.getE2EEPublicKey', [mid, E2EE_KEY_VERSION, toId(keyId)], { mode: 'read' });
  }

  negotiatePublicKey(mid: string): Promise<E2eeNegotiation | undefined> {
    return this.gateway.call('Talk.TalkService.negotiateE2EEPublicKey', [mid], { mode: 'read' });
  }

  getOwnPublicKeys(ignoreGroupKey = false, syncReason: number = SYNC_REASON_UNKNOWN): Promise<unknown> {
    return this.gateway.call('Talk.TalkService.getE2EEPublicKeysEx', [ignoreGroupKey, syncReason], { mode: 'read' });
  }

  getLastPublicKeys(chatMid: string): Promise<Record<string, E2eePublicKey> | undefined> {
    return this.gateway.call('Talk.TalkService.getLastE2EEPublicKeys', [chatMid], { mode: 'read' });
  }

  getLastGroupSharedKey(chatMid: string): Promise<E2eeGroupSharedKey | undefined> {
    return this.gateway.call('Talk.TalkService.getLastE2EEGroupSharedKey', [E2EE_KEY_VERSION, chatMid], { mode: 'read' });
  }

  getGroupSharedKey(chatMid: string, groupKeyId: number | string): Promise<E2eeGroupSharedKey | undefined> {
    return this.gateway.call('Talk.TalkService.getE2EEGroupSharedKey', [E2EE_KEY_VERSION, chatMid, toId(groupKeyId)], { mode: 'read' });
  }

  registerGroupKey(
    chatMid: string,
    members: readonly string[],
    keyIds: ReadonlyArray<number | string>,
    encryptedSharedKeys: readonly string[],
  ): Promise<E2eeGroupSharedKey | undefined> {
    return this.gateway.call(
      'Talk.TalkService.registerE2EEGroupKey',
      [E2EE_KEY_VERSION, chatMid, [...members], keyIds.map(toId), [...encryptedSharedKeys]],
      { mode: 'write' },
    );
  }

  determineMediaMessageFlow(chatMid: string): Promise<MediaMessageFlow | undefined> {
    return this.gateway.call('Talk.TalkService.determineMediaMessageFlow', [{ chatMid }], { mode: 'read' });
  }
}
