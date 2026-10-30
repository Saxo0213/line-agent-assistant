import { describe, expect, it } from 'vitest';
import { LtsmBridge, LtsmBridgeError } from './bridge.js';
import { STUB_SANDBOX } from './stub-sandbox.testkit.js';

const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9, 9]);

type Raw = { send(data: Record<string, unknown>): Promise<unknown> };
const raw = (bridge: LtsmBridge): Raw => bridge as unknown as Raw;

async function create(extra: Partial<Parameters<typeof LtsmBridge.create>[0]> = {}): Promise<LtsmBridge> {
  return LtsmBridge.create({ sandboxSource: STUB_SANDBOX, wasm: WASM, ...extra });
}

describe('LtsmBridge shim message flow', () => {
  it('loads the bundle, fires DOMContentLoaded, then sends init as the first command', async () => {
    const posted: Array<{ type: string }> = [];
    const bridge = await create({ onParentMessage: (m) => posted.push(m as { type: string }) });
    try {
      expect(posted.map((m) => m.type)).toEqual(['loaded', 'response']); // loaded on DOMContentLoaded, then init's response
      expect(await raw(bridge).send({ command: 'dump_log' })).toBe('init,dump_log');
    } finally {
      bridge.close();
    }
  });

  it('presents the extension origin and the sandboxId query the bundle needs', async () => {
    const bridge = await create();
    try {
      const env = JSON.parse((await raw(bridge).send({ command: 'env_check' })) as string);
      expect(env).toMatchObject({
        encoderRealm: true,
        search: '?sandboxId=py',
        scriptSrc: 'file:///ltsm/ltsmSandbox.js',
        a: 'chrome-extension:/x',
      });
      // Nothing from the host leaks into the sandbox.
      expect(env.hasProcess).toBe('undefined');
      expect(env.hasRequire).toBe('undefined');
    } finally {
      bridge.close();
    }
  });

  it('fails to start when the origin is not the extension origin (the bundle rejects it)', async () => {
    await expect(create({ origin: 'chrome-extension://someotherextensionidxxxxxxxxxxxx' })).rejects.toThrow(/Invalid origin/);
  });

  it('serves the wasm bytes through the XMLHttpRequest shim, as a sandbox-realm ArrayBuffer', async () => {
    const bridge = await create();
    try {
      expect(await raw(bridge).send({ command: 'wasm_check' })).toBe(`200:true:${WASM.length}`);
    } finally {
      bridge.close();
    }
  });

  it('maps sandbox errors to LtsmBridgeError (message, then name)', async () => {
    const bridge = await create();
    try {
      await expect(raw(bridge).send({ command: 'boom' })).rejects.toThrow('stub failure');
      await expect(raw(bridge).send({ command: 'boom' })).rejects.toBeInstanceOf(LtsmBridgeError);
      await expect(raw(bridge).send({ command: 'named' })).rejects.toThrow('NamedFailure');
      // the bridge keeps working after an error
      expect(await bridge.curveKeyGenerate()).toBe(7);
    } finally {
      bridge.close();
    }
  });

  it('times out when the sandbox never answers, and close() rejects an in-flight command', async () => {
    const bridge = await create({ responseTimeoutMs: 40 });
    await expect(raw(bridge).send({ command: 'silent' })).rejects.toThrow('no response for silent');
    const bridge2 = await create({ responseTimeoutMs: 5_000 });
    const inFlight = raw(bridge2).send({ command: 'silent' });
    const assertion = expect(inFlight).rejects.toThrow('ltsm bridge closed');
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge2.close();
    await assertion;
    await expect(bridge2.hmac('', '/p', '')).rejects.toThrow('ltsm bridge closed');
    bridge.close();
  });

  it('serialises concurrent commands so responses stay matched to requests', async () => {
    const bridge = await create();
    try {
      const results = await Promise.all([bridge.hmac('', '/a', '1'), bridge.hmac('t', '/b', '2'), bridge.hmac('', '/c', '3')]);
      expect(results).toEqual(['sig(|/a|1)', 'sig(t|/b|2)', 'sig(|/c|3)']);
    } finally {
      bridge.close();
    }
  });
});

describe('LtsmBridge operations', () => {
  it('signs with get_hmac and treats a missing body as empty', async () => {
    const bridge = await create();
    try {
      expect(await bridge.hmac('tok', '/api/x?y=1', '[1]')).toBe('sig(tok|/api/x?y=1|[1])');
      expect(await bridge.hmac(undefined as unknown as string, '/p', undefined as unknown as string)).toBe('sig(|/p|)');
    } finally {
      bridge.close();
    }
  });

  it('ports the Curve25519 / E2EE operations with base64 in and out and sandbox-realm byte arrays', async () => {
    const bridge = await create();
    try {
      const handle = await bridge.curveKeyGenerate();
      expect(await bridge.e2eePublicKey(handle)).toBe(Buffer.from([1, 2, 3, 7]).toString('base64'));
      expect(await bridge.e2eePublicKeyForHandle(handle)).toBe(Buffer.from([1, 2, 3, 7]).toString('base64'));
      const serverKey = Buffer.alloc(32, 9).toString('base64');
      expect(await bridge.e2eeCreateChannel(handle, serverKey)).toBe(72);
      expect(await bridge.e2eeCreateChannelWithPubkey(handle, serverKey)).toBe(72);
      expect(await bridge.e2eeUnwrapKeychain(72, Buffer.from('chain').toString('base64'))).toEqual([5, 6]);
      expect(await bridge.e2eeLoadKey(Buffer.from('k').toString('base64'))).toBe(99);
      expect(await bridge.e2eeWrapGroupSharedKey(72, 11)).toBe(Buffer.from([11]).toString('base64'));

      // uint64 sequence number reaches the sandbox as a BigInt; ids as numbers; plaintext as a sandbox Uint8Array
      const cipher = await bridge.e2eeEncryptV2(72, {
        to: 'u1',
        from: 'u2',
        senderKeyId: '5',
        receiverKeyId: 6,
        contentType: '0',
        sequenceNumber: '9007199254740993',
        plaintextB64: Buffer.from('hello').toString('base64'),
      });
      expect([...Buffer.from(cipher, 'base64')]).toEqual([1, 1, 5, 6, 0, 5]);
    } finally {
      bridge.close();
    }
  });

  it('wraps operation failures with the argument types, as ltsm_bridge.js does', async () => {
    const bridge = await create();
    try {
      await expect(
        bridge.e2eeDecryptV2(1, { to: 'a', from: 'b', senderKeyId: 1, receiverKeyId: 2, contentType: 0, ciphertextB64: '' }),
      ).rejects.toThrow(/unknown command e2eechannel_decrypt_v2 \| args to=string from=string senderKeyId=number:1/);
    } finally {
      bridge.close();
    }
  });
});
