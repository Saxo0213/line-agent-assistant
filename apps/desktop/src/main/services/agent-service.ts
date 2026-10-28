import { randomUUID } from 'node:crypto';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, isAgentScheduleQueueKey, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN, AgentProviderSchema, type AgentAttachmentUpload, type AgentEvent, type AgentProvider, type AgentRunRequest, type WritableConversationKey } from '@line-agent/contracts';
import { AgentAttachmentError, DEFAULT_ATTACHMENT_PROMPT, attachmentPromptSection, removeJobAttachments, resolveStoredAttachments, storeAttachments, validateUploads, type ResolvedAttachment } from './agent-attachments.js';
import { projectFolderPromptSection } from './project-folder-prompt.js';
import type { AgentRepository, AgentJobStatusProjection, AgentQueueKey, SessionKey } from '@line-agent/database';
import type { WorkspaceAuthority } from './workspace-authority.js';
import { splitDeliveryText } from './delivery-service.js';
import { personaPromptSection } from './agent-persona.js';
import { formatIdentityBlock, withAgentRoomHistoryHint, withIdentityBlock, withMcpSkill, withOutputChannel } from './mcp-skill.js';
import { isScheduledRunRequestId } from './agent-schedule-service.js';
import type { AgentJobEnvironment, AgentJobPlan } from './agent-job-environment.js';
const SCHEDULE_CONTEXT_UNAVAILABLE = '（排程資料讀取失敗：請依上列卡片盡力完成，並在回覆說明缺少什麼。）';

/** Main-owned source of per-job LINEJS MCP capabilities for built-in Agents. */
export interface InternalMcpLauncher {
  /** Mints a per-job capability bound to the live listener, or null when the listener is unavailable. */
  mint(job: {
    jobId: string; accountId: string | null; generation: number;
    /** Set only for interactive-approval (operator) jobs; enables the internal permission prompt tool. */
    approval: { sessionKey: string; workspaceRoot: string } | null;
  }): { endpoint: string; token: string } | null;
  /** Synchronously closes admission and aborts in-flight requests for the job. */
  release(jobId: string): void;
  /** App-owned Skill guidance text, or null when unavailable. */
  skill(): Promise<string | null>;
  /** Hidden run-time instructions of a schedule-sourced job (request id `schedule:...`), or null when unavailable. */
  scheduleContext?(sourceRequestId: string): Promise<string | null>;
}

/** Stable identity of a provider session generation (key order independent). */
export function approvalSessionKey(sessionKey: object, sessionGeneration: number): string {
  const sorted = Object.fromEntries(Object.entries(sessionKey).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ sessionKey: sorted, sessionGeneration });
}

export const MCP_STATUS_MESSAGES = {
  configured: '已設定，等待工具載入',
  available: 'MCP 可用',
  not_loaded: 'MCP 未載入',
} as const;
export const MCP_OBSERVATION_TIMEOUT_MS = 10_000;

export interface AgentRunner {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  /** Resolves only after the owned process tree has exited. */
  cancel(jobId: string): Promise<void>;
}

/** A prompt from the shared Agent room; it has no LINE account or chat. */
export interface UiSubmission {
  provider: AgentProvider;
  requestId: string;
  prompt: string;
  workspacePath?: string;
  /** Files chosen in the composer: bytes only, never paths. Written by Main before the job row exists. */
  attachments?: readonly AgentAttachmentUpload[];
}

/** A scheduled Agent run; it has no LINE account or chat and runs in a brand-new provider session. */
export interface ScheduleSubmission {
  provider: AgentProvider;
  requestId: string;
  prompt: string;
}

export type AgentReaction = 'NICE' | 'AMAZING' | 'FUN' | 'LOVE' | 'SAD' | 'OMG' | 'UNDO';
/** Display phase a reaction reports; provider-neutral. `queued` and a queued job's `cancelled` have no active execution. */
export type AgentReactionPhase = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentReactionSink = (jobId: string, key: WritableConversationKey, messageId: string,
  reaction: AgentReaction, phase: AgentReactionPhase) => Promise<void>;

interface ActiveExecution {
  jobId: string;
  key: AgentQueueKey;
  messageId: string | null;
  deadlineAt: number;
  nextHeartbeatAt: number;
  deadlineExceeded: boolean;
  deadlineCancellation?: Promise<void>;
  heartbeatPhase: number;
  reactionInFlight: boolean;
  pendingReaction?: { reaction: AgentReaction; phase: Exclude<AgentReactionPhase, 'queued' | 'running'> };
  terminalPending: boolean;
  terminal: boolean;
  mcpPhase?: 'configured' | 'available' | 'not_loaded';
  mcpObserveAt?: number;
}

/** Interval between running-reaction rotations. The single scheduler timer also serves deadlines and MCP observation. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Pending reactions kept per account for jobs without an execution (queued / queued-cancel); oldest is dropped. */
const DETACHED_REACTION_LIMIT = 16;
const LINE_MESSAGE_ID = /^(?:0|[1-9][0-9]*)$/;
const HEARTBEAT_REACTIONS: readonly AgentReaction[] = ['NICE', 'AMAZING', 'FUN'];

const identity = (key: AgentQueueKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);
/** Concurrent scheduled runs. Raising it also needs the one-running index of migration 072 and the claim query changed. */
export const SCHEDULE_MAX_CONCURRENT_RUNS = 1;
/** Concurrency slot: a LINE account's, the shared Agent room's own, or the scheduled runs' own (neither belongs to an account). */
const slotOf = (key: AgentQueueKey): string => key.accountId ?? (isAgentScheduleQueueKey(key) ? 'agent-schedule\u0000' : 'agent-room\u0000');
const SCHEDULE_IDENTITY = identity(AGENT_SCHEDULE_QUEUE_KEY);
const jobFence = (key: AgentQueueKey, jobId: string) => JSON.stringify([identity(key), jobId]);

