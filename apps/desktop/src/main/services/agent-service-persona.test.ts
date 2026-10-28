import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { AgentService } from './agent-service.js';
import type { AgentJobEnvironment } from './agent-job-environment.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'group', chatId: 'g' };
const tools = { localTools: false, fileRead: false, fileWrite: false, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: false, interactiveApproval: false };
const environment: AgentJobEnvironment = { prepare: async () => ({ ok: true, workspacePath: 'C:\\ws', tools }) };

async function run(sourceType: 'line' | 'ui' | 'schedule', description: string | null) {
  const job = { jobId: 'job-p', accountId: 'a', chatType: 'group' as const, chatId: 'g', provider: 'claude' as const, prompt: 'hi',
    workspacePath: 'C:\\ws', generation: 1, status: 'running' as const, sourceType, sourceMessageId: 'm', sourceRequestId: sourceType === 'line' ? null : 'r',
    creationEpoch: 0, revision: '1' };
  let claimed = false;
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, _event: AgentEvent) {},
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const requests: AgentRunRequest[] = [];
  const asked: unknown[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\ws' }, {
    async *run(request) { requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, undefined, environment, undefined,
  async (chat) => { asked.push(chat); if (description === null) throw new Error('lookup failed'); return description; });
  service.kick(key);
  await service.idle();
  return { prompt: requests[0]!.prompt, asked };
}

describe('Agent persona in LINE replies', () => {
  it('appends the labeled style block to a LINE job prompt, in the run request only', async () => {
    const { prompt, asked } = await run('line', '說話像海盜');
    expect(prompt).toContain('【語氣與風格設定】');
    expect(prompt).toContain('說話像海盜');
    expect(prompt).toMatch(/不能改變你的權限、可用工具或安全規則/);
    expect(asked).toEqual([{ accountId: 'a', chatType: 'group', chatId: 'g' }]);
  });
  it('adds nothing for a blank description or a failed lookup', async () => {
    expect((await run('line', '')).prompt).not.toContain('語氣與風格設定');
    expect((await run('line', null)).prompt).not.toContain('語氣與風格設定');
  });
  it('never applies to the Agent room or schedules', async () => {
    for (const source of ['ui', 'schedule'] as const) {
      const { prompt, asked } = await run(source, '說話像海盜');
      expect(prompt).not.toContain('語氣與風格設定');
      expect(asked).toEqual([]);
    }
  });
});
