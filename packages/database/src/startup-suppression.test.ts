import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { InboundEnvelope, LineWorkerEvent } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('startup durable suppression (PostgreSQL)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let messages: MessageRepository;
  let accountId: string;
  let workerInstanceId: string;
  let controlEpoch: number;

  const envelope = (messageId: string): InboundEnvelope => ({
    eventId: `event-${messageId}`, accountId, chatType: 'group', chatId: 'c-startup-suppression',
    senderId: 'u-sender', messageId, kind: 'text', text: messageId, mentionIds: [], mentionRanges: [],
    replyToMessageId: null, ingestion: { source: 'live', cursor: null },
    occurredAt: '2026-10-31T00:00:00.000Z', attachments: [], raw: {},
  });
  const batch = (batchId: string, before: string, after: string, envelopes: InboundEnvelope[]) => ({
    type: 'batch' as const, accountId, workerInstanceId, controlEpoch, batchId,
    cursorBefore: { version: 1 as const, revision: before, globalRev: '0', individualRev: '0' },
    cursorAfter: { version: 1 as const, revision: after, globalRev: '0', individualRev: '0' }, envelopes,
  }) satisfies Extract<LineWorkerEvent, { type: 'batch' }>;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    messages = new MessageRepository(pool);
    accountId = `startup-suppression-${randomUUID()}`;
    workerInstanceId = `startup-worker-${randomUUID()}`;
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [accountId]);
    const control = await accounts.getControlState();
    const activated = await accounts.activateControl(accountId, control.controlEpoch);
    expect(activated.activated).toBe(true);
    controlEpoch = activated.controlEpoch;
    const binding = { accountId, workerInstanceId, controlEpoch };
    await accounts.bindWorker(binding);
    expect(await accounts.applyWorkerLogin(binding, `u${'a'.repeat(32)}`, 'Agent')).toBe(true);
  });

  afterAll(async () => { await close?.(); });

  it('suppresses pending actions and unrouted observations only for the current worker and epoch', async () => {
    const actions = [
      { envelope: envelope('suppression-stop'), action: 'stop' as const },
      { envelope: envelope('suppression-new'), action: 'new' as const },
      { envelope: envelope('suppression-status'), action: 'status' as const },
    ];
    await messages.ingestBatchAndRoute(batch('startup-action-batch', '0', '1', actions.map((item) => item.envelope)),
      actions.map((item) => ({ eligible: false as const, action: item.action })));

    const unrouted = [envelope('suppression-unrouted-1'), envelope('suppression-unrouted-2')];
    await messages.ingestBatchSource(batch('startup-unrouted-batch', '1', '2', unrouted));
    const scoped = { accountId, workerInstanceId, controlEpoch };
    const before = await messages.listUnroutedLiveSourceMessages(scoped);
    expect(before.map((item) => item.observationId)).toEqual(unrouted.map((item) => item.messageId));
    expect(await messages.listPendingRouteActions(accountId, workerInstanceId)).toHaveLength(3);

    await messages.suppressPendingRouteActions({ ...scoped, workerInstanceId: `${workerInstanceId}-stale` });
    await messages.suppressPendingRouteActions({ ...scoped, controlEpoch: controlEpoch - 1 });
    await messages.suppressUnroutedLiveSourceMessages({ ...scoped, workerInstanceId: `${workerInstanceId}-stale` });
    await messages.suppressUnroutedLiveSourceMessages({ ...scoped, controlEpoch: controlEpoch - 1 });
    const unaffected = await pool.query<{ message_id: string; action: string; effect_applied_at: Date | null }>(
      `SELECT message_id,action,effect_applied_at FROM message_routes WHERE account_id=$1 ORDER BY message_id`, [accountId]);
    expect(unaffected.rows).toEqual(actions.map(({ envelope: item, action }) => ({
      message_id: item.messageId, action, effect_applied_at: null,
    })).sort((left, right) => left.message_id.localeCompare(right.message_id)));
    expect((await messages.listUnroutedLiveSourceMessages(scoped)).map((item) => item.observationId))
      .toEqual(unrouted.map((item) => item.messageId));

    await messages.suppressPendingRouteActions(scoped);
    await messages.suppressUnroutedLiveSourceMessages(scoped);
    const suppressed = await pool.query<{ message_id: string; action: string; effect_applied_at: Date | null }>(
      `SELECT message_id,action,effect_applied_at FROM message_routes WHERE account_id=$1 ORDER BY message_id`, [accountId]);
    expect(suppressed.rows).toEqual(actions.map(({ envelope: item }) => ({
      message_id: item.messageId, action: 'ignore', effect_applied_at: null,
    })).sort((left, right) => left.message_id.localeCompare(right.message_id)));
    expect(await messages.listPendingRouteActions(accountId, workerInstanceId)).toEqual([]);
    expect(await messages.listUnroutedLiveSourceMessages(scoped)).toEqual([]);
    const markers = await pool.query<{ observation_id: string; startup_suppressed: boolean }>(
      `SELECT observation_id,normalized_payload->'livePayload'->'recovery'->>'startupSuppressed'='true' AS startup_suppressed
       FROM external_source_observations WHERE account_id=$1 AND observation_id=ANY($2::text[]) ORDER BY observation_id`,
      [accountId, unrouted.map((item) => item.messageId)]);
    expect(markers.rows).toEqual(unrouted.map((item) => ({ observation_id: item.messageId, startup_suppressed: true })));
  });
});
