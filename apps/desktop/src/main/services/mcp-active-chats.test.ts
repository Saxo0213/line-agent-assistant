import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  MCP_TOOL_EFFECTS, McpListActiveChatsInputSchema, McpQueryTargetMessagesByTimeInputSchema, type McpToolInputUnion, type McpToolOutputUnion,
} from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import {
  AccountRepository, AdminRepository, AgentPermissionRepository, FriendWhitelistRepository, McpTokenRepository, MessageRepository,
} from '../../../../../packages/database/src/index.js';
import { MCP_TOOL_DEFINITIONS, McpService } from './mcp-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const AGENT = 'account-agent';
const ADMIN = 'account-admin';
const FROM = '2026-10-30T00:00:00Z';
type ActiveOutput = Extract<McpToolOutputUnion, { toolName: 'list_active_chats' }>;
type TimedOutput = Extract<McpToolOutputUnion, { toolName: 'query_target_messages_by_time' }>;

database('list_active_chats and the by-time filters through McpService with a real database', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let tokens: McpTokenRepository;
  let messages: MessageRepository;
  let service: McpService;
  let permissions: AgentPermissionRepository;
  const grants = new Map<string, { grantId: string; version: number }>();

  const message = (account: string, chatType: string, chatId: string, id: string, sender: string, kind: string, at: string) => pool.query(
    `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live',$9,'{}')`, [account, id, `ev-${id}`, chatType, chatId, sender, kind, `secret text ${id}`, at]);

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    tokens = new McpTokenRepository(pool);
    messages = new MessageRepository(pool);
    permissions = new AgentPermissionRepository(pool);
    service = new McpService({ pool, tokens, messages });
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(ADMIN);
    await accounts.setOwnMid(ADMIN, 'mid-admin-1');
    await pool.query("UPDATE line_accounts SET display_name = 'Admin LINE', mode = 'MONITOR_ONLY', product_role = 'PRIMARY_ADMIN' WHERE account_id = $1", [ADMIN]);
    await accounts.ensureAccount(AGENT);
    await accounts.setOwnMid(AGENT, 'mid-bot');
    await pool.query("UPDATE line_accounts SET display_name = 'Agent LINE', mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = $1", [AGENT]);
    await new AdminRepository(pool).bindPrimary(AGENT, 'chat-admin', 'mid-admin-1');
    for (const [account, chatType, chatId, title] of [
      [AGENT, 'group', 'g1', 'Group One'], [AGENT, 'group', 'g2', 'Group Two'], [AGENT, 'direct', 'user-a', 'Owner Nick A'],
      [AGENT, 'direct', 'user-b', 'Owner Nick B'], [AGENT, 'direct', 'chat-admin', 'Admin chat'], [ADMIN, 'group', 'ga', 'Admin Group'],
    ] as const) await pool.query('INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,$2,$3,$4)', [account, chatType, chatId, title]);
    await pool.query(`INSERT INTO line_contacts(account_id,mid,display_name,nickname)
      VALUES ($1,'user-a','Alice LINE','Owner Nick A'),($1,'user-b','Bob LINE','Owner Nick B')`, [AGENT]);
    await message(AGENT, 'group', 'g1', 'a1', 'user-a', 'text', '2026-10-30T01:00:00Z');
    await message(AGENT, 'group', 'g1', 'a2', 'user-b', 'text', '2026-10-30T01:10:00Z');
    await message(AGENT, 'group', 'g1', 'a3', 'user-a', 'image', '2026-10-30T01:20:00Z');
    await message(AGENT, 'group', 'g2', 'b1', 'user-a', 'text', '2026-10-30T02:00:00Z');
    await message(AGENT, 'group', 'g2', 'b2', 'mid-bot', 'text', '2026-10-30T02:30:00Z');
    await message(AGENT, 'direct', 'user-a', 'c1', 'user-a', 'text', '2026-10-30T03:00:00Z');
    await message(AGENT, 'direct', 'user-a', 'c2', 'user-a', 'text', '2026-10-30T03:05:00Z');
    await message(AGENT, 'direct', 'user-b', 'd1', 'user-b', 'text', '2026-10-30T04:00:00Z');
    await message(AGENT, 'direct', 'chat-admin', 'e1', 'mid-admin-1', 'text', '2026-10-30T05:00:00Z');
    await message(ADMIN, 'group', 'ga', 'f1', 'ux', 'text', '2026-10-30T06:00:00Z');
    await message(ADMIN, 'group', 'ga', 'f2', 'uy', 'image', '2026-10-30T06:10:00Z');
    const friends = new FriendWhitelistRepository(pool);
    for (const mid of ['user-a', 'user-b']) {
      const grant = await friends.activate(AGENT, mid, 'test');
      grants.set(mid, { grantId: grant.grantId, version: grant.version });
    }
  });
  afterAll(async () => { await service.shutdown(); await close?.(); });

  const seedJob = async (chatType: 'direct' | 'group', chatId: string, senderId: string): Promise<string> => {
    const jobId = randomUUID();
    const messageId = `m-${randomUUID()}`;
    await pool.query("UPDATE agent_jobs SET status = 'completed', completed_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND status = 'running'", [AGENT, chatType, chatId]);
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', 'trigger', 'live', '2020-01-01T00:00:00Z', '{}'::jsonb)`, [AGENT, messageId, `ev-${messageId}`, chatId, chatType, senderId]);
    const direct = grants.get(senderId);
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status,
         direct_friend_grant_id, direct_friend_grant_version)
       VALUES ($1, $2, $3, $4, 'claude', 'line', $5, 'p', 'C:\\workspace', 1, 1, 'running', $6, $7)`,
      [jobId, AGENT, chatType, chatId, messageId, direct?.grantId ?? null, direct?.version ?? null]);
    return jobId;
  };

  const call = (name: string, args: Record<string, unknown>, context: Parameters<McpService['callInternalTool']>[1] = { sourceType: 'ui' }) =>
    service.callInternalTool({ name, arguments: args } as unknown as McpToolInputUnion, context);
  const active = async (args: Record<string, unknown>, context?: Parameters<McpService['callInternalTool']>[1]): Promise<ActiveOutput> => {
    const output = await call('list_active_chats', { from: FROM, ...args }, context);
    if (output.toolName !== 'list_active_chats') throw new Error('unexpected tool');
    return output;
  };
  const timed = async (args: Record<string, unknown>): Promise<TimedOutput> => {
    const output = await call('query_target_messages_by_time', args);
    if (output.toolName !== 'query_target_messages_by_time') throw new Error('unexpected tool');
    return output;
  };
  const summary = (output: ActiveOutput) => output.chats.map((chat) => `${chat.accountId}/${chat.chatType}/${chat.chatId}=${chat.messageCount}/${chat.senderCount}@${chat.lastMessageAt.slice(11, 16)}`);

  it('is a read tool with a description that tells the Agent to use it first and then read only the needed chats', () => {
    expect(MCP_TOOL_EFFECTS.list_active_chats).toBe('read');
    const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'list_active_chats')!;
    expect(definition.description).toContain('Use this tool first to see which chats have new messages and how many, and then read only the chats that you need');
    expect(definition.description).toContain('returns no message text');
    expect(definition.description).toContain('limit defaults to 200');
    expect(definition.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['from'] });
    const properties = Object.keys((definition.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    expect(properties).toEqual(['accountId', 'chatType', 'direction', 'excludeChatIds', 'excludeKinds', 'from', 'kinds', 'limit', 'to']);
    expect(properties).toEqual(Object.keys(McpListActiveChatsInputSchema.shape).sort());
  });

  it('documents the new by-time filters and points the Agent to list_active_chats', () => {
    const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'query_target_messages_by_time')!;
    for (const needle of ['list_active_chats', 'excludeChatIds', 'excludeKinds', 'direction', 'not both', 'pass the same values together with cursor']) {
      expect(definition.description).toContain(needle);
    }
    const properties = (definition.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const name of ['excludeChatIds', 'direction', 'kinds', 'excludeKinds']) expect(properties).toHaveProperty(name);
    expect(Object.keys(properties).sort()).toEqual(Object.keys(McpQueryTargetMessagesByTimeInputSchema.shape).sort());
    const plain = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'query_target_messages')!;
    for (const name of ['excludeChatIds', 'direction', 'kinds', 'excludeKinds']) {
      expect((plain.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty(name);
    }
  });

  it('lists every readable chat for the operator with hand-checked counts and no message text', async () => {
    const output = await active({ to: '2026-10-30T23:59:59Z' });
    expect(output).toMatchObject({ toolName: 'list_active_chats', from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T23:59:59.000Z', truncated: false });
    expect(summary(output)).toEqual([
      `${ADMIN}/group/ga=2/2@06:10`, `${AGENT}/direct/chat-admin=1/1@05:00`, `${AGENT}/direct/user-b=1/1@04:00`,
      `${AGENT}/direct/user-a=2/1@03:05`, `${AGENT}/group/g2=2/2@02:30`, `${AGENT}/group/g1=3/2@01:20`,
    ]);
    expect(output.chats[0]).toMatchObject({ accountDisplayName: 'Admin LINE', conversationTitle: 'Admin Group' });
    expect(JSON.stringify(output)).not.toContain('secret text');
    expect(Object.keys(output.chats[0]!).sort()).toEqual(
      ['accountDisplayName', 'accountId', 'chatId', 'chatType', 'conversationTitle', 'lastMessageAt', 'messageCount', 'senderCount']);
  });

  it('normalizes date-only bounds to whole days in Taiwan time', async () => {
    const output = await active({ from: '2026-10-30', to: '2026-10-30' });
    expect(output.from).toBe('2026-10-29T16:00:00.000Z');
    expect(output.to).toBe('2026-10-30T15:59:59.999Z');
    expect(output.chats).toHaveLength(6);
    const outside = await active({ from: '2026-10-31' });
    expect(outside).toMatchObject({ chats: [], truncated: false, to: null });
  });

  it('has counts equal to the rows of query_target_messages_by_time for several filter combinations', async () => {
    const combos: Array<Record<string, unknown>> = [
      {}, { chatType: 'group' }, { excludeChatIds: ['g1', 'ga'] }, { direction: 'outbound' }, { direction: 'inbound' }, { kinds: ['image'] },
      { kinds: ['text'] }, { excludeKinds: ['text'] }, { accountId: AGENT }, { accountId: ADMIN, kinds: ['text', 'image'] },
      { excludeChatIds: ['ga'], direction: 'inbound', excludeKinds: ['image'] },
    ];
    for (const filters of combos) {
      const rows: TimedOutput['messages'] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await timed({ from: FROM, limit: 2, ...filters, ...(cursor ? { cursor } : {}) });
        rows.push(...page.messages);
        if (!page.hasMore) break;
        cursor = page.nextCursor!;
      }
      const listed = await active(filters);
      expect(listed.chats.reduce((sum, chat) => sum + chat.messageCount, 0), JSON.stringify(filters)).toBe(rows.length);
      for (const chat of listed.chats) {
        const chatRows = rows.filter((row) => row.accountId === chat.accountId && row.chatType === chat.chatType && row.chatId === chat.chatId);
        expect(chat.messageCount).toBe(chatRows.length);
        expect(chat.senderCount).toBe(new Set(chatRows.map((row) => row.senderId)).size);
        expect(chat.lastMessageAt).toBe(chatRows.map((row) => row.occurredAt).sort().at(-1));
      }
    }
  });

  it('applies limit, the 500 clamp and truncated', async () => {
    const two = await active({ limit: 2 });
    expect(two.chats).toHaveLength(2);
    expect(two.truncated).toBe(true);
    const all = await active({ limit: 6 });
    expect(all.chats).toHaveLength(6);
    expect(all.truncated).toBe(false);
    const clamped = await active({ limit: 100000 });
    expect(clamped.chats).toHaveLength(6);
    await expect(call('list_active_chats', { from: FROM, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects invalid list_active_chats input as INVALID_INPUT before reading', async () => {
    expect((await active({})).chats.length).toBeGreaterThan(0);
    for (const args of [
      { from: FROM, kinds: ['text'], excludeKinds: ['image'] }, { to: FROM }, { from: 'soon' }, { from: '2026-10-31', to: '2026-10-30' },
      { from: FROM, direction: 'both' }, { from: FROM, chatId: 'g1' },
    ]) await expect(call('list_active_chats', args), JSON.stringify(args)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  describe('chat-scoped jobs', () => {
    it('shows a granted friend job only its own chat and the peer LINE name, and denies other accounts and chat types', async () => {
      const context = { sourceType: 'line' as const, jobId: await seedJob('direct', 'user-a', 'user-a') };
      const output = await active({}, context);
      expect(summary(output)).toEqual([`${AGENT}/direct/user-a=2/1@03:05`]);
      expect(output.chats[0]!.conversationTitle).toBe('Alice LINE');
      expect(JSON.stringify(output)).not.toContain('Owner Nick');
      await expect(active({ accountId: ADMIN }, context)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      await expect(active({ chatType: 'group' }, context)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      expect(summary(await active({ accountId: AGENT, chatType: 'direct' }, context))).toEqual([`${AGENT}/direct/user-a=2/1@03:05`]);
      expect(await active({ excludeChatIds: ['user-a'] }, context)).toMatchObject({ chats: [], truncated: false });
      // Filters can only narrow the scope, never widen it.
      expect(summary(await active({ kinds: ['text', 'image'], direction: 'inbound' }, context))).toEqual([`${AGENT}/direct/user-a=2/1@03:05`]);
    });

    it('adds only the linked chats, and takes them away again with the link', async () => {
      const context = { sourceType: 'line' as const, jobId: await seedJob('direct', 'user-a', 'user-a') };
      const folder = await permissions.ensureChatFolder(AGENT, 'group', 'g1', 'tester');
      const link = (access: 'READ' | 'NONE', expectedVersion: number) => permissions.setFolderLink(
        { accountId: AGENT, subjectMid: 'user-a', folderId: folder.folderId, access, expectedVersion }, 'tester');
      const version = await link('READ', 0);
      expect(summary(await active({}, context))).toEqual([`${AGENT}/direct/user-a=2/1@03:05`, `${AGENT}/group/g1=3/2@01:20`]);
      expect(summary(await active({ chatType: 'group' }, context))).toEqual([`${AGENT}/group/g1=3/2@01:20`]);
      expect((await active({}, context)).chats.some((chat) => chat.chatId === 'g2')).toBe(false);
      await link('NONE', version);
      expect(summary(await active({}, context))).toEqual([`${AGENT}/direct/user-a=2/1@03:05`]);
    });

    it('shows the Primary Administrator job every chat of every account', async () => {
      const context = { sourceType: 'line' as const, jobId: await seedJob('direct', 'chat-admin', 'mid-admin-1') };
      expect((await active({}, context)).chats).toHaveLength(6);
      expect((await active({ accountId: ADMIN }, context)).chats.map((chat) => chat.chatId)).toEqual(['ga']);
    });

    it('writes the same audit row type as the by-time query, with the number of returned chats as resultCount', async () => {
      const context = { sourceType: 'line' as const, jobId: await seedJob('direct', 'user-b', 'user-b') };
      await active({}, context);
      await call('query_target_messages_by_time', { from: FROM }, context);
      const rows = (await tokens.listAuditRecords(20)).filter((row) => row.principalId === 'internal:chat_scoped:direct:user-b');
      const listRow = rows.find((row) => row.toolName === 'list_active_chats')!;
      const queryRow = rows.find((row) => row.toolName === 'query_target_messages_by_time')!;
      expect(listRow).toMatchObject({ action: 'TOOL_CALLED', disposition: 'ALLOWED', initiator: 'internal_agent', resultCount: 1, accountScopes: [AGENT] });
      expect({ ...listRow, auditId: 0, toolName: '', occurredAt: '' }).toEqual({ ...queryRow, auditId: 0, toolName: '', occurredAt: '' });
    });
  });

  describe('external endpoint', () => {
    const rpc = (target: McpService, args: Record<string, unknown>, id = 1) => target.handleExternalJsonRpc({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_active_chats', arguments: args } });

    it('lists the tool, returns the chats and writes an audit row', async () => {
      const listed = await service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(((listed.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name)).toContain('list_active_chats');
      const response = await rpc(service, { from: FROM });
      expect(response.httpStatus).toBe(200);
      const result = (response.body as { result: { structuredContent: ActiveOutput; isError: boolean } }).result;
      expect(result.isError).toBe(false);
      expect(summary(result.structuredContent)).toHaveLength(6);
      const audit = (await tokens.listAuditRecords(10)).find((row) => row.toolName === 'list_active_chats' && row.principalId === 'local-client');
      expect(audit).toMatchObject({ action: 'TOOL_CALLED', disposition: 'ALLOWED', initiator: 'external_agent', tokenId: null, resultCount: 6 });
    });

    it('denies an account outside the role accounts and an invalid input, and audits both', async () => {
      const denied = await rpc(service, { from: FROM, accountId: 'account-unknown' });
      expect(denied.httpStatus).toBe(403);
      const invalid = await rpc(service, { from: FROM, kinds: ['text'], excludeKinds: ['image'] });
      expect(invalid.httpStatus).toBe(400);
      const audits = (await tokens.listAuditRecords(20)).filter((row) => row.toolName === 'list_active_chats' && row.action === 'AUTH_REJECTED');
      expect(audits.map((row) => row.disposition)).toEqual(expect.arrayContaining(['SCOPE_DENIED', 'INVALID_INPUT']));
    });

    it('keeps the external rate limit', async () => {
      const limited = new McpService({ pool, tokens, messages, rateLimitPerMinute: 2 });
      try {
        expect((await rpc(limited, { from: FROM })).httpStatus).toBe(200);
        expect((await rpc(limited, { from: FROM })).httpStatus).toBe(200);
        const third = await rpc(limited, { from: FROM });
        expect(third.httpStatus).toBe(429);
        const audit = (await tokens.listAuditRecords(10)).find((row) => row.toolName === 'list_active_chats' && row.disposition === 'RATE_LIMITED');
        expect(audit).toMatchObject({ action: 'AUTH_REJECTED', principalId: 'local-client' });
      } finally { await limited.shutdown(); }
    });
  });

  describe('filters of query_target_messages_by_time', () => {
    const readAll = async (filters: Record<string, unknown>, limit: number) => {
      const ids: string[] = [];
      let pages = 0;
      let cursor: string | undefined;
      for (;;) {
        const page = await timed({ from: FROM, limit, ...filters, ...(cursor ? { cursor } : {}) });
        pages += 1;
        ids.push(...page.messages.map((row) => row.messageId));
        if (!page.hasMore) break;
        cursor = page.nextCursor!;
      }
      return { ids, pages };
    };

    it.each<[string, Record<string, unknown>, number, string[]]>([
      ['excludeChatIds', { excludeChatIds: ['g1', 'ga'] }, 2, ['b1', 'b2', 'c1', 'c2', 'd1', 'e1']],
      ['direction inbound', { direction: 'inbound' }, 4, ['a1', 'a2', 'a3', 'b1', 'c1', 'c2', 'd1', 'e1', 'f1', 'f2']],
      ['direction outbound', { direction: 'outbound' }, 1, ['b2']],
      ['kinds', { kinds: ['image'] }, 1, ['a3', 'f2']],
      ['excludeKinds', { excludeKinds: ['image'] }, 3, ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'e1', 'f1']],
      ['all four but kinds', { excludeChatIds: ['ga'], direction: 'inbound', excludeKinds: ['image'] }, 2, ['a1', 'a2', 'b1', 'c1', 'c2', 'd1', 'e1']],
      ['kinds with a chat filter', { kinds: ['text', 'image'], excludeChatIds: ['g2'], direction: 'inbound' }, 3, ['a1', 'a2', 'a3', 'c1', 'c2', 'd1', 'e1', 'f1', 'f2']],
    ])('pages %s without gaps or duplicates', async (_label, filters, limit, expected) => {
      const { ids, pages } = await readAll(filters, limit);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(pages).toBe(Math.max(1, Math.ceil(expected.length / limit)));
      if (expected.length > limit) expect(pages).toBeGreaterThanOrEqual(2);
    });

    it('keeps the filters working next to a chat selector', async () => {
      expect((await readAll({ chatId: 'g1', excludeKinds: ['image'] }, 1)).ids).toEqual(['a1', 'a2']);
      expect((await readAll({ chatType: 'group', direction: 'outbound' }, 1)).ids).toEqual(['b2']);
    });

    it('rejects a cursor from another filter and accepts the same filter written another way', async () => {
      const base = { from: FROM, limit: 1 };
      const filtered = { excludeChatIds: ['g1', 'ga'], direction: 'inbound', excludeKinds: ['image'] };
      const first = await timed({ ...base, ...filtered });
      const cursor = first.nextCursor!;
      expect(cursor).toBeTruthy();
      const different: Array<Record<string, unknown>> = [
        {}, { excludeChatIds: ['g1'], direction: 'inbound', excludeKinds: ['image'] }, { ...filtered, excludeChatIds: ['g1', 'ga', 'g2'] },
        { ...filtered, direction: 'outbound' }, { excludeChatIds: ['g1', 'ga'], direction: 'inbound', kinds: ['text'] },
        { excludeChatIds: ['g1', 'ga'], direction: 'inbound', excludeKinds: ['video'] }, { excludeChatIds: ['g1', 'ga'], excludeKinds: ['image'] },
      ];
      for (const variant of different) {
        await expect(timed({ ...base, ...variant, cursor }), JSON.stringify(variant)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/different query/) });
      }
      expect((await timed({ ...base, ...filtered, excludeChatIds: ['ga', 'g1', 'g1'], cursor })).messages).toHaveLength(1);
      // A cursor of an unfiltered query is not valid for a filtered one, and empty filters keep an unfiltered cursor valid.
      const plain = await timed(base);
      await expect(timed({ ...base, direction: 'inbound', cursor: plain.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await timed({ ...base, excludeChatIds: [], cursor: plain.nextCursor! })).messages).toHaveLength(1);
    });

    it('fails both kinds and excludeKinds, and does not accept the filters on query_target_messages', async () => {
    expect((await timed({ from: FROM, kinds: ['text'] })).messages.length).toBeGreaterThan(0);
    expect((await timed({ from: FROM, excludeKinds: ['text'] })).messages.length).toBeGreaterThan(0);
      await expect(call('query_target_messages_by_time', { from: FROM, kinds: ['text'], excludeKinds: ['image'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      for (const extra of [{ excludeChatIds: ['g1'] }, { direction: 'inbound' }, { kinds: ['text'] }, { excludeKinds: ['text'] }]) {
        await expect(call('query_target_messages', { chatId: 'g1', ...extra })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
    });

    it('does not count the filters as a target selector', async () => {
      await expect(call('query_target_messages_by_time', { to: FROM, excludeChatIds: ['g1'], direction: 'inbound' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await timed({ from: FROM, excludeChatIds: ['g1'] })).messages.length).toBeGreaterThan(0);
    });

    it('keeps the cursor of query_target_messages unchanged', async () => {
      const first = await call('query_target_messages', { chatId: 'g1', limit: 1 });
      if (first.toolName !== 'query_target_messages' || !first.nextCursor) throw new Error('expected a next page');
      const second = await call('query_target_messages', { chatId: 'g1', limit: 1, cursor: first.nextCursor });
      if (second.toolName !== 'query_target_messages') throw new Error('unexpected tool');
      expect(second.messages.map((row) => row.messageId)).toEqual(['a2']);
    });
  });
});
