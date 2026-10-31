import {
  AGENT_SCHEDULE_REQUEST_PREFIX,
  agentScheduleShapeError,
  resolveScheduleMessagePlaceholders,
  type AgentProvider,
  type AgentSchedulePreviewNewMessagesOutput,
  type AgentSchedulePreviewNewMessagesRequest,
  type AgentScheduleNewMessagesTask,
  type AgentSchedule,
  type AgentScheduleCreateInput,
  type AgentScheduleRun,
  type AgentScheduleSendTarget,
  type AgentScheduleTarget,
  type AgentScheduleTargetOption,
  type AgentScheduleUpdatePatch,
} from '@line-agent/contracts';
import { AgentScheduleError, resolveCurrentAgentKey, type AgentLineage, type AgentScheduleClaim, type AgentScheduleClaimResult, type AgentScheduleRepository } from '@line-agent/database';
import { composeScheduleRunContext, composeScheduledPrompt, computeScheduleWindow, type ScheduleTimeWindow } from './agent-schedule-prompt.js';
import type { AgentScheduleMessageContext, AgentScheduleMessageReader } from './agent-schedule-reader.js';
import { NEW_MESSAGES_EMPTY_LINE, evaluateNewMessages, listedText, type NewMessagesEvaluation, type ScheduleOwnDelivery } from './agent-schedule-rules.js';

export const AGENT_SCHEDULE_TICK_MS = 30_000;

export type AgentScheduleStore = Pick<AgentScheduleRepository,
  'list' | 'get' | 'create' | 'update' | 'delete' | 'claimDue' | 'markSubmitted' | 'markFailed' | 'markSent' | 'markSendFailed' | 'markSendUnknown' | 'markNoMessages'
  | 'recoverStale' | 'listRuns' | 'previousSubmittedFor'> & Partial<Pick<AgentScheduleRepository, 'listExternalScoped' | 'updateExternalScoped' | 'deleteExternalScoped'>>;

