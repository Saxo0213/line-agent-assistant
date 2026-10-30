import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LtsmHmacSigner, type HmacBridge } from './ltsm-signer.js';
import { fakePin, MemFs } from './mem-fs.testkit.js';
import { LtsmStore, LtsmUnavailableError } from './store.js';
import { STUB_SANDBOX } from './stub-sandbox.testkit.js';

class CountingBridge implements HmacBridge {
  readonly calls: Array<[string, string, string]> = [];
  closed = false;
  async hmac(token: string, path: string, body: string): Promise<string> {
    this.calls.push([token, path, body]);
    return `h(${token}|${path}|${body})`;
  }
  close(): void {
    this.closed = true;
  }
}

describe('LtsmHmacSigner', () => {
  it('signs through the bridge and allows an empty token (login)', async () => {
    const bridge = new CountingBridge();
    const signer = new LtsmHmacSigner(bridge);
    expect(await signer.sign('', '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', '[{}]')).toBe(
      'h(|/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession|[{}])',
    );
    expect(bridge.calls).toEqual([['', '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', '[{}]']]);
  });

  it('keeps one signing context per SHA-256 of the token and evicts the least recently used', async () => {
    const bridge = new CountingBridge();
    const signer = new LtsmHmacSigner(bridge, { contextCacheSize: 2 });
    await signer.sign('a', '/p', '1');
    await signer.sign('b', '/p', '1');
    expect(signer.contextCount).toBe(2);
    await signer.sign('a', '/p', '2'); // touch a, so b is now the oldest
    await signer.sign('c', '/p', '1'); // evicts b
    expect(signer.contextCount).toBe(2);

    // a is still cached: the identical request is answered from its context, no new bridge call
    const before = bridge.calls.length;
    await signer.sign('a', '/p', '1');
    expect(bridge.calls.length).toBe(before);
    // b was evicted: the same request goes to the bridge again
    await signer.sign('b', '/p', '1');
    expect(bridge.calls.length).toBe(before + 1);
  });

  it('memoises identical requests per token but never across tokens, paths or bodies', async () => {
    const bridge = new CountingBridge();
    const signer = new LtsmHmacSigner(bridge);
    const first = await signer.sign('t', '/p', 'x');
    expect(await signer.sign('t', '/p', 'x')).toBe(first);
    await signer.sign('t', '/p', 'y');
    await signer.sign('t', '/q', 'x');
    await signer.sign('u', '/p', 'x');
    expect(bridge.calls).toHaveLength(4);
  });

  it('never stores the raw token in a context key', async () => {
    const bridge = new CountingBridge();
    const signer = new LtsmHmacSigner(bridge);
    await signer.sign('secret-token', '/p', '');
    const keys = [...(signer as unknown as { contexts: Map<string, unknown> }).contexts.keys()];
    expect(keys).toEqual([createHash('sha256').update('secret-token').digest('hex')]);
  });

  it('close() releases the contexts and the bridge', () => {
    const bridge = new CountingBridge();
    const signer = new LtsmHmacSigner(bridge);
    signer.close();
    expect(bridge.closed).toBe(true);
    expect(signer.contextCount).toBe(0);
  });
});

describe('LtsmHmacSigner.fromStore', () => {
  const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const pin = fakePin(wasm, STUB_SANDBOX);
  const USER_DATA = 'C:\\ud';

  it('throws LtsmUnavailableError carrying the status unless the store is available', async () => {
    const fs = new MemFs();
    const store = new LtsmStore({ userDataDir: USER_DATA, fs, path: win32, pin });
    const error = await LtsmHmacSigner.fromStore(store).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LtsmUnavailableError);
    expect((error as LtsmUnavailableError).status).toEqual({ kind: 'missing', required: '3.7.2', dir: `${USER_DATA}\\line-chrome\\ltsm\\3.7.2` });
  });

  it('builds a working signer from an available store (store -> bridge -> sandbox)', async () => {
    const fs = new MemFs();
    fs.addFile('D:\\src\\ltsm.wasm', wasm);
    fs.addFile('D:\\src\\ltsmSandbox.js', STUB_SANDBOX);
    const store = new LtsmStore({ userDataDir: USER_DATA, fs, path: win32, pin });
    const { verifyManualFolder } = await import('./discovery.js');
    const found = await verifyManualFolder('D:\\src', { fs, path: win32, pin });
    if (found.kind !== 'found') throw new Error('fixture did not verify');
    await store.install(found.match);

    const signer = await LtsmHmacSigner.fromStore(store);
    try {
      expect(await signer.sign('tok', '/api/x', '[]')).toBe('sig(tok|/api/x|[])');
      expect(await signer.sign('', '/api/x', '[]')).toBe('sig(|/api/x|[])');
    } finally {
      signer.close();
    }

    // a corrupted store is refused again at the next construction
    fs.files.set(`${USER_DATA}\\line-chrome\\ltsm\\3.7.2\\ltsmSandbox.js`, Buffer.from('tampered'));
    await expect(LtsmHmacSigner.fromStore(store)).rejects.toMatchObject({ status: { kind: 'corrupt' } });
  });
});
