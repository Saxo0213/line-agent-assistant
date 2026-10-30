import { describe, expect, it } from 'vitest';
import type { QrLoginE2ee } from '../auth/qr-login.js';
import { FakeE2eeBridge, FakeKeyApi, FakeStore, apiError, notFound } from './e2ee.testkit.js';
import { parseChunks, type ChromeMessage } from './framing.js';
import { ChromeError } from '../errors.js';
import { pythonInt } from '../json.js';
import { buildChromeSyncResult } from '../receive/op-normalize.js';
import { ChromeE2ee, ChromeE2eeError, isGroupTarget } from './manager.js';

const ALICE = `u${'a'.repeat(32)}`;
const BOB = `u${'b'.repeat(32)}`;
const GROUP = `c${'1'.repeat(32)}`;

interface World {
  bridge: FakeE2eeBridge;
  api: FakeKeyApi;
  alice: ChromeE2ee;
  bob: ChromeE2ee;
  aliceStore: FakeStore;
  bobStore: FakeStore;
}

function login(handle: number, keyId: number): QrLoginE2ee {
  return { handles: { [keyId]: handle }, exported: { mid: null, latestKeyId: keyId, keys: { [keyId]: `blob-${handle}` } } };
}

function world(): World {
  const bridge = new FakeE2eeBridge();
  bridge.pubs.set(1, 'pub-alice');
  bridge.pubs.set(2, 'pub-bob');
  bridge.blobs.set('blob-1', 1);
  bridge.blobs.set('blob-2', 2);
  const api = new FakeKeyApi();
  api.publicKeys.set(`${ALICE}:11`, { keyData: 'pub-alice', keyId: 11 });
  api.publicKeys.set(`${BOB}:22`, { keyData: 'pub-bob', keyId: 22 });
  api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, allowedTypes: [], specVersion: 2 });
  api.negotiation.set(ALICE, { publicKey: { keyData: 'pub-alice', keyId: 11 }, allowedTypes: [], specVersion: 2 });
  const aliceStore = new FakeStore(ALICE);
  const bobStore = new FakeStore(BOB);
  const alice = new ChromeE2ee({ bridge, api, store: aliceStore });
  const bob = new ChromeE2ee({ bridge, api, store: bobStore });
  alice.adoptLogin(login(1, 11));
  bob.adoptLogin(login(2, 22));
  return { bridge, api, alice, bob, aliceStore, bobStore };
}

const text = (to: string, body: string, extra: ChromeMessage = {}): ChromeMessage => ({
  to,
  toType: 0,
  contentType: 0,
  contentMetadata: {},
  sessionId: 0,
  hasContent: false,
  text: body,
  ...extra,
});

/** What the server delivers: the sealed message plus the sender and an id. */
const delivered = (sealed: ChromeMessage, from: string): ChromeMessage => ({ ...sealed, from, id: '100' });

