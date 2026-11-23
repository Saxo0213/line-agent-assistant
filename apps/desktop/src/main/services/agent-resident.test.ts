import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { buildResidentPrompt, parseResidentKey, residentIdentity, residentKey } from './agent-resident.js';
import { newAgentService } from './agent-service-test-support.js';
import type { AgentRunner, InternalMcpLauncher } from './agent-service.js';
import { GROUP_MENTION_LINE, AGENT_ROOM_HISTORY_HINT, formatAskerLine, formatIdentityBlock, withIdentityBlock, withMcpSkill, withOutputChannel, type JobIdentityView } from './mcp-skill.js';

const groupIdentity: JobIdentityView = { agent: { accountId: 'a', name: 'Bot' }, admin: { accountId: 'a', chatId: 'uadmin', name: 'Admin' },
  current: { accountId: 'a', chatType: 'group', chatId: 'g1', title: 'Team', isAdmin: false, askerName: 'Mei' } };

describe('resident key', () => {
  it('round-trips a LINE key and the room key', () => {
    const line = residentKey(residentIdentity({ accountId: 'a', chatType: 'direct', chatId: 'c' }), 4, 'claude');
    expect(line).toBe('["claude",["line","a","direct","c"],4,"claude"]');
    expect(parseResidentKey(line)).toEqual({ identity: ['line', 'a', 'direct', 'c'], generation: 4, sourceId: 'claude' });
    const room = residentKey(residentIdentity({ accountId: null, chatType: null, chatId: null }), 1, 'acct-0123456789');
    expect(room).toBe('["claude",["ui"],1,"acct-0123456789"]');
    expect(parseResidentKey(room)).toEqual({ identity: ['ui'], generation: 1, sourceId: 'acct-0123456789' });
    expect(parseResidentKey('not json')).toBeNull();
    expect(parseResidentKey('["codex",["ui"],1,"codex"]')).toBeNull();
    expect(parseResidentKey('["claude",["line","a"],1,"claude"]')).toBeNull();
    expect(parseResidentKey('["claude",["ui"],1]')).toBeNull();
    expect(parseResidentKey('["claude",["ui"],1,"bad id"]')).toBeNull();
  });
});

describe('resident prompt builder', () => {
  const base = { sourceType: 'line' as const, skill: 'SKILL', mcp: true, historyEligible: true, identity: groupIdentity,
    visiblePrompt: 'hello', projectFolderSection: '\n\nFOLDERS', personaSection: '\n\nPERSONA', replySection: '\n\nREPLY', attachmentSection: '\n\nFILES' };

  it('puts the fixed parts in the system prompt and the per-turn parts in the message', () => {
    const { systemPrompt, message } = buildResidentPrompt(base);
    const block = formatIdentityBlock(groupIdentity, { asker: false });
    expect(systemPrompt).toBe(`SKILL\n\n---\n\n${withOutputChannel('', 'line').trimEnd()}\n\n${AGENT_ROOM_HISTORY_HINT}\n\n${block}\n\nFOLDERS\n\nPERSONA`);
    expect(block).not.toContain('提問者');
    expect(block).toContain(GROUP_MENTION_LINE);
    expect(message).toBe('提問者：Mei\n\nhello\n\nREPLY\n\nFILES');
  });

  it('adds no asker line outside group and room chats and leaves the MCP parts out without MCP', () => {
    const direct: JobIdentityView = { ...groupIdentity, current: { ...groupIdentity.current!, chatType: 'direct' } };
    expect(buildResidentPrompt({ ...base, identity: direct }).message).toBe('hello\n\nREPLY\n\nFILES');
    expect(formatAskerLine(direct)).toBeNull();
    const none = buildResidentPrompt({ ...base, mcp: false, identity: null, historyEligible: false });
    expect(none.systemPrompt).toBe('FOLDERS\n\nPERSONA');
  });

  it('keeps each part text equal to the one-shot parts', () => {
    const oneShot = withMcpSkill('SKILL', withOutputChannel(withIdentityBlock('hello', formatIdentityBlock(groupIdentity)), 'line'));
    expect(oneShot).toContain('提問者：Mei');
    expect(formatIdentityBlock(groupIdentity)).toContain(formatAskerLine(groupIdentity)!);
  });
});

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };

