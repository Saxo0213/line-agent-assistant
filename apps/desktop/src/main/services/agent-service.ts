import { randomUUID } from 'node:crypto';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, isAgentScheduleQueueKey, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN, AgentProviderSchema, type AgentAttachmentUpload, type AgentEvent, type AgentProvider, type AgentRunRequest, type WritableConversationKey } from '@line-agent/contracts';
import { AgentAttachmentError, DEFAULT_ATTACHMENT_PROMPT, attachmentPromptSection, removeJobAttachments, resolveStoredAttachments, storeAttachments, validateUploads, type ResolvedAttachment } from './agent-attachments.js';
import { projectFolderPromptSection } from './project-folder-prompt.js';
import { routeKeyFor, type AgentRepository, type AgentJob, type AgentJobStatusProjection, type ClaimedAgentJob, type AgentQueueKey, type PendingFailureInput, type PendingTurn, type RouteDecision, type SessionKey } from '@line-agent/database';
import type { WorkspaceAuthority } from './workspace-authority.js';
import { splitDeliveryText } from './delivery-service.js';
import { personaPromptSection } from './agent-persona.js';
import type { ReplyContextResolver } from './agent-reply-context.js';
import type { ResidentReaped, ResidentTurnOptions } from '@line-agent/agent-bridge';
import { decideSelfHeal, emptyReplyFailure, isBlankCompletion, markAfterSelfHeal, needsLineSendCheck, type FailedAgentEvent, type SelfHealContext } from './agent-self-heal.js';
import { formatIdentityBlock, withAgentRoomHistoryHint, withIdentityBlock, withMcpSkill, withOutputChannel, type JobIdentityView } from './mcp-skill.js';
import { buildTranscript, withTranscriptPreamble } from './agent-transcript.js';
import { buildResidentPrompt, parseResidentKey, residentIdentity, residentKey, type ResidentIdentity } from './agent-resident.js';
import { isScheduledRunRequestId } from './agent-schedule-service.js';
import type { AgentJobEnvironment, AgentJobPlan } from './agent-job-environment.js';
import { AgentFailoverTurns, ALL_SOURCES_EXHAUSTED_TEXT, NO_AVAILABLE_SOURCE_TEXT, type FailoverTurnContext, type FailoverTurnStore } from './agent-failover-turns.js';
/** Plan texts T6 and T7 (CliTalkAgent ChatAvailabilityCode user messages); defined in agent-failover-turns.ts. */
export { ALL_SOURCES_EXHAUSTED_TEXT, NO_AVAILABLE_SOURCE_TEXT };
const SCHEDULE_CONTEXT_UNAVAILABLE = '（排程資料讀取失敗：請依上列卡片盡力完成，並在回覆說明缺少什麼。）';

