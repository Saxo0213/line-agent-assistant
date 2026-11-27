import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ArchiveInboundEnvelope } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const accountId = 'square-account';
const chatId = `m${'1'.repeat(32)}`;
const otherId = `p${'2'.repeat(32)}`;
const selfId = `p${'3'.repeat(32)}`;
const envelope = (messageId: string, own = false): ArchiveInboundEnvelope => ({
  eventId: `square-event-${messageId}`, accountId, chatType: 'community', chatId, senderId: own ? selfId : otherId,
  ...(own ? {} : { senderName: 'Synthetic Member' }), messageId, kind: 'text', text: `text ${messageId}`,
  mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
  occurredAt: '2026-10-15T00:00:00.000Z', attachments: [],
  raw: { message: { id: messageId, text: `text ${messageId}` }, square: { eventType: own ? 'SEND_MESSAGE' : 'RECEIVE_MESSAGE', own } },
});

database('community batch ingestion on PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [accountId]);
    await accounts.activateControl(accountId, 1);
    await accounts.bindWorker({ accountId, workerInstanceId: 'worker-1', controlEpoch: 1 });
    await accounts.applyWorkerLogin({ accountId, workerInstanceId: 'worker-1', controlEpoch: 1 }, 'square-own-mid', 'Square account');
  });
  afterAll(async () => { await close?.(); });

  it('stores messages, title, member name and the token, counts only the others as unread, and replays without storing', async () => {
    expect(await repo.readSquareCursor(accountId)).toBeNull();
    const input = { accountId, batchId: 'sq-1', tokenBefore: null, tokenAfter: 'token-1',
      envelopes: [envelope('9001'), envelope('9002', true)], titles: [{ chatId, title: 'Synthetic Community' }] };
    expect(await repo.ingestSquareBatch(input)).toEqual({ status: 'stored', inserted: 2 });
    const cursor = await repo.readSquareCursor(accountId);
    expect(cursor).toMatchObject({ syncToken: 'token-1', lastBatchId: 'sq-1' });
    expect(cursor?.lastDigest).toMatch(/^[0-9a-f]{64}$/);
    const conversation = await pool.query('SELECT title,unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [accountId, 'community', chatId]);
    expect(conversation.rows[0]).toEqual({ title: 'Synthetic Community', unread_count: 1 });
    const names = await pool.query('SELECT member_id,display_name FROM conversation_members WHERE account_id=$1 AND chat_id=$2', [accountId, chatId]);
    expect(names.rows).toEqual([{ member_id: otherId, display_name: 'Synthetic Member' }]);
    expect((await pool.query('SELECT count(*)::int n FROM messages WHERE account_id=$1', [accountId])).rows[0]?.n).toBe(2);
    const own = await pool.query('SELECT raw->\'square\'->>\'own\' own FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, '9002']);
    expect(own.rows[0]?.own).toBe('true');
    // The Talk cursor and routes stay untouched.
    expect((await pool.query('SELECT count(*)::int n FROM sync_cursors WHERE account_id=$1', [accountId])).rows[0]?.n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM message_routes WHERE account_id=$1', [accountId])).rows[0]?.n).toBe(0);

    expect(await repo.ingestSquareBatch(input)).toEqual({ status: 'replay' });
    expect((await pool.query('SELECT count(*)::int n FROM messages WHERE account_id=$1', [accountId])).rows[0]?.n).toBe(2);
    expect((await pool.query('SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_id=$2', [accountId, chatId])).rows[0]?.unread_count).toBe(1);
  });

  it('fails closed for the same batch id with different content', async () => {
    const result = await repo.ingestSquareBatch({ accountId, batchId: 'sq-1', tokenBefore: null, tokenAfter: 'token-1',
      envelopes: [envelope('9003')], titles: [{ chatId, title: 'Synthetic Community' }] });
    expect(result).toEqual({ status: 'digest_conflict' });
    expect((await pool.query('SELECT count(*)::int n FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, '9003'])).rows[0]?.n).toBe(0);
    expect((await repo.readSquareCursor(accountId))?.syncToken).toBe('token-1');
  });

  it('rejects a batch whose token before does not match the stored token and stores nothing', async () => {
    for (const tokenBefore of [null, 'token-wrong']) {
      const result = await repo.ingestSquareBatch({ accountId, batchId: `sq-bad-${tokenBefore ?? 'null'}`, tokenBefore, tokenAfter: 'token-9',
        envelopes: [envelope('9004')] });
      expect(result).toEqual({ status: 'token_conflict' });
    }
    expect((await pool.query('SELECT count(*)::int n FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, '9004'])).rows[0]?.n).toBe(0);
    expect((await repo.readSquareCursor(accountId))?.syncToken).toBe('token-1');
  });

  it('moves the token with the next batch in order', async () => {
    expect(await repo.ingestSquareBatch({ accountId, batchId: 'sq-2', tokenBefore: 'token-1', tokenAfter: 'token-2',
      envelopes: [envelope('9005')] })).toEqual({ status: 'stored', inserted: 1 });
    expect(await repo.readSquareCursor(accountId)).toMatchObject({ syncToken: 'token-2', lastBatchId: 'sq-2' });
  });
});