function serviceFixture(provider: 'claude' | 'codex', sourceType: 'line' | 'schedule', bridgeExtra: Partial<AgentRunner>) {
  const job = { jobId: 'job-r', accountId: sourceType === 'line' ? 'a' : null, chatType: sourceType === 'line' ? 'direct' as const : null,
    chatId: sourceType === 'line' ? 'c' : null, provider, prompt: 'hi', workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const,
    sourceType, sourceMessageId: sourceType === 'line' ? 'm1' : null, sourceRequestId: sourceType === 'line' ? null : 'schedule:1', creationEpoch: 1, revision: '1' };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const calls: string[] = [];
  const turns: Array<{ request: AgentRunRequest; key: string; systemPrompt: string | undefined; endpoint: string | null }> = [];
  const bound: unknown[] = [];
  const reset: string[][] = [];
  const done = async function* (): AsyncGenerator<AgentEvent> { yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; };
  const bridge: AgentRunner = {
    async *run(request) { calls.push('run'); void request; yield* done(); },
    async *runResident(request, turn) {
      calls.push('runResident'); turns.push({ request, key: turn.key, systemPrompt: turn.systemPrompt, endpoint: turn.mcpEndpoint });
      bound.push(turn.bindMcp(true), turn.bindMcp(false));
      yield* done();
    },
    resetResidents(predicate) { reset.push(['k']); this_keys.forEach((k) => { if (predicate(k.key)) k.hit = true; }); return 0; },
    async cancel() {},
    ...bridgeExtra,
  };
  const this_keys: Array<{ key: string; hit: boolean }> = [
    { key: residentKey(residentIdentity(key), 3, 'claude'), hit: false }, { key: residentKey(['ui'], 3, 'claude'), hit: false },
    { key: residentKey(['line', 'a', 'direct', 'other'], 3, 'claude'), hit: false }];
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: (input) => (input.fresh ? { endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' } : { endpoint: 'http://127.0.0.1:1/mcp', rebound: true }) };
  const service = newAgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge,
    undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, launcher);
  return { service, calls, turns, bound, appended, this_keys, repository };
}

describe('AgentService resident path', () => {
  it('runs a Claude LINE job on runResident with the split prompt and the bound token', async () => {
    const f = serviceFixture('claude', 'line', {});
    f.service.kick(key);
    await f.service.idle();
    expect(f.calls).toEqual(['runResident']);
    expect(f.turns[0]!.key).toBe(residentKey(residentIdentity(key), 3, 'claude'));
    expect(f.turns[0]!.endpoint).toBe('http://127.0.0.1:1/mcp');
    expect(f.turns[0]!.systemPrompt).toContain('SKILL');
    expect(f.turns[0]!.request.prompt).toBe('hi');
    expect(f.bound).toEqual([{ token: 'tok' }, 'rebound']);
    expect(f.appended.find((event) => event.type === 'mcp_status')).toMatchObject({ status: 'configured' });
  });

  it('keeps Codex jobs and schedule runs on run()', async () => {
    const codex = serviceFixture('codex', 'line', {});
    codex.service.kick(key);
    await codex.service.idle();
    expect(codex.calls).toEqual(['run']);
    const schedule = serviceFixture('claude', 'schedule', {});
    schedule.service.kick({ accountId: null, chatType: 'schedule', chatId: null });
    await schedule.service.idle();
    expect(schedule.calls).toEqual(['run']);
  });

  it('stopChat resets the residents of that chat only', async () => {
    const f = serviceFixture('claude', 'line', {});
    await f.service.stopChat(key);
    expect(f.this_keys.map((k) => k.hit)).toEqual([true, false, false]);
  });

  it('stopChat also resets the Agent room key while the room shares the chat', async () => {
    const f = serviceFixture('claude', 'line', {});
    (f.repository as unknown as { sharesAgentRoomHistory: () => Promise<boolean> }).sharesAgentRoomHistory = async () => true;
    await f.service.stopChat(key);
    expect(f.this_keys.map((k) => k.hit)).toEqual([true, true, false]);
  });

  it('noteAgentPolicyChanged marks every resident stale', () => {
    let seen = false;
    const f = serviceFixture('claude', 'line', { markResidentsStale(predicate) { seen = predicate('anything'); return 0; } });
    f.service.noteAgentPolicyChanged();
    expect(seen).toBe(true);
  });
});
