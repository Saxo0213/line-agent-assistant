import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { MessageRepository, type McpTokenRepository } from '../../../../../packages/database/src/index.js';
import { McpService } from './mcp-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('MCP read tools merge the Agent account lineage', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let messages: MessageRepository;
  let service: McpService;

  const message = (accountId: string, chatId: string, messageId: string, text: string, at: string) => pool.query(
    `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
     VALUES ($1,$2,$3,'group',$4,'friend','text',$5,'history',$6,'{}')`, [accountId, messageId, `ev-${accountId}-${messageId}`, chatId, text, at]);

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    messages = new MessageRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,product_role) VALUES ('agent-new','New','mid-new','AGENT')");
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,role_revision,mode,status,connection_mode) VALUES ('agent-old','Old','mid-old',1,'MONITOR_ONLY','disconnected','OFFLINE')");
    await pool.query(`INSERT INTO agent_account_lineage(account_id,sequence,became_agent_at,retired_at)
      VALUES ('agent-old',1,now() - interval '2 days',now() - interval '1 day'),('agent-new',2,now() - interval '1 day',NULL)`);
    for (const [accountId, chatId, title] of [['agent-old', 'shared', 'Old title'], ['agent-new', 'shared', 'New title'], ['agent-old', 'old-only', 'Old only']] as const) {
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,$3)", [accountId, chatId, title]);
    }
    await message('agent-old', 'shared', 'm1', 'from old account', '2026-10-01T00:00:00Z');
    await message('agent-new', 'shared', 'm2', 'from new account', '2026-10-02T00:00:00Z');
    await message('agent-old', 'shared', 'm3', 'seen by both', '2026-10-03T00:00:00Z');
    await message('agent-new', 'shared', 'm3', 'seen by both', '2026-10-03T00:00:00Z');
    const tokens = {
      executeForInternalAgent: async (input: { execute: (scope: { client: Pool; authorizedAccountIds: string[] }) => Promise<{ data: unknown }> }) =>
        (await input.execute({ client: pool, authorizedAccountIds: ['agent-new'] })).data,
    } as unknown as McpTokenRepository;
    service = new McpService({ pool, tokens, messages });
  });
  afterAll(async () => { await service.shutdown(); await close?.(); });

  it('lists one conversation per (chatType, chatId) with the current account key and title', async () => {
    const output = await service.callInternalTool({ name: 'list_targets', arguments: {} } as never, { sourceType: 'ui' });
    if (output.toolName !== 'list_targets') throw new Error('unexpected tool');
    const targets = output.targets.map((target) => [target.accountId, target.chatId, target.conversationTitle]).sort();
    expect(targets).toEqual([['agent-new', 'shared', 'New title'], ['agent-old', 'old-only', 'Old only']]);
  });

  it('reads the same chat across the lineage in time order without duplicate message ids', async () => {
    const output = await service.callInternalTool({ name: 'query_target_messages', arguments: { chatType: 'group', chatId: 'shared' } } as never, { sourceType: 'ui' });
    if (output.toolName !== 'query_target_messages') throw new Error('unexpected tool');
    expect(output.messages.map((row) => [row.messageId, row.accountId])).toEqual([['m3', 'agent-new'], ['m2', 'agent-new'], ['m1', 'agent-old']]);
    const timed = await service.callInternalTool({ name: 'query_target_messages_by_time', arguments: {
      chatType: 'group', chatId: 'shared', from: '2026-10-01', to: '2026-10-02' } } as never, { sourceType: 'ui' });
    if (timed.toolName !== 'query_target_messages_by_time') throw new Error('unexpected tool');
    expect(timed.messages.map((row) => row.messageId)).toEqual(['m1', 'm2']);
    expect(timed.hasMore).toBe(false);
    expect(timed.nextCursor).toBeNull();
  });

  it('pages a busy chat in 200-message segments without gaps or duplicates, even with equal timestamps', async () => {
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ('agent-new','group','busy','Busy')");
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
      SELECT 'agent-new', 'b' || lpad(n::text, 4, '0'), 'ev-busy-' || n, 'group', 'busy', 'friend', 'text', 'msg ' || n, 'history',
             '2026-10-10T00:00:00Z'::timestamptz + (n / 3) * interval '1 second', '{}'::jsonb
      FROM generate_series(1, 450) AS n`);
    const ids = (await pool.query("SELECT message_id FROM messages WHERE chat_id='busy' ORDER BY occurred_at ASC, message_id ASC")).rows.map((row) => row.message_id as string);
    expect(ids).toHaveLength(450);
    const byTime = async (extra: Record<string, unknown>) => {
      const out = await service.callInternalTool({ name: 'query_target_messages_by_time', arguments: {
        chatType: 'group', chatId: 'busy', from: '2026-10-10', to: '2026-10-11', ...extra } } as never, { sourceType: 'ui' });
      if (out.toolName !== 'query_target_messages_by_time') throw new Error('unexpected tool');
      return out;
    };
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const out = await byTime({ limit: 500, ...(cursor ? { cursor } : {}) });
      pages += 1;
      sizes.push(out.messages.length);
      expect(out.page).toEqual({ returned: out.messages.length, limit: 200, hasMore: out.hasMore, nextCursor: out.nextCursor });
      seen.push(...out.messages.map((row) => row.messageId));
      if (!out.hasMore) { expect(out.nextCursor).toBeNull(); break; }
      expect(out.nextCursor).not.toBeNull();
      cursor = out.nextCursor as string;
    }
    expect(pages).toBe(3);
    expect(sizes).toEqual([200, 200, 50]);
    expect(seen).toEqual(ids);

    const firstDescending = await service.callInternalTool({ name: 'query_target_messages', arguments: { chatType: 'group', chatId: 'busy', limit: 500 } } as never, { sourceType: 'ui' });
    if (firstDescending.toolName !== 'query_target_messages') throw new Error('unexpected tool');
    const descending: string[] = [...firstDescending.messages.map((row) => row.messageId)];
    let next = firstDescending.nextCursor;
    while (next) {
      const out = await service.callInternalTool({ name: 'query_target_messages', arguments: { chatType: 'group', chatId: 'busy', cursor: next, limit: 200 } } as never, { sourceType: 'ui' });
      if (out.toolName !== 'query_target_messages') throw new Error('unexpected tool');
      descending.push(...out.messages.map((row) => row.messageId));
      next = out.nextCursor;
    }
    expect(descending).toEqual([...ids].reverse());
  });

  it('rejects tampered cursors and cursors issued for a different query', async () => {
    const first = await service.callInternalTool({ name: 'query_target_messages_by_time', arguments: {
      chatType: 'group', chatId: 'busy', from: '2026-10-10', to: '2026-10-11', limit: 10 } } as never, { sourceType: 'ui' });
    if (first.toolName !== 'query_target_messages_by_time' || !first.nextCursor) throw new Error('expected a next page');
    const run = (name: string, args: Record<string, unknown>) => service.callInternalTool({ name, arguments: args } as never, { sourceType: 'ui' });
    const base = { chatType: 'group', chatId: 'busy', from: '2026-10-10', to: '2026-10-11' };
    await expect(run('query_target_messages_by_time', { ...base, cursor: first.nextCursor + 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run('query_target_messages_by_time', { ...base, cursor: 'garbage' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run('query_target_messages_by_time', { ...base, to: '2026-10-12', cursor: first.nextCursor })).rejects.toThrow(/different query/);
    await expect(run('query_target_messages_by_time', { ...base, chatId: 'shared', cursor: first.nextCursor })).rejects.toThrow(/different query/);
    await expect(run('query_target_messages', { chatType: 'group', chatId: 'busy', cursor: first.nextCursor })).rejects.toThrow(/different query/);
    await pool.query("DELETE FROM messages WHERE chat_id='busy'");
    await pool.query("DELETE FROM conversations WHERE chat_id='busy'");
  });

  it('keeps write-side targets on the current Agent account and never selects a retired account for sending', async () => {
    expect((await messages.listSendTargets({ accountId: 'agent-new' })).map((target) => target.chatId)).toEqual(['shared']);
    expect(await messages.getSendTarget('agent-new', 'group', 'old-only')).toBeNull();
    await pool.query("UPDATE line_accounts SET connection_mode='SYSTEM_LOGIN' WHERE account_id IN ('agent-new','agent-old')");
    expect(await messages.findAgentSendAccount()).toBe('agent-new');
    expect((await pool.query("SELECT product_role FROM line_accounts WHERE account_id='agent-old'")).rows[0].product_role).toBeNull();
  });
});
