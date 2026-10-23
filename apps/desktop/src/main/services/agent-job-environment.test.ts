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
  'chat_folder.write': 'DENY', 'agent.local_tools': 'DENY', ...overrides });

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
    const full = { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, interactiveApproval:true };
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
    expect(plan.tools).toEqual({ localTools: false, fileRead: true, fileWrite: false, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false });
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
