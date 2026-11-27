import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from './errors.js';
import { resolveExtensionSource } from './extension-source.js';
import { detectStoreExtension, parseVersionFolder } from './store-extension.js';

// The signature check reads main.js. In this test a main.js that holds the text OK passes.
vi.mock('./extension-features.js', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  return {
    checkExtensionFolderFeatures: async (dir: string) => {
      const text = await readFile(path.join(dir, 'static', 'js', 'main.js'), 'utf8').catch(() => '');
      return text === 'OK' ? { ok: true, failed: [] } : { ok: false, failed: ['HANDLE_EB', 'MEDIA_VIEWER'] };
    },
  };
});

let profile: string;
beforeEach(async () => { profile = await mkdtemp(nodePath.join(tmpdir(), 'store-ext-')); });
afterEach(async () => { await rm(profile, { recursive: true, force: true }); });

async function folder(name: string, mainJs: string): Promise<void> {
  const dir = nodePath.join(profile, 'Default', 'Extensions', CHROME_EXTENSION_ID, name, 'static', 'js');
  await mkdir(dir, { recursive: true });
  await writeFile(nodePath.join(dir, 'main.js'), mainJs, 'utf8');
}

describe('store extension detection', () => {
  it('parses version folder names', () => {
    expect(parseVersionFolder('3.10.1_2')).toEqual({ version: '3.10.1', parts: [3, 10, 1], build: 2 });
    expect(parseVersionFolder('_metadata')).toBeNull();
  });

  it('reports none without a folder', async () => {
    expect(await detectStoreExtension(profile)).toEqual({ kind: 'none' });
  });

  it('uses the highest version folder and records location and state', async () => {
    await folder('3.7.2_0', 'old');
    await folder('3.10.0_0', 'OK');
    await folder('3.9.9_1', 'old');
    await writeFile(nodePath.join(profile, 'Default', 'Preferences'),
      JSON.stringify({ extensions: { settings: { [CHROME_EXTENSION_ID]: { location: 1, state: 1 } } } }), 'utf8');
    const found = await detectStoreExtension(profile);
    expect(found).toMatchObject({ kind: 'ready', version: '3.10.0', location: 1, state: 1 });
  });

  it('reports changed with the failed names', async () => {
    await folder('3.8.0_0', 'changed text');
    expect(await detectStoreExtension(profile)).toMatchObject({ kind: 'changed', version: '3.8.0', failed: ['HANDLE_EB', 'MEDIA_VIEWER'] });
  });
});

describe('extension source order', () => {
  const prepare = vi.fn(async () => ({ path: 'COPY' }));
  beforeEach(() => prepare.mockClear());

  it('a: a usable store install wins and the copy is not prepared', async () => {
    await folder('3.9.0_0', 'OK');
    expect(await resolveExtensionSource({ root: 'R', profileDir: profile }, { prepare })).toEqual({ kind: 'store', version: '3.9.0' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('b: a store install with changed features fails and does not fall back', async () => {
    await folder('3.9.0_0', 'changed');
    const error = await resolveExtensionSource({ root: 'R', profileDir: profile }, { prepare }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'EXTENSION_FEATURES_CHANGED', reason: 'signatures HANDLE_EB MEDIA_VIEWER' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('c: without a store install the developer load copy is used', async () => {
    expect(await resolveExtensionSource({ root: 'R', profileDir: profile }, { prepare })).toEqual({ kind: 'unpacked', path: 'COPY' });
    expect(prepare).toHaveBeenCalledOnce();
  });
});
