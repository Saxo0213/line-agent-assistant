import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretStore, type SecretBackend } from './secret-store.js';

describe('SecretStore', () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  it('persists encrypted token, QR cert and E2EE state and rejects stale rotation correlation', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-')); folders.push(folder);
    const fake: SecretBackend = {
      async protect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
      async unprotect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
    };
    const store = new SecretStore(folder, fake);
    store.beginLogin('a', 'worker-1', 'attempt-2');
    const secrets = { token: 'private-token', qrCert: 'private-qr', e2eeStorage: { key: 'private-e2ee' } };
    expect(await store.saveRotation('a', 'worker-old', 'attempt-2', secrets)).toBe(false);
    expect(await store.saveRotation('a', 'worker-1', 'attempt-1', secrets)).toBe(false);
    expect(await store.saveRotation('a', 'worker-1', 'attempt-2', secrets)).toBe(true);
    const files = await readFile(join(folder, 'secrets', 'a.bin'));
    expect(files.toString('utf8')).not.toContain('private-token');
    expect(await new SecretStore(folder, fake).load('a')).toEqual(secrets);
  });
  it('does not let an older rotation overwrite a newer login while protection is pending', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-')); folders.push(folder);
    let releaseOld!: () => void;
    let enteredOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    const store = new SecretStore(folder, {
      async protect(value) {
        if (JSON.parse(Buffer.from(value).toString('utf8')).token === 'old') {
          enteredOld(); await oldBlocked;
        }
        return value;
      },
      async unprotect(value) { return value; },
    });
    store.beginLogin('a', 'worker-old', 'attempt-old');
    const old = store.saveRotation('a', 'worker-old', 'attempt-old', { token: 'old', qrCert: null, e2eeStorage: null });
    await oldEntered;
    store.beginLogin('a', 'worker-new', 'attempt-new');
    const latest = store.saveRotation('a', 'worker-new', 'attempt-new', { token: 'new', qrCert: null, e2eeStorage: null });
    releaseOld();
    expect(await old).toBe(false);
    expect(await latest).toBe(true);
    expect((await store.load('a'))?.token).toBe('new');
  });
  it('keeps the later secret rotation from the same login attempt when the earlier protect finishes last', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-')); folders.push(folder);
    let enteredOld!: () => void; let releaseOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const store = new SecretStore(folder, {
      async protect(value) {
        if (JSON.parse(Buffer.from(value).toString('utf8')).token === 'older') {
          enteredOld(); await oldGate;
        }
        return value;
      },
      async unprotect(value) { return value; },
    });
    store.beginLogin('a', 'worker-1', 'attempt-1');
    const old = store.saveRotation('a', 'worker-1', 'attempt-1', { token: 'older', qrCert: null, e2eeStorage: null });
    await oldEntered;
    const latest = store.saveRotation('a', 'worker-1', 'attempt-1', { token: 'newer', qrCert: null, e2eeStorage: null });
    releaseOld();
    expect(await old).toBe(false);
    expect(await latest).toBe(true);
    expect((await store.load('a'))?.token).toBe('newer');
  });
  it('serializes account saves and coalesces bursts to the newest pending snapshot', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-lane-')); folders.push(folder);
    let activeProtects = 0; let maximumProtects = 0;
    let releaseFirst!: () => void; let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = new SecretStore(folder, {
      async protect(value) {
        activeProtects++; maximumProtects = Math.max(maximumProtects, activeProtects);
        const token = JSON.parse(Buffer.from(value).toString('utf8')).token;
        try { if (token === 'first') { enteredFirst(); await firstGate; } return value; }
        finally { activeProtects--; }
      },
      async unprotect(value) { return value; },
    });
    store.beginLogin('a', 'worker', 'attempt');
    const first = store.saveRotation('a', 'worker', 'attempt', { token: 'first', qrCert: null, e2eeStorage: null });
    await firstEntered;
    const middle = store.saveRotation('a', 'worker', 'attempt', { token: 'middle', qrCert: null, e2eeStorage: null });
    const latest = store.saveRotation('a', 'worker', 'attempt', { token: 'latest', qrCert: null, e2eeStorage: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maximumProtects).toBe(1);
    releaseFirst();
    await Promise.all([first, middle, latest]);
    expect(maximumProtects).toBe(1);
    expect(await store.load('a')).toMatchObject({ token: 'latest' });
  });
  it('clears the persisted LINE credential on logout', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-')); folders.push(folder);
    const store = new SecretStore(folder, { async protect(value) { return value; }, async unprotect(value) { return value; } });
    store.beginLogin('a', 'worker', 'attempt');
    await store.saveRotation('a', 'worker', 'attempt', { token: 'private', qrCert: null, e2eeStorage: null });
    await store.clear('a');
    expect(await store.load('a')).toBeNull();
    expect(await store.saveRotation('a', 'worker', 'attempt', { token: 'stale', qrCert: null, e2eeStorage: null })).toBe(false);
  });
  it('closes a failed login immediately while fencing its delayed save and preserving account isolation', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-login-failure-')); folders.push(folder);
    let releaseOld!: () => void; let enteredOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const store = new SecretStore(folder, {
      async protect(value) {
        const token = JSON.parse(Buffer.from(value).toString('utf8')).token;
        if (token === 'failed-attempt') { enteredOld(); await oldGate; }
        return value;
      },
      async unprotect(value) { return value; },
    });
    store.beginLogin('a', 'worker-old', 'attempt-old');
    const old = store.saveRotation('a', 'worker-old', 'attempt-old', { token: 'failed-attempt', qrCert: null, e2eeStorage: null });
    await oldEntered;

    const closing = store.closeLogin('a', 'worker-old', 'attempt-old').then(() => 'closed');
    expect(await Promise.race([closing, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 25))])).toBe('closed');
    store.beginLogin('a', 'worker-new', 'attempt-new');
    const next = store.saveRotation('a', 'worker-new', 'attempt-new', { token: 'new-attempt', qrCert: null, e2eeStorage: null });
    store.beginLogin('b', 'worker-b', 'attempt-b');
    const other = store.saveRotation('b', 'worker-b', 'attempt-b', { token: 'other-account', qrCert: null, e2eeStorage: null });
    expect(await other).toBe(true);

    releaseOld();
    expect(await old).toBe(false);
    expect(await next).toBe(true);
    expect((await store.load('a'))?.token).toBe('new-attempt');
    expect((await store.load('b'))?.token).toBe('other-account');
  });
  it('keeps clear ordered after an in-flight save so closed credentials cannot return', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-clear-pending-')); folders.push(folder);
    let release!: () => void; let entered!: () => void;
    const protectEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new SecretStore(folder, {
      async protect(value) { entered(); await gate; return value; },
      async unprotect(value) { return value; },
    });
    store.beginLogin('a', 'worker', 'attempt');
    const save = store.saveRotation('a', 'worker', 'attempt', { token: 'must-clear', qrCert: null, e2eeStorage: null });
    await protectEntered;
    const clearing = store.clear('a');
    release();
    expect(await save).toBe(false);
    await clearing;
    expect(await store.load('a')).toBeNull();
  });
  it('persists and reloads the protected room activation digest key', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-secret-')); folders.push(folder);
    const fake: SecretBackend = {
      async protect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
      async unprotect(value) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
    };
    const first = await new SecretStore(folder, fake).loadOrCreateRoomActivationDigestKey();
    const stored = await readFile(join(folder, 'secrets', 'room-activation-key.bin'));
    expect(first).toHaveLength(32);
    expect(stored).not.toEqual(first);
    expect(await new SecretStore(folder, fake).loadOrCreateRoomActivationDigestKey()).toEqual(first);
  });
});
