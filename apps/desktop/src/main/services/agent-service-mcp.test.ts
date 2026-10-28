import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository, JobIdentity } from '@line-agent/database';
import { AgentService, MCP_OBSERVATION_TIMEOUT_MS, approvalSessionKey, type InternalMcpLauncher } from './agent-service.js';
import type { AgentJobEnvironment } from './agent-job-environment.js';
import { newAgentService } from './agent-service-test-support.js';
import { AGENT_ROOM_HISTORY_HINT, formatIdentityBlock, withAgentRoomHistoryHint, withIdentityBlock, withMcpSkill, withOutputChannel } from './mcp-skill.js';
import { InternalMcpCapabilityRegistry } from './internal-mcp-capabilities.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const TOKEN = `li_job_${'x'.repeat(43)}`;
const SKILL = '# linejs-mcp skill';

function fixture(options: { resume?: boolean; mint?: InternalMcpLauncher['mint']; skill?: string | null; line?: boolean; shares?: boolean; requestId?: string; scheduleContext?: InternalMcpLauncher['scheduleContext']; identity?: JobIdentity } = {}) {
  const job = { jobId: 'job-mcp', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'codex' as const,
    prompt: 'summarise', workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const,
    ...(options.line
      ? { sourceType: 'line' as const, sourceMessageId: 'msg-1', sourceRequestId: null, creationEpoch: 1 }
      : { sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: options.requestId ?? 'req', creationEpoch: null }), revision: '1' };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return options.shares ?? false; },
    ...(options.identity ? { async describeJobIdentity() { return options.identity!; } } : {}),
    async lookupSession() { return options.resume ? { externalSessionId: 'sess-1', generation: 3 } : null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const requests: AgentRunRequest[] = [];
  const minted: string[] = [];
  const released: string[] = [];
  const launcher: InternalMcpLauncher = {
    mint: options.mint ?? ((input) => { minted.push(`${input.jobId}:${input.generation}:${input.accountId}`); return { endpoint: 'http://127.0.0.1:1/mcp', token: TOKEN }; }),
    release: (id) => { released.push(id); },
    skill: async () => options.skill === undefined ? SKILL : options.skill,
    ...(options.scheduleContext ? { scheduleContext: options.scheduleContext } : {}),
  };
  return { job, repository, requests, minted, released, launcher, appended };
}
const published: Array<[string, AgentEvent]> = [];
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('built-in Agent MCP launch', () => {
  afterEach(() => { vi.useRealTimers(); published.length = 0; });

  it('mints a job-bound capability, prepends the Skill once, and releases at terminal', async () => {
    const f = fixture();
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, (id, event) => { published.push([id, event]); }, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    expect(f.minted).toEqual(['job-mcp:3:a']);
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    expect(request.mcp).toEqual({ endpoint: 'http://127.0.0.1:1/mcp', token: TOKEN });
    expect(request.prompt).toBe(withMcpSkill(SKILL, withOutputChannel(withAgentRoomHistoryHint('summarise'), 'ui')));
    expect(f.job.prompt).toBe('summarise');
    expect(request.prompt.split(SKILL).length - 1).toBe(1);
    expect(f.appended.find((event) => event.type === 'mcp_status')).toMatchObject({ status: 'configured', message: '已設定，等待工具載入' });
    expect(f.released).toContain('job-mcp');
    expect(JSON.stringify(f.appended)).not.toContain(TOKEN);
    expect(JSON.stringify(published)).not.toContain(TOKEN);
  });

  const runWith = async (f: ReturnType<typeof fixture>) => {
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    return f.requests[0]!;
  };

  it('puts the main-generated identity block into the run prompt only, and omits it when the lookup fails', async () => {
    const identity: JobIdentity = { agent: { accountId: 'a', name: 'Agentsaxo' }, admin: { accountId: 'a', chatId: 'uadmin', name: '徐佳誠' }, current: null };
    const f = fixture({ identity });
    const request = await runWith(f);
    expect(request.prompt).toBe(withMcpSkill(SKILL, withOutputChannel(withIdentityBlock(withAgentRoomHistoryHint('summarise'), formatIdentityBlock(identity)), 'ui')));
    expect(f.job.prompt).toBe('summarise');
    const broken = fixture();
    (broken.repository as unknown as { describeJobIdentity: () => Promise<never> }).describeJobIdentity = async () => { throw new Error('db down'); };
    expect((await runWith(broken)).prompt).toBe(withMcpSkill(SKILL, withOutputChannel(withAgentRoomHistoryHint('summarise'), 'ui')));
  });

  it('injects the hidden schedule context only for schedule-sourced jobs and never into the stored prompt', async () => {
    const scheduleContext = vi.fn(async () => '【排程規則】CTX');
    const scheduled = fixture({ requestId: 'schedule:11111111-1111-4111-8111-111111111111:2026-10-01T01:00:00.000Z', scheduleContext });
    const request = await runWith(scheduled);
    expect(scheduleContext).toHaveBeenCalledWith('schedule:11111111-1111-4111-8111-111111111111:2026-10-01T01:00:00.000Z');
    expect(request.prompt).toBe(withMcpSkill(SKILL, withOutputChannel(withAgentRoomHistoryHint('summarise\n\n【排程規則】CTX'), 'ui')));
    expect(scheduled.job.prompt).toBe('summarise');
    const plain = fixture({ scheduleContext });
    scheduleContext.mockClear();
    expect((await runWith(plain)).prompt).not.toContain('CTX');
    expect(scheduleContext).not.toHaveBeenCalled();
  });

  it('still runs a schedule-sourced job with a one-line note when the context lookup fails', async () => {
    for (const scheduleContext of [async () => null, async () => { throw new Error('gone'); }]) {
      const f = fixture({ requestId: 'schedule:11111111-1111-4111-8111-111111111111:2026-10-01T01:00:00.000Z', scheduleContext });
      const request = await runWith(f);
      expect(request.prompt).toContain('summarise\n\n（排程資料讀取失敗');
      expect(request.prompt).toContain(SKILL);
    }
  });

  it('tells a LINE-sourced job to answer in plain text exactly once', async () => {
    const f = fixture({ line: true });
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    const line = '輸出位置：LINE（只能用純文字，不要使用 Markdown）';
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.prompt.split(line).length - 1).toBe(1);
    expect(f.requests[0]!.prompt).not.toContain('輸出位置：Agent 聊天室');
  });

  it('gets a fresh capability and one Skill copy on resume', async () => {
    const f = fixture({ resume: true });
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 'sess-1' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    expect(f.requests[0]).toMatchObject({ resumeSessionId: 'sess-1', mcp: { token: TOKEN } });
    expect(f.requests[0]!.prompt.split(SKILL).length - 1).toBe(1);
    expect(f.minted).toHaveLength(1);
  });

  const runOnce = async (f: ReturnType<typeof fixture>) => {
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    return f.requests[0]!;
  };

  it('adds the history guidance once to every Agent room run with MCP, including resumed sessions', async () => {
    for (const needle of ['query_agent_room_history', '目前脈絡沒有足夠資訊', '最終回覆', '原始工具輸出', '遭拒', '不可信資料']) {
      expect(AGENT_ROOM_HISTORY_HINT).toContain(needle);
    }
    const fresh = await runOnce(fixture());
    expect(fresh.prompt).toBe(`${SKILL}

---

輸出位置：Agent 聊天室（可使用 Markdown）

${AGENT_ROOM_HISTORY_HINT}

summarise`);
    expect(fresh.prompt.split(AGENT_ROOM_HISTORY_HINT).length - 1).toBe(1);
    const resumed = await runOnce(fixture({ resume: true }));
    expect(resumed.prompt).toContain(AGENT_ROOM_HISTORY_HINT);
    expect(resumed.prompt.split(AGENT_ROOM_HISTORY_HINT).length - 1).toBe(1);
    const noMcp = await runOnce(fixture({ mint: () => null }));
    expect(noMcp.prompt).toBe('summarise');
    const noSkill = await runOnce(fixture({ skill: null, resume: true }));
    expect(noSkill.prompt).toContain(AGENT_ROOM_HISTORY_HINT);
    expect(noSkill.prompt).not.toContain(SKILL);
  });

  it('adds the hint to an admin-direct LINE run only while the room shares that chat', async () => {
    const shared = await runOnce(fixture({ line: true, shares: true }));
    expect(shared.prompt).toContain(`${AGENT_ROOM_HISTORY_HINT}

summarise`);
    expect(shared.prompt.split(AGENT_ROOM_HISTORY_HINT).length - 1).toBe(1);
    const notShared = await runOnce(fixture({ line: true, shares: false }));
    expect(notShared.prompt).not.toContain('query_agent_room_history');
    expect(notShared.prompt).toContain(SKILL);
    const resumedShared = await runOnce(fixture({ line: true, shares: true, resume: true }));
    expect(resumedShared.prompt).toContain(AGENT_ROOM_HISTORY_HINT);
    expect(resumedShared.prompt.split(AGENT_ROOM_HISTORY_HINT).length - 1).toBe(1);
  });

  it('reports MCP not loaded and runs without MCP when no capability can be minted', async () => {
    const f = fixture({ mint: () => null });
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await service.idle();
    expect(f.requests[0]!.mcp).toBeUndefined();
    expect(f.requests[0]!.prompt).toBe('summarise');
    expect(f.appended.find((event) => event.type === 'mcp_status')).toMatchObject({ status: 'not_loaded', message: 'MCP 未載入' });
    expect(f.appended.some((event) => event.type === 'completed')).toBe(true);
  });

  it('moves configured to available when the handshake is observed', async () => {
    const f = fixture();
    let service!: ReturnType<typeof newAgentService>;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; await gate; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    for (let i = 0; i < 50 && f.requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.noteMcpObservation('job-mcp', 'initialized');
    expect(f.appended.filter((event) => event.type === 'mcp_status')).toHaveLength(1);
    service.noteMcpObservation('job-mcp', 'available');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.appended.filter((event) => event.type === 'mcp_status').map((event) => (event as { status: string }).status)).toEqual(['configured', 'available']);
    open();
    await service.idle();
    service.noteMcpObservation('job-mcp', 'available');
    expect(f.appended.filter((event) => event.type === 'mcp_status')).toHaveLength(2);
  });

  it('reports MCP not loaded after the observation timeout without failing the job', async () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const service = newAgentService(f.repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, {
      async *run(request) { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; await gate; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    }, undefined, undefined, 1, 30 * 60_000, 5_000, 1, undefined, undefined, undefined, f.launcher);
    service.kick(key);
    await vi.advanceTimersByTimeAsync(5);
    await settle();
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MCP_OBSERVATION_TIMEOUT_MS + 10);
    await settle();
    expect(f.appended.filter((event) => event.type === 'mcp_status').map((event) => (event as { status: string }).status)).toEqual(['configured', 'not_loaded']);
    expect(f.appended.some((event) => event.type === 'failed')).toBe(false);
    open();
    await vi.advanceTimersByTimeAsync(5);
    await service.idle();
    expect(f.appended.some((event) => event.type === 'completed')).toBe(true);
  });

  it('keeps launch bounded: capability registry is empty after jobs drain and on shutdown', () => {
    const registry = new InternalMcpCapabilityRegistry(2);
    registry.mint({ jobId: 'j1', accountId: 'a', generation: 1, endpointInstance: 'e' });
    registry.mint({ jobId: 'j2', accountId: 'a', generation: 1, endpointInstance: 'e' });
    expect(() => registry.mint({ jobId: 'j3', accountId: 'a', generation: 1, endpointInstance: 'e' })).toThrow(/limit/);
    registry.release('j1');
    registry.releaseAll();
    expect(registry.size).toBe(0);
    expect(() => registry.mint({ jobId: 'j4', accountId: 'a', generation: 1, endpointInstance: 'e' })).toThrow(/closed/);
  });
});

