// Opt-in test against the real extension assets. Skipped unless LINE_CHROME_LTSM_DIR points at a local folder that holds
// ltsm.wasm and ltsmSandbox.js. Two local identities seal and open messages through the real module; the key service is
// a local fake, so nothing is sent anywhere.
//
// V2 sealing needs an E2EE key unwrapped from a real login keychain (the module rejects a plain curve key with "Invalid
// key"), so only V1 framing can be exercised with locally generated keys. V2 framing, key ids and AAD are covered by the
// fake-bridge tests.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QrLoginE2ee } from '../auth/qr-login.js';
import { LtsmBridge } from '../ltsm/bridge.js';
import { verifyManualFolder } from '../ltsm/discovery.js';
import { LtsmStore } from '../ltsm/store.js';
import { FakeKeyApi, FakeStore, notFound } from './e2ee.testkit.js';
import { parseChunksV1 } from './framing.js';
import { ChromeE2ee } from './manager.js';

const ltsmDir = process.env.LINE_CHROME_LTSM_DIR;
const ALICE = `u${'a'.repeat(32)}`;
const BOB = `u${'b'.repeat(32)}`;
const GROUP = `c${'1'.repeat(32)}`;

describe.skipIf(!ltsmDir)('real ltsm E2EE round trip (opt-in)', () => {
  let userData = '';
  let bridge: LtsmBridge;

  beforeAll(async () => {
    userData = await mkdtemp(path.join(tmpdir(), 'line-chrome-e2ee-'));
    const discovered = await verifyManualFolder(ltsmDir!);
    if (discovered.kind !== 'found') throw new Error(`manual folder did not verify: ${JSON.stringify(discovered)}`);
    const store = new LtsmStore({ userDataDir: userData });
    expect((await store.install(discovered.match)).kind).toBe('available');
    const assets = await store.load();
    bridge = await LtsmBridge.create({ sandboxSource: assets.sandbox, wasm: assets.wasm });
  }, 120_000);

  afterAll(async () => {
    bridge?.close();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  async function identities() {
    const hA = await bridge.curveKeyGenerate();
    const hB = await bridge.curveKeyGenerate();
    const pubA = await bridge.e2eePublicKeyForHandle(hA);
    const pubB = await bridge.e2eePublicKeyForHandle(hB);
    const api = new FakeKeyApi();
    api.publicKeys.set(`${ALICE}:11`, { keyData: pubA, keyId: 11 });
    api.publicKeys.set(`${BOB}:22`, { keyData: pubB, keyId: 22 });
    api.negotiation.set(BOB, { publicKey: { keyData: pubB, keyId: 22 }, specVersion: 1 });
    api.negotiation.set(ALICE, { publicKey: { keyData: pubA, keyId: 11 }, specVersion: 1 });
    const login = (handle: number, keyId: number): QrLoginE2ee => ({ handles: { [keyId]: handle }, exported: { mid: null, latestKeyId: keyId, keys: {} } });
    const alice = new ChromeE2ee({ bridge, api, store: new FakeStore(ALICE) });
    alice.adoptLogin(login(hA, 11));
    const bob = new ChromeE2ee({ bridge, api, store: new FakeStore(BOB) });
    bob.adoptLogin(login(hB, 22));
    return { alice, bob, api };
  }

  it('1:1 V1: seal, deliver, open; our own message opens from history too', async () => {
    const { alice, bob } = await identities();
    const sealed = await alice.encrypt({ to: BOB, toType: 0, contentType: 0, contentMetadata: {}, text: 'hello real module', from: ALICE });
    expect(sealed.text).toBeUndefined();
    expect(sealed.from).toBeUndefined();
    expect((sealed.contentMetadata as Record<string, unknown>).e2eeVersion).toBe('1');
    expect(parseChunksV1(sealed.chunks as string[]).ciphertext.length).toBeGreaterThan(24);
    expect((await bob.decrypt({ ...sealed, id: '1', from: ALICE })).text).toBe('hello real module');
    expect((await alice.decrypt({ ...sealed, id: '1', from: ALICE })).text).toBe('hello real module');
  }, 60_000);

  it('group (spec 1): registers a key, wraps it per member, and both members open the message', async () => {
    const { alice, bob, api } = await identities();
    api.lastGroupKeys.set(GROUP, notFound());
    api.lastPublicKeys.set(GROUP, { [ALICE]: api.publicKeys.get(`${ALICE}:11`)!, [BOB]: api.publicKeys.get(`${BOB}:22`)! });
    // The "server" returns the key wrapped for the registering member.
    const originalRegister = api.registerGroupKey.bind(api);
    api.registerGroupKey = async (chat, members, keyIds, wrapped) => {
      await originalRegister(chat, members, keyIds, wrapped);
      return { groupKeyId: 5, receiverKeyId: 11, creator: ALICE, creatorKeyId: 11, encryptedSharedKey: wrapped[0]!, specVersion: 1, allowedTypes: [] };
    };
    const sealed = await alice.encrypt({ to: GROUP, toType: 2, contentType: 0, contentMetadata: {}, text: 'hello group' });
    expect(parseChunksV1(sealed.chunks as string[]).receiverKeyId).toBe(5);
    api.groupKeys.set(`${GROUP}:5`, {
      groupKeyId: 5,
      receiverKeyId: 22,
      creator: ALICE,
      creatorKeyId: 11,
      encryptedSharedKey: api.registered[0]!.wrapped[1]!,
      specVersion: 1,
      allowedTypes: [],
    });
    const wire = { ...sealed, id: '4', from: ALICE, to: GROUP, toType: 2 };
    expect((await bob.decrypt(wire)).text).toBe('hello group');
    expect((await alice.decrypt(wire)).text).toBe('hello group');
  }, 60_000);
});
