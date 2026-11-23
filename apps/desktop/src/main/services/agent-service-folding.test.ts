import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentJobStatusProjection, AgentRepository } from '@line-agent/database';
import type { ResidentTurnOptions } from '@line-agent/agent-bridge';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { AgentService, type AgentRunner } from './agent-service.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };

describe('AgentService folded jobs', () => {
  it('sends the lead and follower prompts as one turn, then settles the followers with the lead status and reaction', async () => {
    const job = { jobId: 'lead', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'claude' as const, prompt: 'lead prompt',
      workspacePath: 'C:\\trusted', generation: 0, status: 'running' as const, sourceType: 'line' as const, sourceMessageId: '101',
      sourceRequestId: null, creationEpoch: 1, revision: '1',
      foldedJobs: [{ jobId: 'f1', prompt: 'follower one', sourceMessageId: '102', queuePosition: '2' },
        { jobId: 'f2', prompt: 'follower two', sourceMessageId: '103', queuePosition: '3' }] };
    let claimed = false;
    const settleCalls: string[] = [];
    const lifecycle: Array<[string, string]> = [];
    const reactions: Array<[string, string, string]> = [];
    const projection = (jobId: string, messageId: string): AgentJobStatusProjection =>
      ({ jobId, sourceType: 'line', ...key, sourceMessageId: messageId, status: 'completed', revision: '9' });
    const repository = {
      async claimNext() { if (claimed) return null; claimed = true; return job; },
      async getJob() { return job; },
      async sharesAgentRoomHistory() { return false; },
      async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
      async lookupSession() { return null; },
      async listTranscriptEvents() { return []; },
      async appendEvent() {},
      async bindSession() {},
      async clearExternalSession() { return true; },
      async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
      async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
      async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
      async cancelConversationJobs() { return []; },
      async settleFolded(leadJobId: string) { settleCalls.push(leadJobId); return [projection('f1', '102'), projection('f2', '103')]; },
    };
    const requests: AgentRunRequest[] = [];
    const turns: ResidentTurnOptions[] = [];
    const done: AgentEvent = { type: 'completed', finalText: 'one reply' };
    const bridge: AgentRunner = {
      async *run() { yield done; },
      async *runResident(request, turn) { requests.push(request); turns.push(turn); yield done; },
      hasResident() { return true; },
      resetResidents() { return 1; },
      async cancel() {},
    };
    const launcher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
      bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
    const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge,
      async () => {}, undefined, 1, 30_000, 5_000, 1,
      async (jobId, _key, messageId, reaction) => { reactions.push([jobId, messageId, reaction]); }, undefined,
      (item) => { lifecycle.push([item.jobId, item.status]); },
      launcher, fullToolsEnvironment, undefined, undefined, undefined, { committedLineSends: async () => 0 });
    service.kick(key);
    await service.idle();
    for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('lead prompt\nfollower one\nfollower two');
    expect(settleCalls).toEqual(['lead']);
    expect(lifecycle).toContainEqual(['f1', 'completed']);
    expect(lifecycle).toContainEqual(['f2', 'completed']);
    for (const [jobId, messageId] of [['lead', '101'], ['f1', '102'], ['f2', '103']] as const) {
      expect(reactions).toContainEqual([jobId, messageId, 'NICE']);
      expect(reactions).toContainEqual([jobId, messageId, 'LOVE']);
    }
  });
});
