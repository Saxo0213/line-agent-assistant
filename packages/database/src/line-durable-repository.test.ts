import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { LineDurableRepository, type ReceiveBatchInput } from './line-durable-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('durable LINE account state on PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: LineDurableRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new LineDurableRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('reserves signed i32 sequences concurrently per account and resumes after repository restart', async () => {
    const reservations = await Promise.all(Array.from({ length: 32 }, () => repo.reserveRequestSequence('seq-a')));
    expect(reservations.map((entry) => entry.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(new Set(reservations.map((entry) => entry.reservationId)).size).toBe(32);
    expect((await repo.reserveRequestSequence('seq-b')).sequence).toBe(1);
    repo = new LineDurableRepository(pool);
    expect((await repo.reserveRequestSequence('seq-a')).sequence).toBe(33);
  });

  it('does not wrap a signed i32 sequence after exhaustion', async () => {
    await pool.query(`INSERT INTO line_request_sequence_counters(account_id, next_sequence)
      VALUES ('seq-exhaust', 2147483647)`);
    expect(await repo.reserveRequestSequence('seq-exhaust')).toMatchObject({ sequence: 2147483647 });
    await expect(repo.reserveRequestSequence('seq-exhaust')).rejects.toThrow('LINE request sequence exhausted');
  });

  it('recovers reserved attempts safely but makes in-flight UNKNOWN terminal to queueing', async () => {
    const reservation = await repo.reserveRequestSequence('mutation-a');
    const intent = await repo.prepareMutation({
      accountId: 'mutation-a', chatType: 'direct', chatId: 'chat-a', payloadDigest: 'a'.repeat(64),
      authorityEpoch: 4, grantVersion: 9, capability: 'write',
    });
    const reservedIdentity = {
      attemptId: 'attempt-1', ownerId: 'owner-1', workerInstanceId: 'worker-1', credentialVersion: 12,
      reservationId: reservation.reservationId, effectPermitId: 'permit-1',
    };
    await repo.reserveMutationAttempt(intent.intentId, reservedIdentity);
    expect(await repo.recoverMutationAttempts('mutation-a', 'owner-1')).toMatchObject({ prepared: 1, unknown: 0 });
    const abandoned = await pool.query("SELECT state,reservation_id FROM line_mutation_attempts WHERE intent_id=$1 AND attempt_id='attempt-1'", [intent.intentId]);
    expect(abandoned.rows[0]).toMatchObject({ state: 'ABANDONED', reservation_id: reservation.reservationId });

    const nextReservation = await repo.reserveRequestSequence('mutation-a');
    const secondIdentity = { ...reservedIdentity, attemptId: 'attempt-2', reservationId: nextReservation.reservationId, effectPermitId: 'permit-2' };
    expect(await repo.reserveMutationAttempt(intent.intentId, secondIdentity)).toEqual({ sequence: 2, effectPermitId: 'permit-2' });
    await repo.markMutationInFlight(intent.intentId, secondIdentity);
    expect(await repo.recoverMutationAttempts('mutation-a', 'owner-1')).toMatchObject({ prepared: 0, unknown: 1 });
    await expect(repo.reserveMutationAttempt(intent.intentId, { ...secondIdentity, attemptId: 'attempt-3' }))
      .rejects.toThrow('Mutation intent is not PREPARED');
    expect(await repo.reconcileMutation(intent.intentId, { ...secondIdentity, ownerId: 'stale-owner' }, 'SENT')).toBe(false);
    expect(await repo.reconcileMutation(intent.intentId, { ...secondIdentity, credentialVersion: 13 }, 'SENT')).toBe(false);
    expect(await repo.reconcileMutation(intent.intentId, secondIdentity, 'SENT', { lineMessageId: 'line-123' })).toBe(true);
    expect(await repo.reconcileMutation(intent.intentId, secondIdentity, 'REJECTED')).toBe(false);
    expect(await repo.getMutationIntent(intent.intentId)).toMatchObject({
      accountId: 'mutation-a', payloadDigest: 'a'.repeat(64), authorityEpoch: 4, grantVersion: 9,
      ownerId: 'owner-1', credentialVersion: 12, requestSequence: 2, effectPermitId: 'permit-2', state: 'SENT',
    });
    expect((await repo.getMutationIntent(intent.intentId))?.outcome).toMatchObject({ result: { lineMessageId: 'line-123' } });
  });

  it('records request-scoped UNKNOWN with identity fencing and isolates account recovery', async () => {
    const reservationA = await repo.reserveRequestSequence('unknown-a');
    const intentA = await repo.prepareMutation({ accountId: 'unknown-a', chatType: 'room', chatId: 'room',
      payloadDigest: 'b'.repeat(64), authorityEpoch: 1, grantVersion: 2, capability: 'write' });
    const attemptA = { attemptId: 'unknown-attempt-a', ownerId: 'owner-a', workerInstanceId: 'worker-a',
      credentialVersion: 3, reservationId: reservationA.reservationId, effectPermitId: 'permit-a' };
    await repo.reserveMutationAttempt(intentA.intentId, attemptA);
    await repo.markMutationInFlight(intentA.intentId, attemptA);
    expect(await repo.markMutationUnknown(intentA.intentId, { ...attemptA, ownerId: 'stale-owner' }, 'deadline')).toBe(false);
    expect(await repo.markMutationUnknown(intentA.intentId, attemptA, 'deadline')).toBe(true);
    await expect(repo.reserveMutationAttempt(intentA.intentId, { ...attemptA, attemptId: 'must-not-requeue' }))
      .rejects.toThrow('Mutation intent is not PREPARED');
    expect(await repo.reconcileMutation(intentA.intentId, attemptA, 'SENT', { receipt: 42 })).toBe(true);

    const reservationB = await repo.reserveRequestSequence('unknown-b');
    const recoveryReservationA = await repo.reserveRequestSequence('unknown-a');
    const recoveryIntentA = await repo.prepareMutation({ accountId: 'unknown-a', chatType: 'room', chatId: 'room',
      payloadDigest: 'd'.repeat(64), authorityEpoch: 1, grantVersion: 2, capability: 'write' });
    const recoveryAttemptA = { attemptId: 'recovery-attempt-a', ownerId: 'recovery-owner-a', workerInstanceId: 'worker-a',
      credentialVersion: 4, reservationId: recoveryReservationA.reservationId, effectPermitId: 'recovery-permit-a' };
    await repo.reserveMutationAttempt(recoveryIntentA.intentId, recoveryAttemptA);
    const intentB = await repo.prepareMutation({ accountId: 'unknown-b', chatType: 'room', chatId: 'room',
      payloadDigest: 'c'.repeat(64), authorityEpoch: 1, grantVersion: 2, capability: 'write' });
    const attemptB = { attemptId: 'attempt-b', ownerId: 'retired-b', workerInstanceId: 'worker-b',
      credentialVersion: 1, reservationId: reservationB.reservationId, effectPermitId: 'permit-b' };
    await repo.reserveMutationAttempt(intentB.intentId, attemptB);
    expect(await repo.recoverMutationAttempts('unknown-a', 'wrong-retired-owner')).toEqual({ prepared: 0, unknown: 0 });
    expect(await repo.recoverMutationAttempts('unknown-a', 'recovery-owner-a')).toEqual({ prepared: 1, unknown: 0 });
    expect(await repo.getMutationIntent(recoveryIntentA.intentId)).toMatchObject({ state: 'PREPARED', ownerId: null });
    expect(await repo.getMutationIntent(intentB.intentId)).toMatchObject({ state: 'ATTEMPT_RESERVED', ownerId: 'retired-b' });
  });

  it('commits inbox, cursor, gap and dispatch atomically and recovers work after the ACK/wakeup gap', async () => {
    const batch: ReceiveBatchInput = {
      accountId: 'receive-a', ownerId: 'owner-r', transportGeneration: 3, batchId: 'batch-1',
      cursorBefore: { revision: '0' }, cursorAfter: { revision: '8' },
      gap: { sourceId: 'sync-gap-1', kind: 'PARTIAL_SYNC', details: { category: 'groups' } },
      events: [{ sourceEventId: 'event-1', chatType: 'direct', chatId: 'chat-1', order: 1,
        dispatchKind: 'line-event', payload: { text: 'hello' }, raw: { operation: 1 } }],
    };
    await repo.persistReceiveBatch(batch);
    await repo.persistReceiveBatch(batch);
    await repo.persistReceiveBatch({
      accountId: 'receive-a', ownerId: 'owner-r', transportGeneration: 3, batchId: 'batch-2',
      cursorBefore: { revision: '8' }, cursorAfter: { revision: '9', partialSync: { category: 'rooms' } },
      gap: { sourceId: 'sync-gap-2', kind: 'PARTIAL_SYNC', details: { category: 'rooms' } }, events: [],
    });
    await repo.persistReceiveBatch(batch);
    expect(await repo.getReceiveCursor('receive-a')).toEqual({ revision: '9', partialSync: { category: 'rooms' } });
    repo = new LineDurableRepository(pool);
    expect(await repo.listReadyDispatches({ accountId: 'receive-a', limit: 10 })).toMatchObject([
      { accountId: 'receive-a', chatId: 'chat-1', sourceEventId: 'event-1', payload: { text: 'hello' } },
    ]);
    expect(await repo.listOpenSyncGaps('receive-a')).toMatchObject([
      { kind: 'PARTIAL_SYNC', details: { category: 'groups' } },
      { kind: 'PARTIAL_SYNC', details: { category: 'rooms' } },
    ]);
    const counts = await pool.query(`SELECT (SELECT count(*) FROM line_inbox_events WHERE account_id='receive-a') events,
      (SELECT count(*) FROM line_dispatch_outbox WHERE account_id='receive-a') dispatches,
      (SELECT count(*) FROM line_sync_gaps WHERE account_id='receive-a') gaps`);
    expect(counts.rows[0]).toEqual({ events: '1', dispatches: '1', gaps: '2' });
    const [gap] = await repo.listOpenSyncGaps('receive-a');
    expect(await repo.resolveSyncGap('receive-a', gap!.gapId)).toBe(true);
    expect(await repo.resolveSyncGap('receive-a', gap!.gapId)).toBe(false);
    expect(await repo.listOpenSyncGaps('receive-a')).toMatchObject([{ kind: 'PARTIAL_SYNC', details: { category: 'rooms' } }]);
    await repo.persistReceiveBatch({
      accountId: 'receive-a', ownerId: 'owner-r', transportGeneration: 3, batchId: 'batch-3',
      cursorBefore: { revision: '9', partialSync: { category: 'rooms' } },
      cursorAfter: { revision: '10', partialSync: { category: 'rooms' } },
      gap: { sourceId: 'sync-gap-3', kind: 'PARTIAL_SYNC', details: { category: 'groups' } }, events: [],
    });
    expect(await repo.listOpenSyncGaps('receive-a')).toHaveLength(2);
  });

  it('rejects missing cursor predecessors and changed batch or source-event replays', async () => {
    const first: ReceiveBatchInput = {
      accountId: 'cursor-cas', ownerId: 'owner-c', transportGeneration: 1, batchId: 'cursor-batch-1',
      cursorBefore: { revision: '0' }, cursorAfter: { revision: '10' },
      gap: { sourceId: 'cursor-gap', kind: 'RESYNC_REQUIRED', details: { category: 'groups' } },
      events: [{ sourceEventId: 'cursor-event', chatType: 'direct', chatId: 'chat', order: 1,
        dispatchKind: 'local', payload: { value: 1 }, raw: { op: 1 } }],
    };
    await repo.persistReceiveBatch(first);
    await expect(repo.persistReceiveBatch({ ...first, events: [{ ...first.events[0]!, payload: { value: 2 } }] }))
      .rejects.toThrow('LINE batch replay changed its durable content');
    await expect(repo.persistReceiveBatch({ ...first, batchId: 'cursor-batch-2', cursorBefore: { revision: '10' },
      cursorAfter: { revision: '11' }, events: [{ ...first.events[0]!, raw: { op: 2 } }] }))
      .rejects.toThrow('LINE source event replay changed its durable content');
    await expect(repo.persistReceiveBatch({ ...first, events: [{ ...first.events[0]!, chatId: 'other-chat' }] }))
      .rejects.toThrow('LINE batch replay changed its durable content');
    await expect(repo.persistReceiveBatch({ ...first, gap: { ...first.gap!, details: { category: 'rooms' } } }))
      .rejects.toThrow('LINE batch replay changed its durable content');
    await expect(repo.persistReceiveBatch({ ...first, events: [...first.events, { ...first.events[0]!, sourceEventId: 'extra' }] }))
      .rejects.toThrow('LINE batch replay changed its durable content');
    await expect(repo.persistReceiveBatch({ ...first, batchId: 'missing-predecessor', cursorAfter: { revision: '20' } }))
      .rejects.toThrow('Stale LINE cursor predecessor');
    expect(await repo.getReceiveCursor('cursor-cas')).toEqual({ revision: '10' });
    await repo.persistReceiveBatch(first);
    expect(await repo.getReceiveCursor('cursor-cas')).toEqual({ revision: '10' });
  });

  it('serializes concurrent batches that share a cursor predecessor', async () => {
    const makeBatch = (batchId: string, sourceEventId: string, revision: string): ReceiveBatchInput => ({
      accountId: 'cursor-race', ownerId: 'owner-race', transportGeneration: 2, batchId,
      cursorBefore: { revision: '0' }, cursorAfter: { revision },
      events: [{ sourceEventId, chatType: 'group', chatId: 'ordered', order: 1,
        dispatchKind: 'local-handler', payload: {}, raw: {} }],
    });
    const results = await Promise.allSettled([
      repo.persistReceiveBatch(makeBatch('batch-10', 'event-10', '10')),
      repo.persistReceiveBatch(makeBatch('batch-20', 'event-20', '20')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repo.getReceiveCursor('cursor-race')).toMatchObject({ revision: expect.stringMatching(/^(10|20)$/) });
    const rows = await pool.query("SELECT count(*) FROM line_inbox_events WHERE account_id='cursor-race'");
    expect(rows.rows[0].count).toBe('1');
  });

  it('rolls back inbox, cursor, gap and dispatch together when a receive batch is invalid', async () => {
    await expect(repo.persistReceiveBatch({
      accountId: 'receive-rollback', ownerId: 'owner-x', transportGeneration: 1, batchId: 'bad-batch',
      cursorBefore: {}, cursorAfter: { revision: '7' }, gap: { sourceId: 'rollback-gap', kind: 'RESYNC_REQUIRED', details: {} },
      events: [
        { sourceEventId: 'valid-first', chatType: 'direct', chatId: 'chat', order: 1, dispatchKind: 'handler', payload: {}, raw: {} },
        { sourceEventId: 'invalid-second', chatType: 'invalid' as 'direct', chatId: 'chat', order: 2, dispatchKind: 'handler', payload: {}, raw: {} },
      ],
    })).rejects.toThrow();
    expect(await repo.getReceiveCursor('receive-rollback')).toBeNull();
    const counts = await pool.query(`SELECT (SELECT count(*) FROM line_inbox_batches WHERE account_id='receive-rollback') batches,
      (SELECT count(*) FROM line_inbox_events WHERE account_id='receive-rollback') events,
      (SELECT count(*) FROM line_dispatch_outbox WHERE account_id='receive-rollback') dispatches,
      (SELECT count(*) FROM line_sync_gaps WHERE account_id='receive-rollback') gaps`);
    expect(counts.rows[0]).toEqual({ batches: '0', events: '0', dispatches: '0', gaps: '0' });
  });

  it('preserves per-chat dispatch order, deduplicates source events, and permits unrelated chats', async () => {
    await repo.persistReceiveBatch({
      accountId: 'dispatch-a', ownerId: 'owner-d', transportGeneration: 1, batchId: 'batch-d',
      cursorBefore: {}, cursorAfter: { revision: '2' },
      events: [
        { sourceEventId: 'chat-1-first', chatType: 'group', chatId: 'chat-1', order: 1, dispatchKind: 'handler', payload: { n: 1 }, raw: {} },
        { sourceEventId: 'chat-1-second', chatType: 'group', chatId: 'chat-1', order: 2, dispatchKind: 'handler', payload: { n: 2 }, raw: {} },
        { sourceEventId: 'chat-2-first', chatType: 'group', chatId: 'chat-2', order: 1, dispatchKind: 'handler', payload: { n: 3 }, raw: {} },
      ],
    });
    const claimed = await repo.claimReadyDispatches({ accountId: 'dispatch-a', ownerId: 'dispatcher', limit: 2, leaseSeconds: 30 });
    expect(claimed.map((item) => item.sourceEventId)).toEqual(['chat-1-first', 'chat-2-first']);
    await repo.completeDispatch(claimed.find((item) => item.sourceEventId === 'chat-1-first')!);
    const next = await repo.claimReadyDispatches({ accountId: 'dispatch-a', ownerId: 'dispatcher-2', limit: 2, leaseSeconds: 30 });
    expect(next.map((item) => item.sourceEventId)).toEqual(['chat-1-second']);
    await repo.persistReceiveBatch({
      accountId: 'dispatch-a', ownerId: 'owner-d', transportGeneration: 1, batchId: 'batch-d-replay',
      cursorBefore: { revision: '2' }, cursorAfter: { revision: '2' },
      events: [{ sourceEventId: 'chat-1-first', chatType: 'group', chatId: 'chat-1', order: 1,
        dispatchKind: 'handler', payload: { n: 1 }, raw: {} }],
    });
    expect((await pool.query("SELECT count(*) FROM line_dispatch_outbox WHERE account_id='dispatch-a'")).rows).toEqual([{ count: '3' }]);
    const reclaimed = next[0]!;
    await pool.query('UPDATE line_dispatch_outbox SET lease_until=now()-interval \'1 second\' WHERE dispatch_id=$1', [reclaimed.dispatchId]);
    const replacement = await repo.claimReadyDispatches({ accountId: 'dispatch-a', ownerId: 'dispatcher-new', limit: 1, leaseSeconds: 30 });
    expect(await repo.completeDispatch(reclaimed)).toBe(false);
    await expect(pool.query("UPDATE line_dispatch_outbox SET retry_class='REMOTE_MUTATION' WHERE dispatch_id=$1", [replacement[0]!.dispatchId])).rejects.toThrow();
    expect(await repo.completeDispatch(replacement[0]!)).toBe(true);
  });
});
