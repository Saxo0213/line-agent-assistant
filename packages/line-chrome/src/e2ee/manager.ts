// E2EE (Letter Sealing) manager, 1:1 and group. Faithful port of OkLine okline/e2ee.py (E2EEManager :82-731) on top of the
// step-2 LtsmBridge. The linejs E2EE class is NOT used for CHROMEOS.
//
// Differences from OkLine, none of them protocol-visible:
//   - Public keys by (mid, keyId) and receive channels are cached (immutable inputs), and determineMediaMessageFlow
//     honours cacheTtlMillis: the extension caches too, and we must never send more requests than it does.
//   - A concurrent registerGroupKey for the same group shares one in-flight promise.
//   - Key persistence goes through the session-state `chrome:e2eeKeys` slot instead of OkLine's session file.
// `registerE2EEPublicKey` is never called (ruling): the interface has no such method.

import { ChromeApiError, ChromeE2eeError, ChromeError } from '../errors.js';
import { pythonInt, pythonTruthy } from '../json.js';
import type { ExportedE2eeKeys } from '../auth/session-state.js';
import type { QrLoginE2ee } from '../auth/qr-login.js';
import type { LtsmBridge } from '../ltsm/bridge.js';
import type { E2eeGroupSharedKey, E2eeKeyApi, E2eeNegotiation, E2eePublicKey, MediaMessageFlow } from './key-api.js';
import {
  buildChunks,
  buildChunksV1,
  buildE2eeMessage,
  mergeDecrypted,
  messageE2eeVersion,
  parseChunks,
  parseChunksV1,
  serializePlaintext,
  type ChromeMessage,
} from './framing.js';
import { classifyE2eeSendError, type E2eeSendErrorClass } from './send-errors.js';

export { ChromeE2eeError };

/** ContentType values (OkLine enums.py ContentType) that may be Letter-Sealed: the bundle's `sL`/`lL` whitelist. */
export const CONTENT_TYPE = { NONE: 0, IMAGE: 1, VIDEO: 2, AUDIO: 3, FILE: 14, LOCATION: 15 } as const;
export const SEALABLE_CONTENT_TYPES: ReadonlySet<number> = new Set([
  CONTENT_TYPE.NONE,
  CONTENT_TYPE.LOCATION,
  CONTENT_TYPE.IMAGE,
  CONTENT_TYPE.VIDEO,
  CONTENT_TYPE.FILE,
  CONTENT_TYPE.AUDIO,
]);
/** The bundle's `FP`: media types additionally need the negotiated media flow to be V2 before sealing. */
export const MEDIA_CONTENT_TYPES: ReadonlySet<number> = new Set([CONTENT_TYPE.IMAGE, CONTENT_TYPE.VIDEO, CONTENT_TYPE.FILE, CONTENT_TYPE.AUDIO]);
const MEDIA_FLOW_V2 = 2;
const NOT_FOUND_CODE = 5;
const CHANNEL_CACHE_LIMIT = 1000;

/** The slice of the ltsm bridge the manager drives (a fake in tests). */
export type E2eeBridge = Pick<
  LtsmBridge,
  | 'curveKeyGenerate'
  | 'e2eeGetKeyId'
  | 'e2eeExportKey'
  | 'e2eeLoadKey'
  | 'e2eePublicKeyForHandle'
  | 'e2eeCreateChannelWithPubkey'
  | 'e2eeEncryptV1'
  | 'e2eeEncryptV2'
  | 'e2eeDecryptV1'
  | 'e2eeDecryptV2'
  | 'e2eeWrapGroupSharedKey'
  | 'e2eeUnwrapGroupSharedKey'
>;

/** The persistence the manager needs. `ChromeSessionState` satisfies this structurally. */
export interface E2eeKeyStore {
  readonly mid: string | null;
  readonly e2eeKeys: ExportedE2eeKeys | null;
  setE2eeKeys(keys: ExportedE2eeKeys | null): void;
}

export interface ChromeE2eeOptions {
  bridge: E2eeBridge;
  api: E2eeKeyApi;
  store: E2eeKeyStore;
  now?: () => number;
}

interface Negotiation {
  specVersion: number;
  allowedTypes: number[];
}

