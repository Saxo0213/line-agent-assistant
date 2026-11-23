import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunRequest, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import type { ResidentTurnOptions } from '@line-agent/agent-bridge';
import { fullToolsEnvironment } from './agent-service-test-support.js';
import { AgentService, type AgentRunner, type AgentServiceResidentOptions, type InternalMcpLauncher } from './agent-service.js';
import type { TranscriptEvent } from './agent-transcript.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'direct', chatId: 'c' };
const done: AgentEvent[] = [{ type: 'completed', finalText: 'ok' }];
const history: TranscriptEvent[] = [{ role: 'user', text: 'earlier  question' }, { role: 'assistant', text: 'earlier answer' }];

interface Options {
  resume: boolean;
  resident: boolean;
  attempts?: AgentEvent[][];
  transcript?: () => Promise<TranscriptEvent[]>;
  residentOptions?: AgentServiceResidentOptions;
}

function fixture(options: Options) {
  const job = { jobId: 'job-p', accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'claude' as const, prompt: 'now',
    workspacePath: 'C:\\trusted', generation: 3, status: 'running' as const, sourceType: 'line' as const, sourceMessageId: 'm1',
    sourceRequestId: null, creationEpoch: 1, revision: '1' };
  let claimed = false;
  const transcriptCalls: unknown[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async sharesAgentRoomHistory() { return false; },
    async describeJobIdentity() { return { agent: null, admin: null, current: null }; },
    async lookupSession() { return options.resume ? { externalSessionId: 'old-session', generation: 3 } : null; },
    async listTranscriptEvents(input: unknown) { transcriptCalls.push(input); return options.transcript ? options.transcript() : history; },
    async appendEvent() {},
    async bindSession() {},
    async clearExternalSession() { return true; },
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
    async cancelConversationJobs() { return []; },
  };
  const requests: AgentRunRequest[] = [];
  const turns: ResidentTurnOptions[] = [];
  const attempts = options.attempts ?? [done];
  const bridge: AgentRunner = {
    async *run() { yield done[0]!; },
    async *runResident(request, turn) { requests.push(request); turns.push(turn); yield* (attempts[requests.length - 1] ?? done); },
    hasResident() { return options.resident; },
    resetResidents() { return 1; },
    async cancel() {},
  };
  const launcher: InternalMcpLauncher = { mint: () => null, release: () => undefined, skill: async () => 'SKILL', endpoint: () => 'http://127.0.0.1:1/mcp',
    bindResident: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: 'tok' }) };
  const diagnostics: Array<{ stage?: string }> = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => 'C:\\trusted' }, bridge,
    async () => {}, undefined, 1, 30_000, 5_000, 1,
    async () => {}, undefined, () => {},
    launcher, fullToolsEnvironment, (diagnostic) => diagnostics.push(diagnostic), undefined, undefined,
    { committedLineSends: async () => 0, ...options.residentOptions });
  return { service, requests, turns, transcriptCalls, diagnostics };
}

const preamble = 'Recent LINEJS transcript for continuity:\nUser: earlier question\nAssistant: earlier answer\n\nCurrent user message:\n';

async function run(f: ReturnType<typeof fixture>): Promise<void> {
  f.service.kick(key);
  await f.service.idle();
}

describe('AgentService resident transcript preamble', () => {
  it('adds the preamble when there is no session to resume and no live resident process', async () => {
    const f = fixture({ resume: false, resident: false });
    await run(f);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.resumeSessionId).toBeUndefined();
    expect(f.requests[0]!.prompt.startsWith(preamble)).toBe(true);
    expect(f.requests[0]!.prompt).toContain('now');
    expect(f.transcriptCalls).toEqual([{ jobId: 'job-p', generation: 3 }]);
  });

  it('adds no preamble when the request resumes a session', async () => {
    const f = fixture({ resume: true, resident: false });
    await run(f);
    expect(f.requests[0]!.resumeSessionId).toBe('old-session');
    expect(f.requests[0]!.prompt).not.toContain('Recent LINEJS transcript');
    expect(f.transcriptCalls).toEqual([]);
  });

  it('adds no preamble when a resident process is alive', async () => {
    const f = fixture({ resume: false, resident: true });
    await run(f);
    expect(f.requests[0]!.prompt).not.toContain('Recent LINEJS transcript');
    expect(f.transcriptCalls).toEqual([]);
  });

  it('keeps the message unchanged when the transcript is empty', async () => {
    const f = fixture({ resume: false, resident: false, transcript: async () => [] });
    await run(f);
    expect(f.requests[0]!.prompt).not.toContain('Recent LINEJS transcript');
  });

  it('reports a prepare diagnostic and keeps the message when the transcript read fails', async () => {
    const f = fixture({ resume: false, resident: false, transcript: async () => { throw new Error('db down'); } });
    await run(f);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.prompt).not.toContain('Recent LINEJS transcript');
    expect(f.diagnostics.map((diagnostic) => diagnostic.stage)).toEqual(['prepare']);
  });

  it('sends the same message in both attempts of a self-heal and reads the transcript once', async () => {
    const f = fixture({ resume: true, resident: false,
      attempts: [[{ type: 'failed', code: 'CLI_EXIT', message: 'The CLI stopped.', retryable: false }], done] });
    // A resumed first attempt has no preamble; the second attempt keeps the same message.
    await run(f);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.prompt).toBe(f.requests[0]!.prompt);
    expect(f.transcriptCalls).toEqual([]);
    const g = fixture({ resume: false, resident: false,
      attempts: [[{ type: 'failed', code: 'CLI_EXIT', message: 'The CLI stopped.', retryable: false }], done] });
    await run(g);
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]!.prompt).toBe(g.requests[0]!.prompt);
    expect(g.requests[0]!.prompt.startsWith(preamble)).toBe(true);
    expect(g.transcriptCalls).toHaveLength(1);
  });
});

describe('AgentService resident model', () => {
  it('puts the chat model of the job in the resident turn options', async () => {
    const seen: string[] = [];
    const f = fixture({ resume: true, resident: true, residentOptions: { resolveClaudeModel: async (job) => { seen.push(job.jobId); return 'sonnet'; } } });
    await run(f);
    expect(f.turns[0]!.model).toBe('sonnet');
    expect(seen).toEqual(['job-p']);
  });

  it('leaves the model out when the chat has none', async () => {
    const f = fixture({ resume: true, resident: true, residentOptions: { resolveClaudeModel: async () => null } });
    await run(f);
    expect('model' in f.turns[0]!).toBe(false);
  });

  it('leaves the model out without a resolver', async () => {
    const f = fixture({ resume: true, resident: true });
    await run(f);
    expect(f.turns[0]!.model).toBeUndefined();
  });

  it('reports a prepare diagnostic and uses the default model when the resolver fails', async () => {
    const f = fixture({ resume: true, resident: true, residentOptions: { resolveClaudeModel: async () => { throw new Error('db down'); } } });
    await run(f);
    expect(f.turns[0]!.model).toBeUndefined();
    expect(f.requests).toHaveLength(1);
    expect(f.diagnostics.map((diagnostic) => diagnostic.stage)).toEqual(['prepare']);
  });
});
