import { describe, expect, it } from 'vitest';
import { AGENT_ROOM_KEY, type AgentEvent, type WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { AgentService, type AgentRunner, type InternalMcpLauncher } from './agent-service.js';

const lineKey: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const started: AgentEvent = { type: 'started', externalSessionId: 'session-1', workspacePath: 'C:\trusted' };

function fixture(sourceType: 'line' | 'ui') {
  const job = sourceType === 'line'
    ? { jobId: 'job-line', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'claude' as const, prompt: 'hi',
      workspacePath: 'C:\trusted', generation: 1, status: 'running' as const, sourceType: 'line' as const, sourceMessageId: 'm1',
      sourceRequestId: null, creationEpoch: 1, revision: '1' }
    : { jobId: 'job-ui', accountId: null, chatType: null, chatId: null, provider: 'claude' as const, prompt: 'hi',
      workspacePath: 'C:\trusted', generation: 1, status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null,
      sourceRequestId: 'r1', creationEpoch: null, revision: '1' };
  let claimed = false;
  const relayCalls: unknown[][] = [];
  const delivered: string[] = [];
  const diagnostics: unknown[] = [];
  let failRelay = false;
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return null; },
    async appendEvent() {},
    async bindSession() {},
    async clearExternalSession() { return true; },
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
    async appendRelayDelivery(...args: unknown[]) { relayCalls.push(args); if (failRelay) throw new Error('db down'); return true; },
  };
  let residentKey = '';
  const bridge: AgentRunner = {
    async *run() { yield { type: 'completed', finalText: 'one-shot' }; },
    async *runResident(_request, turn) { residentKey = turn.key; yield started; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  };
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\trusted' }, bridge,
    undefined, async (jobId) => { delivered.push(jobId); }, 1, 30_000, 5_000, 1, undefined, undefined, undefined,
    launcher, fullToolsEnvironment, (diagnostic) => diagnostics.push(diagnostic), undefined, undefined, {});
  return { service, relayCalls, delivered, diagnostics, key: () => residentKey, fail: () => { failRelay = true; } };
}

describe('AgentService autonomous relay', () => {
  it('delivers a relayed text to the last completed LINE job of the key', async () => {
    const f = fixture('line');
    f.service.kick(lineKey);
    await f.service.idle();
    expect(f.service.hasRelayTarget(f.key())).toBe(true);
    await f.service.relayAutonomousReply({ key: f.key(), texts: ['background done'] });
    expect(f.relayCalls).toEqual([['job-line', ['background done'], expect.any(String)]]);
    expect(f.delivered).toEqual(['job-line', 'job-line']);
    const before = f.diagnostics.length;
    f.fail();
    await f.service.relayAutonomousReply({ key: f.key(), texts: ['second'] });
    expect(f.diagnostics).toHaveLength(before + 1);
    expect(f.delivered).toEqual(['job-line', 'job-line']);
    f.service.forgetRelayTarget(f.key());
    expect(f.service.hasRelayTarget(f.key())).toBe(false);
  });

  it('has no target for a key that only ran room jobs', async () => {
    const f = fixture('ui');
    f.service.kick(AGENT_ROOM_KEY);
    await f.service.idle();
    expect(f.key()).not.toBe('');
    expect(f.service.hasRelayTarget(f.key())).toBe(false);
    await f.service.relayAutonomousReply({ key: f.key(), texts: ['lost'] });
    expect(f.relayCalls).toEqual([]);
  });
});
