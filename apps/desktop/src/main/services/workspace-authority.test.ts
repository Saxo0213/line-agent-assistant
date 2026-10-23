import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAuthority } from './workspace-authority.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(value?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-authority-')); directories.push(root);
  const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
  let stored: unknown = value === undefined ? await realpath(a) : value;
  let persist: (path: unknown) => Promise<void> = async path => { stored = path; };
  const settings = { getAppSetting: async () => stored, setAppSetting: async (_key: string, path: unknown) => persist(path) };
  const authority = await WorkspaceAuthority.load(settings);
  return { root, a: await realpath(a), b: await realpath(b), authority, stored: () => stored,
    persistence: (fn: typeof persist) => { persist = fn; } };
}

describe('workspace authority', () => {
  it('publishes canonical changes and rejects invalid candidates without mutation', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'file'), 'x');
    for (const invalid of ['relative', '', join(f.root, 'file'), join(f.root, 'absent')]) {
      await expect(f.authority.configure(invalid)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
      expect(await f.authority.current()).toBe(f.a);
    }
    expect(await f.authority.configure(join(f.b, '.'))).toBe(f.b);
    expect(f.stored()).toBe(f.b);
    expect(await f.authority.inspect()).toEqual({ status: 'available', version: 1, path: f.b });
  });
  it('checks filesystem availability freshly and recovers without changing configuration', async () => {
    const f = await fixture(); expect(await f.authority.current()).toBe(f.a);
    await rm(f.a, { recursive: true });
    expect(await f.authority.inspect()).toMatchObject({ status: 'unavailable', configuredPath: f.a, version: 0 });
    await expect(f.authority.current()).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    await mkdir(f.a); expect(await f.authority.current()).toBe(f.a);
  });
  it.each(['relative', '', 42])('preserves malformed legacy identity %s without blocking startup', async value => {
    const f = await fixture(value);
    expect(await f.authority.inspect()).toMatchObject({ status: 'unavailable', version: 0 });
    expect(f.stored()).toBe(value);
    await f.authority.configure(f.b); expect(await f.authority.current()).toBe(f.b);
  });
  it('keeps the old snapshot during persistence and on failure; publishes only on success', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.persistence(async () => { await gate; throw new Error('database offline'); });
    const update = f.authority.configure(f.b); const rejected = expect(update).rejects.toThrow('database offline');
    expect(await f.authority.current()).toBe(f.a); release(); await rejected;
    expect(await f.authority.inspect()).toMatchObject({ version: 0, path: f.a });
  });
  it('captures one configuration before validation even when configure publishes later', async () => {
    const f = await fixture();
    const captured = f.authority.current(); await f.authority.configure(f.b);
    expect(await captured).toBe(f.a); expect(await f.authority.current()).toBe(f.b);
  });
});
