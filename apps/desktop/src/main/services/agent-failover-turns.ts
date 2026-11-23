import type { AgentEvent } from '@line-agent/contracts';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { routeKeyFor, type AgentJob, type AgentJobStatusProjection, type AgentQueueKey, type ClaimedAgentJob, type PendingFailureInput, type PendingTurn, type RouteDecision, type SessionKey } from '@line-agent/database';

/** User texts of the automatic failover (plan T1 and T3 to T8, CliTalkAgent wording). */
export const ALL_SOURCES_EXHAUSTED_TEXT = 'CLAUDECODE / CODEX 的可用來源使用量已滿，請等額度恢復後再試。';
export const NO_AVAILABLE_SOURCE_TEXT = '目前沒有可用的 CLAUDECODE / CODEX CLI 來源，請檢查登入與設定。';
export const QUOTA_NOTICE_TEXT = '⏸️ 目前來源的使用量已滿；系統會在下一回合改用其他可用來源。';
export const UNSAFE_REPLAY_TEXT = '來源已切換，但上一回合可能已執行工具或產生內容，訊息已保留，請確認後重新送出。';
export const CLAIM_LOST_TEXT = '訊息已保留，請確認附件與執行狀態後重新送出。';
export const ATTEMPT_CAP_TEXT = '自動接續已達上限，訊息已保留，請確認後重新送出。';
export const RATE_LIMIT_RESUME_TEXT = '▶️ 額度恢復了，我接著剛剛中斷的地方繼續。';
export const RATE_LIMIT_PROMPT = '（系統）先前的限流/上限應已解除，請從剛剛中斷的地方繼續。';
export const PENDING_SAVE_FAILED_TEXT = '無法保存待接續訊息，請重新送出。';
/** CTA chat.rs 1075 reason texts. */
export const ATTEMPT_CAP_REASON = '自動接續已達重試上限';
export const CONTINUATION_UNFINISHED_REASON = '接續執行未完成，請確認後重新送出。';
/** CTA provider_guard.rs: a transient rate limit retries after about three minutes. */
export const RATE_LIMIT_RETRY_MS = 180_000;
/** CTA resume_recoverable_pending_turns limit (maintenance.rs 213). */
const RECOVERY_LIMIT = 8;
/** CTA hard attempt cap (chat.rs 1066). */
const ATTEMPT_CAP = 8;

type FailedEvent = Extract<AgentEvent, { type: 'failed' }>;

/** The pending-turn calls that this module uses (PendingTurnRepository satisfies it). */
export interface FailoverTurnStore {
  get(pendingId: string): Promise<PendingTurn | null>;
  findByJob(jobId: string): Promise<PendingTurn | null>;
  recordFailure(input: PendingFailureInput): Promise<PendingTurn | null>;
  bindActiveJob(pendingId: string, jobId: string): Promise<boolean>;
  claimSafe(pendingId: string, targetSourceId: string): Promise<PendingTurn | null>;
  markCompleted(pendingId: string): Promise<boolean>;
  markExhausted(pendingId: string): Promise<boolean>;
  requireConfirmation(pendingId: string, reason: string): Promise<boolean>;
  supersedeMatching(lineageKey: string, text: string): Promise<boolean>;
  /** The exhausted rows that a recovery may replay, oldest first (CTA resume_recoverable_pending_turns). Needed by recoverExhausted only. */
  recoverableSnapshot?(limit: number): Promise<PendingTurn[]>;
}

