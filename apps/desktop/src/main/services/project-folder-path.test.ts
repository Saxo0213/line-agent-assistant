import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { defaultProjectPathPolicy, stripExtendedPrefix, validateProjectFolderPath, type ProjectPathPolicy } from './project-folder-path.js';

const windows = process.platform === 'win32' ? describe : describe.skip;

windows('project folder path validation', () => {
  let base: string;
  let policy: ProjectPathPolicy;
  const dir = async (...parts: string[]) => { const path = join(base, ...parts); await mkdir(path, { recursive: true }); return path; };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'project-folder-')));
    policy = {
      forbiddenTrees: [await dir('Windows'), await dir('Program Files'), await dir('Program Files (x86)'), await dir('ProgramData')],
      protectedPaths: [await dir('LocalAppData', 'LineAgentAssistant'), await dir('install')],
      profileRoots: [await dir('Users', 'boss')],
      workspace: async () => join(base, 'agent', 'workspace'),
    };
    await dir('agent', 'workspace', 'groups');
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('accepts an existing folder (spaces, Chinese) and returns its canonical path', async () => {
    const folder = await dir('公司 專案', '第一季 報告');
    expect(await validateProjectFolderPath(folder, policy)).toEqual({ ok: true, path: folder });
    expect(await validateProjectFolderPath(`  ${folder}  `, policy)).toEqual({ ok: true, path: folder });
    expect(await validateProjectFolderPath(`${folder}\\`, policy)).toEqual({ ok: true, path: folder });
  });

  it('accepts a sub-folder of the user profile but refuses the profile root and its parents', async () => {
    const sub = await dir('Users', 'boss', 'Documents', 'Projects');
    expect(await validateProjectFolderPath(sub, policy)).toMatchObject({ ok: true });
    expect(await validateProjectFolderPath(join(base, 'Users', 'boss'), policy)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await validateProjectFolderPath(join(base, 'Users'), policy)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('refuses relative, drive-relative, device and missing paths and files', async () => {
    const file = join(base, 'a-file.txt');
    await writeFile(file, 'x');
    for (const input of ['', '   ', 'Projects\\Alpha', '.\\Alpha', '\\Alpha', 'D:Alpha', '\\\\?\\C:\\Windows', '\\\\.\\C:']) {
      expect(await validateProjectFolderPath(input, policy), input).toEqual({ ok: false, reason: 'not_absolute' });
    }
    expect(await validateProjectFolderPath(join(base, 'does-not-exist'), policy)).toEqual({ ok: false, reason: 'not_found' });
    expect(await validateProjectFolderPath(file, policy)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses drive roots', async () => {
    const root = parse(base).root;
    expect(await validateProjectFolderPath(root, policy)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await validateProjectFolderPath(root.replace(/\\$/, ''), policy)).toMatchObject({ ok: false });
  });

  it.each([
    ['Windows', ['Windows'], true], ['inside Windows', ['Windows', 'System32'], true],
    ['Program Files', ['Program Files'], true], ['inside Program Files (x86)', ['Program Files (x86)', 'App'], true],
    ['ProgramData', ['ProgramData'], true], ['inside ProgramData', ['ProgramData', 'Vendor'], true],
  ])('refuses %s', async (_name, parts, forbidden) => {
    const path = await dir(...parts);
    expect(await validateProjectFolderPath(path, policy)).toEqual(forbidden ? { ok: false, reason: 'forbidden' } : { ok: true, path });
  });

  it('refuses app data, the installation, the workspace, their parents and anything inside them', async () => {
    const appData = join(base, 'LocalAppData', 'LineAgentAssistant');
    await dir('LocalAppData', 'LineAgentAssistant', 'logs');
    const workspace = join(base, 'agent', 'workspace');
    for (const path of [appData, join(appData, 'logs'), join(base, 'LocalAppData'), join(base, 'install'), workspace, join(workspace, 'groups'),
      join(base, 'agent'), base]) {
      expect(await validateProjectFolderPath(path, policy), path).toEqual({ ok: false, reason: 'forbidden' });
    }
    // A sibling of the workspace that merely shares a name prefix is fine.
    const sibling = await dir('agent', 'workspace-notes');
    expect(await validateProjectFolderPath(sibling, policy)).toEqual({ ok: true, path: sibling });
  });

  it('compares case-insensitively', async () => {
    expect(await validateProjectFolderPath(join(base, 'PROGRAM FILES'), policy)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await validateProjectFolderPath(join(base, 'windows'), policy)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('judges a junction by its real target: into a forbidden place is refused, into an allowed place is stored as the target', async () => {
    const link = join(base, 'looks-harmless');
    await symlink(join(base, 'Windows'), link, 'junction');
    expect(await validateProjectFolderPath(link, policy)).toEqual({ ok: false, reason: 'forbidden' });
    const viaProfile = join(base, 'to-profile');
    await symlink(join(base, 'Users', 'boss'), viaProfile, 'junction');
    expect(await validateProjectFolderPath(viaProfile, policy)).toEqual({ ok: false, reason: 'forbidden' });
    const viaWorkspace = join(base, 'to-workspace');
    await symlink(join(base, 'agent', 'workspace', 'groups'), viaWorkspace, 'junction');
    expect(await validateProjectFolderPath(viaWorkspace, policy)).toEqual({ ok: false, reason: 'forbidden' });
    const real = await dir('real-projects');
    const good = join(base, 'alias-to-projects');
    await symlink(real, good, 'junction');
    expect(await validateProjectFolderPath(good, policy)).toEqual({ ok: true, path: real });
    // A path that walks through a junction to a forbidden sub-folder is refused too.
    const through = join(good, '..', 'Program Files');
    expect(await validateProjectFolderPath(through, policy)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('refuses characters that cannot be written safely into a permission rule', async () => {
    for (const name of ['專案 (舊)', 'a[1]', 'a{b}', 'what#', 'x^y', 'bang!']) {
      const path = await dir(name);
      expect(await validateProjectFolderPath(path, policy), name).toEqual({ ok: false, reason: 'unsupported_chars' });
    }
    expect(await validateProjectFolderPath(`${base}\\a*b`, policy)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a UNC share root and accepts a folder below it (syntax and root rule only)', async () => {
    // The share does not exist here, so both stay not_found; the root rule is covered through the real drive-root case above.
    expect(await validateProjectFolderPath('\\\\no-such-host-for-test\\share', policy)).toMatchObject({ ok: false });
    expect(await validateProjectFolderPath('\\\\no-such-host-for-test\\share\\Projects', policy)).toEqual({ ok: false, reason: 'not_found' });
    expect(await validateProjectFolderPath('\\\\', policy)).toEqual({ ok: false, reason: 'not_absolute' });
    expect(await validateProjectFolderPath('\\\\server', policy)).toEqual({ ok: false, reason: 'not_absolute' });
  });

  it('survives a workspace lookup failure by not treating it as protected', async () => {
    const folder = await dir('plain');
    const failing: ProjectPathPolicy = { ...policy, workspace: async () => { throw new Error('unavailable'); } };
    expect(await validateProjectFolderPath(folder, failing)).toEqual({ ok: true, path: folder });
  });
});

describe('project path helpers', () => {
  it('strips the extended-length prefix', () => {
    expect(stripExtendedPrefix('\\\\?\\C:\\Projects')).toBe('C:\\Projects');
    expect(stripExtendedPrefix('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
    expect(stripExtendedPrefix('C:\\Projects')).toBe('C:\\Projects');
  });

  it('builds the default policy from the Windows environment', () => {
    const policy = defaultProjectPathPolicy({ homeDirectory: 'C:\\Users\\boss', protectedPaths: ['C:\\Apps\\Agent'],
      environment: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\boss\\AppData\\Local' } });
    expect(policy.forbiddenTrees).toEqual(expect.arrayContaining(['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']));
    expect(policy.protectedPaths).toEqual(['C:\\Users\\boss\\AppData\\Local\\LineAgentAssistant', 'C:\\Apps\\Agent']);
    expect(policy.profileRoots).toEqual(['C:\\Users\\boss']);
  });
});