describe('interactive approval binding at launch', () => {
  type Approval = Parameters<InternalMcpLauncher['mint']>[0]['approval'];
  const sessionKey = { accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'codex', sourceType: 'ui' };
  async function launch(interactiveApproval: boolean, jobExtra: Record<string, unknown>): Promise<Approval[]> {
    const approvals: Approval[] = [];
    const f = fixture({ mint: (input) => { approvals.push(input.approval); return { endpoint: 'http://127.0.0.1:1/mcp', token: TOKEN }; } });
    Object.assign(f.job, jobExtra);
    const environment: AgentJobEnvironment = { prepare: async () => ({ ok: true, workspacePath: 'C:\trusted\room',
      tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write', webTools: false, interactiveApproval } }) };
    const runner = {
      async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> { f.requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
      async cancel() {},
    };
    const Service = AgentService as unknown as new (...args: unknown[]) => AgentService;
    const service = new Service(f.repository, { current: async () => 'C:\trusted' }, runner, undefined, undefined, 1, 30_000, 5_000, 1,
      undefined, undefined, undefined, f.launcher, environment);
    service.kick(key);
    await service.idle();
    expect(f.requests).toHaveLength(1);
    return approvals;
  }

  it('passes an approval binding only for interactive-approval jobs', async () => {
    expect(await launch(false, {})).toEqual([null]);
    const [approval] = await launch(true, { sessionKey, sessionGeneration: 4 });
    expect(approval).toEqual({ sessionKey: approvalSessionKey(sessionKey, 4), workspaceRoot: 'C:\trusted\room' });
  });

  it('keys the session allowlist by provider session and generation, so /new yields a new session', async () => {
    const [first] = await launch(true, { sessionKey, sessionGeneration: 4 });
    const [again] = await launch(true, { sessionKey: { ...sessionKey }, sessionGeneration: 4 });
    const [renewed] = await launch(true, { sessionKey, sessionGeneration: 5 });
    expect(again!.sessionKey).toBe(first!.sessionKey);
    expect(renewed!.sessionKey).not.toBe(first!.sessionKey);
    expect(JSON.parse(renewed!.sessionKey)).toEqual({ sessionKey, sessionGeneration: 5 });
    // Key order of the stored session identity does not change the binding.
    const reordered = Object.fromEntries(Object.entries(sessionKey).reverse());
    expect(approvalSessionKey(reordered, 4)).toBe(first!.sessionKey);
  });
});