export interface AgentFailoverTurnDependencies {
  /** The failover switch. Every entry point does nothing while it is off. */
  enabled(): Promise<boolean>;
  routeFor(input: { job: AgentJob; sessionKey?: SessionKey; sessionGeneration: number; excluded: readonly string[] }): Promise<RouteDecision>;
  store: FailoverTurnStore;
  enqueueContinuation(input: { originJobId: string; prompt: string; workerInstanceId?: string; controlEpoch?: number }): Promise<AgentJobStatusProjection | null>;
  /** The current worker binding of a LINE job, when known. */
  currentBinding?: (job: AgentJob) => Promise<{ workerInstanceId: string; controlEpoch: number } | null>;
  /** Reads a job by id. Needed by recoverExhausted only. */
  getJob?: (jobId: string) => Promise<AgentJob | null>;
  /** Sends a text to the LINE chat of the job in the background (D24). A failure is a diagnostic. */
  notify(job: ClaimedAgentJob, text: string): void;
  publish(projection: AgentJobStatusProjection): void;
  kick(key: AgentQueueKey): void;
  isShuttingDown(): boolean;
  /** The number of committed LINE sends of a job (decision D1). */
  committedLineSends?: (jobId: string) => Promise<number>;
  report(error: unknown, jobId?: string): void;
  retryDelayMs?: number;
}

/** What the module needs to know about the turn that ended. The job already has the routed provider, session and generation. */
export interface FailoverTurnContext {
  job: ClaimedAgentJob;
  queueKey: AgentQueueKey;
  sessionKey: SessionKey | undefined;
  sessionGeneration: number;
  /** The account source that the run used. */
  sourceId: string | null;
  /** The lead prompt and the folded prompts, joined with a newline. */
  userText: string;
}

interface RateLimitTimer {
  handle: ReturnType<typeof setTimeout>;
  context: FailoverTurnContext;
  /** The replaying row whose continuation hit the limit; its next continuation takes over the row. */
  heldPendingId: string | null;
}

/**
 * What happens after a turn ends: quota or logout (CliTalkAgent chat.rs quota_failover_response and resume_pending_turn),
 * a transient rate limit (provider_guard.rs note_rate_limit_pause and run_quota_wake_check), the end of a continuation job,
 * the restart recovery and the supersede of a resent text. A thrown error is a diagnostic; it never changes the job.
 */
export class AgentFailoverTurns {
  private readonly timers = new Map<string, RateLimitTimer>();
  private disposed = false;
  private recovering = false;

  constructor(private readonly deps: AgentFailoverTurnDependencies) {}

  /** Clears every rate-limit timer. A timer is lost at a restart (CTA, same). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer.handle);
    this.timers.clear();
  }

  /** LINE and UI jobs with a session only. A scheduled run has none (plan D25). */
  private eligible(context: FailoverTurnContext): context is FailoverTurnContext & { sessionKey: SessionKey } {
    return context.job.sourceType !== 'schedule' && context.sessionKey !== undefined;
  }

  private async active(context: FailoverTurnContext): Promise<boolean> {
    if (!this.eligible(context) || this.disposed) return false;
    return this.deps.enabled();
  }

  /** The replaying row that has this job as its active job, or null. */
  private async replayingRow(jobId: string): Promise<PendingTurn | null> {
    const row = await this.deps.store.findByJob(jobId);
    return row && row.activeJobId === jobId && row.status === 'replaying' ? row : null;
  }

  private notifyLine(job: ClaimedAgentJob, text: string): void {
    if (job.sourceType === 'line') this.deps.notify(job, text);
  }

  /** CTA supersede_matching: a resent text replaces the open rows of the same lineage that hold the same text. */
  async supersede(context: FailoverTurnContext): Promise<void> {
    try {
      if (!await this.active(context)) return;
      await this.deps.store.supersedeMatching(routeKeyFor(context.sessionKey!), context.userText);
    } catch (error) { this.deps.report(error, context.job.jobId); }
  }

  /** The turn failed. Quota and logout re-route, a transient limit schedules a retry, and any other code ends a continuation. */
  async afterFailure(context: FailoverTurnContext, event: FailedEvent): Promise<void> {
    try {
      if (!await this.active(context)) return;
      if (event.code === 'PROVIDER_LIMIT' || event.code === 'AUTH_REQUIRED') await this.quotaOrLogout(context as FailoverTurnContext & { sessionKey: SessionKey }, event);
      else if (event.code === 'PROVIDER_RATE_LIMITED') await this.rateLimited(context as FailoverTurnContext & { sessionKey: SessionKey });
      else await this.continuationFailed(context.job.jobId, event.code);
    } catch (error) { this.deps.report(error, context.job.jobId); }
  }