export class AgentService {
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly activeJobs = new Map<string, string>();
  private readonly executions = new Map<string, ActiveExecution>();
  private schedulerTimer: ReturnType<typeof setTimeout> | undefined;
  private statusRotationIntervalMs = HEARTBEAT_INTERVAL_MS;
  private readonly activeAccountSlots = new Map<string, number>();
  private readonly reservedAccountSlots = new Map<string, number>();
  private reservedProviderSlots = 0;
  private refillPromise: Promise<void> | undefined;
  private refillPending = false;
  private readonly stopping = new Map<string, number>();
  private readonly stoppingJobs = new Map<string, number>();
  private readonly shutdownAbortController = new AbortController();
  private shuttingDown = false;
  private readonly retrying = new Set<string>();
  /** Per-account lane for reactions of jobs that have no active execution; entries exist only while non-empty. */
  private readonly detachedReactions = new Map<string, { active: boolean;
    queue: Array<{ jobId: string; key: WritableConversationKey; messageId: string; reaction: AgentReaction; phase: AgentReactionPhase }> }>();
  constructor(
    private readonly agents: AgentRepository,
    private readonly workspace: Pick<WorkspaceAuthority, 'current'>,
    private readonly bridge: AgentRunner,
    private readonly onEvent: ((jobId: string, event: AgentEvent) => void | Promise<void>) | undefined,
    private readonly onCompleted: ((jobId: string) => Promise<void>) | undefined,
    private readonly maxConcurrentExecutions = 2,
    private readonly maxExecutionMs = 30 * 60 * 1000,
    private readonly maxShutdownWaitMs = 5000,
    private readonly maxConcurrentPerAccount = 1,
    private readonly onReaction: AgentReactionSink | undefined,
    private readonly resolvePromptContext: ((job: {
      jobId: string;
      sourceType: 'line' | 'ui';
      prompt: string;
    }) => Promise<{ enrichedPrompt: string } | null>) | undefined,
    private readonly onLifecycle: ((projection: AgentJobStatusProjection) => void | Promise<void>) | undefined,
    private readonly mcpLauncher: InternalMcpLauncher | undefined,
    /** Required: where a job runs and which provider tools it gets. There is no default, so nothing fails open. */
    private readonly environment: AgentJobEnvironment,
    private readonly onDiagnostic?: (diagnostic: SafeDiagnostic, jobId?: string) => void,
    /** The persona description in force for a LINE chat (docs/architecture/agent-persona.md); blank adds nothing to the prompt. */
    private readonly resolvePersonaDescription?: (chat: { accountId: string; chatType: string; chatId: string }) => Promise<string>,
  ) {}

  private reportFailure(stage: SafeDiagnostic['stage'], error?: unknown, jobId?: string): void {
    try { this.onDiagnostic?.(diagnosticFailure('agent', stage, error), jobId); } catch { /* Observation cannot change durable job state. */ }
  }

  private releaseMcp(jobId: string): void {
    try { this.mcpLauncher?.release(jobId); } catch { /* Release is best effort; durable job state still fences requests. */ }
  }

  private emitMcpStatus(execution: ActiveExecution, status: keyof typeof MCP_STATUS_MESSAGES): void {
    execution.mcpPhase = status;
    const event: AgentEvent = { type: 'mcp_status', status, message: MCP_STATUS_MESSAGES[status] };
    void this.agents.appendEvent(execution.jobId, event)
      .then(() => this.onEvent?.(execution.jobId, event))
      .catch(() => undefined);
  }

  /** Called by Main when an authenticated initialize + tools/list was observed on the job capability. */
  noteMcpObservation(jobId: string, observation: 'initialized' | 'tools_listed' | 'available'): void {
    const execution = this.executions.get(jobId);
    if (observation !== 'available' || !execution || execution.terminal || execution.terminalPending) return;
    if (execution.mcpPhase === 'configured' || execution.mcpPhase === 'not_loaded') this.emitMcpStatus(execution, 'available');
  }

  private publishLifecycle(projection: AgentJobStatusProjection): void {
    try { const published = this.onLifecycle?.(projection); if (published) void Promise.resolve(published).catch(() => undefined); }
    catch { /* Projection failures must not block durable Agent work. */ }
  }

  publishCommittedStatus(projection: AgentJobStatusProjection): void { this.publishLifecycle(projection); }

