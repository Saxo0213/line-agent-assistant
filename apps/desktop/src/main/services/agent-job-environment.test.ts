import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allPermissions, type ChatFolderRow, type JobPolicy } from '@line-agent/database';
import type { EffectivePermissions } from '@line-agent/contracts';
import { AgentJobEnvironmentService } from './agent-job-environment.js';
import { ChatFolderService, type ChatFolderStore } from './chat-folders.js';

let base: string;
let workspace: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'job-env-')));
  workspace = join(base, 'workspace');
  await mkdir(workspace);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const rows = new Map<string, ChatFolderRow>();
const store: ChatFolderStore = {
  async ensureChatFolder(accountId, chatType, chatId) {
    const key = JSON.stringify([accountId, chatType, chatId]);
    if (!rows.has(key)) rows.set(key, { folderId: crypto.randomUUID(), accountId, chatType: chatType as ChatFolderRow['chatType'], chatId, title: chatId });
    return rows.get(key)!;
  },
};
const userPermissions = (overrides: Partial<EffectivePermissions> = {}): EffectivePermissions => ({
  'records.query_current_chat': 'ALLOW', 'records.query_all_chats': 'DENY', 'chat_folder.read': 'ALLOW',
  'chat_folder.write': 'DENY', 'agent.local_tools': 'DENY', 'project_folder.read': 'DENY', 'project_folder.write': 'DENY', ...overrides });

function environment(policy: JobPolicy | null, getExecutionLevel?: () => Promise<'read_only'|'workspace_write'|'trust'|'full'>) {
  return new AgentJobEnvironmentService({ resolvePolicy: async () => policy, ...(getExecutionLevel ? { getExecutionLevel } : {}),
    folders: new ChatFolderService(store, { current: async () => workspace }), workspace: { current: async () => workspace } });
}
const user = (chatType: JobPolicy['chatType'], chatId: string, extra: Partial<JobPolicy> = {}): JobPolicy => ({
  principal: { kind: 'user', senderMid: 'U1' }, accountId: 'acc', chatType, chatId, permissions: userPermissions(), linkedChats: [], ...extra });