describe('1:1 sealing', () => {
  it('V2 round-trips: text is sealed away, the peer decrypts it', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'hello bob', { from: ALICE }));
    expect(sealed.text).toBeUndefined();
    expect(sealed.from).toBeUndefined();
    expect((sealed.contentMetadata as Record<string, unknown>).e2eeVersion).toBe('2');
    const chunks = sealed.chunks as string[];
    expect(chunks).toHaveLength(5);
    const parsed = parseChunks(chunks);
    expect([parsed.senderKeyId, parsed.receiverKeyId]).toEqual([11, 22]);

    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect(plain.text).toBe('hello bob');
    expect(plain.chunks).toEqual([]);
  });

  it('seals under keys and AAD that the peer must reproduce (wrong contentType fails)', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'x'));
    await expect(w.bob.decrypt({ ...delivered(sealed, ALICE), contentType: 1 })).rejects.toThrow(/authentication/);
  });

  it('numbers the V2 sequence from 0 and increments per seal', async () => {
    const w = world();
    await w.alice.encrypt(text(BOB, 'a'));
    await w.alice.encrypt(text(BOB, 'b'));
    expect(w.bridge.encryptV2.map((c) => c.sequenceNumber)).toEqual([0, 1]);
    expect(w.bridge.encryptV2[0]).toMatchObject({ to: BOB, from: ALICE });
  });

  it('uses the peer negotiated specVersion 1 for V1 framing and e2eeVersion "1"', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion: 1 });
    const sealed = await w.alice.encrypt(text(BOB, 'old school'));
    expect((sealed.contentMetadata as Record<string, unknown>).e2eeVersion).toBe('1');
    expect(w.bridge.encryptV2).toHaveLength(0);
    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect(plain.text).toBe('old school');
  });

  it('rejects an unsupported specVersion', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion: 7 });
    await expect(w.alice.encrypt(text(BOB, 'x'))).rejects.toThrow(/specVersion 7/);
  });

  it('falls back to getE2EEPublicKey(mid, 1, 0) when negotiate returns no key', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { specVersion: 2 });
    w.api.publicKeys.set(`${BOB}:0`, { keyData: 'pub-bob', keyId: 22 });
    const sealed = await w.alice.encrypt(text(BOB, 'fallback'));
    expect(w.api.calls).toContain(`getPublicKey:${BOB}:0`);
    expect((await w.bob.decrypt(delivered(sealed, ALICE))).text).toBe('fallback');
  });

  it('decrypts our own sealed message read back from history (counterparty is the recipient)', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'mine'));
    const plain = await w.alice.decrypt(delivered(sealed, ALICE));
    expect(plain.text).toBe('mine');
    expect(w.api.calls).toContain(`getPublicKey:${BOB}:22`);
  });

  it('caches the negotiated channel per peer and public keys per (mid, keyId)', async () => {
    const w = world();
    await w.alice.encrypt(text(BOB, 'a'));
    await w.alice.encrypt(text(BOB, 'b'));
    expect(w.api.calls.filter((c) => c === `negotiate:${BOB}`)).toHaveLength(1);
    const sealed = await w.alice.encrypt(text(BOB, 'c'));
    await w.bob.decrypt(delivered(sealed, ALICE));
    await w.bob.decrypt(delivered(sealed, ALICE));
    expect(w.api.calls.filter((c) => c === `getPublicKey:${ALICE}:11`)).toHaveLength(1);
  });

  it('never caches the answer for keyId 0 (the latest key of the user)', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { specVersion: 2 }); // no key in the negotiation: the fallback asks for keyId 0
    w.api.publicKeys.set(`${BOB}:0`, { keyData: 'pub-bob', keyId: 22 });
    await w.alice.encrypt(text(BOB, 'a'));
    await w.alice.encrypt(text(BOB, 'b'));
    const own = await w.alice.decrypt(delivered(await w.alice.encrypt(text(BOB, 'c')), ALICE)); // history read-back asks the recipient key
    expect(own.text).toBe('c');
    expect(w.api.calls.filter((c) => c === `getPublicKey:${BOB}:0`).length).toBeGreaterThanOrEqual(1);
    // A keyId 0 lookup made twice in a row reaches the API twice and leaves nothing in the cache; a real keyId is cached.
    const direct = w.alice as unknown as { userPublicKey(mid: string, keyId: number): Promise<string>; publicKeys: Map<string, unknown> };
    w.api.calls.length = 0;
    await direct.userPublicKey(BOB, 0);
    await direct.userPublicKey(BOB, 0);
    expect(w.api.calls.filter((c) => c === `getPublicKey:${BOB}:0`)).toHaveLength(2);
    expect(direct.publicKeys.has(`${BOB}:0`)).toBe(false);
    await direct.userPublicKey(ALICE, 11);
    await direct.userPublicKey(ALICE, 11);
    expect(w.api.calls.filter((c) => c === `getPublicKey:${ALICE}:11`)).toHaveLength(1);
    w.api.calls.length = 0;
    const before = w.api.calls.filter((c) => c === `getPublicKey:${BOB}:0`).length;
    w.alice.resetNegotiation(BOB);
    await w.alice.encrypt(text(BOB, 'd'));
    await w.alice.encrypt(text(BOB, 'e'));
    w.alice.resetNegotiation(BOB);
    await w.alice.encrypt(text(BOB, 'f'));
    expect(w.api.calls.filter((c) => c === `getPublicKey:${BOB}:0`).length).toBe(before + 2);
  });

  it('carries sealed media key material: ENC_KM and FILE_NAME leave contentMetadata and come back decrypted', async () => {
    const w = world();
    const message = text(BOB, '', {
      text: undefined,
      contentType: 14,
      contentMetadata: { ENC_KM: 'a2V5bWF0ZXJpYWw=', FILE_NAME: 'doc.pdf', OID: 'oid', FILE_SIZE: '12' },
    });
    w.api.mediaFlow = { flowMap: { 14: 2 } };
    const sealed = await w.alice.encrypt(message);
    expect(sealed.contentMetadata).toEqual({ OID: 'oid', FILE_SIZE: '12', e2eeVersion: '2' });
    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect(plain.contentMetadata).toEqual({
      OID: 'oid',
      FILE_SIZE: '12',
      e2eeVersion: '2',
      ENC_KM: 'a2V5bWF0ZXJpYWw=',
      FILE_NAME: 'doc.pdf',
    });
  });

  it('seals REPLACE into the ciphertext and restores it parsed', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'edit', { contentMetadata: { REPLACE: '{"sid":"5"}' } }));
    expect((sealed.contentMetadata as Record<string, unknown>).REPLACE).toBeUndefined();
    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect((plain.contentMetadata as Record<string, unknown>).REPLACE).toEqual({ sid: '5' });
  });

  it('fails clearly without keys', async () => {
    const w = world();
    const cold = new ChromeE2ee({ bridge: w.bridge, api: w.api, store: new FakeStore(ALICE) });
    expect(cold.isReady()).toBe(false);
    await expect(cold.encrypt(text(BOB, 'x'))).rejects.toThrow(/not initialised/);
    await expect(cold.decrypt({ ...delivered(await w.alice.encrypt(text(BOB, 'x')), ALICE), to: BOB, from: ALICE })).rejects.toThrow();
  });

  it('fails decrypt for a sender key the server does not know', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'x'));
    w.api.publicKeys.delete(`${ALICE}:11`);
    await expect(w.bob.decrypt(delivered(sealed, ALICE))).rejects.toThrow(/no E2EE public key/);
  });
});

