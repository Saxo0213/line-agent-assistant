import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { AgentService, type AgentRunner, type AgentServiceResidentOptions } from './agent-service.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const started: AgentEvent = { type: 'started', externalSessionId: 'new-thread', workspacePath: 'C:\\trusted' };
const resumeNotFound: AgentEvent = { type: 'failed', code: 'RESUME_NOT_FOUND', message: 'The saved Codex thread was not found.', retryable: true, detail: 'resume_not_found' };

function fixture(attempts: AgentEvent[][], residentOptions: AgentServiceResidentOptions, sourceType: 'line' | 'schedule' = 'line') {
  const job = { jobId: 'job-x', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const, prompt: 'hi',
    workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const, sourceType, sourceMessageId: 'm1',
    sourceRequestId: null, creationEpoch: 1, revision: '1' };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const cleared: unknown[][] = [];
  const diagnostics: Array<{ detail?: string | undefined; outcome?: string | undefined }> = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return { externalSessionId: 'old-thread', generation: 3 }; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async clearExternalSession(...args: unknown[]) { cleared.push(args); return true; },
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const calls: Array<{ request: AgentRunRequest; options: unknown[] }> = [];
  const bridge: AgentRunner = {
    async *run(request, ...options) { calls.push({ request, options }); yield* (attempts[calls.length - 1] ?? []); },
    async cancel() {},
  };
  const failed: string[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge,
    async (_id, event) => { if (event.type === 'failed') failed.push(`${event.code}:${event.detail ?? ''}`); }, undefined, 1, 30_000, 5_000, 1,
    undefined, undefined, undefined, undefined, fullToolsEnvironment, (diagnostic) => diagnostics.push(diagnostic), undefined, undefined, residentOptions);
  return { service, calls, appended, cleared, failed, diagnostics };
}

describe('AgentService Codex one-shot (P3)', () => {
  it('passes the turn timeout and the chat model to the run', async () => {
    const f = fixture([[started, { type: 'completed', finalText: 'ok' }]], { residentTurnTimeoutMs: 120_000, resolveCodexModel: async () => 'gpt-5.2-codex' });
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.options).toEqual([{ timeoutMs: 120_000 }]);
    expect(f.calls[0]!.request.model).toBe('gpt-5.2-codex');
  });

  it('gives a schedule run no run timeout', async () => {
    const f = fixture([[started, { type: 'completed', finalText: 'ok' }]], { residentTurnTimeoutMs: 120_000 }, 'schedule');
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls[0]!.options).toEqual([]);
  });

  it('runs a model resolver error without a model', async () => {
    const f = fixture([[started, { type: 'completed', finalText: 'ok' }]], { resolveCodexModel: async () => { throw new Error('db down'); } });
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls[0]!.request.model).toBeUndefined();
    expect(f.appended.at(-1)).toEqual({ type: 'completed', finalText: 'ok' });
  });

  it('retries once without resume after RESUME_NOT_FOUND and clears the stored session', async () => {
    const f = fixture([[resumeNotFound], [started, { type: 'completed', finalText: 'ok' }]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.request.resumeSessionId).toBe('old-thread');
    expect(f.calls[1]!.request.resumeSessionId).toBeUndefined();
    expect(f.cleared).toEqual([[expect.objectContaining({ accountId: 'a', provider: 'codex' }), 3, 'old-thread']]);
    expect(f.appended.some((event) => event.type === 'failed')).toBe(false);
    expect(f.diagnostics.map((diagnostic) => [diagnostic.detail, diagnostic.outcome])).toEqual([['resume_not_found_retry', 'recovered']]);
  });

  it('ends the job when the retry fails too', async () => {
    const f = fixture([[resumeNotFound], [resumeNotFound]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls).toHaveLength(2);
    expect(f.failed).toEqual(['RESUME_NOT_FOUND:resume_not_found']);
  });

  it('does not retry when a LINE send is committed, and still clears the dead session once', async () => {
    const f = fixture([[resumeNotFound]], { committedLineSends: async () => 1 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls).toHaveLength(1);
    expect(f.cleared).toEqual([[expect.objectContaining({ accountId: 'a', provider: 'codex' }), 3, 'old-thread']]);
    expect(f.failed).toEqual(['RESUME_NOT_FOUND:resume_not_found']);
  });

  it('completes a partial reply and records timeout_partial', async () => {
    const f = fixture([[started, { type: 'completed', finalText: 'partial text', partial: true }]], {});
    f.service.kick(key);
    await f.service.idle();
    expect(f.appended.at(-1)).toEqual({ type: 'completed', finalText: 'partial text', partial: true });
    expect(f.diagnostics.map((diagnostic) => [diagnostic.detail, diagnostic.outcome])).toEqual([['timeout_partial', 'recovered']]);
    expect(f.failed).toEqual([]);
  });
});
