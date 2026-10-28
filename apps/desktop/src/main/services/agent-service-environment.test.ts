import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { AgentService } from './agent-service.js';
import type { AgentJobEnvironment } from './agent-job-environment.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'group', chatId: 'g' };

function fixture(environment: AgentJobEnvironment) {
  const job = { jobId: 'job-env', accountId: 'a', chatType: 'group' as const, chatId: 'g', provider: 'claude' as const,
    prompt: 'hi', workspacePath: 'C:\\configured', generation: 1, status: 'running' as const,
    sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 0, revision: '1' };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const lookups: string[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async lookupSession(input: { workspacePath: string }) { lookups.push(input.workspacePath); return null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const requests: AgentRunRequest[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\configured' }, {
    async *run(request) { requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, undefined, environment);
  return { service, requests, appended, lookups };
}

describe('agent-service hands the workspace and tool decision to the runner as data', () => {
  it('uses the environment plan for cwd, session lookup and the tool policy (row 4b)', async () => {
    const tools = { localTools: false, fileRead: true, fileWrite: false, linkedReadDirs: ['C:\\ws\\groups\\x'], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: false, interactiveApproval:false };
    const f = fixture({ prepare: async () => ({ ok: true, workspacePath: 'C:\\ws\\groups\\own', tools }) });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ workspacePath: 'C:\\ws\\groups\\own', tools });
    expect(f.lookups).toEqual(['C:\\ws\\groups\\own']);
  });

  it('passes the plan extensions to the runner and sends none when the plan has none', async () => {
    const tools = { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: false, interactiveApproval: false };
    const extensions = { servers: [], tools: { webSearch: true, webFetch: false, bash: false, fileRead: false, fileWrite: false } };
    const withExtensions = fixture({ prepare: async () => ({ ok: true, workspacePath: 'C:\ws', tools, extensions }) });
    withExtensions.service.kick(key); await withExtensions.service.idle();
    expect(withExtensions.requests[0]).toMatchObject({ extensions });
    const without = fixture({ prepare: async () => ({ ok: true, workspacePath: 'C:\ws', tools }) });
    without.service.kick(key); await without.service.idle();
    expect('extensions' in without.requests[0]!).toBe(false);
  });

  it('fails the job closed before the runner starts when the environment refuses (row 8 / 15)', async () => {
    const f = fixture({ prepare: async () => ({ ok: false, code: 'CHAT_FOLDER_UNAVAILABLE', message: 'The chat folder is unavailable or escapes the workspace.' }) });
    f.service.kick(key);
    await f.service.idle();
    expect(f.requests).toHaveLength(0);
    expect(f.appended).toContainEqual({ type: 'failed', code: 'CHAT_FOLDER_UNAVAILABLE', message: 'The chat folder is unavailable or escapes the workspace.', retryable: false });
  });

  it('fails closed when the environment throws', async () => {
    const thrown = fixture({ prepare: async () => { throw new Error('boom'); } });
    thrown.service.kick(key);
    await thrown.service.idle();
    expect(thrown.requests).toHaveLength(0);
    expect(thrown.appended.some((event) => event.type === 'failed' && event.code === 'WORKSPACE_UNAVAILABLE')).toBe(true);
  });
});