describe('sealing gates (OkLine encrypt)', () => {
  it('returns an already sealed message untouched', async () => {
    const w = world();
    const m = text(BOB, '', { chunks: ['a', 'b', 'c'] });
    expect(await w.alice.encrypt(m)).toBe(m);
  });

  it('chunks use Python truthiness: a non-empty string, object or number is already sealed (OkLine e2ee.py:294)', async () => {
    for (const chunks of ['x', { a: 1 }, 1]) {
      const w = world();
      const m = { ...text(BOB, 'x'), chunks };
      expect(await w.alice.encrypt(m)).toBe(m);
      expect(w.api.calls).toEqual([]);
      expect(w.bridge.calls).toEqual([]);
    }
    const w = world();
    expect((await w.alice.encrypt({ ...text(BOB, 'x'), chunks: [] })).chunks as string[]).toHaveLength(5);
  });

  it('a falsy contentType is 0 at the gate; [] and {} then fail in the seal after the negotiation (OkLine e2ee.py:296, :445)', async () => {
    for (const contentType of [[], {}]) {
      const w = world();
      await expect(w.alice.encrypt({ ...text(BOB, 'x'), contentType })).rejects.toBeInstanceOf(ChromeE2eeError);
      expect(w.api.calls).toEqual([`negotiate:${BOB}`]);
      expect(w.api.calls.some((c) => c.startsWith('sendMessage'))).toBe(false);
    }
    const w = world();
    expect((await w.alice.encrypt({ ...text(BOB, 'x'), contentType: 0 })).chunks as string[]).toHaveLength(5);
  });

  it('a group send with a [] contentType fails in the seal after the key reads and registers nothing (OkLine e2ee.py:622)', async () => {
    const w = world();
    const gsk = { groupKeyId: 7, receiverKeyId: 11, creator: BOB, creatorKeyId: 22, encryptedSharedKey: 'gsk:500', specVersion: 2, allowedTypes: [] };
    w.api.lastGroupKeys.set(GROUP, gsk);
    w.api.groupKeys.set(`${GROUP}:7`, gsk);
    await expect(w.alice.encrypt({ ...text(GROUP, 'x', { toType: 2 }), contentType: [] })).rejects.toBeInstanceOf(ChromeE2eeError);
    expect(w.api.calls).toEqual([`getLastGroupSharedKey:${GROUP}`, `getPublicKey:${BOB}:22`]);
    expect(w.api.registered).toHaveLength(0);
  });

  it('leaves non-sealable content types plain', async () => {
    const w = world();
    const sticker = text(BOB, '', { contentType: 7 });
    expect(await w.alice.encrypt(sticker)).toBe(sticker);
    expect(w.api.calls).toHaveLength(0);
  });

  it('seals location, and keeps `text` out of a location message', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, '', { text: undefined, contentType: 15, location: { latitude: 1, longitude: 2, title: 't' } }));
    expect(sealed.location).toBeUndefined();
    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect(plain.location).toEqual({ latitude: 1, longitude: 2, title: 't' });
  });

  it('honours negotiated allowedTypes once known', async () => {
    const w = world();
    await w.alice.encrypt(text(BOB, 'prime')); // negotiates
    w.alice.resetNegotiation(BOB);
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, allowedTypes: [1], specVersion: 2 });
    await w.alice.encrypt(text(BOB, 'again')); // caches allowedTypes [1] (image only), and seals this one: unknown before
    const m = text(BOB, 'plain now');
    expect(await w.alice.encrypt(m)).toBe(m);
  });

  it('media needs the V2 flow; a V1 flow map leaves it plain', async () => {
    const w = world();
    w.api.mediaFlow = { flowMap: { 1: 1 }, cacheTtlMillis: 60000 };
    const image = text(BOB, '', { text: undefined, contentType: 1, contentMetadata: { ENC_KM: 'a2V5' } });
    expect(await w.alice.encrypt(image)).toBe(image);
    w.api.mediaFlow = { flowMap: { 1: 2 } };
    const sealedAgainFromCache = await w.alice.encrypt(image);
    expect(sealedAgainFromCache).toBe(image); // the V1 answer is cached for its TTL: no second request
    expect(w.api.calls.filter((c) => c.startsWith('mediaFlow:'))).toHaveLength(1);
  });

  it('assumes V2 when the media flow lookup fails (no silent downgrade)', async () => {
    const w = world();
    w.api.mediaFlow = new Error('offline');
    const image = text(BOB, '', { text: undefined, contentType: 1, contentMetadata: { ENC_KM: 'a2V5' } });
    const sealed = await w.alice.encrypt(image);
    expect(sealed.chunks).toHaveLength(5);
  });
});

describe('flowMap parsing like Python (`flow.get("flowMap") or {}`)', () => {
  const image = () => text(BOB, '', { text: undefined, contentType: 1, contentMetadata: { ENC_KM: 'a2V5' } });
  const lookups = (w: World) => w.api.calls.filter((c) => c.startsWith('mediaFlow:'));
  it.each([['bad'], [1], [true], [[1]], ['0']])('a truthy non-map flowMap %j raises and is not cached', async (flowMap) => {
    const w = world();
    w.api.mediaFlow = { flowMap, cacheTtlMillis: 1000 } as never;
    await expect(w.alice.mediaFlowIsV2(BOB, 1)).rejects.toBeInstanceOf(ChromeE2eeError);
    await expect(w.alice.mediaFlowIsV2(BOB, 1)).rejects.toBeInstanceOf(ChromeE2eeError);
    expect(lookups(w)).toHaveLength(2);
    await expect(w.alice.encrypt(image())).rejects.toBeInstanceOf(ChromeE2eeError);
  });
  it.each([[null], [false], [0], [''], [[]], [{}]])('a falsy or empty flowMap %j gives {} and is cached for the TTL', async (flowMap) => {
    const w = world();
    w.api.mediaFlow = { flowMap, cacheTtlMillis: 1000 } as never;
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
    expect(lookups(w)).toHaveLength(1);
  });
  it.each([[null], [[1]], ['x']])('a flow answer %j that is not a map resolves true', async (flow) => {
    const w = world();
    w.api.mediaFlow = flow as never;
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
  });
  it('a failing RPC resolves true', async () => {
    const w = world();
    w.api.mediaFlow = new Error('offline');
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
  });
});

