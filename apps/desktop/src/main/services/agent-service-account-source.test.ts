import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { residentKey, residentIdentity } from './agent-resident.js';
import { AgentService, type AgentAccountSources, type AgentRunner, type InternalMcpLauncher } from './agent-service.js';
import { fullToolsEnvironment } from './agent-service-test-support.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const MANAGED = 'acct-0123456789';
const rows: Record<string, { sourceId: string; kind: 'system' | 'managed' }> = {
  claude: { sourceId: 'claude', kind: 'system' }, codex: { sourceId: 'codex', kind: 'system' }, [MANAGED]: { sourceId: MANAGED, kind: 'managed' },
};

function fixture(input: { provider: 'claude' | 'codex'; sourceType?: 'line' | 'schedule'; jobs?: number; bindFails?: boolean }) {
  const sourceType = input.sourceType ?? 'line';
  const line = sourceType === 'line';
  let claimed = 0;
  // The effective default: the managed source first, the system source after the first run.
  let defaultId = MANAGED;
  const makeJob = (n: number) => ({ jobId: `job-${n}`, accountId: line ? 'a' : null, chatType: line ? 'direct' as const : null, chatId: line ? 'c' : null,
    provider: input.provider, prompt: 'hi', workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const, sourceType,
    sourceMessageId: line ? `m${n}` : null, sourceRequestId: line ? null : 'schedule:1', creationEpoch: 1, revision: '1' });
  const bound = new Map<string, string>();
  const recorded: Array<[string, string]> = [];
  const binds: string[] = [];
  const appended: AgentEvent[] = [];
  const repository = {
    async claimNext() { if (claimed >= (input.jobs ?? 1)) return null; claimed += 1; return makeJob(claimed); },
    async getJob() { return makeJob(claimed); },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    // The rule of AgentRepository.bindSessionAccountSource: write the default once, then keep it.
    async bindSessionAccountSource(sessionKey: { provider: string }, generation: number) {
      if (input.bindFails) throw new Error('bind failed');
      const slot = `${sessionKey.provider}:${generation}`;
      binds.push(slot);
      if (!bound.has(slot)) bound.set(slot, defaultId);
      return bound.get(slot)!;
    },
    async setJobAccountSource(jobId: string, sourceId: string) { recorded.push([jobId, sourceId]); },
    async completeJob() { return { ...makeJob(claimed), status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...makeJob(claimed), status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...makeJob(claimed), status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const requests: AgentRunRequest[] = [];
  const turnKeys: string[] = [];
  const done = async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'started', externalSessionId: 's' };
    yield { type: 'completed', finalText: 'ok' };
    defaultId = input.provider;
  };
  const bridge: AgentRunner = {
    async *run(request) { requests.push(request); yield* done(); },
    async *runResident(request, turn) { requests.push(request); turnKeys.push(turn.key); yield* done(); },
    async cancel() {},
  };
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
  const lookups: string[] = [];
  const accountSources: AgentAccountSources = {
    async get(id) { lookups.push(`get:${id}`); return rows[id] ?? null; },
    async effectiveDefault(provider) { lookups.push(`default:${provider}`); return rows[defaultId]!; },
  };
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge, undefined, undefined,
    1, 30_000, 5_000, 1, undefined, undefined, undefined, launcher, fullToolsEnvironment, undefined, undefined, undefined, { accountSources });
  const kickKey = line ? key : { accountId: null, chatType: 'schedule', chatId: null } as unknown as WritableConversationKey;
  return { service, requests, turnKeys, recorded, binds, appended, lookups, kickKey };
}

describe('AgentService account sources (P4)', () => {
  it('binds the default source on the first turn and passes it to the runner', async () => {
    const f = fixture({ provider: 'codex' });
    f.service.kick(f.kickKey);
    await f.service.idle();
    expect(f.requests[0]!.account).toEqual({ id: MANAGED, kind: 'managed' });
    expect(f.recorded).toEqual([['job-1', MANAGED]]);
  });

  it('keeps the bound source of a session after the default changes (CliTalkAgent chat.rs 3128-3166)', async () => {
    const f = fixture({ provider: 'codex', jobs: 2 });
    f.service.kick(f.kickKey);
    await f.service.idle();
    f.service.kick(f.kickKey);
    await f.service.idle();
    // The default changed to the system source after the first run; the second run still uses the managed source.
    expect(f.requests.map((request) => request.account)).toEqual([{ id: MANAGED, kind: 'managed' }, { id: MANAGED, kind: 'managed' }]);
    expect(f.recorded).toEqual([['job-1', MANAGED], ['job-2', MANAGED]]);
  });

  it('runs a schedule job on the effective default source without a session binding', async () => {
    const f = fixture({ provider: 'claude', sourceType: 'schedule', jobs: 2 });
    f.service.kick(f.kickKey);
    await f.service.idle();
    f.service.kick(f.kickKey);
    await f.service.idle();
    expect(f.binds).toEqual([]);
    expect(f.lookups).toEqual(['default:claude', 'default:claude']);
    // No binding: the second run follows the changed default.
    expect(f.requests.map((request) => request.account)).toEqual([{ id: MANAGED, kind: 'managed' }, { id: 'claude', kind: 'system' }]);
  });

  it('puts the source id into the resident key of a Claude job', async () => {
    const f = fixture({ provider: 'claude' });
    f.service.kick(f.kickKey);
    await f.service.idle();
    expect(f.turnKeys).toEqual([residentKey(residentIdentity(key), 3, MANAGED)]);
  });

  it('fails the job and runs nothing when the source binding fails', async () => {
    const f = fixture({ provider: 'claude', bindFails: true });
    f.service.kick(f.kickKey);
    await f.service.idle();
    expect(f.requests).toEqual([]);
    expect(f.recorded).toEqual([]);
    expect(f.appended.some((event) => event.type === 'failed' && event.code === 'ACCOUNT_SOURCE_UNAVAILABLE')).toBe(true);
  });
});
