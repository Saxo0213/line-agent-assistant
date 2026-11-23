import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@line-agent/contracts';
import type { AgentJobStatusProjection, ClaimedAgentJob, PendingFailureInput, PendingTurn, RouteDecision, SessionKey } from '@line-agent/database';
import { AgentFailoverTurns, ALL_SOURCES_EXHAUSTED_TEXT, ATTEMPT_CAP_TEXT, QUOTA_NOTICE_TEXT, RATE_LIMIT_PROMPT, RATE_LIMIT_RESUME_TEXT, UNSAFE_REPLAY_TEXT,
  type FailoverTurnContext } from './agent-failover-turns.js';

type FailedEvent = Extract<AgentEvent, { type: 'failed' }>;
const sessionKey = { accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'claude', sourceType: 'line' } as SessionKey;
const lineage = JSON.stringify(['line', 'a', 'direct', 'c']);
const queueKey = { accountId: 'a', chatType: 'direct', chatId: 'c' } as const;

const failed = (code: string, extra: Partial<FailedEvent> = {}): FailedEvent => ({ type: 'failed', code, message: `${code} message`, retryable: true, ...extra });

function context(sourceType: 'line' | 'ui' | 'schedule' = 'line'): FailoverTurnContext {
  const job = { jobId: 'job-1', sourceType, accountId: sourceType === 'line' ? 'a' : null, chatType: sourceType === 'line' ? 'direct' : null,
    chatId: sourceType === 'line' ? 'c' : null, provider: 'claude' } as unknown as ClaimedAgentJob;
  return { job, queueKey: queueKey as FailoverTurnContext['queueKey'], sessionKey: sourceType === 'schedule' ? undefined : sessionKey, sessionGeneration: 3,
    sourceId: 'claude', userText: 'hello\nmore' };
}

function fixture(input: { enabled?: boolean; decision?: RouteDecision; attemptCount?: number; committed?: number | 'error'; enqueueRefused?: boolean;
  claimLost?: boolean; saveFails?: boolean; row?: Partial<PendingTurn> | null } = {}) {
  const calls: string[] = [];
  const recorded: PendingFailureInput[] = [];
  const notices: string[] = [];
  const enqueued: Array<{ originJobId: string; prompt: string; workerInstanceId?: string; controlEpoch?: number }> = [];
  const published: string[] = [];
  const kicked: unknown[] = [];
  const routed: unknown[] = [];
  const reported: unknown[] = [];
  const row = (extra: Partial<PendingTurn> = {}): PendingTurn => ({ pendingId: 'p-1', originJobId: 'job-1', activeJobId: 'job-1', lineageKey: lineage, userText: 'hello\nmore',
    status: 'pending', hadToolActivity: false, hadEffectiveOutput: false, attemptedSourceIds: ['claude'], attemptCount: input.attemptCount ?? 1, ...extra } as PendingTurn);
  const turns = new AgentFailoverTurns({
    enabled: async () => input.enabled ?? true,
    routeFor: async (call) => { routed.push(call); return input.decision ?? { kind: 'switch_required', provider: 'codex', sourceId: 'codex' }; },
    store: {
      get: async () => (input.row ? row(input.row) : null),
      findByJob: async () => (input.row ? row(input.row) : null),
      recordFailure: async (call) => { recorded.push(call); return input.saveFails ? null : row({ hadToolActivity: call.hadToolActivity, hadEffectiveOutput: call.hadEffectiveOutput }); },
      bindActiveJob: async (id, jobId) => { calls.push(`bind:${id}:${jobId}`); return true; },
      claimSafe: async (id, sourceId) => { calls.push(`claim:${id}:${sourceId}`); return input.claimLost ? null : row({ status: 'replaying', attemptCount: (input.attemptCount ?? 1) + 1 }); },
      markCompleted: async (id) => { calls.push(`completed:${id}`); return true; },
      markExhausted: async (id) => { calls.push(`exhausted:${id}`); return true; },
      requireConfirmation: async (id, reason) => { calls.push(`confirm:${id}:${reason}`); return true; },
      supersedeMatching: async (key, text) => { calls.push(`supersede:${key}:${text}`); return true; },
    },
    enqueueContinuation: async (call) => { enqueued.push(call); return input.enqueueRefused ? null : { jobId: `cont-${enqueued.length}` } as AgentJobStatusProjection; },
    currentBinding: async () => ({ workerInstanceId: 'w1', controlEpoch: 5 }),
    notify: (_job, text) => { notices.push(text); },
    publish: (projection) => { published.push(projection.jobId); },
    kick: (key) => { kicked.push(key); },
    isShuttingDown: () => false,
    ...(input.committed === undefined ? {} : { committedLineSends: async () => { if (input.committed === 'error') throw new Error('count failed'); return input.committed as number; } }),
    report: (error) => { reported.push(error); },
  });
  return { turns, calls, recorded, notices, enqueued, published, kicked, routed, reported };
}

