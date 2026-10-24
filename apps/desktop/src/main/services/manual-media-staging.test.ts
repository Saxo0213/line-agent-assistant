import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStaleManualMedia, stageManualMedia, validateManualMedia } from './manual-media-staging.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('manual media staging', () => {
  it('stages opaque paths with a digest and removes the files after send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manual-media-test-')); dirs.push(root);
    const staged = await stageManualMedia([{ name: 'note.txt', bytes: new Uint8Array([1, 2, 3]) }], root);
    expect(staged.items[0]).toMatchObject({ fileName: 'note.txt', kind: 'file', sizeBytes: 3,
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' });
    expect((await readdir(join(root, (await readdir(root))[0]!))).length).toBe(1);
    await staged.cleanup();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects invalid names and oversize selections before staging', async () => {
    expect(() => validateManualMedia([{ name: '../secret.txt', bytes: new Uint8Array([1]) }])).toThrow();
    expect(() => validateManualMedia([{ name: 'empty.txt', bytes: new Uint8Array() }])).toThrow();
  });

  it('refuses an already-cancelled request before creating a staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manual-media-cancel-')); dirs.push(root);
    const controller = new AbortController(); controller.abort();
    await expect(stageManualMedia([{ name: 'note.txt', bytes: new Uint8Array([1]) }], root, controller.signal)).rejects.toThrow('cancelled');
    expect(await readdir(root)).toEqual([]);
  });

  it('cleans only old send directories and scans a bounded set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manual-media-cleanup-')); dirs.push(root);
    await import('node:fs/promises').then(({ mkdir, utimes }) => mkdir(join(root, 'send-old')).then(async () => {
      const old = new Date(0); await utimes(join(root, 'send-old'), old, old);
    }));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'keep-me')));
    await cleanupStaleManualMedia(root);
    expect(await readdir(root)).toEqual(['keep-me']);
  });
});