describe('one media flow lookup per send attempt', () => {
  const image = () => text(BOB, '', { text: undefined, contentType: 1, contentMetadata: { ENC_KM: 'a2V5' } });
  const lookups = (w: World) => w.api.calls.filter((c) => c.startsWith('mediaFlow:'));
  it('with cacheTtlMillis 0 one media send makes one lookup when the seal skips the gate', async () => {
    const w = world();
    w.api.mediaFlow = { flowMap: { 1: 2 }, cacheTtlMillis: 0 };
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true); // the prepare step
    const sealed = await w.alice.encrypt(image(), { mediaFlowChecked: true });
    expect(sealed.chunks).toHaveLength(5);
    expect(lookups(w)).toHaveLength(1);
  });
  it('a failing first lookup is not repeated by the seal', async () => {
    const w = world();
    w.api.mediaFlow = new Error('offline');
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
    const sealed = await w.alice.encrypt(image(), { mediaFlowChecked: true });
    expect(sealed.chunks).toHaveLength(5);
    expect(lookups(w)).toHaveLength(1);
  });
  it('a seal without prepare (the retry attempt) makes exactly one lookup', async () => {
    const w = world();
    w.api.mediaFlow = { flowMap: { 1: 2 }, cacheTtlMillis: 0 };
    await w.alice.encrypt(image(), { mediaFlowChecked: false });
    expect(lookups(w)).toHaveLength(1);
  });
});

describe('fixed public keys stay cached for the session', () => {
  it('2001 distinct (mid, keyId) lookups, then the first again: no second request for the first key', async () => {
    const w = world();
    const direct = w.alice as unknown as { userPublicKey(mid: string, keyId: number): Promise<string> };
    for (let keyId = 1; keyId <= 2001; keyId += 1) w.api.publicKeys.set(`${BOB}:${keyId}`, { keyData: `pub-${keyId}`, keyId });
    for (let keyId = 1; keyId <= 2001; keyId += 1) await direct.userPublicKey(BOB, keyId);
    await direct.userPublicKey(BOB, 1);
    expect(w.api.calls.filter((c) => c === `getPublicKey:${BOB}:1`)).toHaveLength(1);
  });
});

describe('group sealing', () => {
  const gsk = { groupKeyId: 7, receiverKeyId: 11, creator: BOB, creatorKeyId: 22, encryptedSharedKey: 'gsk:500', specVersion: 2, allowedTypes: [] };

  it('routes by toType/prefix', () => {
    expect(isGroupTarget({ toType: 2, to: 'x' })).toBe(true);
    expect(isGroupTarget({ toType: 1, to: 'x' })).toBe(true);
    expect(isGroupTarget({ toType: 4, to: 'x' })).toBe(true);
    expect(isGroupTarget({ toType: 0, to: GROUP })).toBe(true);
    expect(isGroupTarget({ toType: 0, to: `r${'1'.repeat(32)}` })).toBe(true);
    expect(isGroupTarget({ toType: 0, to: BOB })).toBe(false);
  });

  it('uses the latest shared key, then decrypts with the key id carried in the message', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, gsk);
    w.api.groupKeys.set(`${GROUP}:7`, gsk);
    const sealed = await w.alice.encrypt(text(GROUP, 'hi group', { toType: 2 }));
    const parsed = parseChunks(sealed.chunks as string[]);
    expect([parsed.senderKeyId, parsed.receiverKeyId]).toEqual([11, 7]);
    expect(w.api.calls).toContain(`getLastGroupSharedKey:${GROUP}`);

    const plain = await w.bob.decrypt(delivered(sealed, ALICE));
    expect(plain.text).toBe('hi group');
    expect(w.api.calls).toContain(`getGroupSharedKey:${GROUP}:7`);
  });

  it('registers a group key when the group has none (NOT_FOUND), wrapping once per member, keyVersion handled by the api', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, notFound());
    w.api.lastPublicKeys.set(GROUP, { [ALICE]: { keyData: 'pub-alice', keyId: 11 }, [BOB]: { keyData: 'pub-bob', keyId: 22 }, [`u${'c'.repeat(32)}`]: {} });
    w.api.registerResult = { ...gsk, encryptedSharedKey: 'wrapped:900:1' };
    const sealed = await w.alice.encrypt(text(GROUP, 'first message', { toType: 2 }));
    expect(w.api.registered).toHaveLength(1);
    const reg = w.api.registered[0]!;
    expect(reg.members).toEqual([ALICE, BOB]); // the member without keyData is skipped
    expect(reg.keyIds).toEqual([11, 22]);
    expect(reg.wrapped).toHaveLength(2);
    expect(reg.wrapped[0]).toMatch(/^wrapped:900:/);
    expect(parseChunks(sealed.chunks as string[]).receiverKeyId).toBe(7);
  });

  it('shares one in-flight registration between concurrent sends', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, notFound());
    w.api.lastPublicKeys.set(GROUP, { [ALICE]: { keyData: 'pub-alice', keyId: 11 } });
    w.api.registerResult = { ...gsk, encryptedSharedKey: 'wrapped:900:1' };
    await Promise.all([w.alice.registerGroupKey(GROUP), w.alice.registerGroupKey(GROUP)]);
    expect(w.api.registered).toHaveLength(1);
  });

  it('propagates other errors from the latest-key lookup instead of registering', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, apiError(8));
    await expect(w.alice.encrypt(text(GROUP, 'x', { toType: 2 }))).rejects.toThrow();
    expect(w.api.registered).toHaveLength(0);
  });

  it('falls back to V1 framing when the group negotiated specVersion 1', async () => {
    const w = world();
    const v1 = { ...gsk, specVersion: 1 };
    w.api.lastGroupKeys.set(GROUP, v1);
    w.api.groupKeys.set(`${GROUP}:7`, v1);
    const sealed = await w.alice.encrypt(text(GROUP, 'v1 group', { toType: 2 }));
    expect((sealed.contentMetadata as Record<string, unknown>).e2eeVersion).toBe('1');
    expect((await w.bob.decrypt(delivered(sealed, ALICE))).text).toBe('v1 group');
  });
});

