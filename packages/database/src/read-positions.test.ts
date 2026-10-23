import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { InboundEnvelope, LineWorkerEvent } from '@line-agent/contracts';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Batch = Extract<LineWorkerEvent, { type: 'batch' }>;
const GROUP = `c${'1'.repeat(32)}`;
const ROOM = `r${'3'.repeat(32)}`;
const DIRECT = `u${'4'.repeat(32)}`;
const R1 = `u${'a'.repeat(32)}`;
const R2 = `u${'b'.repeat(32)}`;
const READ_AT = '2026-10-22T01:02:03.000Z';

let sequence = 0;
function envelope(accountId: string, chatType: 'group' | 'room' | 'direct', chatId: string): InboundEnvelope {
  const id = ++sequence;
  return { eventId: `rp-event-${id}-${accountId}`, accountId, chatId, chatType, senderId: 'sender', messageId: `rp-${id}-${accountId}`,
    kind: 'text', text: 'hello', mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: `cursor-${id}` }, occurredAt: '2026-10-22T00:00:00.000Z', attachments: [], raw: {} };
}
const receipt = (chatId: string, readerMid: string, messageId: string) => ({ chatId, readerMid, messageId, readAt: READ_AT });

database('read positions', () => {
  let pool: Pool; let close: (() => Promise<void>) | undefined; let repository: MessageRepository;
  let epoch = 0; let instance = '';
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('rp-A');
    await accounts.ensureAccount('rp-B');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'rp-A'");
    await accounts.activateControl('rp-A', (await accounts.getControlState()).controlEpoch);
    epoch = Number((await pool.query('SELECT control_epoch FROM account_control WHERE singleton=true')).rows[0].control_epoch);
    instance = `rp-worker-${randomUUID()}`;
    await accounts.bindWorker({ accountId: 'rp-A', workerInstanceId: instance, controlEpoch: epoch });
  });
  afterAll(async () => { await close?.(); });

  function batch(envelopes: InboundEnvelope[], readReceipts?: ReturnType<typeof receipt>[], accountId = 'rp-A'): Batch {
    return { type: 'batch', accountId, workerInstanceId: instance, controlEpoch: epoch, batchId: `batch-${randomUUID()}`,
      cursorBefore: { version: 1, revision: '1', globalRev: '1', individualRev: '1' },
      cursorAfter: { version: 1, revision: '2', globalRev: '2', individualRev: '2' },
      envelopes, ...(readReceipts ? { readReceipts } : {}) } as Batch;
  }
  const ingest = (input: Batch) => repository.ingestBatchAndRoute(input, input.envelopes.map(() => ({ eligible: false as const })));
  const key = (chatType: 'group' | 'room' | 'direct', chatId: string, accountId = 'rp-A') => ({ accountId, chatType, chatId });

  it('inserts, advances, and never regresses a read position', async () => {
    await ingest(batch([envelope('rp-A', 'group', GROUP)]));
    const first = await ingest(batch([], [receipt(GROUP, R1, '100')]));
    expect(first.readPositionsChanged).toBe(1);
    expect(first.readPositionChanges).toEqual([{ key: key('group', GROUP), messageId: '100' }]);
    expect(await repository.readPositionsForConversation(key('group', GROUP))).toEqual([
      { readerMid: R1, lastReadMessageId: '100', lastReadAt: READ_AT }]);
    expect((await ingest(batch([], [receipt(GROUP, R1, '99')]))).readPositionsChanged).toBe(0);
    expect((await ingest(batch([], [receipt(GROUP, R1, '100')]))).readPositionsChanged).toBe(0);
    // 9 < 100 numerically although it sorts after "100" as text.
    expect((await ingest(batch([], [receipt(GROUP, R1, '9')]))).readPositionsChanged).toBe(0);
    expect((await ingest(batch([], [receipt(GROUP, R1, '1000')]))).readPositionsChanged).toBe(1);
    expect((await repository.readPositionsForConversation(key('group', GROUP)))[0]!.lastReadMessageId).toBe('1000');
  });

  it('drops receipts for a conversation that does not exist for the account', async () => {
    const missing = `c${'9'.repeat(32)}`;
    const result = await ingest(batch([], [receipt(missing, R1, '5')]));
    expect(result.readPositionsChanged).toBe(0);
    expect(await repository.readPositionsForConversation(key('group', missing))).toEqual([]);
    const rows = await pool.query("SELECT count(*) FROM message_read_positions WHERE chat_id = $1", [missing]);
    expect(rows.rows[0].count).toBe('0');
  });

  it('isolates accounts that share a chat id', async () => {
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('rp-B','group',$1) ON CONFLICT DO NOTHING", [GROUP]);
    await ingest(batch([], [receipt(GROUP, R2, '7')]));
    expect(await repository.readPositionsForConversation(key('group', GROUP, 'rp-B'))).toEqual([]);
    expect((await repository.readPositionsForConversation(key('group', GROUP))).map((row) => row.readerMid).sort()).toEqual([R1, R2]);
  });

  it('is idempotent on replay and counts one change per conversation across a mixed batch', async () => {
    await ingest(batch([envelope('rp-A', 'room', ROOM), envelope('rp-A', 'direct', DIRECT)]));
    const input = batch([], [receipt(ROOM, R1, '20'), receipt(ROOM, R2, '21'), receipt(DIRECT, DIRECT, '30'), receipt(ROOM, R1, '25')]);
    const first = await ingest(input);
    expect(first.readPositionsChanged).toBe(3);
    expect(first.readPositionChanges).toHaveLength(2);
    expect(first.readPositionChanges).toEqual(expect.arrayContaining([
      { key: key('room', ROOM), messageId: '25' }, { key: key('direct', DIRECT), messageId: '30' }]));
    const replay = await ingest(input);
    expect(replay.readPositionsChanged).toBe(0);
    expect(replay.readPositionChanges).toEqual([]);
    expect((await repository.readPositionsForConversation(key('room', ROOM), { limit: 1 }))).toHaveLength(1);
  });

  it('rejects an invalid receipt batch and rolls back the whole transaction', async () => {
    const bad = batch([envelope('rp-A', 'group', GROUP)], [{ ...receipt(GROUP, R1, '5'), messageId: 'x' }]);
    await expect(ingest(bad)).rejects.toThrow();
    const rows = await pool.query('SELECT count(*) FROM messages WHERE message_id = $1', [bad.envelopes[0]!.messageId]);
    expect(rows.rows[0].count).toBe('0');
  });
});
