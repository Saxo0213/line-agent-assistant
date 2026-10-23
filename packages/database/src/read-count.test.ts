import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const GROUP = `c${'1'.repeat(32)}`;
const DIRECT = `u${'4'.repeat(32)}`;
const COMMUNITY = `m${'5'.repeat(32)}`;
const OWN = `u${'0'.repeat(32)}`;
const R1 = `u${'a'.repeat(32)}`;
const R2 = `u${'b'.repeat(32)}`;
const R3 = `u${'c'.repeat(32)}`;

database('timeline read count and reader list', () => {
  let pool: Pool; let close: (() => Promise<void>) | undefined; let repository: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('rc-A');
    await accounts.ensureAccount('rc-B');
    await pool.query("UPDATE line_accounts SET own_mid = $1 WHERE account_id = 'rc-A'", [OWN]);
    for (const [account, type, chat] of [['rc-A', 'group', GROUP], ['rc-A', 'direct', DIRECT], ['rc-A', 'community', COMMUNITY], ['rc-B', 'group', GROUP]]) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [account, type, chat]);
    }
    const add = (account: string, type: string, chat: string, id: string, sender: string, minute: number) => pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,'text','t','live', '2026-10-22T00:00:00Z'::timestamptz + ($7 || ' minutes')::interval,'{}'::jsonb)`,
      [account, id, `ev-${account}-${id}`, chat, type, sender, String(minute)]);
    await add('rc-A', 'group', GROUP, '100', OWN, 1);
    await add('rc-A', 'group', GROUP, '200', OWN, 2);
    await add('rc-A', 'group', GROUP, '300', OWN, 3);
    await add('rc-A', 'group', GROUP, '250', R3, 4);
    await add('rc-A', 'group', GROUP, 'abc', OWN, 5);
    await add('rc-A', 'direct', DIRECT, '50', OWN, 1);
    await add('rc-A', 'community', COMMUNITY, '60', OWN, 1);
    await add('rc-B', 'group', GROUP, '100', 'someone', 1);
    const read = (account: string, type: string, chat: string, reader: string, id: string, at: string) => pool.query(
      'INSERT INTO message_read_positions (account_id, chat_type, chat_id, reader_mid, last_read_message_id, last_read_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [account, type, chat, reader, id, at]);
    await read('rc-A', 'group', GROUP, R1, '200', '2026-10-22T01:00:00Z');
    await read('rc-A', 'group', GROUP, R2, '150', '2026-10-22T02:00:00Z');
    await read('rc-A', 'group', GROUP, R3, 'not-numeric', '2026-10-22T03:00:00Z');
    await read('rc-A', 'direct', DIRECT, DIRECT, '50', '2026-10-22T01:00:00Z');
    await read('rc-A', 'community', COMMUNITY, R1, '60', '2026-10-22T01:00:00Z');
    await read('rc-B', 'group', GROUP, R1, '999', '2026-10-22T01:00:00Z');
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('rc-A',$1,'Alpha','Nick'),('rc-A',$2,'Bravo',NULL)", [R1, R2]);
  });
  afterAll(async () => { await close?.(); });

  const counts = async (type: 'group' | 'direct' | 'community', chat: string, account = 'rc-A') => {
    const page = await repository.listMessages({ accountId: account, chatType: type, chatId: chat }, null, 50);
    return Object.fromEntries(page.messages.map((message) => [message.messageId, message.readCount]));
  };

  it('counts readers at equal, greater and smaller boundaries and skips other senders and bad ids', async () => {
    expect(await counts('group', GROUP)).toEqual({ '100': 2, '200': 1, '300': undefined, '250': undefined, abc: undefined });
  });
  it('shows a direct own message count and nothing for community chats', async () => {
    expect(await counts('direct', DIRECT)).toEqual({ '50': 1 });
    expect(await counts('community', COMMUNITY)).toEqual({ '60': undefined });
  });
  it('isolates accounts sharing a chat id', async () => {
    expect(await counts('group', GROUP, 'rc-B')).toEqual({ '100': undefined });
  });
  it('lists readers newest first with the member name precedence and respects the limit', async () => {
    const key = { accountId: 'rc-A', chatType: 'group' as const, chatId: GROUP };
    expect(await repository.listMessageReaders(key, '100')).toEqual([
      { mid: R2, name: 'Bravo', readAt: '2026-10-22T02:00:00.000Z' },
      { mid: R1, name: 'Nick', readAt: '2026-10-22T01:00:00.000Z' }]);
    expect((await repository.listMessageReaders(key, '200')).map((reader) => reader.mid)).toEqual([R1]);
    expect(await repository.listMessageReaders(key, '100', { limit: 1 })).toHaveLength(1);
  });
  it('returns no readers for other senders, bad ids, unsupported chats and other accounts', async () => {
    const key = { accountId: 'rc-A', chatType: 'group' as const, chatId: GROUP };
    expect(await repository.listMessageReaders(key, '250')).toEqual([]);
    expect(await repository.listMessageReaders(key, 'abc')).toEqual([]);
    expect(await repository.listMessageReaders(key, '300')).toEqual([]);
    expect(await repository.listMessageReaders({ accountId: 'rc-A', chatType: 'community', chatId: COMMUNITY }, '60')).toEqual([]);
    expect(await repository.listMessageReaders({ ...key, accountId: 'rc-B' }, '100')).toEqual([]);
  });
});
