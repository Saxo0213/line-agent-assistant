import { randomUUID } from 'node:crypto';
import type { AccountMode, ConversationKey, InboundEnvelope, WritableConversationKey, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { isWritableChatType, diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import type { AccountRepository, AdminRepository, AgentJobStatusProjection, FriendWhitelistRepository, MessageRepository, RoutingDecision, SettingsRepository } from '@line-agent/database';
import { hasOwnMention, isAgentSwitchText, isFolderCommandText, isFreeCommandText, isPersonaCommandText, routeTrigger, type FolderCommand, type FreeCommand, type PersonaCommand, type TriggerDecision } from './trigger-router.js';
import { executePersonaCommand } from './agent-persona.js';
import { classifyRoomControl, ownMentionBody, sanitizeRoomControlEnvelope, type RoomActivationCommand } from './room-control.js';
import { sanitizeInbound } from './sensitive-message-sanitizer.js';
import type { SecretStore } from './secret-store.js';
import type { WorkspaceInspection } from './workspace-authority.js';
import type { AgentReaction } from './agent-service.js';
import { claimed as permissionTicketClaimed, type PermissionCommandService, type PermissionTicket } from './permission-command.js';
import type { Locale } from '../../locale.js';
import { linePrompt } from './line-prompts.js';
import { resolveChatProvider, resolveDefaultProvider } from './default-provider.js';

import { pickWorkerBinding } from '../worker-binding-fields.js';
export type BoundWorker = WorkerBinding & { mode: AccountMode };

type ConnectionHealthLane = { binding: BoundWorker; generation: number; pending: boolean; running: boolean };

export interface WorkerCommandSink {
  send(command: LineWorkerCommand): Promise<void>;
}

export interface AgentControl {
  kick(key: WritableConversationKey): void;
  /** Resolves true when it cancelled a running or queued job. */
  stopChat(key: WritableConversationKey): Promise<boolean | void>;
  resetChat(key: WritableConversationKey, commandMessageId?: string): Promise<void>;
  getChatStatus?(key: WritableConversationKey): Promise<{ runningJobId: string | null }>;
}

interface AttachmentControl { downloadById(attachmentId: string): Promise<boolean>; }
export interface RoomControlHandler {
  handle(command: RoomActivationCommand): Promise<void>;
  isEnabled?(key: WritableConversationKey): Promise<boolean>;
  getActiveAuthorization?(key: WritableConversationKey): Promise<{ grantId: string; version: number } | null>;
  respond?(envelope: Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number], body: string): Promise<void>;
}

/** Group free mode (docs/architecture/group-free-mode.md); implemented by FreeModeService. */
export interface FreeModeControl {
  isActive(key: WritableConversationKey): boolean;
  statusText(key: WritableConversationKey): string | null;
  handleCommand(key: WritableConversationKey & { chatType: 'group' | 'room' }, enabledBy: string, command: FreeCommand, sourceMessageId?: string): Promise<void>;
  addMessage(envelope: Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number]): void;
}

/** `/folder` (docs/architecture/project-folders.md); implemented by ProjectFolderService. */
export interface ProjectFolderControl {
  handleCommand(key: WritableConversationKey, actor: string, command: FolderCommand): Promise<void>;
}

type FreeDispatch = { command: FreeCommand } | { message: true };
type AgentDispatch = Extract<TriggerDecision, { type: 'agent_provider' | 'agent_usage' }>;

