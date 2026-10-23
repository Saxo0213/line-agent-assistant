import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_ROOM_KEY, type ConversationKey, type InboundEnvelope } from '@line-agent/contracts';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { MessageRepository } from './message-repository.js';
import { SettingsRepository } from './settings-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let sequence = 20_000;

function envelope(key: ConversationKey, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  const id = ++sequence;
  return {
    eventId: `event-${id}`,
    ...key,
    senderId: 'sender-1',
    messageId: `message-${id}`,
    kind: 'text',
    text: `/agent work ${id}`,
    mentionIds: ['agent-1'],
    mentionRanges: [{ start: 0, end: 6, userId: 'agent-1' }],
    replyToMessageId: null,
    ingestion: { source: 'live', cursor: `cursor-${id}` },
    occurredAt: '2026-10-15T10:00:00.000Z',
    attachments: [],
    raw: {},
    ...overrides,
  };
}

const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\work' };

async function assignAgentRole(pool: Pool, accountId: string): Promise<void> {
  await pool.query("UPDATE line_accounts SET product_role = NULL WHERE product_role = 'AGENT'");
  await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [accountId]);
}

database('multi-account identity and control fencing', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let settings: SettingsRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    settings = new SettingsRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('defaults new accounts to monitor and concurrent CAS activation leaves at most one active', async () => {
    await accounts.ensureAccount('race-A');
    await accounts.ensureAccount('race-B');
    await assignAgentRole(pool, 'race-A');
    expect((await accounts.getAccount('race-A'))?.mode).toBe('MONITOR_ONLY');
    const epoch = (await accounts.getControlState()).controlEpoch;
    const results = await Promise.all([
      accounts.activateControl('race-A', epoch),
      accounts.activateControl('race-B', epoch),
    ]);
    expect(results.filter((result) => result.activated)).toHaveLength(1);
    const active = await pool.query("SELECT account_id FROM line_accounts WHERE mode = 'ACTIVE_CONTROL'");
    expect(active.rowCount).toBe(1);
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'line_accounts_one_active_idx'");
    expect(index.rows[0].indexdef).toContain('(1)');
    await accounts.revokeControl(epoch);
  });

  it('keeps identical chat and attachment IDs isolated across accounts and chat types', async () => {
    const keys: ConversationKey[] = [
      { accountId: 'iso-A', chatType: 'group', chatId: 'same-chat' },
      { accountId: 'iso-B', chatType: 'group', chatId: 'same-chat' },
      { accountId: 'iso-A', chatType: 'room', chatId: 'same-chat' },
    ];
    const inputs = keys.map((key, index) => envelope(key, {
      messageId: `same-message-${index}`,
      attachments: [{ id: 'same-attachment', kind: 'image', name: `${index}.png`, mimeType: 'image/png', sizeBytes: index }],
    }));
    for (const input of inputs) await messages.ingestAndRoute(input, { eligible: false });
    await settings.setConversationAgent({ ...keys[0]!, enabled: true, provider: 'codex' });
    await settings.setConversationAgent({ ...keys[1]!, enabled: false, provider: 'claude' });
    expect(await settings.getConversationAgent(keys[0]!)).toEqual({ enabled: true, provider: 'codex' });
    expect(await settings.getConversationAgent(keys[1]!)).toEqual({ enabled: false, provider: 'claude' });
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...keys[0]!, provider: 'codex', externalSessionId: 'group-session', generation: 0 })).toBe(true);
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...keys[2]!, provider: 'codex', externalSessionId: 'room-session', generation: 0 })).toBe(true);
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...keys[0]!, provider: 'codex' })).toMatchObject({ externalSessionId: 'group-session' });
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...keys[2]!, provider: 'codex' })).toMatchObject({ externalSessionId: 'room-session' });
    const attachments = await Promise.all(inputs.map((input) => messages.getAttachmentBySource(
      { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId }, input.messageId, 'same-attachment',
    )));
    expect(new Set(attachments.map((attachment) => attachment?.attachmentId)).size).toBe(3);
    expect(attachments.map((attachment) => attachment?.name)).toEqual(['0.png', '1.png', '2.png']);
    const search = await messages.searchMessages({ key: keys[0], text: 'work', limit: 20 });
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject(keys[0]!);
    const recordId = await messages.createWorkRecord('isolated', [{ key: keys[0]!, messageId: inputs[0]!.messageId }]);
    expect(await messages.listWorkRecordMessages(recordId)).toEqual([{ ...keys[0]!, messageId: inputs[0]!.messageId }]);
  });

  it('claims the shared Agent room FIFO, one at a time, with no LINE account and no effect on LINE chats', async () => {
    const keyA = { accountId: 'claim-A', chatType: 'direct', chatId: 'same-chat' } as const;
    await messages.ingestAndRoute(envelope(keyA), { eligible: false });
    const first = await agents.enqueueUiJob({ provider: 'codex', requestId: 'room-1', prompt: 'one', workspacePath: 'C:\\work' });
    const second = await agents.enqueueUiJob({ provider: 'claude', requestId: 'room-2', prompt: 'two', workspacePath: 'C:\\work' });
    expect(await agents.claimNext(keyA)).toBeNull();
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed).toMatchObject({ jobId: first.jobId, sourceType: 'ui', accountId: null, chatType: null, chatId: null, sourceRequestId: 'room-1' });
    expect(await agents.claimNext(AGENT_ROOM_KEY)).toBeNull();
    await agents.failJob(first.jobId);
    expect(await agents.claimNext(AGENT_ROOM_KEY)).toMatchObject({ jobId: second.jobId });
    await agents.failJob(second.jobId);
  });

  it('archives monitor commands without jobs or LINE responses', async () => {
    const key = { accountId: 'monitor-A', chatType: 'group', chatId: 'monitor-chat' } as const;
    for (const text of ['@Agent work', '/agent', '/new', '/stop', '/status']) {
      const input = envelope(key, { text, mentionIds: [], mentionRanges: [] });
      expect((await messages.ingestAndRoute(input, route)).jobId).toBeUndefined();
    }
    const state = await pool.query("SELECT (SELECT count(*) FROM messages WHERE account_id = $1) messages, (SELECT count(*) FROM agent_jobs WHERE account_id = $1) jobs, (SELECT count(*) FROM agent_deliveries d JOIN agent_jobs j USING(job_id) WHERE j.account_id = $1) deliveries", [key.accountId]);
    expect(state.rows[0]).toEqual({ messages: '5', jobs: '0', deliveries: '0' });
  });

  it('saves monitor UI analysis without delivery and activation never delivers it', async () => {
    const key = { accountId: 'ui-monitor', chatType: 'direct', chatId: 'ui-chat' } as const;
    await messages.ingestAndRoute(envelope(key), { eligible: false });
    const job = await agents.enqueueUiJob({ provider: 'claude', requestId: 'ui-only', prompt: 'analyse', workspacePath: 'C:\\work' });
    await agents.claimNext(AGENT_ROOM_KEY);
    await agents.saveFinal(job.jobId, 'analysis');
    expect(await agents.listDeliveries(job.jobId)).toEqual([]);
    const epoch = (await accounts.getControlState()).controlEpoch;
    await assignAgentRole(pool, key.accountId);
    expect((await accounts.activateControl(key.accountId, epoch)).activated).toBe(true);
    expect(await agents.createLineDelivery(job.jobId, epoch, ['analysis'])).toBe(false);
    expect(await agents.listDeliveries(job.jobId)).toEqual([]);
    await accounts.revokeControl(epoch);
  });

  it('revokes old epoch work and A to B to A never resurrects it', async () => {
    const keyA = { accountId: 'fence-A', chatType: 'group', chatId: 'fence-chat' } as const;
    const keyB = { accountId: 'fence-B', chatType: 'group', chatId: 'fence-chat' } as const;
    await accounts.ensureAccount(keyA.accountId);
    await accounts.ensureAccount(keyB.accountId);
    const startEpoch = (await accounts.getControlState()).controlEpoch;
    await assignAgentRole(pool, keyA.accountId);
    expect((await accounts.activateControl(keyA.accountId, startEpoch)).activated).toBe(true);
    const runningKey = { ...keyA, chatId: 'running-chat' };
    const pendingKey = { ...keyA, chatId: 'pending-chat' };
    const sendingKey = { ...keyA, chatId: 'sending-chat' };
    const sentKey = { ...keyA, chatId: 'sent-chat' };
    const queued = await messages.ingestAndRoute(envelope(keyA), route);
    const running = await messages.ingestAndRoute(envelope(runningKey), route);
    const pending = await messages.ingestAndRoute(envelope(pendingKey), route);
    const sending = await messages.ingestAndRoute(envelope(sendingKey), route);
    const sent = await messages.ingestAndRoute(envelope(sentKey), route);
    for (const result of [queued, running, pending, sending, sent]) expect(result.jobId).toEqual(expect.any(String));
    const runningProjection = await agents.claimNext(runningKey);
    await agents.claimNext(pendingKey);
    await agents.saveFinal(pending.jobId!, 'pending');
    expect(await agents.createLineDelivery(pending.jobId!, startEpoch, ['pending'])).toBe(true);
    await agents.claimNext(sendingKey);
    await agents.saveFinal(sending.jobId!, 'sending');
    expect(await agents.createLineDelivery(sending.jobId!, startEpoch, ['sending'])).toBe(true);
    expect(await agents.claimLineDelivery(sending.jobId!, 0, startEpoch)).toMatchObject(sendingKey);
    await agents.claimNext(sentKey);
    await agents.saveFinal(sent.jobId!, 'sent');
    expect(await agents.createLineDelivery(sent.jobId!, startEpoch, ['sent'])).toBe(true);
    expect(await agents.claimLineDelivery(sent.jobId!, 0, startEpoch)).toMatchObject(sentKey);
    expect(await agents.markDeliverySent(sent.jobId!, 0, 'line-sent')).toBe(true);

    const revoke = await accounts.revokeControl(startEpoch);
    expect(revoke.revoked).toBe(true);
    expect(revoke.inFlightJobIds).toContain(running.jobId);
    expect(revoke.cancelledJobs.map((job) => job.jobId)).toEqual(expect.arrayContaining([queued.jobId!, running.jobId!]));
    const cancelledRunning = revoke.cancelledJobs.find((job) => job.jobId === running.jobId)!;
    expect(BigInt(cancelledRunning.revision)).toBeGreaterThan(BigInt(runningProjection!.revision));
    expect(revoke.inFlightDeliveryIds).toHaveLength(1);
    expect((await agents.listDeliveries(pending.jobId!))[0]?.status).toBe('cancelled');
    expect((await agents.listDeliveries(sending.jobId!))[0]?.status).toBe('unknown');
    expect((await agents.listDeliveries(sent.jobId!))[0]?.status).toBe('sent');
    expect(await agents.claimLineDelivery(pending.jobId!, 0, startEpoch)).toBeNull();

    await assignAgentRole(pool, keyB.accountId);
    expect((await accounts.activateControl(keyB.accountId, revoke.controlEpoch)).activated).toBe(true);
    const revokeB = await accounts.revokeControl(revoke.controlEpoch);
    await assignAgentRole(pool, keyA.accountId);
    expect((await accounts.activateControl(keyA.accountId, revokeB.controlEpoch)).activated).toBe(true);
    expect(await agents.createLineDelivery(running.jobId!, revokeB.controlEpoch, ['resurrect'])).toBe(false);
    expect(await agents.claimLineDelivery(pending.jobId!, 0, revokeB.controlEpoch)).toBeNull();
    await accounts.revokeControl(revokeB.controlEpoch);
  });

  it('serializes revoke races with ingest, completion, and delivery claim', async () => {
    const key = { accountId: 'race-fence', chatType: 'direct', chatId: 'race-chat' } as const;
    await accounts.ensureAccount(key.accountId);
    await assignAgentRole(pool, key.accountId);
    let epoch = (await accounts.getControlState()).controlEpoch;
    expect((await accounts.activateControl(key.accountId, epoch)).activated).toBe(true);
    const [revokeDuringIngest, ingest] = await Promise.all([
      accounts.revokeControl(epoch),
      messages.ingestAndRoute(envelope(key), route),
    ]);
    if (ingest.jobId) {
      const state = await pool.query('SELECT status FROM agent_jobs WHERE job_id = $1', [ingest.jobId]);
      expect(state.rows[0].status).toBe('cancelled');
    }
    expect(await agents.claimNext(key)).toBeNull();

    epoch = revokeDuringIngest.controlEpoch;
    await assignAgentRole(pool, key.accountId);
    expect((await accounts.activateControl(key.accountId, epoch)).activated).toBe(true);
    const completionJob = await messages.ingestAndRoute(envelope({ ...key, chatId: 'completion-race' }), route);
    await agents.claimNext({ ...key, chatId: 'completion-race' });
    const [completion, revokeDuringCompletion] = await Promise.allSettled([
      agents.saveFinal(completionJob.jobId!, 'done'),
      accounts.revokeControl(epoch),
    ]);
    const nextEpoch = (revokeDuringCompletion.status === 'fulfilled' ? revokeDuringCompletion.value : await accounts.getControlState()).controlEpoch;
    if (completion.status === 'fulfilled') expect(await agents.createLineDelivery(completionJob.jobId!, epoch, ['done'])).toBe(false);

    await assignAgentRole(pool, key.accountId);
    expect((await accounts.activateControl(key.accountId, nextEpoch)).activated).toBe(true);
    const deliveryKey = { ...key, chatId: 'delivery-race' };
    const deliveryJob = await messages.ingestAndRoute(envelope(deliveryKey), route);
    await agents.claimNext(deliveryKey);
    await agents.saveFinal(deliveryJob.jobId!, 'deliver');
    expect(await agents.createLineDelivery(deliveryJob.jobId!, nextEpoch, ['deliver'])).toBe(true);
    const [, finalRevoke] = await Promise.all([
      agents.claimLineDelivery(deliveryJob.jobId!, 0, nextEpoch),
      accounts.revokeControl(nextEpoch),
    ]);
    expect(finalRevoke.revoked).toBe(true);
    expect((await agents.listDeliveries(deliveryJob.jobId!))[0]?.status).toMatch(/^(unknown|cancelled)$/);
    expect(await agents.claimLineDelivery(deliveryJob.jobId!, 0, nextEpoch)).toBeNull();
  });
});
