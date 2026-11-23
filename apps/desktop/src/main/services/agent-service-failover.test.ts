import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository, PendingFailureInput, PendingTurn, RouteDecision } from '@line-agent/database';
import { AgentService, ALL_SOURCES_EXHAUSTED_TEXT, NO_AVAILABLE_SOURCE_TEXT, type AgentAccountSources, type AgentFailover, type AgentRunner, type InternalMcpLauncher } from './agent-service.js';
import { fullToolsEnvironment } from './agent-service-test-support.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const MANAGED = 'acct-0123456789';
const rows: Record<string, { sourceId: string; kind: 'system' | 'managed' }> = {
  claude: { sourceId: 'claude', kind: 'system' }, codex: { sourceId: 'codex', kind: 'system' }, [MANAGED]: { sourceId: MANAGED, kind: 'managed' },
};

function fixture(input: { provider: 'claude' | 'codex'; sourceType?: 'line' | 'schedule'; decision: RouteDecision; enabled?: boolean;
  applied?: { switched: boolean; previous?: { provider: 'claude' | 'codex'; generation: number } }; folded?: boolean; activePending?: Partial<PendingTurn>;
  routingFails?: boolean }) {
  const sourceType = input.sourceType ?? 'line';
  const line = sourceType === 'line';
  let claimed = 0;
  const makeJob = (n: number) => ({ jobId: `job-${n}`, accountId: line ? 'a' : null, chatType: line ? 'direct' as const : null, chatId: line ? 'c' : null,
    provider: input.provider, prompt: 'hi', workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const, sourceType,
    sourceMessageId: line ? `m${n}` : null, sourceRequestId: line ? null : 'schedule:1', creationEpoch: 1, revision: '1',
    ...(input.folded ? { foldedJobs: [{ jobId: 'folded-1', prompt: 'more', sourceMessageId: 'm9', queuePosition: '2' }] } : {}) });
  const appended: AgentEvent[] = [];
  const applyCalls: unknown[] = [];
  const transcriptCalls: unknown[] = [];
  const binds: string[] = [];
  const repository = {
    async claimNext() { if (claimed >= 1) return null; claimed += 1; return makeJob(claimed); },
    async getJob() { return makeJob(claimed); },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async bindSessionAccountSource(sessionKey: { provider: string }) { binds.push(sessionKey.provider); return sessionKey.provider; },
    async setJobAccountSource() {},
    async applyRoute(call: { provider: 'claude' | 'codex'; sessionKey?: object; sessionGeneration: number }) {
      applyCalls.push(call);
      const switched = input.applied?.switched ?? false;
      return { switched, sessionKey: call.sessionKey ? { ...call.sessionKey, provider: call.provider } : null, generation: switched ? call.sessionGeneration + 1 : call.sessionGeneration,
        ...(input.applied?.previous ? { previous: input.applied.previous } : {}) };
    },
    async listTranscriptEvents(call: unknown) {
      transcriptCalls.push(call);
      return [{ role: 'user' as const, text: 'earlier question' }, { role: 'assistant' as const, text: 'earlier answer' }];
    },
    async completeJob() { return { ...makeJob(claimed), status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...makeJob(claimed), status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...makeJob(claimed), status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const requests: AgentRunRequest[] = [];
  const done = async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'started', externalSessionId: 's' };
    yield { type: 'completed', finalText: 'ok' };
  };
  const bridge: AgentRunner = {
    async *run(request) { requests.push(request); yield* done(); },
    async *runResident(request) { requests.push(request); yield* done(); },
    async cancel() {},
  };
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
  const accountSources: AgentAccountSources = {
    async get(id) { return rows[id] ?? null; },
    async effectiveDefault(provider) { return rows[provider]!; },
  };
  const routed: unknown[] = [];
  const recorded: PendingFailureInput[] = [];
  const exhausted: string[] = [];
  const notices: Array<[string, string]> = [];
  const failover: AgentFailover = {
    routing: {
      enabled: async () => input.enabled ?? true,
      routeFor: async (call) => { routed.push(call); if (input.routingFails) throw new Error('route failed'); return input.decision; },
    },
    pendingTurns: {
      findByJob: async () => (input.activePending ? { pendingId: 'p-1', activeJobId: 'job-1', attemptedSourceIds: [], ...input.activePending } as PendingTurn : null),
      recordFailure: async (call) => { recorded.push(call); return { pendingId: 'p-new' } as PendingTurn; },
      markExhausted: async (id) => { exhausted.push(id); return true; },
    },
    sendNotice: async (job, text) => { notices.push([job.jobId, text]); },
  };
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge, undefined, undefined,
    1, 30_000, 5_000, 1, undefined, undefined, undefined, launcher, fullToolsEnvironment, undefined, undefined, undefined, { accountSources, failover });
  const kickKey = line ? key : { accountId: null, chatType: 'schedule', chatId: null } as unknown as WritableConversationKey;
  return { service, requests, appended, applyCalls, transcriptCalls, binds, routed, recorded, exhausted, notices, kickKey };
}

async function run(f: ReturnType<typeof fixture>): Promise<void> {
  f.service.kick(f.kickKey);
  await f.service.idle();
}