describe('key persistence', () => {
  it('exports the blobs captured at login and persists them through the store', () => {
    const w = world();
    expect(w.alice.exportKeys()).toEqual({ mid: ALICE, latestKeyId: 11, keys: { 11: 'blob-1' } });
    w.alice.persist();
    expect(w.aliceStore.saved).toBe(1);
    expect(w.aliceStore.e2eeKeys?.keys).toEqual({ 11: 'blob-1' });
  });

  it('reloads from the persisted blobs without a QR login and serves the original blobs on re-export', async () => {
    const w = world();
    const stored = { mid: ALICE, latestKeyId: 11, keys: { 11: 'blob-1', 5: 'blob-missing' } };
    const store = new FakeStore(ALICE, stored);
    const restored = new ChromeE2ee({ bridge: w.bridge, api: w.api, store });
    expect(await restored.loadFromState()).toBe(true); // the key that fails to load is skipped
    expect(restored.exportKeys()).toEqual({ mid: ALICE, latestKeyId: 11, keys: { 11: 'blob-1' } });
    const sealed = await restored.encrypt(text(BOB, 'after restart'));
    expect((await w.bob.decrypt(delivered(sealed, ALICE))).text).toBe('after restart');
    expect(w.bridge.calls.filter((c) => c.startsWith('loadKey:'))).toHaveLength(2);
  });

  it('is not ready from an empty state', async () => {
    const w = world();
    const restored = new ChromeE2ee({ bridge: w.bridge, api: w.api, store: new FakeStore(ALICE) });
    expect(await restored.loadFromState()).toBe(false);
    expect(restored.exportKeys()).toBeNull();
  });
});

describe('resetNegotiation', () => {
  it('drops the negotiation, the channel, the cached public keys of the chat and nothing else', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'a'));
    await w.bob.decrypt(delivered(sealed, ALICE));
    const peek = (e2ee: unknown) => e2ee as { peerChannels: Map<string, unknown>; peerNegotiation: Map<string, unknown>; publicKeys: Map<string, unknown> };
    const alice = peek(w.alice);
    alice.publicKeys.set(`${BOB}:22`, { keyData: 'pub-bob', keyId: 22 });
    alice.publicKeys.set(`${ALICE}:11`, { keyData: 'pub-alice', keyId: 11 });
    expect(alice.peerChannels.has(BOB)).toBe(true);
    expect(alice.peerNegotiation.has(BOB)).toBe(true);
    w.alice.resetNegotiation(BOB);
    expect(alice.peerChannels.size).toBe(0);
    expect(alice.peerNegotiation.size).toBe(0);
    expect([...alice.publicKeys.keys()]).toEqual([`${ALICE}:11`]);
  });

  it('leaves no chat state behind after two failed 84 attempts', async () => {
    const w = world();
    const message = text(BOB, 'x');
    await w.alice.encrypt(message);
    const error = apiError(84);
    const first = await w.alice.recoverFromSendError(message, error); // after the first failure
    expect(first.retry).toBe(true);
    await w.alice.encrypt(message); // the retry negotiates again
    w.alice.resetNegotiation(BOB); // the adapter's final-failure reset
    const alice = w.alice as unknown as { peerChannels: Map<string, unknown>; peerNegotiation: Map<string, unknown> };
    expect(alice.peerChannels.size).toBe(0);
    expect(alice.peerNegotiation.size).toBe(0);
  });
});

