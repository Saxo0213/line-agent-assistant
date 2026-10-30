// Opt-in test against the real extension assets. Skipped unless LINE_CHROME_LTSM_DIR points at a local folder that holds
// ltsm.wasm and ltsmSandbox.js (any layout up to 4 levels deep). It only reads local files and sends nothing.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LtsmBridge } from './bridge.js';
import { verifyManualFolder } from './discovery.js';
import { LtsmHmacSigner } from './ltsm-signer.js';
import { LtsmStore } from './store.js';

// Vector published in OkLine's tests/test_hmac_bridge.py (MIT): empty token, createSession path, "[{}]" body.
const KNOWN_PATH = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession';
const KNOWN_BODY = '[{}]';
const KNOWN_HMAC = 'xc7hTRfwaauLuMpoXQRt2DDZE+nu+8e4auOw1F/UQZo=';

const ltsmDir = process.env.LINE_CHROME_LTSM_DIR;

describe.skipIf(!ltsmDir)('real ltsm assets (opt-in)', () => {
  let userData = '';
  let signer: LtsmHmacSigner;
  let bridge: LtsmBridge;

  beforeAll(async () => {
    userData = await mkdtemp(path.join(tmpdir(), 'line-chrome-real-'));
    const discovered = await verifyManualFolder(ltsmDir!);
    if (discovered.kind !== 'found') throw new Error(`manual folder did not verify: ${JSON.stringify(discovered)}`);
    const store = new LtsmStore({ userDataDir: userData });
    expect((await store.install(discovered.match)).kind).toBe('available');
    const assets = await store.load();
    bridge = await LtsmBridge.create({ sandboxSource: assets.sandbox, wasm: assets.wasm });
    signer = new LtsmHmacSigner(bridge);
  }, 120_000);

  afterAll(async () => {
    signer?.close();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  it('reproduces the known empty-token X-Hmac vector', async () => {
    expect(await signer.sign('', KNOWN_PATH, KNOWN_BODY)).toBe(KNOWN_HMAC);
  });

  it('is deterministic, 32 bytes, and depends on the body and the token', async () => {
    const a = await bridge.hmac('', KNOWN_PATH, KNOWN_BODY);
    const b = await bridge.hmac('', KNOWN_PATH, KNOWN_BODY);
    expect(a).toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
    expect(await bridge.hmac('', KNOWN_PATH, '[{},{}]')).not.toBe(a);
    expect(await bridge.hmac('some-token', KNOWN_PATH, KNOWN_BODY)).not.toBe(a);
  });

  it('generates a Curve25519 key and exposes its 32-byte public key', async () => {
    const handle = await bridge.curveKeyGenerate();
    expect(typeof handle).toBe('number');
    expect(Buffer.from(await bridge.e2eePublicKey(handle), 'base64')).toHaveLength(32);
  });
});