export interface AgentScheduleSubmission { provider: AgentProvider; requestId: string; prompt: string; mcpAccountScope?: readonly string[] | null }

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
  /** Reads the messages of a window for new_messages schedules (same scope, redaction and audit as a scheduled Agent run). */
  readMessages?: AgentScheduleMessageReader;
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
      if (claim.task.type === 'new_messages') { await this.runNewMessages(claim); continue; }
      try {
        const prompt = composeScheduledPrompt({
          title: claim.title, prompt: claim.prompt, task: claim.task, targets: claim.targets, delivery: claim.delivery,
          window: computeScheduleWindow({ window: claim.window, recurrence: claim.recurrence, scheduledFor: claim.scheduledFor,
            previousSubmittedFor: claim.previousSubmittedFor }),
        });
        const accountScope = await this.currentAccountScope(claim.externalAccountScope);
        const job = await this.options.submit({ provider: claim.provider, requestId: scheduleRequestId(claim.scheduleId, claim.scheduledFor), prompt,
          ...(accountScope != null ? { mcpAccountScope: accountScope } : {}) });
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
      const target = await this.deliveryTarget(claim.delivery);
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

  /** The LINE chat a program schedule sends to: the line_target chat, or the Primary Admin's direct chat; null when there is none. */
  private async deliveryTarget(delivery: AgentSchedule['delivery']): Promise<AgentScheduleSendTarget | null> {
    if (delivery.mode === 'line_target') return delivery.target;
    if (delivery.mode === 'primary_admin') {
      const admin = await this.primaryAdminChat();
      if (admin) return { accountId: admin.accountId, chatType: 'direct', chatId: admin.chatId, title: admin.title };
    }
    return null;
  }

  /**
   * The delivery chat as the chat of the own lists (the messages that the schedule sent are not new messages). Null when there is no
   * delivery chat. A lookup error goes to onError and counts as none; the send step looks up the target again and handles its own error.
   */
  private async ownDelivery(delivery: AgentSchedule['delivery'] | null | undefined): Promise<ScheduleOwnDelivery | null> {
    if (!delivery) return null;
    try {
      const target = await this.deliveryTarget(delivery);
      return target ? { accountId: target.accountId, chatType: target.chatType, chatId: target.chatId } : null;
    } catch (error) {
      this.options.onError?.(error);
      return null;
    }
  }

  /** Reads the window and applies the rules of a new_messages task. A read error is thrown with its real error. */
  private async evaluateNewMessages(task: AgentScheduleNewMessagesTask, targets: readonly AgentScheduleTarget[], window: ScheduleTimeWindow,
    ownDelivery: ScheduleOwnDelivery | null, context?: AgentScheduleMessageContext): Promise<{ evaluation: NewMessagesEvaluation; incomplete: boolean }> {
    const reader = this.options.readMessages;
    if (!reader) throw new Error('The schedule message reader is not available.');
    const read = await reader({ from: window.from, to: window.to, targets, ...(context ? { context } : {}) });
    return { evaluation: evaluateNewMessages({ task, messages: read.messages, window, ownDelivery }), incomplete: read.incomplete };
  }

  /**
   * A new_messages run. Main reads the window and applies the rules. Chats with action list are sent as one text through the Agent LINE
   * send queue; chats with action llm start one Agent job (only when there are some). With nothing to send and no llm chat the run ends as
   * no_messages (or sends one line when sendWhenEmpty). `send_unknown` is final. A read error ends the run as failed.
   */
  private async runNewMessages(claim: AgentScheduleClaim): Promise<void> {
    const store = this.options.store;
    const task = claim.task;
    if (task.type !== 'new_messages') return;
    const window = computeScheduleWindow({ window: claim.window, recurrence: claim.recurrence, scheduledFor: claim.scheduledFor,
      previousSubmittedFor: claim.previousSubmittedFor });
    const accountScope = await this.currentAccountScope(claim.externalAccountScope);
    let result: { evaluation: NewMessagesEvaluation; incomplete: boolean };
    try {
      result = await this.evaluateNewMessages(task, claim.targets, window, await this.ownDelivery(claim.delivery),
        { sourceType: 'schedule', accountScope });
    } catch (error) {
      this.options.onError?.(error);
      await store.markFailed(claim.runId).catch((markError: unknown) => { this.options.onError?.(markError); });
      return;
    }
    try {
      const llmChats = result.evaluation.chats.filter((chat) => chat.action === 'llm');
      let text = listedText(result.evaluation.chats, result.incomplete);
      if (text.length === 0 && llmChats.length === 0) {
        if (!task.sendWhenEmpty) { await store.markNoMessages(claim.runId); return; }
        text = NEW_MESSAGES_EMPTY_LINE;
      }
      if (text.length > 0) {
        let status: 'sent' | 'failed' | 'unknown' = 'failed';
        try {
          const target = await this.deliveryTarget(claim.delivery);
          if (target && this.options.sendSystemText) status = (await this.options.sendSystemText({ runId: claim.runId, target, text })).status;
        } catch (error) {
          this.options.onError?.(error);
        }
        if (status === 'unknown') { await store.markSendUnknown(claim.runId); return; }
        if (status !== 'sent') { await store.markSendFailed(claim.runId); return; }
      }
      if (llmChats.length === 0) { await store.markSent(claim.runId); return; }
      const prompt = composeScheduledPrompt({
        title: claim.title, prompt: claim.prompt, task, targets: claim.targets, delivery: claim.delivery, window,
        llmChats: llmChats.map((chat) => ({ accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId, title: chat.title })),
      });
      const job = await this.options.submit({ provider: claim.provider, requestId: scheduleRequestId(claim.scheduleId, claim.scheduledFor), prompt,
        ...(accountScope !== null ? { mcpAccountScope: accountScope } : {}) });
      await store.markSubmitted(claim.runId, job.jobId);
    } catch (error) {
      this.options.onError?.(error);
      await store.markFailed(claim.runId).catch((markError: unknown) => { this.options.onError?.(markError); });
    }
  }

  /**
   * The hidden run-time instructions of a schedule-sourced job (request id `schedule:<id>:<scheduledFor>`), rebuilt from the schedule
   * row at job start. Returns null when the request id is not a schedule's or the schedule no longer exists.
   */
  async runContext(sourceRequestId: string, jobId?: string): Promise<string | null> {
    if (!isScheduledRunRequestId(sourceRequestId)) return null;
    const match = /^schedule:([0-9a-f-]{36}):(.+)$/i.exec(sourceRequestId);
    const scheduledFor = match ? new Date(match[2]!) : null;
    if (!match || !scheduledFor || Number.isNaN(scheduledFor.getTime())) return null;
    const schedule = await this.options.store.get(match[1]!);
    if (!schedule) return null;
    const previousSubmittedFor = await this.options.store.previousSubmittedFor(schedule.scheduleId, scheduledFor);
    const mapped = await this.remapTargets(schedule);
    const adminChat = schedule.delivery.mode === 'primary_admin' ? await this.primaryAdminChat() : null;
    const window = computeScheduleWindow({ window: schedule.window, recurrence: schedule.recurrence, scheduledFor, previousSubmittedFor });
    // new_messages: evaluate the rules again for this slot; the Agent reads only the chats whose rule says llm.
    const llmChats = schedule.task.type === 'new_messages'
      ? (await this.evaluateNewMessages(schedule.task, mapped.targets, window, await this.ownDelivery(mapped.delivery), jobId
        ? { sourceType: 'job', jobId, generation: 0, accountId: null }
        : { sourceType: 'schedule', accountScope: null })).evaluation.chats.filter((chat) => chat.action === 'llm')
        .map((chat) => ({ accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId, title: chat.title }))
      : undefined;
    return composeScheduleRunContext({
      title: schedule.title, prompt: schedule.prompt, task: schedule.task, targets: mapped.targets, delivery: mapped.delivery, adminChat, window,
      ...(llmChats ? { llmChats } : {}),
    });
  }

  private async lineage(): Promise<AgentLineage | null> {
    try { return await this.options.agentLineage?.() ?? null; } catch (error) { this.options.onError?.(error); return null; }
  }

  private async currentAccountScope(accountScope: readonly string[] | null): Promise<string[] | null> {
    if (accountScope === null) return null;
    const lineage = await this.lineage();
    return [...new Set(accountScope.map((accountId) => lineage?.currentAccountId && lineage.accountIds.includes(accountId)
      ? lineage.currentAccountId : accountId))];
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
  listExternal(accountIds: readonly string[]): Promise<AgentSchedule[]> { return this.options.store.listExternalScoped?.(accountIds) ?? Promise.resolve([]); }
  listRuns(scheduleId: string, limit = 20): Promise<AgentScheduleRun[]> { return this.options.store.listRuns(scheduleId, limit); }
  listTargets(query: string | undefined, limit = 20, purpose: AgentScheduleTargetPurpose = 'read'): Promise<AgentScheduleTargetOption[]> {
    return this.options.targets ? this.options.targets.list(query, limit, purpose) : Promise.resolve([]);
  }

  /**
   * Preview of a new_messages form: reads and evaluates the latest window that ends now. A delivery of the form (mapped through the Agent
   * lineage) removes the own lists, as a real run does; with none, no message is removed as own. It never sends, never creates a job and never
   * writes a run.
   */
  async previewNewMessages(input: AgentSchedulePreviewNewMessagesRequest): Promise<AgentSchedulePreviewNewMessagesOutput> {
    const resolved = await this.resolveTargets(input.targets);
    const lineage = await this.lineage();
    const targets = lineage ? resolved.map((target) => resolveCurrentAgentKey(lineage, target)) : resolved;
    const to = this.now();
    const window = computeScheduleWindow({ window: input.window, recurrence: input.recurrence ?? { kind: 'daily', time: '00:00' }, scheduledFor: to,
      previousSubmittedFor: null });
    const delivery = input.delivery ? (await this.remapTargets({ targets: [], delivery: input.delivery })).delivery : null;
    const { evaluation, incomplete } = await this.evaluateNewMessages(input.task, targets, window, await this.ownDelivery(delivery));
    return {
      from: window.from.toISOString(), to: window.to.toISOString(),
      chats: evaluation.chats.map((chat) => ({ accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId, title: chat.title,
        messageCount: chat.messageCount, senderCount: chat.senderCount, action: chat.action, text: chat.text })),
      messageCount: evaluation.messageCount, chatCount: evaluation.chatCount, listedChars: evaluation.listedChars, incomplete,
    };
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
    return this.createWithAccountScope(input, null);
  }

  async createExternal(input: AgentScheduleCreateInput, accountScope: readonly string[], signal?: AbortSignal): Promise<AgentSchedule> {
    const scope = [...new Set(accountScope)];
    const required = this.scheduleTargetAccounts(input.targets, input.delivery);
    if (required.some((accountId) => !scope.includes(accountId))) {
      throw new AgentScheduleError('SCHEDULE_INVALID_TARGET', 'Schedule target is outside its authorized account scope.');
    }
    return this.createWithAccountScope(input, scope, signal);
  }

  private async createWithAccountScope(input: AgentScheduleCreateInput, accountScope: readonly string[] | null, signal?: AbortSignal): Promise<AgentSchedule> {
    const invalid = agentScheduleShapeError({ prompt: input.prompt, targets: input.targets, task: input.task, delivery: input.delivery });
    if (invalid) throw new AgentScheduleError('SCHEDULE_INVALID', invalid);
    const resolved: AgentScheduleCreateInput = {
      ...input,
      targets: await this.resolveTargets(input.targets),
      delivery: input.delivery.mode === 'line_target' ? { mode: 'line_target', target: await this.resolveSendTarget(await this.currentDeliveryTarget(input.delivery.target)) } : input.delivery,
    };
    if (signal?.aborted) throw signal.reason ?? new Error('Schedule request cancelled before database mutation.');
    const schedule = await this.options.store.create(resolved, this.now(), accountScope);
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

  async updateExternal(scheduleId: string, patch: AgentScheduleUpdatePatch, allowedAccountIds: readonly string[], signal?: AbortSignal): Promise<AgentSchedule> {
    const required = this.scheduleTargetAccounts(patch.targets, patch.delivery);
    if (required.some((accountId) => !allowedAccountIds.includes(accountId))) {
      throw new AgentScheduleError('SCHEDULE_INVALID_TARGET', 'Schedule target is outside its authorized account scope.');
    }
    const resolved: AgentScheduleUpdatePatch = { ...patch };
    if (patch.targets) resolved.targets = await this.resolveTargets(patch.targets);
    if (patch.delivery?.mode === 'line_target') {
      resolved.delivery = { mode: 'line_target', target: await this.resolveSendTarget(await this.currentDeliveryTarget(patch.delivery.target)) };
    }
    if (!this.options.store.updateExternalScoped) throw new AgentScheduleError('SCHEDULE_NOT_FOUND', 'Schedule not found.');
    if (signal?.aborted) throw signal.reason ?? new Error('Schedule request cancelled before database mutation.');
    const schedule = await this.options.store.updateExternalScoped(scheduleId, resolved, allowedAccountIds, required, this.now());
    this.changed();
    return schedule;
  }

  async delete(scheduleId: string): Promise<boolean> {
    const deleted = await this.options.store.delete(scheduleId);
    if (deleted) this.options.publish?.();
    return deleted;
  }

  async deleteExternal(scheduleId: string, allowedAccountIds: readonly string[], signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw signal.reason ?? new Error('Schedule request cancelled before database mutation.');
    const deleted = await this.options.store.deleteExternalScoped?.(scheduleId, allowedAccountIds) ?? false;
    if (deleted) this.changed();
    return deleted;
  }

  private scheduleTargetAccounts(targets: readonly AgentScheduleTarget[] | undefined, delivery: AgentSchedule['delivery'] | undefined): string[] {
    return [...new Set([...(targets ?? []).map((target) => target.accountId), ...(delivery?.mode === 'line_target' ? [delivery.target.accountId] : [])])];
  }
}