afterEach(() => { vi.useRealTimers(); });

describe('AgentFailoverTurns quota and logout (P5 B3b)', () => {
  it('a safe quota failure sends T1, claims the new source, enqueues one continuation and binds it', async () => {
    const f = fixture();
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.recorded).toEqual([{ originJobId: 'job-1', lineageKey: lineage, userText: 'hello\nmore', provider: 'claude', sourceId: 'claude',
      hadToolActivity: false, hadEffectiveOutput: false, error: 'PROVIDER_LIMIT message' }]);
    expect(f.routed).toEqual([expect.objectContaining({ sessionGeneration: 3, excluded: ['claude'] })]);
    expect(f.calls).toEqual(['claim:p-1:codex', 'bind:p-1:cont-1']);
    expect(f.enqueued).toEqual([{ originJobId: 'job-1', prompt: 'hello\nmore', workerInstanceId: 'w1', controlEpoch: 5 }]);
    expect(f.notices).toEqual([QUOTA_NOTICE_TEXT]);
    expect(f.published).toEqual(['cont-1']);
    expect(f.kicked).toEqual([queueKey]);
  });

  it('a logout failure routes again without T1', async () => {
    const f = fixture();
    await f.turns.afterFailure(context(), failed('AUTH_REQUIRED'));
    expect(f.enqueued).toHaveLength(1);
    expect(f.notices).toEqual([]);
  });

  it('an unsafe failure sends T3 and enqueues nothing', async () => {
    const f = fixture();
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT', { hadToolActivity: true }));
    expect(f.enqueued).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.notices).toEqual([QUOTA_NOTICE_TEXT, UNSAFE_REPLAY_TEXT]);
  });

  it('committed LINE sends make the turn unsafe, and a failed count does too', async () => {
    for (const committed of [2, 'error'] as const) {
      const f = fixture({ committed });
      await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
      expect(f.recorded[0]!.hadEffectiveOutput).toBe(true);
      expect(f.enqueued).toEqual([]);
      expect(f.notices).toContain(UNSAFE_REPLAY_TEXT);
    }
    const none = fixture({ committed: 0 });
    await none.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(none.enqueued).toHaveLength(1);
  });

  it('the cap of 8 attempts requires confirmation and sends T5', async () => {
    const f = fixture({ attemptCount: 8 });
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.calls).toEqual(['confirm:p-1:自動接續已達重試上限']);
    expect(f.notices).toEqual([QUOTA_NOTICE_TEXT, ATTEMPT_CAP_TEXT]);
    expect(f.routed).toEqual([]);
    expect(f.enqueued).toEqual([]);
  });

  it('no route marks the row exhausted and sends T6', async () => {
    const f = fixture({ decision: { kind: 'all_sources_exhausted' } });
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.calls).toEqual(['exhausted:p-1']);
    expect(f.notices).toEqual([QUOTA_NOTICE_TEXT, ALL_SOURCES_EXHAUSTED_TEXT]);
    expect(f.enqueued).toEqual([]);
  });

  it('a lost claim or a refused enqueue keeps the row and sends T4', async () => {
    const lost = fixture({ claimLost: true });
    await lost.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(lost.enqueued).toEqual([]);
    expect(lost.notices.at(-1)).toContain('訊息已保留，請確認附件與執行狀態');
    const refused = fixture({ enqueueRefused: true });
    await refused.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(refused.calls.at(-1)).toMatch(/^confirm:p-1:/);
    expect(refused.notices.at(-1)).toContain('訊息已保留，請確認附件與執行狀態');
  });

  it('a row that cannot be saved sends the save-failed text and stops', async () => {
    const f = fixture({ saveFails: true });
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.notices).toEqual(['無法保存待接續訊息，請重新送出。']);
    expect(f.routed).toEqual([]);
  });

  it('a UI job gets no LINE text', async () => {
    const f = fixture();
    await f.turns.afterFailure(context('ui'), failed('PROVIDER_LIMIT'));
    expect(f.notices).toEqual([]);
    expect(f.enqueued).toEqual([{ originJobId: 'job-1', prompt: 'hello\nmore' }]);
  });
});

