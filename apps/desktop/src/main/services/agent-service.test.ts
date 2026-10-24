import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type AgentEvent, type AgentRunRequest, type WritableConversationKey, type InboundEnvelope } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AgentRepository, MessageRepository, SettingsRepository } from '../../../../../packages/database/src/index.js';
import { newAgentService } from './agent-service-test-support.js';
import { HEARTBEAT_INTERVAL_MS } from './agent-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let id = 0;
function envelope(chatId: string): InboundEnvelope {
  id++;
  return { eventId: `e${id}`, accountId: 'a', chatType: 'direct', chatId, senderId: 'user', messageId: `m${id}`,
    kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: {} };
}
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted' };
const key = (chatId: string): WritableConversationKey => ({ accountId: 'a', chatType: 'direct', chatId });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Timed out waiting for service state');
}

describe('terminal state publication ordering', () => {
  it('releases transferred global and account slots when shutdown wins after claim and cancellation fails', async () => {
    let claim!: (job: NonNullable<Awaited<ReturnType<AgentRepository['claimNext']>>>) => void;
    let entered!: () => void;
    const claimEntered = new Promise<void>((resolve) => { entered = resolve; });
    const pendingClaim = new Promise<NonNullable<Awaited<ReturnType<AgentRepository['claimNext']>>>>((resolve) => { claim = resolve; });
    const job = { jobId: 'shutdown-claim', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'shutdown-request', creationEpoch: null, revision: '100' };
    const repository = { async claimNext() { entered(); return pendingClaim; }, async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '101' }; } };
    let runs = 0; let cancels = 0;
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { runs++; }, async cancel() { cancels++; throw new Error('cancel failed'); },
    }, undefined, undefined, 1, 30_000, 5_000, 1);
    service.kick(key('shutdown-chat'));
    await claimEntered;
    const stopping = service.shutdown();
    claim(job);
    await stopping;
    const inventory = service as unknown as { activeJobs: Map<string, string>; activeAccountSlots: Map<string, number>; reservedProviderSlots: number; reservedAccountSlots: Map<string, number> };
    expect(runs).toBe(0);
    expect(cancels).toBe(1);
    expect(inventory.activeJobs.size).toBe(0);
    expect(inventory.activeAccountSlots.size).toBe(0);
    expect(inventory.reservedProviderSlots).toBe(0);
    expect(inventory.reservedAccountSlots.size).toBe(0);
  });

  it('transfers a claimed reservation before a delayed status publication can settle', async () => {
    let claimed = false; let started = false; let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const job = { jobId: 'reservation-job', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'reservation-request', creationEpoch: null, revision: '100' };
    const repository = { async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {},
      async completeJob() { return { ...job, status: 'completed' as const, revision: '101' }; } };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; yield { type: 'completed' as const, finalText: 'done' }; }, async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, () => delayed);
    try {
      service.kick(key('reservation-chat'));
      await until(() => started);
      await service.idle();
      expect(started).toBe(true);
    } finally { release(); await service.shutdown().catch(() => undefined); }
  });

  it('publishes committed running and failure lifecycle states from the owning service path', async () => {
    const order: string[] = [];
    let claimed = false;
    let status: 'running' | 'failed' = 'running';
    const job = { jobId: 'job-lifecycle', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'line' as const, sourceMessageId: 'source-message', sourceRequestId: null, creationEpoch: 0, revision: '100' };
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return { ...job, status }; }, async lookupSession() { return null; }, async appendEvent() { order.push('persist-event'); },
      async failJob() { status = 'failed'; order.push('commit-failed'); return { ...job, status: 'failed', revision: '101' }; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' },
      { async *run() { yield { type: 'failed' as const, code: 'NO', message: 'failed', retryable: false }; }, async cancel() {} },
      undefined, undefined, 2, 30_000, 5_000, 1, undefined,
      undefined,
      (projection) => { order.push(`publish-${projection.status}`); });
    service.kick(key('c'));
    await service.idle();
    expect(order).toEqual(['publish-running', 'persist-event', 'commit-failed', 'publish-failed']);
  });

  it('publishes the committed LINE failure projection when MCP prompt context is denied', async () => {
    const order: string[] = [];
    const projections: Array<{ status: string; revision: string }> = [];
    let claimed = false;
    const job = { jobId: 'job-mcp-context-denied', accountId: 'a', chatType: 'direct' as const, chatId: 'mcp-denied', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'line' as const, sourceMessageId: 'source-denied', sourceRequestId: null, creationEpoch: 0, revision: '100' };
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async appendEvent() { order.push('persist-event'); },
      async lookupSession() { return null; },
      async failJob() { order.push('commit-failed'); return { ...job, status: 'failed' as const, revision: '101' }; },
    };
    let providerRuns = 0;
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { providerRuns++; }, async cancel() {},
    }, (_jobId, event) => { if (event.type === 'failed') order.push('emit-failed'); }, undefined,
    1, 30_000, 5_000, 1, undefined,
    async () => { throw new Error('MCP context denied'); },
    (projection) => { projections.push({ status: projection.status, revision: projection.revision }); order.push(`publish-${projection.status}`); });
    service.kick(key('mcp-denied'));
    await service.idle();
    const inventory = service as unknown as { activeJobs: Map<string, string>; activeAccountSlots: Map<string, number>; reservedProviderSlots: number; reservedAccountSlots: Map<string, number> };
    expect(projections).toEqual([{ status: 'running', revision: '100' }, { status: 'failed', revision: '101' }]);
    expect(order).toEqual(['publish-running', 'persist-event', 'commit-failed', 'publish-failed', 'emit-failed']);
    expect(providerRuns).toBe(0);
    expect(inventory.activeJobs.size).toBe(0);
    expect(inventory.activeAccountSlots.size).toBe(0);
    expect(inventory.reservedProviderSlots).toBe(0);
    expect(inventory.reservedAccountSlots.size).toBe(0);
  });

  it('does not publish a failed lifecycle event when prompt-context failure has no committed transition', async () => {
    let claimed = false;
    const job = { jobId: 'job-mcp-context-no-transition', accountId: 'a', chatType: 'direct' as const, chatId: 'mcp-no-transition', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'line' as const, sourceMessageId: 'source-no-transition', sourceRequestId: null, creationEpoch: 0, revision: '200' };
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async appendEvent() {}, async lookupSession() { return null; }, async failJob() { return null; },
    };
    const projections: Array<{ status: string; revision: string }> = [];
    const emitted: AgentEvent[] = [];
    let providerRuns = 0;
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { providerRuns++; }, async cancel() {},
    }, (_jobId, event) => { emitted.push(event); }, undefined,
    1, 30_000, 5_000, 1, undefined,
    async () => { throw new Error('MCP context denied'); },
    (projection) => { projections.push({ status: projection.status, revision: projection.revision }); });
    service.kick(key('mcp-no-transition'));
    await service.idle();
    expect(projections).toEqual([{ status: 'running', revision: '200' }]);
    expect(emitted).toEqual([]);
    expect(providerRuns).toBe(0);
  });

  it('publishes started after the provider session is bound', async () => {
    const order: string[] = [];
    let claimed = false;
    const job = { jobId: 'job-started', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() { order.push('persist-event'); },
      async bindSession() { order.push('bind-session'); return true; }, async completeJob() { return true; },
      async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' },
      { async *run() { yield { type: 'started' as const, externalSessionId: 'session-1', workspacePath: 'C:\\trusted' }; }, async cancel() {} },
      (_jobId, event) => { if (event.type === 'started') order.push('publish-started'); });

    service.kick(key('c'));
    await service.idle();

    expect(order).toEqual(['persist-event', 'bind-session', 'publish-started']);
  });

  it('publishes completed only after completeJob commits', async () => {
    const order: string[] = [];
    let claimed = false;
    const job = { jobId: 'job-1', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() { order.push('persist-event'); },
      async bindSession() { return true; }, async completeJob() { order.push('complete-commit'); return true; },
      async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' },
      { async *run() { yield { type: 'completed' as const, finalText: 'answer' }; }, async cancel() {} },
      (_jobId, event) => { if (event.type === 'completed') order.push('publish-terminal'); });

    service.kick(key('c'));
    await service.idle();

    expect(order).toEqual(['persist-event', 'complete-commit', 'publish-terminal']);
  });
});

