import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_PERMISSION_IDS, type AgentPermissionId } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';
import { MessageRepository } from './message-repository.js';
import { FriendWhitelistRepository } from './friend-whitelist-repository.js';
import { McpTokenRepository } from './mcp-token-repository.js';
import {
  AgentPermissionError, AgentPermissionRepository, allPermissions, deriveToolPolicy, resolveJobPolicy,
  resolveLinkedChats, resolvePrincipalPermissions, resolveUserPermissions,
} from './agent-permissions.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ACCOUNT = 'acc';

database('Agent permissions, chat folders and folder links', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let tokens: McpTokenRepository;
  let messages: MessageRepository;
  let repo: AgentPermissionRepository;
  let friends: FriendWhitelistRepository;
  const grants = new Map<string, { grantId: string; version: number }>();

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    tokens = new McpTokenRepository(pool);
    messages = new MessageRepository(pool);
    repo = new AgentPermissionRepository(pool);
    friends = new FriendWhitelistRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(ACCOUNT);
    await accounts.setOwnMid(ACCOUNT, 'mid-bot');
    await pool.query("UPDATE line_accounts SET display_name = 'Agent LINE', mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = $1", [ACCOUNT]);
    await new AdminRepository(pool).bindPrimary(ACCOUNT, 'admin-direct', 'mid-admin');
    await messages.upsertConversationCatalog(ACCOUNT, [
      { chatType: 'group', chatId: 'g1', title: 'Group One', members: [
        { memberId: 'user-a', displayName: 'Alice LINE', nickname: 'Owner Nick A' }, { memberId: 'user-b', displayName: 'Bob LINE' }] },
      { chatType: 'group', chatId: 'g2', title: 'Group Two', members: [{ memberId: 'user-a', displayName: 'Alice LINE', nickname: 'Owner Nick A' }] },
      // The line-worker stores the owner's nickname as the direct chat title; the seed follows that real rule.
      { chatType: 'direct', chatId: 'user-a', title: 'Owner Nick A', members: [{ memberId: 'user-a', displayName: 'Alice LINE', nickname: 'Owner Nick A' }] },
      { chatType: 'direct', chatId: 'user-b', title: 'Owner Nick B', members: [{ memberId: 'user-b', displayName: 'Bob LINE', nickname: 'Owner Nick B' }] },
      { chatType: 'direct', chatId: 'admin-direct', title: 'Admin', members: [{ memberId: 'mid-admin', displayName: 'Boss' }] },
    ]);
    for (const [chatId, chatType, sender, text] of [
      ['g1', 'group', 'user-a', 'hello from g1'], ['g2', 'group', 'user-a', 'hello from g2'],
      ['user-a', 'direct', 'user-a', 'hello 1:1 a'], ['user-b', 'direct', 'user-b', 'hello 1:1 b'],
    ] as const) {
      const id = `m-${randomUUID()}`;
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, 'live', now(), '{}'::jsonb)`, [ACCOUNT, id, `ev-${id}`, chatId, chatType, sender, text]);
    }
    for (const mid of ['user-a', 'user-b']) {
      const grant = await friends.activate(ACCOUNT, mid, 'test');
      grants.set(mid, { grantId: grant.grantId, version: grant.version });
    }
    for (const chatId of ['g1', 'g2']) {
      const requestId = randomUUID();
      await pool.query(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
           admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,$2,'group',$3,$4,'member','admin-direct','mid-admin',1,1,'CONSUMED',clock_timestamp())`, [requestId, ACCOUNT, chatId, randomUUID()]);
      await pool.query(`INSERT INTO room_agent_policies(account_id, chat_type, chat_id, state, authority_version) VALUES ($1,'group',$2,'ENABLED',1)`, [ACCOUNT, chatId]);
      const grantId = randomUUID();
      await pool.query(
        `INSERT INTO room_agent_grants(grant_id, account_id, chat_type, chat_id, capability, version, state, request_id)
         VALUES ($1,$2,'group',$3,'AGENT_USE_ROOM',1,'ACTIVE',$4)`, [grantId, ACCOUNT, chatId, requestId]);
      grants.set(`room:${chatId}`, { grantId, version: 1 });
    }
  });
  afterAll(async () => { await close(); });

  const seedJob = async (chatType: 'direct' | 'group', chatId: string, senderId: string, sourceType: 'line' | 'ui' = 'line'): Promise<string> => {
    const jobId = randomUUID();
    const messageId = `m-${randomUUID()}`;
    await pool.query(`UPDATE agent_jobs SET status = 'completed', completed_at = now() WHERE ((account_id = $1 AND chat_type = $2 AND chat_id = $3) OR ($4 = 'ui' AND source_type = 'ui')) AND status = 'running'`, [ACCOUNT, chatType, chatId, sourceType]);
    if (sourceType === 'line') {
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 'trigger', 'live', now(), '{}'::jsonb)`, [ACCOUNT, messageId, `ev-${messageId}`, chatId, chatType, senderId]);
    }
    const direct = grants.get(senderId);
    const room = chatType === 'group' ? grants.get(`room:${chatId}`) : undefined;
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_request_id, prompt, workspace_path, generation, creation_epoch, status,
         direct_friend_grant_id, direct_friend_grant_version, room_agent_grant_id, room_agent_grant_version)
       VALUES ($1, $2, $3, $4, 'claude', $5, $6, $7, 'p', 'C:\\workspace', 1, $12, 'running', $8, $9, $10, $11)`,
      // Shared Agent room jobs (UI) are account-less.
      [jobId, sourceType === 'ui' ? null : ACCOUNT, sourceType === 'ui' ? null : chatType, sourceType === 'ui' ? null : chatId, sourceType, sourceType === 'line' ? messageId : null, sourceType === 'ui' ? randomUUID() : null,
        sourceType === 'line' && senderId !== 'mid-admin' ? direct?.grantId ?? null : null, sourceType === 'line' && senderId !== 'mid-admin' ? direct?.version ?? null : null,
        sourceType === 'line' && senderId !== 'mid-admin' ? room?.grantId ?? null : null, sourceType === 'line' && senderId !== 'mid-admin' ? room?.version ?? null : null, sourceType === 'line' ? 1 : null]);
    return jobId;
  };

  const callTool = (jobId: string, toolName: 'list_targets' | 'query_target_messages', args: { target?: string; senderName?: string } = {},
    requestedChat?: { chatType?: 'group' | 'direct'; chatId?: string }) => tokens.executeForInternalAgent({
    context: { sourceType: 'line', jobId }, toolName,
    ...(requestedChat ? { requestedChat } : {}),
    execute: async ({ client, authorizedAccountIds, conversationScope, extraConversationScopes, ownLineNamesOnly }) => {
      const scope = { ...(conversationScope ? { conversationScope } : {}), ...(extraConversationScopes ? { extraConversationScopes } : {}), ...(ownLineNamesOnly ? { ownLineNamesOnly } : {}) };
      if (toolName === 'list_targets') {
        const targets = await messages.listConversationTargets({ accountIds: authorizedAccountIds, ...scope, ...(args.target ? { query: args.target } : {}) }, client);
        return { data: { targets, messages: [] as Awaited<ReturnType<MessageRepository['queryTargetMessages']>> }, resultCount: targets.length };
      }
      const rows = await messages.queryTargetMessages({ accountIds: authorizedAccountIds, ...scope, ...args }, client);
      return { data: { targets: [] as Awaited<ReturnType<MessageRepository['listConversationTargets']>>, messages: rows }, resultCount: rows.length };
    },
  });

  const set = (subject: Parameters<AgentPermissionRepository['setPermission']>[0]['subject'], permission: AgentPermissionId, effect: 'ALLOW' | 'DENY' | 'INHERIT', expectedVersion: number, chatId = 'g1') =>
    repo.setPermission({ accountId: ACCOUNT, subject, chatType: 'group', chatId, permission, effect, expectedVersion }, 'tester');
  const seedLegacy = async (kind: 'EVERYONE' | 'USER', mid: string | null, permission: AgentPermissionId, effect: 'ALLOW' | 'DENY') => {
    await pool.query(`INSERT INTO agent_permission_rules (account_id, subject_kind, subject_mid, permission, effect, version, updated_by)
      VALUES ($1,$2,$3,$4,$5,1,'legacy-test')`, [ACCOUNT, kind, mid, permission, effect]);
  };
  const current = async (subject: 'EVERYONE' | string, permission: string): Promise<number> => {
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM agent_permission_rules WHERE account_id=$1 AND permission=$2 AND subject_mid=$3 AND chat_type='group' AND chat_id='g1'`, [ACCOUNT, permission, subject]);
    return rows.rows[0] ? Number(rows.rows[0].version) : 0;
  };
  const clearRules = async () => {
    await pool.query('DELETE FROM agent_permission_rules WHERE account_id = $1', [ACCOUNT]);
    await pool.query('DELETE FROM agent_permission_global_defaults');
  };

  it('resolves scoped user override before legacy user, 所有人 and catalog default, while admin/operator still bypass', async () => {
    await clearRules();
    const defaults = await resolveUserPermissions(pool, ACCOUNT, 'user-a');
    expect(defaults).toEqual({ 'records.query_current_chat': 'ALLOW', 'records.query_all_chats': 'DENY', 'chat_folder.read': 'ALLOW',
      'chat_folder.write': 'ALLOW', 'agent.local_tools': 'DENY' });
    await seedLegacy('EVERYONE', null, 'records.query_current_chat', 'DENY');
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('DENY');
    await seedLegacy('USER', 'user-a', 'records.query_current_chat', 'ALLOW');
    await set({ kind: 'USER', mid: 'user-a' }, 'records.query_current_chat', 'DENY', 0);
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('DENY');
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g2' }))['records.query_current_chat']).toBe('ALLOW');
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-b', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('DENY');
    await seedLegacy('EVERYONE', null, 'chat_folder.write', 'DENY');
    await set({ kind: 'USER', mid: 'user-b' }, 'chat_folder.write', 'ALLOW', 0);
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-b', { chatType: 'group', chatId: 'g1' }))['chat_folder.write']).toBe('ALLOW');
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['chat_folder.write']).toBe('DENY');
    // Admin/operator ignore every rule; unresolved never ALLOWs.
    expect(await resolvePrincipalPermissions(pool, ACCOUNT, { kind: 'admin', userId: 'mid-admin' })).toEqual(allPermissions('ALLOW'));
    expect(await resolvePrincipalPermissions(pool, ACCOUNT, { kind: 'operator' })).toEqual(allPermissions('ALLOW'));
    expect(await resolvePrincipalPermissions(pool, ACCOUNT, { kind: 'unresolved' })).toEqual(allPermissions('DENY'));
    await clearRules();
  });

  it('setPermission: optimistic versions, unknown ids, INHERIT deletes, every change audited and the audit is append-only', async () => {
    await clearRules();
    const before = Number((await pool.query('SELECT count(*) AS n FROM agent_permission_audit')).rows[0].n);
    const subject = { kind: 'USER' as const, mid: 'user-a' };
    const v1 = await set(subject, 'records.query_all_chats', 'ALLOW', 0);
    await expect(set(subject, 'records.query_all_chats', 'DENY', 0)).rejects.toMatchObject({ code: 'PERMISSION_VERSION_CONFLICT' });
    const v2 = await set(subject, 'records.query_all_chats', 'DENY', v1);
    expect(v2).toBeGreaterThan(v1);
    const v3 = await set(subject, 'records.query_all_chats', 'INHERIT', v2);
    expect(await current('user-a', 'records.query_all_chats')).toBe(0);
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a'))['records.query_all_chats']).toBe('DENY');
    // Recreating after a delete keeps versions monotonic (no ABA with the stale client).
    expect(await set(subject, 'records.query_all_chats', 'ALLOW', 0)).toBeGreaterThan(v3);
    await expect(set(subject, 'no.such_permission' as AgentPermissionId, 'ALLOW', 0)).rejects.toBeInstanceOf(AgentPermissionError);
    await expect(set(subject, 'no.such_permission' as AgentPermissionId, 'ALLOW', 0)).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' });
    const after = Number((await pool.query('SELECT count(*) AS n FROM agent_permission_audit')).rows[0].n);
    expect(after - before).toBe(4);
    await expect(pool.query('UPDATE agent_permission_audit SET actor = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM agent_permission_audit')).rejects.toThrow(/append-only/);
    await clearRules();
    expect(AGENT_PERMISSION_IDS).toContain('chat_folder.read');
  });

  it('persists global defaults below legacy account rules and above the catalog with optimistic audit versions', async () => {
    await clearRules();
    expect((await repo.getGlobalDefaults()).rules).toEqual([]);
    const v1 = await repo.setGlobalDefault({ permission: 'records.query_current_chat', effect: 'DENY', expectedVersion: 0 }, 'operator');
    expect(v1).toBeGreaterThan(0);
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('DENY');
    expect((await repo.getState(ACCOUNT)).defaults).toEqual([{ permission: 'records.query_current_chat', effect: 'DENY', version: v1 }]);
    await seedLegacy('EVERYONE', null, 'records.query_current_chat', 'ALLOW');
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('ALLOW');
    await expect(repo.setGlobalDefault({ permission: 'records.query_current_chat', effect: 'ALLOW', expectedVersion: 0 }, 'operator'))
      .rejects.toMatchObject({ code: 'PERMISSION_VERSION_CONFLICT' });
    const v2 = await repo.setGlobalDefault({ permission: 'records.query_current_chat', effect: 'INHERIT', expectedVersion: v1 }, 'operator');
    expect(v2).toBeGreaterThan(v1);
    await clearRules();
    const v3 = await repo.setGlobalDefault({ permission: 'records.query_current_chat', effect: 'ALLOW', expectedVersion: 0 }, 'operator');
    expect(v3).toBeGreaterThan(v2);
    expect((await resolveUserPermissions(pool, ACCOUNT, 'user-a', { chatType: 'group', chatId: 'g1' }))['records.query_current_chat']).toBe('ALLOW');
    await expect(repo.setGlobalDefault({ permission: 'no.such_permission' as AgentPermissionId, effect: 'ALLOW', expectedVersion: 0 }, 'operator'))
      .rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' });
    await clearRules();
  });

  it('MCP: defaults give chat-only scope; 所有人 DENY blocks users but not the admin; override changes apply to the next call; revocation still denies', async () => {
    await clearRules();
    const userJob = await seedJob('group', 'g1', 'user-a');
    const adminJob = await seedJob('group', 'g1', 'mid-admin');
    expect((await callTool(userJob, 'query_target_messages')).messages.every((m) => m.chatId === 'g1')).toBe(true);
    expect((await callTool(adminJob, 'query_target_messages')).messages.map((m) => m.chatId)).toContain('g2');

    await seedLegacy('EVERYONE', null, 'records.query_current_chat', 'DENY');
    await seedLegacy('USER', 'user-a', 'records.query_current_chat', 'ALLOW');
    const scopedDenyVersion = await set({ kind: 'USER', mid: 'user-a' }, 'records.query_current_chat', 'DENY', 0);
    await expect(callTool(userJob, 'query_target_messages')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(callTool(userJob, 'list_targets')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await callTool(adminJob, 'query_target_messages')).messages.length).toBeGreaterThan(0);
    const audit = (await tokens.listAuditRecords(20)).find((row) => row.disposition === 'PERMISSION_DENIED');
    expect(audit).toMatchObject({ initiator: 'internal_agent', action: 'AUTH_REJECTED', toolName: 'list_targets' });
    // tools/list input: the same resolution is exposed by verifyInternalAgent.
    const listed = await tokens.verifyInternalAgent({ context: { sourceType: 'line', jobId: userJob } });
    expect(listed['records.query_current_chat']).toBe('DENY');
    const otherGroupJob = await seedJob('group', 'g2', 'user-a');
    expect((await callTool(otherGroupJob, 'query_target_messages')).messages.every((m) => m.chatId === 'g2')).toBe(true);
    expect((await resolveJobPolicy(pool, otherGroupJob))!.permissions['records.query_current_chat']).toBe('ALLOW');
    expect((await tokens.verifyInternalAgent({ context: { sourceType: 'line', jobId: otherGroupJob } }))['records.query_current_chat']).toBe('ALLOW');
    // Mid-job override: the next call uses the new effect.
    await set({ kind: 'USER', mid: 'user-a' }, 'records.query_current_chat', 'ALLOW', scopedDenyVersion);
    expect((await callTool(userJob, 'query_target_messages')).messages.every((m) => m.chatId === 'g1')).toBe(true);
    // query_all_chats ALLOW is the only widening, and it stays within the job's account.
    await seedLegacy('USER', 'user-a', 'records.query_all_chats', 'ALLOW');
    const widened = (await callTool(userJob, 'query_target_messages')).messages;
    expect(new Set(widened.map((m) => m.chatId))).toEqual(new Set(['g1', 'g2', 'user-a', 'user-b']));
    expect(widened.every((m) => m.accountId === ACCOUNT)).toBe(true);
    await clearRules();
    // Grant revoked mid-job: denied (v1.0.76 behavior kept).
    const revokable = await seedJob('direct', 'user-b', 'user-b');
    expect((await callTool(revokable, 'query_target_messages')).messages.length).toBeGreaterThan(0);
    await friends.revoke(ACCOUNT, 'user-b', 'test');
    await expect(callTool(revokable, 'query_target_messages')).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const reactivated = await friends.activate(ACCOUNT, 'user-b', 'test');
    grants.set('user-b', { grantId: reactivated.grantId, version: reactivated.version });
  });

  it('name privacy: whitelisted users see LINE display names only; admin keeps nicknames; nicknames cannot be probed by search', async () => {
    await clearRules();
    const userJob = await seedJob('group', 'g1', 'user-a');
    const adminJob = await seedJob('group', 'g1', 'mid-admin');
    const userView = (await callTool(userJob, 'query_target_messages')).messages.find((m) => m.senderId === 'user-a');
    expect(userView?.senderName).toBe('Alice LINE');
    const adminView = (await callTool(adminJob, 'query_target_messages')).messages.find((m) => m.senderId === 'user-a');
    expect(adminView?.senderName).toBe('Owner Nick A');
    expect((await callTool(userJob, 'query_target_messages', { senderName: 'Owner Nick' })).messages).toEqual([]);
    expect((await callTool(userJob, 'query_target_messages', { target: 'Owner Nick' })).messages).toEqual([]);
    expect((await callTool(adminJob, 'query_target_messages', { senderName: 'Owner Nick' })).messages.length).toBeGreaterThan(0);
    const members = (await callTool(userJob, 'list_targets')).targets[0]?.members;
    expect(members?.find((m) => m.memberId === 'user-a')?.displayName).toBe('Alice LINE');
    expect(JSON.stringify(await callTool(userJob, 'list_targets'))).not.toContain('Owner Nick');
  });

  it('name privacy covers direct chat titles (the owner nickname is stored as the title): list, query, search and the all-chats scope', async () => {
    await clearRules();
    const userJob = await seedJob('direct', 'user-a', 'user-a');
    const adminJob = await seedJob('direct', 'admin-direct', 'mid-admin');
    const ownChat = await callTool(userJob, 'query_target_messages');
    const ownTargets = await callTool(userJob, 'list_targets');
    expect(JSON.stringify(ownChat)).not.toContain('Owner Nick');
    expect(JSON.stringify(ownTargets)).not.toContain('Owner Nick');
    expect(ownChat.messages.length).toBeGreaterThan(0);
    expect(ownChat.messages.every((m) => m.conversationTitle === 'Alice LINE')).toBe(true);
    expect(ownTargets.targets.map((t) => t.conversationTitle)).toEqual(['Alice LINE']);
    for (const probe of [{ target: 'Owner Nick' }, { senderName: 'Owner Nick' }]) {
      expect((await callTool(userJob, 'query_target_messages', probe)).messages).toEqual([]);
    }
    expect((await callTool(userJob, 'list_targets', { target: 'Owner Nick' })).targets).toEqual([]);
    // The admin keeps the full rule: nickname titles, nickname search.
    expect((await callTool(adminJob, 'query_target_messages', { target: 'Owner Nick' })).messages.length).toBeGreaterThan(0);
    const adminTitles = (await callTool(adminJob, 'list_targets', { target: 'Owner Nick' })).targets.map((t) => t.conversationTitle);
    expect(adminTitles).toEqual(expect.arrayContaining(['Owner Nick A', 'Owner Nick B']));
    // records.query_all_chats widens scope, not names.
    await seedLegacy('USER', 'user-a', 'records.query_all_chats', 'ALLOW');
    const all = await callTool(userJob, 'query_target_messages');
    const allTargets = await callTool(userJob, 'list_targets');
    expect(new Set(all.messages.map((m) => m.chatId))).toEqual(new Set(['g1', 'g2', 'user-a', 'user-b', 'admin-direct']));
    expect(JSON.stringify(all)).not.toContain('Owner Nick');
    expect(JSON.stringify(allTargets)).not.toContain('Owner Nick');
    const directTitles = new Set(all.messages.filter((m) => m.chatType === 'direct' && m.chatId !== 'admin-direct').map((m) => m.conversationTitle));
    expect(directTitles).toEqual(new Set(['Alice LINE', 'Bob LINE']));
    expect((await callTool(userJob, 'query_target_messages', { target: 'Owner Nick' })).messages).toEqual([]);
    expect((await callTool(userJob, 'list_targets', { target: 'Owner Nick' })).targets).toEqual([]);
    await clearRules();
  });

  it('job policy and provider tool derivation from the job row', async () => {
    await clearRules();
    const userJob = await seedJob('group', 'g1', 'user-a');
    const policy = (await resolveJobPolicy(pool, userJob))!;
    expect(policy.principal).toEqual({ kind: 'user', senderMid: 'user-a' });
    expect(deriveToolPolicy(policy)).toEqual({ localTools: false, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false });
    await set({ kind: 'USER', mid: 'user-a' }, 'chat_folder.write', 'ALLOW', 0);
    await set({ kind: 'USER', mid: 'user-a' }, 'chat_folder.read', 'DENY', 0);
    expect(deriveToolPolicy((await resolveJobPolicy(pool, userJob))!)).toEqual({ localTools: false, fileRead: false, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false });
    await set({ kind: 'USER', mid: 'user-a' }, 'agent.local_tools', 'ALLOW', 0);
    expect(deriveToolPolicy((await resolveJobPolicy(pool, userJob))!).localTools).toBe(true);
    const adminPolicy = (await resolveJobPolicy(pool, await seedJob('group', 'g1', 'mid-admin')))!;
    expect(adminPolicy.principal.kind).toBe('admin');
    expect(deriveToolPolicy(adminPolicy)).toMatchObject({ localTools: true, interactiveApproval:false });
    const uiPolicy = (await resolveJobPolicy(pool, await seedJob('direct', 'admin-direct', 'x', 'ui')))!;
    expect(uiPolicy.principal.kind).toBe('operator');
    expect(uiPolicy).toMatchObject({ accountId: null, chatType: null, chatId: null, linkedChats: [] });
    expect(deriveToolPolicy(uiPolicy)).toMatchObject({ localTools: true, fileRead: true, fileWrite: true, interactiveApproval:true });
    expect(await resolveJobPolicy(pool, randomUUID())).toBeNull();
    await clearRules();
  });

  it('resolves login job permissions from the captured sender before the source message exists', async () => {
    await clearRules();
    await set({ kind: 'USER', mid: 'user-a' }, 'chat_folder.read', 'ALLOW', 0);
    const jobId = randomUUID();
    const sourceMessageId = `not-yet-stored-${randomUUID()}`;
    await pool.query(`INSERT INTO agent_jobs (job_id,account_id,chat_type,chat_id,provider,source_type,source_message_id,
      source_sender_id,prompt,workspace_path,generation,creation_epoch,status,direct_friend_grant_id,direct_friend_grant_version)
      VALUES ($1,$2,'group','g1','codex','line',$3,'user-a','direct envelope prompt','C:\\workspace',1,1,'queued',$4,$5)`,
    [jobId, ACCOUNT, sourceMessageId, grants.get('user-a')!.grantId, grants.get('user-a')!.version]);
    const policy = await resolveJobPolicy(pool, jobId);
    expect(policy?.principal).toEqual({ kind: 'user', senderMid: 'user-a' });
    expect(policy?.permissions['chat_folder.read']).toBe('ALLOW');
    expect((await pool.query('SELECT 1 FROM messages WHERE account_id=$1 AND message_id=$2', [ACCOUNT, sourceMessageId])).rowCount).toBe(0);
    await set({ kind: 'USER', mid: 'user-a' }, 'chat_folder.read', 'DENY', await current('user-a', 'chat_folder.read'));
    expect((await resolveJobPolicy(pool, jobId))?.permissions['chat_folder.read']).toBe('DENY');
    await clearRules();
  });

  it('stores execution policy defaults, applies optimistic versioning, and accepts only valid tool allowlist values', async () => {
    expect(await repo.getExecutionPolicy()).toMatchObject({ level: 'full', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 1 });
    await pool.query('INSERT INTO agent_execution_policy (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING');
    expect((await pool.query('SELECT timeout_action FROM agent_execution_policy WHERE singleton = true')).rows[0]).toEqual({ timeout_action: 'DENY' });
    await expect(repo.setExecutionPolicy({ level: 'trust', approvalTimeoutSeconds: 240, timeoutAction: 'ALLOW', expectedVersion: 1 })).resolves.toBe(2);
    await expect(repo.setExecutionPolicy({ level: 'full', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', expectedVersion: 1 })).rejects.toMatchObject({ code: 'PERMISSION_VERSION_CONFLICT' });
    expect(await repo.getExecutionPolicy()).toMatchObject({ level: 'trust', approvalTimeoutSeconds: 240, timeoutAction: 'ALLOW', version: 2 });
    expect((await pool.query('SELECT timeout_action FROM agent_execution_policy WHERE singleton = true')).rows[0]).toEqual({ timeout_action: 'ALLOW' });
    const tool = await repo.addToolAllowlistEntry('tool', 'mcp__linejs__list_targets');
    const webFetch = await repo.addToolAllowlistEntry('tool', 'WebFetch');
    const bash = await repo.addToolAllowlistEntry('bash_command', ' git  status \n');
    expect(bash.value).toBe(' git  status \n');
    expect((await repo.listToolAllowlist()).find(entry=>entry.id===bash.id)?.value).toBe(' git  status \n');
    await expect(repo.addToolAllowlistEntry('bash_command','')).rejects.toMatchObject({code:'INVALID_ALLOWLIST'});
    await expect(repo.addToolAllowlistEntry('bash_command',' \t ')).rejects.toMatchObject({code:'INVALID_ALLOWLIST'});
    await expect(repo.addToolAllowlistEntry('bash_command','bad\0command')).rejects.toMatchObject({code:'INVALID_ALLOWLIST'});
    expect((await repo.addToolAllowlistEntry('bash_command','x'.repeat(2000))).value).toHaveLength(2000);
    await expect(repo.addToolAllowlistEntry('bash_command','x'.repeat(2001))).rejects.toMatchObject({code:'INVALID_ALLOWLIST'});
    expect(tool.value).toBe('mcp__linejs__list_targets');
    expect(webFetch.value).toBe('WebFetch');
    for (const value of ['bash','BASH','Bash','rm -rf','git status','']) {
      await expect(repo.addToolAllowlistEntry('tool', value)).rejects.toMatchObject({ code: 'INVALID_ALLOWLIST' });
    }
    await expect(repo.addToolAllowlistEntry('bash_head' as 'tool', 'git status')).rejects.toMatchObject({ code: 'INVALID_ALLOWLIST' });
    expect(await repo.listToolAllowlist()).toHaveLength(4);
    await expect(pool.query("INSERT INTO agent_tool_allowlist (kind,value) VALUES ('bash_head','git status')")).rejects.toThrow();
    await expect(pool.query("INSERT INTO agent_tool_allowlist (kind,value) VALUES ('bash_command',$1)", ['x'.repeat(2001)])).rejects.toThrow();
    await repo.removeToolAllowlistEntry(tool.id);
    await repo.clearToolAllowlist();
    expect(await repo.listToolAllowlist()).toHaveLength(0);
    await repo.recordExecutionApproval({decision:'allow_once',tool:'Bash'},'operator');
    expect((await pool.query("SELECT detail FROM agent_permission_audit WHERE audit_kind='EXECUTION_APPROVAL'")).rows[0]?.detail).toEqual({decision:'allow_once',tool:'Bash'});
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE agent_tool_allowlist IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(repo.addToolAllowlistEntry('tool', 'WebSearch')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally { await locker.query('ROLLBACK').catch(() => undefined); locker.release(); }
    const audit = await pool.query("SELECT audit_kind, count(*)::int n FROM agent_permission_audit WHERE audit_kind IN ('EXECUTION_POLICY','ALLOWLIST') GROUP BY audit_kind");
    expect(audit.rows).toEqual(expect.arrayContaining([expect.objectContaining({ audit_kind: 'EXECUTION_POLICY', n: 1 }), expect.objectContaining({ audit_kind: 'ALLOWLIST', n: 6 })]));
  });

  it('migration 049 changes only an untouched version 1 policy and audits the change once', async () => {
    const migration = await readFile(fileURLToPath(new URL('../migrations/049_agent_execution_default_full.sql', import.meta.url)), 'utf8');
    const auditCount = async () => (await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM agent_permission_audit WHERE audit_kind = 'EXECUTION_POLICY' AND actor = 'system:default_full'" )).rows[0]!.n;

    await pool.query('DELETE FROM agent_execution_policy');
    await pool.query('INSERT INTO agent_execution_policy (singleton) VALUES (true)');
    expect((await pool.query('SELECT level, timeout_action FROM agent_execution_policy WHERE singleton = true')).rows[0]).toEqual({ level: 'full', timeout_action: 'DENY' });
    await pool.query("DELETE FROM agent_permission_audit WHERE actor = 'system:default_full'");
    await pool.query('DELETE FROM agent_execution_policy');
    await pool.query("ALTER TABLE agent_execution_policy ALTER COLUMN level SET DEFAULT 'workspace_write'");
    await pool.query("INSERT INTO agent_execution_policy (singleton, level, version) VALUES (true, 'workspace_write', 1)");
    await pool.query(migration);
    expect(await repo.getExecutionPolicy()).toMatchObject({ level: 'full', version: 2 });
    const audit = await pool.query<{ detail: unknown; new_version: number }>(
      "SELECT detail, new_version FROM agent_permission_audit WHERE audit_kind = 'EXECUTION_POLICY' AND actor = 'system:default_full'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ detail: { level: 'full', approvalTimeoutSeconds: 180 } });
    expect(Number(audit.rows[0]!.new_version)).toBe(2);
    expect(await auditCount()).toBe(1);

    await pool.query("UPDATE agent_execution_policy SET level = 'workspace_write', version = 3");
    await pool.query(migration);
    expect(await repo.getExecutionPolicy()).toMatchObject({ level: 'workspace_write', version: 3 });
    const untouchedAuditCount = await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM agent_permission_audit WHERE audit_kind = 'EXECUTION_POLICY' AND actor = 'system:default_full' AND new_version = 4");
    expect(untouchedAuditCount.rows[0]!.n).toBe(0);
    await pool.query('DELETE FROM agent_execution_policy');
    await expect(repo.getExecutionPolicy()).resolves.toMatchObject({ level: 'full', approvalTimeoutSeconds: 180, version: 1 });
  });

  it('fails a policy write blocked by a row lock within the statement timeout and rolls it back', async () => {
    await pool.query('INSERT INTO agent_execution_policy (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING');
    const before = await repo.getExecutionPolicy();
    const auditCount = async () => (await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM agent_permission_audit WHERE audit_kind = 'EXECUTION_POLICY'")).rows[0]!.n;
    const auditBefore = await auditCount();
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT * FROM agent_execution_policy WHERE singleton = true FOR UPDATE');
      const started = Date.now();
      await expect(repo.setExecutionPolicy({ level: before.level === 'full' ? 'trust' : 'full',
        approvalTimeoutSeconds: before.approvalTimeoutSeconds, timeoutAction: before.timeoutAction, expectedVersion: before.version }, 'lock-test'))
        .rejects.toMatchObject({ code: '57014' });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(3_500);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
    expect(await repo.getExecutionPolicy()).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
    // The pooled client was rolled back and is reusable without a leftover transaction or timeout.
    const reused = await pool.query<{ timeout: string }>('SHOW statement_timeout');
    expect(reused.rows[0]!.timeout).not.toBe('2s');
  }, 15_000);

  it('caps operator and user file write permissions at the policy level', async () => {
    const userJob = await seedJob('group', 'g1', 'user-a');
    const current = await repo.getExecutionPolicy();
    await repo.setExecutionPolicy({ level: 'read_only', approvalTimeoutSeconds: 180, timeoutAction: current.timeoutAction, expectedVersion: current.version });
    expect(deriveToolPolicy((await resolveJobPolicy(pool, userJob))!, 'read_only').fileWrite).toBe(false);
    const operator = (await resolveJobPolicy(pool, await seedJob('direct', 'admin-direct', 'x', 'ui')))!;
    expect(deriveToolPolicy(operator, 'read_only')).toMatchObject({ level: 'read_only', fileWrite: false, localTools: true });
    expect(deriveToolPolicy(operator, 'trust')).toMatchObject({ level: 'trust', fileWrite: true });
  });

  it('chat folders are idempotent, per chat, and include friend 1:1 chats; state lists eligible chats and display names', async () => {
    const g1 = await repo.ensureChatFolder(ACCOUNT, 'group', 'g1', 'tester');
    expect((await repo.ensureChatFolder(ACCOUNT, 'group', 'g1', 'tester')).folderId).toBe(g1.folderId);
    const g2 = await repo.ensureChatFolder(ACCOUNT, 'group', 'g2', 'tester');
    const direct = await repo.ensureChatFolder(ACCOUNT, 'direct', 'user-a', 'tester');
    expect(new Set([g1.folderId, g2.folderId, direct.folderId]).size).toBe(3);
    expect(direct.title).toBe('Owner Nick A');
    await expect(repo.ensureChatFolder(ACCOUNT, 'group', 'nope', 'tester')).rejects.toMatchObject({ code: 'INVALID_CHAT' });
    await expect(repo.ensureChatFolder(ACCOUNT, 'community', 'x', 'tester')).rejects.toMatchObject({ code: 'INVALID_CHAT' });
    const state = await repo.getState(ACCOUNT);
    expect(state.subjects.map((s) => s.displayName)).toEqual(['Alice LINE', 'Bob LINE']);
    expect(state.subjects.some((s) => JSON.stringify(s).includes('Owner Nick'))).toBe(false);
    expect(state.eligibleChats.map((c) => `${c.chatType}/${c.chatId}`).sort()).toEqual(['direct/user-a', 'direct/user-b', 'group/g1', 'group/g2']);
    expect(await repo.getChatFolder(randomUUID())).toBeNull();
  });

  it('folder links: IPC-level rules, READ-only runtime, records union, removal on the next call, other users unaffected', async () => {
    await clearRules();
    const g1 = await repo.ensureChatFolder(ACCOUNT, 'group', 'g1', 'tester');
    const g2 = await repo.ensureChatFolder(ACCOUNT, 'group', 'g2', 'tester');
    const direct = await repo.ensureChatFolder(ACCOUNT, 'direct', 'user-b', 'tester');
    const link = (subjectMid: string, folderId: string, access: 'NONE' | 'READ' | 'WRITE', expectedVersion: number) =>
      repo.setFolderLink({ accountId: ACCOUNT, subjectMid, folderId, access, expectedVersion }, 'tester');
    // Row 14: direct folder, non-whitelisted subject, unknown folder; WRITE fails closed.
    await expect(link('user-a', direct.folderId, 'READ', 0)).rejects.toMatchObject({ code: 'INVALID_LINK' });
    await expect(link('stranger', g1.folderId, 'READ', 0)).rejects.toMatchObject({ code: 'INVALID_LINK' });
    await expect(link('user-a', randomUUID(), 'READ', 0)).rejects.toMatchObject({ code: 'INVALID_LINK' });
    await expect(link('user-a', g1.folderId, 'WRITE', 0)).rejects.toMatchObject({ code: 'LINK_WRITE_UNSUPPORTED' });

    // Row 11: A linked READ to g1 and g2 and triggers in their 1:1.
    const v1 = await link('user-a', g1.folderId, 'READ', 0);
    await link('user-a', g2.folderId, 'READ', 0);
    await expect(link('user-a', g1.folderId, 'READ', 0)).rejects.toMatchObject({ code: 'PERMISSION_VERSION_CONFLICT' });
    expect((await resolveLinkedChats(pool, ACCOUNT, 'user-a')).map((l) => l.chatId).sort()).toEqual(['g1', 'g2']);
    const aJob = await seedJob('direct', 'user-a', 'user-a');
    const aMessages = (await callTool(aJob, 'query_target_messages')).messages;
    expect(new Set(aMessages.map((m) => m.chatId))).toEqual(new Set(['user-a', 'g1', 'g2']));
    await expect(callTool(aJob, 'query_target_messages', {}, { chatType: 'group', chatId: 'g2' })).resolves.toBeDefined();
    await expect(callTool(aJob, 'query_target_messages', {}, { chatId: 'user-b' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await callTool(aJob, 'list_targets')).targets.map((t) => t.chatId).sort()).toEqual(['g1', 'g2', 'user-a']);
    expect(JSON.stringify(aMessages)).not.toContain('Owner Nick');
    // Job-start policy carries the links for the --add-dir set.
    expect((await resolveJobPolicy(pool, aJob))!.linkedChats.map((l) => l.chatId).sort()).toEqual(['g1', 'g2']);
    // Row 16: B is unaffected.
    const bJob = await seedJob('direct', 'user-b', 'user-b');
    expect(new Set((await callTool(bJob, 'query_target_messages')).messages.map((m) => m.chatId))).toEqual(new Set(['user-b']));
    expect((await resolveJobPolicy(pool, bJob))!.linkedChats).toEqual([]);
    // Row 13: removal takes effect on the next call of the same job.
    await link('user-a', g1.folderId, 'NONE', v1);
    expect(new Set((await callTool(aJob, 'query_target_messages')).messages.map((m) => m.chatId))).toEqual(new Set(['user-a', 'g2']));
    // Linked records need current-chat ALLOW.
    await repo.setPermission({ accountId: ACCOUNT, subject: { kind: 'USER', mid: 'user-a' }, chatType: 'direct', chatId: 'user-a',
      permission: 'records.query_current_chat', effect: 'DENY', expectedVersion: 0 }, 'tester');
    await expect(callTool(aJob, 'query_target_messages')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Links are audited with the folder id, and removing the folder cascades the link.
    const audit = await pool.query("SELECT count(*) AS n FROM agent_permission_audit WHERE permission = 'folder_link' AND folder_id IS NOT NULL");
    expect(Number(audit.rows[0].n)).toBe(3);
    await pool.query('DELETE FROM chat_folders WHERE folder_id = $1', [g2.folderId]);
    expect(await resolveLinkedChats(pool, ACCOUNT, 'user-a')).toEqual([]);
    await clearRules();
  });

  it('revokes the selected user account and chat grants together and audits every affected scope', async () => {
    await friends.activate(ACCOUNT, 'user-b', 'test', { kind: 'CHAT', chatType: 'group', chatId: 'g1' });
    const before = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM line_friend_whitelist_audit WHERE target_mid='user-b' AND action='REVOKED'");
    expect(await friends.revokeAll(ACCOUNT, 'user-b', 'operator')).toBe(2);
    expect(await friends.getActiveAuthorization(ACCOUNT, 'user-b', { kind: 'ACCOUNT' })).toBeNull();
    expect(await friends.getActiveAuthorization(ACCOUNT, 'user-b', { kind: 'CHAT', chatType: 'group', chatId: 'g1' })).toBeNull();
    expect((await repo.getState(ACCOUNT)).subjects.some((subject) => subject.mid === 'user-b')).toBe(false);
    const after = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM line_friend_whitelist_audit WHERE target_mid='user-b' AND action='REVOKED'");
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(2);
  });
});