describe('AgentFailoverTurns continuation end (P5 B3b)', () => {
  const replaying = { status: 'replaying' as const, activeJobId: 'job-1' };

  it('a completed continuation completes its row', async () => {
    const f = fixture({ row: replaying });
    await f.turns.afterCompleted(context());
    expect(f.calls).toEqual(['completed:p-1']);
  });

  it('a job that is no continuation changes no row', async () => {
    const f = fixture({ row: { status: 'pending' } });
    await f.turns.afterCompleted(context());
    await f.turns.afterFailure(context(), failed('CLI_EXIT'));
    expect(f.calls).toEqual([]);
  });

  it('a continuation that fails with another code, or is cancelled, requires confirmation', async () => {
    const f = fixture({ row: replaying });
    await f.turns.afterFailure(context(), failed('CLI_EXIT'));
    await f.turns.afterCancelled(context());
    expect(f.calls).toEqual(['confirm:p-1:接續執行未完成，請確認後重新送出。', 'confirm:p-1:接續執行未完成，請確認後重新送出。']);
    expect(f.notices).toEqual([]);
  });

  it('a continuation that fails on quota again records the failure on its row and routes again', async () => {
    const f = fixture({ row: replaying });
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.recorded).toHaveLength(1);
    expect(f.enqueued).toHaveLength(1);
    expect(f.calls.some((call) => call.startsWith('confirm'))).toBe(false);
  });
});

describe('AgentFailoverTurns transient rate limit (P5 B3b)', () => {
  it('schedules one timer per lineage; the due timer sends T8 and enqueues with the system prompt', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    await f.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    expect(f.recorded).toEqual([]);
    expect(f.routed).toEqual([]);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(f.enqueued).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.notices).toEqual([RATE_LIMIT_RESUME_TEXT]);
    expect(f.enqueued).toEqual([{ originJobId: 'job-1', prompt: RATE_LIMIT_PROMPT, workerInstanceId: 'w1', controlEpoch: 5 }]);
    expect(f.published).toEqual(['cont-1']);
    expect(f.kicked).toEqual([queueKey]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.enqueued).toHaveLength(1);
  });

  it('a refused enqueue at the due time does nothing more, and dispose clears the timers', async () => {
    vi.useFakeTimers();
    const refused = fixture({ enqueueRefused: true });
    await refused.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    await vi.advanceTimersByTimeAsync(181_000);
    expect(refused.enqueued).toHaveLength(1);
    expect(refused.published).toEqual([]);
    const disposed = fixture();
    await disposed.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    disposed.turns.dispose();
    await vi.advanceTimersByTimeAsync(181_000);
    expect(disposed.enqueued).toEqual([]);
  });

  it('a continuation that hits the limit again hands its replaying row to the next continuation', async () => {
    vi.useFakeTimers();
    const f = fixture({ row: { status: 'replaying', activeJobId: 'job-1' } });
    await f.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.calls).toEqual(['bind:p-1:cont-1']);
  });
});