describe('LINE execution reactions', () => {
  it('uses the shared scheduler deadline to cancel and fail a LINE job with SAD', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let announceStart!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announceStart = resolve; });
    let claimed = false;
    const job = { jobId: 'reaction-timeout', accountId: 'a', chatType: 'direct' as const, chatId: 'chat-timeout', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as 'running' | 'failed',
      sourceType: 'line' as const, sourceMessageId: 'source-timeout', sourceRequestId: null, creationEpoch: 1 };
    let cancelCalls = 0;
    const events: AgentEvent[] = [];
    const reactions: string[] = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent(_jobId: string, event: AgentEvent) { events.push(event); },
      async bindSession() { return true; }, async completeJob() { return true; },
      async failJob() { job.status = 'failed'; return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { announceStart(); await gate; yield { type: 'completed' as const, finalText: 'late' }; },
      async cancel() { cancelCalls++; release(); },
    }, undefined, undefined, 2, 5_000, 5000, 1,
    async (_jobId, _key, _messageId, reaction) => { reactions.push(reaction); });

    try {
      service.kick(key(job.chatId));
      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      await service.idle();
      for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();

      expect(cancelCalls).toBe(1);
      expect(job.status).toBe('failed');
      expect(events).toEqual([expect.objectContaining({ type: 'failed', code: 'TIMEOUT' })]);
      expect([...reactions]).toEqual(['NICE', 'SAD']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await service.idle();
      vi.useRealTimers();
    }
  });

  it.each([
    { event: { type: 'failed' as const, code: 'PROVIDER_ERROR', message: 'no', retryable: false }, reaction: 'SAD' },
    { event: { type: 'cancelled' as const }, reaction: 'FUN' },
    { event: { type: 'completed' as const, finalText: 'done' }, reaction: 'LOVE' },
  ])('uses $reaction for a persisted LINE terminal state', async ({ event, reaction }) => {
    let claimed = false;
    const job = { jobId: `reaction-${reaction}`, accountId: 'a', chatType: 'direct' as const, chatId: `chat-${reaction}`,
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as 'running' | 'failed' | 'cancelled', sourceType: 'line' as const,
      sourceMessageId: `source-${reaction}`, sourceRequestId: null, creationEpoch: 1 };
    const reactions: string[] = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { job.status = 'failed'; return true; },
      async cancelJob() { job.status = 'cancelled'; return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { yield event; }, async cancel() {},
    }, undefined, undefined, 2, 60_000, 5000, 1,
    async (_jobId, _key, _messageId, value) => { reactions.push(value); });

    service.kick(key(job.chatId));
    await service.idle();
    for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();

    expect([...reactions]).toEqual(['NICE', reaction]);
  });

  it('delivers the terminal reaction after an unresolved heartbeat without delaying job completion', async () => {
    let releaseHeartbeat!: () => void;
    const heartbeat = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    let claimed = false;
    const job = { jobId: 'reaction-terminal', accountId: 'a', chatType: 'direct' as const, chatId: 'chat-terminal', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'line' as const, sourceMessageId: 'source-terminal', sourceRequestId: null, creationEpoch: 1 };
    const reactions: string[] = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { yield { type: 'completed' as const, finalText: 'done' }; }, async cancel() {},
    }, undefined, undefined, 2, 60_000, 5000, 1, async (_jobId, _key, _messageId, reaction) => {
      reactions.push(reaction);
      if (reaction === 'NICE') await heartbeat;
    });

    service.kick(key(job.chatId));
    await service.idle();
    await Promise.resolve();
    expect([...reactions]).toEqual(['NICE']);

    releaseHeartbeat();
    await tick();

    expect([...reactions]).toEqual(['NICE', 'LOVE']);
  });

  it('shares one scheduler across active LINE jobs and rotates their heartbeat reactions', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = [
      { jobId: 'reaction-a', accountId: 'a', chatType: 'direct' as const, chatId: 'chat-a', provider: 'codex' as const,
        prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
        sourceType: 'line' as const, sourceMessageId: 'source-a', sourceRequestId: null, creationEpoch: 1 },
      { jobId: 'reaction-b', accountId: 'b', chatType: 'direct' as const, chatId: 'chat-b', provider: 'codex' as const,
        prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
        sourceType: 'line' as const, sourceMessageId: 'source-b', sourceRequestId: null, creationEpoch: 1 },
    ];
    const started = new Set<string>();
    const reactions: string[] = [];
    const repository = {
      async claimNext(conversation: WritableConversationKey) { return jobs.find((job) => job.chatId === conversation.chatId) ?? null; },
      async getJob(jobId: string) { return jobs.find((job) => job.jobId === jobId) ?? null; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { started.add(request.jobId); await gate; yield { type: 'completed' as const, finalText: 'done' }; },
      async cancel() {},
    }, undefined, undefined, 2, 60_000, 5000, 1,
    async (_jobId, _key, _messageId, reaction) => { reactions.push(reaction); });

    try {
      service.kick(key('chat-a'));
      service.kick({ accountId: 'b', chatType: 'direct', chatId: 'chat-b' });
      for (let attempt = 0; attempt < 20 && started.size < 2; attempt++) await Promise.resolve();
      for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();
      expect(started.size).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      expect([...reactions]).toEqual(['NICE', 'NICE']);

      expect(HEARTBEAT_INTERVAL_MS).toBe(10_000);
      await vi.advanceTimersByTimeAsync(9_999);
      expect([...reactions]).toEqual(['NICE', 'NICE']);
      await vi.advanceTimersByTimeAsync(1);

      expect([...reactions]).toEqual(['NICE', 'NICE', 'AMAZING', 'AMAZING']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...reactions]).toEqual(['NICE', 'NICE', 'AMAZING', 'AMAZING', 'FUN', 'FUN']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...reactions]).toEqual(['NICE', 'NICE', 'AMAZING', 'AMAZING', 'FUN', 'FUN', 'NICE', 'NICE']);
      reactions.length = 0;
      release();
      await service.idle();
      for (let attempt = 0; attempt < 8; attempt++) await Promise.resolve();
      expect([...reactions]).toEqual(['LOVE', 'LOVE']);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...reactions]).toEqual(['LOVE', 'LOVE']);
    } finally {
      release();
      await service.idle();
      vi.useRealTimers();
    }
  });

  it('retimes running LINE reactions from the update time on the shared scheduler', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = { jobId: 'reaction-retime', accountId: 'a', chatType: 'direct' as const, chatId: 'retime', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const,
      sourceType: 'line' as const, sourceMessageId: 'source-retime', sourceRequestId: null, creationEpoch: 1 };
    let claimed = false;
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    };
    const reactions: string[] = [];
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { await gate; yield { type: 'completed' as const, finalText: 'done' }; }, async cancel() {},
    }, undefined, undefined, 1, 60_000, 5000, 1,
    async (_jobId, _key, _messageId, reaction) => { reactions.push(reaction); });

    try {
      service.kick(key('retime'));
      for (let attempt = 0; attempt < 12 && reactions.length === 0; attempt++) await Promise.resolve();
      expect(reactions).toEqual(['NICE']);
      expect(() => service.setStatusRotationIntervalSeconds(86_401)).toThrow();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(4_000);
      service.setStatusRotationIntervalSeconds(5);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(reactions).toEqual(['NICE']);
      await vi.advanceTimersByTimeAsync(1);
      expect(reactions).toEqual(['NICE', 'AMAZING']);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      release();
      await service.idle();
      vi.useRealTimers();
    }
  });
});