interface PeerChannel {
  channel: number;
  myKeyId: number;
  peerKeyId: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
/** OkLine e2ee.py:332-333 `flow.get("flowMap") or {}` then `.get(...)`: a Python-falsy value gives {}, a map is used, any other value raises. */
function pythonFlowMap(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === false || raw === 0 || raw === '') return {};
  if (Array.isArray(raw)) {
    if (raw.length === 0) return {};
  } else if (isRecord(raw)) {
    return raw;
  }
  throw new ChromeE2eeError('determineMediaMessageFlow flowMap is not a map');
}

/** OkLine `_is_group`: ROOM(1), GROUP(2), SQUARE_CHAT(4) or a c/r/s mid prefix. */
export function isGroupTarget(message: ChromeMessage): boolean {
  const toType = pythonInt(pythonTruthy(message.toType) ? message.toType : 0);
  if (toType === 1 || toType === 2 || toType === 4) return true;
  const to = typeof message.to === 'string' ? message.to : '';
  return ['c', 'r', 's'].includes(to.slice(0, 1).toLowerCase());
}

export class ChromeE2ee {
  private readonly bridge: E2eeBridge;
  private readonly api: E2eeKeyApi;
  private readonly store: E2eeKeyStore;
  private readonly now: () => number;

  /** Our unwrapped E2EE keys: keyId -> bridge handle. */
  private readonly myKeys = new Map<number, number>();
  /** keyId -> exported blob. The module cannot re-export an imported key, so blobs are served from here (OkLine :88-91). */
  private readonly exportBlobs = new Map<number, string>();
  private latestKeyId: number | null = null;
  private readonly peerChannels = new Map<string, PeerChannel>();
  private readonly peerNegotiation = new Map<string, Negotiation>();
  private readonly groupNegotiation = new Map<string, Negotiation>();
  private readonly groupKeys = new Map<string, number>();
  private readonly publicKeys = new Map<string, E2eePublicKey>();
  private readonly channelCache = new Map<string, number>();
  private readonly mediaFlows = new Map<string, { flowMap: Record<string, unknown>; expiresAt: number }>();
  private readonly registering = new Map<string, Promise<{ handle: number; groupKeyId: number }>>();
  private seq = 0;

