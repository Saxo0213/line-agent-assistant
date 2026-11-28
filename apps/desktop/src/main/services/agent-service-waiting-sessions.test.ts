import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository, JobIdentity } from '@line-agent/database';
import { AgentService, type AgentServiceResidentOptions, type InternalMcpLauncher } from './agent-service.js';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { buildResidentPrompt } from './agent-resident.js';
import { formatWaitingSessionsSection } from './external-session-service.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const TOKEN = `li_job_${'x'.repeat(43)}`;
const SECTION = '\n\n---\nWaiting external sessions. Test text.\n#1 Build: running tests';
const SCHEDULE_REQUEST = 'schedule:11111111-1111-4111-8111-111111111111:2026-10-01T01:00:00.000Z';

const adminIdentity = (isAdmin: boolean): JobIdentity => ({ agent: { accountId: 'a', name: 'AgentDemo' }, admin: { accountId: 'a', chatId: 'c', name: 'Admin' },
  current: { accountId: 'a', chatType: 'direct', chatId: 'c', title: 'Admin', isAdmin } });

/** Runs one job through the one-shot (Codex) prompt path and returns the run request. */
async function run(options: { line?: boolean; isAdmin?: boolean; requestId?: string | null; mcp?: boolean; waiting?: AgentServiceResidentOptions['waitingSessionsSection'] }) {
  const line = options.line ?? true;
  const job = { jobId: 'job-w', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const, prompt: 'forward this', workspacePath: 'C:\\trusted',
    generation: 3, status: 'running' as const, revision: '1',
    ...(line ? { sourceType: 'line' as const, sourceMessageId: 'msg-1', sourceRequestId: options.requestId ?? null, creationEpoch: 1 }
      : { sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'req', creationEpoch: null }) };
  let claimed = false;
  const events: AgentEvent[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return adminIdentity(options.isAdmin ?? true); },
    async lookupSession() { return null; },
    async appendEvent(_id: string, event: AgentEvent) { events.push(event); },
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const launcher: InternalMcpLauncher = {
    mint: () => (options.mcp === false ? null : { endpoint: 'http://127.0.0.1:1/mcp', token: TOKEN }),
    release: () => undefined,
    skill: async () => '# skill',
  };
  const requests: AgentRunRequest[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
    async *run(request) { requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, launcher, fullToolsEnvironment, undefined, undefined, undefined,
  options.waiting ? { waitingSessionsSection: options.waiting } : {});
  service.kick(key);
  await service.idle();
  return { request: requests[0]!, job, events };
}

describe('waiting external sessions in the Agent prompt', () => {
  it('adds the list after the prompt of a Primary Admin job in the direct chat, and never to the stored prompt', async () => {
    const waiting = vi.fn(async () => SECTION);
    const { request, job } = await run({ waiting });
    expect(waiting).toHaveBeenCalledWith('a');
    expect(request.prompt.endsWith(`forward this${SECTION}`)).toBe(true);
    expect(request.prompt.split('Waiting external sessions.').length - 1).toBe(1);
    expect(job.prompt).toBe('forward this');
  });

  it('adds nothing for a job that is not a Primary Admin direct prompt job', async () => {
    const cases: Array<[string, Parameters<typeof run>[0]]> = [
      ['another chat or user', { isAdmin: false }],
      ['the Agent room', { line: false }],
      ['a schedule run', { requestId: SCHEDULE_REQUEST }],
      ['a job without MCP tools', { mcp: false }],
    ];
    for (const [name, options] of cases) {
      const waiting = vi.fn(async () => SECTION);
      const { request } = await run({ ...options, waiting });
      expect(waiting, name).not.toHaveBeenCalled();
      expect(request.prompt, name).not.toContain('Waiting external sessions');
    }
  });

  it('leaves the prompt unchanged when no session waits or when the lookup fails', async () => {
    const plain = (await run({})).request.prompt;
    expect((await run({ waiting: async () => '' })).request.prompt).toBe(plain);
    const failing = await run({ waiting: async () => { throw new Error('db down'); } });
    expect(failing.request.prompt).toBe(plain);
    expect(failing.events.some((event) => event.type === 'completed')).toBe(true);
  });

  it('puts the list at the end of the message of a resident turn and adds nothing when it is empty', () => {
    const base = { sourceType: 'line' as const, skill: null, mcp: true, historyEligible: false, identity: null, visiblePrompt: 'forward this',
      projectFolderSection: '', personaSection: '', replySection: '\n\n---\nreply', attachmentSection: '\n\nfiles' };
    expect(buildResidentPrompt({ ...base, waitingSessionsSection: SECTION }).message).toBe(`forward this\n\n---\nreply\n\nfiles${SECTION}`);
    expect(buildResidentPrompt({ ...base, waitingSessionsSection: '' }).message).toBe('forward this\n\n---\nreply\n\nfiles');
    expect(buildResidentPrompt(base).message).toBe('forward this\n\n---\nreply\n\nfiles');
    expect(buildResidentPrompt({ ...base, waitingSessionsSection: SECTION }).systemPrompt).not.toContain('Waiting external sessions');
  });
});

describe('formatWaitingSessionsSection', () => {
  it('gives an empty string for no session', () => {
    expect(formatWaitingSessionsSection([])).toBe('');
  });

  it('shows #n, the label and the first 80 characters of the last text, and the label only when the text is unknown', () => {
    const long = `${'あ'.repeat(79)}XY and more`;
    const section = formatWaitingSessionsSection([
      { seq: 2, label: 'Build', lastText: '【Build #2】Tests\nare   running' },
      { seq: 3, label: 'Docs', lastText: long },
      { seq: 5, label: 'Quiet', lastText: null },
      { seq: 6, label: 'Tag only', lastText: '【Tag only #6】' },
    ]);
    expect(section.startsWith('\n\n---\nWaiting external sessions. If the message of the admin answers one of these sessions, call forward_to_session with its number')).toBe(true);
    const lines = section.split('\n').slice(-4);
    expect(lines).toEqual(['#2 Build: Tests are running', `#3 Docs: ${'あ'.repeat(79)}X`, '#5 Quiet', '#6 Tag only']);
  });
});