describe('six-state LINE reactions', () => {
  const lineJob = (jobId: string, chatId: string, status: string, sourceMessageId: string | null = '4242') => ({
    jobId, accountId: 'a', chatType: 'direct' as const, chatId, provider: 'codex' as const,
    prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: status as 'running' | 'interrupted',
    sourceType: 'line' as const, sourceMessageId, sourceRequestId: null, creationEpoch: 1 });
  const projection = (job: ReturnType<typeof lineJob>, status: string) => ({
    jobId: job.jobId, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, sourceType: 'line' as const,
    sourceMessageId: job.sourceMessageId, status: status as 'cancelled', revision: '1' });
  const idleRunner = { async *run() { /* never used */ }, async cancel() {} };
  const emptyRepository = {} as unknown as AgentRepository;
  const newService = (reactions: Array<[string, string, string]>, repository: unknown = emptyRepository) =>
    newAgentService(repository as AgentRepository, { current: async () => 'C:\\trusted' }, idleRunner,
      undefined, undefined, 2, 60_000, 5000, 1,
      async (_jobId, _key, messageId, reaction, phase) => { reactions.push([messageId, reaction, phase]); });

  it('sends AMAZING once for a newly queued LINE job and nothing for failed, UI or non-numeric ones', async () => {
    const reactions: Array<[string, string, string]> = [];
    const service = newService(reactions);
    const queued = { jobId: 'q1', accountId: 'a', chatType: 'direct' as const, chatId: 'chat-q', sourceMessageId: '4242', status: 'queued' as const };
    service.noteQueued(queued);
    service.noteQueued({ ...queued, jobId: 'q2', status: 'failed' as never });
    service.noteQueued({ ...queued, jobId: 'q3', sourceMessageId: null });
    service.noteQueued({ ...queued, jobId: 'q4', sourceMessageId: 'not-numeric' });
    await tick();
    expect(reactions).toEqual([['4242', 'AMAZING', 'queued']]);
  });

  it('never lets a failing queued reaction throw, and keeps one in flight per account', async () => {
    let inFlight = 0; let maxInFlight = 0; const seen: string[] = [];
    const service = newAgentService(emptyRepository, { current: async () => 'C:\\trusted' }, idleRunner,
      undefined, undefined, 2, 60_000, 5000, 1, async (_jobId, _key, messageId) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); seen.push(messageId);
        await tick(); inFlight--;
        if (messageId === '1') throw new Error('boom');
      });
    for (const messageId of ['1', '2', '3']) {
      expect(() => service.noteQueued({ jobId: `j${messageId}`, accountId: 'a', chatType: 'direct', chatId: 'c',
        sourceMessageId: messageId, status: 'queued' })).not.toThrow();
    }
    await until(() => seen.length === 3 && inFlight === 0);
    expect(maxInFlight).toBe(1);
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('sends FUN when a still-queued LINE job is cancelled by stopJob, and nothing for a UI job', async () => {
    const queuedJob = lineJob('queued-stop', 'chat-stop', 'queued');
    const uiProjection = { jobId: 'ui', accountId: null, chatType: 'agent_room', chatId: 'agent-room', sourceType: 'ui' as const,
      sourceMessageId: null, status: 'cancelled' as const, revision: '1' };
    const reactions: Array<[string, string, string]> = [];
    const service = newService(reactions, {
      async cancelJobForKey(_key: unknown, jobId: string) { return jobId === 'ui' ? uiProjection : projection(queuedJob, 'cancelled'); },
    });
    expect(await service.stopJob(key('chat-stop'), 'queued-stop')).toBe(true);
    expect(await service.stopJob(AGENT_ROOM_KEY, 'ui')).toBe(true);
    await tick();
    expect(reactions).toEqual([['4242', 'FUN', 'cancelled']]);
  });

  it('sends FUN for every queued job cancelled by stopChat and resetChat', async () => {
    const first = lineJob('queued-1', 'chat-reset', 'queued', '11');
    const second = lineJob('queued-2', 'chat-reset', 'queued', '12');
    const reactions: Array<[string, string, string]> = [];
    const service = newService(reactions, {
      async cancelConversationJobs() { return [projection(first, 'cancelled')]; },
      async resetConversationForMessage() { return { result: 'applied', cancelledJobIds: ['queued-2'], cancelledJobs: [projection(second, 'cancelled')] }; },
      async listQueuedConversations() { return []; },
      async claimNext() { return null; },
    });
    await service.stopChat(key('chat-reset'));
    await service.resetChat(key('chat-reset'), 'command-1');
    await tick();
    expect(reactions).toEqual([['11', 'FUN', 'cancelled'], ['12', 'FUN', 'cancelled']]);
  });

  it('sends OMG when an active execution ends interrupted, and nothing for a startup-recovered interrupt', async () => {
    let claimed = false;
    const job = lineJob('runtime-interrupt', 'chat-interrupt', 'running');
    const reactions: Array<[string, string, string]> = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return null; }, async cancelJob() { return null; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { job.status = 'interrupted'; yield { type: 'completed' as const, finalText: 'late' }; }, async cancel() {},
    }, undefined, undefined, 2, 60_000, 5000, 1,
    async (_jobId, _key, messageId, reaction, phase) => { reactions.push([messageId, reaction, phase]); });
    service.kick(key('chat-interrupt'));
    await service.idle();
    await tick();
    expect(reactions).toEqual([['4242', 'NICE', 'running'], ['4242', 'OMG', 'interrupted']]);

    // Startup recovery marks jobs interrupted with no execution: no service method is involved and nothing is sent.
    const recovered: Array<[string, string, string]> = [];
    const recoveredService = newService(recovered, { async listQueuedConversations() { return []; } });
    await recoveredService.recoverQueued();
    await tick();
    expect(recovered).toEqual([]);
  });
});