export class LineService {
  private readonly bindings = new Map<string, BoundWorker>();
  private readonly qrPendingSecrets = new Map<string, { workerInstanceId: string; loginAttemptId: string; secrets: Extract<LineWorkerEvent, { type: 'secretRotation' }>['secrets'] }>();
  private readonly qrAttempts = new Map<string, { workerInstanceId: string; loginAttemptId: string; kind: 'qr' | 'token' }>();
  private readonly pendingLogouts = new Map<string, { binding: WorkerBinding; resolve(value: { ok: boolean; error: string | null }): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly attachmentReadiness = new Map<string, { accountId: string; controlEpoch: number; authenticated: boolean; ready: boolean; protocolVerified: boolean }>();
  private readonly transportHealth = new Map<string, 'connected' | 'degraded' | 'disconnected' | 'unverified'>();
  private readonly catalogHealth = new Map<string, 'ready' | 'degraded'>();
  private readonly connectionHealthWrites = new Map<string, ConnectionHealthLane>();
  private connectionHealthGeneration = 0;
  private readonly bindingReady = new Map<string, Promise<void>>();
  private readonly recoveryReady = new Map<string, Promise<void>>();
  private readonly accountBindingReady = new Map<string, Promise<void>>();
  private readonly roomEffects = new Set<Promise<void>>();
  private readonly ingressLanes = new Map<string, { tail: Promise<unknown>; count: number }>();
  private ingressClosed = false;
  constructor(
    private readonly accounts: AccountRepository,
    private readonly messages: MessageRepository,
    private readonly settings: SettingsRepository,
    private readonly worker: WorkerCommandSink,
    private readonly agents: AgentControl,
    private readonly secrets?: SecretStore,
    private readonly attachments?: AttachmentControl,
    private readonly onInboundEnvelope?: (envelope: Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number],
      secretCandidate?: Readonly<{ code: string; exact: boolean }> | null, ownMid?: string | null,
      binding?: BoundWorker) => Promise<boolean>,
    private readonly admins?: AdminRepository,
    private readonly workspaceAuthority: { inspect(): Promise<WorkspaceInspection> } = { async inspect() {
      return { status: 'unavailable', version: 0, configuredPath: null,
        reason: 'Workspace inspection is unavailable. Select an existing directory in Settings > Agent.' };
    } },
    private readonly roomControl?: RoomControlHandler,
    private readonly friendWhitelist?: Pick<FriendWhitelistRepository, 'getActiveAuthorization'>,
    private readonly classifyInbound?: (envelope: Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number],
      candidate: Readonly<{ code: string; exact: boolean }> | null, ownMid: string | null) => Promise<boolean>,
    private readonly publishCommittedJobStatuses?: (statuses: readonly NonNullable<Awaited<ReturnType<MessageRepository['ingestBatchAndRoute']>>['jobStatuses'][number]>[]) => void,
    private readonly permissionCommands?: Pick<PermissionCommandService, 'classify' | 'enqueue'>,
    private readonly publishReadPositionChanges?: (changes: readonly Readonly<{ key: ConversationKey; messageId: string }>[]) => void,
    private readonly locale: Locale | string = 'en',
    private readonly onDiagnostic?: (diagnostic: SafeDiagnostic) => void,
    private readonly freeMode?: FreeModeControl,
    private readonly projectFolders?: ProjectFolderControl,
  ) {}

  private reportFailure(stage: SafeDiagnostic['stage'], error?: unknown): void {
    try { this.onDiagnostic?.(diagnosticFailure('line_ingest', stage, error)); } catch { /* Preserve ingestion and replay ownership. */ }
  }

  bind(binding: BoundWorker, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Worker binding cancelled'));
    const priorOwner = this.bindings.get(binding.workerInstanceId);
    const sameOwner = !!priorOwner && priorOwner.accountId === binding.accountId && priorOwner.controlEpoch === binding.controlEpoch
      && priorOwner.transportOwnerId === binding.transportOwnerId && priorOwner.transportGeneration === binding.transportGeneration;
    for (const [instance, prior] of this.bindings) if (prior.accountId === binding.accountId) {
      this.bindings.delete(instance);
      this.bindingReady.delete(instance);
      this.recoveryReady.delete(instance);
      if (instance !== binding.workerInstanceId || prior.controlEpoch !== binding.controlEpoch) {
        this.attachmentReadiness.delete(instance);
        this.transportHealth.delete(instance);
        this.catalogHealth.delete(instance);
      }
    }
    this.bindings.set(binding.workerInstanceId, binding);
    if (!sameOwner) {
      this.transportHealth.set(binding.workerInstanceId, 'disconnected');
      this.catalogHealth.set(binding.workerInstanceId, 'ready');
    }
    const healthLane = this.connectionHealthWrites.get(binding.accountId);
    if (healthLane?.running) {
      healthLane.binding = binding;
      healthLane.generation = ++this.connectionHealthGeneration;
      healthLane.pending = true;
    }
    const readiness = this.attachmentReadiness.get(binding.workerInstanceId);
    if (!readiness || readiness.accountId !== binding.accountId || readiness.controlEpoch !== binding.controlEpoch) {
      this.attachmentReadiness.set(binding.workerInstanceId,
        { accountId: binding.accountId, controlEpoch: binding.controlEpoch, authenticated: false, ready: false, protocolVerified: false });
    }
    const previous = this.accountBindingReady.get(binding.accountId) ?? Promise.resolve();
    let registered!: Promise<void>;
    registered = previous.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw new Error('Worker binding cancelled');
      await this.accounts.bindWorker(binding, signal);
      if (signal?.aborted) throw new Error('Worker binding cancelled');
    }).catch((error) => {
      if (!signal?.aborted) this.reportFailure('persist', error);
      if (signal?.aborted && this.bindings.get(binding.workerInstanceId) === binding) {
        this.unbind(binding.workerInstanceId);
        if (this.accountBindingReady.get(binding.accountId) === registered) this.accountBindingReady.delete(binding.accountId);
      }
      throw error;
    });
    const recovery = registered.then(() => {
      if (signal?.aborted) throw new Error('Worker binding cancelled');
      return this.drainPendingActions(binding, signal).then(() => this.reconcileUnroutedLiveMessages(binding, signal));
    });
    // Retain the rejection for the event handler while preventing an early unhandled rejection.
    void recovery.catch(() => undefined);
    this.bindingReady.set(binding.workerInstanceId, registered);
    this.recoveryReady.set(binding.workerInstanceId, recovery);
    this.accountBindingReady.set(binding.accountId, registered);
    return registered;
  }

  private async reconcileUnroutedLiveMessages(binding: BoundWorker, signal?: AbortSignal): Promise<void> {
    const repository = this.messages as MessageRepository & {
      listUnroutedLiveSourceMessages?: (input: { accountId: string; workerInstanceId: string; controlEpoch: number;
        afterObservationId?: string; limit?: number }) => Promise<Array<{ observationId: string; envelope: InboundEnvelope | null;
          receiptMode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; receiptControlEpoch: number; sensitive: boolean }>>;
    };
    if (binding.mode !== 'ACTIVE_CONTROL' || !repository.listUnroutedLiveSourceMessages) return;
    let afterObservationId: string | undefined;
    let replayFailureReported = false;
    for (;;) {
      if (signal?.aborted || this.bindings.get(binding.workerInstanceId) !== binding) return;
      const page = await repository.listUnroutedLiveSourceMessages({ accountId: binding.accountId,
        workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
        ...(afterObservationId === undefined ? {} : { afterObservationId }), limit: 100 });
      if (!page.length) return;
      for (const item of page) {
        afterObservationId = item.observationId;
        if (!item.envelope || item.envelope.accountId !== binding.accountId || item.envelope.ingestion.source !== 'live') continue;
        const currentReceipt = item.receiptMode === 'ACTIVE_CONTROL' && item.receiptControlEpoch === binding.controlEpoch;
        const event: LineWorkerEvent = { type: 'batch', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
          controlEpoch: binding.controlEpoch, batchId: `recovery:${item.observationId}`,
          cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
          cursorAfter: { version: 1, revision: '0', globalRev: '0', individualRev: '0' }, envelopes: [item.envelope] };
        try {
          await this.handleWorkerEventInLane(binding.workerInstanceId, event, { recovered: true,
            receiptCurrent: currentReceipt, sensitive: item.sensitive });
        } catch (error) {
          // Unmatched provenance stays for the next bind to retry; record one failure per pass, not per item.
          if (!replayFailureReported) { replayFailureReported = true; this.reportFailure('recover', error); }
        }
      }
      if (page.length < 100) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  unbind(workerInstanceId: string): void {
    const binding = this.bindings.get(workerInstanceId);
    for (const [requestId, pending] of this.pendingLogouts) if (pending.binding.workerInstanceId === workerInstanceId) {
      clearTimeout(pending.timer);
      this.pendingLogouts.delete(requestId);
      pending.reject(new Error('LINE_LOGOUT_WORKER_STOPPED'));
    }
    if (binding) {
      const qrAttempt = this.qrAttempts.get(binding.accountId);
      if (qrAttempt?.workerInstanceId === workerInstanceId) this.qrAttempts.delete(binding.accountId);
      const pending = this.qrPendingSecrets.get(binding.accountId);
      if (pending?.workerInstanceId === workerInstanceId) this.qrPendingSecrets.delete(binding.accountId);
    }
    this.bindings.delete(workerInstanceId);
    this.attachmentReadiness.delete(workerInstanceId);
    this.transportHealth.delete(workerInstanceId);
    this.catalogHealth.delete(workerInstanceId);
    if (binding) {
      const healthLane = this.connectionHealthWrites.get(binding.accountId);
      if (healthLane && !healthLane.running) this.connectionHealthWrites.delete(binding.accountId);
      else if (healthLane) healthLane.pending = false;
    }
    this.bindingReady.delete(workerInstanceId);
    this.recoveryReady.delete(workerInstanceId);
  }
  isAuthenticatedReady(binding: WorkerBinding): boolean {
    const current = this.bindings.get(binding.workerInstanceId);
    const readiness = this.attachmentReadiness.get(binding.workerInstanceId);
    return !!current && current.accountId === binding.accountId && current.controlEpoch === binding.controlEpoch
      && current.mode !== 'PAUSED' && !!readiness && readiness.accountId === binding.accountId
      && readiness.controlEpoch === binding.controlEpoch && readiness.authenticated && readiness.ready;
  }
  isAttachmentReady(binding: WorkerBinding): boolean {
    const current = this.bindings.get(binding.workerInstanceId);
    const readiness = this.attachmentReadiness.get(binding.workerInstanceId);
    const health = this.transportHealth.get(binding.workerInstanceId);
    return !!current && current.accountId === binding.accountId && current.controlEpoch === binding.controlEpoch
      && current.mode !== 'PAUSED' && !!readiness && readiness.accountId === binding.accountId
      && readiness.controlEpoch === binding.controlEpoch && readiness.authenticated && readiness.protocolVerified
      && health !== 'disconnected' && health !== 'unverified';
  }
  binding(accountId: string): BoundWorker | null {
    return [...this.bindings.values()].find((value) => value.accountId === accountId && value.mode === 'ACTIVE_CONTROL') ?? null;
  }

  async reactToMessage(key: WritableConversationKey, messageId: string, reaction: AgentReaction): Promise<void> {
    if ((await this.accounts.resolveCapabilities?.(key.accountId))?.connectionMode === 'EXTERNAL_MONITOR') return;
    const binding = this.binding(key.accountId);
    if (!binding || binding.mode !== 'ACTIVE_CONTROL') return;
    const workerBinding = pickWorkerBinding(binding);
    await this.worker.send({ type: 'reactMessage', ...workerBinding, ...key, requestId: randomUUID(), messageId, reaction });
  }

  private async drainPendingActions(binding: BoundWorker, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || binding.mode !== 'ACTIVE_CONTROL') return;
    for (const route of await this.messages.listPendingRouteActions(binding.accountId, binding.workerInstanceId)) {
      if (signal?.aborted || this.bindings.get(binding.workerInstanceId) !== binding) return;
      if (!isWritableChatType(route.key.chatType)) continue;
      await this.applyPendingAction(binding, { ...route.key, chatType: route.key.chatType }, route.messageId, signal);
    }
  }

  private async applyPendingAction(binding: BoundWorker, key: WritableConversationKey, messageId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || binding.mode !== 'ACTIVE_CONTROL' || this.bindings.get(binding.workerInstanceId) !== binding) return;
    await this.messages.applyPendingRouteAction(key, messageId, binding.workerInstanceId, async (action) => {
      if (signal?.aborted || this.bindings.get(binding.workerInstanceId) !== binding) return;
      if (action === 'stop') {
        const stopped = await this.agents.stopChat(key) === true;
        await this.sendChatText(binding, key, linePrompt(this.locale, stopped ? 'agentStopped' : 'agentNothingToStop'), messageId);
      } else if (action === 'new') {
        await this.agents.resetChat(key, messageId);
        await this.sendChatText(binding, key, linePrompt(this.locale, 'agentNewStarted'), messageId);
      }
      else {
        const status = await this.agents.getChatStatus?.(key);
        if (signal?.aborted || this.bindings.get(binding.workerInstanceId) !== binding) return;
        const base = status?.runningJobId ? linePrompt(this.locale, 'agentRunning', { code: status.runningJobId })
          : linePrompt(this.locale, 'agentIdle');
        const freeLine = this.freeMode?.statusText(key) ?? null;
        const text = freeLine ? `${base}\n${freeLine}` : base;
        await this.worker.send({ type: 'sendText', ...binding, ...key, requestId: randomUUID(),
          text, replyToMessageId: messageId });
      }
    });
  }

  private async sendChatText(binding: BoundWorker, key: WritableConversationKey, text: string, replyToMessageId: string): Promise<void> {
    await this.worker.send({ type: 'sendText', ...binding, ...key, requestId: randomUUID(), text, replyToMessageId });
  }

  /** Primary Administrator's `/agent claude|codex|default`, or the usage hint for a served non-administrator. */
  private async applyAgentCommand(binding: BoundWorker, key: WritableConversationKey, messageId: string, dispatch: AgentDispatch): Promise<void> {
    const name = (provider: 'claude' | 'codex') => provider === 'codex' ? 'Codex' : 'Claude';
    if (dispatch.type === 'agent_usage') {
      await this.sendChatText(binding, key, linePrompt(this.locale, 'agentSwitchUsage', { name: dispatch.provider }), messageId);
      return;
    }
    if (!await this.settings.setConversationProvider(key, dispatch.provider === 'default' ? null : dispatch.provider)) return;
    const text = dispatch.provider === 'default'
      ? linePrompt(this.locale, 'agentSwitchedDefault', { name: name(await resolveDefaultProvider(this.settings)) })
      : linePrompt(this.locale, 'agentSwitched', { name: name(dispatch.provider) });
    await this.sendChatText(binding, key, text, messageId);
  }

  /** Primary Administrator's `/persona` in a group/room: executes it and answers with the confirmation text. */
  private async applyPersonaCommand(binding: BoundWorker, key: WritableConversationKey, messageId: string, command: PersonaCommand): Promise<void> {
    let text: string;
    try { text = await executePersonaCommand(this.settings, key, command, this.locale); }
    catch (error) { this.reportFailure('execute', error); text = linePrompt(this.locale, 'personaFailed'); }
    await this.sendChatText(binding, key, text, messageId);
  }

  private queueAttachmentDownload(attachmentId: string): void {
    if (!this.attachments) return;
    void Promise.resolve().then(() => this.attachments!.downloadById(attachmentId)).catch(() => undefined);
  }

  async requestQrLogin(accountId: string, workerInstanceId: string, loginAttemptId: string): Promise<void> {
    const binding = this.requireBinding(accountId, workerInstanceId);
    this.qrAttempts.set(accountId, { workerInstanceId, loginAttemptId, kind: 'qr' });
    this.qrPendingSecrets.delete(accountId);
    this.secrets?.beginLogin(accountId, workerInstanceId, loginAttemptId, binding.lineTransport);
    await this.worker.send({ type: 'loginQr', accountId, workerInstanceId, controlEpoch: binding.controlEpoch, loginAttemptId });
  }

  async requestLogout(accountId: string, workerInstanceId: string, timeoutMs = 12_000): Promise<{ ok: boolean; error: string | null }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 11_000 || timeoutMs > 30_000) throw new Error('LINE_LOGOUT_TIMEOUT_INVALID');
    const binding = this.requireBinding(accountId, workerInstanceId);
    const requestId = randomUUID();
    const { accountId: boundAccount, workerInstanceId: boundWorker, controlEpoch, transportOwnerId,
      transportGeneration, writeGrantVersion } = binding;
    const command: LineWorkerCommand = { type: 'logout', requestId, accountId: boundAccount,
      workerInstanceId: boundWorker, controlEpoch, ...(transportOwnerId ? { transportOwnerId } : {}),
      ...(transportGeneration === undefined ? {} : { transportGeneration }),
      ...(writeGrantVersion === undefined ? {} : { writeGrantVersion }) };
    const result = new Promise<{ ok: boolean; error: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLogouts.delete(requestId);
        resolve({ ok: false, error: 'LINE_LOGOUT_FAILED' });
      }, timeoutMs);
      this.pendingLogouts.set(requestId, { binding, resolve, reject, timer });
    });
    try { await this.worker.send(command); }
    catch (error) {
      const pending = this.pendingLogouts.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingLogouts.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error('LINE_LOGOUT_FAILED'));
      }
    }
    return result;
  }

  /** Kind of the pending login attempt ('qr' or 'token'), or null when this worker has no such attempt. */
  loginAttemptKind(accountId: string, workerInstanceId: string, loginAttemptId: string): 'qr' | 'token' | null {
    const attempt = this.qrAttempts.get(accountId);
    return attempt?.workerInstanceId === workerInstanceId && attempt.loginAttemptId === loginAttemptId ? attempt.kind : null;
  }

  async cancelLoginAttempt(accountId: string, workerInstanceId: string, loginAttemptId: string): Promise<void> {
    const attempt = this.qrAttempts.get(accountId);
    if (attempt?.workerInstanceId === workerInstanceId && attempt.loginAttemptId === loginAttemptId) {
      this.qrAttempts.delete(accountId);
      this.qrPendingSecrets.delete(accountId);
    }
    await this.secrets?.closeLogin(accountId, workerInstanceId, loginAttemptId);
  }

  async requestTokenLogin(accountId: string, workerInstanceId: string, loginAttemptId: string): Promise<void> {
    const binding = this.requireBinding(accountId, workerInstanceId);
    // Secrets are stored for each transport. A worker gets only the stored session of its own transport.
    const secrets = await this.secrets?.load(accountId, binding.lineTransport);
    if (!secrets?.token) throw new Error('No saved LINE token for this account');
    this.qrAttempts.set(accountId, { workerInstanceId, loginAttemptId, kind: 'token' });
    this.qrPendingSecrets.delete(accountId);
    this.secrets?.beginLogin(accountId, workerInstanceId, loginAttemptId, binding.lineTransport);
    await this.worker.send({ type: 'setSecretState', accountId, workerInstanceId,
      controlEpoch: binding.controlEpoch, loginAttemptId, secrets });
    await this.worker.send({ type: 'loginToken', accountId, workerInstanceId,
      controlEpoch: binding.controlEpoch, loginAttemptId });
  }

  private requireBinding(accountId: string, workerInstanceId: string): BoundWorker {
    const binding = this.bindings.get(workerInstanceId);
    if (!binding || binding.accountId !== accountId) throw new Error('Unknown worker binding');
    return binding;
  }

  isCurrentWorkerEvent(processInstanceId: string, event: LineWorkerEvent): boolean {
    const binding = this.bindings.get(processInstanceId);
    return !!binding && event.workerInstanceId === processInstanceId && event.accountId === binding.accountId
      && 'controlEpoch' in event && event.controlEpoch === binding.controlEpoch;
  }

  private enqueueComposedConnectionStatus(binding: BoundWorker): void {
    let lane = this.connectionHealthWrites.get(binding.accountId);
    if (!lane) {
      lane = { binding, generation: ++this.connectionHealthGeneration, pending: false, running: false };
      this.connectionHealthWrites.set(binding.accountId, lane);
    }
    lane.binding = binding;
    lane.generation = ++this.connectionHealthGeneration;
    lane.pending = true;
    if (lane.running) return;
    lane.running = true;
    void this.flushComposedConnectionStatus(lane);
  }

  private async flushComposedConnectionStatus(lane: ConnectionHealthLane): Promise<void> {
    try {
      while (lane.pending) {
        lane.pending = false;
        const binding = lane.binding;
        const generation = lane.generation;
        if (this.bindings.get(binding.workerInstanceId) !== binding) continue;
        const transport = this.transportHealth.get(binding.workerInstanceId) ?? 'disconnected';
        const catalog = this.catalogHealth.get(binding.workerInstanceId) ?? 'ready';
        const status = transport === 'degraded' || transport === 'unverified' || catalog === 'degraded' ? 'degraded'
          : transport === 'disconnected' ? 'disconnected' : 'connected';
        let applied: boolean | undefined;
        try { applied = await this.accounts.applyWorkerConnectionStatus(binding, status); }
        catch (error) {
          // A persistence rejection is not evidence that this binding is stale, but the status was not saved.
          this.reportFailure('persist', error);
        }
        if (lane.generation !== generation) continue;
        if (applied === false && this.bindings.get(binding.workerInstanceId) === binding) this.unbind(binding.workerInstanceId);
      }
    } finally {
      lane.running = false;
      if (lane.pending) {
        lane.running = true;
        void this.flushComposedConnectionStatus(lane);
      } else if (this.connectionHealthWrites.get(lane.binding.accountId) === lane) {
        this.connectionHealthWrites.delete(lane.binding.accountId);
      }
    }
  }

  async handleWorkerEvent(processInstanceId: string, event: LineWorkerEvent): Promise<readonly string[] | undefined> {
    if (event.type !== 'batch') return this.handleWorkerEventInLane(processInstanceId, event);
    if (this.ingressClosed) throw new Error('ACCOUNT_INGRESS_CLOSED');
    const lane = this.ingressLanes.get(event.accountId) ?? { tail: Promise.resolve(), count: 0 };
    if (lane.count >= 2) throw new Error('ACCOUNT_INGRESS_CAPACITY');
    this.ingressLanes.set(event.accountId, lane);
    lane.count++;
    const operation = lane.tail.catch(() => undefined).then(() => {
      if (this.ingressClosed) throw new Error('ACCOUNT_INGRESS_CLOSED');
      return this.handleWorkerEventInLane(processInstanceId, event);
    });
    lane.tail = operation;
    try { return await operation; }
    finally {
      lane.count--;
      if (!lane.count && this.ingressLanes.get(event.accountId) === lane) this.ingressLanes.delete(event.accountId);
    }
  }

  async shutdownIngress(): Promise<void> {
    this.ingressClosed = true;
    await Promise.allSettled([...this.ingressLanes.values()].map((lane) => lane.tail));
  }

  private async handleWorkerEventInLane(processInstanceId: string, event: LineWorkerEvent,
    recovered?: { recovered: true; receiptCurrent: boolean; sensitive: boolean }): Promise<readonly string[] | undefined> {
    const binding = this.bindings.get(processInstanceId);
    if (!binding || !this.isCurrentWorkerEvent(processInstanceId, event)) return;
    if (event.type === 'logoutResult') {
      const pending = this.pendingLogouts.get(event.requestId);
      if (!pending || pending.binding.accountId !== event.accountId || pending.binding.workerInstanceId !== event.workerInstanceId
        || pending.binding.controlEpoch !== event.controlEpoch) return;
      clearTimeout(pending.timer);
      this.pendingLogouts.delete(event.requestId);
      pending.resolve({ ok: event.ok, error: event.error });
      return;
    }
    if (event.type === 'syncConfirmed') {
      // Liveness record only. It returns before drainPendingActions so it cannot change traffic timing to LINE.
      try { await this.accounts.applyWorkerSyncConfirmed(binding); }
      catch (error) { this.reportFailure('persist', error); }
      return;
    }
    if ((event.type === 'batch' || event.type === 'historyResult')
      && (await this.accounts.resolveCapabilities?.(event.accountId))?.connectionMode === 'EXTERNAL_MONITOR') return;
    await this.bindingReady.get(processInstanceId);
    if (!this.isCurrentWorkerEvent(processInstanceId, event)) return;
    if (binding.mode === 'ACTIVE_CONTROL' && !recovered) {
      const recovery = this.recoveryReady.get(processInstanceId) ?? this.drainPendingActions(binding);
      this.recoveryReady.set(processInstanceId, recovery);
      try { await recovery; } finally {
        if (this.recoveryReady.get(processInstanceId) === recovery) this.recoveryReady.delete(processInstanceId);
      }
      if (!this.isCurrentWorkerEvent(processInstanceId, event)) return;
    }
    if (event.type === 'login') {
      const account = await this.accounts.getAccount(event.accountId);
      const qrAttempt = this.qrAttempts.get(event.accountId);
      const pending = this.qrPendingSecrets.get(event.accountId);
      let accepted = false;
      if (!account?.ownMid || account.ownMid === event.ownMid) {
        accepted = await this.accounts.applyWorkerLogin(binding, event.ownMid, event.displayName, event.picturePath,
          async () => {
            if (qrAttempt?.workerInstanceId === processInstanceId && qrAttempt.loginAttemptId === event.loginAttemptId
              && pending?.workerInstanceId === processInstanceId && pending.loginAttemptId === event.loginAttemptId) {
              return this.secrets ? await this.secrets.saveRotation(event.accountId, processInstanceId, event.loginAttemptId, pending.secrets) : true;
            }
          }, qrAttempt?.kind === 'qr' && qrAttempt.workerInstanceId === processInstanceId && qrAttempt.loginAttemptId === event.loginAttemptId);
      }
      if (!accepted) {
        this.qrAttempts.delete(event.accountId);
        this.qrPendingSecrets.delete(event.accountId);
        if (qrAttempt?.workerInstanceId === processInstanceId && qrAttempt.loginAttemptId === event.loginAttemptId) {
          await this.secrets?.closeLogin(event.accountId, processInstanceId, event.loginAttemptId);
        }
        this.unbind(processInstanceId);
      } else {
        if (qrAttempt?.workerInstanceId === processInstanceId && qrAttempt.loginAttemptId === event.loginAttemptId) {
          this.qrAttempts.delete(event.accountId);
          this.qrPendingSecrets.delete(event.accountId);
        }
        const readiness = this.attachmentReadiness.get(processInstanceId);
        if (readiness?.accountId === binding.accountId && readiness.controlEpoch === binding.controlEpoch) readiness.authenticated = true;
      }
      return;
    }
    if (event.type === 'authInvalidated') {
      for (const [requestId, pending] of this.pendingLogouts) {
        if (pending.binding.accountId !== event.accountId || pending.binding.workerInstanceId !== event.workerInstanceId
          || pending.binding.controlEpoch !== event.controlEpoch) continue;
        clearTimeout(pending.timer);
        this.pendingLogouts.delete(requestId);
        pending.resolve({ ok: false, error: 'LINE_AUTH_INVALIDATED' });
      }
      const readiness = this.attachmentReadiness.get(processInstanceId);
      if (readiness?.accountId === binding.accountId && readiness.controlEpoch === binding.controlEpoch) {
        readiness.authenticated = false;
        readiness.ready = false;
      }
      this.transportHealth.set(processInstanceId, 'disconnected');
      this.enqueueComposedConnectionStatus(binding);
      return;
    }
    if (event.type === 'loginFailure') {
      const attempt = this.qrAttempts.get(event.accountId);
      if (attempt?.workerInstanceId !== processInstanceId || attempt.loginAttemptId !== event.loginAttemptId) return;
      this.qrAttempts.delete(event.accountId);
      this.qrPendingSecrets.delete(event.accountId);
      await this.secrets?.closeLogin(event.accountId, processInstanceId, event.loginAttemptId);
      this.transportHealth.set(processInstanceId, 'degraded');
      const readiness = this.attachmentReadiness.get(processInstanceId);
      if (readiness?.accountId === binding.accountId && readiness.controlEpoch === binding.controlEpoch) readiness.ready = false;
      this.enqueueComposedConnectionStatus(binding);
      return;
    }
    if (event.type === 'status') {
      const status = event.state === 'ready' ? 'connected' : event.state === 'PROTOCOL_UNVERIFIED' ? 'unverified'
        : event.state === 'degraded' ? 'degraded' : 'disconnected';
      this.transportHealth.set(processInstanceId, status);
      this.enqueueComposedConnectionStatus(binding);
      const readiness = this.attachmentReadiness.get(processInstanceId);
      if (readiness?.accountId === binding.accountId && readiness.controlEpoch === binding.controlEpoch) {
        readiness.ready = event.state === 'ready' && readiness.authenticated;
        if (event.state === 'ready') readiness.protocolVerified = true;
        if (event.state === 'PROTOCOL_UNVERIFIED') readiness.protocolVerified = false;
        if (event.state === 'connecting' || event.state === 'disconnected' || event.state === 'stopped') {
          readiness.authenticated = false;
          readiness.protocolVerified = false;
        }
      }
      return;
    }
    if (event.type === 'catalogRefreshStatus') {
      this.catalogHealth.set(processInstanceId, event.state === 'degraded' ? 'degraded' : 'ready');
      this.enqueueComposedConnectionStatus(binding);
      return;
    }
    if (event.type === 'error') {
      // Operation failures are diagnostic events. The worker's status and
      // login lifecycle events remain authoritative for account readiness.
      return;
    }
    if (event.type === 'secretRotation') {
      const qrAttempt = this.qrAttempts.get(event.accountId);
      if (qrAttempt?.workerInstanceId === event.workerInstanceId && qrAttempt.loginAttemptId === event.loginAttemptId) {
        this.qrPendingSecrets.set(event.accountId, { workerInstanceId: event.workerInstanceId,
          loginAttemptId: event.loginAttemptId, secrets: structuredClone(event.secrets) });
      } else {
        await this.secrets?.saveRotation(event.accountId, event.workerInstanceId, event.loginAttemptId, event.secrets);
      }
      return;
    }
    if (event.type === 'conversationCatalog') {
      await this.messages.upsertConversationCatalog(event.accountId, event.conversations.map((conversation) => {
        const { picturePath, members, ...catalog } = conversation;
        return {
        ...catalog,
        ...(picturePath === undefined ? {} : { picturePath }),
        members: members.map((member) => {
          const { picturePath: memberPicturePath, nickname, ...memberData } = member;
          return { ...memberData, ...(nickname === undefined ? {} : { nickname }),
            ...(memberPicturePath === undefined ? {} : { picturePath: memberPicturePath }) };
        }),
        title: conversation.title ?? '',
      }; }));
      return;
    }
    if (event.type === 'historyResult') {
      const attachmentIds: string[] = [];
      const changedMessageIds: string[] = [];
      for (const envelope of event.envelopes) {
        if (envelope.accountId !== binding.accountId || envelope.chatType !== event.chatType || envelope.chatId !== event.chatId) {
          throw new Error('History envelope source mismatch');
        }
        const historyEnvelope = sanitizeRoomControlEnvelope({ ...envelope, ingestion: { ...envelope.ingestion, source: 'history' as const } });
        const archived = sanitizeInbound(historyEnvelope).envelope;
        const result = await this.messages.ingestAndRoute(archived, { eligible: false });
        if (result.disposition === 'inserted' || result.messageChanged) changedMessageIds.push(archived.messageId);
        if (result.disposition === 'inserted' && this.attachments) {
          for (const descriptor of archived.attachments) {
            const item = await this.messages.getAttachmentBySource(
              { accountId: archived.accountId, chatType: archived.chatType, chatId: archived.chatId },
              archived.messageId, descriptor.id,
            );
            if (item) attachmentIds.push(item.attachmentId);
          }
        }
      }
      for (const attachmentId of attachmentIds) this.queueAttachmentDownload(attachmentId);
      return changedMessageIds;
    }
    if (event.type !== 'batch') return;
    const account = await this.accounts.getAccount(event.accountId);
    const prepared = event.envelopes.map((original) => {
      const ownMid = original.chatType === 'direct' || (original.accountId === binding.accountId && event.accountId === binding.accountId)
        ? account?.ownMid ?? null : null;
      const ingress = sanitizeInbound(sanitizeRoomControlEnvelope(original), account?.ownMid ? { ownMid: account.ownMid } : {});
      return { ...ingress, envelope: ingress.envelope,
        secretCandidate: original.accountId === binding.accountId && event.accountId === binding.accountId
          ? ingress.secretCandidate : null,
        ownMid, control: classifyRoomControl(ingress.envelope, ownMid, binding.accountId),
        ...(recovered ? { sensitive: recovered.sensitive } : {}) };
    });
    const useIndependentIngest = typeof (this.messages as unknown as { ingestBatchSource?: unknown }).ingestBatchSource === 'function';
    if (useIndependentIngest && !recovered) await this.messages.prepareBatchConversations({ ...event, envelopes: prepared.map(({ envelope }) => envelope) });
    const sourceBatch = { ...event, envelopes: prepared.map(({ envelope }) => envelope) };
    const workspacePromise = this.workspaceAuthority.inspect();
    const storagePromise = useIndependentIngest && !recovered
      ? this.messages.ingestBatchSource(sourceBatch, new Set(prepared.filter((item) => item.sensitive).map((item) => item.envelope.messageId)))
      : null;
    const existingRoutesPromise = useIndependentIngest
      ? this.messages.existingLiveRoutes(sourceBatch)
      : Promise.resolve(new Set<string>());
    const ackPromise = storagePromise?.then(() => this.worker.send({ type: 'ackBatch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: event.batchId,
      cursorAfter: event.cursorAfter }));
    if (ackPromise) void ackPromise.catch(() => undefined);
    const administrative = new Set<string>();
    for (const { envelope, secretCandidate, ownMid } of prepared) {
      if (await this.classifyInbound?.(envelope, secretCandidate, ownMid)) administrative.add(envelope.messageId);
    }
    const existingRoutes = await existingRoutesPromise;
    const workspace = await workspacePromise;
    const actions: Array<{ key: WritableConversationKey; decision: TriggerDecision }> = [];
    const decisions: RoutingDecision[] = [];
    const permissionTickets = new Map<object, PermissionTicket>();
    const freeDispatches = new Map<string, FreeDispatch>();
    const agentDispatches = new Map<string, AgentDispatch>();
    const primaryAdminMessageIds = new Set<string>();
    const folderDispatches = new Map<string, FolderCommand>();
    const folderAdminCommandIds = new Set<string>();
    const personaAdminCommandIds = new Set<string>();
    const personaDispatches = new Map<string, PersonaCommand>();
    const primaryAdminLookupFailedIds = new Set<string>();
    for (const { envelope, ownMid, control, sensitive } of prepared) {
      const key: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
      const conversation = await this.settings.getConversationAgent(key);
      const directAdmin = envelope.chatType === 'direct'
        ? await this.admins?.isPrimaryAdministrator(envelope.accountId, envelope.chatId, envelope.senderId) === true
        : false;
      const permissionTicket = this.permissionCommands?.classify(envelope, directAdmin === true) ?? null;
      if (permissionTicket) permissionTickets.set(envelope, permissionTicket);
      const permissionClaimed = permissionTicketClaimed(permissionTicket);
      const shouldCheckGroupAuthorization = envelope.chatType !== 'direct' && control.type === 'none'
        && envelope.ingestion.source === 'live' && envelope.kind === 'text' && envelope.senderId !== ownMid
        && !administrative.has(envelope.messageId) && (hasOwnMention(envelope, ownMid) || isFreeCommandText(envelope, ownMid) || isFolderCommandText(envelope, ownMid) || isPersonaCommandText(envelope, ownMid)
          || (this.freeMode?.isActive(key) === true && isAgentSwitchText(envelope, ownMid)));
      let primaryAdminLookupFailed = false;
      const primaryAdmin = envelope.chatType === 'direct'
        ? directAdmin
        : shouldCheckGroupAuthorization
          ? await this.admins?.isPrimaryUser(envelope.accountId, envelope.senderId).catch(() => {
            primaryAdminLookupFailed = true;
            primaryAdminLookupFailedIds.add(envelope.messageId);
            return false;
          }) === true : false;
      const friendAuthorization = primaryAdmin || primaryAdminLookupFailed ? null
        : envelope.chatType === 'direct' || shouldCheckGroupAuthorization
          ? await this.friendWhitelist?.getActiveAuthorization(envelope.accountId, envelope.senderId,
            envelope.chatType === 'direct' ? { kind: 'ACCOUNT' } : { kind: 'CHAT', chatType: envelope.chatType, chatId: envelope.chatId }) ?? null : null;
      const roomAuthorization = envelope.chatType === 'direct' || !shouldCheckGroupAuthorization || primaryAdmin || primaryAdminLookupFailed
        || friendAuthorization?.scopeKind !== 'ACCOUNT' ? null
        : await this.roomControl?.getActiveAuthorization?.(key) ?? null;
      const roomAgentEnabled = envelope.chatType === 'direct'
        ? conversation?.enabled ?? false
        : primaryAdmin || (shouldCheckGroupAuthorization && friendAuthorization?.scopeKind === 'CHAT')
          || (shouldCheckGroupAuthorization && friendAuthorization?.scopeKind === 'ACCOUNT' && roomAuthorization !== null);
      const senderIsPrimaryAdmin = envelope.chatType === 'direct'
        ? primaryAdmin || friendAuthorization !== null
        : primaryAdmin;
      const routed = permissionClaimed || primaryAdminLookupFailed ? { type: 'ignore' as const } : routeTrigger(envelope, { ownMid,
        agentEnabled: roomAgentEnabled, defaultProvider: await resolveChatProvider(this.settings, conversation?.provider),
        senderIsPrimaryAdmin, primaryAdmin: primaryAdmin === true, senderIsFolderAdmin: primaryAdmin, workspaceConfigured: true, freeModeActive: this.freeMode?.isActive(key) ?? false });
      // Free-mode decisions are applied after ingestion; for storage and admission they are plain ignored messages.
      const freeDispatch: FreeDispatch | null = !this.freeMode ? null : routed.type === 'free' || routed.type === 'free_range' ? { command: routed }
        : routed.type === 'free_message' ? { message: true } : null;
      if (primaryAdmin === true) primaryAdminMessageIds.add(envelope.messageId);
      const agentDispatch = routed.type === 'agent_provider' || routed.type === 'agent_usage' ? routed : null;
      const decision: Exclude<TriggerDecision, FreeCommand | FolderCommand | PersonaCommand | { type: 'free_message' } | AgentDispatch> = routed.type === 'free' || routed.type === 'free_range' || routed.type === 'folder'
        || routed.type === 'persona' || routed.type === 'free_message' || routed.type === 'agent_provider' || routed.type === 'agent_usage' ? { type: 'ignore' } : routed;
      const authorization = !primaryAdmin && friendAuthorization ? {
        directGrantId: friendAuthorization.grantId,
        directGrantVersion: friendAuthorization.version,
        ...(envelope.chatType === 'direct' || !roomAuthorization ? {} : {
          roomGrantId: roomAuthorization.grantId, roomGrantVersion: roomAuthorization.version,
        }),
      } : undefined;
      const routeIsClosed = existingRoutes.has(envelope.messageId) || (recovered && !recovered.receiptCurrent);
      // `/folder` is applied after ingestion like free mode; for storage and admission it is a plain ignored message.
      if (routed.type === 'folder') folderAdminCommandIds.add(envelope.messageId);
      if (routed.type === 'folder' && this.projectFolders && !routeIsClosed && !permissionClaimed && control.type === 'none'
        && !administrative.has(envelope.messageId) && !sensitive) folderDispatches.set(envelope.messageId, routed);
      // `/persona` is applied after ingestion like `/agent`; for storage and admission it is a plain ignored message.
      if (routed.type === 'persona') personaAdminCommandIds.add(envelope.messageId);
      if (routed.type === 'persona' && !routeIsClosed && !permissionClaimed && control.type === 'none'
        && !administrative.has(envelope.messageId) && !sensitive) personaDispatches.set(envelope.messageId, routed);
      actions.push({ key, decision: routeIsClosed ? { type: 'ignore' } : decision });
      if (freeDispatch && !routeIsClosed && !permissionClaimed && control.type === 'none' && !administrative.has(envelope.messageId) && !sensitive) {
        freeDispatches.set(envelope.messageId, freeDispatch);
      }
      if (agentDispatch && !routeIsClosed && !permissionClaimed && control.type === 'none' && !administrative.has(envelope.messageId) && !sensitive) {
        agentDispatches.set(envelope.messageId, agentDispatch);
      }
      const primaryAdminAdmission = envelope.chatType !== 'direct' && primaryAdmin && decision.type !== 'ignore'
        ? { primaryAdminSenderId: envelope.senderId } : {};
      if (existingRoutes.has(envelope.messageId) || (recovered && !recovered.receiptCurrent)
        || permissionClaimed || control.type !== 'none' || administrative.has(envelope.messageId) || sensitive) {
        decisions.push({ eligible: false, action: 'ignore' });
      }
      else if (decision.type !== 'prompt') decisions.push({ eligible: false, action: decision.type, ...primaryAdminAdmission });
      else if (workspace.status === 'available') decisions.push({ eligible: true, provider: decision.provider,
        prompt: decision.prompt, workspacePath: workspace.path, ...(authorization ? { authorization } : {}),
        ...primaryAdminAdmission });
      else decisions.push({ eligible: false, ...(authorization ? { authorization } : {}),
        workspaceFailure: { provider: decision.provider, prompt: decision.prompt,
          workspacePath: workspace.configuredPath, code: 'INVALID_WORKSPACE', reason: workspace.reason },
        ...primaryAdminAdmission });
    }
    const admissionPromise = useIndependentIngest
      ? this.messages.admitLiveBatch(sourceBatch, decisions)
      : null;
    if (admissionPromise) void admissionPromise.catch(() => undefined);
    // Auto-replies are an independent automation branch. Start the bounded effect
    // from the inbound routing decision, without waiting for canonical storage.
    if (useIndependentIngest && this.roomControl?.respond) {
      for (const [index, { envelope, ownMid, control, sensitive }] of prepared.entries()) {
        const decision = decisions[index]!;
        const promptAdmitted = decision.eligible || 'workspaceFailure' in decision;
        const primaryAdminAction = Boolean('action' in decision && decision.action !== 'ignore'
          && 'primaryAdminSenderId' in decision && decision.primaryAdminSenderId);
        if (envelope.ingestion.source !== 'live' || control.type !== 'none'
          || (recovered && !recovered.receiptCurrent) || existingRoutes.has(envelope.messageId)
          || administrative.has(envelope.messageId) || sensitive || primaryAdminAction || promptAdmitted
          || primaryAdminLookupFailedIds.has(envelope.messageId) || agentDispatches.has(envelope.messageId)
          || (isFreeCommandText(envelope, ownMid) && primaryAdminMessageIds.has(envelope.messageId))
          || folderAdminCommandIds.has(envelope.messageId) || personaAdminCommandIds.has(envelope.messageId)) continue;
        const body = ownMentionBody(envelope, ownMid);
        if (body !== null) this.scheduleRoomEffect(async () => {
          const key: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
          if (!await this.roomControl?.isEnabled?.(key)) await this.roomControl?.respond?.(envelope, body);
        });
      }
    }
    type StoredBatch = Awaited<ReturnType<MessageRepository['ingestBatchSource']>>;
    type AdmittedBatch = Awaited<ReturnType<MessageRepository['admitLiveBatch']>>;
    let result: StoredBatch & Partial<Pick<AdmittedBatch, 'jobIds' | 'jobMessageIds' | 'jobStatuses'
      | 'primaryAdminActionMessageIds' | 'routeDecisions'>>;
    let admissionResult: Awaited<ReturnType<MessageRepository['admitLiveBatch']>> | null = null;
    if (useIndependentIngest && recovered) {
      const admittedBatch: AdmittedBatch = await admissionPromise!.catch((error: unknown) => {
        this.reportFailure('admission', error);
        return { jobIds: [], jobMessageIds: [], jobStatuses: [], primaryAdminActionMessageIds: [], routeDecisions: decisions };
      });
      try { await this.messages.recordBatchRoutes(sourceBatch, admittedBatch.routeDecisions,
        new Set(admittedBatch.jobStatuses.map((status) => status.sourceMessageId))); } catch (error) { this.reportFailure('persist', error); }
      admissionResult = admittedBatch;
      result = { inserted: 0, duplicate: 0, insertedMessageIds: [], changedMessageIds: [],
        readPositionsChanged: 0, readPositionChanges: [], ...admittedBatch };
    } else if (useIndependentIngest) {
      try { result = await storagePromise!; }
      catch (error) { await admissionPromise?.catch(() => undefined); throw error; }
      await ackPromise;
      const committedAdmission: AdmittedBatch = await admissionPromise!.then((value) => value,
        (error: unknown) => { this.reportFailure('admission', error); return { jobIds: [], jobMessageIds: [], jobStatuses: [], primaryAdminActionMessageIds: [], routeDecisions: decisions }; });
      admissionResult = committedAdmission;
      try {
        await this.messages.recordBatchRoutes(sourceBatch, committedAdmission.routeDecisions,
          new Set(committedAdmission.jobStatuses.map((status) => status.sourceMessageId)));
      } catch (error) {
        // Route projection is best effort; source provenance remains available for replay.
        this.reportFailure('persist', error);
      }
      result = { ...result, ...committedAdmission };
    } else {
      result = await this.messages.ingestBatchAndRoute(sourceBatch, decisions);
      this.publishCommittedJobStatuses?.(result.jobStatuses);
    }
    if (admissionResult) this.publishCommittedJobStatuses?.(admissionResult.jobStatuses);
    // One refresh per affected conversation (deduplicated by the repository); a publish failure never blocks ingest or ACK.
    if (result.readPositionsChanged > 0 && result.readPositionChanges?.length) {
      try { this.publishReadPositionChanges?.(result.readPositionChanges); } catch { /* UI refresh is best effort */ }
    }
    const inserted = new Set(result.insertedMessageIds);
    const primaryAdminActions = new Set(result.primaryAdminActionMessageIds ?? []);
    const committedAgentActions = new Set(result.jobStatuses?.map((status) => status.sourceMessageId) ?? []);
    const consumed = new Set<string>();
    const admitted = prepared.filter(({ envelope }) => {
      if (!inserted.has(envelope.messageId) || consumed.has(envelope.messageId)) return false;
      consumed.add(envelope.messageId);
      return envelope.accountId === binding.accountId && envelope.ingestion.source === 'live';
    });
    for (const { envelope, secretCandidate, ownMid } of admitted) {
      if (!this.isCurrentWorkerEvent(processInstanceId, event)) break;
      if (primaryAdminLookupFailedIds.has(envelope.messageId)) continue;
      if (await this.onInboundEnvelope?.(envelope, secretCandidate, ownMid, binding)) administrative.add(envelope.messageId);
    }
    const queued = new Set(result.jobMessageIds);
    const attachmentIds: string[] = [];
    if (this.attachments) {
      for (const envelope of prepared.map(({ envelope }) => envelope).filter((envelope) => inserted.has(envelope.messageId))) {
        for (const descriptor of envelope.attachments) {
          const attachment = await this.messages.getAttachmentBySource(
            { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId },
            envelope.messageId, descriptor.id,
          );
          if (attachment) attachmentIds.push(attachment.attachmentId);
        }
      }
    }
    for (const [index, action] of actions.entries()) {
      const envelope = prepared[index]!.envelope;
      if (queued.has(envelope.messageId)) this.agents.kick(action.key);
      await this.applyPendingAction(binding, action.key, envelope.messageId);
    }
    if (!useIndependentIngest) {
      // Keep the legacy path for narrow service test doubles; production ACK is issued from storagePromise above.
      await this.worker.send({ type: 'ackBatch', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, batchId: event.batchId, cursorAfter: event.cursorAfter });
    }
    // Only admitted (newly inserted) messages advance the /權限 dialogue, in batch order; duplicates and
    // failed ingestion never reach enqueue(), so a replay leaves the pending state untouched. enqueue() is
    // synchronous and bounded; replies go through the shared transport and never hold ingest or ack.
    for (const { envelope } of admitted) {
      const ticket = permissionTickets.get(envelope);
      if (ticket && this.bindings.get(binding.workerInstanceId) === binding) this.permissionCommands?.enqueue(envelope, ticket);
    }
    for (const { envelope } of admitted) {
      const dispatch = freeDispatches.get(envelope.messageId);
      if (!dispatch || !this.freeMode || primaryAdminLookupFailedIds.has(envelope.messageId)
        || this.bindings.get(binding.workerInstanceId) !== binding) continue;
      const freeKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId } as WritableConversationKey & { chatType: 'group' | 'room' };
      if ('command' in dispatch) this.scheduleRoomEffect(() => this.freeMode?.handleCommand(freeKey, envelope.senderId, dispatch.command, envelope.messageId));
      else this.freeMode.addMessage(envelope);
    }
    for (const { envelope } of admitted) {
      const folder = folderDispatches.get(envelope.messageId);
      if (!folder || !this.projectFolders || primaryAdminLookupFailedIds.has(envelope.messageId)
        || this.bindings.get(binding.workerInstanceId) !== binding) continue;
      const folderKey: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
      this.scheduleRoomEffect(() => this.projectFolders?.handleCommand(folderKey, envelope.senderId, folder));
    }
    for (const { envelope } of admitted) {
      const persona = personaDispatches.get(envelope.messageId);
      if (!persona || primaryAdminLookupFailedIds.has(envelope.messageId) || this.bindings.get(binding.workerInstanceId) !== binding) continue;
      const personaKey: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
      this.scheduleRoomEffect(() => this.applyPersonaCommand(binding, personaKey, envelope.messageId, persona));
    }
    for (const { envelope } of admitted) {
      const dispatch = agentDispatches.get(envelope.messageId);
      if (!dispatch || primaryAdminLookupFailedIds.has(envelope.messageId) || this.bindings.get(binding.workerInstanceId) !== binding) continue;
      const agentKey: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
      this.scheduleRoomEffect(() => this.applyAgentCommand(binding, agentKey, envelope.messageId, dispatch));
    }
    for (const attachmentId of attachmentIds) this.queueAttachmentDownload(attachmentId);
    for (const { control, envelope, ownMid } of admitted) {
      if (primaryAdminLookupFailedIds.has(envelope.messageId)) continue;
      if (control.type === 'command') {
        this.scheduleRoomEffect(() => this.roomControl?.handle(control.command));
      } else if (!useIndependentIngest && control.type === 'none' && !administrative.has(envelope.messageId)
        && !primaryAdminActions.has(envelope.messageId) && !committedAgentActions.has(envelope.messageId)
        && !agentDispatches.has(envelope.messageId) && !(isFreeCommandText(envelope, ownMid) && primaryAdminMessageIds.has(envelope.messageId))
        && !folderAdminCommandIds.has(envelope.messageId) && !personaAdminCommandIds.has(envelope.messageId) && this.roomControl?.respond) {
        const body = ownMentionBody(envelope, ownMid);
        if (body !== null) this.scheduleRoomEffect(async () => {
          const key: WritableConversationKey = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
          if (!await this.roomControl?.isEnabled?.(key)) await this.roomControl?.respond?.(envelope, body);
        });
      }
    }
    return [...new Set([...result.insertedMessageIds, ...(result.changedMessageIds ?? [])])];
  }

  async idleRoomEffects(): Promise<void> {
    while (this.roomEffects.size) await Promise.allSettled([...this.roomEffects]);
  }

  private scheduleRoomEffect(work: (() => Promise<void> | undefined) | undefined): void {
    if (!work || this.roomEffects.size >= 64) return;
    let operation: Promise<void>;
    try { operation = Promise.resolve(work()).then(() => undefined); }
    catch (error) { this.reportFailure('execute', error); return; }
    this.roomEffects.add(operation);
    void operation.finally(() => this.roomEffects.delete(operation)).catch((error: unknown) => this.reportFailure('execute', error));
  }
}

