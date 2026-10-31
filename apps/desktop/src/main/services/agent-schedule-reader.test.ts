import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { McpMessageRecord, McpToolInputUnion, McpToolOutputUnion } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AgentRepository, McpTokenRepository, MessageRepository } from '../../../../../packages/database/src/index.js';
import { McpService } from './mcp-service.js';
import { createScheduleMessageReader } from './agent-schedule-reader.js';
import { NEW_MESSAGES_RUN_MESSAGE_CAP } from './agent-schedule-rules.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const FROM = new Date('2026-10-30T00:00:00Z');
const TO = new Date('2026-10-30T12:00:00Z');

const record = (n: number, chatId = 'g1'): McpMessageRecord => ({
  accountId: 'acc', accountDisplayName: null, chatType: 'group', chatId, conversationTitle: chatId, messageId: `m${chatId}-${n}`, senderId: 'u', senderName: 'U',
  direction: 'inbound', kind: 'text', text: `t${n}`, recalled: false, occurredAt: '2026-10-30T01:00:00.000Z', attachments: [],
});
type Timed = Extract<McpToolOutputUnion, { toolName: 'query_target_messages_by_time' }>;
const page = (messages: McpMessageRecord[], next: string | null): Timed => ({ toolName: 'query_target_messages_by_time', messages, hasMore: next !== null, nextCursor: next,
  page: { returned: messages.length, limit: 200, hasMore: next !== null, nextCursor: next }, from: FROM.toISOString(), to: TO.toISOString() });
const argsOf = (call: unknown) => (call as [McpToolInputUnion])[0];

describe('createScheduleMessageReader (fake tool)', () => {
  it('queries the whole window with no selector, limit 200, and pages with the cursor until hasMore is false', async () => {
    const tool = vi.fn()
      .mockResolvedValueOnce(page([record(1), record(2)], 'c1'))
      .mockResolvedValueOnce(page([record(3)], 'c2'))
      .mockResolvedValueOnce(page([record(4)], null));
    const result = await createScheduleMessageReader(tool)({ from: FROM, to: TO, targets: [] });
    expect(result.messages.map((message) => message.text)).toEqual(['t1', 't2', 't3', 't4']);
    expect(result.incomplete).toBe(false);
    expect(tool).toHaveBeenCalledTimes(3);
    expect(argsOf(tool.mock.calls[0])).toEqual({ name: 'query_target_messages_by_time', arguments: { from: FROM.toISOString(), to: TO.toISOString(), limit: 200 } });
    expect(argsOf(tool.mock.calls[1]).arguments).toEqual({ from: FROM.toISOString(), to: TO.toISOString(), limit: 200, cursor: 'c1' });
    expect(argsOf(tool.mock.calls[2]).arguments).toMatchObject({ cursor: 'c2' });
  });

  it('reads each target by accountId, chatType and chatId and combines the results', async () => {
    const tool = vi.fn(async (input: McpToolInputUnion) => {
      const chatId = (input.arguments as { chatId?: string }).chatId ?? '';
      return page([record(1, chatId)], null);
    });
    const result = await createScheduleMessageReader(tool)({ from: FROM, to: TO, targets: [
      { accountId: 'acc', chatType: 'group', chatId: 'g1', title: 'One' }, { accountId: 'acc2', chatType: 'direct', chatId: 'd1', title: 'Two' }] });
    expect(result.messages.map((message) => message.chatId)).toEqual(['g1', 'd1']);
    expect(tool.mock.calls.map((call) => call[0].arguments)).toEqual([
      { from: FROM.toISOString(), to: TO.toISOString(), limit: 200, accountId: 'acc', chatType: 'group', chatId: 'g1' },
      { from: FROM.toISOString(), to: TO.toISOString(), limit: 200, accountId: 'acc2', chatType: 'direct', chatId: 'd1' },
    ]);
  });

  it('stops at 10000 messages and reports the result as incomplete', async () => {
    expect(NEW_MESSAGES_RUN_MESSAGE_CAP).toBe(10_000);
    let served = 0;
    const tool = vi.fn(async () => {
      const messages = Array.from({ length: 200 }, (_, i) => record(served + i));
      served += 200;
      return page(messages, 'next');
    });
    const result = await createScheduleMessageReader(tool)({ from: FROM, to: TO, targets: [] });
    expect(result.messages).toHaveLength(10_000);
    expect(result.incomplete).toBe(true);
    expect(tool).toHaveBeenCalledTimes(50);
  });

  it('trims a page that crosses the cap, and is complete when the cap is hit exactly with no more messages', async () => {
    let calls = 0;
    const crossing = vi.fn(async () => { const n = calls++; return page(Array.from({ length: 200 }, (_, i) => record(n * 200 + i)), n >= 49 ? null : 'next'); });
    // 49 pages of 200 = 9800, then a page of 200 ends exactly at 10000 with hasMore false.
    const exact = await createScheduleMessageReader(crossing)({ from: FROM, to: TO, targets: [] });
    expect(exact.messages).toHaveLength(10_000);
    expect(exact.incomplete).toBe(false);
    // Two targets: the second one adds a message after the cap.
    const targets = [{ accountId: 'acc', chatType: 'group' as const, chatId: 'a', title: '' }, { accountId: 'acc', chatType: 'group' as const, chatId: 'b', title: '' }];
    let first = 0;
    const two = vi.fn(async (input: McpToolInputUnion) => {
      if ((input.arguments as { chatId?: string }).chatId !== 'a') return page([record(1, 'b')], null);
      const n = first++;
      return page(Array.from({ length: 200 }, (_, i) => record(n * 200 + i, 'a')), n >= 49 ? null : 'next');
    });
    const over = await createScheduleMessageReader(two)({ from: FROM, to: TO, targets });
    expect(over.messages).toHaveLength(10_000);
    expect(over.incomplete).toBe(true);
    // A second target with no message does not make the result incomplete.
    let again = 0;
    const empty = vi.fn(async (input: McpToolInputUnion) => {
      if ((input.arguments as { chatId?: string }).chatId !== 'a') return page([], null);
      const n = again++;
      return page(Array.from({ length: 200 }, (_, i) => record(n * 200 + i, 'a')), n >= 49 ? null : 'next');
    });
    expect((await createScheduleMessageReader(empty)({ from: FROM, to: TO, targets })).incomplete).toBe(false);
  });

  it('throws the real tool error and rejects an unexpected output', async () => {
    const failure = Object.assign(new Error('Requested LINE account is unavailable'), { code: 'SCOPE_DENIED' });
    await expect(createScheduleMessageReader(async () => { throw failure; })({ from: FROM, to: TO, targets: [] })).rejects.toBe(failure);
    await expect(createScheduleMessageReader(async () => ({ toolName: 'list_targets', targets: [] }))({ from: FROM, to: TO, targets: [] })).rejects.toThrow('Unexpected MCP output');
  });
});