describe('AgentFailoverTurns leftover settle (P5 B3b)', () => {
  const reason = '接續執行未完成，請確認後重新送出。';

  it('settleLeftover requires confirmation for a failed continuation, completes a completed one, and skips a row that a timer holds', async () => {
    const failedRow = fixture({ row: { status: 'replaying', activeJobId: 'job-1' }, enabled: false });
    await failedRow.turns.settleLeftover('job-1', 'failed');
    await failedRow.turns.settleLeftover('job-1', 'interrupted');
    expect(failedRow.calls).toEqual([`confirm:p-1:${reason}`, `confirm:p-1:${reason}`]);
    const done = fixture({ row: { status: 'replaying', activeJobId: 'job-1' } });
    await done.turns.settleLeftover('job-1', 'completed');
    expect(done.calls).toEqual(['completed:p-1']);
    const other = fixture({ row: { status: 'pending', activeJobId: 'job-1' } });
    await other.turns.settleLeftover('job-1', 'failed');
    expect(other.calls).toEqual([]);
    vi.useFakeTimers();
    const held = fixture({ row: { status: 'replaying', activeJobId: 'job-1' } });
    await held.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    await held.turns.settleLeftover('job-1', 'failed');
    expect(held.calls).toEqual([]);
    held.turns.dispose();
    await held.turns.settleLeftover('job-1', 'failed');
    expect(held.calls).toEqual([]);
  });

  it('a replaced timer releases its old held row', async () => {
    vi.useFakeTimers();
    // Two rows: the first timer holds p-1 (job-1); the second failure comes from job-2, which holds p-2.
    const calls: string[] = [];
    const rows: Record<string, PendingTurn> = {
      'job-1': { pendingId: 'p-1', activeJobId: 'job-1', status: 'replaying' } as PendingTurn,
      'job-2': { pendingId: 'p-2', activeJobId: 'job-2', status: 'replaying' } as PendingTurn,
    };
    const replaced = new AgentFailoverTurns({
      enabled: async () => true, routeFor: async () => ({ kind: 'all_sources_exhausted' }),
      store: { get: async () => null, findByJob: async (id: string) => rows[id] ?? null, recordFailure: async () => null, bindActiveJob: async () => true,
        claimSafe: async () => null, markCompleted: async () => true, markExhausted: async () => true,
        requireConfirmation: async (id: string, text: string) => { calls.push(`confirm:${id}:${text}`); return true; }, supersedeMatching: async () => true },
      enqueueContinuation: async () => null, notify: () => undefined, publish: () => undefined, kick: () => undefined, isShuttingDown: () => false,
      report: () => undefined,
    });
    await replaced.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    const second = context();
    second.job = { ...second.job, jobId: 'job-2' } as typeof second.job;
    await replaced.afterFailure(second, failed('PROVIDER_RATE_LIMITED'));
    expect(calls).toEqual([`confirm:p-1:${reason}`]);
    replaced.dispose();
  });
});

describe('AgentFailoverTurns gates (P5 B3b)', () => {
  it('a schedule job does nothing', async () => {
    vi.useFakeTimers();
    const f = fixture({ row: { status: 'replaying', activeJobId: 'job-1' } });
    const scheduled = context('schedule');
    await f.turns.afterFailure(scheduled, failed('PROVIDER_LIMIT'));
    await f.turns.afterFailure(scheduled, failed('PROVIDER_RATE_LIMITED'));
    await f.turns.afterCompleted(scheduled);
    await f.turns.supersede(scheduled);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.calls).toEqual([]);
    expect(f.recorded).toEqual([]);
    expect(f.enqueued).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it('the switch off does nothing', async () => {
    vi.useFakeTimers();
    const f = fixture({ enabled: false, row: { status: 'replaying', activeJobId: 'job-1' } });
    await f.turns.afterFailure(context(), failed('PROVIDER_LIMIT'));
    await f.turns.afterFailure(context(), failed('PROVIDER_RATE_LIMITED'));
    await f.turns.afterCompleted(context());
    await f.turns.supersede(context());
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.calls).toEqual([]);
    expect(f.recorded).toEqual([]);
    expect(f.enqueued).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it('supersede uses the lineage key and the effective text', async () => {
    const f = fixture();
    await f.turns.supersede(context());
    expect(f.calls).toEqual([`supersede:${lineage}:hello\nmore`]);
  });

  it('a thrown error is a diagnostic', async () => {
    const f = fixture();
    const broken = new AgentFailoverTurns({ enabled: async () => { throw new Error('boom'); }, report: (error: unknown) => { f.reported.push(error); } } as unknown as ConstructorParameters<typeof AgentFailoverTurns>[0]);
    await broken.afterFailure(context(), failed('PROVIDER_LIMIT'));
    expect(f.reported).toHaveLength(1);
  });
});
