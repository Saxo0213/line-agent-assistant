import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretStore, type SecretBackend } from './secret-store.js';

const xor: SecretBackend = {
  async protect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
  async unprotect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
};
const desktop = { token: 'desktop-token', qrCert: 'desktop-cert', e2eeStorage: { key: 'linejs-e2ee' } };
const chrome = { token: 'chrome-token', qrCert: 'chrome-cert', e2eeStorage: { transport: 'CHROMEOS-3.7.2', 'chrome:reqSeq': 4 } };

describe('SecretStore per-transport secrets', () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  const makeStore = async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-transport-')); folders.push(folder);
    return { folder, store: new SecretStore(folder, xor) };
  };

  it('keeps DESKTOPWIN in the original file and CHROMEOS in its own file', async () => {
    const { folder, store } = await makeStore();
    store.beginLogin('a', 'w1', 'l1');
    expect(await store.saveRotation('a', 'w1', 'l1', desktop)).toBe(true);
    store.beginLogin('a', 'w2', 'l2', 'CHROMEOS');
    expect(await store.saveRotation('a', 'w2', 'l2', chrome)).toBe(true);
    expect((await readdir(join(folder, 'secrets'))).sort()).toEqual(['a.bin', 'a.chromeos.bin']);
    expect(await store.load('a')).toEqual(desktop);
    expect(await store.load('a', 'DESKTOPWIN')).toEqual(desktop);
    expect(await store.load('a', 'CHROMEOS')).toEqual(chrome);
  });

  it('never returns one transport session for the other, even if a file holds the wrong snapshot', async () => {
    const { folder, store } = await makeStore();
    // A DESKTOPWIN worker never gets a CHROMEOS snapshot. A CHROMEOS worker never gets a linejs storage.
    store.beginLogin('a', 'w1', 'l1');
    await store.saveRotation('a', 'w1', 'l1', chrome);
    expect(await store.load('a', 'DESKTOPWIN')).toBeNull();
    store.beginLogin('b', 'w1', 'l1', 'CHROMEOS');
    await store.saveRotation('b', 'w1', 'l1', desktop);
    expect(await store.load('b', 'CHROMEOS')).toBeNull();
    expect((await readdir(join(folder, 'secrets'))).sort()).toEqual(['a.bin', 'b.chromeos.bin']);
  });

  it('a CHROMEOS session without e2ee state yet is still loadable', async () => {
    const { store } = await makeStore();
    store.beginLogin('a', 'w1', 'l1', 'CHROMEOS');
    await store.saveRotation('a', 'w1', 'l1', { token: 't', qrCert: null, e2eeStorage: null });
    expect((await store.load('a', 'CHROMEOS'))?.token).toBe('t');
  });

  it('writes a rotation to the transport of its login attempt', async () => {
    const { store } = await makeStore();
    store.beginLogin('a', 'w1', 'l1', 'CHROMEOS');
    await store.saveRotation('a', 'w1', 'l1', chrome);
    expect(await store.load('a', 'DESKTOPWIN')).toBeNull();
    expect(await store.load('a', 'CHROMEOS')).toEqual(chrome);
  });

  it('clear(account, transport) removes only that transport; clear(account) removes both', async () => {
    const { folder, store } = await makeStore();
    store.beginLogin('a', 'w1', 'l1');
    await store.saveRotation('a', 'w1', 'l1', desktop);
    store.beginLogin('a', 'w2', 'l2', 'CHROMEOS');
    await store.saveRotation('a', 'w2', 'l2', chrome);
    await store.clear('a', 'CHROMEOS');
    expect(await store.load('a', 'CHROMEOS')).toBeNull();
    expect(await store.load('a', 'DESKTOPWIN')).toEqual(desktop);
    store.beginLogin('a', 'w3', 'l3', 'CHROMEOS');
    await store.saveRotation('a', 'w3', 'l3', chrome);
    await store.clear('a');
    expect(await readdir(join(folder, 'secrets'))).toEqual([]);
  });

  it('keeps the active transport in a marker file; no marker means DESKTOPWIN', async () => {
    const { folder, store } = await makeStore();
    expect(await store.getTransport('a')).toBe('DESKTOPWIN');
    await store.setTransport('a', 'CHROMEOS');
    expect(await store.getTransport('a')).toBe('CHROMEOS');
    expect(await readdir(join(folder, 'secrets'))).toEqual(['a.transport']);
    expect(await new SecretStore(folder, xor).getTransport('a')).toBe('CHROMEOS');
    expect(await store.getTransport('b')).toBe('DESKTOPWIN');
    await store.setTransport('a', 'DESKTOPWIN');
    expect(await readdir(join(folder, 'secrets'))).toEqual([]);
    expect(await store.getTransport('a')).toBe('DESKTOPWIN');
  });

  it('clear does not remove the transport marker', async () => {
    const { store } = await makeStore();
    await store.setTransport('a', 'CHROMEOS');
    await store.clear('a');
    expect(await store.getTransport('a')).toBe('CHROMEOS');
  });
});