  constructor(options: ChromeE2eeOptions) {
    this.bridge = options.bridge;
    this.api = options.api;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  get myMid(): string | null {
    return this.store.mid ?? this.store.e2eeKeys?.mid ?? null;
  }

  isReady(): boolean {
    return this.myKeys.size > 0 && this.latestKeyId !== null;
  }

  // -- key loading / persistence (OkLine :111-197) --------------------------------------------------------------------

  /** OkLine `load_from_login`: adopt the live handles a QR login produced in this process. */
  adoptLogin(login: QrLoginE2ee): boolean {
    this.myKeys.clear();
    this.exportBlobs.clear();
    for (const [id, handle] of Object.entries(login.handles)) this.myKeys.set(Number(id), handle);
    for (const [id, blob] of Object.entries(login.exported.keys)) this.exportBlobs.set(Number(id), blob);
    this.latestKeyId = this.myKeys.size > 0 ? Math.max(...this.myKeys.keys()) : null;
    return this.isReady();
  }

  /** OkLine `export_keys`: the persistable key blobs, or null when not ready. */
  exportKeys(): ExportedE2eeKeys | null {
    if (!this.isReady()) return null;
    const keys: Record<string, string> = {};
    for (const keyId of this.myKeys.keys()) {
      const blob = this.exportBlobs.get(keyId);
      if (blob !== undefined) keys[String(keyId)] = blob;
    }
    return { mid: this.myMid, latestKeyId: this.latestKeyId, keys };
  }

  /** Writes the key blobs into the session state (`chrome:e2eeKeys`), which checkpoints the encrypted snapshot. */
  persist(): void {
    const keys = this.exportKeys();
    if (keys) this.store.setE2eeKeys(keys);
  }

  /** OkLine `load_from_export`: rebuild the keychain from the persisted blobs, no QR needed. */
  async loadFromState(): Promise<boolean> {
    const stored = this.store.e2eeKeys;
    if (!stored || Object.keys(stored.keys).length === 0) return false;
    this.myKeys.clear();
    for (const [id, blob] of Object.entries(stored.keys)) {
      try {
        const handle = await this.bridge.e2eeLoadKey(blob);
        this.myKeys.set(Number(id), handle);
        this.exportBlobs.set(Number(id), blob);
      } catch {
        /* OkLine :184-185: a key that fails to load is skipped */
      }
    }
    if (this.myKeys.size === 0) return false;
    const latest = stored.latestKeyId;
    this.latestKeyId = latest !== null && this.myKeys.has(latest) ? latest : Math.max(...this.myKeys.keys());
    return this.isReady();
  }

  // -- public keys / channels (OkLine :199-269, 484-490) --------------------------------------------------------------

  private async userPublicKey(mid: string, keyId: number | string): Promise<string> {
    const id = pythonInt(keyId);
    const cacheKey = `${mid}:${id}`;
    // keyId 0 means "the latest key of this user". The answer changes over time, so it is never read from or written to the cache
    // (OkLine e2ee.py:247-251).
    const cacheable = id !== 0;
    let pk = cacheable ? this.publicKeys.get(cacheKey) : undefined;
    if (!pk) {
      pk = await this.api.getPublicKey(mid, id);
      if (!isRecord(pk) || typeof pk.keyData !== 'string' || pk.keyData === '') {
        throw new ChromeE2eeError(`no E2EE public key for ${mid} keyId=${id}`);
      }
      if (cacheable) this.publicKeys.set(cacheKey, pk);
    }
    return pk.keyData as string;
  }

  private async channel(myHandle: number, peerPubB64: string): Promise<number> {
    const cacheKey = `${myHandle}|${peerPubB64}`;
    const cached = this.channelCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const channel = await this.bridge.e2eeCreateChannelWithPubkey(myHandle, peerPubB64);
    if (this.channelCache.size >= CHANNEL_CACHE_LIMIT) this.channelCache.delete(this.channelCache.keys().next().value as string);
    this.channelCache.set(cacheKey, channel);
    return channel;
  }

  /** OkLine `_negotiate_peer`: the peer's (publicKey, keyId) via negotiate, falling back to getE2EEPublicKey(mid, 1, 0). */
  private async negotiatePeer(peerMid: string): Promise<{ pub: string; keyId: number }> {
    const neg: E2eeNegotiation | undefined = await this.api.negotiatePublicKey(peerMid);
    if (isRecord(neg)) {
      // Parse both fields first. A parse error then caches nothing.
      const specVersion = pythonTruthy(neg.specVersion) ? pythonInt(neg.specVersion) : 2;
      const allowedTypes = Array.isArray(neg.allowedTypes) ? neg.allowedTypes.map((a) => pythonInt(a)) : [];
      this.peerNegotiation.set(peerMid, { specVersion, allowedTypes });
      const pk = neg.publicKey;
      if (isRecord(pk) && pythonTruthy(pk.keyData) && pk.keyId !== undefined && pk.keyId !== null) {
        return { pub: pk.keyData as string, keyId: pythonInt(pk.keyId) };
      }
    }
    if (!this.peerNegotiation.has(peerMid)) this.peerNegotiation.set(peerMid, { specVersion: 2, allowedTypes: [] });
    const gk = await this.api.getPublicKey(peerMid, 0);
    if (isRecord(gk) && gk.keyData !== undefined && gk.keyData !== null) return { pub: gk.keyData, keyId: pythonInt(gk.keyId === undefined ? 0 : gk.keyId) };
    throw new ChromeE2eeError(`could not negotiate E2EE key for ${peerMid}`);
  }

  private requireReady(): { latest: number; handle: number } {
    if (!this.isReady() || this.latestKeyId === null) throw new ChromeE2eeError('E2EE not initialised: log in with a QR login first');
    const handle = this.myKeys.get(this.latestKeyId);
    if (handle === undefined) throw new ChromeE2eeError('E2EE latest key is not loaded');
    return { latest: this.latestKeyId, handle };
  }

  private async channelForSend(peerMid: string): Promise<PeerChannel> {
    const existing = this.peerChannels.get(peerMid);
    if (existing) return existing;
    const { latest, handle } = this.requireReady();
    const peer = await this.negotiatePeer(peerMid);
    const channel = await this.channel(handle, peer.pub);
    const entry = { channel, myKeyId: latest, peerKeyId: peer.keyId };
    this.peerChannels.set(peerMid, entry);
    return entry;
  }

  private ownHandleFor(keyId: number): number {
    const handle = this.myKeys.get(keyId) ?? this.myKeys.get(this.latestKeyId ?? 0);
    if (handle === undefined) throw new ChromeE2eeError('no local E2EE key to decrypt with');
    return handle;
  }

  private async channelForReceive(senderMid: string, senderKeyId: number, receiverKeyId: number): Promise<number> {
    const myHandle = this.ownHandleFor(receiverKeyId);
    const pub = await this.userPublicKey(senderMid, senderKeyId);
    return this.channel(myHandle, pub);
  }

  /** OkLine `_channel_for_own`: our own sealed 1:1 messages read back from history use ECDH(our key, the recipient's key). */
  private async channelForOwn(peerMid: string, senderKeyId: number, receiverKeyId: number): Promise<number> {
    const myHandle = this.ownHandleFor(senderKeyId);
    return this.channel(myHandle, await this.userPublicKey(peerMid, receiverKeyId || 0));
  }

  // -- routers (OkLine :279-347) --------------------------------------------------------------------------------------

  /**
   * OkLine `encrypt`: sealed Message with `chunks`. Already-sealed messages and non-sealable content types are returned
   * untouched; negotiated `allowedTypes` and the media flow gate sealing like the extension's `encryptMessage`.
   * When `mediaFlowChecked` is true, the caller already ran `mediaFlowIsV2` for this send attempt, so the gate is skipped.
   */
  async encrypt(message: ChromeMessage, options: { mediaFlowChecked?: boolean } = {}): Promise<ChromeMessage> {
    if (pythonTruthy(message.chunks)) return message; // iL: already sealed (OK e2ee.py:294, Python truthiness)
    const contentType = pythonInt(pythonTruthy(message.contentType) ? message.contentType : 0);
    if (!SEALABLE_CONTENT_TYPES.has(contentType)) return message;
    const to = typeof message.to === 'string' ? message.to : '';
    const group = isGroupTarget(message);
    const negotiation = (group ? this.groupNegotiation : this.peerNegotiation).get(to);
    const allowed = negotiation?.allowedTypes ?? [];
    if (allowed.length > 0 && !allowed.includes(contentType)) return message;
    if (options.mediaFlowChecked !== true && MEDIA_CONTENT_TYPES.has(contentType) && !(await this.mediaFlowIsV2(to, contentType))) return message;
    return group ? this.encryptGroup(message) : this.encryptUser(message);
  }

  /** OkLine `_media_flow_is_v2`: best effort; any failure assumes V2 so a send is never silently downgraded to plain. */
  async mediaFlowIsV2(chatMid: string, contentType: number): Promise<boolean> {
    let entry = this.mediaFlows.get(chatMid);
    if (!entry || entry.expiresAt <= this.now()) {
      let flow: MediaMessageFlow | undefined;
      try {
        flow = await this.api.determineMediaMessageFlow(chatMid);
      } catch {
        return true; // OkLine e2ee.py:325-329 guards the RPC only
      }
      if (!isRecord(flow)) return true;
      // OkLine e2ee.py:332-333: a Python-falsy flowMap is {}; a truthy value that is not a map raises. Nothing is cached then.
      const flowMap = pythonFlowMap(flow.flowMap);
      let ttl = 0;
      try {
        ttl = pythonInt(flow.cacheTtlMillis ?? 0);
      } catch {
        ttl = 0;
      }
      entry = { flowMap, expiresAt: this.now() + Math.max(0, ttl) };
      if (ttl > 0) this.mediaFlows.set(chatMid, entry);
    }
    const value = entry.flowMap[String(contentType)];
    if (value === undefined || value === null) return true;
    return pythonInt(value) === MEDIA_FLOW_V2;
  }

  /** OkLine `decrypt`: V1 and V2 framing, 1:1 and group, including our own sealed messages read back from history. */
  async decrypt(message: ChromeMessage): Promise<ChromeMessage> {
    return isGroupTarget(message) ? this.decryptGroup(message) : this.decryptUser(message);
  }

  // -- 1:1 (OkLine :425-481) ------------------------------------------------------------------------------------------

  private async encryptUser(message: ChromeMessage): Promise<ChromeMessage> {
    const to = String(message.to);
    const from = typeof message.from === 'string' && message.from !== '' ? message.from : this.myMid;
    const { channel, myKeyId, peerKeyId } = await this.channelForSend(to);
    const plaintext = serializePlaintext(message);
    const specVersion = this.peerNegotiation.get(to)?.specVersion || 2;
    if (specVersion === 1) {
      // peer negotiated spec 1: V1 framing, no AAD fields
      const ct = Buffer.from(await this.bridge.e2eeEncryptV1(channel, b64(plaintext)), 'base64');
      return buildE2eeMessage(message, buildChunksV1(ct, myKeyId, peerKeyId), 1);
    }
    if (specVersion !== 2) throw new ChromeE2eeError(`unsupported E2EE specVersion ${specVersion} for ${to}`);
    if (from === null) throw new ChromeE2eeError('own mid unknown: cannot seal');
    const ct = Buffer.from(
      await this.bridge.e2eeEncryptV2(channel, {
        to,
        from,
        senderKeyId: myKeyId,
        receiverKeyId: peerKeyId,
        contentType: pythonInt(message.contentType === undefined ? 0 : message.contentType),
        sequenceNumber: this.nextSeq(),
        plaintextB64: b64(plaintext),
      }),
      'base64',
    );
    return buildE2eeMessage(message, buildChunks(ct, myKeyId, peerKeyId), 2);
  }

  private async decryptUser(message: ChromeMessage): Promise<ChromeMessage> {
    const chunks = Array.isArray(message.chunks) ? message.chunks : [];
    const version = messageE2eeVersion(message);
    const sender = typeof message.from === 'string' ? message.from : '';
    const to = typeof message.to === 'string' ? message.to : '';
    const parsed = version === 1 ? parseChunksV1(chunks) : parseChunks(chunks);
    const senderKeyId = parsed.senderKeyId ?? 0;
    const receiverKeyId = parsed.receiverKeyId ?? 0;
    const channel =
      sender !== '' && to !== '' && sender === this.myMid
        ? await this.channelForOwn(to, senderKeyId, receiverKeyId)
        : await this.channelForReceive(sender, senderKeyId, receiverKeyId);
    const ctB64 = b64(parsed.ciphertext);
    const pt =
      version === 1
        ? await this.bridge.e2eeDecryptV1(channel, ctB64)
        : await this.bridge.e2eeDecryptV2(channel, {
            to,
            from: sender,
            senderKeyId,
            receiverKeyId,
            contentType: pythonInt(message.contentType === undefined ? 0 : message.contentType),
            ciphertextB64: ctB64,
          });
    return mergeDecrypted(message, Buffer.from(pt, 'base64'));
  }

  // -- group (OkLine :492-652) ----------------------------------------------------------------------------------------

  /**
   * OkLine `_group_key_handle`: fetch and unwrap a group shared key (cached). `groupKeyId` undefined or 0 resolves the
   * latest key; a group without any (NOT_FOUND) gets one registered, the extension's `renewLatestGroupKey` fallback.
   */
  private async groupKeyHandle(groupMid: string, groupKeyId?: number): Promise<{ handle: number; groupKeyId: number }> {
    if (groupKeyId) {
      const cached = this.groupKeys.get(`${groupMid}:${groupKeyId}`);
      if (cached !== undefined) return { handle: cached, groupKeyId };
    }
    let gsk: E2eeGroupSharedKey | undefined;
    if (!groupKeyId) {
      try {
        gsk = await this.api.getLastGroupSharedKey(groupMid);
      } catch (error) {
        if (error instanceof ChromeApiError && error.code === NOT_FOUND_CODE) return this.registerGroupKey(groupMid);
        throw error;
      }
    } else {
      gsk = await this.api.getGroupSharedKey(groupMid, groupKeyId);
    }
    if (!isRecord(gsk) || !pythonTruthy(gsk.encryptedSharedKey)) throw new ChromeE2eeError(`no E2EE group shared key for ${groupMid}`);
    const gkid = pythonInt(gsk.groupKeyId === undefined ? (groupKeyId || 0) : gsk.groupKeyId);
    const cached = this.groupKeys.get(`${groupMid}:${gkid}`);
    if (cached !== undefined) return { handle: cached, groupKeyId: gkid };
    return this.unwrapGroupKey(groupMid, gsk);
  }

  /** OkLine `_unwrap_group_key`: caches the handle and the group's `allowedTypes`/`specVersion`. */
  private async unwrapGroupKey(groupMid: string, gsk: E2eeGroupSharedKey): Promise<{ handle: number; groupKeyId: number }> {
    const gkid = pythonInt(gsk.groupKeyId === undefined ? 0 : gsk.groupKeyId);
    const receiverKeyId = pythonInt(pythonTruthy(gsk.receiverKeyId) ? gsk.receiverKeyId : (this.latestKeyId || 0));
    const myHandle = this.myKeys.get(receiverKeyId) ?? this.myKeys.get(this.latestKeyId ?? 0);
    if (myHandle === undefined) throw new ChromeE2eeError('no local E2EE key to unwrap the group key');
    if (typeof gsk.creator !== 'string' || gsk.creatorKeyId === undefined) throw new ChromeE2eeError(`group key for ${groupMid} has no creator`);
    const unwrapChannel = await this.channel(myHandle, await this.userPublicKey(gsk.creator, gsk.creatorKeyId));
    const handle = await this.bridge.e2eeUnwrapGroupSharedKey(unwrapChannel, String(gsk.encryptedSharedKey));
    // Parse both fields first. A parse error then caches nothing.
    const specVersion = pythonInt(pythonTruthy(gsk.specVersion) ? gsk.specVersion : 2);
    const allowedTypes = Array.isArray(gsk.allowedTypes) ? gsk.allowedTypes.map((a) => pythonInt(a)) : [];
    this.groupKeys.set(`${groupMid}:${gkid}`, handle);
    this.groupNegotiation.set(groupMid, { specVersion, allowedTypes });
    return { handle, groupKeyId: gkid };
  }

  /**
   * OkLine `register_group_key` (the extension's `registerGroupKey`): generate a curve key, wrap it once per member public
   * key (`getLastE2EEPublicKeys`), upload via `registerE2EEGroupKey` (keyVersion 1), then unwrap the returned key locally.
   */
  registerGroupKey(groupMid: string): Promise<{ handle: number; groupKeyId: number }> {
    const inflight = this.registering.get(groupMid);
    if (inflight) return inflight;
    const run = this.doRegisterGroupKey(groupMid).finally(() => this.registering.delete(groupMid));
    this.registering.set(groupMid, run);
    return run;
  }

  private async doRegisterGroupKey(groupMid: string): Promise<{ handle: number; groupKeyId: number }> {
    const { handle: myHandle } = this.requireReady();
    const sharedKeyHandle = await this.bridge.curveKeyGenerate();
    const members = await this.api.getLastPublicKeys(groupMid);
    if (!isRecord(members) || Object.keys(members).length === 0) {
      throw new ChromeE2eeError(`no members with E2EE public keys for ${groupMid}`);
    }
    const memberMids: string[] = [];
    const keyIds: number[] = [];
    const wrapped: string[] = [];
    for (const [mid, pk] of Object.entries(members)) {
      const pub = isRecord(pk) && typeof pk.keyData === 'string' && pk.keyData !== '' ? pk.keyData : null;
      if (!pub) continue;
      const channel = await this.channel(myHandle, pub);
      wrapped.push(await this.bridge.e2eeWrapGroupSharedKey(channel, sharedKeyHandle));
      memberMids.push(mid);
      keyIds.push(pythonInt((pk as E2eePublicKey).keyId === undefined ? 0 : (pk as E2eePublicKey).keyId));
    }
    if (memberMids.length === 0) throw new ChromeE2eeError(`no member public key data for ${groupMid}`);
    const result = await this.api.registerGroupKey(groupMid, memberMids, keyIds, wrapped);
    if (!isRecord(result) || !pythonTruthy(result.encryptedSharedKey)) throw new ChromeE2eeError(`registerE2EEGroupKey returned no key for ${groupMid}`);
    return this.unwrapGroupKey(groupMid, result);
  }

  private async encryptGroup(message: ChromeMessage): Promise<ChromeMessage> {
    const groupMid = String(message.to);
    const { handle: gkHandle, groupKeyId } = await this.groupKeyHandle(groupMid);
    const { latest, handle: myHandle } = this.requireReady();
    const myPub = await this.bridge.e2eePublicKeyForHandle(myHandle);
    const channel = await this.channel(gkHandle, myPub);
    const plaintext = serializePlaintext(message);
    const specVersion = this.groupNegotiation.get(groupMid)?.specVersion || 2;
    if (specVersion === 1) {
      const ct = Buffer.from(await this.bridge.e2eeEncryptV1(channel, b64(plaintext)), 'base64');
      return buildE2eeMessage(message, buildChunksV1(ct, latest, groupKeyId), 1);
    }
    if (specVersion !== 2) throw new ChromeE2eeError(`unsupported E2EE specVersion ${specVersion} for ${groupMid}`);
    const from = this.myMid;
    if (from === null) throw new ChromeE2eeError('own mid unknown: cannot seal');
    const ct = Buffer.from(
      await this.bridge.e2eeEncryptV2(channel, {
        to: groupMid,
        from,
        senderKeyId: latest,
        receiverKeyId: groupKeyId,
        contentType: pythonInt(message.contentType === undefined ? 0 : message.contentType),
        sequenceNumber: this.nextSeq(),
        plaintextB64: b64(plaintext),
      }),
      'base64',
    );
    return buildE2eeMessage(message, buildChunks(ct, latest, groupKeyId), 2);
  }

  private async decryptGroup(message: ChromeMessage): Promise<ChromeMessage> {
    const chunks = Array.isArray(message.chunks) ? message.chunks : [];
    const version = messageE2eeVersion(message);
    const parsed = version === 1 ? parseChunksV1(chunks) : parseChunks(chunks);
    const senderKeyId = parsed.senderKeyId ?? 0;
    const groupKeyId = parsed.receiverKeyId ?? 0;
    const groupMid = typeof message.to === 'string' ? message.to : '';
    const sender = typeof message.from === 'string' ? message.from : '';
    const { handle: gkHandle } = await this.groupKeyHandle(groupMid, groupKeyId || undefined);
    const channel = await this.channel(gkHandle, await this.userPublicKey(sender, senderKeyId));
    const ctB64 = b64(parsed.ciphertext);
    const pt =
      version === 1
        ? await this.bridge.e2eeDecryptV1(channel, ctB64)
        : await this.bridge.e2eeDecryptV2(channel, {
            to: groupMid,
            from: sender,
            senderKeyId,
            receiverKeyId: groupKeyId,
            contentType: pythonInt(message.contentType === undefined ? 0 : message.contentType),
            ciphertextB64: ctB64,
          });
    return mergeDecrypted(message, Buffer.from(pt, 'base64'));
  }

  // -- send-error recovery (OkLine :654-710) --------------------------------------------------------------------------

  /** OkLine `reset_negotiation` (`resetE2eeInfo`): drop all cached E2EE state for one chat. */
  resetNegotiation(chatMid: string): void {
    this.peerChannels.delete(chatMid);
    this.peerNegotiation.delete(chatMid);
    this.groupNegotiation.delete(chatMid);
    this.mediaFlows.delete(chatMid);
    for (const key of [...this.groupKeys.keys()]) if (key.startsWith(`${chatMid}:`)) this.groupKeys.delete(key);
    for (const key of [...this.publicKeys.keys()]) if (key.startsWith(`${chatMid}:`)) this.publicKeys.delete(key);
  }

  /**
   * Applies the OkLine recovery for a failed sealed send and says whether the caller may retry exactly once (step 6 does
   * the retry under a fresh single-use permit). 84/86/87/88/90 reset; 99 resets and re-registers the group key for group
   * targets; 122 resets and must NOT be retried; anything else changes nothing.
   */
  async recoverFromSendError(message: ChromeMessage, error: unknown): Promise<{ retry: boolean; classification: E2eeSendErrorClass }> {
    const classification = classifyE2eeSendError(error);
    const to = typeof message.to === 'string' ? message.to : '';
    switch (classification.kind) {
      case 'refresh-media-flow':
        this.resetNegotiation(to);
        return { retry: false, classification };
      case 'recreate-group-key':
        this.resetNegotiation(to);
        if (isGroupTarget(message)) await this.registerGroupKey(to);
        return { retry: true, classification };
      case 'renegotiate':
        this.resetNegotiation(to);
        return { retry: true, classification };
      default:
        return { retry: false, classification };
    }
  }

  private nextSeq(): number {
    return this.seq++;
  }
}
