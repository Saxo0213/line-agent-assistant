import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';
import { SAMPLE_FUN, SAMPLE_NICE, SAMPLE_PAID } from './native-reactions.fixtures.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const GROUP = `c${'7'.repeat(32)}`;
const OWN = `u${'0'.repeat(32)}`;
const NICE_REACTOR = 'u00000000000000000000000000000001';
const FUN_REACTOR = 'u00000000000000000000000000000002';
const PAID_REACTOR = 'u00000000000000000000000000000003';

database('timeline message reactions', () => {
  let pool: Pool; let close: (() => Promise<void>) | undefined; let repository: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new MessageRepository(pool);
    await new AccountRepository(pool).ensureAccount('rx-A');
    await pool.query("UPDATE line_accounts SET own_mid = $1 WHERE account_id = 'rx-A'", [OWN]);
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('rx-A','group',$1)", [GROUP]);
    const add = (id: string, minute: number, raw: unknown) => pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('rx-A',$1,$2,$3,'group','someone','text','t','live','2026-10-22T00:00:00Z'::timestamptz + ($4 || ' minutes')::interval,$5::jsonb)`,
      [id, `ev-rx-${id}`, GROUP, String(minute), JSON.stringify(raw)]);
    const row = (cell: unknown) => ({ native: { row: { columns: ['_id', '_reactionStatus'], cells: ['1', cell] } } });
    await add('1', 1, row(SAMPLE_NICE));
    await add('2', 2, row(SAMPLE_FUN));
    await add('3', 3, row(SAMPLE_PAID));
    await add('4', 4, {});
    await add('5', 5, row('{broken'));
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ('rx-A',$1,'Alpha')", [NICE_REACTOR]);
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id,display_name) VALUES ('rx-A','group',$1,$2,'Member Fun')", [GROUP, FUN_REACTOR]);
  });
  afterAll(async () => { await close?.(); });

  it('derives reactions with names resolved (contact, member, then mid suffix) and omits the field otherwise', async () => {
    const page = await repository.listMessages({ accountId: 'rx-A', chatType: 'group', chatId: GROUP }, null, 50);
    const by = Object.fromEntries(page.messages.map((message) => [message.messageId, message]));
    expect(by['1']!.reactions).toEqual([{ kind: 'NICE', count: 1, reactorIds: [NICE_REACTOR], reactorNames: ['Alpha'] }]);
    expect(by['2']!.reactions).toEqual([{ kind: 'FUN', count: 1, reactorIds: [FUN_REACTOR], reactorNames: ['Member Fun'] }]);
    expect(by['3']!.reactions).toEqual([{ kind: 'PAID', productId: '60ebfdc03cc24041bb139cf5', emojiId: '004', count: 1,
      reactorIds: [PAID_REACTOR], reactorNames: [`…${PAID_REACTOR.slice(-4)}`] }]);
    expect('reactions' in by['4']!).toBe(false);
    expect('reactions' in by['5']!).toBe(false);
  });

  it('issues one name query per page, not per message', async () => {
    const queries: string[] = [];
    const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => { queries.push(String(typeof args[0] === 'string' ? args[0] : '')); return original(...args); };
    try {
      await repository.listMessages({ accountId: 'rx-A', chatType: 'group', chatId: GROUP }, null, 50);
    } finally { (pool as unknown as { query: unknown }).query = original; }
    expect(queries.filter((sql) => sql.includes('unnest($4::text[])'))).toHaveLength(1);
  });
});