  /** The turn completed. A continuation job completes its row. */
  async afterCompleted(context: FailoverTurnContext): Promise<void> {
    try {
      if (!await this.active(context)) return;
      const row = await this.replayingRow(context.job.jobId);
      if (row) await this.deps.store.markCompleted(row.pendingId);
    } catch (error) { this.deps.report(error, context.job.jobId); }
  }

  /** The turn was cancelled. A continuation job needs a confirmation. */
  async afterCancelled(context: FailoverTurnContext): Promise<void> {
    try {
      if (this.deps.isShuttingDown() || !await this.active(context)) return;
      const row = await this.replayingRow(context.job.jobId);
      if (row) await this.deps.store.requireConfirmation(row.pendingId, CONTINUATION_UNFINISHED_REASON);
    } catch (error) { this.deps.report(error, context.job.jobId); }
  }

  /**
   * The one settle step of a job that has ended on any path (called once from the finally block of the pump). The specific handlers run first
   * and rebind or change the row, so this finds nothing for them. It does not check the switch: a replaying row must not stay stuck when
   * the switch is turned off. At a shutdown the restart recovery handles the row. A row that a rate-limit timer holds is left to the timer.
   */
  async settleLeftover(jobId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void> {
    try {
      if (this.disposed || this.deps.isShuttingDown()) return;
      const row = await this.replayingRow(jobId);
      if (!row) return;
      for (const timer of this.timers.values()) if (timer.heldPendingId === row.pendingId) return;
      if (status === 'completed') await this.deps.store.markCompleted(row.pendingId);
      else await this.deps.store.requireConfirmation(row.pendingId, CONTINUATION_UNFINISHED_REASON);
    } catch (error) { this.deps.report(error, jobId); }
  }

  /**
   * A failure that Task 1 and Task 3 do not handle. A continuation that finds no route again is exhausted (CTA mark_exhausted on a route error);
   * any other code needs a confirmation. CTA sends no extra text: the job shows its own failure.
   */
  private async continuationFailed(jobId: string, code: string): Promise<void> {
    const row = await this.replayingRow(jobId);
    if (!row) return;
    if (code === 'ALL_SOURCES_EXHAUSTED' || code === 'NO_AVAILABLE_SOURCE') await this.deps.store.markExhausted(row.pendingId);
    else await this.deps.store.requireConfirmation(row.pendingId, CONTINUATION_UNFINISHED_REASON);
  }

  /** The D1 rule: effective output, or a committed LINE send, or an error in the check (safe side). */
  private async effectiveOutput(context: FailoverTurnContext, event: FailedEvent): Promise<boolean> {
    if (event.hadEffectiveOutput === true) return true;
    if (!this.deps.committedLineSends) return false;
    try { return (await this.deps.committedLineSends(context.job.jobId)) > 0; }
    catch (error) { this.deps.report(error, context.job.jobId); return true; }
  }

  private async enqueue(context: { job: AgentJob }, originJobId: string, prompt: string): Promise<AgentJobStatusProjection | null> {
    let binding: { workerInstanceId: string; controlEpoch: number } | null = null;
    if (context.job.sourceType === 'line' && this.deps.currentBinding) {
      try { binding = await this.deps.currentBinding(context.job); } catch (error) { this.deps.report(error, context.job.jobId); }
    }
    return this.deps.enqueueContinuation({ originJobId, prompt, ...(binding ? { workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch } : {}) });
  }

  /**
   * CTA resume_recoverable_pending_turns_with (chat.rs 1146-1240), limit 8: a source is usable again, so each exhausted row that has no
   * tool activity and no effective output starts a continuation job. CTA sends no chat text for the replay itself; the continuation
   * job sends the provider-switch text when it runs. Returns the number of continuations that started. A run guard stops overlap.
   */
  async recoverExhausted(limit = RECOVERY_LIMIT): Promise<number> {
    const { store, getJob } = this.deps;
    if (this.recovering || this.disposed || this.deps.isShuttingDown() || !store.recoverableSnapshot || !getJob) return 0;
    this.recovering = true;
    let started = 0;
    try {
      if (!await this.deps.enabled()) return 0;
      for (const row of await store.recoverableSnapshot(Math.min(limit, RECOVERY_LIMIT))) {
        if (this.disposed || this.deps.isShuttingDown()) break;
        try { if (await this.recoverRow(row, getJob)) started += 1; } catch (error) { this.deps.report(error, row.activeJobId ?? row.originJobId); }
      }
    } catch (error) { this.deps.report(error); }
    finally { this.recovering = false; }
    return started;
  }

  private async recoverRow(row: PendingTurn, getJob: (jobId: string) => Promise<AgentJob | null>): Promise<boolean> {
    const lastJobId = row.activeJobId ?? row.originJobId;
    const job = await getJob(lastJobId);
    if (!job || job.sourceType === 'schedule') return false;
    // The session key of the failed turn is its lineage key: the claim stored routeKeyFor(sessionKey) there. A room job that shares
    // the admin-direct session therefore routes on the chat key, like its first turn did.
    const sessionKey = sessionKeyOf(row.lineageKey, job);
    const decision = await this.deps.routeFor({ job, sessionKey, sessionGeneration: job.generation, excluded: row.attemptedSourceIds });
    if (decision.kind === 'all_sources_exhausted' || decision.kind === 'no_available_source') return false;
    const claimed = await this.deps.store.claimSafe(row.pendingId, decision.sourceId);
    if (!claimed) return false;
    const projection = await this.enqueue({ job }, lastJobId, claimed.userText);
    if (!projection) {
      // The claim won and the enqueue was refused (for example the LINE authority changed): the row is replaying and needs a confirmation.
      await this.deps.store.requireConfirmation(row.pendingId, CLAIM_LOST_TEXT);
      return false;
    }
    await this.deps.store.bindActiveJob(row.pendingId, projection.jobId);
    this.deps.publish(projection);
    this.deps.kick(job.sourceType === 'line' ? { accountId: job.accountId, chatType: job.chatType, chatId: job.chatId } : { ...AGENT_ROOM_KEY });
    return true;
  }

  /** CTA quota_failover_response (chat.rs 1001-1096). */
  private async quotaOrLogout(context: FailoverTurnContext & { sessionKey: SessionKey }, event: FailedEvent): Promise<void> {
    const { job, sessionKey } = context;
    const hadToolActivity = event.hadToolActivity === true;
    const hadEffectiveOutput = await this.effectiveOutput(context, event);
    const pending = await this.deps.store.recordFailure({ originJobId: job.jobId, lineageKey: routeKeyFor(sessionKey), userText: context.userText,
      provider: job.provider, sourceId: context.sourceId, hadToolActivity, hadEffectiveOutput, error: event.message });
    if (!pending) { this.notifyLine(job, PENDING_SAVE_FAILED_TEXT); return; }
    // CTA provider_guard.rs handle_source_failure: only the quota failure tells the chat. The block itself is recorded by the failed-event
    // handler, which the caller has awaited before this point, so the router below sees the blocked source.
    if (event.code === 'PROVIDER_LIMIT') this.notifyLine(job, QUOTA_NOTICE_TEXT);
    if (pending.attemptCount >= ATTEMPT_CAP) {
      await this.deps.store.requireConfirmation(pending.pendingId, ATTEMPT_CAP_REASON);
      this.notifyLine(job, ATTEMPT_CAP_TEXT);
      return;
    }
    const decision = await this.deps.routeFor({ job, sessionKey, sessionGeneration: context.sessionGeneration, excluded: pending.attemptedSourceIds });
    if (decision.kind === 'all_sources_exhausted' || decision.kind === 'no_available_source') {
      await this.deps.store.markExhausted(pending.pendingId);
      this.notifyLine(job, decision.kind === 'all_sources_exhausted' ? ALL_SOURCES_EXHAUSTED_TEXT : NO_AVAILABLE_SOURCE_TEXT);
      return;
    }
    if (pending.hadToolActivity || pending.hadEffectiveOutput) { this.notifyLine(job, UNSAFE_REPLAY_TEXT); return; }
    const claimed = await this.deps.store.claimSafe(pending.pendingId, decision.sourceId);
    if (claimed) {
      const projection = await this.enqueue(context, job.jobId, claimed.userText);
      if (projection) {
        await this.deps.store.bindActiveJob(pending.pendingId, projection.jobId);
        this.deps.publish(projection);
        this.deps.kick(context.queueKey);
        return;
      }
      // The claim won and the enqueue was refused (for example the LINE authority changed): the row is replaying and needs a confirmation.
      await this.deps.store.requireConfirmation(pending.pendingId, CLAIM_LOST_TEXT);
    }
    this.notifyLine(job, CLAIM_LOST_TEXT);
  }

  /** CTA note_rate_limit_pause (provider_guard.rs 289-312): no block and no new row; one timer per lineage that replaces the older one. */
  private async rateLimited(context: FailoverTurnContext & { sessionKey: SessionKey }): Promise<void> {
    const lineage = routeKeyFor(context.sessionKey);
    const held = await this.replayingRow(context.job.jobId);
    if (this.disposed) return;
    const old = this.timers.get(lineage);
    if (old) {
      clearTimeout(old.handle);
      // The old timer can hold another replaying row; with no timer it needs a confirmation.
      if (old.heldPendingId && old.heldPendingId !== held?.pendingId) await this.deps.store.requireConfirmation(old.heldPendingId, CONTINUATION_UNFINISHED_REASON);
    }
    const timer: RateLimitTimer = { context, heldPendingId: held?.pendingId ?? null,
      handle: setTimeout(() => { void this.due(lineage, timer); }, this.deps.retryDelayMs ?? RATE_LIMIT_RETRY_MS) };
    timer.handle.unref?.();
    this.timers.set(lineage, timer);
  }

  /** CTA run_quota_wake_check (provider_guard.rs 296-335): tell the chat, then continue with the system prompt. */
  private async due(lineage: string, timer: RateLimitTimer): Promise<void> {
    if (this.timers.get(lineage) === timer) this.timers.delete(lineage);
    const { context } = timer;
    try {
      if (this.disposed || this.deps.isShuttingDown() || !await this.deps.enabled()) return;
      this.notifyLine(context.job, RATE_LIMIT_RESUME_TEXT);
      const projection = await this.enqueue(context, context.job.jobId, RATE_LIMIT_PROMPT);
      if (!projection) {
        if (timer.heldPendingId) await this.deps.store.requireConfirmation(timer.heldPendingId, CONTINUATION_UNFINISHED_REASON);
        return;
      }
      if (timer.heldPendingId) {
        // The continuation that hit the limit holds a replaying row; the new continuation takes the row over.
        const row = await this.deps.store.get(timer.heldPendingId);
        if (row && row.status === 'replaying' && row.activeJobId === context.job.jobId) await this.deps.store.bindActiveJob(row.pendingId, projection.jobId);
      }
      this.deps.publish(projection);
      this.deps.kick(context.queueKey);
    } catch (error) { this.deps.report(error, context.job.jobId); }
  }
}

/** The session key of a pending row: its lineage key text (see routeKeyFor), else the key of the job. */
function sessionKeyOf(lineageKey: string, job: AgentJob): SessionKey {
  try {
    const parsed: unknown = JSON.parse(lineageKey);
    if (Array.isArray(parsed) && parsed[0] === 'ui') return { ...AGENT_ROOM_KEY, provider: job.provider, sourceType: 'ui' };
    if (Array.isArray(parsed) && parsed[0] === 'line' && typeof parsed[1] === 'string' && typeof parsed[2] === 'string' && typeof parsed[3] === 'string') {
      return { accountId: parsed[1], chatType: parsed[2] as 'direct' | 'group' | 'room', chatId: parsed[3], provider: job.provider, sourceType: 'line' };
    }
  } catch { /* Fall back to the key of the job. */ }
  return job.sourceType === 'line'
    ? { accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, provider: job.provider, sourceType: 'line' }
    : { ...AGENT_ROOM_KEY, provider: job.provider, sourceType: 'ui' };
}
