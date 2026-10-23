import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type InboundEnvelope } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { MessageRepository } from './message-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let nextId = 0;
const envelope = (chatId: string): InboundEnvelope => ({ eventId: `e${++nextId}`, accountId: 'a', chatType: 'direct', chatId,
  senderId: 'user', messageId: `m${nextId}`, kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: {} });
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted' };

database('agent service lifecycle repository', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let messages: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool); messages = new MessageRepository(pool);
    const accounts = new AccountRepository(pool); await accounts.ensureAccount('a');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'a'");
    await accounts.activateControl('a', 1);
  });
  afterAll(async () => { await close?.(); });

  it('claims a LINE job with source provenance and epoch', async () => {
    const input = envelope('source');
    const { jobId } = await messages.ingestAndRoute(input, route);
    const claimed = await agents.claimNext({ accountId: 'a', chatType: 'direct', chatId: 'source' });
    expect(claimed).toMatchObject({ jobId, sourceType: 'line', sourceMessageId: input.messageId, creationEpoch: 1 });
    expect(await agents.getJob(jobId!)).toMatchObject({ sourceType: 'line', sourceMessageId: input.messageId });
  });

  it('atomically saves final and eligible LINE delivery, with no rows for UI source', async () => {
    const line = envelope('line-final');
    const { jobId } = await messages.ingestAndRoute(line, route);
    await agents.claimNext({ accountId: 'a', chatType: 'direct', chatId: 'line-final' });
    expect(await agents.completeJob(jobId!, 'answer', ['answer'], 1)).not.toBeNull();
    expect(await agents.listDeliveries(jobId!)).toHaveLength(1);
    const ui = await agents.enqueueUiJob({ provider: 'codex', requestId: 'r1', prompt: 'question', workspacePath: 'C:\\trusted' });
    await agents.claimNext(AGENT_ROOM_KEY);
    expect(await agents.completeJob(ui.jobId, 'ui answer', ['ui answer'], 1)).not.toBeNull();
    expect(await agents.listDeliveries(ui.jobId)).toHaveLength(0);
  });

  it('does not complete or deliver a cancelled job', async () => {
    const input = envelope('cancel-final');
    const { jobId } = await messages.ingestAndRoute(input, route);
    await agents.claimNext({ accountId: 'a', chatType: 'direct', chatId: 'cancel-final' });
    expect(await agents.cancelJob(jobId!)).not.toBeNull();
    expect(await agents.completeJob(jobId!, 'late', ['late'], 1)).toBeNull();
    expect(await agents.listDeliveries(jobId!)).toHaveLength(0);
  });

  it('recognizes only a sent Agent delivery as a reply target in the same conversation', async () => {
    const input = envelope('reply-source');
    const { jobId } = await messages.ingestAndRoute(input, route);
    await agents.claimNext({ accountId: 'a', chatType: 'direct', chatId: 'reply-source' });
    await agents.completeJob(jobId!, 'answer', ['answer'], 1);
    await agents.claimLineDelivery(jobId!, 0, 1);
    await agents.markDeliverySent(jobId!, 0, 'sent-line-id');
    expect(await messages.wasDeliveredByAgent({ accountId: 'a', chatType: 'direct', chatId: 'reply-source' }, 'sent-line-id')).toBe(true);
    expect(await messages.wasDeliveredByAgent({ accountId: 'a', chatType: 'direct', chatId: 'other-chat' }, 'sent-line-id')).toBe(false);
  });

  it('keeps LINE and UI resume sessions separate for the same provider and conversation', async () => {
    const input = envelope('source-provenance');
    await messages.ingestAndRoute(input, { eligible: false });
    const key = { accountId: 'a', chatType: 'direct' as const, chatId: 'source-provenance', provider: 'codex' as const };
    const roomKey = { ...AGENT_ROOM_KEY, provider: 'codex' as const };
    expect(await agents.bindSession({ workspacePath: 'C:\\trusted', ...key, sourceType: 'line', externalSessionId: 'line-session', generation: 0 })).toBe(true);
    expect(await agents.lookupSession({ workspacePath: 'C:\\trusted', ...roomKey, sourceType: 'ui' })).toBeNull();
    expect(await agents.bindSession({ workspacePath: 'C:\\trusted', ...roomKey, sourceType: 'ui', externalSessionId: 'ui-session', generation: 0 })).toBe(true);
    expect(await agents.lookupSession({ workspacePath: 'C:\\trusted', ...key, sourceType: 'line' })).toMatchObject({ externalSessionId: 'line-session' });
    expect(await agents.lookupSession({ workspacePath: 'C:\\trusted', ...roomKey, sourceType: 'ui' })).toMatchObject({ externalSessionId: 'ui-session' });
    const uiJob = await agents.enqueueUiJob({ provider: 'codex', requestId: 'r', prompt: 'work', workspacePath: 'C:\\trusted' });
    await agents.claimNext(AGENT_ROOM_KEY);
    const request = { jobId: uiJob.jobId, provider: 'codex' as const,
      source: { type: 'ui' as const, requestId: 'r' },
      prompt: 'work', workspacePath: 'C:\\trusted', resumeSessionId: 'line-session' };
    expect(await agents.validateResumeSession(request)).toEqual({ status: 'invalid' });
    expect(await agents.validateResumeSession({ ...request, resumeSessionId: 'ui-session' })).toEqual({ status: 'valid' });
    await pool.query('UPDATE agent_jobs SET workspace_path=$2 WHERE job_id=$1',[uiJob.jobId,'C:\\alias']);
    expect(await agents.validateResumeSession({ ...request, resumeSessionId: 'ui-session' })).toEqual({ status: 'valid' });
    expect(await agents.validateResumeSession({ ...request, workspacePath: 'C:\\retargeted', resumeSessionId: 'ui-session' })).toEqual({ status: 'workspace_mismatch' });
  });
  it('scopes job event and cancellation operations to the authoritative conversation key', async () => {
    const input = envelope('owned-job');
    const { jobId } = await messages.ingestAndRoute(input, route);
    const owner = { accountId: 'a', chatType: 'direct' as const, chatId: 'owned-job' };
    const forged = { accountId: 'a', chatType: 'direct' as const, chatId: 'other-job' };
    await agents.appendEvent(jobId!, { type: 'text_delta', text: 'progress' });
    expect(await agents.listJobEvents(owner, jobId!)).toEqual([{ type: 'text_delta', text: 'progress' }]);
    expect(await agents.listJobEvents(forged, jobId!)).toEqual([]);
    expect(await agents.cancelJobForKey(forged, jobId!)).toBeNull();
    expect((await agents.getJob(jobId!))?.status).toBe('queued');
    expect(await agents.cancelJobForKey(owner, jobId!)).not.toBeNull();
  });
  it('allows only an owned failed job to be manually requeued', async () => {
    const input = envelope('manual-retry');
    const { jobId } = await messages.ingestAndRoute(input, route);
    const owner = { accountId: 'a', chatType: 'direct' as const, chatId: 'manual-retry' };
    await agents.claimNext(owner);
    await agents.failJob(jobId!);
    expect(await agents.retryJobForKey({ ...owner, chatId: 'forged' }, jobId!, 'C:\\work')).toBeNull();
    expect(await agents.retryJobForKey(owner, jobId!, 'C:\\work')).not.toBeNull();
    expect((await agents.getJob(jobId!))?.status).toBe('queued');
  });
});