describe('global Agent execution capacity', () => {
  it('refills durable discovery when stop releases a fenced FIFO head', async () => {
    const stopped = { jobId: 'fenced-head', accountId: 'a', chatType: 'direct' as const, chatId: 'chat-x', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'queued' as 'queued' | 'cancelled',
      sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'x', creationEpoch: null };
    const later = { ...stopped, jobId: 'later-head', chatId: 'chat-y', sourceRequestId: 'y', status: 'queued' as 'queued' | 'running' | 'completed' };
    let releaseCancel!: () => void;
    let announceCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const cancelStarted = new Promise<void>((resolve) => { announceCancel = resolve; });
    const started: string[] = [];
    const repository = {
      async cancelConversationJobs() { announceCancel(); await cancelGate; stopped.status = 'cancelled'; },
      async listQueuedConversations(limit: number) {
        const head = stopped.status === 'queued' ? stopped : later.status === 'queued' ? later : undefined;
        return head && limit > 0 ? [{ accountId: head.accountId, chatType: head.chatType, chatId: head.chatId }] : [];
      },
      async claimNext(conversation: WritableConversationKey) {
        if (conversation.chatId === stopped.chatId && stopped.status === 'queued') { stopped.status = 'cancelled'; return stopped; }
        if (conversation.chatId === later.chatId && later.status === 'queued') { later.status = 'running'; return later; }
        return null;
      },
      async getJob(jobId: string) { return jobId === later.jobId ? later : stopped; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { later.status = 'completed'; return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { started.push(request.jobId); yield { type: 'completed' as const, finalText: 'done' }; }, async cancel() {},
    }, undefined, undefined, 2);

    const stop = service.stopChat(key(stopped.chatId));
    await cancelStarted;
    await service.recoverQueued();
    releaseCancel();
    await stop;
    await until(() => started.includes(later.jobId));
    await service.idle();

    expect(started).toEqual([later.jobId]);
  });

  it('reserves one provider slot per account while another account is waiting', async () => {
    const keys = [
      { accountId: 'account-a', chatType: 'direct' as const, chatId: 'a-first' },
      { accountId: 'account-a', chatType: 'direct' as const, chatId: 'a-second' },
      { accountId: 'account-b', chatType: 'direct' as const, chatId: 'b-first' },
    ];
    const jobs = new Map(keys.map((conversation, index) => [conversation.chatId, {
      jobId: `fair-job-${index}`, ...conversation, provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted',
      generation: 0, status: 'queued' as const, sourceType: 'ui' as const, sourceMessageId: null,
      sourceRequestId: conversation.chatId, creationEpoch: null,
    }]));
    const running = new Set<string>();
    const repository = {
      async claimNext(conversation: WritableConversationKey) {
        const job = jobs.get(conversation.chatId);
        if (!job || job.status !== 'queued' || running.has(conversation.chatId)) return null;
        (job as { status: 'queued' | 'running' }).status = 'running'; running.add(conversation.chatId);
        return job;
      },
      async listQueuedConversations(limit: number) {
        return keys.filter((conversation) => jobs.get(conversation.chatId)?.status === 'queued').slice(0, limit);
      },
      async getJob(jobId: string) { return [...jobs.values()].find((job) => job.jobId === jobId) ?? null; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob(jobId: string) {
        const job = [...jobs.values()].find((candidate) => candidate.jobId === jobId);
        if (job) (job as { status: 'queued' | 'running' | 'completed' }).status = 'completed';
        return true;
      },
      async failJob() { return true; }, async cancelJob() { return true; },
    };
    const releases = new Map<string, () => void>();
    const started = new Set<string>();
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request: AgentRunRequest) {
        const sourceId = request.source.type === 'ui' ? request.source.requestId : request.source.messageId;
        started.add(sourceId);
        await new Promise<void>((resolve) => releases.set(sourceId, resolve));
        yield { type: 'completed' as const, finalText: 'done' };
      }, async cancel(jobId) { releases.get(jobId)?.(); },
    }, undefined, undefined, 2);

    service.kick(keys[0]!);
    await until(() => started.has('a-first'));
    await service.recoverQueued();
    await until(() => started.has('b-first'));
    expect([...started].sort()).toEqual(['a-first', 'b-first']);
    releases.get('a-first')?.();
    await until(() => started.has('a-second'));
    expect(started.has('b-first')).toBe(true);
    releases.get('a-second')?.(); releases.get('b-first')?.();
    await service.idle();
  });

  it('repeats durable refill when a second slot opens during an in-flight refill query', async () => {
    const jobs = new Map<string, any>();
    const queued: WritableConversationKey[] = [];
    for (const chatId of ['refill-a', 'refill-b']) jobs.set(chatId, {
      jobId: chatId, accountId: 'a', chatType: 'direct', chatId, provider: 'codex', prompt: 'work', workspacePath: 'C:\\trusted',
      generation: 0, status: 'running', sourceType: 'ui', sourceMessageId: null, sourceRequestId: chatId, creationEpoch: null,
    });
    let scanStarted!: () => void; let releaseScan!: () => void; let gateFirstScan = true;
    const scanReady = new Promise<void>((resolve) => { scanStarted = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const claimed = new Set<string>();
    const repository = {
      async claimNext(conversation: WritableConversationKey) {
        const job = jobs.get(conversation.chatId);
        if (!job || claimed.has(conversation.chatId)) return null;
        claimed.add(conversation.chatId); job.status = 'running'; return job;
      },
      async listQueuedConversations(limit: number) {
        const snapshot = queued.filter((conversation) => jobs.get(conversation.chatId)?.status === 'queued').slice(0, limit);
        if (gateFirstScan) { gateFirstScan = false; scanStarted(); await scanGate; }
        return snapshot;
      },
      async getJob(jobId: string) { return [...jobs.values()].find((job) => job.jobId === jobId) ?? null; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const releases = new Map<string, () => void>();
    const started = new Set<string>();
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request: AgentRunRequest) {
        started.add(request.source.type === 'ui' ? request.source.requestId : request.source.messageId);
        await new Promise<void>((resolve) => releases.set(request.jobId, resolve));
        yield { type: 'completed' as const, finalText: 'done' };
    }, async cancel(jobId) { releases.get(jobId)?.(); },
    }, undefined, undefined, 2, 30 * 60 * 1000, 5000, 2);
    service.kick(key('refill-a')); service.kick(key('refill-b'));
    await until(() => releases.size === 2);
    releases.get('refill-a')?.();
    await scanReady;
    const late = { jobId: 'refill-late', accountId: 'a', chatType: 'direct' as const, chatId: 'refill-late', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'queued' as const, sourceType: 'ui' as const,
      sourceMessageId: null, sourceRequestId: 'refill-late', creationEpoch: null };
    jobs.set(late.chatId, late); queued.push(key(late.chatId));
    releases.get('refill-b')?.();
    releaseScan();

    await until(() => started.has('refill-late'));
    releases.get(late.jobId)?.();
    await service.idle();
    expect(started.has('refill-late')).toBe(true);
  });

  it('does not leave a timed-out job running when the first timeout event write fails', async () => {
    const job = { jobId: 'timeout-write-job', accountId: 'a', chatType: 'direct' as const, chatId: 'timeout-write',
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as 'running' | 'failed', sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    let claimed = false; let release!: () => void; let status: 'running' | 'failed' = 'running'; let timeoutWrites = 0;
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return { ...job, status }; }, async lookupSession() { return null; },
      async appendEvent(_jobId: string, event: AgentEvent) {
        if (event.type === 'failed' && event.code === 'TIMEOUT' && timeoutWrites++ === 0) throw new Error('temporary database write failure');
      }, async bindSession() { return true; }, async completeJob() { return true; },
      async failJob() { status = 'failed'; return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { await new Promise<void>((resolve) => { release = resolve; }); yield { type: 'cancelled' as const }; },
      async cancel() { release(); },
    }, undefined, undefined, 1, 10);

    service.kick(key('timeout-write'));
    await service.idle();

    expect(status).toBe('failed');
    expect(timeoutWrites).toBeGreaterThanOrEqual(2);
  });

  it('bounds shutdown after cancellation fails while quarantining the live provider slot', async () => {
    const job = { jobId: 'quarantined-job', accountId: 'a', chatType: 'direct' as const, chatId: 'quarantined',
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    let claimed = false; let release!: () => void; let started = false;
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; await new Promise<void>((resolve) => { release = resolve; }); yield { type: 'completed' as const, finalText: 'done' }; },
      async cancel() { throw new Error('child exit remains unconfirmed'); },
    }, undefined, undefined, 1, 30_000, 25);

    service.kick(key('quarantined'));
    await until(() => started);
    const shutdown = service.shutdown().then(() => 'settled', () => 'settled');
    const outcome = await Promise.race([shutdown, new Promise<'unbounded'>((resolve) => setTimeout(() => resolve('unbounded'), 100))]);

    expect(outcome).toBe('settled');
    expect(await service.getChatStatus(key('quarantined'))).toEqual({ runningJobId: 'quarantined-job' });
    release();
    await service.idle();
  });

  it('does not refill-spin a conversation held by delayed stop until the durable cancel finishes', async () => {
    const active = { jobId: 'stop-active', accountId: 'a', chatType: 'direct' as const, chatId: 'stop-held', provider: 'codex' as const,
      prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const, sourceType: 'ui' as const,
      sourceMessageId: null, sourceRequestId: 'active', creationEpoch: null };
    const queued = { ...active, jobId: 'stop-queued', status: 'queued' as 'queued' | 'cancelled', sourceRequestId: 'queued' };
    const later = { ...active, jobId: 'stop-later', status: 'queued' as 'queued' | 'running', sourceRequestId: 'later' };
    let releaseRun!: () => void; let releaseLater!: () => void; let releaseCancel!: () => void;
    let claimed = false; let laterClaimed = false; let scans = 0;
    let scansWhileHeld = 0; let cancelReleased = false;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const laterGate = new Promise<void>((resolve) => { releaseLater = resolve; });
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const repository = {
      async claimNext() {
        if (!claimed) { claimed = true; return active; }
        if (!laterClaimed && later.status === 'queued') { laterClaimed = true; later.status = 'running'; return later; }
        return null;
      },
      async listQueuedConversations(limit: number) {
        scans++;
        if (scans >= 10) { scansWhileHeld = scans; cancelReleased = true; releaseCancel(); }
        return [queued, later].some((job) => job.status === 'queued') ? [key('stop-held')].slice(0, limit) : [];
      },
      async cancelConversationJobs() { await cancelGate; queued.status = 'cancelled'; },
      async getJob(jobId: string) { return jobId === later.jobId ? later : active; }, async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const started: string[] = [];
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) {
        started.push(request.jobId);
        if (request.jobId === active.jobId) await runGate;
        else await laterGate;
        yield { type: 'completed' as const, finalText: 'done' };
      }, async cancel() {},
    });
    service.kick(key('stop-held'));
    await until(() => claimed);
    const stopping = service.stopChat(key('stop-held'));
    await until(() => started.includes(active.jobId));
    // Work arriving while stop holds the conversation remains durable and is
    // picked up by the release wakeup rather than by a refill spin.
    const releaseTimer = setTimeout(() => {
      if (cancelReleased) return;
      scansWhileHeld = scans; cancelReleased = true; releaseCancel();
    }, 20);
    (queued as { status: 'queued' | 'cancelled' }).status = 'queued';
    later.status = 'queued';
    releaseRun();
    await stopping;
    clearTimeout(releaseTimer);
    await until(() => started.includes(later.jobId));
    releaseLater();
    await service.idle();

    expect(scansWhileHeld).toBeLessThan(10);
  });

  it('cancels TIMEOUT persistence backoff on shutdown after the provider has exited', async () => {
    const job = { jobId: 'timeout-shutdown', accountId: 'a', chatType: 'direct' as const, chatId: 'timeout-shutdown',
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    let claimed = false; let release!: () => void; let cancelCalls = 0; let failCalls = 0;
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; },
      async appendEvent(_jobId: string, event: AgentEvent) { if (event.type === 'failed' && event.code === 'TIMEOUT') throw new Error('database unavailable'); },
      async bindSession() { return true; }, async completeJob() { return true; },
      async failJob() { failCalls++; throw new Error('database unavailable'); },
      async cancelJob() { throw new Error('database unavailable during shutdown'); },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { await new Promise<void>((resolve) => { release = resolve; }); yield { type: 'cancelled' as const }; },
      async cancel() { cancelCalls++; release(); },
    }, undefined, undefined, 1, 10, 100);

    service.kick(key('timeout-shutdown'));
    await until(() => failCalls > 0);
    await service.shutdown().catch(() => undefined);
    const attemptsAtShutdown = failCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    expect(await service.getChatStatus(key('timeout-shutdown'))).toEqual({ runningJobId: null });
    expect(failCalls).toBe(attemptsAtShutdown);
  });

  it('gives an older queued conversation a slot before reusing a hot conversation slot', async () => {
    const jobs = new Map<string, any>();
    const globalQueue = ['hot-first', 'cold-first', 'hot-second'];
    for (const [jobId, chatId] of [['hot-first', 'hot'], ['cold-first', 'cold'], ['hot-second', 'hot']] as const) jobs.set(jobId, {
      jobId, accountId: 'a', chatType: 'direct', chatId, provider: 'codex', prompt: 'work', workspacePath: 'C:\\trusted',
      generation: 0, status: 'queued', sourceType: 'ui', sourceMessageId: null, sourceRequestId: jobId, creationEpoch: null,
    });
    const claimed = new Set<string>();
    const repository = {
      async claimNext(conversation: WritableConversationKey) {
        const jobId = globalQueue.find((id) => jobs.get(id)?.chatId === conversation.chatId && !claimed.has(id));
        if (!jobId) return null;
        claimed.add(jobId); jobs.get(jobId).status = 'running'; return jobs.get(jobId);
      },
      async listQueuedConversations(limit: number) {
        const seen = new Set<string>();
        return globalQueue.filter((id) => !claimed.has(id) && !seen.has(jobs.get(id)?.chatId)
          && !!seen.add(jobs.get(id)?.chatId!)).slice(0, limit).map((id) => key(jobs.get(id)!.chatId));
      },
      async getJob(jobId: string) { return jobs.get(jobId) ?? null; }, async lookupSession() { return null; },
      async appendEvent() {}, async bindSession() { return true; }, async completeJob() { return true; },
      async failJob() { return true; }, async cancelJob() { return true; },
    };
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request: AgentRunRequest) {
        started.push(request.source.type === 'ui' ? request.source.requestId : request.source.messageId);
        await new Promise<void>((resolve) => releases.set(request.jobId, resolve));
        yield { type: 'completed' as const, finalText: 'done' };
      }, async cancel(jobId) { releases.get(jobId)?.(); },
    }, undefined, undefined, 1);

    service.kick(key('hot'));
    await until(() => releases.has('hot-first'));
    service.kick(key('cold'));
    await tick();
    releases.get('hot-first')?.();
    await until(() => releases.has('cold-first') || releases.has('hot-second'));

    expect(started[1]).toBe('cold-first');
    releases.get('cold-first')?.();
    await until(() => releases.has('hot-second'));
    releases.get('hot-second')?.();
    await service.idle();
  });

  it('automatically drains more than 256 durable conversations without another kick', async () => {
    const keys = Array.from({ length: 259 }, (_, index) => key(`burst-${index}`));
    const jobs = new Map(keys.map((conversation, index) => [conversation.chatId, {
      jobId: `burst-job-${index}`, accountId: 'a', chatType: 'direct' as const, chatId: conversation.chatId,
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: `r-${index}`, creationEpoch: null,
    }]));
    const claimed = new Set<string>();
    const repository = {
      async claimNext(conversation: WritableConversationKey) {
        if (claimed.has(conversation.chatId)) return null;
        claimed.add(conversation.chatId);
        return jobs.get(conversation.chatId) ?? null;
      },
      async listQueuedConversations(limit: number) {
        return keys.filter((conversation) => !claimed.has(conversation.chatId)).slice(0, limit);
      },
      async getJob(jobId: string) { return [...jobs.values()].find((item) => item.jobId === jobId) ?? null; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    const releases = new Map<string, () => void>();
    const started = new Set<string>();
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request: AgentRunRequest) {
        started.add(request.source.type === 'ui' ? request.source.requestId : request.source.messageId);
        await new Promise<void>((resolve) => releases.set(request.jobId, resolve));
        yield { type: 'completed' as const, finalText: 'done' };
    }, async cancel(jobId) { releases.get(jobId)?.(); },
    }, undefined, undefined, 2, 30 * 60 * 1000, 5000, 2);

    await service.recoverQueued();
    for (let attempt = 0; attempt < 259; attempt++) {
      await until(() => releases.size > 0);
      const next = releases.entries().next().value as [string, () => void] | undefined;
      next?.[1]();
      releases.delete(next![0]);
      await tick();
    }
    await service.idle();

    expect(started.size).toBe(259);
    expect(claimed.size).toBe(259);
  });

  it('keeps overflow jobs queued in the repository until a global provider slot opens', async () => {
    const keys = ['one', 'two', 'three'].map((chatId) => key(chatId));
    const jobs = new Map(keys.map((conversation, index) => [conversation.chatId, {
      jobId: `capacity-${index}`, accountId: 'a', chatType: 'direct' as const, chatId: conversation.chatId,
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null,
    }]));
    const claimed = new Set<string>();
    const repository = {
      async claimNext(conversation: WritableConversationKey) {
        if (claimed.has(conversation.chatId)) return null;
        claimed.add(conversation.chatId);
        return jobs.get(conversation.chatId) ?? null;
      },
      async listQueuedConversations(limit: number) { return keys.filter((conversation) => !claimed.has(conversation.chatId)).slice(0, limit); },
      async getJob(jobId: string) { return [...jobs.values()].find((item) => item.jobId === jobId) ?? null; },
      async lookupSession() { return null; }, async appendEvent() {}, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { return true; }, async cancelJob() { return true; },
    };
    let active = 0; let maximum = 0;
    const releases = new Map<string, () => void>();
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request: AgentRunRequest) {
        active++; maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.set(request.jobId, resolve));
        active--; yield { type: 'completed' as const, finalText: 'done' };
      }, async cancel(jobId) { releases.get(jobId)?.(); },
    }, undefined, undefined, 2, 30 * 60 * 1000, 5000, 2);

    keys.forEach((conversation) => service.kick(conversation));
    await until(() => releases.size >= 2);
    expect(maximum).toBe(2);
    expect(claimed.has('three')).toBe(false);
    releases.values().next().value?.();
    await tick();
    expect(claimed.has('three')).toBe(true);
    await until(() => releases.size === 3);
    releases.forEach((release) => release());
    await service.idle();
    expect(maximum).toBe(2);
  });

  it('cancels an over-deadline provider tree and persists one timeout terminal event', async () => {
    const job = { jobId: 'deadline-job', accountId: 'a', chatType: 'direct' as const, chatId: 'deadline',
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    let claimed = false; let release!: () => void; let cancelCalled = false; let failed = 0;
    const events: AgentEvent[] = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; }, async lookupSession() { return null; },
      async appendEvent(_jobId: string, event: AgentEvent) { events.push(event); }, async bindSession() { return true; },
      async completeJob() { return true; }, async failJob() { failed++; return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { await new Promise<void>((resolve) => { release = resolve; }); yield { type: 'cancelled' as const }; },
      async cancel() { cancelCalled = true; release(); },
    }, undefined, undefined, 1, 15);

    service.kick(key('deadline'));
    const drained = await Promise.race([service.idle().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))]);

    expect(drained).toBe(true);
    expect(cancelCalled).toBe(true);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', code: 'TIMEOUT', message: 'Agent execution timed out.', retryable: false },
    ]);
    expect(failed).toBe(1);
  });

  it('lets a confirmed completed event win when its database write crosses the deadline', async () => {
    const job = { jobId: 'slow-complete-job', accountId: 'a', chatType: 'direct' as const, chatId: 'slow-complete',
      provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0,
      status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'r', creationEpoch: null };
    let claimed = false; let status: 'running' | 'completed' | 'failed' = 'running'; let failCalls = 0;
    const events: AgentEvent[] = [];
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return { ...job, status }; }, async lookupSession() { return null; },
      async appendEvent(_jobId: string, event: AgentEvent) {
        events.push(event);
        if (event.type === 'completed') await new Promise((resolve) => setTimeout(resolve, 40));
      }, async bindSession() { return true; },
      async completeJob() { status = 'completed'; return true; },
      async failJob() { failCalls++; status = 'failed'; return true; }, async cancelJob() { return true; },
    };
    const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run() { yield { type: 'completed' as const, finalText: 'done' }; }, async cancel() {},
    }, undefined, undefined, 1, 15);

    service.kick(key('slow-complete'));
    await service.idle();

    expect(status).toBe('completed');
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(0);
    expect(failCalls).toBe(0);
  });
});

