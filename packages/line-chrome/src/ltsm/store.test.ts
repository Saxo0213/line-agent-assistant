import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverLtsmAssets, type LtsmDiscoveryMatch } from './discovery.js';
import { fakePin, MemFs } from './mem-fs.testkit.js';
import { describeLtsmStatus, LtsmStore, LtsmUnavailableError } from './store.js';

const WASM = 'FAKE-WASM-BYTES-0123456789';
const SANDBOX = 'FAKE-SANDBOX-JS-CONTENT-abcdefghijklmnop';
const pin = fakePin(WASM, SANDBOX);
const USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\LineAgent';
const STORE_DIR = `${USER_DATA}\\line-chrome\\ltsm\\3.7.2`;
const SRC = 'D:\\src';

async function match(fs: MemFs): Promise<LtsmDiscoveryMatch> {
  fs.addFile(`${SRC}\\p\\ltsm.wasm`, WASM);
  fs.addFile(`${SRC}\\p\\ltsmSandbox.js`, SANDBOX);
  const { verifyManualFolder } = await import('./discovery.js');
  const result = await verifyManualFolder(SRC, { fs, path: win32, pin });
  if (result.kind !== 'found') throw new Error('fixture did not verify');
  return result.match;
}

function makeStore(fs: MemFs): LtsmStore {
  return new LtsmStore({ userDataDir: USER_DATA, fs, path: win32, pin });
}

describe('LtsmStore', () => {
  it('reports missing before any install', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    expect(await store.status()).toEqual({ kind: 'missing', required: '3.7.2', dir: STORE_DIR });
    await expect(store.load()).rejects.toBeInstanceOf(LtsmUnavailableError);
  });

  it('copies verified assets into <userData>\\line-chrome\\ltsm\\3.7.2 and loads them', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    expect(await store.install(await match(fs))).toEqual({ kind: 'available', version: '3.7.2', dir: STORE_DIR });
    expect([...fs.files.keys()].filter((p) => p.startsWith(STORE_DIR)).sort()).toEqual([
      `${STORE_DIR}\\ltsm.wasm`,
      `${STORE_DIR}\\ltsmSandbox.js`,
    ]);
    const loaded = await store.load();
    expect(loaded.version).toBe('3.7.2');
    expect(loaded.wasm.toString()).toBe(WASM);
    expect(loaded.sandbox.toString()).toBe(SANDBOX);
  });

  it('writes through a temp name and renames into place, leaving no temp file behind', async () => {
    const fs = new MemFs();
    const renames: Array<[string, string]> = [];
    const rename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      renames.push([from, to]);
      await rename(from, to);
    };
    await makeStore(fs).install(await match(fs));
    expect(renames).toHaveLength(2);
    for (const [from, to] of renames) {
      expect(from).toMatch(/\.tmp$/);
      expect(from).not.toBe(to);
      expect(to.startsWith(STORE_DIR)).toBe(true);
    }
    expect([...fs.files.keys()].some((p) => p.endsWith('.tmp'))).toBe(false);
  });

  it('cleans up the temp file and never exposes a partial final file when a rename fails', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    const m = await match(fs);
    fs.failRename = (to) => to.endsWith('ltsmSandbox.js');
    await expect(store.install(m)).rejects.toThrow(/rename blocked/);
    expect([...fs.files.keys()].some((p) => p.endsWith('.tmp'))).toBe(false);
    expect(fs.files.has(`${STORE_DIR}\\ltsmSandbox.js`)).toBe(false);
    expect((await store.status()).kind).toBe('corrupt'); // wasm landed, sandbox did not
    await expect(store.load()).rejects.toBeInstanceOf(LtsmUnavailableError);
  });

  it('re-verifies on every load and detects a tampered or truncated file', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    await store.install(await match(fs));
    await store.load();

    fs.files.set(`${STORE_DIR}\\ltsm.wasm`, Buffer.from('X'.repeat(WASM.length))); // same size, different content
    const status = await store.status();
    expect(status.kind).toBe('corrupt');
    expect(status.kind === 'corrupt' && status.problems[0]).toMatch(/ltsm\.wasm: md5/);
    const error = await store.load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LtsmUnavailableError);
    expect((error as LtsmUnavailableError).status.kind).toBe('corrupt');

    fs.files.set(`${STORE_DIR}\\ltsm.wasm`, Buffer.from(WASM)); // repaired
    expect((await store.status()).kind).toBe('available');

    fs.files.set(`${STORE_DIR}\\ltsmSandbox.js`, Buffer.from('short'));
    const truncated = await store.status();
    expect(truncated.kind === 'corrupt' && truncated.problems[0]).toMatch(/ltsmSandbox\.js: size 5/);
  });

  it('reports a missing single file as corrupt', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    await store.install(await match(fs));
    fs.files.delete(`${STORE_DIR}\\ltsmSandbox.js`);
    const status = await store.status();
    expect(status.kind === 'corrupt' && status.problems).toEqual(['ltsmSandbox.js: file is missing']);
  });

  it('reports wrong-version when the store only holds another version', async () => {
    const fs = new MemFs();
    fs.addDir(`${USER_DATA}\\line-chrome\\ltsm\\3.7.1`);
    const status = await makeStore(fs).status();
    expect(status).toEqual({ kind: 'wrong-version', required: '3.7.2', detected: ['3.7.1'] });
    expect(describeLtsmStatus(status)).toContain('3.7.1');
    expect(describeLtsmStatus(status)).toContain('3.7.2');
  });

  it('refuses to install a match from another version or whose source changed after discovery', async () => {
    const fs = new MemFs();
    const store = makeStore(fs);
    const m = await match(fs);
    expect(await store.install({ ...m, extensionVersion: '3.7.1' })).toMatchObject({ kind: 'wrong-version', detected: ['3.7.1'] });

    fs.files.set(`${SRC}\\p\\ltsm.wasm`, Buffer.from('X'.repeat(WASM.length)));
    const status = await store.install(m);
    expect(status.kind).toBe('corrupt');
    expect([...fs.files.keys()].some((p) => p.startsWith(STORE_DIR))).toBe(false);
  });

  it('works end to end from an automatic discovery', async () => {
    const fs = new MemFs();
    const dir = 'C:\\L\\Microsoft\\Edge\\User Data\\Default\\Extensions\\ophjlpahpchlmihnnnihgmmeilfjmjjc\\3.7.2_0';
    fs.addFile(`${dir}\\z\\ltsm.wasm`, WASM);
    fs.addFile(`${dir}\\z\\ltsmSandbox.js`, SANDBOX);
    const found = await discoverLtsmAssets({ env: { LOCALAPPDATA: 'C:\\L' }, fs, path: win32, pin });
    if (found.kind !== 'found') throw new Error('expected found');
    const store = makeStore(fs);
    expect((await store.install(found.match)).kind).toBe('available');
    await store.remove();
    expect((await store.status()).kind).toBe('missing');
  });
});