describe('send-error recovery', () => {
  it('84/86/87/88/90 reset the chat and allow one retry that re-negotiates', async () => {
    const w = world();
    await w.alice.encrypt(text(BOB, 'a'));
    for (const code of [84, 86, 87, 88, 90]) {
      const r = await w.alice.recoverFromSendError(text(BOB, 'a'), apiError(code));
      expect(r).toMatchObject({ retry: true, classification: { kind: 'renegotiate', code } });
    }
    const negotiations = w.api.calls.filter((c) => c === `negotiate:${BOB}`).length;
    await w.alice.encrypt(text(BOB, 'b'));
    expect(w.api.calls.filter((c) => c === `negotiate:${BOB}`).length).toBe(negotiations + 1);
  });

  it('99 on a group re-registers the group key and allows one retry', async () => {
    const w = world();
    w.api.lastPublicKeys.set(GROUP, { [ALICE]: { keyData: 'pub-alice', keyId: 11 } });
    w.api.registerResult = { groupKeyId: 8, receiverKeyId: 11, creator: ALICE, creatorKeyId: 11, encryptedSharedKey: 'wrapped:900:1', specVersion: 2 };
    const r = await w.alice.recoverFromSendError(text(GROUP, 'x', { toType: 2 }), apiError(99));
    expect(r.retry).toBe(true);
    expect(w.api.registered).toHaveLength(1);
  });

  it('99 on a 1:1 chat only resets', async () => {
    const w = world();
    const r = await w.alice.recoverFromSendError(text(BOB, 'x'), apiError(99));
    expect(r.retry).toBe(true);
    expect(w.api.registered).toHaveLength(0);
  });

  it('122 resets but is NOT retried; unrelated codes change nothing', async () => {
    const w = world();
    expect((await w.alice.recoverFromSendError(text(BOB, 'x'), apiError(122))).retry).toBe(false);
    expect((await w.alice.recoverFromSendError(text(BOB, 'x'), apiError(82))).retry).toBe(false);
    expect((await w.alice.recoverFromSendError(text(BOB, 'x'), new Error('network'))).retry).toBe(false);
  });
});

describe('Python int() parsing (OkLine e2ee.py)', () => {
  const image = () => text(BOB, '', { text: undefined, contentType: 1, contentMetadata: { ENC_KM: 'a2V5' } });
  const keyCalls = (w: World) => w.api.calls.filter((c) => c.startsWith('getPublicKey:'));
  const peerCache = (w: World) => (w.alice as unknown as { peerNegotiation: Map<string, unknown> }).peerNegotiation;
  const groupCache = (w: World) => (w.alice as unknown as { groupNegotiation: Map<string, unknown> }).groupNegotiation;
  const gsk = { groupKeyId: 7, receiverKeyId: 11, creator: BOB, creatorKeyId: 22, encryptedSharedKey: 'gsk:500', specVersion: 2, allowedTypes: [] };

  it('pythonInt follows Python int()', () => {
    expect(pythonInt('1_0')).toBe(10);
    expect(pythonInt(true)).toBe(1);
    expect(pythonInt(false)).toBe(0);
    expect(pythonInt(1.9)).toBe(1);
    expect(Object.is(pythonInt(-0.5), 0)).toBe(true);
    for (const ok of [['1', 1], ['+1', 1], ['-2', -2], [' 1 ', 1], ['007', 7]] as const) expect(pythonInt(ok[0])).toBe(ok[1]);
    for (const bad of ['1e0', '1.0', '1.5', '0x1', '', '1__0', '_1', '1_', Number.NaN, Infinity, -Infinity, null, undefined, [], {}]) {
      expect(() => pythonInt(bad)).toThrow(ChromeE2eeError);
    }
    expect(new ChromeE2eeError('x')).toBeInstanceOf(ChromeError);
  });

  it('isGroupTarget throws for a toType that is not an integer', () => {
    expect(() => isGroupTarget({ toType: 'abc', to: BOB })).toThrow(ChromeE2eeError);
    expect(isGroupTarget({ toType: '2', to: BOB })).toBe(true);
  });

  it('a negotiated specVersion "1e0" fails the seal and caches nothing', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion: '1e0' });
    await expect(w.alice.encrypt(text(BOB, 'x'))).rejects.toBeInstanceOf(ChromeError);
    expect(w.api.calls).toEqual([`negotiate:${BOB}`]);
    expect(peerCache(w).has(BOB)).toBe(false);
  });

  it('specVersion "1" gives V1, " 2 ", "" and "0" give V2', async () => {
    const versionOf = async (specVersion: unknown) => {
      const w = world();
      w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion });
      const sealed = await w.alice.encrypt(text(BOB, 'x'));
      return (sealed.contentMetadata as Record<string, unknown>).e2eeVersion;
    };
    expect(await versionOf('1')).toBe('1');
    expect(await versionOf(' 2 ')).toBe('2');
    expect(await versionOf('')).toBe('2');
    expect(await versionOf('0')).toBe('2');
  });

  it('allowedTypes ["1.5"] fails the seal; allowedTypes [15] leaves a text message plain', async () => {
    const bad = world();
    bad.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, allowedTypes: ['1.5'], specVersion: 2 });
    await expect(bad.alice.encrypt(text(BOB, 'x'))).rejects.toBeInstanceOf(ChromeE2eeError);
    expect(peerCache(bad).has(BOB)).toBe(false);

    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, allowedTypes: [15], specVersion: 2 });
    await w.alice.encrypt(text(BOB, 'prime'));
    const m = text(BOB, 'plain now');
    expect(await w.alice.encrypt(m)).toBe(m);
  });

  it('a publicKey.keyId "abc" fails the seal', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 'abc' }, specVersion: 2 });
    await expect(w.alice.encrypt(text(BOB, 'x'))).rejects.toBeInstanceOf(ChromeE2eeError);
  });

  it('a group specVersion "1e0" fails the seal before any registration', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, { ...gsk, specVersion: '1e0' });
    await expect(w.alice.encrypt(text(GROUP, 'x', { toType: 2 }))).rejects.toBeInstanceOf(ChromeE2eeError);
    expect(w.api.registered).toHaveLength(0);
    expect(groupCache(w).has(GROUP)).toBe(false);
  });

  it('a group creatorKeyId "1e0" fails the seal before any getE2EEPublicKey', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, { ...gsk, creatorKeyId: '1e0' });
    await expect(w.alice.encrypt(text(GROUP, 'x', { toType: 2 }))).rejects.toBeInstanceOf(ChromeE2eeError);
    expect(keyCalls(w)).toEqual([]);
  });

  it('a media flow value "2.0" fails; a cacheTtlMillis "abc" counts as 0 and is not cached', async () => {
    const bad = world();
    bad.api.mediaFlow = { flowMap: { 1: '2.0' }, cacheTtlMillis: 1000 };
    await expect(bad.alice.mediaFlowIsV2(BOB, 1)).rejects.toBeInstanceOf(ChromeE2eeError);
    await expect(bad.alice.encrypt(image())).rejects.toBeInstanceOf(ChromeE2eeError);

    const w = world();
    w.api.mediaFlow = { flowMap: { 1: 2 }, cacheTtlMillis: 'abc' };
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
    expect(await w.alice.mediaFlowIsV2(BOB, 1)).toBe(true);
    expect(w.api.calls.filter((c) => c.startsWith('mediaFlow:'))).toHaveLength(2);
  });

  it('a sealed message with contentType "abc" fails the decrypt without a request and gives MISSING_E2EE_KEY', async () => {
    const w = world();
    const sealed = await w.alice.encrypt(text(BOB, 'x'));
    await w.bob.decrypt(delivered(sealed, ALICE)); // warms the sender key and the channel
    const calls = w.api.calls.length;
    const broken = { ...delivered(sealed, ALICE), contentType: 'abc' };
    await expect(w.bob.decrypt(broken)).rejects.toBeInstanceOf(ChromeE2eeError);
    const result = await buildChromeSyncResult({
      operations: [{ revision: 1, type: 26, message: broken }],
      cursorAfter: '9',
      decryptor: w.bob,
      ownMid: BOB,
      seenConversationIds: new Set<string>(),
    });
    expect(result.operations).toEqual([
      { operation: { revision: 1, type: 26, message: broken }, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } },
    ]);
    expect(w.api.calls).toHaveLength(calls);
  });
});