database('the schedule read path through McpService with a real database', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let service: McpService;
  let read: ReturnType<typeof createScheduleMessageReader>;
  const AGENT = 'acc-agent';
  const PAUSED = 'acc-paused';

  const insert = (account: string, chatId: string, id: string, text: string, at: string, sender = 'user-a') => pool.query(
    `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
     VALUES ($1,$2,$3,'group',$4,$5,'text',$6,'live',$7,'{}')`, [account, id, `ev-${id}`, chatId, sender, text, at]);
  // The audit table is append-only: each test reads only the rows written after its start mark.
  let mark = 0;
  const markAudit = async () => { mark = Number((await pool.query<{ id: string }>('SELECT COALESCE(max(audit_id), 0) AS id FROM mcp_agent_audit')).rows[0]!.id); };
  const audit = async () => (await pool.query<{ principal_id: string; tool_name: string; action: string; disposition: string; initiator: string; result_count: number | null }>(
    'SELECT principal_id, tool_name, action, disposition, initiator, result_count FROM mcp_agent_audit WHERE audit_id > $1 ORDER BY audit_id', [mark])).rows;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    const accounts = new AccountRepository(pool);
    for (const account of [AGENT, PAUSED]) {
      await accounts.ensureAccount(account);
      await pool.query("UPDATE line_accounts SET mode = $2 WHERE account_id = $1", [account, account === PAUSED ? 'PAUSED' : 'ACTIVE_CONTROL']);
    }
    for (const [account, chatId] of [[AGENT, 'g1'], [AGENT, 'g2'], [AGENT, 'many'], [PAUSED, 'gp']] as const) {
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,$3)", [account, chatId, `title-${chatId}`]);
    }
    await insert(AGENT, 'g1', 'a1', 'hello g1', '2026-10-30T01:00:00Z');
    await insert(AGENT, 'g1', 'a2', 'key sk-abcdefgh12345678 and more', '2026-10-30T01:05:00Z');
    await insert(AGENT, 'g1', 'old', 'before the window', '2026-10-29T01:00:00Z');
    await insert(AGENT, 'g2', 'b1', 'hello g2', '2026-10-30T02:00:00Z');
    await insert(PAUSED, 'gp', 'p1', 'paused account', '2026-10-30T02:00:00Z');
    for (let i = 0; i < 250; i++) await insert(AGENT, 'many', `x${i}`, `bulk ${i}`, new Date(Date.UTC(2026, 9, 30, 3, 0, i)).toISOString());
    await new AgentRepository(pool).enqueueUiJob({ provider: 'claude', requestId: 'ui-room-1', prompt: 'AGENT ROOM PRIVATE PROMPT', workspacePath: 'C:\\work' });
    service = new McpService({ pool, tokens: new McpTokenRepository(pool), messages: new MessageRepository(pool) });
    read = createScheduleMessageReader((tool) => service.callInternalTool(tool, { sourceType: 'schedule' }));
  });
  afterAll(async () => { await service.shutdown(); await close?.(); });

  it('reads every readable chat of the window with the scope of the schedule principal and writes one audit row per page', async () => {
    await markAudit();
    const result = await read({ from: FROM, to: TO, targets: [] });
    const ids = result.messages.map((message) => (message as unknown as McpMessageRecord).messageId);
    expect(result.incomplete).toBe(false);
    expect(ids).toContain('a1');
    expect(ids).toContain('b1');
    expect(ids).not.toContain('old');
    // A paused account is out of scope, as it is for a scheduled Agent run.
    expect(ids).not.toContain('p1');
    expect(result.messages).toHaveLength(2 + 1 + 250);
    expect(result.messages.filter((message) => message.chatId === 'many')).toHaveLength(250);
    // 253 messages are two pages of at most 200.
    const rows = await audit();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ principal_id: 'internal:schedule', tool_name: 'query_target_messages_by_time', action: 'TOOL_CALLED', disposition: 'ALLOWED', initiator: 'internal_agent' });
    expect(rows.map((row) => row.result_count)).toEqual([200, 53]);
    expect(rows.some((row) => row.principal_id === 'internal:ui')).toBe(false);
  });

  it('redacts secrets in the text exactly as the Agent tool does', async () => {
    const result = await read({ from: FROM, to: TO, targets: [{ accountId: AGENT, chatType: 'group', chatId: 'g1', title: '' }] });
    expect(result.messages.map((message) => message.text)).toEqual(['hello g1', 'key [REDACTED] and more']);
    expect(JSON.stringify(result.messages)).not.toContain('sk-abcdefgh');
  });

  it('reads only the target chats when targets are given and audits the same principal', async () => {
    await markAudit();
    const result = await read({ from: FROM, to: TO, targets: [{ accountId: AGENT, chatType: 'group', chatId: 'g2', title: '' }] });
    expect(result.messages.map((message) => (message as unknown as McpMessageRecord).messageId)).toEqual(['b1']);
    expect(await audit()).toMatchObject([{ principal_id: 'internal:schedule', tool_name: 'query_target_messages_by_time', result_count: 1 }]);
  });

  it('does not include the local Agent room', async () => {
    const result = await read({ from: FROM, to: new Date(Date.now() + 86_400_000), targets: [] });
    expect(JSON.stringify(result.messages)).not.toContain('AGENT ROOM PRIVATE PROMPT');
    expect(result.messages.every((message) => message.accountId === AGENT)).toBe(true);
  });

  it('keeps the real error when a target account is unavailable and still audits the refusal', async () => {
    await markAudit();
    await expect(read({ from: FROM, to: TO, targets: [{ accountId: 'no-such-account', chatType: 'group', chatId: 'g1', title: '' }] }))
      .rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(await audit()).toMatchObject([{ principal_id: 'internal:schedule', action: 'AUTH_REJECTED', disposition: 'SCOPE_DENIED' }]);
  });
});
