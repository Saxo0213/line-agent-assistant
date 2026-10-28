import {
  AGENT_SCHEDULE_REQUEST_PREFIX,
  agentScheduleShapeError,
  resolveScheduleMessagePlaceholders,
  type AgentProvider,
  type AgentSchedule,
  type AgentScheduleCreateInput,
  type AgentScheduleRun,
  type AgentScheduleSendTarget,
  type AgentScheduleTarget,
  type AgentScheduleTargetOption,
  type AgentScheduleUpdatePatch,
} from '@line-agent/contracts';
import { AgentScheduleError, resolveCurrentAgentKey, type AgentLineage, type AgentScheduleClaim, type AgentScheduleClaimResult, type AgentScheduleRepository } from '@line-agent/database';
import { composeScheduleRunContext, composeScheduledPrompt, computeScheduleWindow } from './agent-schedule-prompt.js';

export const AGENT_SCHEDULE_TICK_MS = 30_000;

export type AgentScheduleStore = Pick<AgentScheduleRepository,
  'list' | 'get' | 'create' | 'update' | 'delete' | 'claimDue' | 'markSubmitted' | 'markFailed' | 'markSent' | 'markSendFailed' | 'markSendUnknown'
  | 'recoverStale' | 'listRuns' | 'previousSubmittedFor'>;

export interface AgentScheduleSubmission { provider: AgentProvider; requestId: string; prompt: string }

export type AgentScheduleTargetPurpose = 'read' | 'delivery';

/** Sends a system message through the Agent LINE send queue (AgentLineSendService.sendSystemText). `unknown` is never retried. */
export interface AgentScheduleSystemMessage {
  runId: string;
  target: AgentScheduleSendTarget;
  text: string;
}
export type AgentScheduleSystemSender = (input: AgentScheduleSystemMessage) => Promise<{ status: 'sent' | 'failed' | 'unknown' }>;

/**
 * Conversations a schedule may use. read: any chat the Agent can read through list_targets (communities included), never the local
 * Agent room. delivery: the Agent account's direct, group and room chats (the send-target lookup).
 */
export interface AgentScheduleTargetResolver {
  /** Returns the targets with a refreshed title; throws AgentScheduleError('SCHEDULE_INVALID_TARGET') for an unknown or forbidden one. */
  resolve(targets: readonly AgentScheduleTarget[], purpose?: AgentScheduleTargetPurpose): Promise<AgentScheduleTarget[]>;
  list(query: string | undefined, limit: number, purpose?: AgentScheduleTargetPurpose): Promise<AgentScheduleTargetOption[]>;
}

/** The Agent account's direct chat with the current Primary Admin, as the delivery target of a primary_admin schedule. */
export interface AgentSchedulePrimaryAdminChat { accountId: string; chatId: string; title: string }

export interface AgentScheduleServiceOptions {
  store: AgentScheduleStore;
  /** Creates the isolated schedule job (AgentService.submitScheduled). Called only after the claim transaction committed. */
  submit: (input: AgentScheduleSubmission) => Promise<{ jobId: string }>;
  /** Sends the text of a system message schedule (no Agent job, no provider). Called only after the claim transaction committed. */
  sendSystemText?: AgentScheduleSystemSender;
  targets?: AgentScheduleTargetResolver;
  /** Resolves the Agent account lineage; stored targets of former Agent accounts are mapped to the current account at fire time. */
  agentLineage?: () => Promise<AgentLineage>;
  /** Resolves the Primary Admin direct chat at fire time; null when none. A failure counts as none. */
  primaryAdminChat?: () => Promise<AgentSchedulePrimaryAdminChat | null>;
  /** Tells subscribers that a schedule or a run changed. */
  publish?: () => void;
  now?: () => Date;
  tickMs?: number;
  onError?: (error: unknown) => void;
}

/** The job request id of one schedule slot; AgentRepository.enqueueScheduleJob de-duplicates on it. */
export const scheduleRequestId = (scheduleId: string, scheduledFor: Date): string =>
  `${AGENT_SCHEDULE_REQUEST_PREFIX}${scheduleId}:${scheduledFor.toISOString()}`;

/** True for a job created by a schedule; such a job must not manage schedules. */
export const isScheduledRunRequestId = (sourceRequestId: string | null | undefined): boolean =>
  typeof sourceRequestId === 'string' && sourceRequestId.startsWith(AGENT_SCHEDULE_REQUEST_PREFIX);

/**
 * Scheduled Agent triggers (docs/architecture/agent-schedules.md). Every 30 s the service claims due schedules in one
 * database transaction, then, outside that transaction, submits each Agent claim as an isolated schedule job or sends each system
 * message claim directly through the Agent LINE send queue. Ticks never overlap.
 */