database('AgentService on real PostgreSQL', () => {
  let pool: Pool; let close: () => Promise<void>; let agents: AgentRepository; let messages: MessageRepository; let settings: SettingsRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase()); agents = new AgentRepository(pool); messages = new MessageRepository(pool);
    settings = new SettingsRepository(pool); const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('a');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='a'");
    await accounts.activateControl('a', 1);
  });
  afterAll(async () => { await close?.(); });

  it('runs FIFO within a full conversation and concurrently across conversations', async () => {
    const first = await messages.ingestAndRoute(envelope('fifo'), route);
    const second = await messages.ingestAndRoute(envelope('fifo'), route);
    // The shared Agent room runs concurrently with a LINE chat: it has its own queue and account-less slot.
    const other = await agents.enqueueUiJob({ provider: 'codex', requestId: 'parallel-request', prompt: 'work', workspacePath: 'C:\\trusted' });
    const started: string[] = []; const releases = new Map<string, () => void>();
    const bridge = { async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      started.push(request.jobId);
      await new Promise<void>((resolve) => releases.set(request.jobId, resolve));
      yield { type: 'started', externalSessionId: `session-${request.jobId}` };
      yield { type: 'completed', finalText: 'done' };
    }, async cancel(jobId: string) { releases.get(jobId)?.(); } };
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, bridge);
    service.kick(key('fifo')); service.kick(AGENT_ROOM_KEY);
    await until(() => started.length === 2);
    expect(new Set(started)).toEqual(new Set([first.jobId, other.jobId]));
    expect(started).not.toContain(second.jobId);
    releases.get(first.jobId!)?.(); await until(() => started.length === 3);
    expect(new Set(started)).toEqual(new Set([first.jobId, other.jobId, second.jobId]));
    releases.get(second.jobId!)?.(); releases.get(other.jobId!)?.();
    await service.idle();
  });

  it('cancels owned running work before stop returns and drops late final', async () => {
    const input = await messages.ingestAndRoute(envelope('stop'), route);
    let resolveCancel!: () => void; let resolveRun!: () => void;
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const cancelled = new Promise<void>((resolve) => { resolveCancel = resolve; });
    const bridge = { async *run(): AsyncIterable<AgentEvent> {
      markRunStarted();
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      yield { type: 'completed', finalText: 'late' };
    }, async cancel() { await cancelled; resolveRun(); } };
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, bridge);
    service.kick(key('stop')); await runStarted;
    let returned = false; const stop = service.stopChat(key('stop')).then(() => { returned = true; });
    await tick(); expect(returned).toBe(false);
    resolveCancel(); await stop; await service.idle();
    expect((await agents.getJob(input.jobId!))?.status).toBe('cancelled');
    expect(await agents.listDeliveries(input.jobId!)).toHaveLength(0);
  });
  it('cancels running process trees before shutdown waits for pumps', async () => {
    const input = await messages.ingestAndRoute(envelope('shutdown'), route);
    let started = false; let release!: () => void; let cancelCalled = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; await gate; yield { type: 'completed' as const, finalText: 'late' }; },
      async cancel() { cancelCalled = true; release(); },
    });
    service.kick(key('shutdown')); await until(() => started);
    await service.shutdown();
    expect(cancelCalled).toBe(true);
    expect((await agents.getJob(input.jobId!))?.status).toBe('cancelled');
  });
  it('still cancels physical jobs when shutdown persistence fails', async () => {
    await messages.ingestAndRoute(envelope('shutdown-db-failure'), route);
    let started = false; let release!: () => void; let cancelCalled = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; await gate; },
      async cancel() { cancelCalled = true; release(); },
    });
    service.kick(key('shutdown-db-failure')); await until(() => started);
    const cancellation = vi.spyOn(agents, 'cancelJob').mockRejectedValue(new Error('database unavailable'));
    try {
      // Reporting the persistence error is allowed; skipping owned-process cleanup is not.
      await service.shutdown().catch(() => undefined);
      expect(cancelCalled).toBe(true);
    } finally {
      cancellation.mockRestore();
      release();
      await service.idle();
    }
  });

  it('does not launch a job cancelled while claimNext is returning', async () => {
    await messages.ingestAndRoute(envelope('claim-race'), route);
    let claimReady!: () => void; let releaseClaim!: () => void;
    const claimed = new Promise<void>((resolve) => { claimReady = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const realClaim = agents.claimNext.bind(agents);
    const spy = vi.spyOn(agents, 'claimNext').mockImplementation(async (conversation) => {
      const job = await realClaim(conversation);
      claimReady();
      await claimGate;
      return job;
    });
    let started = false;
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; await runnerGate; },
      async cancel() { releaseRunner(); },
    });
    try {
      service.kick(key('claim-race'));
      await claimed;
      const stopping = service.stopChat(key('claim-race'));
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query("SELECT status FROM agent_jobs WHERE chat_id = 'claim-race'");
        if (result.rows[0]?.status === 'cancelled') break;
        await tick();
      }
      releaseClaim();
      const outcome = await Promise.race([stopping.then(() => 'stopped'), tick().then(() => 'hung')]);
      expect(outcome).toBe('stopped');
      expect(started).toBe(false);
    } finally {
      releaseClaim(); releaseRunner(); spy.mockRestore(); await service.idle();
    }
  });
  it('applies a replayed LINE /new generation reset only once in PostgreSQL', async () => {
    const input = envelope('new-once');
    await messages.ingestAndRoute({ ...input, text: '/new' }, { eligible: false });
    await pool.query(`INSERT INTO message_routes (account_id, message_id, action, creation_epoch)
      VALUES ('a', $1, 'new', 1)`, [input.messageId]);
    expect(await agents.resetConversationForMessage(key('new-once'), input.messageId)).toMatchObject({ result: 'applied' });
    expect(await agents.resetConversationForMessage(key('new-once'), input.messageId)).toMatchObject({ result: 'already_applied' });
    const generations = await pool.query(`SELECT generation FROM agent_sessions
      WHERE account_id = 'a' AND chat_type = 'direct' AND chat_id = 'new-once'`);
    // A LINE chat only owns its LINE sessions (codex and claude); UI sessions belong to the shared Agent room and are no
    // longer reset per chat (agent-repository resetConversationForMessage), so exactly two rows, each reset once.
    expect(generations.rows.map((row) => row.generation)).toEqual([1, 1]);
  });
  it('does not cancel a UI Agent run for a stale LINE /new command', async () => {
    const input = envelope('stale-new');
    await messages.ingestAndRoute({ ...input, text: '/new' }, { eligible: false });
    await pool.query(`INSERT INTO message_routes (account_id, message_id, action, creation_epoch)
      VALUES ('a', $1, 'new', 0)`, [input.messageId]);
    await agents.enqueueUiJob({ provider: 'codex', requestId: 'ui-stale', prompt: 'work', workspacePath: 'C:\\trusted' });
    let started!: () => void; let release!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started(); await gate; yield { type: 'completed' as const, finalText: 'done' }; },
      async cancel() { cancellations++; release(); },
    });
    try {
      service.kick(AGENT_ROOM_KEY); await running;
      // A LINE /new for a chat never touches the account-less Agent room's run.
      await service.resetChat(key('stale-new'), input.messageId);
      expect(cancellations).toBe(0);
    } finally { release(); await service.idle(); }
  });
  it.each(['stopJob', 'resetChat'] as const)('%s fences a job claimed before cancellation', async (action) => {
    const chatId = `claim-${action}`;
    const input = await messages.ingestAndRoute(envelope(chatId), route);
    let claimReady!: () => void; let releaseClaim!: () => void;
    const claimed = new Promise<void>((resolve) => { claimReady = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const realClaim = agents.claimNext.bind(agents);
    const spy = vi.spyOn(agents, 'claimNext').mockImplementation(async (conversation) => {
      const job = await realClaim(conversation);
      claimReady(); await claimGate; return job;
    });
    let started = false;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; }, async cancel() {},
    });
    try {
      service.kick(key(chatId)); await claimed;
      const stopping = action === 'stopJob'
        ? service.stopJob(key(chatId), input.jobId!) : service.resetChat(key(chatId));
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await agents.getJob(input.jobId!))?.status === 'cancelled') break;
        await tick();
      }
      releaseClaim();
      await stopping; await service.idle();
      expect(started).toBe(false);
      expect((await agents.getJob(input.jobId!))?.status).toBe('cancelled');
    } finally { releaseClaim(); spy.mockRestore(); await service.idle(); }
  });
  it('never starts a cancelled job when stopJob wins after a stale pre-run read', async () => {
    const input = await messages.ingestAndRoute(envelope('stop-read-race'), route);
    let readReady!: () => void; let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { readReady = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const realGetJob = agents.getJob.bind(agents);
    let delayed = false;
    const spy = vi.spyOn(agents, 'getJob').mockImplementation(async (jobId) => {
      const snapshot = await realGetJob(jobId);
      if (jobId === input.jobId && snapshot?.status === 'running' && !delayed) {
        delayed = true; readReady(); await readGate;
      }
      return snapshot;
    });
    let started = false;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; yield { type: 'completed' as const, finalText: 'late' }; },
      async cancel() {},
    });
    try {
      service.kick(key('stop-read-race')); await readStarted;
      const stopping = service.stopJob(key('stop-read-race'), input.jobId!);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await realGetJob(input.jobId!))?.status === 'cancelled') break;
        await tick();
      }
      releaseRead(); await stopping; await service.idle();
      expect(started).toBe(false);
      expect((await realGetJob(input.jobId!))?.status).toBe('cancelled');
    } finally { releaseRead(); spy.mockRestore(); await service.idle(); }
  });
  it('keeps the pre-start fence when a duplicate stopJob finds an already-cancelled job', async () => {
    const input = await messages.ingestAndRoute(envelope('duplicate-stop-read-race'), route);
    let readReady!: () => void; let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { readReady = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const realGetJob = agents.getJob.bind(agents);
    let delayed = false;
    const spy = vi.spyOn(agents, 'getJob').mockImplementation(async (jobId) => {
      const snapshot = await realGetJob(jobId);
      if (jobId === input.jobId && snapshot?.status === 'running' && !delayed) {
        delayed = true; readReady(); await readGate;
      }
      return snapshot;
    });
    let started = false;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; yield { type: 'completed' as const, finalText: 'late' }; },
      async cancel() {},
    });
    try {
      service.kick(key('duplicate-stop-read-race')); await readStarted;
      const firstStop = service.stopJob(key('duplicate-stop-read-race'), input.jobId!);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await realGetJob(input.jobId!))?.status === 'cancelled') break;
        await tick();
      }
      expect(await service.stopJob(key('duplicate-stop-read-race'), input.jobId!)).toBe(false);
      releaseRead();
      expect(await firstStop).toBe(true);
      await service.idle();
      expect(started).toBe(false);
      expect((await realGetJob(input.jobId!))?.status).toBe('cancelled');
    } finally { releaseRead(); spy.mockRestore(); await service.idle(); }
  });
  it('does not let a wrong-chat stopJob fence cancel another chats running job', async () => {
    const input = await messages.ingestAndRoute(envelope('owned-stop-race'), route);
    let readReady!: () => void; let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { readReady = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let validationReady!: () => void; let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => { validationReady = resolve; });
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const realGetJob = agents.getJob.bind(agents);
    const realCancel = agents.cancelJobForKey.bind(agents);
    let delayed = false;
    const readSpy = vi.spyOn(agents, 'getJob').mockImplementation(async (jobId) => {
      const snapshot = await realGetJob(jobId);
      if (jobId === input.jobId && snapshot?.status === 'running' && !delayed) {
        delayed = true; readReady(); await readGate;
      }
      return snapshot;
    });
    const cancelSpy = vi.spyOn(agents, 'cancelJobForKey').mockImplementation(async (conversation, jobId) => {
      if (conversation.chatId === 'wrong-stop-race') { validationReady(); await validationGate; }
      return realCancel(conversation, jobId);
    });
    let started = false;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started = true; yield { type: 'completed' as const, finalText: 'owned' }; },
      async cancel() {},
    });
    try {
      service.kick(key('owned-stop-race')); await readStarted;
      const wrongStop = service.stopJob(key('wrong-stop-race'), input.jobId!);
      await validationStarted;
      releaseRead(); await service.idle();
      releaseValidation(); expect(await wrongStop).toBe(false);
      expect(started).toBe(true);
      expect((await realGetJob(input.jobId!))?.status).toBe('completed');
    } finally { releaseRead(); releaseValidation(); readSpy.mockRestore(); cancelSpy.mockRestore(); await service.idle(); }
  });
  // UI work belongs to the one shared Agent room (account-less queue), so the overlapping stop/reset/submit now target
  // AGENT_ROOM_KEY and the account-less UI sessions rather than a per-chat key.
  it('keeps the claim fence until overlapping stop and reset operations both finish', async () => {
    await settings.setAppSetting('workspace_path', 'C:\\trusted');
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
    const realReset = agents.resetGeneration.bind(agents);
    const spy = vi.spyOn(agents, 'resetGeneration').mockImplementation(async (session) => {
      if (session.provider === 'claude' && session.sourceType === 'ui') await resetGate;
      return realReset(session);
    });
    let started = 0;
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, {
      async *run() { started++; yield { type: 'completed' as const, finalText: 'done' }; },
      async cancel() {},
    });
    let resetting: Promise<void> | undefined;
    try {
      resetting = service.resetChat(AGENT_ROOM_KEY);
      await tick();
      await service.stopChat(AGENT_ROOM_KEY);
      await service.submitFromUi({ provider: 'codex', requestId: 'during-reset', prompt: 'new work' });
      await tick();
      expect(started).toBe(0);
      releaseReset(); await resetting; await service.idle();
      expect(started).toBe(1);
    } finally { releaseReset(); await resetting; await service.idle(); spy.mockRestore(); }
  });

  it('ignores the renderer workspace path on UI submission', async () => {
    await messages.ingestAndRoute(envelope('ui'), { eligible: false });
    await settings.setAppSetting('workspace_path', 'C:\\trusted');
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, { async *run() {}, async cancel() {} });
    const result = await service.submitFromUi({ ...key('ui'), provider: 'codex', requestId: 'ui-1', prompt: 'question', workspacePath: 'C:\\evil' });
    expect((await agents.getJob(result.jobId))?.workspacePath).toBe('C:\\trusted');
    await service.idle();
  });
  it('scopes stop, retry and event reads to the requested conversation', async () => {
    const input = await messages.ingestAndRoute(envelope('job-actions'), route);
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, { async *run() {}, async cancel() {} });
    expect(await service.stopJob(key('forged'), input.jobId!)).toBe(false);
    expect(await service.stopJob(key('job-actions'), input.jobId!)).toBe(true);
    expect(await service.getJobEvents(key('forged'), input.jobId!)).toEqual([]);
    expect(await service.retryJob(key('forged'), input.jobId!)).toBe(false);
  });
  it('persists long final output as bounded LINE delivery segments', async () => {
    const input = await messages.ingestAndRoute(envelope('long-final'), route);
    const output = 'x'.repeat(10_000);
    const service = newAgentService(agents, { current: async () => 'C:\\trusted' }, { async *run() {
      yield { type: 'started' as const, externalSessionId: 'long-session' };
      yield { type: 'completed' as const, finalText: output };
    }, async cancel() {} });
    service.kick(key('long-final')); await service.idle();
    const parts = await agents.listDeliveries(input.jobId!);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.text.length <= 4900)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(output);
  });
});
