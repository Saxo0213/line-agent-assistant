import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentRootChange } from './attachment-root-change.js';
import type { BootstrapConfiguration } from './bootstrap-settings.js';

describe('attachment root change', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture(options: { save?: (configuration: BootstrapConfiguration) => Promise<void>; pick?: () => Promise<string | null> } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'line-attachment-root-')); roots.push(root);
    const source = join(root, 'old'), target = join(root, 'new'), bootstrapRoot = join(root, 'bootstrap'), workspace = join(root, 'workspace');
    await mkdir(source); await mkdir(target); await mkdir(bootstrapRoot); await mkdir(workspace);
    const configuration: BootstrapConfiguration = { databaseUrl: 'postgresql://localhost/line_agent', attachmentRoot: source, embedded: { version: '18.6', port: 55432 } };
    const settings = { root: bootstrapRoot, load: vi.fn(async () => configuration), save: vi.fn(async (next: BootstrapConfiguration) => {
      await options.save?.(next); Object.assign(configuration, next);
    }) };
    const pick = options.pick ?? (async () => target);
    const cutover = vi.fn(async <T>(work: () => Promise<T>) => work());
    const change = createAttachmentRootChange({ settings, getAgentWorkspace: async () => workspace, pick, runCutover: cutover as never, open: vi.fn(async () => undefined) });
    return { root, source, target, bootstrapRoot, workspace, configuration, settings, cutover, change };
  }

  it('leaves files and bootstrap untouched when the directory picker is cancelled', async () => {
    const f = await fixture({ pick: async () => null });
    await writeFile(join(f.source, 'keep.txt'), 'keep');
    expect(await f.change.prepare()).toBeNull();
    expect(f.settings.save).not.toHaveBeenCalled();
    expect(await readFile(join(f.source, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('moves nested files, verifies them, then updates only the bootstrap attachment root', async () => {
    const f = await fixture();
    await mkdir(join(f.source, 'accounts', 'a'), { recursive: true });
    await writeFile(join(f.source, 'accounts', 'a', 'photo.bin'), Buffer.from([1, 2, 3, 4]));
    const selection = await f.change.prepare();
    const canonicalTarget = await realpath(f.target);
    expect(selection?.path).toBe(canonicalTarget);
    await expect(f.change.move(selection!.id)).resolves.toBe(canonicalTarget);
    expect(await readFile(join(f.target, 'accounts', 'a', 'photo.bin'))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(f.configuration).toEqual({ databaseUrl: 'postgresql://localhost/line_agent', attachmentRoot: canonicalTarget, embedded: { version: '18.6', port: 55432 } });
    expect(f.settings.save).toHaveBeenCalledOnce();
  });

  it('retains the old root and active setting when source contains a symbolic link', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'keep.txt'), 'keep');
    const outside = join(f.root, 'outside'); await writeFile(outside, 'secret');
    await symlink(outside, join(f.source, 'linked.txt'));
    const selection = await f.change.prepare();
    await expect(f.change.move(selection!.id)).rejects.toThrow(/link or unsupported/);
    expect(f.configuration.attachmentRoot).toBe(f.source);
    expect(await readFile(join(f.source, 'keep.txt'), 'utf8')).toBe('keep');
    expect(f.settings.save).not.toHaveBeenCalled();
  });

  it('retains the source when atomic bootstrap save fails after the target copy', async () => {
    const f = await fixture({ save: async () => { throw new Error('save failed'); } });
    await writeFile(join(f.source, 'keep.txt'), 'keep');
    const selection = await f.change.prepare();
    await expect(f.change.move(selection!.id)).rejects.toThrow('save failed');
    expect(f.configuration.attachmentRoot).toBe(f.source);
    expect(await readFile(join(f.source, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(f.target, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects nested roots and opens only the active bootstrap path', async () => {
    const f = await fixture({ pick: async () => join(f.source, 'nested') });
    await mkdir(join(f.source, 'nested'));
    await expect(f.change.prepare()).rejects.toThrow(/cannot contain or be inside/);
    const container = join(f.root, 'container'), nestedSource = join(container, 'attachments');
    await mkdir(nestedSource, { recursive: true });
    f.configuration.attachmentRoot = nestedSource;
    const enclosing = createAttachmentRootChange({ settings: f.settings, getAgentWorkspace: async () => f.workspace,
      runCutover: async (work) => work(), pick: async () => container, open: vi.fn() });
    await expect(enclosing.prepare()).rejects.toThrow(/cannot contain or be inside/);
    const open = vi.fn(async () => undefined);
    const safe = createAttachmentRootChange({ settings: f.settings, getAgentWorkspace: async () => f.workspace, runCutover: async (work) => work(), pick: async () => null, open });
    await safe.openCurrent();
    expect(open).toHaveBeenCalledWith(await realpath(f.configuration.attachmentRoot));
  });

  it('allows only one active cutover and consumes its selection once', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'keep.txt'), 'keep');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const cutover = vi.fn(async (work: () => Promise<unknown>) => { await gate; await work(); });
    const change = createAttachmentRootChange({ settings: f.settings, getAgentWorkspace: async () => f.workspace,
      runCutover: cutover as never, pick: async () => f.target, open: vi.fn() });
    const selection = await change.prepare();
    const moving = change.move(selection!.id);
    await expect(change.move(selection!.id)).rejects.toThrow(/expired/);
    await expect(change.move((await change.prepare())!.id)).rejects.toThrow(/already in progress/);
    finish(); await moving;
    expect(cutover).toHaveBeenCalledOnce();
  });

  it.each(['bootstrap', 'ancestor'] as const)('rejects an attachment source equal to or above the bootstrap root before cutover (%s)', async (sourceKind) => {
    const f = await fixture();
    const source = sourceKind === 'bootstrap' ? f.bootstrapRoot : f.root;
    const configFile = join(f.bootstrapRoot, 'bootstrap.json');
    await writeFile(configFile, 'protected configuration');
    f.configuration.attachmentRoot = source;
    await expect(f.change.prepare()).rejects.toThrow(/contains the application settings folder/);
    expect(f.cutover).not.toHaveBeenCalled();
    expect(f.settings.save).not.toHaveBeenCalled();
    expect(await readFile(configFile, 'utf8')).toBe('protected configuration');
  });

  it('rejects an attachment source that is the Agent workspace before cutover and preserves its contents', async () => {
    const f = await fixture();
    const sentinel = join(f.workspace, 'agent-data.txt');
    await writeFile(sentinel, 'workspace data');
    f.configuration.attachmentRoot = f.workspace;
    await expect(f.change.prepare()).rejects.toThrow(/overlaps the Agent workspace/);
    expect(f.cutover).not.toHaveBeenCalled();
    expect(f.settings.save).not.toHaveBeenCalled();
    expect(await readFile(sentinel, 'utf8')).toBe('workspace data');
  });

  it('allows a dedicated attachment folder below bootstrap and retains the legacy source after migration', async () => {
    const f = await fixture();
    const dedicatedSource = join(f.bootstrapRoot, 'data', 'attachments');
    await mkdir(dedicatedSource, { recursive: true });
    const protectedConfig = join(f.bootstrapRoot, 'bootstrap.json');
    await writeFile(protectedConfig, 'protected configuration');
    await writeFile(join(dedicatedSource, 'item.bin'), Buffer.from([8, 7, 6]));
    f.configuration.attachmentRoot = dedicatedSource;
    const selection = await f.change.prepare();
    await f.change.move(selection!.id);
    expect(await readFile(protectedConfig, 'utf8')).toBe('protected configuration');
    expect(await readFile(join(dedicatedSource, 'item.bin'))).toEqual(Buffer.from([8, 7, 6]));
    expect(f.configuration.attachmentRoot).toBe(await realpath(f.target));
  });

  it('rejects source and target roots that overlap embedded PostgreSQL data', async () => {
    const f = await fixture();
    const embeddedData = join(f.root, 'program-data', 'postgres', 'S-1-5-21-1', 'data');
    await mkdir(embeddedData, { recursive: true });
    const sentinel = join(embeddedData, 'PG_VERSION');
    await writeFile(sentinel, '18');
    const manager = (pick: () => Promise<string | null>) => createAttachmentRootChange({ settings: f.settings,
      getAgentWorkspace: async () => f.workspace, getAdditionalProtectedPaths: async () => [embeddedData],
      runCutover: f.cutover as never, pick, open: vi.fn() });

    f.configuration.attachmentRoot = embeddedData;
    await expect(manager(async () => f.target).prepare()).rejects.toThrow(/embedded database data/);
    expect(f.cutover).not.toHaveBeenCalled();
    expect(await readFile(sentinel, 'utf8')).toBe('18');

    f.configuration.attachmentRoot = f.source;
    await expect(manager(async () => embeddedData).prepare()).rejects.toThrow(/overlap the embedded database data/);
    expect(f.cutover).not.toHaveBeenCalled();
    expect(await readFile(sentinel, 'utf8')).toBe('18');
  });
});
