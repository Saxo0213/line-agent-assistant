import { describe, expect, it } from 'vitest';
import type { AgentJob, AgentJobStatusProjection, PendingTurn, RouteDecision } from '@line-agent/database';
import { AgentFailoverTurns, CLAIM_LOST_TEXT } from './agent-failover-turns.js';

const lineage = JSON.stringify(['line', 'a', 'direct', 'c']);
const lineJob = { jobId: 'job-1', sourceType: 'line', accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'claude', generation: 2 } as unknown as AgentJob;

function fixture(input: { enabled?: boolean; decision?: RouteDecision; enqueueRefused?: boolean; job?: AgentJob | null; rows?: Array<Partial<PendingTurn>>; shuttingDown?: boolean } = {}) {
  const calls: string[] = [];
  const routed: unknown[] = [];
  const enqueued: unknown[] = [];
  const kicked: unknown[] = [];
  const published: string[] = [];
  const reported: unknown[] = [];
  const rows = input.rows ?? [{}];
  const row = (extra: Partial<PendingTurn>): PendingTurn => ({ pendingId: 'p-1', originJobId: 'job-1', activeJobId: null, lineageKey: lineage, userText: 'hello', status: 'exhausted',
    hadToolActivity: false, hadEffectiveOutput: false, attemptedSourceIds: ['claude'], attemptCount: 1, ...extra } as PendingTurn);
  const turns = new AgentFailoverTurns({
    enabled: async () => input.enabled ?? true,
    routeFor: async (call) => { routed.push(call); return input.decision ?? { kind: 'switch_required', provider: 'codex', sourceId: 'codex' }; },
    store: {
      get: async () => null, findByJob: async () => null, recordFailure: async () => null,
      bindActiveJob: async (id, jobId) => { calls.push(`bind:${id}:${jobId}`); return true; },
      claimSafe: async (id, sourceId) => { calls.push(`claim:${id}:${sourceId}`); return row({ pendingId: id, status: 'replaying', attemptCount: 2 }); },
      markCompleted: async () => true, markExhausted: async () => true,
      requireConfirmation: async (id, reason) => { calls.push(`confirm:${id}:${reason}`); return true; },
      supersedeMatching: async () => true,
      recoverableSnapshot: async (limit) => { calls.push(`snapshot:${limit}`); return rows.map((extra, index) => row({ pendingId: `p-${index + 1}`, ...extra })); },
    },
    getJob: async (id) => { calls.push(`job:${id}`); return input.job === undefined ? lineJob : input.job; },
    enqueueContinuation: async (call) => { enqueued.push(call); return input.enqueueRefused ? null : { jobId: `cont-${enqueued.length}` } as AgentJobStatusProjection; },
    currentBinding: async () => ({ workerInstanceId: 'w1', controlEpoch: 5 }),
    notify: () => { calls.push('notify'); },
    publish: (projection) => { published.push(projection.jobId); },
    kick: (key) => { kicked.push(key); },
    isShuttingDown: () => input.shuttingDown ?? false,
    report: (error) => { reported.push(error); },
  });
  return { turns, calls, routed, enqueued, kicked, published, reported };
}

describe('AgentFailoverTurns.recoverExhausted', () => {
  it('starts a continuation for a safe exhausted row', async () => {
    const f = fixture();
    expect(await f.turns.recoverExhausted()).toBe(1);
    expect(f.calls).toEqual(['snapshot:8', 'job:job-1', 'claim:p-1:codex', 'bind:p-1:cont-1']);
    expect(f.routed).toEqual([expect.objectContaining({ excluded: ['claude'], sessionGeneration: 2,
      sessionKey: expect.objectContaining({ accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'claude', sourceType: 'line' }) })]);
    expect(f.enqueued).toEqual([{ originJobId: 'job-1', prompt: 'hello', workerInstanceId: 'w1', controlEpoch: 5 }]);
    expect(f.published).toEqual(['cont-1']);
    expect(f.kicked).toEqual([{ accountId: 'a', chatType: 'direct', chatId: 'c' }]);
  });

  it('reads the active job of a row and caps the limit at 8', async () => {
    const f = fixture({ rows: [{ activeJobId: 'job-9' }] });
    await f.turns.recoverExhausted(50);
    expect(f.calls.slice(0, 2)).toEqual(['snapshot:8', 'job:job-9']);
    expect(f.enqueued).toEqual([expect.objectContaining({ originJobId: 'job-9' })]);
  });

  it('skips a row with no route and sends no text', async () => {
    const f = fixture({ decision: { kind: 'all_sources_exhausted' } });
    expect(await f.turns.recoverExhausted()).toBe(0);
    expect(f.calls).toEqual(['snapshot:8', 'job:job-1']);
    expect(f.enqueued).toEqual([]);
  });

  it('skips a missing job and a scheduled job', async () => {
    expect(await fixture({ job: null }).turns.recoverExhausted()).toBe(0);
    const schedule = fixture({ job: { ...lineJob, sourceType: 'schedule' } as unknown as AgentJob });
    expect(await schedule.turns.recoverExhausted()).toBe(0);
    expect(schedule.routed).toEqual([]);
  });

  it('requires a confirmation when the enqueue is refused', async () => {
    const f = fixture({ enqueueRefused: true });
    expect(await f.turns.recoverExhausted()).toBe(0);
    expect(f.calls).toContain(`confirm:p-1:${CLAIM_LOST_TEXT}`);
    expect(f.calls).not.toContain('notify');
    expect(f.published).toEqual([]);
  });

  it('does nothing with the switch off or during a shutdown', async () => {
    const off = fixture({ enabled: false });
    expect(await off.turns.recoverExhausted()).toBe(0);
    expect(off.calls).toEqual([]);
    const closing = fixture({ shuttingDown: true });
    expect(await closing.turns.recoverExhausted()).toBe(0);
    expect(closing.calls).toEqual([]);
  });

  it('does not overlap two runs', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.turns.recoverExhausted(), f.turns.recoverExhausted()]);
    expect(first + second).toBe(1);
  });
});
