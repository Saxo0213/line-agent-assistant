import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { LineWorkerEvent } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository, type IngestResult } from './message-repository.js';
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
    await accounts.applyWorkerLogin({ accountId: 'batch-account', workerInstanceId: 'worker-1', controlEpoch: 1 }, 'batch-own-mid', 'Batch account');
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

  it('keeps first-chat source persistence and Agent admission independent in both failure directions', async () => {
    const accountId = 'batch-account';

    const first = batch('independent-agent-fails', '1');
    first.accountId = accountId;
    first.envelopes[0]!.accountId = accountId;
    first.envelopes[0]!.chatId = 'first-chat';
    first.batchId = 'independent-agent-fails';
    first.cursorBefore = cursor('1');
    first.cursorAfter = cursor('2');
    await repo.prepareBatchConversations(first);
    await pool.query(`CREATE FUNCTION reject_independent_agent_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced Agent admission failure'; END $$`);
    await pool.query('CREATE TRIGGER reject_independent_agent_job BEFORE INSERT ON agent_jobs FOR EACH ROW EXECUTE FUNCTION reject_independent_agent_job()');
    const stored = await repo.ingestBatchSource(first);
    await expect(repo.admitLiveBatch(first, [route])).rejects.toThrow('forced Agent admission failure');
    await pool.query('DROP TRIGGER reject_independent_agent_job ON agent_jobs');
    await pool.query('DROP FUNCTION reject_independent_agent_job()');
    expect(stored.insertedMessageIds).toEqual(['independent-agent-fails']);
    expect((await pool.query(`SELECT count(*)::int count FROM messages WHERE account_id=$1 AND message_id=$2`,
      [accountId, 'independent-agent-fails'])).rows[0]?.count).toBe(1);
    expect((await repo.admitLiveBatch(first, [route])).jobStatuses).toHaveLength(1);
    expect((await repo.admitLiveBatch(first, [route])).jobStatuses).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int count FROM agent_jobs WHERE account_id=$1 AND source_message_id=$2`,
      [accountId, 'independent-agent-fails'])).rows[0]?.count).toBe(1);

    const second = batch('independent-storage-fails', '2');
    second.accountId = accountId;
    second.envelopes[0]!.accountId = accountId;
    second.envelopes[0]!.chatId = 'first-chat';
    second.batchId = 'independent-storage-fails';
    second.cursorBefore = cursor('2');
    second.cursorAfter = cursor('3');
    second.envelopes[0]!.attachments = [{ id: 'invalid', kind: 'invalid' as 'image', name: null, mimeType: null, sizeBytes: null }];
    await repo.prepareBatchConversations(second);
    await expect(repo.ingestBatchSource(second)).rejects.toThrow();
    expect((await repo.admitLiveBatch(second, [route])).jobStatuses).toHaveLength(1);
    expect((await repo.admitLiveBatch(second, [route])).jobStatuses).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int count FROM messages WHERE account_id=$1 AND message_id=$2`,
      [accountId, 'independent-storage-fails'])).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int count FROM agent_jobs WHERE account_id=$1 AND source_message_id=$2`,
      [accountId, 'independent-storage-fails'])).rows[0]?.count).toBe(1);
    await pool.query(`DELETE FROM external_source_batches WHERE batch_id = ANY($1::text[])`,
      [['independent-agent-fails', 'independent-storage-fails']]);
    await pool.query(`UPDATE external_source_checkpoints SET cursor=$2::jsonb WHERE account_id=$1`,
      [accountId, JSON.stringify(cursor('1'))]);
    await pool.query(`UPDATE sync_cursors SET cursor=$2::jsonb WHERE account_id=$1 AND source='live'`,
      [accountId, JSON.stringify(cursor('1'))]);
  });

  it('stages login batches once and reprojects a changed native message on replay', async () => {
    const accountId = 'batch-account';
    const liveRaw = (text: string, revision: number) => ({ revision, message: { id: 'login-update', contentType: 0, text } });
    const initial = batch('login-update', '2');
    initial.accountId = accountId;
    initial.envelopes[0]!.accountId = accountId;
    initial.batchId = 'reconcile-initial';
    initial.cursorBefore = cursor('1');
    initial.envelopes[0]!.raw = liveRaw('before', 1);
    await repo.ingestBatchAndRoute(initial, [{ eligible: false }]);
    await repo.ingestBatchAndRoute(initial, [{ eligible: false }]);

    const update = batch('login-update', '3');
    update.accountId = accountId;
    update.envelopes[0]!.accountId = accountId;
    update.batchId = 'reconcile-update';
    update.cursorBefore = cursor('2');
    update.envelopes[0]!.text = 'after';
    update.envelopes[0]!.raw = liveRaw('after', 2);
    const changed = await repo.ingestBatchAndRoute(update, [{ eligible: false }]);
    expect(changed).toMatchObject({ inserted: 0, duplicate: 1, changedMessageIds: ['login-update'] });
    await repo.ingestBatchAndRoute(update, [{ eligible: false }]);

    const rows = await pool.query(`SELECT m.text_content,
      (SELECT count(*) FROM external_source_observations o WHERE o.canonical_message_id='login-update' AND o.source_id=a.selected_source_id) observations,
      (SELECT count(*) FROM message_source_provenance p WHERE p.message_id='login-update' AND p.source_id=a.selected_source_id) provenance,
      (SELECT count(*) FROM external_source_batches b WHERE b.source_id=a.selected_source_id AND b.batch_id IN ('reconcile-initial','reconcile-update')) batches
      FROM line_accounts a JOIN messages m ON m.account_id=a.account_id
      WHERE a.account_id=$1 AND m.message_id='login-update'`, [accountId]);
    expect(rows.rows[0]).toEqual({ text_content: 'after', observations: '1', provenance: '1', batches: '2' });
    await repo.ingestBatchAndRoute(initial, [{ eligible: false }]);
    const staleReplay = await pool.query('SELECT text_content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'login-update']);
    expect(staleReplay.rows[0].text_content).toBe('after');
  });

  it('updates a staged login history row for a confirmed native recall', async () => {
    const input = batch('1700000000123', '1').envelopes[0]!;
    input.accountId = 'batch-account';
    input.ingestion = { source: 'history', cursor: null };
    input.text = 'before';
    input.raw = { revision: input.messageId, message: { id: input.messageId, contentType: 0, text: 'before' } };
    await repo.ingestAndRoute(input, { eligible: false });
    const recalled = { ...input, text: null, raw: { revision: input.messageId, message: { id: input.messageId, contentType: 0,
      text: '', contentMetadata: { UNSENT: true } } } };
    const changed = await repo.ingestAndRoute(recalled, { eligible: false });
    expect(changed).toMatchObject({ disposition: 'duplicate', messageChanged: true });
    await repo.ingestAndRoute(recalled, { eligible: false });
    const rows = await pool.query(`SELECT m.text_content,m.content,
      (SELECT count(*) FROM external_source_observations o WHERE o.canonical_message_id=$1 AND o.source_id=a.selected_source_id) observations,
      (SELECT origin FROM message_source_provenance p WHERE p.message_id=$1 AND p.source_id=a.selected_source_id) origin
      FROM line_accounts a JOIN messages m ON m.account_id=a.account_id
      WHERE a.account_id=$2 AND m.message_id=$1`, [input.messageId, input.accountId]);
    expect(rows.rows[0]).toMatchObject({ text_content: 'before', content: { type: 'unsent' }, observations: '1', origin: 'SYSTEM_LOGIN_HISTORY' });
  });

  it('projects a confirmed manual unsend through the existing login source observation', async () => {
    const messageId = 'manual-unsend-source-copy';
    const input = { ...batch(messageId, '1').envelopes[0]!, messageId, accountId: 'batch-account',
      senderId: 'batch-own-mid', text: 'before', ingestion: { source: 'history' as const, cursor: null },
      raw: { revision: 1, message: { id: messageId, contentType: 0, text: 'before' } } };
    await repo.ingestAndRoute(input, { eligible: false });

    const key = { accountId: 'batch-account', chatType: 'direct' as const, chatId: 'chat' };
    await expect(repo.recordManualUnsend(key, messageId, 'someone-else')).rejects.toThrow('Logged-in source authority is stale');
    expect(await repo.recordManualUnsend(key, messageId, 'batch-own-mid')).toBe(true);
    expect(await repo.recordManualUnsend(key, messageId, 'batch-own-mid')).toBe(false);
    const projected = await pool.query(`SELECT m.text_content,m.content,o.normalized_payload->'livePayload'->'raw'->'message'->'contentMetadata' AS metadata,
      o.observation_id,o.batch_id,(SELECT count(*) FROM external_source_observations o2 WHERE o2.canonical_message_id=m.message_id AND o2.source_id=a.selected_source_id) observations,
      (SELECT count(*) FROM external_source_batches b WHERE b.source_id=o.source_id AND b.generation=o.generation AND b.batch_id=o.batch_id) batches
      FROM line_accounts a JOIN messages m ON m.account_id=a.account_id
      JOIN external_source_observations o ON o.canonical_message_id=m.message_id AND o.source_id=a.selected_source_id
      WHERE a.account_id='batch-account' AND m.message_id=$1`, [messageId]);
    expect(projected.rows[0]).toMatchObject({ text_content: 'before', content: { type: 'unsent' },
      metadata: { UNSENT: true }, observation_id: messageId, batch_id: expect.stringMatching(/^manual-unsend:/), observations: '1', batches: '1' });
  });

  it('serializes manual unsend before concurrent recall and stale login observations', async () => {
    const messageId = 'manual-unsend-lock-order';
    const key = { accountId: 'batch-account', chatType: 'direct' as const, chatId: 'chat' };
    const envelope = (source: 'live' | 'history', text: string | null, recalled = false) => ({
      ...batch(messageId, '1').envelopes[0]!, messageId, accountId: key.accountId, senderId: 'batch-own-mid',
      text, ingestion: { source, cursor: null }, raw: { revision: `${source}-${recalled ? 'recall' : text}`,
        message: { id: messageId, contentType: 0, text: recalled ? '' : text,
          ...(recalled ? { contentMetadata: { UNSENT: true } } : {}) } },
    });
    await repo.ingestAndRoute(envelope('history', 'before'), { eligible: false });

    const barrierKey = '8951138500131';
    const barrier = await pool.connect();
    let manual: Promise<boolean> | undefined;
    let concurrent: Promise<IngestResult>[] = [];
    try {
      await barrier.query('SELECT pg_advisory_lock($1::bigint)', [barrierKey]);
      await pool.query(`CREATE FUNCTION test_pause_manual_unsend_observation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.batch_id LIKE 'manual-unsend:%' THEN PERFORM pg_advisory_xact_lock(${barrierKey}::bigint); END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER test_pause_manual_unsend_observation BEFORE UPDATE ON external_source_observations
        FOR EACH ROW EXECUTE FUNCTION test_pause_manual_unsend_observation()`);
      manual = repo.recordManualUnsend(key, messageId, 'batch-own-mid');
      const waitFor = async (predicate: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };
      let manualPid: number | undefined;
      expect(await waitFor(async () => {
        const activity = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%UPDATE external_source_observations%' LIMIT 1`);
        manualPid = activity.rows[0]?.pid;
        return manualPid !== undefined;
      })).toBe(true);

      concurrent = [
        repo.ingestAndRoute(envelope('live', null, true), { eligible: false }),
        repo.ingestAndRoute(envelope('history', 'stale-history'), { eligible: false }),
        repo.ingestAndRoute(envelope('live', 'stale-live'), { eligible: false }),
      ];
      expect(await waitFor(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND wait_event_type='Lock' AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`, [manualPid])).rowCount === 1)).toBe(true);
      await barrier.query('SELECT pg_advisory_unlock($1::bigint)', [barrierKey]);

      const results = await Promise.allSettled([manual, ...concurrent]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: true });

      const checkpoint = await pool.query<{ cursor: { version: 1; revision: string; globalRev: string; individualRev: string } }>(
        `SELECT c.cursor FROM line_accounts a JOIN external_source_checkpoints c ON c.source_id=a.selected_source_id
         WHERE a.account_id=$1`, [key.accountId]);
      const cursorBefore = checkpoint.rows[0]!.cursor;
      const nextRevision = (BigInt(cursorBefore.revision) + 1n).toString();
      const staleBatch = batch(messageId, '1');
      staleBatch.batchId = 'manual-unsend-stale-live-batch';
      staleBatch.accountId = key.accountId;
      staleBatch.cursorBefore = cursorBefore;
      staleBatch.cursorAfter = { ...cursorBefore, revision: nextRevision };
      staleBatch.envelopes[0]!.accountId = key.accountId;
      staleBatch.envelopes[0]!.senderId = 'batch-own-mid';
      staleBatch.envelopes[0]!.text = 'before';
      staleBatch.envelopes[0]!.raw = { revision: 1, message: { id: messageId, contentType: 0, text: 'before' } };
      const unreadBefore = await pool.query<{ unread_count: number }>(
        'SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
        [key.accountId, key.chatType, key.chatId]);
      const staleBatchResult = await repo.ingestBatchAndRoute(staleBatch, [{ eligible: false }]);
      expect(staleBatchResult).toMatchObject({ inserted: 0, duplicate: 1, insertedMessageIds: [], changedMessageIds: [] });
      const unreadAfter = await pool.query<{ unread_count: number }>(
        'SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
        [key.accountId, key.chatType, key.chatId]);
      expect(unreadAfter.rows[0]?.unread_count).toBe(unreadBefore.rows[0]?.unread_count);
      await pool.query('UPDATE external_source_checkpoints SET cursor=$2::jsonb WHERE account_id=$1',
        [key.accountId, JSON.stringify(cursor('3'))]);
      await pool.query("UPDATE sync_cursors SET cursor=$2::jsonb WHERE account_id=$1 AND source='live'",
        [key.accountId, JSON.stringify(cursor('3'))]);
    } finally {
      await barrier.query('SELECT pg_advisory_unlock($1::bigint)', [barrierKey]).catch(() => undefined);
      await Promise.allSettled([...(manual ? [manual] : []), ...concurrent]);
      await pool.query('DROP TRIGGER IF EXISTS test_pause_manual_unsend_observation ON external_source_observations');
      await pool.query('DROP FUNCTION IF EXISTS test_pause_manual_unsend_observation()');
      barrier.release();
    }
    const final = await pool.query(`SELECT m.text_content,m.content,o.observation_id,
      o.normalized_payload->'livePayload'->'raw'->'message'->'contentMetadata' AS metadata
      FROM messages m JOIN line_accounts a ON a.account_id=m.account_id
      JOIN external_source_observations o ON o.source_id=a.selected_source_id AND o.canonical_message_id=m.message_id
      WHERE m.account_id=$1 AND m.message_id=$2`, [key.accountId, messageId]);
    expect(final.rows[0]).toMatchObject({ text_content: 'before', content: { type: 'unsent' }, observation_id: messageId,
      metadata: { UNSENT: true } });
  });

  it('projects login mention IDs and ranges through the shared canonical projector', async () => {
    const input = { ...batch('login-mentions', '1').envelopes[0]!, accountId: 'batch-account',
      messageId: 'login-mentions', text: '@Agent work', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }],
      raw: { revision: 'login-mentions', message: { id: 'login-mentions', contentType: 0, text: '@Agent work' } } };
    await repo.ingestAndRoute(input, { eligible: false });
    const row = await pool.query(`SELECT m.mention_ids,m.mention_ranges
      FROM messages m JOIN line_accounts a ON a.account_id=m.account_id
      JOIN external_source_observations o ON o.source_id=a.selected_source_id AND o.canonical_message_id=m.message_id
      WHERE m.account_id=$1 AND m.message_id=$2`, [input.accountId, input.messageId]);
    expect(row.rows[0]).toEqual({ mention_ids: ['agent-mid'], mention_ranges: input.mentionRanges });
  });

  it('projects non-text login content from the persisted source observation', async () => {
    const accountId = 'batch-account';
    const input = { ...batch('login-contact', '1').envelopes[0]!, accountId, messageId: 'login-contact', kind: 'contact' as const,
      text: null, contact: { mid: `u${'c'.repeat(32)}`, displayName: 'Friend' },
      ingestion: { source: 'history' as const, cursor: null },
      raw: { revision: 1, message: { id: 'login-contact', contentType: 13, text: null } } };
    const result = await repo.ingestAndRoute(input, { eligible: false });
    expect(result.disposition).toBe('inserted');
    const rows = await pool.query(`SELECT m.kind,m.content,o.normalized_payload->'livePayload' AS payload
      FROM messages m JOIN line_accounts a ON a.account_id=m.account_id
      JOIN external_source_observations o ON o.source_id=a.selected_source_id AND o.canonical_message_id=m.message_id
      WHERE m.account_id=$1 AND m.message_id=$2`, [accountId, input.messageId]);
    expect(rows.rows[0]).toMatchObject({ kind: 'contact', content: { type: 'contact', mid: input.contact.mid, displayName: 'Friend' },
      payload: { raw: input.raw, contact: input.contact } });
  });

  it('persists a cursor-only checkpoint', async () => {
    await repo.ingestBatchAndRoute({ ...batch('unused', '4'), batchId: 'cursor-only-after-reconcile', cursorBefore: cursor('3'), envelopes: [] }, []);
    const row = await pool.query("SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live'");
    expect(row.rows[0].cursor).toBe(JSON.stringify(cursor('4')));
    expect(await repo.getLiveCursor('batch-account')).toEqual(cursor('4'));
  });

  it('rolls back the complete batch when one envelope is invalid', async () => {
    const input = batch('m-bad', '5');
    input.cursorBefore = cursor('4');
    input.envelopes.push({ ...input.envelopes[0]!, messageId: 'm-bad-2', attachments: [{ id: 'bad', kind: 'invalid' as 'image', name: null, mimeType: null, sizeBytes: null }] });
    await expect(repo.ingestBatchAndRoute(input, [route, route])).rejects.toThrow();
    const rows = await pool.query("SELECT (SELECT count(*) FROM messages WHERE message_id LIKE 'm-bad%') messages, (SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live') cursor");
    expect(rows.rows[0]).toEqual({ messages: '0', cursor: JSON.stringify(cursor('4')) });
  });
  it('never regresses an independent composite cursor component on replay', async () => {
    await repo.ingestBatchAndRoute({ ...batch('unused', '5'), batchId: 'composite-first', cursorBefore: cursor('4'), envelopes: [], cursorAfter: { ...cursor('5'), globalRev: '9' } }, []);
    await repo.ingestBatchAndRoute({ ...batch('unused', '5'), batchId: 'composite-second', cursorBefore: { ...cursor('5'), globalRev: '9' }, envelopes: [], cursorAfter: { ...cursor('5'), globalRev: '3', individualRev: '2' } }, []);
    const row = await pool.query("SELECT cursor FROM sync_cursors WHERE account_id = 'batch-account' AND source = 'live'");
    expect(JSON.parse(row.rows[0].cursor)).toEqual({ version: 1, revision: '5', globalRev: '9', individualRev: '2' });
  });
  it('claims same-batch jobs in envelope order even when timestamps tie and UUIDs sort backward', async () => {
    const input = batch('fifo-first', '6');
    input.cursorBefore = { version: 1, revision: '5', globalRev: '9', individualRev: '2' };
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
  it('keeps a history recall when a stale live observation arrives in a later batch', async () => {
    const accountId = 'batch-account';
    const messageId = 'recall-stale-live';
    const checkpoint = await pool.query<{ cursor: { version: 1; revision: string; globalRev: string; individualRev: string } }>(
      `SELECT c.cursor FROM line_accounts a JOIN external_source_checkpoints c ON c.source_id=a.selected_source_id
       WHERE a.account_id=$1`, [accountId]);
    const current = checkpoint.rows[0]?.cursor ?? null;
    const beforeRevision = Number(current?.revision ?? '0');
    const live = batch(messageId, String(beforeRevision + 1));
    live.cursorBefore = current ?? cursor(String(beforeRevision));
    live.accountId = accountId;
    live.batchId = 'recall-stale-live-original';
    live.envelopes[0]!.accountId = accountId;
    live.envelopes[0]!.text = 'original';
    live.envelopes[0]!.raw = { revision: 1, message: { id: messageId, contentType: 0, text: 'original' } };
    await repo.ingestBatchAndRoute(live, [{ eligible: false }]);

    const recalled = { ...live.envelopes[0]!, ingestion: { source: 'history' as const, cursor: null }, text: null,
      raw: { revision: 2, message: { id: messageId, contentType: 0, text: '', contentMetadata: { UNSENT: true } } } };
    await repo.ingestAndRoute(recalled, { eligible: false });

    const afterFirst = await pool.query<{ cursor: typeof current }>(
      `SELECT c.cursor FROM line_accounts a JOIN external_source_checkpoints c ON c.source_id=a.selected_source_id
       WHERE a.account_id=$1`, [accountId]);
    const staleBefore = afterFirst.rows[0]!.cursor!;
    const stale = { ...live, batchId: 'recall-stale-live-replay', cursorBefore: staleBefore,
      cursorAfter: { ...staleBefore, revision: String(Number(staleBefore.revision) + 1) },
      envelopes: [{ ...live.envelopes[0]!, eventId: 'recall-stale-live-replay-event' }] };
    const unreadBefore = await pool.query<{ unread_count: number }>(
      'SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [accountId, live.envelopes[0]!.chatType, live.envelopes[0]!.chatId]);
    const result = await repo.ingestBatchAndRoute(stale, [{ eligible: false }]);
    expect(result).toMatchObject({ inserted: 0, duplicate: 1, insertedMessageIds: [] });
    expect(result.changedMessageIds).toEqual([]);
    const row = await pool.query(`SELECT content,text_content,
      (SELECT origin FROM message_source_provenance WHERE account_id=$1 AND message_id=$2) origin
      FROM messages WHERE account_id=$1 AND message_id=$2`, [accountId, messageId]);
    expect(row.rows[0]).toEqual({ content: { format: 1, type: 'unsent' }, text_content: 'original', origin: 'SYSTEM_LOGIN_LIVE' });
    const unreadAfter = await pool.query<{ unread_count: number }>(
      'SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [accountId, live.envelopes[0]!.chatType, live.envelopes[0]!.chatId]);
    expect(unreadAfter.rows[0]?.unread_count).toBe(unreadBefore.rows[0]?.unread_count);
  });
  it('archives a still-bound MONITOR_ONLY worker batch after another account advances the global control epoch', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('monitor-account');
    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE account_id='batch-account'");
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='monitor-account'");
    await accounts.bindWorker({ accountId: 'monitor-account', workerInstanceId: 'worker-1', controlEpoch: 1 });
    await accounts.applyWorkerLogin({ accountId: 'monitor-account', workerInstanceId: 'worker-1', controlEpoch: 1 }, 'monitor-own-mid', 'Monitor');
    await accounts.revokeControl(1);
    const input = { ...batch('monitor-message', '6'), accountId: 'monitor-account',
      envelopes: [{ ...batch('monitor-message', '6').envelopes[0]!, accountId: 'monitor-account' }] };
    input.cursorBefore = cursor('0');
    expect(await repo.ingestBatchAndRoute(input, [route])).toMatchObject({ inserted: 1, jobIds: [] });
    await expect(repo.ingestBatchAndRoute({ ...input, workerInstanceId: 'forged-worker', batchId: 'forged' }, [route]))
      .rejects.toThrow('Stale batch control epoch');
    await expect(repo.ingestBatchAndRoute({ ...input, controlEpoch: 99, batchId: 'future' }, [route]))
      .rejects.toThrow('Stale batch control epoch');
  });
});