describe('AgentService failover routing (P5 B3a)', () => {
  it('switches a LINE job to Codex: applies the route, runs on the new source, sends one notice and adds the previous transcript', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'switch_required', provider: 'codex', sourceId: 'codex' },
      applied: { switched: true, previous: { provider: 'claude', generation: 3 } } });
    await run(f);
    expect(f.applyCalls).toEqual([{ jobId: 'job-1', sessionKey: { ...key, provider: 'claude', sourceType: 'line' }, sessionGeneration: 3, provider: 'codex', sourceId: 'codex' }]);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.provider).toBe('codex');
    expect(f.requests[0]!.account).toEqual({ id: 'codex', kind: 'system' });
    expect(f.requests[0]!.prompt).toContain('Recent LINEJS transcript for continuity');
    expect(f.requests[0]!.prompt).toContain('User: earlier question');
    expect(f.transcriptCalls).toEqual([{ jobId: 'job-1', generation: 4, from: { provider: 'claude', generation: 3 } }]);
    expect(f.notices).toEqual([['job-1', '已切換至 Codex']]);
    expect(f.binds).toEqual([]);
  });

  it('adds the previous transcript to a resident Claude turn after a switch', async () => {
    const f = fixture({ provider: 'codex', decision: { kind: 'switch_required', provider: 'claude', sourceId: MANAGED },
      applied: { switched: true, previous: { provider: 'codex', generation: 3 } } });
    await run(f);
    expect(f.requests[0]!.provider).toBe('claude');
    expect(f.requests[0]!.account).toEqual({ id: MANAGED, kind: 'managed' });
    expect(f.requests[0]!.prompt).toContain('User: earlier question');
    expect(f.transcriptCalls).toEqual([{ jobId: 'job-1', generation: 4, from: { provider: 'codex', generation: 3 } }]);
    expect(f.notices).toEqual([['job-1', '已切換至 Claude']]);
  });

  it('sends no notice and no previous transcript when the provider and the generation stay', async () => {
    const f = fixture({ provider: 'codex', decision: { kind: 'use', provider: 'codex', sourceId: 'codex' }, applied: { switched: false } });
    await run(f);
    expect(f.requests[0]!.prompt).not.toContain('Recent LINEJS transcript');
    expect(f.transcriptCalls).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it('starts a new generation on another source of the same provider without a notice', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'switch_required', provider: 'claude', sourceId: MANAGED },
      applied: { switched: true, previous: { provider: 'claude', generation: 3 } } });
    await run(f);
    expect(f.requests[0]!.account).toEqual({ id: MANAGED, kind: 'managed' });
    expect(f.transcriptCalls).toEqual([{ jobId: 'job-1', generation: 4, from: { provider: 'claude', generation: 3 } }]);
    expect(f.notices).toEqual([]);
  });

  it('gives the attempted sources of its active pending turn to the router', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'use', provider: 'claude', sourceId: 'claude' }, applied: { switched: false },
      activePending: { attemptedSourceIds: ['claude'] } });
    await run(f);
    expect(f.routed).toMatchObject([{ excluded: ['claude'], sessionGeneration: 3 }]);
  });

  it('fails with ALL_SOURCES_EXHAUSTED, keeps an exhausted pending turn and tells the chat', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'all_sources_exhausted' }, folded: true });
    await run(f);
    expect(f.requests).toEqual([]);
    expect(f.applyCalls).toEqual([]);
    expect(f.appended).toContainEqual({ type: 'failed', code: 'ALL_SOURCES_EXHAUSTED', message: ALL_SOURCES_EXHAUSTED_TEXT, retryable: true });
    expect(f.recorded).toEqual([{ originJobId: 'job-1', lineageKey: JSON.stringify(['line', 'a', 'direct', 'c']), userText: 'hi\nmore', provider: 'claude',
      sourceId: null, hadToolActivity: false, hadEffectiveOutput: false, error: ALL_SOURCES_EXHAUSTED_TEXT }]);
    expect(f.exhausted).toEqual(['p-new']);
    expect(f.notices).toEqual([['job-1', ALL_SOURCES_EXHAUSTED_TEXT]]);
  });

  it('fails with NO_AVAILABLE_SOURCE and the T7 text', async () => {
    const f = fixture({ provider: 'codex', decision: { kind: 'no_available_source' } });
    await run(f);
    expect(f.appended).toContainEqual({ type: 'failed', code: 'NO_AVAILABLE_SOURCE', message: NO_AVAILABLE_SOURCE_TEXT, retryable: true });
    expect(f.notices).toEqual([['job-1', NO_AVAILABLE_SOURCE_TEXT]]);
  });

  it('does not record a second pending turn for a job that is already the active job of one', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'all_sources_exhausted' }, activePending: {} });
    await run(f);
    expect(f.recorded).toEqual([]);
    expect(f.appended.some((event) => event.type === 'failed' && event.code === 'ALL_SOURCES_EXHAUSTED')).toBe(true);
  });

  it('keeps no pending turn and sends no notice for a scheduled run (D25)', async () => {
    const f = fixture({ provider: 'claude', sourceType: 'schedule', decision: { kind: 'all_sources_exhausted' } });
    await run(f);
    expect(f.recorded).toEqual([]);
    expect(f.notices).toEqual([]);
    expect(f.appended.some((event) => event.type === 'failed' && event.code === 'ALL_SOURCES_EXHAUSTED')).toBe(true);
  });

  it('fails with ACCOUNT_SOURCE_UNAVAILABLE when the router throws', async () => {
    const f = fixture({ provider: 'claude', decision: { kind: 'use', provider: 'claude', sourceId: 'claude' }, routingFails: true });
    await run(f);
    expect(f.requests).toEqual([]);
    expect(f.appended.some((event) => event.type === 'failed' && event.code === 'ACCOUNT_SOURCE_UNAVAILABLE')).toBe(true);
  });

  it('does not route and has no quota gate when the switch is off', async () => {
    const f = fixture({ provider: 'codex', decision: { kind: 'all_sources_exhausted' }, enabled: false });
    await run(f);
    expect(f.routed).toEqual([]);
    expect(f.applyCalls).toEqual([]);
    expect(f.binds).toEqual(['codex']);
    expect(f.requests).toHaveLength(1);
    expect(f.notices).toEqual([]);
  });
});