interface SupervisedWorker {
  send(command: LineWorkerCommand): Promise<void>;
  waitModeAck(mode: AccountMode, timeoutMs: number): Promise<boolean>;
  killAndWait(): Promise<void>;
}

interface WorkerFactory {
  spawn(accountId: string, workerInstanceId: string, controlEpoch: number, mode: AccountMode): Promise<SupervisedWorker>;
}

/** Serializes account authority changes and treats DB epoch as the only durable grant. */
export class AccountSupervisor {
  private active: { binding: BoundWorker; worker: SupervisedWorker } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly accounts: AccountRepository, private readonly factory: WorkerFactory,
    private readonly acknowledgementTimeoutMs = 3000,
    private readonly onPhase?: (phase: 'idle' | 'revoking' | 'granting' | 'failed', targetAccountId: string | null) => void,
    private readonly cancelAgentJob?: (jobId: string) => Promise<void>,
    private readonly onJobStatus?: (projection: AgentJobStatusProjection) => void,
    /** First ack after a fresh spawn also covers child boot + init; draining a running worker keeps acknowledgementTimeoutMs. */
    private readonly bootAcknowledgementTimeoutMs = acknowledgementTimeoutMs) {}

  async revokeControlAndCancel(expectedEpoch: number) {
    const revoked = await this.accounts.revokeControl(expectedEpoch);
    const cancellations = revoked.inFlightJobIds.map((jobId) => {
      try { return Promise.resolve(this.cancelAgentJob?.(jobId)); }
      catch (error) { return Promise.reject(error); }
    });
    for (const projection of revoked.cancelledJobs ?? []) this.onJobStatus?.(projection);
    const results = await Promise.allSettled(cancellations);
    const failed = results.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed) throw failed.reason;
    return revoked;
  }

  binding(accountId: string): BoundWorker | null {
    return this.active?.binding.accountId === accountId ? this.active.binding : null;
  }

  isCurrent(binding: WorkerBinding): boolean {
    const current = this.active?.binding;
    return current?.accountId === binding.accountId && current.workerInstanceId === binding.workerInstanceId
      && current.controlEpoch === binding.controlEpoch;
  }

  runLifecycle<T>(operation: () => Promise<T>): Promise<T>;
  runLifecycle<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | undefined>;
  runLifecycle<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!signal) {
      const result = this.tail.then(operation);
      this.tail = result.catch(() => undefined);
      return result;
    }
    if (signal.aborted) return Promise.resolve(undefined as T);

    let started = false;
    let cancelBeforeStart!: () => void;
    const cancelled = new Promise<T>((resolve) => { cancelBeforeStart = () => resolve(undefined as T); });
    const onAbort = () => {
      if (!started) cancelBeforeStart();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const scheduled = this.tail.then(() => {
      if (signal.aborted) return undefined as T;
      started = true;
      signal.removeEventListener('abort', onAbort);
      return operation();
    });
    this.tail = scheduled.catch(() => undefined);
    return Promise.race([scheduled, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
  }

  retireWithinLifecycle(binding: WorkerBinding): boolean {
    if (!this.isCurrent(binding)) return false;
    this.active = null;
    return true;
  }

  retire(binding: WorkerBinding): Promise<boolean> {
    return this.runLifecycle(async () => this.retireWithinLifecycle(binding));
  }

  adopt(binding: BoundWorker, worker: SupervisedWorker, acknowledged = false): Promise<boolean> {
    return this.runLifecycle(async () => this.adoptWithinLifecycle(binding, worker, acknowledged));
  }

  async adoptWithinLifecycle(binding: BoundWorker, worker: SupervisedWorker, acknowledged = false): Promise<boolean> {
    const state = await this.accounts.getControlState();
    if (binding.mode !== 'ACTIVE_CONTROL' || state.activeAccountId !== binding.accountId
      || state.controlEpoch !== binding.controlEpoch
      || !await this.accounts.isCurrentActiveWorkerBinding(binding)) return false;
    this.active = { binding, worker };
    try {
      if (acknowledged || await this.waitBounded(worker.waitModeAck('ACTIVE_CONTROL', this.bootAcknowledgementTimeoutMs), this.bootAcknowledgementTimeoutMs)) return true;
      throw Object.assign(new Error('Restored active worker did not acknowledge control'), { name: 'TimeoutError' });
    } catch (error) {
      try { await worker.killAndWait(); }
      catch (stopError) { throw stopError; }
      this.active = null;
      await this.revokeControlAndCancel(binding.controlEpoch);
      throw error;
    }
  }

  switchTo(accountId: string): Promise<BoundWorker> {
    return this.runLifecycle(() => this.switchWithinLifecycle(accountId));
  }

  async switchWithinLifecycle(accountId: string): Promise<BoundWorker> {
    this.onPhase?.('revoking', accountId);
    try {
      const binding = await this.performSwitch(accountId);
      this.onPhase?.('idle', null);
      return binding;
    } catch (error) {
      this.onPhase?.('failed', accountId);
      throw error;
    }
  }

  private async performSwitch(accountId: string): Promise<BoundWorker> {
    const state = await this.accounts.getControlState();
    if (state.activeAccountId === accountId && this.active?.binding.accountId === accountId
      && this.active.binding.controlEpoch === state.controlEpoch) return this.active.binding;
    let revokedWorker: { binding: BoundWorker; worker: SupervisedWorker } | null = null;
    let revokedWorkerKilled = false;
    if (state.activeAccountId) {
      if (this.active && this.active.binding.accountId === state.activeAccountId
        && this.active.binding.controlEpoch === state.controlEpoch) {
        const { binding, worker } = this.active;
        revokedWorker = { binding, worker };
        let drained = false;
        try {
          drained = await this.waitBounded((async () => {
            await worker.send({ type: 'revokeControl', accountId: binding.accountId,
              workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
            return worker.waitModeAck('MONITOR_ONLY', this.acknowledgementTimeoutMs);
          })());
        } catch { drained = false; }
        if (!drained) {
          await worker.killAndWait();
          revokedWorkerKilled = true;
        }
      }
      this.active = null;
      const revoked = await this.revokeControlAndCancel(state.controlEpoch);
      if (!revoked.revoked) throw new Error('Account control changed while switching');
      if (revokedWorkerKilled && revokedWorker) {
        const monitorBinding: BoundWorker = { accountId: revokedWorker.binding.accountId,
          workerInstanceId: randomUUID(), controlEpoch: revoked.controlEpoch, mode: 'MONITOR_ONLY' };
        const monitor = await this.factory.spawn(monitorBinding.accountId, monitorBinding.workerInstanceId,
          monitorBinding.controlEpoch, monitorBinding.mode);
        try {
          if (!await this.waitBounded(monitor.waitModeAck('MONITOR_ONLY', this.bootAcknowledgementTimeoutMs), this.bootAcknowledgementTimeoutMs)) {
            throw new Error('Replacement monitor worker did not acknowledge monitoring');
          }
        } catch (error) {
          await monitor.killAndWait();
          throw error;
        }
      }
    }
    const vacant = await this.accounts.getControlState();
    this.onPhase?.('granting', accountId);
    const grant = await this.accounts.activateControl(accountId, vacant.controlEpoch);
    if (!grant.activated) throw new Error('Unable to activate requested account');
    const binding: BoundWorker = { accountId, workerInstanceId: randomUUID(),
      controlEpoch: grant.controlEpoch, mode: 'ACTIVE_CONTROL' };
    let worker: SupervisedWorker | undefined;
    try {
      worker = await this.factory.spawn(accountId, binding.workerInstanceId, binding.controlEpoch, binding.mode);
      if (!await this.waitBounded(worker.waitModeAck('ACTIVE_CONTROL', this.bootAcknowledgementTimeoutMs), this.bootAcknowledgementTimeoutMs)) {
        throw new Error('New worker did not acknowledge control grant');
      }
      this.active = { binding, worker };
      return binding;
    } catch (error) {
      await worker?.killAndWait();
      await this.revokeControlAndCancel(binding.controlEpoch);
      throw error;
    }
  }

  private async waitBounded(ack: Promise<boolean>, timeoutMs = this.acknowledgementTimeoutMs): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([ack, new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