/** Main-owned source of per-job LINEJS MCP capabilities for built-in Agents. */
export interface InternalMcpLauncher {
  /** Mints a per-job capability bound to the live listener, or null when the listener is unavailable. */
  mint(job: {
    jobId: string; accountId: string | null; generation: number;
    /** Set only for interactive-approval (operator) jobs; enables the internal permission prompt tool. */
    approval: { sessionKey: string; workspaceRoot: string } | null;
  }): { endpoint: string; token: string } | null;
  /** Synchronously closes admission and aborts in-flight requests for the job. A resident token stays. */
  release(jobId: string): void;
  /**
   * Binds a job to the token of a resident process. fresh: new token. Not fresh: the old token stays ("rebound").
   * Null when the listener is unavailable, or a not-fresh bind has no slot for the current listener instance.
   */
  bindResident?(input: {
    residentKey: string; fresh: boolean; jobId: string; accountId: string | null; generation: number;
    approval: { sessionKey: string; workspaceRoot: string } | null;
  }): { endpoint: string; token: string } | { endpoint: string; rebound: true } | null;
  /** Deletes the token of a resident process and aborts its current capability. */
  releaseResident?(residentKey: string): void;
  /** The URL of the running internal MCP listener, or null when it is not running. */
  endpoint?(): string | null;
  /** App-owned Skill guidance text, or null when unavailable. */
  skill(): Promise<string | null>;
  /** Hidden run-time instructions of a schedule-sourced job (request id `schedule:...`), or null when unavailable. */
  scheduleContext?(sourceRequestId: string, jobId: string): Promise<string | null>;
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

/** The CLI account source that a run uses (the `account` field of the run request). */
export type AgentAccountRef = NonNullable<AgentRunRequest['account']>;

/** Reads of the CLI account sources (AccountSourceRepository satisfies it). */
export interface AgentAccountSources {
  get(sourceId: string): Promise<{ sourceId: string; kind: 'system' | 'managed' } | null>;
  effectiveDefault(provider: AgentProvider): Promise<{ sourceId: string; kind: 'system' | 'managed' }>;
}

/** The router and the pending-turn store of the automatic failover (P5, plan D21 to D26). */
export interface AgentFailover {
  routing: {
    enabled(): Promise<boolean>;
    routeFor(input: { job: AgentJob; sessionKey?: SessionKey; sessionGeneration: number; excluded: readonly string[] }): Promise<RouteDecision>;
  };
  pendingTurns: {
    findByJob(jobId: string): Promise<PendingTurn | null>;
    recordFailure(input: PendingFailureInput): Promise<PendingTurn | null>;
    markExhausted(pendingId: string): Promise<boolean>;
  };
  /** Sends a notice text to the LINE chat of the job (provider switch, no source). A failure never fails the job. */
  sendNotice?: (job: ClaimedAgentJob, text: string) => Promise<void>;
  /**
   * What happens after a turn fails on quota, logout or a transient rate limit (P5 B3b). Without it the turns end as before.
   * `store` is the PendingTurnRepository; `currentBinding` gives the worker binding that a continuation of a LINE job must match.
   */
  turns?: { store: FailoverTurnStore; currentBinding?: (job: AgentJob) => Promise<{ workerInstanceId: string; controlEpoch: number } | null> };
}

export interface AgentRunner {
  /** `options.timeoutMs` is a per-run time limit that only a Codex one-shot run uses (a partial reply is kept at the limit). */
  run(request: AgentRunRequest, options?: { timeoutMs?: number }): AsyncIterable<AgentEvent>;
  queryQuota?(provider: AgentProvider, account?: AgentAccountRef): Promise<unknown>;
  /** Resolves only after the owned process tree has exited. */
  cancel(jobId: string): Promise<void>;
  /** Called with +1 before and -1 after every MCP tool call of the job. */
  noteToolActivity?(jobId: string, delta: 1 | -1): void;
  /** One turn on a resident Claude process (one process per session key). */
  runResident?(request: AgentRunRequest, turn: ResidentTurnOptions): AsyncIterable<AgentEvent>;
  hasResident?(key: string): boolean;
  /** Kills and removes each resident that the predicate accepts. */
  resetResidents?(predicate: (key: string) => boolean): number;
  /** Marks each accepted resident stale: an idle one closes now, a busy one at the end of its turn. */
  markResidentsStale?(predicate: (key: string) => boolean): number;
  /** Subscribes to the close of a resident process (reap, reset, exit). Returns the unsubscribe function. */
  onResidentClosed?(listener: (event: { key: string }) => void): (() => void) | void;
  /** Subscribes to a resident spawn at the limit when no resident can be reaped. Returns the unsubscribe function. */
  onResidentCapacityExceeded?(listener: (event: { key: string; live: number; max: number }) => void): (() => void) | void;
  /** Subscribes to the idle reap of a resident process (Auto-Slim input). Returns the unsubscribe function. */
  onResidentReaped?(listener: (event: ResidentReaped) => void): (() => void) | void;
  /** Subscribes to the result of a resident turn that no job started. The texts are ready to deliver. */
  onAutonomousReply?(listener: (event: { key: string; texts: string[] }) => void): (() => void) | void;
  /** Sets the check that tells if a resident key has a chat to deliver an autonomous reply to. */
  setRelayTarget?(hasTarget: (key: string) => boolean): void;
}

/** Options of the resident Claude path. */
export interface AgentServiceResidentOptions {
  /** Timeout of one resident turn. Default 900 000 ms. */
  residentTurnTimeoutMs?: number;
  /** Stall time of one resident turn (no CLI output). 0 = off. Default 120 000 ms. */
  residentStallMs?: number;
  /**
   * The number of committed LINE sends of a job (decision D1: no self-heal after a LINE side effect).
   * Without it, or when it throws, a failed first attempt is final.
   */
  committedLineSends?: (jobId: string) => Promise<number>;
  /**
   * The Claude model alias that the chat of a job chose with /model; null follows the bridge default (opus).
   * A change of the model changes the arguments hash, so the bridge replaces the process with --resume.
   */
  resolveClaudeModel?: (job: ClaimedAgentJob) => Promise<'haiku' | 'sonnet' | 'opus' | null>;
  /** The Codex model ID that the chat of a job chose with /model; null follows the Codex default. A resolver error means no model. */
  resolveCodexModel?: (job: ClaimedAgentJob) => Promise<string | null>;
  /**
   * The CLI account sources (P4). A chat session binds the default source on its first run and keeps it (CliTalkAgent chat.rs 3128-3166);
   * a schedule run uses the effective default. Without it every job runs on the system source of its provider.
   */
  accountSources?: AgentAccountSources;
  /** The automatic failover. Without it, or with the switch off, a job keeps the P4 source binding and no route is chosen. */
  failover?: AgentFailover;
}
export const RESIDENT_TURN_TIMEOUT_MS = 900_000;
export const RESIDENT_STALL_MS = 120_000;

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
  mcpAccountScope?: readonly string[] | null;
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
  /** The prepared run directory and file-read grant. Set after the workspace plan is ready. */
  fileAccess?: { workspacePath: string; fileRead: boolean };
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
  /** Per resident key: the last completed LINE job that ran on it. An autonomous reply goes to the chat of this job. A room job never sets it. */
  private readonly relayAnchors = new Map<string, string>();
  private readonly retrying = new Set<string>();
  /** Per-account lane for reactions of jobs that have no active execution; entries exist only while non-empty. */
  /** The turn lifecycle after a quota, logout or rate-limit failure; set only when the failover has a turn store. */
  private readonly failoverTurns: AgentFailoverTurns | undefined;
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
    /** The quoted message of a LINE reply and its ready files (run request only); null when the trigger message is no reply. */
    private readonly resolveReplyContext?: ReplyContextResolver,
    private readonly residentOptions: AgentServiceResidentOptions = {},
  ) {
    const failover = residentOptions.failover;
    if (failover?.turns) {
      this.failoverTurns = new AgentFailoverTurns({
        enabled: () => failover.routing.enabled(),
        routeFor: (input) => failover.routing.routeFor(input),
        store: failover.turns.store,
        enqueueContinuation: (input) => this.agents.enqueueContinuation(input),
        getJob: (jobId) => this.agents.getJob(jobId),
        ...(failover.turns.currentBinding ? { currentBinding: failover.turns.currentBinding } : {}),
        notify: (job, text) => this.sendFailoverNotice(job, text),
        publish: (projection) => this.publishLifecycle(projection),
        kick: (queueKey) => this.kick(queueKey),
        isShuttingDown: () => this.shuttingDown,
        ...(residentOptions.committedLineSends ? { committedLineSends: residentOptions.committedLineSends } : {}),
        report: (error, jobId) => this.reportFailure('execute', error, jobId),
      });
    }
  }

  /** CTA resume_recoverable_pending_turns: replays the exhausted pending turns (limit 8). Returns the number of continuations that started. */
  async recoverFailoverTurns(limit = 8): Promise<number> { return this.failoverTurns ? this.failoverTurns.recoverExhausted(limit) : 0; }

  /** Sends a failover notice to the LINE chat of a job in the background. A failure is a diagnostic; it never changes the job. */
  private sendFailoverNotice(job: ClaimedAgentJob, text: string): void {
    const send = this.residentOptions.failover?.sendNotice;
    if (!send) return;
    void Promise.resolve().then(() => send(job, text)).catch((error: unknown) => this.reportFailure('publish', error, job.jobId));
  }

  private reportFailure(stage: SafeDiagnostic['stage'], error?: unknown, jobId?: string): void {
    try { this.onDiagnostic?.(diagnosticFailure('agent', stage, error), jobId); } catch { /* Observation cannot change durable job state. */ }
  }

  /** True when a resident key has a completed LINE job to deliver an autonomous reply to. */
  hasRelayTarget(key: string): boolean { return this.relayAnchors.has(key); }

  /** Forget the relay target of a resident key (the process is gone). */
  forgetRelayTarget(key: string): void { this.relayAnchors.delete(key); }

  /**
   * Deliver the autonomous reply texts of a resident key to the chat of its last completed LINE job.
   * Each text is split like a job output and added to that job as new delivery rows, then the job delivery path runs.
   * A failure is a diagnostic. It never throws.
   */
  async relayAutonomousReply(event: { key: string; texts: readonly string[] }): Promise<void> {
    const anchor = this.relayAnchors.get(event.key);
    if (!anchor || this.shuttingDown) return;
    for (const text of event.texts) {
      if (this.shuttingDown) return;
      try {
        const added = await this.agents.appendRelayDelivery(anchor, splitDeliveryText(text), randomUUID());
        if (added) await this.onCompleted?.(anchor);
      } catch (error) { this.reportFailure('persist', error, anchor); }
    }
  }

  /** One diagnostic for a self-heal. The detail is a bounded slug: the failure code of the first attempt. */
  private reportSelfHeal(code: string, jobId: string): void {
    try { this.onDiagnostic?.({ ...diagnosticFailure('agent', 'execute'), detail: `self_heal:${code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)}` }, jobId); } catch { /* Observation cannot change durable job state. */ }
  }

  /** One diagnostic for a recovery of a Codex one-shot job (audit outcome 'recovered'). The detail is a fixed slug. */
  private reportRecovered(detail: string, jobId: string): void {
    try { this.onDiagnostic?.({ ...diagnosticFailure('agent', 'execute', undefined, 'recovered'), detail }, jobId); } catch { /* Observation cannot change durable job state. */ }
  }

  /** Decision D1 plus the code rules for the failure of attempt 1. The send check runs only when every code rule allows a heal. */
  private async shouldSelfHeal(jobId: string, failure: FailedAgentEvent, deadlineExceeded: boolean): Promise<boolean> {
    let committedLineSends: SelfHealContext['committedLineSends'];
    if (deadlineExceeded || !needsLineSendCheck(failure)) committedLineSends = undefined;
    else if (!this.residentOptions.committedLineSends) committedLineSends = undefined;
    else {
      try { committedLineSends = await this.residentOptions.committedLineSends(jobId); }
      catch (error) { committedLineSends = 'error'; this.reportFailure('execute', error, jobId); }
    }
    return decideSelfHeal(failure, { deadlineExceeded, committedLineSends }).heal;
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

  /** Called by Main around every MCP tool call of the job; the bridge may use it to hold its idle timer. */
  noteToolActivity(jobId: string, delta: 1 | -1): void {
    this.bridge.noteToolActivity?.(jobId, delta);
  }

  /** Called when the execution policy or the extension (external MCP server) settings changed: every resident process is replaced at its next turn. */
  noteAgentPolicyChanged(): void {
    try { this.bridge.markResidentsStale?.(() => true); } catch { /* A resident that stays is replaced by the arguments hash check. */ }
  }

  /** Resets the resident processes of a chat; the Agent room and the admin-direct chat are one pair while the room shares that chat. */
  private async resetResidentsOfChat(key: AgentQueueKey): Promise<void> {
    if (!this.bridge.resetResidents || isAgentScheduleQueueKey(key)) return;
    try {
      const identities: ResidentIdentity[] = [residentIdentity(key)];
      const isRoom = key.accountId === null;
      if (isRoom) {
        const admin = (await this.agents.describeJobIdentity({ sourceType: 'ui', accountId: null, chatType: null, chatId: null }).catch(() => null))?.admin;
        if (admin) identities.push(residentIdentity({ accountId: admin.accountId, chatType: 'direct', chatId: admin.chatId }));
      } else if (await this.agents.sharesAgentRoomHistory({ sourceType: 'line', accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }).catch(() => false)) {
        identities.push(['ui']);
      }
      const wanted = new Set(identities.map((identity) => JSON.stringify(identity)));
      this.bridge.resetResidents((residentKeyText) => {
        const parsed = parseResidentKey(residentKeyText);
        return parsed !== null && wanted.has(JSON.stringify(parsed.identity));
      });
    } catch (error) { this.reportFailure('execute', error); }
  }

  /** The run directory and file-read grant of a job that is running now. Null when the job has no active execution or it is ending. */
  runFileAccess(jobId: string): { workspacePath: string; fileRead: boolean } | null {
    const execution = this.executions.get(jobId);
    if (!execution || execution.terminal || execution.terminalPending || !execution.fileAccess) return null;
    return { ...execution.fileAccess };
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
    this.failoverTurns?.dispose();
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
    const result = await this.agents.enqueueScheduleJob({ provider: input.provider, requestId: input.requestId, prompt: input.prompt, workspacePath,
      ...(input.mcpAccountScope !== undefined ? { mcpAccountScope: input.mcpAccountScope } : {}) });
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
      await this.resetResidentsOfChat(key);
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

  queryQuota(provider: AgentProvider, account?: AgentAccountRef): Promise<unknown> {
    if (!this.bridge.queryQuota) return Promise.reject(new Error('Provider quota query is unavailable'));
    return this.bridge.queryQuota(provider, account);
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
      await this.resetResidentsOfChat(key);
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
      // Set after the routing; the turn lifecycle of a failed, completed or cancelled turn reads it (P5 B3b).
      let turnContext: FailoverTurnContext | undefined;
      // Jobs folded into this job at the claim (CliTalkAgent R2 drain). They share this run and settle with it.
      const foldedJobs = job.foldedJobs ?? [];
      let foldWorkspace: string | null = null;
      // Set when quoted files were copied into the job directory; the directory is removed when the job ends.
      let replyFilesWorkspace: string | null = null;
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
        // CliTalkAgent discord.rs parts.join("\n"): the lead prompt and each folded prompt form ONE message of ONE turn.
        if (foldedJobs.length > 0) effectivePrompt = [effectivePrompt, ...foldedJobs.map((folded) => folded.prompt)].join('\n');
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
        foldWorkspace = plan.workspacePath;
        // A room job reads and writes the session the claim fixed for it (the admin-direct session while shared, else its own);
        // every other job uses its chat's session. A scheduled run has NO session (see below).
        const scheduledRun = job.sourceType === 'schedule';
        const initialSessionKey = scheduledRun ? undefined : job.sessionKey ?? { ...key, provider: job.provider, sourceType: job.sourceType } as SessionKey;
        const initialGeneration = job.sessionGeneration ?? job.generation;
        // The CLI account source of the run (P4, decision D13; P5 routing, plan D21). A failed lookup or binding fails the job: it never runs on another account.
        // With the failover switch on, the router picks the provider and source at the start of the turn and applyRoute applies the pick.
        let account: AgentAccountRef = { id: job.provider, kind: 'system' };
        let routedSessionKey = initialSessionKey;
        let routedGeneration = initialGeneration;
        /** Set when applyRoute started a new generation: the provider and generation that ran before. */
        let switchedFrom: { provider: AgentProvider; generation: number } | undefined;
        let routingFailure: { code: 'ALL_SOURCES_EXHAUSTED' | 'NO_AVAILABLE_SOURCE'; text: string } | undefined;
        let routingPending: PendingTurn | null = null;
        const accountSources = this.residentOptions.accountSources;
        const failover = this.residentOptions.failover;
        if (accountSources) {
          try {
            if (failover && await failover.routing.enabled()) {
              const pending = scheduledRun ? null : await failover.pendingTurns.findByJob(job.jobId);
              routingPending = pending && pending.activeJobId === job.jobId ? pending : null;
              const decision = await failover.routing.routeFor({ job, ...(initialSessionKey ? { sessionKey: initialSessionKey } : {}),
                sessionGeneration: initialGeneration, excluded: routingPending?.attemptedSourceIds ?? [] });
              if (decision.kind === 'all_sources_exhausted') routingFailure = { code: 'ALL_SOURCES_EXHAUSTED', text: ALL_SOURCES_EXHAUSTED_TEXT };
              else if (decision.kind === 'no_available_source') routingFailure = { code: 'NO_AVAILABLE_SOURCE', text: NO_AVAILABLE_SOURCE_TEXT };
              else {
                const row = await accountSources.get(decision.sourceId);
                if (!row) throw new Error('The account source of the job does not exist.');
                const applied = await this.agents.applyRoute({ jobId: job.jobId, ...(initialSessionKey ? { sessionKey: initialSessionKey } : {}),
                  sessionGeneration: initialGeneration, provider: decision.provider, sourceId: decision.sourceId });
                account = { id: row.sourceId, kind: row.kind };
                // The run goes on with the applied provider, session and generation.
                job.provider = decision.provider;
                if (applied.sessionKey) {
                  routedSessionKey = applied.sessionKey;
                  routedGeneration = applied.generation;
                  job.sessionKey = applied.sessionKey;
                  job.sessionGeneration = applied.generation;
                  job.generation = applied.generation;
                }
                if (applied.switched && applied.previous) {
                  switchedFrom = applied.previous;
                  // CliTalkAgent chat.rs 950-970: the notice goes out only when the provider changes.
                  if (applied.previous.provider !== decision.provider && job.sourceType === 'line') {
                    this.sendFailoverNotice(job, `已切換至 ${decision.provider === 'codex' ? 'Codex' : 'Claude'}`);
                  }
                }
              }
            } else {
              const row = initialSessionKey
                ? await accountSources.get(await this.agents.bindSessionAccountSource(initialSessionKey, initialGeneration))
                : await accountSources.effectiveDefault(job.provider);
              if (!row) throw new Error('The account source of the job does not exist.');
              account = { id: row.sourceId, kind: row.kind };
              await this.agents.setJobAccountSource(job.jobId, account.id);
            }
          } catch (error) {
            this.reportFailure('persist', error, job.jobId);
            const event: AgentEvent = { type: 'failed', code: 'ACCOUNT_SOURCE_UNAVAILABLE', message: 'The CLI account source could not be resolved; retry later.', retryable: true };
            await this.agents.appendEvent(job.jobId, event).catch((persistError: unknown) => this.reportFailure('persist', persistError, job.jobId));
            const projection = await this.agents.failJob(job.jobId);
            if (projection) { execution.terminal = true; this.publishLifecycle(projection); this.sendReaction(execution, 'SAD', 'failed'); await this.onEvent?.(job.jobId, event); }
            continue;
          }
        }
        turnContext = { job, queueKey: key, sessionKey: routedSessionKey, sessionGeneration: routedGeneration, sourceId: account.id,
          userText: [job.prompt, ...foldedJobs.map((folded) => folded.prompt)].join('\n') };
        // CliTalkAgent supersede_matching: a resent text replaces the open pending rows of the chat. A continuation job does not.
        if (this.failoverTurns && !routingPending) await this.failoverTurns.supersede(turnContext);
        if (routingFailure && failover) {
          // CliTalkAgent chat.rs 1370-1390: a turn that finds no route is kept as an exhausted pending turn, so a recovery can run it again.
          // A scheduled run keeps none (plan D25). A turn that is already pending keeps its row.
          if (!scheduledRun && initialSessionKey && !routingPending) {
            try {
              const userText = [job.prompt, ...foldedJobs.map((folded) => folded.prompt)].join('\n');
              const recorded = await failover.pendingTurns.recordFailure({ originJobId: job.jobId, lineageKey: routeKeyFor(initialSessionKey), userText,
                provider: job.provider, sourceId: null, hadToolActivity: false, hadEffectiveOutput: false, error: routingFailure.text });
              if (recorded) await failover.pendingTurns.markExhausted(recorded.pendingId);
            } catch (error) { this.reportFailure('persist', error, job.jobId); }
          }
          const event: AgentEvent = { type: 'failed', code: routingFailure.code, message: routingFailure.text, retryable: true };
          await this.agents.appendEvent(job.jobId, event).catch((persistError: unknown) => this.reportFailure('persist', persistError, job.jobId));
          const projection = await this.agents.failJob(job.jobId);
          if (projection) { execution.terminal = true; this.publishLifecycle(projection); this.sendReaction(execution, 'SAD', 'failed'); await this.onEvent?.(job.jobId, event); }
          if (job.sourceType === 'line') this.sendFailoverNotice(job, routingFailure.text);
          // A continuation that finds no route again goes back to exhausted.
          if (this.failoverTurns) await this.failoverTurns.afterFailure(turnContext, event);
          continue;
        }
        const sessionKey = routedSessionKey;
        const sessionGeneration = routedGeneration;
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
        const resume = sessionKey ? await this.agents.lookupSession({ ...sessionKey, workspacePath: plan.workspacePath }) : null;
        const request: AgentRunRequest = { jobId: job.jobId, provider: job.provider, source, prompt: effectivePrompt,
          workspacePath: plan.workspacePath, tools: plan.tools, account, ...(plan.extensions ? { extensions: plan.extensions } : {}),
          ...(sessionGeneration === job.generation && resume?.generation === job.generation ? { resumeSessionId: resume.externalSessionId } : {}) };

        const current = await this.agents.getJob(job.jobId);
        if (this.stopping.has(id) || this.stoppingJobs.has(jobFence(key, job.jobId)) || current?.status !== 'running') {
          if (current?.status === 'running') { const projection = await this.agents.cancelJobForKey(key, job.jobId); if (projection) this.publishLifecycle(projection); }
          continue;
        }
        // Claude LINE and room jobs run on a resident process; schedule runs and Codex keep the one-shot path.
        const resident = job.provider === 'claude' && job.sourceType !== 'schedule' && sessionKey !== undefined
          && typeof this.bridge.runResident === 'function';
        let runRequest = request;
        // A Codex one-shot job of a chat or the room (not a schedule): the resident turn timeout, the chat's model, and a retry without resume.
        const codexOneShot = job.provider === 'codex' && job.sourceType !== 'schedule';
        const codexTimeoutMs = codexOneShot ? this.residentOptions.residentTurnTimeoutMs ?? RESIDENT_TURN_TIMEOUT_MS : undefined;
        let residentTurn: ResidentTurnOptions | undefined;
        const residentParts: { skill: string | null; mcp: boolean; historyEligible: boolean; identity: JobIdentityView | null; visiblePrompt: string } =
          { skill: null, mcp: false, historyEligible: false, identity: null, visiblePrompt: request.prompt };
        if (resident && sessionKey) {
          const mcpEndpoint = this.mcpLauncher?.endpoint?.() ?? null;
          const launcher = this.mcpLauncher;
          if (launcher && mcpEndpoint) {
            try {
              residentParts.skill = await launcher.skill();
              residentParts.mcp = true;
              residentParts.historyEligible = job.sourceType === 'ui'
                || await (async () => this.agents.sharesAgentRoomHistory({ sourceType: job.sourceType, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId }))().catch(() => false);
              residentParts.identity = await (async () => await this.agents.describeJobIdentity({
                sourceType: job.sourceType, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, jobId: job.jobId }))().catch(() => null);
            } catch (error) { this.reportFailure('prepare', error, job.jobId); residentParts.skill = null; }
          }
          const scheduleContext = isScheduledRunRequestId(job.sourceRequestId)
            ? await (async () => await launcher?.scheduleContext?.(job.sourceRequestId!, job.jobId))().catch(() => null) ?? SCHEDULE_CONTEXT_UNAVAILABLE : null;
          residentParts.visiblePrompt = scheduleContext ? `${request.prompt}

${scheduleContext}` : request.prompt;
          const turnKey = residentKey(residentIdentity(sessionKey), sessionGeneration, account.id);
          const bindMcp = (fresh: boolean): { token: string } | 'rebound' | null => {
            if (!launcher || !mcpEndpoint) return fresh ? null : 'rebound';
            try {
              const approval = plan.tools.interactiveApproval
                ? { sessionKey: approvalSessionKey(sessionKey, sessionGeneration), workspaceRoot: plan.workspacePath } : null;
              const bound = launcher.bindResident?.({ residentKey: turnKey, fresh, jobId: job.jobId,
                accountId: job.accountId, generation: job.generation, approval }) ?? null;
              if (bound === null) return null;
              return 'rebound' in bound ? 'rebound' : { token: bound.token };
            } catch (error) { this.reportFailure('prepare', error, job.jobId); return null; }
          };
          residentTurn = { key: turnKey, mcpEndpoint, bindMcp,
            timeoutMs: this.residentOptions.residentTurnTimeoutMs ?? RESIDENT_TURN_TIMEOUT_MS,
            stallMs: this.residentOptions.residentStallMs ?? RESIDENT_STALL_MS };
          if (launcher) {
            const initial: AgentEvent = mcpEndpoint
              ? { type: 'mcp_status', status: 'configured', message: MCP_STATUS_MESSAGES.configured }
              : { type: 'mcp_status', status: 'not_loaded', message: MCP_STATUS_MESSAGES.not_loaded };
            if (mcpEndpoint) {
              execution.mcpPhase = 'configured';
              execution.mcpObserveAt = Date.now() + MCP_OBSERVATION_TIMEOUT_MS;
            }
            await this.agents.appendEvent(job.jobId, initial).catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
            await this.onEvent?.(job.jobId, initial);
          }
        } else if (this.mcpLauncher) {
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
                ? await (async () => await this.mcpLauncher?.scheduleContext?.(job.sourceRequestId!, job.jobId))().catch(() => null) ?? SCHEDULE_CONTEXT_UNAVAILABLE : null;
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
        if (projectFolderSection && !residentTurn) runRequest = { ...runRequest, prompt: `${runRequest.prompt}${projectFolderSection}` };
        // The persona (語氣與風格設定) of a LINE reply: run request only. The Agent room and schedules never get it.
        let residentPersonaSection = '';
        let residentReplySection = '';
        let residentAttachmentSection = '';
        if (job.sourceType === 'line' && job.accountId && job.chatType && job.chatId && this.resolvePersonaDescription) {
          const personaSection = await this.resolvePersonaDescription({ accountId: job.accountId, chatType: job.chatType, chatId: job.chatId })
            .then(personaPromptSection).catch(() => '');
          if (personaSection) { residentPersonaSection = personaSection; if (!residentTurn) runRequest = { ...runRequest, prompt: `${runRequest.prompt}${personaSection}` }; }
        }
        // The quoted message of a LINE reply: run request only, before the attachment section. A failure never fails the job.
        if (job.sourceType === 'line' && job.accountId && job.chatType && job.chatId && job.sourceMessageId && this.resolveReplyContext) {
          try {
            const reply = await this.resolveReplyContext({ jobId: job.jobId, accountId: job.accountId, chatType: job.chatType, chatId: job.chatId,
              messageId: job.sourceMessageId, workspacePath: plan.workspacePath, provider: job.provider });
            if (reply) {
              residentReplySection = reply.section;
              if (!residentTurn) runRequest = { ...runRequest, prompt: `${runRequest.prompt}${reply.section}` };
              if (reply.files.length > 0) { attachmentFiles = [...attachmentFiles, ...reply.files]; replyFilesWorkspace = plan.workspacePath; }
            }
          } catch (replyError) { this.reportFailure('prepare', replyError, job.jobId); }
        }
        if (attachmentFiles.length > 0) {
          // Added last and to the run request only: the stored job prompt never carries the section or any path.
          const imagePaths = job.provider === 'codex' ? attachmentFiles.filter((item) => item.kind === 'image').map((item) => item.absolutePath) : [];
          if (residentTurn) residentAttachmentSection = attachmentPromptSection(job.provider, attachmentFiles);
          else runRequest = { ...runRequest, prompt: `${runRequest.prompt}${attachmentPromptSection(job.provider, attachmentFiles)}`,
            ...(imagePaths.length > 0 ? { imagePaths } : {}) };
        }
        if (residentTurn) {
          const built = buildResidentPrompt({ sourceType: job.sourceType === 'ui' ? 'ui' : 'line', ...residentParts,
            projectFolderSection, personaSection: residentPersonaSection, replySection: residentReplySection, attachmentSection: residentAttachmentSection });
          // CliTalkAgent prompt_user_with_session_context: a new process without a session to resume gets the recent turns in front of the message.
          // It is computed once here, so the second attempt of a self-heal sends the same message.
          let message = built.message;
          try {
            if (switchedFrom) {
              // A provider or source switch starts a new generation with nothing to resume: the turns of the previous generation come first.
              message = withTranscriptPreamble(message, buildTranscript(await this.agents.listTranscriptEvents({ jobId: job.jobId, generation: sessionGeneration, from: switchedFrom })));
            } else if (!request.resumeSessionId && !this.bridge.hasResident?.(residentTurn.key)) {
              message = withTranscriptPreamble(message, buildTranscript(await this.agents.listTranscriptEvents({ jobId: job.jobId, generation: sessionGeneration })));
            }
          } catch (error) { this.reportFailure('prepare', error, job.jobId); message = built.message; }
          let model: 'haiku' | 'sonnet' | 'opus' | undefined;
          if (this.residentOptions.resolveClaudeModel) {
            try { model = await this.residentOptions.resolveClaudeModel(job) ?? undefined; }
            catch (error) { this.reportFailure('prepare', error, job.jobId); }
          }
          residentTurn = { ...residentTurn, ...(built.systemPrompt ? { systemPrompt: built.systemPrompt } : {}), ...(model ? { model } : {}) };
          runRequest = { ...request, prompt: message };
        }
        if (codexOneShot && switchedFrom && !runRequest.resumeSessionId) {
          try {
            runRequest = { ...runRequest, prompt: withTranscriptPreamble(runRequest.prompt,
              buildTranscript(await this.agents.listTranscriptEvents({ jobId: job.jobId, generation: sessionGeneration, from: switchedFrom }))) };
          } catch (error) { this.reportFailure('prepare', error, job.jobId); }
        }
        if (codexOneShot && this.residentOptions.resolveCodexModel) {
          try { const codexModel = await this.residentOptions.resolveCodexModel(job); if (codexModel) runRequest = { ...runRequest, model: codexModel }; }
          catch (error) { this.reportFailure('prepare', error, job.jobId); }
        }
        execution.fileAccess = { workspacePath: plan.workspacePath, fileRead: plan.tools.fileRead };
        // A resident job has its own turn timeout; this deadline is only a backstop above it.
        execution.deadlineAt = Date.now() + (residentTurn ? 2 * residentTurn.timeoutMs + 60_000 : codexTimeoutMs !== undefined ? codexTimeoutMs + 60_000 : this.maxExecutionMs);
        execution.nextHeartbeatAt = Date.now() + this.statusRotationIntervalMs;
        this.executions.set(job.jobId, execution);
        this.startScheduler();
        this.sendReaction(execution, 'NICE', 'running');
        for (const folded of foldedJobs) {
          if (job.sourceType === 'line' && folded.sourceMessageId && LINE_MESSAGE_ID.test(folded.sourceMessageId)) {
            this.enqueueDetachedReaction(folded.jobId, key as WritableConversationKey, folded.sourceMessageId, 'NICE', 'running');
          }
        }
        // The external session id is stored only when the job completes with success (CliTalkAgent chat.rs). A failed job keeps the old session.
        let pendingSession: { externalSessionId: string; workspacePath: string } | undefined;
        // Self-heal (CliTalkAgent self_heal_once): a resident turn that fails gets ONE more attempt on a new process, unless a rule in
        // agent-self-heal.ts forbids it. The failure of attempt 1 is held back: nothing is stored, no reaction is sent for it.
        let attempt = 1;
        let healed = false;
        let attemptRequest = runRequest;
        let heldFailure: FailedAgentEvent | undefined;
        do {
        heldFailure = undefined;
        pendingSession = undefined;
        const events = residentTurn && this.bridge.runResident ? this.bridge.runResident(attemptRequest, residentTurn)
          : this.bridge.run(attemptRequest, ...(codexTimeoutMs !== undefined ? [{ timeoutMs: codexTimeoutMs }] : []));
        for await (let event of events) {
          if (execution.deadlineExceeded) break;
          if (residentTurn && isBlankCompletion(event)) event = emptyReplyFailure();
          if (event.type === 'failed' && residentTurn && attempt === 1
            && (await this.agents.getJob(job.jobId))?.status === 'running'
            && await this.shouldSelfHeal(job.jobId, event, execution.deadlineExceeded)) { heldFailure = event; break; }
          // CliTalkAgent should_retry_without_resume (decision D7): a Codex thread that is gone gets ONE more attempt without resume, under the D1 send rule.
          if (event.type === 'failed' && codexOneShot && attempt === 1 && event.code === 'RESUME_NOT_FOUND' && attemptRequest.resumeSessionId !== undefined
            && (await this.agents.getJob(job.jobId))?.status === 'running'
            && await this.shouldSelfHeal(job.jobId, event, execution.deadlineExceeded)) { heldFailure = event; break; }
          if (event.type === 'failed' && healed) event = markAfterSelfHeal(event);
          // CliTalkAgent always clears the stored provider session for this failure; without it the next job resumes the dead thread again.
          // The retry path cleared it before attempt 2, and attempt 2 has no resume id, so this is the final failure of attempt 1 only.
          if (event.type === 'failed' && codexOneShot && event.code === 'RESUME_NOT_FOUND' && sessionKey && resume && resume.generation === sessionGeneration) {
            await this.agents.clearExternalSession(sessionKey, sessionGeneration, resume.externalSessionId)
              .catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
          }
          if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') { execution.terminalPending = true; this.releaseMcp(job.jobId); }
          if ((await this.agents.getJob(job.jobId))?.status !== 'running') continue;
          await this.agents.appendEvent(job.jobId, event);
          if (event.type === 'started') {
            if (event.workspacePath) pendingSession = { externalSessionId: event.externalSessionId, workspacePath: event.workspacePath };
            await this.onEvent?.(job.jobId, event);
          } else if (event.type === 'completed') {
            if (event.partial) this.reportRecovered('timeout_partial', job.jobId);
            if (pendingSession && sessionKey) await this.agents.bindSession({ ...sessionKey,
              externalSessionId: pendingSession.externalSessionId, generation: sessionGeneration, workspacePath: pendingSession.workspacePath });
            const projection = await this.agents.completeJob(job.jobId, event.finalText, splitDeliveryText(event.finalText), job.creationEpoch ?? 0);
            if (projection) {
              execution.terminal = true;
              if (residentTurn && job.sourceType === 'line') this.relayAnchors.set(residentTurn.key, job.jobId);
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'LOVE', 'completed');
              await this.onEvent?.(job.jobId, event);
              await this.onCompleted?.(job.jobId);
              if (this.failoverTurns && turnContext) await this.failoverTurns.afterCompleted(turnContext);
            }
          } else if (event.type === 'failed') {
            const projection = await this.agents.failJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'SAD', 'failed');
              // The failed-event handler (quota block) has finished before the turn lifecycle routes again.
              await this.onEvent?.(job.jobId, event);
              if (this.failoverTurns && turnContext) await this.failoverTurns.afterFailure(turnContext, event);
            }
          } else if (event.type === 'cancelled') {
            const projection = await this.agents.cancelJob(job.jobId);
            if (projection) {
              execution.terminal = true;
              this.publishLifecycle(projection);
              this.sendReaction(execution, 'FUN', 'cancelled');
              await this.onEvent?.(job.jobId, event);
              if (this.failoverTurns && turnContext) await this.failoverTurns.afterCancelled(turnContext);
            }
          } else await this.onEvent?.(job.jobId, event);
        }
        if (heldFailure && (residentTurn || codexOneShot) && !execution.deadlineExceeded && (await this.agents.getJob(job.jobId))?.status === 'running') {
          // Attempt 2: reset this key only, forget the stored provider session id, and run without a resume id.
          if (residentTurn) {
            this.reportSelfHeal(heldFailure.code, job.jobId);
            try { this.bridge.resetResidents?.((candidate) => candidate === residentTurn!.key); } catch (error) { this.reportFailure('execute', error, job.jobId); }
          } else this.reportRecovered('resume_not_found_retry', job.jobId);
          if (sessionKey && resume && resume.generation === sessionGeneration) {
            await this.agents.clearExternalSession(sessionKey, sessionGeneration, resume.externalSessionId)
              .catch((error: unknown) => this.reportFailure('persist', error, job.jobId));
          }
          const { resumeSessionId: _dropped, ...withoutResume } = attemptRequest;
          void _dropped;
          attemptRequest = withoutResume;
          attempt = 2;
          healed = true;
        } else heldFailure = undefined;
        } while (heldFailure);
        if (execution.deadlineExceeded) {
          await execution.deadlineCancellation;
          const timeoutEvent: AgentEvent = { type: 'failed', code: 'TIMEOUT', message: 'Agent execution timed out.', retryable: false };
          timeoutPersisted = await this.appendTimeoutWithRetry(job.jobId, timeoutEvent, this.shutdownAbortController.signal);
          if (await this.failTimedOutJob(job.jobId, this.shutdownAbortController.signal)) {
            execution.terminal = true;
            if (timeoutPersisted) {
              this.sendReaction(execution, 'SAD', 'failed');
              await this.onEvent?.(job.jobId, timeoutEvent);
              if (this.failoverTurns && turnContext) await this.failoverTurns.afterFailure(turnContext, timeoutEvent);
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
              if (this.failoverTurns && turnContext) await this.failoverTurns.afterFailure(turnContext, timeoutEvent);
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
        // Best effort: quoted files of a LINE job are deleted at the end of the job and never change its result.
        if (replyFilesWorkspace) await removeJobAttachments(replyFilesWorkspace, job.jobId).catch(() => undefined);
        const current = await this.agents.getJob(job.jobId).catch(() => null);
        if (current && !execution.terminal) {
          if (current.status === 'cancelled') {
            execution.terminal = true;
            this.sendReaction(execution, 'FUN', 'cancelled');
            if (this.failoverTurns && turnContext) await this.failoverTurns.afterCancelled(turnContext);
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
        // A continuation job that ended on a path without the turn lifecycle (early failure, fallback failJob, interrupt) settles its row here.
        if (this.failoverTurns && current && (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled' || current.status === 'interrupted')) {
          await this.failoverTurns.settleLeftover(job.jobId, current.status);
        }
        if (foldedJobs.length > 0) await this.settleFoldedJobs(job.jobId, foldedJobs, foldWorkspace);
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

  /**
   * The lead of folded jobs ended: each still-queued follower takes the lead's status (one reply, delivered by the lead only),
   * gets the same terminal reaction through the detached lane, and its stored files are deleted. A lead that is not terminal
   * settles nothing; startup recovery frees its followers. Best effort: a failure never changes the lead.
   */
  private async settleFoldedJobs(leadJobId: string, folded: readonly { jobId: string }[], workspacePath: string | null): Promise<void> {
    let settled: AgentJobStatusProjection[] = [];
    try { settled = await this.agents.settleFolded(leadJobId); }
    catch (error) { this.reportFailure('persist', error, leadJobId); }
    for (const projection of settled) {
      this.publishLifecycle(projection);
      if (projection.sourceType !== 'line' || !projection.sourceMessageId || !LINE_MESSAGE_ID.test(projection.sourceMessageId)) continue;
      const reaction: { reaction: AgentReaction; phase: Exclude<AgentReactionPhase, 'queued' | 'running'> } | null =
        projection.status === 'completed' ? { reaction: 'LOVE', phase: 'completed' }
        : projection.status === 'failed' ? { reaction: 'SAD', phase: 'failed' }
        : projection.status === 'cancelled' ? { reaction: 'FUN', phase: 'cancelled' }
        : projection.status === 'interrupted' ? { reaction: 'OMG', phase: 'interrupted' } : null;
      if (!reaction) continue;
      this.enqueueDetachedReaction(projection.jobId, { accountId: projection.accountId, chatType: projection.chatType, chatId: projection.chatId },
        projection.sourceMessageId, reaction.reaction, reaction.phase);
    }
    if (workspacePath) for (const item of folded) await removeJobAttachments(workspacePath, item.jobId).catch(() => undefined);
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