  /** Retimes the existing scheduler's running-reaction deadline after settings are saved. */
  setStatusRotationIntervalSeconds(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN
      || seconds > AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX) {
      throw new Error('Status icon rotation interval must be an integer from 5 to 86400 seconds');
    }
    this.statusRotationIntervalMs = seconds * 1000;
    const nextAt = Date.now() + this.statusRotationIntervalMs;
    for (const execution of this.executions.values()) {
      if (!execution.terminal && !execution.terminalPending && !execution.deadlineExceeded && execution.messageId && this.onReaction) {
        execution.nextHeartbeatAt = nextAt;
      }
    }
    this.scheduleScheduler();
  }

  /**
   * Called after LINE ingest durably committed new jobs. A freshly queued LINE job gets one AMAZING reaction.
   * Duplicates never reach here (no new row), UI jobs have no LINE message, and a failure never affects the enqueue.
   */
  noteQueued(projection: { jobId: string; accountId: string; chatType: WritableConversationKey['chatType']; chatId: string;
    sourceMessageId: string | null; status: AgentJobStatusProjection['status'] }): void {
    if (projection.status !== 'queued' || !projection.sourceMessageId || !LINE_MESSAGE_ID.test(projection.sourceMessageId)) return;
    this.enqueueDetachedReaction(projection.jobId,
      { accountId: projection.accountId, chatType: projection.chatType, chatId: projection.chatId },
      projection.sourceMessageId, 'AMAZING', 'queued');
  }

  /** A cancelled job that never reached an execution (it was still queued) already showed AMAZING: show FUN. */
  private reactCancelledQueued(projection: AgentJobStatusProjection): void {
    if (projection.sourceType !== 'line' || projection.status !== 'cancelled'
      || !projection.sourceMessageId || !LINE_MESSAGE_ID.test(projection.sourceMessageId)) return;
    // A claimed job is finished by its pump, whose finally block sends the cancelled reaction.
    for (const jobId of this.activeJobs.values()) if (jobId === projection.jobId) return;
    this.enqueueDetachedReaction(projection.jobId,
      { accountId: projection.accountId, chatType: projection.chatType, chatId: projection.chatId },
      projection.sourceMessageId, 'FUN', 'cancelled');
  }

  private enqueueDetachedReaction(jobId: string, key: WritableConversationKey, messageId: string,
    reaction: AgentReaction, phase: AgentReactionPhase): void {
    if (this.shuttingDown || !this.onReaction) return;
    const slot = key.accountId;
    let lane = this.detachedReactions.get(slot);
    if (!lane) { lane = { active: false, queue: [] }; this.detachedReactions.set(slot, lane); }
    if (lane.queue.length >= DETACHED_REACTION_LIMIT) lane.queue.shift();
    lane.queue.push({ jobId, key, messageId, reaction, phase });
    if (lane.active) return;
    lane.active = true;
    const current = lane;
    void (async () => {
      while (!this.shuttingDown) {
        const next = current.queue.shift();
        if (!next) break;
        try { await this.onReaction!(next.jobId, next.key, next.messageId, next.reaction, next.phase); }
        catch { /* Display only: a failed reaction never changes the job. */ }
      }
    })().finally(() => {
      current.active = false;
      if (current.queue.length === 0 || this.shuttingDown) this.detachedReactions.delete(slot);
    });
  }

  kick(key: AgentQueueKey): void {
    if (this.shuttingDown) return;
    const id = identity(key);
    if (this.pumps.has(id)) return;
    let madeProgress = false;
    const pump = Promise.resolve().then(async () => { madeProgress = await this.pump(key); }).finally(() => {
      this.pumps.delete(id);
      if (madeProgress) this.refillQueued();
    });
    this.pumps.set(id, pump);
  }

  /** Running Agent room / LINE jobs. Scheduled runs have their own slot and never count against the global provider limit. */
  private providerSlotsInUse(): number {
    return this.activeJobs.size - (this.activeJobs.has(SCHEDULE_IDENTITY) ? 1 : 0);
  }

  /** Reclaims bounded batches from the durable queue after startup/recovery. */
  recoverQueued(): Promise<void> {
    if (this.shuttingDown || !this.agents.listQueuedConversations) return Promise.resolve();
    return this.agents.listQueuedConversations(256).then((keys) => {
      let available = this.maxConcurrentExecutions - this.providerSlotsInUse() - this.reservedProviderSlots;
      const selectedByAccount = new Map<string, number>();
      for (const key of keys) {
        const scheduled = isAgentScheduleQueueKey(key);
        if (available <= 0 && !scheduled) continue;
        const id = identity(key);
        if (this.stopping.has(id) || this.pumps.has(id)) continue;
        const accountSlots = (this.activeAccountSlots.get(slotOf(key)) ?? 0)
          + (this.reservedAccountSlots.get(slotOf(key)) ?? 0)
          + (selectedByAccount.get(slotOf(key)) ?? 0);
        if (accountSlots >= (scheduled ? SCHEDULE_MAX_CONCURRENT_RUNS : this.maxConcurrentPerAccount)) continue;
        this.kick(key);
        selectedByAccount.set(slotOf(key), (selectedByAccount.get(slotOf(key)) ?? 0) + 1);
        if (!scheduled) available -= 1;
      }
    });
  }

  async idle(): Promise<void> {
    while (this.pumps.size) await Promise.all([...this.pumps.values()]);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopScheduler();
    this.shutdownAbortController.abort();
    const active = [...this.activeJobs.values()];
    const errors: unknown[] = [];
    const collect = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    };
    const cleanup = (async () => {
      // Physical process ownership is independent of persistence. Always tear
      // down the process tree even when recording cancellation failed.
      for (const jobId of active) this.releaseMcp(jobId);
      collect(await Promise.allSettled(active.map((jobId) => this.bridge.cancel(jobId))));
      collect(await Promise.allSettled(active.map(async (jobId) => {
        const projection = await this.agents.cancelJob(jobId); if (projection) this.publishLifecycle(projection);
      })));
      try { await this.idle(); } catch (error) { errors.push(error); }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      cleanup.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), this.maxShutdownWaitMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (expired) errors.push(new Error('Agent shutdown timed out while provider ownership remains quarantined'));
    if (errors.length) throw new AggregateError(errors, 'Agent shutdown encountered cleanup errors');
  }

  async submitFromUi(input: UiSubmission): Promise<{ disposition: 'inserted' | 'duplicate'; jobId: string }> {
    const workspacePath = await this.workspace.current();
    const uploads = input.attachments ?? [];
    if (uploads.length === 0) {
      const result = await this.agents.enqueueUiJob({ provider: input.provider, requestId: input.requestId,
        prompt: input.prompt, workspacePath });
      this.kick(AGENT_ROOM_KEY);
      return result;
    }
    // Attachment submit is atomic: write the files, then insert the row. Either failure removes the job directory.
    validateUploads(uploads);
    const jobId = randomUUID();
    const attachments = await storeAttachments({ workspace: workspacePath, jobId, uploads });
    let result: { disposition: 'inserted' | 'duplicate'; jobId: string };
    try {
      result = await this.agents.enqueueUiJob({ provider: input.provider, requestId: input.requestId, jobId, attachments,
        prompt: input.prompt.trim().length === 0 ? DEFAULT_ATTACHMENT_PROMPT : input.prompt, workspacePath });
    } catch (error) {
      await removeJobAttachments(workspacePath, jobId);
      throw error;
    }
    // A repeated request id resolves to the earlier job, which owns its own files.
    if (result.jobId !== jobId) await removeJobAttachments(workspacePath, jobId);
    this.kick(AGENT_ROOM_KEY);
    return result;
  }

  /**
   * Queues one scheduled run on its own queue (idempotent on the request id). The job is not an Agent room job and never uses a
   * session: the run starts a brand-new provider session.
   */
  async submitScheduled(input: ScheduleSubmission): Promise<{ disposition: 'inserted' | 'duplicate'; jobId: string }> {
    const workspacePath = await this.workspace.current();
    const result = await this.agents.enqueueScheduleJob({ provider: input.provider, requestId: input.requestId, prompt: input.prompt, workspacePath });
    this.kick(AGENT_SCHEDULE_QUEUE_KEY);
    return result;
  }

  /** Resolves true when a queued or running job was cancelled. */
  async stopChat(key: AgentQueueKey): Promise<boolean> {
    const id = identity(key);
    this.holdStarts(id);
    try {
      const cancelled = await this.agents.cancelConversationJobs(key) ?? [];
      const active = this.activeJobs.get(id);
      if (active) this.releaseMcp(active);
      const physicalCancellation = active ? this.bridge.cancel(active) : undefined;
      for (const projection of cancelled) { this.publishLifecycle(projection); this.reactCancelledQueued(projection); }
      if (physicalCancellation) await physicalCancellation;
      await this.pumps.get(id);
      return cancelled.length > 0 || active !== undefined;
    } finally { this.releaseStarts(id, key); }
  }

  async stopJob(key: AgentQueueKey, jobId: string): Promise<boolean> {
    const fence = jobFence(key, jobId);
    this.holdJobStart(fence);
    let cancelled: AgentJobStatusProjection | null;
    try { cancelled = await this.agents.cancelJobForKey(key, jobId); }
    catch (error) { this.releaseJobStart(fence); throw error; }
    if (!cancelled) {
      this.releaseJobStart(fence);
      return false;
    }
    const id = identity(key);
    const pump = this.pumps.get(id);
    if (pump) void pump.then(() => this.releaseJobStart(fence), () => this.releaseJobStart(fence));
    else this.releaseJobStart(fence);
    if (this.activeJobs.get(id) === jobId) {
      this.releaseMcp(jobId);
      const physicalCancellation = this.bridge.cancel(jobId);
      this.publishLifecycle(cancelled);
      await physicalCancellation;
      await pump;
    } else { this.publishLifecycle(cancelled); this.reactCancelledQueued(cancelled); }
    return true;
  }

  async retryJob(key: AgentQueueKey, jobId: string): Promise<boolean> {
    const fence = jobFence(key, jobId);
    if (this.retrying.has(fence) || this.shuttingDown) return false;
    this.retrying.add(fence);
    try {
      const workspacePath = await this.workspace.current();
      const projection = await this.agents.retryJobForKey(key, jobId, workspacePath);
      if (!projection) return false;
      this.publishLifecycle(projection);
      if (!this.shuttingDown) this.kick(key);
      return true;
    } finally { this.retrying.delete(fence); }
  }

  getJobEvents(key: AgentQueueKey, jobId: string): Promise<AgentEvent[]> {
    return this.agents.listJobEvents(key, jobId);
  }

  /** Events of a scheduled run (never room events: the room's own lookup excludes schedule jobs). */
  getScheduleJobEvents(jobId: string): Promise<AgentEvent[]> {
    return this.agents.listJobEvents(AGENT_SCHEDULE_QUEUE_KEY, jobId);
  }

  /** Agent room events: a room job, or an admin-direct LINE job while that chat is shared; anything else is empty. */
  getRoomJobEvents(jobId: string): Promise<AgentEvent[]> {
    return this.agents.listRoomJobEvents(jobId);
  }

  async resetChat(key: AgentQueueKey, commandMessageId?: string): Promise<void> {
    // Scheduled runs have no session to reset; resetting their queue only stops what is queued or running.
    if (isAgentScheduleQueueKey(key)) { await this.stopChat(key); return; }
    const id = identity(key);
    this.holdStarts(id);
    try {
      const committed: AgentJobStatusProjection[] = [];
      if (commandMessageId && key.accountId !== null) {
        const reset = await this.agents.resetConversationForMessage(key, commandMessageId);
        if (reset.result === 'stale') return;
        committed.push(...reset.cancelledJobs);
      }
      else {
        const resets = await Promise.all(AgentProviderSchema.options.flatMap((provider) =>
          // A LINE chat owns LINE sessions; the shared Agent room owns the account-less UI sessions.
          [this.agents.resetGeneration({ ...key, provider, sourceType: key.accountId === null ? 'ui' : 'line' })]));
        for (const reset of resets) committed.push(...reset.cancelledJobs);
      }
      const active = this.activeJobs.get(id);
      if (active) this.releaseMcp(active);
      const physicalCancellation = active ? this.bridge.cancel(active) : undefined;
      // The room and the admin's direct chat share one conversation: a reset on either side also cancels the other
      // side's jobs, and a running one is a live provider process that must be stopped here too.
      const otherIds = new Set<string>();
      const otherCancellations: Promise<void>[] = [];
      for (const projection of committed) {
        const ownerId = identity(projection.sourceType === 'ui' ? AGENT_ROOM_KEY : projection.sourceType === 'schedule' ? AGENT_SCHEDULE_QUEUE_KEY
          : { accountId: projection.accountId, chatType: projection.chatType, chatId: projection.chatId });
        const otherActive = ownerId === id ? undefined : this.activeJobs.get(ownerId);
        if (otherActive === projection.jobId) {
          otherIds.add(ownerId);
          this.releaseMcp(otherActive);
          otherCancellations.push(this.bridge.cancel(otherActive));
        }
      }
      for (const projection of committed) { this.publishLifecycle(projection); this.reactCancelledQueued(projection); }
      if (physicalCancellation) await physicalCancellation;
      await Promise.all(otherCancellations);
      await this.pumps.get(id);
      for (const ownerId of otherIds) await this.pumps.get(ownerId);
    } finally { this.releaseStarts(id, key); }
  }

  private holdStarts(id: string): void { this.stopping.set(id, (this.stopping.get(id) ?? 0) + 1); }

  private holdJobStart(fence: string): void {
    this.stoppingJobs.set(fence, (this.stoppingJobs.get(fence) ?? 0) + 1);
  }

  private releaseJobStart(fence: string): void {
    const count = this.stoppingJobs.get(fence);
    if (count === 1) this.stoppingJobs.delete(fence);
    else if (count !== undefined) this.stoppingJobs.set(fence, count - 1);
  }

  private releaseStarts(id: string, key: AgentQueueKey): void {
    const count = this.stopping.get(id);
    if (count === 1) {
      this.stopping.delete(id);
      this.kick(key);
      const releasedPump = this.pumps.get(id);
      if (releasedPump) void releasedPump.then(() => this.refillQueued(), () => this.refillQueued());
      else this.refillQueued();
    }
    else if (count !== undefined) this.stopping.set(id, count - 1);
  }

  async getChatStatus(key: AgentQueueKey): Promise<{ runningJobId: string | null }> {
    return { runningJobId: this.activeJobs.get(identity(key)) ?? null };
  }

  private async pump(key: AgentQueueKey): Promise<boolean> {
    const id = identity(key);
    const scheduledQueue = isAgentScheduleQueueKey(key);
    let madeProgress = false;
    while (true) {
      if (this.shuttingDown || this.stopping.has(id)) return madeProgress;
      const accountSlots = (this.activeAccountSlots.get(slotOf(key)) ?? 0)
        + (this.reservedAccountSlots.get(slotOf(key)) ?? 0);
      if (accountSlots >= (scheduledQueue ? SCHEDULE_MAX_CONCURRENT_RUNS : this.maxConcurrentPerAccount)) return madeProgress;
      // Scheduled runs use only their own slot: they neither wait for nor take a provider slot of the room or a LINE chat.
      if (!scheduledQueue && this.providerSlotsInUse() + this.reservedProviderSlots >= this.maxConcurrentExecutions) {
        return madeProgress;
      }
      const releaseProviderReservation = () => { if (!scheduledQueue) this.reservedProviderSlots -= 1; };
      if (!scheduledQueue) this.reservedProviderSlots += 1;
      this.reservedAccountSlots.set(slotOf(key), (this.reservedAccountSlots.get(slotOf(key)) ?? 0) + 1);
      let job;
      try { job = await this.agents.claimNext(key); }
      catch (error) {
        releaseProviderReservation();
        this.releaseAccountReservation(slotOf(key));
        throw error;
      }
      if (!job) {
        releaseProviderReservation();
        this.releaseAccountReservation(slotOf(key));
        return madeProgress;
      }
      madeProgress = true;
      this.activeJobs.set(id, job.jobId);
      this.activeAccountSlots.set(slotOf(key), (this.activeAccountSlots.get(slotOf(key)) ?? 0) + 1);
      releaseProviderReservation();
      this.releaseAccountReservation(slotOf(key));
      if (this.shuttingDown) {
        try {
          this.releaseMcp(job.jobId);
          const [physical, projection] = await Promise.allSettled([this.bridge.cancel(job.jobId), this.agents.cancelJob(job.jobId)]);
          if (projection.status === 'fulfilled' && projection.value) this.publishLifecycle(projection.value);
          void physical;
        } finally {
          this.activeJobs.delete(id);
          const accountCount = (this.activeAccountSlots.get(slotOf(key)) ?? 1) - 1;
          if (accountCount > 0) this.activeAccountSlots.set(slotOf(key), accountCount);
          else this.activeAccountSlots.delete(slotOf(key));
        }
        return madeProgress;
      }
      this.publishLifecycle(job);
      const execution: ActiveExecution = { jobId: job.jobId, key: { ...key },
        messageId: job.sourceType === 'line' ? job.sourceMessageId : null,
        deadlineAt: 0, nextHeartbeatAt: 0, deadlineExceeded: false,
        heartbeatPhase: 0, reactionInFlight: false, terminalPending: false, terminal: false };
      let timeoutPersisted = false;
      const source: AgentRunRequest['source'] = job.sourceType === 'line'
        ? { type: 'line', accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, messageId: job.sourceMessageId! }
        : { type: job.sourceType, requestId: job.sourceRequestId! };
      try {
        let effectivePrompt = job.prompt;
        if (this.resolvePromptContext) {
          try {
            const enriched = await this.resolvePromptContext({
              jobId: job.jobId,
              sourceType: job.sourceType === 'line' ? 'line' : 'ui',
              prompt: job.prompt,
            });
            if (enriched) effectivePrompt = enriched.enrichedPrompt;
          } catch (contextError) {
            this.reportFailure('prepare', contextError, job.jobId);
            const failEvent: AgentEvent = {
              type: 'failed',
              code: 'MCP_ACCESS_DENIED',
              message: 'MCP internal query failed.',
              retryable: false,
            };
            await this.agents.appendEvent(job.jobId, failEvent).catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
            const projection = await this.agents.failJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, failEvent);
            }
            continue;
          }
        }
        // Workspace and provider tools are decided here from the job row and handed to the runner as data.
        let prepared: AgentJobPlan;
        try { prepared = await this.environment.prepare(job.jobId, job.workspacePath); }
        catch (error) { this.reportFailure('prepare', error, job.jobId); prepared = { ok: false, code: 'WORKSPACE_UNAVAILABLE', message: 'The Agent workspace is unavailable.' }; }
        if (!prepared.ok) {
          const failEvent: AgentEvent = { type: 'failed', code: prepared.code, message: prepared.message, retryable: false };
          await this.agents.appendEvent(job.jobId, failEvent).catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
          const projection = await this.agents.failJob(job.jobId);
          if (projection) {
            execution.terminal = true;
            this.publishLifecycle(projection);
            this.sendReaction(execution, 'SAD', 'failed');
            await this.onEvent?.(job.jobId, failEvent);
          }
          continue;
        }
        const plan = prepared;
        // Attachments must still exist on every run, including a retry; a missing file fails the job instead of being dropped.
        let attachmentFiles: ResolvedAttachment[] = [];
        if (job.sourceType === 'ui' && job.attachments?.length) {
          try { attachmentFiles = await resolveStoredAttachments(plan.workspacePath, job.jobId, job.attachments); }
          catch (attachmentError) {
            this.reportFailure('prepare', attachmentError, job.jobId);
            const failEvent: AgentEvent = { type: 'failed', code: 'ATTACHMENT_MISSING',
              message: attachmentError instanceof AgentAttachmentError ? attachmentError.message : '附件檔案已遺失，無法執行這項工作。', retryable: false };
            await this.agents.appendEvent(job.jobId, failEvent).catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
            const projection = await this.agents.failJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, failEvent);
            }
            continue;
          }
        }
        // A room job reads and writes the session the claim fixed for it (the admin-direct session while shared, else its
        // own); every other job uses its chat's session. A room job stamped for another target (the binding changed since
        // it was queued) starts fresh and binds to the target's current generation.
        // A scheduled run has NO session: no lookup, no resume, no bind. Every run starts a brand-new provider session, and the
        // approval key below is unique to the job so nothing carries over to or from the room or another run.
        const scheduledRun = job.sourceType === 'schedule';
        const sessionKey = scheduledRun ? undefined : job.sessionKey ?? { ...key, provider: job.provider, sourceType: job.sourceType } as SessionKey;
        const sessionGeneration = job.sessionGeneration ?? job.generation;
        const resume = sessionKey ? await this.agents.lookupSession({ ...sessionKey, workspacePath: plan.workspacePath }) : null;
        const request: AgentRunRequest = { jobId: job.jobId, provider: job.provider, source, prompt: effectivePrompt,
          workspacePath: plan.workspacePath, tools: plan.tools, ...(plan.extensions ? { extensions: plan.extensions } : {}),
          ...(sessionGeneration === job.generation && resume?.generation === job.generation ? { resumeSessionId: resume.externalSessionId } : {}) };

        const current = await this.agents.getJob(job.jobId);
        if (this.stopping.has(id) || this.stoppingJobs.has(jobFence(key, job.jobId)) || current?.status !== 'running') {
          if (current?.status === 'running') { const projection = await this.agents.cancelJobForKey(key, job.jobId); if (projection) this.publishLifecycle(projection); }
          continue;
        }
        let runRequest = request;
        if (this.mcpLauncher) {
          let launch: { endpoint: string; token: string } | null = null;
          try {
            const skill = await this.mcpLauncher.skill();
            // Session allowlists are keyed by the provider session plus its generation, so `/new` starts empty.
            const approval = plan.tools.interactiveApproval
              ? { sessionKey: approvalSessionKey(sessionKey ?? { schedule: job.jobId }, sessionGeneration), workspaceRoot: plan.workspacePath } : null;
            launch = this.mcpLauncher.mint({ jobId: job.jobId, accountId: job.accountId, generation: job.generation, approval });
            if (launch) {
              // Add history guidance on every eligible run, including provider-resumed sessions. The hint sits after
              // the output-channel line, before the user's text, in the run request only (the stored job prompt is unchanged).
              // Eligible: an Agent room job, or an admin-direct LINE job while the room shares that chat (checked now).
              const historyEligible = job.sourceType === 'ui'
                || job.sourceType !== 'schedule' && await (async () => this.agents.sharesAgentRoomHistory({ sourceType: job.sourceType, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId }))().catch(() => false);
              // 「身分」 block: who the Agent, the administrator and the current chat are. A failed lookup omits it; it never fails the job.
              const identityBlock = await (async () => formatIdentityBlock(await this.agents.describeJobIdentity({
                sourceType: job.sourceType, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, jobId: job.jobId })))().catch(() => null);
              // Schedule-sourced jobs get their machine instructions here, in the run request only (the stored prompt stays the short card).
              const scheduleContext = job.sourceType === 'schedule' || isScheduledRunRequestId(job.sourceRequestId)
                ? await (async () => await this.mcpLauncher?.scheduleContext?.(job.sourceRequestId!))().catch(() => null) ?? SCHEDULE_CONTEXT_UNAVAILABLE : null;
              const visible = scheduleContext ? `${request.prompt}

${scheduleContext}` : request.prompt;
              const userText = withIdentityBlock(historyEligible ? withAgentRoomHistoryHint(visible) : visible, identityBlock);
              runRequest = { ...request, prompt: withMcpSkill(skill, withOutputChannel(userText, job.sourceType)), mcp: launch };
            }
          } catch (error) { this.reportFailure('prepare', error, job.jobId); launch = null; }
          const initial: AgentEvent = launch
            ? { type: 'mcp_status', status: 'configured', message: MCP_STATUS_MESSAGES.configured }
            : { type: 'mcp_status', status: 'not_loaded', message: MCP_STATUS_MESSAGES.not_loaded };
          if (launch) {
            execution.mcpPhase = 'configured';
            execution.mcpObserveAt = Date.now() + MCP_OBSERVATION_TIMEOUT_MS;
          }
          await this.agents.appendEvent(job.jobId, initial).catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
          await this.onEvent?.(job.jobId, initial);
        }
        // The project folders are named in the run request only, after the MCP skill block (a resumed session is told again).
        const projectFolderSection = projectFolderPromptSection(plan.tools.projectDirs, job.provider === 'codex' && plan.tools.ownFolderReadOnly === true);
        if (projectFolderSection) runRequest = { ...runRequest, prompt: `${runRequest.prompt}${projectFolderSection}` };
        // The persona (語氣與風格設定) of a LINE reply: run request only. The Agent room and schedules never get it.
        if (job.sourceType === 'line' && job.accountId && job.chatType && job.chatId && this.resolvePersonaDescription) {
          const personaSection = await this.resolvePersonaDescription({ accountId: job.accountId, chatType: job.chatType, chatId: job.chatId })
            .then(personaPromptSection).catch(() => '');
          if (personaSection) runRequest = { ...runRequest, prompt: `${runRequest.prompt}${personaSection}` };
        }
        if (attachmentFiles.length > 0) {
          // Added last and to the run request only: the stored job prompt never carries the section or any path.
          const imagePaths = job.provider === 'codex' ? attachmentFiles.filter((item) => item.kind === 'image').map((item) => item.absolutePath) : [];
          runRequest = { ...runRequest, prompt: `${runRequest.prompt}${attachmentPromptSection(job.provider, attachmentFiles)}`,
            ...(imagePaths.length > 0 ? { imagePaths } : {}) };
        }
        execution.deadlineAt = Date.now() + this.maxExecutionMs;
        execution.nextHeartbeatAt = Date.now() + this.statusRotationIntervalMs;
        this.executions.set(job.jobId, execution);
        this.startScheduler();
        this.sendReaction(execution, 'NICE', 'running');
        for await (const event of this.bridge.run(runRequest)) {
          if (execution.deadlineExceeded) break;
          if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') { execution.terminalPending = true; this.releaseMcp(job.jobId); }
          if ((await this.agents.getJob(job.jobId))?.status !== 'running') continue;
          await this.agents.appendEvent(job.jobId, event);
          if (event.type === 'started') {
            if (event.workspacePath && sessionKey) await this.agents.bindSession({ ...sessionKey,
              externalSessionId: event.externalSessionId, generation: sessionGeneration, workspacePath: event.workspacePath });
            await this.onEvent?.(job.jobId, event);
          } else if (event.type === 'completed') {
            const projection = await this.agents.completeJob(job.jobId, event.finalText, splitDeliveryText(event.finalText), job.creationEpoch ?? 0);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'LOVE', 'completed');
              await this.onEvent?.(job.jobId, event);
              await this.onCompleted?.(job.jobId);
            }
          } else if (event.type === 'failed') {
            const projection = await this.agents.failJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, event);
            }
          } else if (event.type === 'cancelled') {
            const projection = await this.agents.cancelJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'FUN', 'cancelled');
              await this.onEvent?.(job.jobId, event);
            }
          } else await this.onEvent?.(job.jobId, event);
        }
        if (execution.deadlineExceeded) {
          await execution.deadlineCancellation;
          const timeoutEvent: AgentEvent = { type: 'failed', code: 'TIMEOUT', message: 'Agent execution timed out.', retryable: false };
          timeoutPersisted = await this.appendTimeoutWithRetry(job.jobId, timeoutEvent, this.shutdownAbortController.signal);
          if (await this.failTimedOutJob(job.jobId, this.shutdownAbortController.signal)) {
            execution.terminal = true;
            if (timeoutPersisted) {
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, timeoutEvent);
            }
          }
        } else if (!execution.terminal) {
          const projection = await this.agents.failJob(job.jobId);
          if (projection) {
            execution.terminal = true;
            this.publishLifecycle(projection);
            this.sendReaction(execution, 'SAD', 'failed');
          }
        }
      } catch (error) {
        this.reportFailure('execute', error, job.jobId);
        if (execution.deadlineExceeded && !timeoutPersisted) {
          const timeoutEvent: AgentEvent = { type: 'failed', code: 'TIMEOUT', message: 'Agent execution timed out.', retryable: false };
          timeoutPersisted = await this.appendTimeoutWithRetry(job.jobId, timeoutEvent, this.shutdownAbortController.signal);
          if (await this.failTimedOutJob(job.jobId, this.shutdownAbortController.signal)) {
            execution.terminal = true;
            if (timeoutPersisted) {
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, timeoutEvent);
            }
          }
        } else if (!execution.deadlineExceeded) {
          const projection = await this.agents.failJob(job.jobId);
          if (projection) {
            execution.terminal = true;
            this.publishLifecycle(projection);
            this.sendReaction(execution, 'SAD', 'failed');
          }
        }
      } finally {
        const current = await this.agents.getJob(job.jobId).catch(() => null);
        if (current && !execution.terminal) {
          if (current.status === 'cancelled') {
            execution.terminal = true;
            this.sendReaction(execution, 'FUN', 'cancelled');
          } else if (current.status === 'interrupted') {
            // Runtime interrupt of an active execution only. Jobs marked interrupted by startup recovery have no
            // execution and intentionally send nothing, so startup never bursts reactions to LINE.
            execution.terminal = true;
            this.sendReaction(execution, 'OMG', 'interrupted');
          } else if (current.status === 'failed') {
            execution.terminal = true;
            this.sendReaction(execution, 'SAD', 'failed');
          } else if (current.status === 'completed') {
            execution.terminal = true;
            this.sendReaction(execution, 'LOVE', 'completed');
          }
        }
        this.releaseMcp(job.jobId);
        if (execution.deadlineCancellation) await execution.deadlineCancellation.catch(() => undefined);
        this.executions.delete(job.jobId);
        if (this.executions.size === 0) this.stopScheduler();
        else this.scheduleScheduler();
        // The owned provider process has exited before run() finishes; keep the
        // global slot until any deadline-triggered cancellation confirms exit.
        this.activeJobs.delete(id);
        const accountCount = (this.activeAccountSlots.get(slotOf(key)) ?? 1) - 1;
        if (accountCount > 0) this.activeAccountSlots.set(slotOf(key), accountCount);
        else this.activeAccountSlots.delete(slotOf(key));
      }
      // Return after one job so all ready conversations re-enter global FIFO
      // arbitration rather than letting this hot conversation take the slot.
      return madeProgress;
    }
  }

  private startScheduler(): void {
    if (this.shuttingDown) return;
    this.scheduleScheduler();
  }

  private scheduleScheduler(): void {
    if (this.shuttingDown || this.executions.size === 0) { this.stopScheduler(); return; }
    let nextAt = Number.POSITIVE_INFINITY;
    for (const execution of this.executions.values()) {
      if (execution.terminal || execution.terminalPending || execution.deadlineExceeded) continue;
      nextAt = Math.min(nextAt, execution.deadlineAt,
        execution.messageId && this.onReaction ? execution.nextHeartbeatAt : Number.POSITIVE_INFINITY,
        execution.mcpPhase === 'configured' && execution.mcpObserveAt !== undefined ? execution.mcpObserveAt : Number.POSITIVE_INFINITY);
    }
    if (!Number.isFinite(nextAt)) { this.stopScheduler(); return; }
    if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = undefined;
      this.tickScheduler();
      this.scheduleScheduler();
    }, Math.max(1, nextAt - Date.now()));
  }

  private stopScheduler(): void {
    if (this.schedulerTimer === undefined) return;
    clearTimeout(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }

  private tickScheduler(): void {
    const now = Date.now();
    for (const execution of this.executions.values()) {
      if (execution.terminal || execution.terminalPending) continue;
      if (!execution.deadlineExceeded && now >= execution.deadlineAt) {
        execution.deadlineExceeded = true;
        this.releaseMcp(execution.jobId);
        execution.deadlineCancellation = this.bridge.cancel(execution.jobId);
        void execution.deadlineCancellation.catch(() => undefined);
      }
      if (execution.deadlineExceeded) continue;
      if (execution.mcpPhase === 'configured' && execution.mcpObserveAt !== undefined && now >= execution.mcpObserveAt) {
        this.emitMcpStatus(execution, 'not_loaded');
      }
      if (execution.messageId && this.onReaction && now >= execution.nextHeartbeatAt) {
        execution.nextHeartbeatAt = now + this.statusRotationIntervalMs;
        if (!execution.reactionInFlight) {
          execution.heartbeatPhase = (execution.heartbeatPhase + 1) % HEARTBEAT_REACTIONS.length;
          this.sendReaction(execution, HEARTBEAT_REACTIONS[execution.heartbeatPhase]!, 'running');
        }
      }
    }
  }

  private sendReaction(execution: ActiveExecution, reaction: AgentReaction,
    phase: Exclude<AgentReactionPhase, 'queued'>): void {
    if (!execution.messageId || !this.onReaction) return;
    if (execution.reactionInFlight) {
      if (phase !== 'running') execution.pendingReaction = { reaction, phase };
      return;
    }
    execution.reactionInFlight = true;
    void Promise.resolve().then(() => this.onReaction!(execution.jobId, execution.key as WritableConversationKey, execution.messageId!, reaction, phase))
      .catch(() => undefined)
      .finally(() => {
        execution.reactionInFlight = false;
        const pending = execution.pendingReaction;
        if (pending) {
          delete execution.pendingReaction;
          this.sendReaction(execution, pending.reaction, pending.phase);
        }
      });
  }

  private releaseAccountReservation(accountId: string): void {
    const count = (this.reservedAccountSlots.get(accountId) ?? 1) - 1;
    if (count > 0) this.reservedAccountSlots.set(accountId, count);
    else this.reservedAccountSlots.delete(accountId);
  }

  private async appendTimeoutWithRetry(jobId: string, event: AgentEvent, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) return false;
      try { await this.agents.appendEvent(jobId, event); return true; }
      catch (error) { this.reportFailure('persist', error, jobId); if (attempt < 2 && !await this.waitForRetry(10 * (attempt + 1), signal)) return false; }
    }
    return false;
  }

  private async failTimedOutJob(jobId: string, signal: AbortSignal): Promise<boolean> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const projection = await this.agents.failJob(jobId); if (projection) { this.publishLifecycle(projection); return true; }
        if ((await this.agents.getJob(jobId))?.status !== 'running') return true;
      } catch (error) { this.reportFailure('persist', error, jobId); /* Retry until the durable job is terminal. */ }
      if (!await this.waitForRetry(Math.min(1000, 25 * 2 ** Math.min(attempt++, 5)), signal)) return false;
    }
    return false;
  }

  private waitForRetry(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (keepGoing: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(keepGoing);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private refillQueued(): void {
    if (this.shuttingDown || !this.agents.listQueuedConversations) return;
    if (this.refillPromise) { this.refillPending = true; return; }
    this.refillPromise = this.recoverQueued().catch((error: unknown) => this.reportFailure('recover', error)).finally(() => {
      this.refillPromise = undefined;
      if (this.refillPending && !this.shuttingDown) {
        this.refillPending = false;
        this.refillQueued();
      }
    });
  }
}
