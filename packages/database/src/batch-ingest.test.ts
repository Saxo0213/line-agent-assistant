import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { LineWorkerEvent } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { AgentRepository } from './agent-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Batch = Extract<LineWorkerEvent, { type: 'batch' }>;
const cursor = (revision: string) => ({ version: 1 as const, revision, globalRev: '0', individualRev: '0' });
const batch = (messageId: string, revision: string): Batch => ({
  type: 'batch', accountId: 'batch-account', workerInstanceId: 'worker-1', controlEpoch: 1,
  batchId: `batch-${revision}`, cursorBefore: cursor(String(Number(revision) - 1)), cursorAfter: cursor(revision),
  envelopes: [{ eventId: `event-${messageId}`, accountId: 'batch-account', chatType: 'direct', chatId: 'chat',
    senderId: 'person', messageId, kind: 'text', text: 'do work', mentionIds: [], mentionRanges: [],
    replyToMessageId: null, ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z',
    attachments: [{ id: 'external-1', kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 12 }], raw: {} }],
});
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'do work', workspacePath: 'C:\\trusted' };

database('atomic batch ingestion on PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('batch-account');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'batch-account'");
    await accounts.activateControl('batch-account', 1);
    await accounts.bindWorker({ accountId: 'batch-account', workerInstanceId: 'worker-1', controlEpoch: 1 });
  });
  afterAll(async () => { await close?.(); });

  it('commits messages, attachments, jobs and cursor together and replays idempotently', async () => {
    const input = batch('m1', '1');
    const first = await repo.ingestBatchAndRoute(input, [route]);
    expect(first).toMatchObject({ inserted: 1, duplicate: 0, jobIds: [expect.any(String)] });
    await repo.ingestBatchAndRoute(input, [route]);
    const rows = await pool.query(`SELECT (SELECT count(*) FROM messages) messages,
      (SELECT count(*) FROM attachments) attachments, (SELECT count(*) FROM agent_jobs) jobs,
      (SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live') cursor`);
    expect(rows.rows[0]).toEqual({ messages: '1', attachments: '1', jobs: '1', cursor: JSON.stringify(cursor('1')) });
    const job = await pool.query('SELECT source_type, source_message_id, creation_epoch FROM agent_jobs');
    expect(job.rows[0]).toEqual({ source_type: 'line', source_message_id: 'm1', creation_epoch: '1' });
    const decision = await pool.query("SELECT action, provider FROM message_routes WHERE account_id = 'batch-account' AND message_id = 'm1'");
    expect(decision.rows[0]).toEqual({ action: 'prompt', provider: 'codex' });
  });

  it('persists a cursor-only checkpoint', async () => {
    await repo.ingestBatchAndRoute({ ...batch('unused', '2'), envelopes: [] }, []);
    const row = await pool.query("SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live'");
    expect(row.rows[0].cursor).toBe(JSON.stringify(cursor('2')));
    expect(await repo.getLiveCursor('batch-account')).toEqual(cursor('2'));
  });

  it('rolls back the complete batch when one envelope is invalid', async () => {
    const input = batch('m-bad', '3');
    input.envelopes.push({ ...input.envelopes[0]!, messageId: 'm-bad-2', attachments: [{ id: 'bad', kind: 'invalid' as 'image', name: null, mimeType: null, sizeBytes: null }] });
    await expect(repo.ingestBatchAndRoute(input, [route, route])).rejects.toThrow();
    const rows = await pool.query("SELECT (SELECT count(*) FROM messages WHERE message_id LIKE 'm-bad%') messages, (SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live') cursor");
    expect(rows.rows[0]).toEqual({ messages: '0', cursor: JSON.stringify(cursor('2')) });
  });
  it('never regresses an independent composite cursor component on replay', async () => {
    await repo.ingestBatchAndRoute({ ...batch('unused', '4'), envelopes: [], cursorAfter: { ...cursor('4'), globalRev: '9' } }, []);
    await repo.ingestBatchAndRoute({ ...batch('unused', '4'), envelopes: [], cursorAfter: { ...cursor('4'), globalRev: '3', individualRev: '2' } }, []);
    const row = await pool.query("SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live'");
    expect(JSON.parse(row.rows[0].cursor)).toEqual({ version: 1, revision: '4', globalRev: '9', individualRev: '2' });
  });
  it('claims same-batch jobs in envelope order even when timestamps tie and UUIDs sort backward', async () => {
    const input = batch('fifo-first', '5');
    input.envelopes[0]!.chatId = 'fifo-chat';
    input.envelopes.push({ ...input.envelopes[0]!, eventId: 'fifo-second-event', messageId: 'fifo-second' });
    await repo.ingestBatchAndRoute(input, [route, route]);
    await pool.query(`UPDATE agent_jobs SET created_at = '2026-10-15T00:00:00Z',
      job_id = CASE source_message_id WHEN 'fifo-first' THEN 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
        ELSE '00000000-0000-4000-8000-000000000000'::uuid END
      WHERE source_message_id IN ('fifo-first', 'fifo-second')`);
    const agents = new AgentRepository(pool);
    const key = { accountId: 'batch-account', chatType: 'direct' as const, chatId: 'fifo-chat' };
    const first = await agents.claimNext(key);
    expect(first?.sourceMessageId).toBe('fifo-first');
    await agents.cancelJob(first!.jobId);
    expect((await agents.claimNext(key))?.sourceMessageId).toBe('fifo-second');
  });
  it('archives a still-bound MONITOR_ONLY worker batch after another account advances the global control epoch', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('monitor-account');
    await accounts.revokeControl(1);
    await accounts.bindWorker({ accountId: 'monitor-account', workerInstanceId: 'worker-1', controlEpoch: 1 });
    const input = { ...batch('monitor-message', '6'), accountId: 'monitor-account',
      envelopes: [{ ...batch('monitor-message', '6').envelopes[0]!, accountId: 'monitor-account' }] };
    expect(await repo.ingestBatchAndRoute(input, [route])).toMatchObject({ inserted: 1, jobIds: [] });
    await expect(repo.ingestBatchAndRoute({ ...input, workerInstanceId: 'forged-worker', batchId: 'forged' }, [route]))
      .rejects.toThrow('Stale batch control epoch');
    await expect(repo.ingestBatchAndRoute({ ...input, controlEpoch: 99, batchId: 'future' }, [route]))
      .rejects.toThrow('Stale batch control epoch');
  });
});