describe('chunk decoding follows Python base64.b64decode (OkLine e2ee_crypto.py:40-41)', () => {
  const noKeyLookup = (w: World): string[] => w.api.calls.filter((c) => c.startsWith('getPublicKey:'));

  async function sealedPair(v1: boolean): Promise<{ w: World; msg: ChromeMessage }> {
    const w = world();
    if (v1) w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion: 1 });
    const sealed = await w.alice.encrypt(text(BOB, 'chunk check'));
    return { w, msg: delivered(sealed, ALICE) };
  }
  const withChunk = (msg: ChromeMessage, index: number, value: string): ChromeMessage => {
    const chunks = [...(msg.chunks as string[])];
    chunks[index] = value;
    return { ...msg, chunks };
  };

  it.each([
    ['V2', false],
    ['V1', true],
  ])('%s: a fifth chunk without padding fails the decrypt before any key lookup and gives MISSING_E2EE_KEY', async (_name, v1) => {
    const { w, msg } = await sealedPair(v1);
    const good = (msg.chunks as string[])[4]!;
    const bad = withChunk(msg, 4, good.replace(/=+$/, ''));
    expect(good.endsWith('=')).toBe(true);
    await expect(w.bob.decrypt(bad)).rejects.toThrow();
    expect(noKeyLookup(w)).toEqual([]);
    const result = await buildChromeSyncResult({
      operations: [{ revision: 1, type: 26, message: bad }],
      cursorAfter: '9',
      decryptor: w.bob,
      ownMid: BOB,
      seenConversationIds: new Set<string>(),
    });
    expect(result.operations).toEqual([
      { operation: { revision: 1, type: 26, message: bad }, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } },
    ]);
    expect(noKeyLookup(w)).toEqual([]);
  });

  it.each([
    ['V2', false],
    ['V1', true],
  ])('%s: the same message with padded chunks decrypts (control)', async (_name, v1) => {
    const { w, msg } = await sealedPair(v1);
    expect((await w.bob.decrypt(msg)).text).toBe('chunk check');
  });

  it.each([
    ['V2', false],
    ['V1', true],
  ])('%s: a fifth chunk with a non-ASCII character after its padding fails the decrypt before any key lookup', async (_name, v1) => {
    const { w, msg } = await sealedPair(v1);
    const good = (msg.chunks as string[])[4]!;
    const bad = withChunk(msg, 4, good + 'é');
    await expect(w.bob.decrypt(bad)).rejects.toThrow();
    expect(noKeyLookup(w)).toEqual([]);
    const result = await buildChromeSyncResult({
      operations: [{ revision: 1, type: 26, message: bad }],
      cursorAfter: '9',
      decryptor: w.bob,
      ownMid: BOB,
      seenConversationIds: new Set<string>(),
    });
    expect(result.operations).toEqual([
      { operation: { revision: 1, type: 26, message: bad }, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } },
    ]);
    expect(noKeyLookup(w)).toEqual([]);
  });

  it.each([
    ['V2', false],
    ['V1', true],
  ])('%s: a body chunk c[1] without padding makes parseChunks fail before channelForReceive, with no request', async (_name, v1) => {
    const { w, msg } = await sealedPair(v1);
    const body = (msg.chunks as string[])[1]!;
    // Drop the padding. If the chunk has none, drop the last data character: both leave a dangling sextet.
    const stripped = body.replace(/=+$/, '');
    const bad = withChunk(msg, 1, stripped === body ? body.slice(0, -1) : stripped);
    const calls = w.api.calls.length;
    await expect(w.bob.decrypt(bad)).rejects.toThrow(/not valid base64/);
    expect(w.api.calls).toHaveLength(calls);
  });
});

