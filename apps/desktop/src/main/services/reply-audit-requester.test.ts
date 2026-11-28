import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import { allPermissions, type AgentRepository, type JobPolicy } from '@line-agent/database';
import { AgentJobEnvironmentService, type AgentJobEnvironment } from './agent-job-environment.js';
import { buildResidentPrompt } from './agent-resident.js';
import { AgentService, type InternalMcpLauncher } from './agent-service.js';
import { REQUESTER_LINES } from './reply-audit-service.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'group', chatId: 'g' };
const tools = { localTools: false, fileRead: false, fileWrite: false, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: false, interactiveApproval: false };

async function runOneShot(sourceType: 'line' | 'ui', requester: 'admin' | 'member') {
  const environment: AgentJobEnvironment = { prepare: async () => ({ ok: true, workspacePath: 'C:\\ws', tools, requester }) };
  const job = { jobId: 'job-r', accountId: 'a', chatType: 'group' as const, chatId: 'g', provider: 'codex' as const, prompt: 'hi',
    workspacePath: 'C:\\ws', generation: 1, status: 'running' as const, sourceType, sourceMessageId: 'm', sourceRequestId: sourceType === 'line' ? null : 'r',
    creationEpoch: 0, revision: '1' };
  let claimed = false;
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, _event: AgentEvent) {},
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const launcher: InternalMcpLauncher = { mint: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: `li_job_${'x'.repeat(43)}` }), release: () => {}, skill: async () => '# skill' };
  const requests: AgentRunRequest[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\ws' }, {
    async *run(request) { requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, launcher, environment);
  service.kick(key);
  await service.idle();
  return requests[0]!.prompt;
}

describe('發問者 line of a LINE job', () => {
  it('names the Primary Admin or a member in the run request of a LINE job', async () => {
    expect(await runOneShot('line', 'admin')).toContain('發問者：主要管理者');
    const member = await runOneShot('line', 'member');
    expect(member).toContain('發問者：成員');
    expect(member).not.toContain('發問者：主要管理者');
  });
  it('is not added to an Agent room job', async () => {
    expect(await runOneShot('ui', 'member')).not.toContain('發問者');
  });
  it('is the first line of the turn message of a resident job', () => {
    const base = { sourceType: 'line' as const, skill: 'SKILL', mcp: true, historyEligible: false, identity: null, visiblePrompt: 'hello',
      projectFolderSection: '', personaSection: '', replySection: '', attachmentSection: '' };
    expect(buildResidentPrompt({ ...base, requesterLine: REQUESTER_LINES.member }).message).toBe('發問者：成員\n\nhello');
    expect(buildResidentPrompt({ ...base, requesterLine: REQUESTER_LINES.admin }).message).toBe('發問者：主要管理者\n\nhello');
    expect(buildResidentPrompt(base).message).toBe('hello');
  });
  it('comes from the job policy: admin and operator are admin, a user is a member', async () => {
    const plan = async (principal: JobPolicy['principal']) => await new AgentJobEnvironmentService({
      resolvePolicy: async () => ({ principal, accountId: 'a', chatType: 'direct', chatId: 'c', permissions: allPermissions('ALLOW'), linkedChats: [] }),
      folders: { resolve: async () => ({ path: process.cwd() }) } as never, workspace: { current: async () => process.cwd() },
    }).prepare('j');
    expect(await plan({ kind: 'admin', userId: 'A' })).toMatchObject({ ok: true, requester: 'admin' });
    expect(await plan({ kind: 'operator' })).toMatchObject({ ok: true, requester: 'admin' });
    expect(await plan({ kind: 'user', senderMid: 'U' })).toMatchObject({ ok: true, requester: 'member' });
  });
});
