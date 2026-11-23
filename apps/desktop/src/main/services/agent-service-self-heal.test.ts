import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { AgentService, type AgentRunner, type AgentServiceResidentOptions, type InternalMcpLauncher } from './agent-service.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const started: AgentEvent = { type: 'started', externalSessionId: 'new-session', workspacePath: 'C:\\trusted' };
const cliExit: AgentEvent = { type: 'failed', code: 'CLI_EXIT', message: 'The CLI stopped.', retryable: false };

function fixture(attempts: AgentEvent[][], residentOptions: AgentServiceResidentOptions) {
  const job = { jobId: 'job-h', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'claude' as const, prompt: 'hi',
    workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const, sourceType: 'line' as const, sourceMessageId: 'm1',
    sourceRequestId: null, creationEpoch: 1, revision: '1' };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const cleared: unknown[][] = [];
  const bound: unknown[] = [];
  const diagnostics: Array<{ detail?: string | undefined }> = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return { externalSessionId: 'old-session', generation: 3 }; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession(binding: unknown) { bound.push(binding); },
    async clearExternalSession(...args: unknown[]) { cleared.push(args); return true; },
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const requests: AgentRunRequest[] = [];
  const resets: string[] = [];
  const reactions: string[] = [];
  const bridge: AgentRunner = {
    async *run() { yield { type: 'completed', finalText: 'one-shot' }; },
    async *runResident(request) { requests.push(request); yield* (attempts[requests.length - 1] ?? []); },
    resetResidents(predicate) { resets.push(predicate('["claude",["line","a","direct","c"],3,"claude"]') ? 'own' : 'other'); return 1; },
    async cancel() {},
  };
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
  const failed: string[] = [];
  const lifecycle: string[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge,
    async (_id, event) => { if (event.type === 'failed') failed.push(`${event.code}:${event.detail ?? ''}`); }, undefined, 1, 30_000, 5_000, 1,
    async (_jobId, _key, _messageId, reaction, phase) => { reactions.push(`${reaction}:${phase}`); }, undefined,
    (projection) => { lifecycle.push(projection.status); },
    launcher, fullToolsEnvironment, (diagnostic) => diagnostics.push(diagnostic), undefined, undefined, residentOptions);
  return { service, requests, resets, appended, cleared, bound, failed, reactions, diagnostics, lifecycle };
}

describe('AgentService self-heal', () => {
  it('runs a second attempt without a resume id after CLI_EXIT and completes the job', async () => {
    const f = fixture([[started, cliExit], [started, { type: 'completed', finalText: 'ok' }]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]!.resumeSessionId).toBe('old-session');
    expect(f.requests[1]!.resumeSessionId).toBeUndefined();
    expect(f.resets).toEqual(['own']);
    expect(f.cleared).toEqual([[expect.objectContaining({ accountId: 'a', provider: 'claude' }), 3, 'old-session']]);
    expect(f.appended.some((event) => event.type === 'failed')).toBe(false);
    expect(f.appended.at(-1)).toEqual({ type: 'completed', finalText: 'ok' });
    expect(f.bound).toHaveLength(1);
    expect(f.bound[0]).toMatchObject({ externalSessionId: 'new-session' });
    expect(f.failed).toEqual([]);
    expect(f.lifecycle).not.toContain('failed');
    expect(f.reactions).not.toContain('SAD:failed');
    expect(f.diagnostics.map((diagnostic) => diagnostic.detail)).toEqual(['self_heal:CLI_EXIT']);
  });

  it('marks the failure of attempt 2 with after_self_heal', async () => {
    const f = fixture([[cliExit], [cliExit]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(2);
    expect(f.failed).toEqual(['CLI_EXIT:after_self_heal']);
    expect(f.appended.filter((event) => event.type === 'failed')).toHaveLength(1);
  });

  it('heals a blank reply as EMPTY_REPLY', async () => {
    const f = fixture([[started, { type: 'completed', finalText: '  ' }], [started, { type: 'completed', finalText: 'ok' }]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(2);
    expect(f.diagnostics.map((diagnostic) => diagnostic.detail)).toEqual(['self_heal:EMPTY_REPLY']);
  });

  it('D1: does not heal when the job has a committed LINE send', async () => {
    const f = fixture([[cliExit], [started, { type: 'completed', finalText: 'ok' }]], { committedLineSends: async () => 1 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(1);
    expect(f.resets).toEqual([]);
    expect(f.failed).toEqual(['CLI_EXIT:']);
  });

  it('does not heal when the send check throws or is missing', async () => {
    const thrown = fixture([[cliExit]], { committedLineSends: async () => { throw new Error('db down'); } });
    thrown.service.kick(key);
    await thrown.service.idle();
    expect(thrown.requests).toHaveLength(1);
    const missing = fixture([[cliExit]], {});
    missing.service.kick(key);
    await missing.service.idle();
    expect(missing.requests).toHaveLength(1);
  });

  it('does not heal PROVIDER_LIMIT', async () => {
    const f = fixture([[{ type: 'failed', code: 'PROVIDER_LIMIT', message: 'limit', retryable: false }]], { committedLineSends: async () => 0 });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(1);
    expect(f.failed).toEqual(['PROVIDER_LIMIT:']);
  });
});