describe('server fields use Python truthiness (OkLine e2ee.py, P7)', () => {
  const peerCache = (w: World) => (w.alice as unknown as { peerNegotiation: Map<string, unknown> }).peerNegotiation;
  const groupCache = (w: World) => (w.alice as unknown as { groupNegotiation: Map<string, unknown> }).groupNegotiation;
  const gsk = { groupKeyId: 7, receiverKeyId: 11, creator: BOB, creatorKeyId: 22, encryptedSharedKey: 'gsk:500', specVersion: 2, allowedTypes: [] };
  const versionOf = (m: ChromeMessage) => (m.contentMetadata as Record<string, unknown>).e2eeVersion;

  it('a toType of [] or {} decrypts through the 1:1 path like toType 0', async () => {
    for (const toType of [[], {}, 0]) {
      const w = world();
      const sealed = await w.alice.encrypt(text(BOB, 'hello bob'));
      const plain = await w.bob.decrypt({ ...delivered(sealed, ALICE), toType });
      expect(plain.text).toBe('hello bob');
      expect(w.api.calls.filter((c) => c.startsWith('getPublicKey:'))).toEqual([`getPublicKey:${ALICE}:11`]);
      expect(w.api.calls.some((c) => c.startsWith('getGroupSharedKey:') || c.startsWith('getLastGroupSharedKey:'))).toBe(false);
    }
  });

  it('a negotiated specVersion of [] or {} gives V2 with 5 chunks', async () => {
    for (const specVersion of [[], {}]) {
      const w = world();
      w.api.negotiation.set(BOB, { publicKey: { keyData: 'pub-bob', keyId: 22 }, specVersion });
      const sealed = await w.alice.encrypt(text(BOB, 'x'));
      expect(versionOf(sealed)).toBe('2');
      expect(sealed.chunks as string[]).toHaveLength(5);
    }
  });

  it('a negotiated keyData of [] takes the getPublicKey(mid, 0) fallback', async () => {
    const w = world();
    w.api.negotiation.set(BOB, { publicKey: { keyData: [] as unknown as string, keyId: 5 } });
    w.api.publicKeys.set(`${BOB}:0`, { keyData: 'pub-bob', keyId: 22 });
    const sealed = await w.alice.encrypt(text(BOB, 'fallback'));
    expect(w.api.calls.filter((c) => c.startsWith('getPublicKey:'))).toEqual([`getPublicKey:${BOB}:0`]);
    expect(parseChunks(sealed.chunks as string[]).receiverKeyId).toBe(22);
    expect(peerCache(w).get(BOB)).toEqual({ specVersion: 2, allowedTypes: [] });
    expect((await w.bob.decrypt(delivered(sealed, ALICE))).text).toBe('fallback');
  });

  it('a group shared key with an empty encryptedSharedKey fails before any other request', async () => {
    for (const empty of [[], {}]) {
      const w = world();
      w.api.lastGroupKeys.set(GROUP, { ...gsk, encryptedSharedKey: empty as unknown as string });
      await expect(w.alice.encrypt(text(GROUP, 'x', { toType: 2 }))).rejects.toBeInstanceOf(ChromeE2eeError);
      expect(w.api.calls).toEqual([`getLastGroupSharedKey:${GROUP}`]);
      expect(w.api.registered).toHaveLength(0);
    }
  });

  it('an empty group receiverKeyId uses the latest own key; an empty specVersion gives V2', async () => {
    const w = world();
    const odd = { ...gsk, receiverKeyId: [] as unknown as number, specVersion: [] as unknown };
    w.api.lastGroupKeys.set(GROUP, odd);
    w.api.groupKeys.set(`${GROUP}:7`, odd);
    const sealed = await w.alice.encrypt(text(GROUP, 'hi group', { toType: 2 }));
    expect(w.bridge.calls).toContain('channel:1:pub-bob');
    expect(groupCache(w).get(GROUP)).toEqual({ specVersion: 2, allowedTypes: [] });
    expect(versionOf(sealed)).toBe('2');
    expect(sealed.chunks as string[]).toHaveLength(5);
  });

  it('a registerGroupKey result with an empty encryptedSharedKey fails after one registration', async () => {
    const w = world();
    w.api.lastGroupKeys.set(GROUP, notFound());
    w.api.lastPublicKeys.set(GROUP, { [ALICE]: { keyData: 'pub-alice', keyId: 11 } });
    w.api.registerResult = { ...gsk, encryptedSharedKey: {} as unknown as string };
    await expect(w.alice.encrypt(text(GROUP, 'x', { toType: 2 }))).rejects.toThrow(/^registerE2EEGroupKey returned no key/);
    expect(w.api.registered).toHaveLength(1);
  });
});