describe('job workspace and provider tools are selected from the job row', () => {
  it('fails closed when the durable execution policy cannot be loaded', async () => {
    expect(await environment({ principal:{kind:'operator'}, accountId:null, chatType:null, chatId:null,
      permissions:allPermissions('ALLOW'), linkedChats:[] }, async () => { throw new Error('db unavailable'); }).prepare('j'))
      .toEqual({ ok:false, code:'EXECUTION_POLICY_UNAVAILABLE', message:'The Agent execution policy could not be loaded.' });
  });
  it('row 1/4c: operator and primary-admin 1:1 run in the top layer with the default workspace-write policy', async () => {
    const full = { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: true, interactiveApproval:true };
    const operator = await environment({ principal: { kind: 'operator' }, accountId: 'acc', chatType: 'direct', chatId: '__local_agent_room__',
      permissions: allPermissions('ALLOW'), linkedChats: [] }).prepare('j');
    expect(operator).toEqual({ ok: true, workspacePath: workspace, tools: full });
    const admin = await environment({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType: 'direct', chatId: 'A',
      permissions: allPermissions('ALLOW'), linkedChats: [] }).prepare('j');
    expect(admin).toEqual({ ok: true, workspacePath: workspace, tools: { ...full, interactiveApproval:false } });
  });

  it('keeps the workspace stored on the job row for top-layer jobs', async () => {
    const plan = await environment({ principal: { kind: 'operator' }, accountId: 'acc', chatType: 'direct', chatId: 'x',
      permissions: allPermissions('ALLOW'), linkedChats: [] }).prepare('j', 'Z:\\stored-on-job');
    expect(plan).toMatchObject({ ok: true, workspacePath: 'Z:\\stored-on-job' });
  });

  it('row 2/4b: the primary admin inside a group runs in that group\'s folder with full tools; two groups never share a cwd', async () => {
    const adminIn = (chatId: string): JobPolicy => ({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType: 'group', chatId,
      permissions: allPermissions('ALLOW'), linkedChats: [] });
    const g1 = await environment(adminIn('g-one')).prepare('j');
    const g2 = await environment(adminIn('g-two')).prepare('j');
    expect(g1).toMatchObject({ ok: true, tools: { localTools: true } });
    if (!g1.ok || !g2.ok) throw new Error('expected plans');
    expect(g1.workspacePath.startsWith(join(workspace, 'groups'))).toBe(true);
    expect(g1.workspacePath).not.toBe(g2.workspacePath);
    // The admin layer is the whole system: the workspace root is mounted next to the group cwd.
    expect(g1.tools.workspaceRootDir).toBe(workspace);
    expect(g1.tools.linkedReadDirs).toEqual([]);
    // Top-layer jobs already run in the root and mount nothing extra.
    const top = await environment({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType: 'direct', chatId: 'A',
      permissions: allPermissions('ALLOW'), linkedChats: [] }).prepare('j');
    expect(top).toMatchObject({ ok: true, tools: { workspaceRootDir: null } });
  });

  it('row 3/4: a whitelisted user in a group gets read-only file tools in the group folder; an explicit write override adds Write/Edit', async () => {
    const plan = await environment(user('group', 'g-three')).prepare('j');
    if (!plan.ok) throw new Error('expected plan');
    expect(plan.workspacePath.startsWith(join(workspace, 'groups'))).toBe(true);
    // A whitelisted user never gets the workspace root, and without links nothing is mounted.
    expect(plan.tools).toEqual({ localTools: false, fileRead: true, fileWrite: false, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write', webTools: true, interactiveApproval:false });
    const writable = await environment(user('group', 'g-three', { permissions: userPermissions({ 'chat_folder.write': 'ALLOW' }) })).prepare('j');
    expect(writable).toMatchObject({ ok: true, workspacePath: plan.workspacePath, tools: { fileWrite: true, localTools: false } });
    const none = await environment(user('group', 'g-three', { permissions: userPermissions({ 'chat_folder.read': 'DENY' }) })).prepare('j');
    expect(none).toMatchObject({ ok: true, tools: { fileRead: false, fileWrite: false, localTools: false } });
  });

  it('row 4d: a whitelisted friend 1:1 runs in chats\\<folder_id>, never the top layer', async () => {
    const plan = await environment(user('direct', 'U1')).prepare('j');
    if (!plan.ok) throw new Error('expected plan');
    expect(plan.workspacePath.startsWith(join(workspace, 'chats'))).toBe(true);
    expect(plan.workspacePath).not.toBe(workspace);
    expect(plan.tools.localTools).toBe(false);
  });

  it('row 11/16: links mount the linked group folders read-only; users without links are unaffected', async () => {
    const linked = await environment(user('direct', 'U1', { linkedChats: [
      { folderId: 'x', chatType: 'group', chatId: 'link-one' }, { folderId: 'y', chatType: 'group', chatId: 'link-two' }] })).prepare('j');
    if (!linked.ok) throw new Error('expected plan');
    expect(linked.workspacePath.startsWith(join(workspace, 'chats'))).toBe(true);
    expect(linked.tools.linkedReadDirs).toHaveLength(2);
    expect(linked.tools.linkedReadDirs.every((dir) => dir.startsWith(join(workspace, 'groups')))).toBe(true);
    expect(linked.tools.fileWrite).toBe(false);
    expect(linked.tools.fileRead).toBe(true);
    const plain = await environment(user('direct', 'U2')).prepare('j');
    expect(plain).toMatchObject({ ok: true, tools: { linkedReadDirs: [] } });
  });

  it('row 15: a linked folder that is a junction escaping groups\\ fails the job closed', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    const folder = await store.ensureChatFolder('acc', 'group', 'escape-link', 't');
    await mkdir(join(workspace, 'groups'), { recursive: true });
    await symlink(outside, join(workspace, 'groups', folder.folderId), 'junction');
    const plan = await environment(user('direct', 'U1', { linkedChats: [{ folderId: folder.folderId, chatType: 'group', chatId: 'escape-link' }] })).prepare('j');
    expect(plan).toMatchObject({ ok: false, code: 'CHAT_FOLDER_UNAVAILABLE' });
  });

  it('fails closed when the policy is missing, unresolved, or the workspace is unavailable', async () => {
    expect(await environment(null).prepare('j')).toMatchObject({ ok: false, code: 'JOB_POLICY_UNRESOLVED' });
    expect(await environment({ ...user('group', 'g'), principal: { kind: 'unresolved' } }).prepare('j')).toMatchObject({ ok: false, code: 'JOB_POLICY_UNRESOLVED' });
    const broken = new AgentJobEnvironmentService({ resolvePolicy: async () => user('group', 'g'),
      folders: new ChatFolderService(store, { current: async () => join(base, 'missing') }), workspace: { current: async () => join(base, 'missing') } });
    expect(await broken.prepare('j')).toMatchObject({ ok: false });
  });
});

describe('extra Agent tools are loaded only for eligible principals', () => {
  const extras = { servers: [{ name: 'files', transport: 'stdio' as const, command: 'node', args: [], env: { K: 'v' }, headers: {}, providers: ['claude' as const] }],
    tools: { webSearch: true, webFetch: false, bash: false, fileRead: false, fileWrite: false } };
  const withExtras = (policy: JobPolicy | null, resolveExtensions: () => Promise<typeof extras | null> = async () => extras) =>
    new AgentJobEnvironmentService({ resolvePolicy: async () => policy, resolveExtensions,
      folders: new ChatFolderService(store, { current: async () => workspace }), workspace: { current: async () => workspace } });
  const all = allPermissions('ALLOW');

  it('gives extensions to the operator (Agent room and schedules) and to the Primary Admin, direct or in a group', async () => {
    const operator = await withExtras({ principal: { kind: 'operator' }, accountId: null, chatType: null, chatId: null, permissions: all, linkedChats: [] }).prepare('j');
    expect(operator).toMatchObject({ ok: true, extensions: extras });
    const adminDirect = await withExtras({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType: 'direct', chatId: 'A', permissions: all, linkedChats: [] }).prepare('j');
    expect(adminDirect).toMatchObject({ ok: true, extensions: extras });
    const adminGroup = await withExtras({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType: 'group', chatId: 'g1', permissions: all, linkedChats: [] }).prepare('j');
    expect(adminGroup).toMatchObject({ ok: true, extensions: extras });
  });

  it('never gives extensions to whitelisted members, free-mode jobs or unresolved jobs, and does not even look them up', async () => {
    let lookups = 0;
    const counting = async () => { lookups += 1; return extras; };
    const member = await withExtras(user('group', 'g1'), counting).prepare('j');
    expect(member).toMatchObject({ ok: true }); expect('extensions' in member).toBe(false);
    const freeMode = await withExtras({ ...user('group', 'g1'), principal: { kind: 'user', senderMid: 'free-mode:member' } }, counting).prepare('j');
    expect('extensions' in freeMode).toBe(false);
    const direct = await withExtras(user('direct', 'U1'), counting).prepare('j');
    expect('extensions' in direct).toBe(false);
    expect(await withExtras({ ...user('group', 'g1'), principal: { kind: 'unresolved' } }, counting).prepare('j')).toMatchObject({ ok: false });
    expect(lookups).toBe(0);
  });

  it('leaves the plan unchanged when nothing is configured or the lookup fails', async () => {
    const policy: JobPolicy = { principal: { kind: 'operator' }, accountId: null, chatType: null, chatId: null, permissions: all, linkedChats: [] };
    expect('extensions' in await withExtras(policy, async () => null).prepare('j')).toBe(false);
    expect(await withExtras(policy, async () => { throw new Error('decrypt failed'); }).prepare('j')).toMatchObject({ ok: true, tools: { localTools: true } });
    const without = await environment(policy).prepare('j');
    expect('extensions' in without).toBe(false);
  });
});

describe('project folders (/folder) are mounted per principal', () => {
  const mounts = [{ path: 'D:/Company/Ro', mode: 'READ' as const }, { path: 'D:/Company/Rw', mode: 'READ_WRITE' as const }];
  const withFolders = (policy: JobPolicy | null, level: 'read_only' | 'workspace_write' | 'trust' | 'full' = 'workspace_write',
    resolve: () => Promise<typeof mounts> = async () => mounts, seen: unknown[] = []) =>
    new AgentJobEnvironmentService({ resolvePolicy: async () => policy, getExecutionLevel: async () => level,
      resolveProjectFolders: async (key) => { seen.push(key); return resolve(); },
      folders: new ChatFolderService(store, { current: async () => workspace }), workspace: { current: async () => workspace } });
  const adminIn = (chatType: JobPolicy['chatType'], chatId: string): JobPolicy => ({ principal: { kind: 'admin', userId: 'A' }, accountId: 'acc', chatType, chatId,
    permissions: allPermissions('ALLOW'), linkedChats: [] });
  const dirs = (plan: Awaited<ReturnType<AgentJobEnvironmentService['prepare']>>) => { if (!plan.ok) throw new Error('expected plan'); return plan.tools.projectDirs; };

  it('mounts every bound folder for the admin (group and 1:1) and makes only READ_WRITE ones writable', async () => {
    const seen: unknown[] = [];
    const group = await withFolders(adminIn('group', 'g1'), 'workspace_write', undefined, seen).prepare('j');
    expect(dirs(group)).toEqual([{ path: 'D:/Company/Ro', writable: false }, { path: 'D:/Company/Rw', writable: true }]);
    expect(group).toMatchObject({ ok: true, tools: { fileRead: true, fileWrite: true } });
    expect(seen).toEqual([{ accountId: 'acc', chatType: 'group', chatId: 'g1' }]);
    expect(dirs(await withFolders(adminIn('direct', 'A')).prepare('j'))).toHaveLength(2);
  });

  it('never makes a folder writable at the read_only execution level', async () => {
    const plan = await withFolders(adminIn('group', 'g1'), 'read_only').prepare('j');
    expect(dirs(plan)).toEqual([{ path: 'D:/Company/Ro', writable: false }, { path: 'D:/Company/Rw', writable: false }]);
    expect(plan).toMatchObject({ tools: { fileRead: true, fileWrite: false } });
  });

  it('mounts nothing for a whitelisted user without project_folder.read, and for the operator', async () => {
    expect(dirs(await withFolders(user('group', 'g1')).prepare('j'))).toEqual([]);
    const operator = await withFolders({ principal: { kind: 'operator' }, accountId: null, chatType: null, chatId: null, permissions: allPermissions('ALLOW'), linkedChats: [] }).prepare('j');
    expect(dirs(operator)).toEqual([]);
  });

  it('gives a user with project_folder.read the folders read-only; write needs project_folder.write too', async () => {
    const readOnly = await withFolders(user('group', 'g1', { permissions: userPermissions({ 'project_folder.read': 'ALLOW' }) })).prepare('j');
    expect(dirs(readOnly)).toEqual([{ path: 'D:/Company/Ro', writable: false }, { path: 'D:/Company/Rw', writable: false }]);
    expect(readOnly).toMatchObject({ tools: { fileRead: true, fileWrite: false } });
    const writer = await withFolders(user('group', 'g1', { permissions: userPermissions({ 'project_folder.read': 'ALLOW', 'project_folder.write': 'ALLOW' }) })).prepare('j');
    expect(dirs(writer)).toEqual([{ path: 'D:/Company/Ro', writable: false }, { path: 'D:/Company/Rw', writable: true }]);
    expect(writer).toMatchObject({ tools: { fileWrite: true } });
    // fileWrite exists only for the project folder: the user's own chat folder must stay read-only.
    expect(writer).toMatchObject({ tools: { ownFolderReadOnly: true } });
    const both = await withFolders(user('group', 'g1', { permissions: userPermissions({ 'project_folder.read': 'ALLOW', 'project_folder.write': 'ALLOW', 'chat_folder.write': 'ALLOW' }) })).prepare('j');
    expect(both).toMatchObject({ tools: { fileWrite: true } });
    expect('ownFolderReadOnly' in (both as { tools: object }).tools).toBe(false);
    const admin = await withFolders(adminIn('group', 'g1')).prepare('j');
    expect('ownFolderReadOnly' in (admin as { tools: object }).tools).toBe(false);
    const writeOnly = await withFolders(user('group', 'g1', { permissions: userPermissions({ 'project_folder.write': 'ALLOW' }) })).prepare('j');
    expect(dirs(writeOnly)).toEqual([]);
  });

  it('treats a free-mode member like any user: default DENY mounts nothing, an everyone rule mounts read-only', async () => {
    const member = { principal: { kind: 'user' as const, senderMid: 'free-mode:member' } };
    expect(dirs(await withFolders({ ...user('group', 'g1'), ...member }).prepare('j'))).toEqual([]);
    const allowed = await withFolders({ ...user('group', 'g1', { permissions: userPermissions({ 'project_folder.read': 'ALLOW' }) }), ...member }).prepare('j');
    expect(dirs(allowed).every((dir) => !dir.writable)).toBe(true);
    expect(dirs(allowed)).toHaveLength(2);
  });

  it('keeps linked read folders and project folders side by side, and the job runs without folders when the lookup fails', async () => {
    const both = await withFolders(user('direct', 'U1', { permissions: userPermissions({ 'project_folder.read': 'ALLOW' }),
      linkedChats: [{ folderId: 'x', chatType: 'group', chatId: 'link-one' }] })).prepare('j');
    if (!both.ok) throw new Error('expected plan');
    expect(both.tools.linkedReadDirs).toHaveLength(1);
    expect(both.tools.projectDirs).toHaveLength(2);
    const failing = await withFolders(adminIn('group', 'g1'), 'workspace_write', async () => { throw new Error('db'); }).prepare('j');
    expect(failing).toMatchObject({ ok: true, tools: { projectDirs: [] } });
  });
});