export class AgentScheduleService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly options: AgentScheduleServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Marks leftover `submitting` runs as missed, ticks once and starts the interval timer. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    const recovered = await this.options.store.recoverStale();
    if (recovered > 0) this.options.publish?.();
    this.timer = setInterval(() => { void this.tick(); }, this.options.tickMs ?? AGENT_SCHEDULE_TICK_MS);
    this.timer.unref();
    await this.tick();
  }

  /** Stops the timer and waits for the tick in flight, so no job is submitted after this resolves. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** Runs one claim-and-submit pass. A call while a pass is running joins it instead of starting another. */
  tick(): Promise<void> {
    if (this.stopped) return this.running ?? Promise.resolve();
    if (this.running) return this.running;
    const pass = this.runPass().catch((error: unknown) => { this.options.onError?.(error); })
      .finally(() => { if (this.running === pass) this.running = undefined; });
    this.running = pass;
    return pass;
  }

  private async runPass(): Promise<void> {
    const result: AgentScheduleClaimResult = await this.options.store.claimDue(this.now());
    for (const rawClaim of result.claims) {
      const claim = await this.remapTargets(rawClaim);
      if (claim.task.type === 'message') { await this.sendSystemMessage(claim); continue; }
      try {
        const prompt = composeScheduledPrompt({
          title: claim.title, prompt: claim.prompt, task: claim.task, targets: claim.targets, delivery: claim.delivery,
          window: computeScheduleWindow({ window: claim.window, recurrence: claim.recurrence, scheduledFor: claim.scheduledFor,
            previousSubmittedFor: claim.previousSubmittedFor }),
        });
        const job = await this.options.submit({ provider: claim.provider, requestId: scheduleRequestId(claim.scheduleId, claim.scheduledFor), prompt });
        await this.options.store.markSubmitted(claim.runId, job.jobId);
      } catch (error) {
        this.options.onError?.(error);
        await this.options.store.markFailed(claim.runId).catch((markError: unknown) => { this.options.onError?.(markError); });
      }
    }
    if (result.changed) this.options.publish?.();
  }

  /**
   * A system message run: Main sends the text itself (placeholders resolved for the slot time, Asia/Taipei). It never creates an
   * Agent job or touches a provider. `send_unknown` is final: the message may have reached LINE, so it is never retried.
   */
  private async sendSystemMessage(claim: AgentScheduleClaim): Promise<void> {
    const store = this.options.store;
    try {
      if (claim.task.type !== 'message') return;
      let target: AgentScheduleSendTarget | null = null;
      if (claim.delivery.mode === 'line_target') target = claim.delivery.target;
      else if (claim.delivery.mode === 'primary_admin') {
        const admin = await this.primaryAdminChat();
        if (admin) target = { accountId: admin.accountId, chatType: 'direct', chatId: admin.chatId, title: admin.title };
      }
      if (!target || !this.options.sendSystemText) { await store.markSendFailed(claim.runId); return; }
      const result = await this.options.sendSystemText({ runId: claim.runId, target,
        text: resolveScheduleMessagePlaceholders(claim.task.text, claim.scheduledFor) });
      if (result.status === 'sent') await store.markSent(claim.runId);
      else if (result.status === 'unknown') await store.markSendUnknown(claim.runId);
      else await store.markSendFailed(claim.runId);
    } catch (error) {
      this.options.onError?.(error);
      await store.markSendFailed(claim.runId).catch((markError: unknown) => { this.options.onError?.(markError); });
    }
  }

  /**
   * The hidden run-time instructions of a schedule-sourced job (request id `schedule:<id>:<scheduledFor>`), rebuilt from the schedule
   * row at job start. Returns null when the request id is not a schedule's or the schedule no longer exists.
   */
  async runContext(sourceRequestId: string): Promise<string | null> {
    if (!isScheduledRunRequestId(sourceRequestId)) return null;
    const match = /^schedule:([0-9a-f-]{36}):(.+)$/i.exec(sourceRequestId);
    const scheduledFor = match ? new Date(match[2]!) : null;
    if (!match || !scheduledFor || Number.isNaN(scheduledFor.getTime())) return null;
    const schedule = await this.options.store.get(match[1]!);
    if (!schedule) return null;
    const previousSubmittedFor = await this.options.store.previousSubmittedFor(schedule.scheduleId, scheduledFor);
    const mapped = await this.remapTargets(schedule);
    const adminChat = schedule.delivery.mode === 'primary_admin' ? await this.primaryAdminChat() : null;
    return composeScheduleRunContext({
      title: schedule.title, prompt: schedule.prompt, task: schedule.task, targets: mapped.targets, delivery: mapped.delivery, adminChat,
      window: computeScheduleWindow({ window: schedule.window, recurrence: schedule.recurrence, scheduledFor, previousSubmittedFor }),
    });
  }

  private async lineage(): Promise<AgentLineage | null> {
    try { return await this.options.agentLineage?.() ?? null; } catch (error) { this.options.onError?.(error); return null; }
  }

  /** Maps the read targets and the line_target delivery through the Agent lineage; the stored row is never rewritten. */
  private async remapTargets<T extends { targets: AgentScheduleTarget[]; delivery: AgentSchedule['delivery'] }>(value: T): Promise<T> {
    const lineage = await this.lineage();
    if (!lineage) return value;
    return { ...value, targets: value.targets.map((target) => resolveCurrentAgentKey(lineage, target)),
      delivery: value.delivery.mode === 'line_target' ? { ...value.delivery, target: resolveCurrentAgentKey(lineage, value.delivery.target) } : value.delivery };
  }

  private async currentDeliveryTarget(target: AgentScheduleSendTarget): Promise<AgentScheduleSendTarget> {
    const lineage = await this.lineage();
    return lineage ? resolveCurrentAgentKey(lineage, target) : target;
  }

  private changed(): void {
    this.options.publish?.();
    void this.tick();
  }

  list(): Promise<AgentSchedule[]> { return this.options.store.list(); }
  listRuns(scheduleId: string, limit = 20): Promise<AgentScheduleRun[]> { return this.options.store.listRuns(scheduleId, limit); }
  listTargets(query: string | undefined, limit = 20, purpose: AgentScheduleTargetPurpose = 'read'): Promise<AgentScheduleTargetOption[]> {
    return this.options.targets ? this.options.targets.list(query, limit, purpose) : Promise.resolve([]);
  }

  /** The Primary Admin's direct chat with the Agent account now, or null (also when the lookup fails). */
  async primaryAdminChat(): Promise<AgentSchedulePrimaryAdminChat | null> {
    try { return await this.options.primaryAdminChat?.() ?? null; } catch (error) { this.options.onError?.(error); return null; }
  }

  private async resolveTargets(targets: readonly AgentScheduleTarget[], purpose: AgentScheduleTargetPurpose = 'read'): Promise<AgentScheduleTarget[]> {
    if (targets.length === 0 || !this.options.targets) return [...targets];
    return this.options.targets.resolve(targets, purpose);
  }

  private async resolveSendTarget(target: AgentScheduleSendTarget): Promise<AgentScheduleSendTarget> {
    const resolved = this.options.targets ? (await this.options.targets.resolve([target], 'delivery'))[0]! : target;
    if (resolved.chatType !== 'direct' && resolved.chatType !== 'group' && resolved.chatType !== 'room') {
      throw new AgentScheduleError('SCHEDULE_INVALID_TARGET', `Unknown or unavailable chat: ${resolved.chatType}/${resolved.chatId}`);
    }
    return { ...resolved, chatType: resolved.chatType };
  }

  async create(input: AgentScheduleCreateInput): Promise<AgentSchedule> {
    const invalid = agentScheduleShapeError({ prompt: input.prompt, targets: input.targets, task: input.task, delivery: input.delivery });
    if (invalid) throw new AgentScheduleError('SCHEDULE_INVALID', invalid);
    const resolved: AgentScheduleCreateInput = {
      ...input,
      targets: await this.resolveTargets(input.targets),
      delivery: input.delivery.mode === 'line_target' ? { mode: 'line_target', target: await this.resolveSendTarget(await this.currentDeliveryTarget(input.delivery.target)) } : input.delivery,
    };
    const schedule = await this.options.store.create(resolved, this.now());
    this.changed();
    return schedule;
  }

  async update(scheduleId: string, patch: AgentScheduleUpdatePatch): Promise<AgentSchedule> {
    const current = await this.options.store.get(scheduleId);
    if (!current) throw new AgentScheduleError('SCHEDULE_NOT_FOUND', 'Schedule not found.');
    const invalid = agentScheduleShapeError({
      prompt: patch.prompt ?? current.prompt, targets: patch.targets ?? current.targets, task: patch.task ?? current.task,
      delivery: patch.delivery ?? current.delivery });
    if (invalid) throw new AgentScheduleError('SCHEDULE_INVALID', invalid);
    const resolved: AgentScheduleUpdatePatch = { ...patch };
    if (patch.targets) resolved.targets = await this.resolveTargets(patch.targets);
    if (patch.delivery?.mode === 'line_target') {
      resolved.delivery = { mode: 'line_target', target: await this.resolveSendTarget(await this.currentDeliveryTarget(patch.delivery.target)) };
    }
    const schedule = await this.options.store.update(scheduleId, resolved, this.now());
    this.changed();
    return schedule;
  }

  async delete(scheduleId: string): Promise<boolean> {
    const deleted = await this.options.store.delete(scheduleId);
    if (deleted) this.options.publish?.();
    return deleted;
  }
}
