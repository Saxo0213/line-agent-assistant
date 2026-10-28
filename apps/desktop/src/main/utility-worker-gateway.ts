import { randomUUID } from 'node:crypto';
import { diagnosticFailure, type IngestLatency, type SafeDiagnostic } from '@line-agent/contracts';
import { isLocalAgentRoom, LineWorkerCommandSchema, LineWorkerEventSchema, WORKER_PROTOCOL_VERSION, type ComponentHealth, type LineWorkerCommand, type LineWorkerEvent, type TalkCursorV1Dto, type WorkerBinding } from '@line-agent/contracts';
import type { IntegratedWorkerGateway, SendMediaRequest } from './connected-facade.js';
import { ManualSendNotStartedError } from './services/manual-send-errors.js';

type Bound = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; purpose?: 'DOWNLOAD_ONLY'; expectedMid?: string; application?: string };
type AccountAuthority = Readonly<{ intentGeneration: number; controlEpoch: number; mode: Bound['mode'];
  readGrantVersion: number; writeGrantVersion: number; downloadGrantVersion: number }>;
type Child = { postMessage(value: unknown): void; kill(): void; on(event: 'message' | 'exit', listener: (value?: unknown) => void): void;
  listenerCount?(event: 'message' | 'exit'): number };
type Pending<T> = { resolve(value: T): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; cleanup?: () => void;
  command?: unknown; started?: boolean;
  cancelling?: boolean; value?: T; attachmentId?: string; cancelReason?: string; done?: Promise<void>; finishDone?(): void };
export type ChatResourceGatewayDiagnostic = { stage: 'gateway_admission' | 'pending_request' | 'worker_response';
  reason: 'missing_worker' | 'not_ready_worker' | 'stale_binding' | 'pending_stopped' | 'worker_response_error' | 'unknown';
  currentBindingMatch?: boolean; currentEpochMatch?: boolean; workerReady?: boolean };
export class ChatResourceGatewayError extends Error {
  constructor(message: string, readonly diagnostic: ChatResourceGatewayDiagnostic) { super(message); this.name = 'ChatResourceGatewayError'; }
}
function chatResourceGatewayError(message: string, stage: ChatResourceGatewayDiagnostic['stage'], reason: ChatResourceGatewayDiagnostic['reason'],
  currentBindingMatch?: boolean, currentEpochMatch?: boolean, workerReady?: boolean): ChatResourceGatewayError {
  return new ChatResourceGatewayError(message, { stage, reason,
    ...(currentBindingMatch !== undefined ? { currentBindingMatch } : {}),
    ...(currentEpochMatch !== undefined ? { currentEpochMatch } : {}),
    ...(workerReady !== undefined ? { workerReady } : {}) });
}
type State = { binding: Bound; child: Child; poll: ReturnType<typeof setInterval> | undefined; stopping: boolean;
  generation: number; bindingComplete: boolean;
  bindingCompletePromise: Promise<void>; resolveBindingComplete(): void;
  exitConfirmed: boolean;
  modeRevision: number;
  modeTask: { mode: Bound['mode']; revision: number; controller: AbortController; task: Promise<void> } | undefined;
  restartTask: { mode: Bound['mode']; revision: number; controller: AbortController; task: Promise<void> } | undefined;
  acknowledgedMode: Bound['mode'] | null; modeAckReady: boolean; bindingReady: boolean;
  domainEvents: LineWorkerEvent[]; processingDomainEvents: boolean;
  /** Live batches this binding is ingesting or has just acked; a worker re-emission of the same batchId is dropped. */
  batches: Map<string, BatchTrack>;
  catalogEvents: Map<'conversationCatalog' | 'catalogRefreshStatus', Extract<LineWorkerEvent, { type: 'conversationCatalog' | 'catalogRefreshStatus' }>>;
  processingCatalogEvents: boolean; retired: boolean;
  protocolVerified: boolean; protocolTimer: ReturnType<typeof setTimeout>;
  downloadReady: boolean;
  downloadAuthRequests: Map<string, Pending<Extract<LineWorkerEvent, { type: 'downloadAuthResult' }>>>;
  sends: Map<string, Pending<Extract<LineWorkerEvent, { type: 'sendResult' }>>>;
  unsends: Map<string, Pending<Extract<LineWorkerEvent, { type: 'unsendResult' }>>>;
  sendQueue: string[]; activeSendId: string | undefined;
  uncertainSends: Map<string, { operationId: string; attemptId: string; writeGrantVersion: number }>;
  downloads: Map<string, Pending<Extract<LineWorkerEvent, { type: 'attachmentResult' }>>>;
  relations: Map<string, Pending<Extract<LineWorkerEvent, { type: 'friendRelationResult' | 'addFriendResult' }>>>;
  chatResources: Map<string, Pending<Extract<LineWorkerEvent, { type: 'chatResourceResult' }>>>;
  ownProfiles: Map<string, Pending<Extract<LineWorkerEvent, { type: 'ownProfileResult' }>>>;
  usedRelationRequests: Map<string, { type: 'check' | 'add'; targetMid: string }>;
  modeWaiters: Map<string, Set<(value: boolean) => void>>;
  rawModeWaiters: Map<string, Set<(value: boolean) => void>>; exited: Promise<void>; resolveExited(): void };
type BatchTrack = { recvAt: number; queueLength: number; minOccurredAt: number | undefined; messageCount: number;
  reemitCount: number; ackedAt: number | undefined };
/** A live batch that was stored late; timings are spans in ms and carry no message content. */
export type IngestLatencyReport = { accountId: string; workerInstanceId: string; kind: 'upstream' | 'main'; latency: IngestLatency };
export const INGEST_SLOW_TOTAL_MS = 10_000;
export const INGEST_SLOW_MAIN_MS = 2_000;
/** Older than this at receive means a catch-up batch (restart/reconnect), never a slow LINE upstream. */
export const INGEST_BACKLOG_MS = 300_000;
const BATCH_TRACK_ACKED_TTL_MS = 30_000;
const BATCH_TRACK_LIMIT = 256;
type Intent = { generation: number; binding: Bound };
type ManualSendCommand = Extract<LineWorkerCommand, { type: 'sendText' | 'manualSendText' | 'sendMedia' }>;
export const SEND_GAP_MIN_MS = 1_000;
export const SEND_GAP_MAX_MS = 3_000;
export const SEND_GAP_PER_CHAR_MS = 20;
export const SEND_GAP_LENGTH_CAP_MS = 7_000;
export const MEDIA_SEND_TIMEOUT_MS = 120_000;
const MAX_MEDIA_WAITERS = 32;
type ExternalTaskKind = 'cursor' | 'binding' | 'mode' | 'restart';
type AccountRuntime = { generation: number; transportGeneration: number; authority: AccountAuthority | undefined;
  phase: 'stopped' | 'launching' | 'running' | 'retiring' | 'restarting' | 'quarantined' | 'failed';
  intent: Intent | undefined; child: State | undefined; restart: { generation: number; sourceBinding: Bound; timer: ReturnType<typeof setTimeout> } | undefined;
  launch: { owner: symbol; generation: number; binding: Bound; sourceBinding: Bound | undefined; controller: AbortController;
    cancel(reason: string): void; task: Promise<Bound> } | undefined;
  external: { owner: symbol; controller: AbortController; kind: ExternalTaskKind } | undefined;
  cleanup: { owner: symbol; child: State; task: Promise<void>; settled: boolean } | undefined;
  quarantine: { owner: symbol; kind: ExternalTaskKind; task: Promise<unknown> } | undefined;
  restartCount: number; lastError: string | undefined };

export const MAX_UTILITY_WORKERS = 4;

export function createUtilityWorkerGateway(options: { spawn(binding: Bound): Child;
  onDiagnostic?: (diagnostic: SafeDiagnostic, accountId?: string) => void;
  /** Called only for slow live batches (stored > 10 s after LINE's occurredAt, or > 2 s after Main received it). */
  onIngestLatency?: (report: IngestLatencyReport) => void;
  durableCursor?(accountId: string, signal: AbortSignal): Promise<TalkCursorV1Dto | null>;
  pollIntervalMs?: number; responseTimeoutMs?: number; restartDelayMs?: number; maxRestarts?: number; stopTimeoutMs?: number;
  lifecycleTimeoutMs?: number; maxWorkers?: number; maxSendsGlobal?: number;
  /** Deterministic pacing hooks for tests: random in [0,1), clock in ms, cancellable timer. */
  random?: () => number; now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }): IntegratedWorkerGateway {
  const runtimes = new Map<string, AccountRuntime>();
  const maxWorkers = Math.max(1, Math.min(MAX_UTILITY_WORKERS, Math.floor(options.maxWorkers ?? MAX_UTILITY_WORKERS)));
  const launchReservations = new Set<string>();
  const occupiedAccounts = () => new Set([...runtimes.entries()]
    .filter(([, lifecycle]) => !!lifecycle.child || !!lifecycle.launch || !!lifecycle.restart || !!lifecycle.cleanup)
    .map(([accountId]) => accountId).concat([...launchReservations]));
  const lifecycleFor = (accountId: string): AccountRuntime => {
    const existing = runtimes.get(accountId);
    if (existing) return existing;
    const lifecycle: AccountRuntime = { generation: 0, transportGeneration: 0, authority: undefined, phase: 'stopped', restartCount: 0, intent: undefined, child: undefined,
      restart: undefined, launch: undefined, external: undefined, cleanup: undefined, quarantine: undefined, lastError: undefined };
    runtimes.set(accountId, lifecycle);
    return lifecycle;
  };
  const stateFor = (accountId: string): State | undefined => runtimes.get(accountId)?.child;
  const ownsIntent = (lifecycle: AccountRuntime, intent: Intent) => lifecycle.intent === intent && lifecycle.generation === intent.generation;
  let listener: ((workerInstanceId: string, event: LineWorkerEvent) => Promise<void>) | undefined;
  let workerExitListener: ((binding: WorkerBinding) => void) | undefined;
  let bindingListener: ((binding: Bound, signal: AbortSignal) => Promise<void> | void) | undefined;
  let restartBindingListener: ((binding: Bound, signal: AbortSignal) => Promise<void> | void) | undefined;
  let modeListener: ((binding: Bound, signal: AbortSignal) => Promise<void> | void) | undefined;
  const responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
  const lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? options.stopTimeoutMs ?? 5_000;
  const maxQueuedDomainEvents = 256;
  const maxSendsPerAccount = 64;
  const maxSendsGlobal = Math.max(1, Math.min(256, Math.floor(options.maxSendsGlobal ?? 256)));
  const maxUsedRelationRequests = 1024;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  // Per-account send pacing: one record per account with sends, deleted once its gap has elapsed or on stop.
  const pacing = new Map<string, { endedAt: number; gapMs: number; timer?: unknown }>();
  /** Longer text waits longer: 20 ms per character, capped; media adds nothing. */
  const lengthGapMs = (command: ManualSendCommand) => command.type === 'sendMedia' ? 0
    : Math.min(SEND_GAP_LENGTH_CAP_MS, SEND_GAP_PER_CHAR_MS * Array.from(command.text).length);
  const cancelPacing = (accountId: string) => {
    const pace = pacing.get(accountId);
    if (pace?.timer !== undefined) clearTimer(pace.timer);
    pacing.delete(accountId);
  };
  const mediaWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  let mediaActive = false;
  let closing = false;
  let shutdownTask: Promise<void> | undefined;
  const unknownSend = (state: State, command: ManualSendCommand): Extract<LineWorkerEvent, { type: 'sendResult' }> => ({
    type: 'sendResult', accountId: state.binding.accountId, workerInstanceId: state.binding.workerInstanceId,
    controlEpoch: state.binding.controlEpoch, transportOwnerId: state.binding.transportOwnerId,
    transportGeneration: state.binding.transportGeneration, writeGrantVersion: state.binding.writeGrantVersion,
    requestId: command.requestId, operationId: command.operationId, attemptId: command.attemptId,
    status: 'unknown', messageId: null,
    error: 'TRANSPORT_OUTCOME_UNKNOWN',
  });
  const clearPending = (state: State, reason: string) => {
    clearTimeout(state.protocolTimer);
    for (const [requestId, pending] of state.sends) {
      pending.cleanup?.(); if (pending.timer) clearTimeout(pending.timer);
      if (pending.started && (reason === 'Worker exited' || reason === 'Worker stopped')) {
        pending.resolve(unknownSend(state, pending.command as ManualSendCommand));
      }
      else pending.reject(new Error(reason));
    }
    for (const [requestId, pending] of state.unsends) {
      if (pending.timer) clearTimeout(pending.timer);
      const command = pending.command as Extract<LineWorkerCommand, { type: 'unsendMessage' }>;
      if (pending.started && (reason === 'Worker exited' || reason === 'Worker stopped')) pending.resolve({
        ...workerBindingFields(state.binding), type: 'unsendResult', chatType: command.chatType, chatId: command.chatId,
        requestId, messageId: command.messageId, status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      else pending.reject(new Error(reason));
    }
    state.unsends.clear();
    for (const pending of state.downloads.values()) { pending.cleanup?.(); clearTimeout(pending.timer); pending.reject(new Error(reason)); pending.finishDone?.(); }
    for (const pending of state.chatResources.values()) { pending.cleanup?.(); if (pending.timer) clearTimeout(pending.timer);
      pending.reject(chatResourceGatewayError(reason, 'pending_request', 'pending_stopped')); }
    for (const pending of state.ownProfiles.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    for (const pending of state.downloadAuthRequests.values()) { pending.cleanup?.(); if (pending.timer) clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    for (const pending of state.relations.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      const command = pending.command as Extract<LineWorkerCommand, { type: 'addFriendByMid' }> | undefined;
      if (pending.started && command?.type === 'addFriendByMid' && (reason === 'Worker exited' || reason === 'Worker stopped')) {
        pending.resolve({ accountId: state.binding.accountId, workerInstanceId: state.binding.workerInstanceId,
          controlEpoch: state.binding.controlEpoch, transportOwnerId: state.binding.transportOwnerId,
          transportGeneration: state.binding.transportGeneration, writeGrantVersion: state.binding.writeGrantVersion,
          type: 'addFriendResult', requestId: command.requestId,
          targetMid: command.targetMid, status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      } else pending.reject(new Error(reason));
    }
    state.sends.clear(); state.sendQueue.length = 0; state.activeSendId = undefined;
    cancelPacing(state.binding.accountId);
    state.uncertainSends.clear(); state.downloads.clear(); state.chatResources.clear(); state.ownProfiles.clear(); state.downloadAuthRequests.clear(); state.downloadReady = false; state.relations.clear();
    for (const waiters of state.modeWaiters.values()) for (const resolve of waiters) resolve(false);
    state.modeWaiters.clear();
    for (const waiters of state.rawModeWaiters.values()) for (const resolve of waiters) resolve(false);
    state.rawModeWaiters.clear();
  };
  const runBounded = async <T>(lifecycle: AccountRuntime, owner: symbol, kind: ExternalTaskKind,
    controller: AbortController, operation: (signal: AbortSignal) => Promise<T> | T): Promise<T> => {
    const signal = controller.signal;
    if (lifecycle.quarantine) throw new Error('Worker lifecycle quarantined');
    let settled = false;
    const task = Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('Worker lifecycle cancelled');
      return operation(signal);
    });
    lifecycle.external = { owner, controller, kind };
    void task.then(() => { settled = true; }, () => { settled = true; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Worker lifecycle cancelled'));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('Worker lifecycle deadline exceeded')); }, lifecycleTimeoutMs);
    });
    try {
      return await Promise.race([task, cancelled, deadline]);
    } catch (error) {
      if (!settled && !lifecycle.quarantine) {
        const quarantine = { owner, kind, task: task as Promise<unknown> };
        lifecycle.quarantine = quarantine;
        lifecycle.phase = 'quarantined';
        lifecycle.lastError = error instanceof Error ? error.message : 'Worker lifecycle callback failed';
        void task.then(() => {
          if (lifecycle.quarantine !== quarantine) return;
          lifecycle.quarantine = undefined;
          lifecycle.phase = lifecycle.child ? (lifecycle.child.bindingComplete ? 'running' : 'launching') : lifecycle.intent ? 'launching' : 'stopped';
        }, () => {
          if (lifecycle.quarantine !== quarantine) return;
          lifecycle.quarantine = undefined;
          lifecycle.phase = lifecycle.child ? (lifecycle.child.bindingComplete ? 'running' : 'launching') : lifecycle.intent ? 'launching' : 'stopped';
        });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (lifecycle.external?.owner === owner) lifecycle.external = undefined;
    }
  };
  const runModeCallback = (lifecycle: AccountRuntime, state: State, mode: Bound['mode'], revision: number) => {
    if (!modeListener) {
      if (state.modeTask?.mode !== mode || state.modeTask.revision !== revision) state.modeTask?.controller.abort();
      state.modeTask = undefined;
      return { revision, task: Promise.resolve(), synchronous: true };
    }
    if (state.modeTask?.mode === mode && state.modeTask.revision === revision) {
      return { revision, task: state.modeTask.task, synchronous: false };
    }
    state.modeTask?.controller.abort();
    const controller = new AbortController();
    const owner = Symbol('mode-callback');
    const modeBinding = { ...state.binding, mode };
    const task = runBounded(lifecycle, owner, 'mode', controller,
      (signal) => modeListener?.(modeBinding, signal));
    state.modeTask = { mode, revision, controller, task };
    void task.finally(() => { if (state.modeTask?.revision === revision) state.modeTask = undefined; }).catch(() => undefined);
    return { revision, task, synchronous: false };
  };
  const runRestartBindingCallback = (lifecycle: AccountRuntime, state: State, mode: Bound['mode'], revision: number) => {
    if (!restartBindingListener) return Promise.resolve();
    if (state.restartTask?.mode === mode && state.restartTask.revision === revision) return state.restartTask.task;
    state.restartTask?.controller.abort();
    const controller = new AbortController();
    const owner = Symbol('restart-callback');
    const binding = { ...state.binding, mode };
    const task = runBounded(lifecycle, owner, 'restart', controller,
      (signal) => restartBindingListener?.(binding, signal));
    const restartTask = { mode, revision, controller, task };
    state.restartTask = restartTask;
    void task.finally(() => { if (state.restartTask === restartTask) state.restartTask = undefined; }).catch(() => undefined);
    return task;
  };
  const sendCount = (state: State) => state.sends.size + state.uncertainSends.size;
  const globalSendCount = () => [...runtimes.values()].reduce((total, lifecycle) =>
    total + (lifecycle.child ? sendCount(lifecycle.child) : 0), 0);
  const ownerFields = (binding: WorkerBinding) => ({ transportOwnerId: binding.transportOwnerId,
    transportGeneration: binding.transportGeneration, writeGrantVersion: binding.writeGrantVersion });
  const sameWorkerBinding = (left: WorkerBinding, right: WorkerBinding) => left.accountId === right.accountId
    && left.workerInstanceId === right.workerInstanceId && left.controlEpoch === right.controlEpoch
    && left.transportOwnerId === right.transportOwnerId && left.transportGeneration === right.transportGeneration
    && left.writeGrantVersion === right.writeGrantVersion;
  const workerBindingFields = (binding: WorkerBinding) => ({ accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, ...ownerFields(binding) });
  const relationUnknown = (state: State, command: Extract<LineWorkerCommand, { type: 'checkFriendRelation' | 'addFriendByMid' }>, relationError = 'RELATION_OUTCOME_UNKNOWN') =>
    command.type === 'checkFriendRelation'
      ? { ...workerBindingFields(state.binding), type: 'friendRelationResult' as const, requestId: command.requestId,
        targetMid: command.targetMid, status: 'unknown' as const, error: relationError }
      : { ...workerBindingFields(state.binding), type: 'addFriendResult' as const, requestId: command.requestId,
        targetMid: command.targetMid, status: 'unknown' as const, error: 'TRANSPORT_OUTCOME_UNKNOWN' };
  const failPendingRelations = (state: State, relationError = 'RELATION_WORKER_EXIT') => {
    for (const [requestId, pending] of state.relations) {
      if (pending.timer) clearTimeout(pending.timer);
      const command = pending.command as Extract<LineWorkerCommand, { type: 'checkFriendRelation' | 'addFriendByMid' }>;
      state.relations.delete(requestId);
      if (command.type === 'checkFriendRelation') {
        pending.resolve(relationUnknown(state, command, relationError) as Extract<LineWorkerEvent, { type: 'friendRelationResult' }>);
      } else if (pending.started) {
        pending.resolve(relationUnknown(state, command) as Extract<LineWorkerEvent, { type: 'addFriendResult' }>);
      } else {
        pending.resolve({ ...workerBindingFields(state.binding), type: 'addFriendResult', requestId,
          targetMid: command.targetMid, status: 'failed', error: 'SIDE_EFFECT_DENIED' });
      }
    }
  };
  const postNextSend = (state: State) => {
    if (state.activeSendId || state.stopping || state.retired || !state.modeAckReady) return;
    const accountId = state.binding.accountId;
    const pace = pacing.get(accountId);
    if (pace?.timer !== undefined) return;
    const head = state.sendQueue.map((id) => state.sends.get(id)).find((item) => item && !item.cancelling);
    if (pace && head) {
      const wait = pace.endedAt + pace.gapMs + lengthGapMs(head.command as ManualSendCommand) - now();
      if (wait > 0) {
        pace.timer = setTimer(() => { pace.timer = undefined; postNextSend(state); }, wait);
        return;
      }
    }
    if (pace && !head && now() >= pace.endedAt + pace.gapMs + SEND_GAP_LENGTH_CAP_MS) pacing.delete(accountId);
    while (state.sendQueue.length) {
      const requestId = state.sendQueue.shift()!;
      const pending = state.sends.get(requestId);
      if (!pending || pending.cancelling) continue;
      const command = pending.command as ManualSendCommand;
      if (state.acknowledgedMode !== 'ACTIVE_CONTROL'
        && !(command.type === 'manualSendText' && state.acknowledgedMode === 'MONITOR_ONLY')
        && !(command.type === 'sendMedia' && command.manualSend === true && state.acknowledgedMode === 'MONITOR_ONLY')) {
        state.sends.delete(requestId);
        pending.cleanup?.();
        pending.resolve({ ...workerBindingFields(state.binding), type: 'sendResult', requestId,
          operationId: command.operationId, attemptId: command.attemptId, status: 'failed', messageId: null,
          error: 'SIDE_EFFECT_DENIED' });
        continue;
      }
      state.activeSendId = requestId;
      pending.started = true;
      pending.timer = setTimeout(() => {
        if (state.sends.get(requestId) !== pending) return;
        state.sends.delete(requestId);
        pending.cleanup?.();
        state.uncertainSends.set(requestId, { operationId: command.operationId!, attemptId: command.attemptId!,
          writeGrantVersion: command.writeGrantVersion! });
        pending.resolve(unknownSend(state, command));
        lifecycleFor(state.binding.accountId).lastError = 'LINE send outcome unknown';
      }, command.type === 'sendMedia' ? command.timeoutMs + 5_000 : responseTimeoutMs);
      try { state.child.postMessage(pending.command); }
      catch (error) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.cleanup?.(); state.sends.delete(requestId); state.activeSendId = undefined;
        pending.reject(command.type === 'sendMedia'
          ? new ManualSendNotStartedError(error instanceof Error ? error.message : 'Worker media send was not admitted.')
          : error instanceof Error ? error : new Error('Worker send failed'));
        continue;
      }
      return;
    }
  };
  const requestCancel = (state: State, token: string, pending: Pending<Extract<LineWorkerEvent, { type: 'attachmentResult' }>>, reason = 'Worker download cancelled') => {
    if (state.downloads.get(token) !== pending || pending.cancelling) return;
    pending.cancelling = true;
    pending.cancelReason = reason;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      state.child.kill();
      void state.exited.then(() => pending.reject(new Error('Worker exited before confirming attachment cancellation')));
    }, options.stopTimeoutMs ?? 5_000);
    try { state.child.postMessage({ type: 'cancelAttachmentDownload', ...ownerFields(state.binding), accountId: state.binding.accountId,
      workerInstanceId: state.binding.workerInstanceId, controlEpoch: state.binding.controlEpoch,
      attachmentId: pending.attachmentId, attemptToken: token }); }
    catch (error) {
      try { options.onDiagnostic?.(diagnosticFailure('cancelAttachmentDownload', 'dispatch', error), state.binding.accountId); } catch { /* observer only */ }
      state.child.kill(); void state.exited.then(() => pending.reject(new Error('Worker exited before confirming attachment cancellation')));
    }
  };
  const currentFor = (command: WorkerBinding) => {
    const state = stateFor(command.accountId);
    if (!state || state.retired || state.binding.workerInstanceId !== command.workerInstanceId || state.binding.controlEpoch !== command.controlEpoch
      || (command.transportOwnerId !== undefined && command.transportOwnerId !== state.binding.transportOwnerId)
      || (command.transportGeneration !== undefined && command.transportGeneration !== state.binding.transportGeneration)) throw new Error('Stale worker binding');
    if (state.stopping) throw new Error('Worker is stopping');
    return state;
  };
  const unwrap = (value: unknown): unknown => value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value;
  const isCurrentEventState = (state: State, accountId: string, source: Child, event: LineWorkerEvent) =>
    stateFor(accountId) === state && state.child === source && !state.stopping && !state.retired
      && state.binding.workerInstanceId === event.workerInstanceId && state.binding.accountId === event.accountId
      && (!('controlEpoch' in event) || state.binding.controlEpoch === event.controlEpoch)
      && event.transportOwnerId === state.binding.transportOwnerId
      && event.transportGeneration === state.binding.transportGeneration
      && event.writeGrantVersion === state.binding.writeGrantVersion;
  const failEventProcessing = (accountId: string, state: State) => {
    if (stateFor(accountId) !== state) return;
    state.retired = true; state.domainEvents.length = 0; state.catalogEvents.clear();
    state.binding = { ...state.binding, mode: 'MONITOR_ONLY' };
    state.acknowledgedMode = null;
    lifecycleFor(accountId).phase = 'retiring';
    clearPending(state, 'Worker event processing failed');
    state.child.kill();
  };
  const catalogEvent = (event: LineWorkerEvent): event is Extract<LineWorkerEvent, { type: 'conversationCatalog' | 'catalogRefreshStatus' }> =>
    event.type === 'conversationCatalog' || event.type === 'catalogRefreshStatus';
  const drainCatalogEvents = async (accountId: string, state: State) => {
    if (state.processingCatalogEvents) return;
    state.processingCatalogEvents = true;
    try {
      while (state.catalogEvents.size > 0) {
        const next = state.catalogEvents.entries().next().value as [
          'conversationCatalog' | 'catalogRefreshStatus',
          Extract<LineWorkerEvent, { type: 'conversationCatalog' | 'catalogRefreshStatus' }>,
        ] | undefined;
        if (!next) break;
        const [kind, event] = next;
        state.catalogEvents.delete(kind);
        if (!isCurrentEventState(state, accountId, state.child, event)) continue;
        try {
          await listener?.(event.workerInstanceId, event);
        } catch (error) {
          try { options.onDiagnostic?.(diagnosticFailure('catalog_refresh', 'persist', error), accountId); } catch { /* observer only */ }
          // Catalog persistence and snapshot publication are a separate health
          // domain; never retire a healthy transport for their failures.
          if (event.type === 'conversationCatalog' || event.state === 'ready') {
            const degraded: Extract<LineWorkerEvent, { type: 'catalogRefreshStatus' }> = {
              type: 'catalogRefreshStatus', state: 'degraded', code: 'CATALOG_REFRESH_FAILED',
              accountId: event.accountId, workerInstanceId: event.workerInstanceId, controlEpoch: event.controlEpoch,
              transportOwnerId: event.transportOwnerId, transportGeneration: event.transportGeneration,
              writeGrantVersion: event.writeGrantVersion,
            };
            state.catalogEvents.set('catalogRefreshStatus', degraded);
          }
        }
      }
    } finally {
      state.processingCatalogEvents = false;
      if (!state.retired && !state.stopping && state.catalogEvents.size > 0) void drainCatalogEvents(accountId, state);
    }
  };
  /** Exactly one ingest per batchId: true when this binding already tracks it (queued, ingesting or just acked). */
  const trackBatch = (state: State, event: Extract<LineWorkerEvent, { type: 'batch' }>): boolean => {
    const existing = state.batches.get(event.batchId);
    if (existing) {
      if (existing.ackedAt !== undefined && now() - existing.ackedAt > BATCH_TRACK_ACKED_TTL_MS) state.batches.delete(event.batchId);
      else { existing.reemitCount++; return true; }
    }
    if (state.batches.size >= BATCH_TRACK_LIMIT) {
      const oldest = state.batches.keys().next().value; if (oldest !== undefined) state.batches.delete(oldest);
    }
    const times = event.envelopes.map((envelope) => Date.parse(envelope.occurredAt)).filter(Number.isFinite);
    state.batches.set(event.batchId, { recvAt: now(), queueLength: state.domainEvents.length + Number(state.processingDomainEvents),
      minOccurredAt: times.length ? Math.min(...times) : undefined, messageCount: event.envelopes.length, reemitCount: 0, ackedAt: undefined });
    return false;
  };
  /** Ingest committed: Main is about to ack the worker. Reports the batch when it was slow. */
  const ackedBatch = (state: State, batchId: string) => {
    const track = state.batches.get(batchId);
    if (!track || track.ackedAt !== undefined) return;
    const storedAt = track.ackedAt = now();
    if (track.minOccurredAt === undefined || !options.onIngestLatency) return;
    const lineToMainMs = Math.max(0, track.recvAt - track.minOccurredAt);
    const mainIngestMs = Math.max(0, storedAt - track.recvAt);
    const backlog = lineToMainMs > INGEST_BACKLOG_MS;
    const totalSlow = !backlog && lineToMainMs + mainIngestMs > INGEST_SLOW_TOTAL_MS;
    const mainSlow = mainIngestMs > INGEST_SLOW_MAIN_MS;
    if (!totalSlow && !mainSlow) return;
    const kind = mainSlow && (!totalSlow || mainIngestMs >= lineToMainMs) ? 'main' : 'upstream';
    try {
      options.onIngestLatency({ accountId: state.binding.accountId, workerInstanceId: state.binding.workerInstanceId, kind,
        latency: { lineToMainMs: Math.round(lineToMainMs), mainIngestMs: Math.round(mainIngestMs), queueLength: track.queueLength,
          messageCount: track.messageCount, reemitCount: track.reemitCount } });
    } catch { /* observer only */ }
  };
  /** Processing ended: an unacked batch is forgotten so the worker's next re-emission is ingested again. */
  const settleBatch = (state: State, event: LineWorkerEvent) => {
    if (event.type !== 'batch') return;
    if (state.batches.get(event.batchId)?.ackedAt === undefined) state.batches.delete(event.batchId);
  };
  const drainDomainEvents = async (accountId: string, state: State) => {
    if (state.processingDomainEvents) return;
    state.processingDomainEvents = true;
    try {
      while (state.domainEvents.length > 0) {
        const event = state.domainEvents.shift()!;
        if (!isCurrentEventState(state, accountId, state.child, event)) continue;
        try { await listener?.(event.workerInstanceId, event); }
        finally { settleBatch(state, event); }
      }
    } catch (error) {
      try { options.onDiagnostic?.(diagnosticFailure('line_ingest', 'persist', error), accountId); } catch { /* observer only */ }
      failEventProcessing(accountId, state);
    } finally {
      state.processingDomainEvents = false;
      if (!state.retired && !state.stopping && state.domainEvents.length > 0) void drainDomainEvents(accountId, state);
    }
  };
  async function consume(accountId: string, source: Child, raw: unknown) {
    const parsed = LineWorkerEventSchema.safeParse(unwrap(raw));
    if (!parsed.success) {
      try { options.onDiagnostic?.(diagnosticFailure('unknown', 'parse'), accountId); } catch { /* observer only */ }
      return;
    }
    const event = parsed.data; const state = stateFor(accountId);
    const cancellationEvent = event.type === 'attachmentResult' || event.type === 'attachmentCancelAck' || event.type === 'chatResourceResult';
    if (!state || state.child !== source || event.accountId !== accountId || event.workerInstanceId !== state.binding.workerInstanceId
      || ('controlEpoch' in event && event.controlEpoch !== state.binding.controlEpoch)
      || event.transportOwnerId !== state.binding.transportOwnerId
      || event.transportGeneration !== state.binding.transportGeneration
      || event.writeGrantVersion !== state.binding.writeGrantVersion
      || ((state.stopping || state.retired) && !cancellationEvent)) return;
    if (catalogEvent(event)) {
      state.catalogEvents.set(event.type, event);
      void drainCatalogEvents(accountId, state);
      return;
    }
    if (event.type === 'error' && event.requestId) {
      // A worker-side error for a read-only request settles it now instead of waiting for its timeout.
      // Sends, unsends and Relation mutations keep their own outcome-unknown handling.
      const failure = new Error(`Worker rejected request: ${event.code}`);
      state.ownProfiles.get(event.requestId)?.reject(failure);
      state.chatResources.get(event.requestId)?.reject(chatResourceGatewayError(failure.message, 'pending_request', 'unknown'));
      const relation = state.relations.get(event.requestId);
      if (relation && (relation.command as { type?: string } | undefined)?.type === 'checkFriendRelation') {
        state.relations.delete(event.requestId); if (relation.timer) clearTimeout(relation.timer); relation.reject(failure);
      }
    }
    if (event.type !== 'sendResult' && event.type !== 'unsendResult' && event.type !== 'attachmentResult' && event.type !== 'attachmentCancelAck'
      && event.type !== 'friendRelationResult' && event.type !== 'addFriendResult'
      && event.type !== 'chatResourceResult' && event.type !== 'ownProfileResult'
      && event.type !== 'downloadAuthResult' && event.type !== 'downloadReady' && event.type !== 'downloadAuthInvalidated'
      && event.type !== 'modeAck' && event.type !== 'workerProtocolAck') {
      if (event.type === 'batch' && trackBatch(state, event)) return;
      if (state.domainEvents.length + Number(state.processingDomainEvents) >= maxQueuedDomainEvents) {
        if (event.type === 'batch') state.batches.delete(event.batchId);
        throw new Error('Worker domain event queue limit exceeded');
      }
      state.domainEvents.push(event);
      void drainDomainEvents(accountId, state);
      return;
    }
    if (event.type === 'sendResult') {
      const pending = state.sends.get(event.requestId);
      const expected = pending?.command as { operationId?: string; attemptId?: string } | undefined
        ?? state.uncertainSends.get(event.requestId);
      if (expected && (event.operationId !== expected.operationId || event.attemptId !== expected.attemptId)) return;
      if (pending) { state.sends.delete(event.requestId); if (pending.timer) clearTimeout(pending.timer); pending.cleanup?.(); pending.resolve(event); }
      if (state.uncertainSends.delete(event.requestId) || state.activeSendId === event.requestId) {
        state.activeSendId = undefined;
        pacing.set(accountId, { endedAt: now(), gapMs: SEND_GAP_MIN_MS + Math.floor(random() * (SEND_GAP_MAX_MS - SEND_GAP_MIN_MS + 1)) });
        postNextSend(state);
      }
      if (stateFor(accountId) === state) refreshPhase(lifecycleFor(accountId));
    }
    else if (event.type === 'unsendResult') {
      const pending = state.unsends.get(event.requestId);
      const command = pending?.command as Extract<LineWorkerCommand, { type: 'unsendMessage' }> | undefined;
      if (!pending || !command || event.messageId !== command.messageId || event.chatId !== command.chatId || event.chatType !== command.chatType
        || !sameWorkerBinding(state.binding, command) || !sameWorkerBinding(state.binding, event)) return;
      state.unsends.delete(event.requestId); if (pending.timer) clearTimeout(pending.timer); pending.cleanup?.(); pending.resolve(event);
    }
    else if (event.type === 'friendRelationResult' || event.type === 'addFriendResult') {
      const pending = state.relations.get(event.requestId);
      const command = pending?.command as Extract<LineWorkerCommand, { type: 'checkFriendRelation' | 'addFriendByMid' }> | undefined;
      const expectedType = command?.type === 'checkFriendRelation' ? 'friendRelationResult' : 'addFriendResult';
      if (!pending || !command || event.type !== expectedType || event.targetMid !== command.targetMid
        || !sameWorkerBinding(state.binding, command) || !sameWorkerBinding(state.binding, event)) return;
      if (!relationControlCurrent(state)) { failPendingRelations(state, 'RELATION_BINDING_REVOKED'); return; }
      state.relations.delete(event.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(event);
    }
    else if (event.type === 'chatResourceResult') {
      const pending = state.chatResources.get(event.requestId);
      const command = pending?.command as Extract<LineWorkerCommand, { type: 'chatResourceRead' }> | undefined;
      if (!pending || !command || event.action !== command.action || event.chatId !== command.chatId ||
        event.chatType !== command.chatType || !sameWorkerBinding(state.binding, command) || !sameWorkerBinding(state.binding, event)) return;
      pending.resolve(event);
    }
    else if (event.type === 'ownProfileResult') {
      const pending = state.ownProfiles.get(event.requestId);
      const command = pending?.command as Extract<LineWorkerCommand, { type: 'refreshOwnProfile' }> | undefined;
      if (!pending || !command || !sameWorkerBinding(state.binding, command) || !sameWorkerBinding(state.binding, event)) return;
      pending.resolve(event);
    }
    else if (event.type === 'attachmentResult') {
      const pending = state.downloads.get(event.attemptToken);
      if (pending?.cancelling) pending.value = event;
      else pending?.resolve(event);
    } else if (event.type === 'attachmentCancelAck') {
      const pending = state.downloads.get(event.attemptToken);
      if (!pending?.cancelling) return;
      if (event.cancelled) pending.reject(new Error(pending.cancelReason ?? 'Worker download cancelled'));
      else if (pending.value) pending.resolve(pending.value);
      else {
        state.child.kill();
        void state.exited.then(() => pending.reject(new Error('Worker exited before confirming attachment cancellation')));
      }
    } else if (event.type === 'downloadAuthResult') {
      const pending = state.downloadAuthRequests.get(event.requestId);
      if (!pending || !sameWorkerBinding(state.binding, event)) return;
      state.downloadReady = event.accepted;
      pending.resolve(event);
    } else if (event.type === 'downloadReady') {
      if (event.ownMid !== state.binding.expectedMid || !sameWorkerBinding(state.binding, event)) return;
      state.downloadReady = true;
    } else if (event.type === 'downloadAuthInvalidated') {
      if (!sameWorkerBinding(state.binding, event)) return;
      state.downloadReady = false;
    }
    else if (event.type === 'workerProtocolAck') {
      if (event.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        lifecycleFor(accountId).phase = 'retiring'; state.child.kill(); return;
      }
      state.protocolVerified = true;
      clearTimeout(state.protocolTimer);
      return;
    }
    else if (event.type === 'modeAck') {
      if (!state.protocolVerified || state.stopping) return;
      const lifecycle = lifecycleFor(accountId);
      if (event.mode !== 'ACTIVE_CONTROL') {
        failPendingRelations(state, 'RELATION_BINDING_REVOKED');
        const activeAuthority = lifecycle.authority?.intentGeneration === state.generation
          && lifecycle.authority.mode === 'ACTIVE_CONTROL';
        const activeState = state.binding.mode === 'ACTIVE_CONTROL' || state.acknowledgedMode === 'ACTIVE_CONTROL';
        if (activeAuthority) fenceWriteAuthority(state, event.mode);
        else if (activeState) {
          state.binding = { ...state.binding, mode: event.mode };
          state.modeAckReady = false;
          state.acknowledgedMode = null;
        }
      }
      let authority = lifecycle.authority;
      // A worker may always reduce its own authority. Treat that acknowledgement
      // as a synchronous write fence; acknowledgements can never grant authority.
      if (!authority || authority.intentGeneration !== state.generation || authority.mode !== event.mode) return;
      const revision = state.acknowledgedMode === event.mode ? state.modeRevision : ++state.modeRevision;
      state.binding = { ...state.binding, mode: event.mode }; state.acknowledgedMode = event.mode; state.modeAckReady = false;
      const { task, synchronous } = runModeCallback(lifecycle, state, event.mode, revision);
      try { if (!synchronous) await task; }
      catch (error) {
        if (state.modeRevision !== revision) return;
        throw error;
      }
      if (stateFor(accountId) !== state || state.stopping || state.retired || state.modeRevision !== revision
        || state.binding.mode !== event.mode) return;
      state.modeAckReady = true;
      // Raw acknowledgement is still before restart adoption (which may be
      // queued behind the caller), but after the durable binding registration.
      for (const resolve of state.rawModeWaiters.get(event.mode) ?? []) resolve(true);
      state.rawModeWaiters.delete(event.mode);
      if (!state.bindingReady) {
        await runRestartBindingCallback(lifecycle, state, event.mode, revision);
        if (stateFor(accountId) !== state || state.stopping || state.retired || state.modeRevision !== revision
          || state.acknowledgedMode !== event.mode || lifecycle.authority?.intentGeneration !== state.generation
          || lifecycle.authority.mode !== event.mode) return;
      }
      state.bindingReady = true; lifecycle.phase = 'running'; lifecycle.lastError = undefined;
      for (const resolve of state.modeWaiters.get(event.mode) ?? []) resolve(true);
      state.modeWaiters.delete(event.mode);
    } else if (state.stopping) return;
    await listener?.(event.workerInstanceId, event);
  }
  const fallbackCursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
  const bindingMatches = (left: WorkerBinding | undefined, right: WorkerBinding) => !!left
    && left.accountId === right.accountId && left.workerInstanceId === right.workerInstanceId && left.controlEpoch === right.controlEpoch
    && (right.transportOwnerId === undefined || left.transportOwnerId === right.transportOwnerId)
    && (right.transportGeneration === undefined || left.transportGeneration === right.transportGeneration);
  const relationControlCurrent = (state: State) => {
    const lifecycle = runtimes.get(state.binding.accountId);
    return state.protocolVerified && state.bindingComplete && state.bindingReady && state.modeAckReady
      && state.binding.mode === 'ACTIVE_CONTROL' && state.acknowledgedMode === 'ACTIVE_CONTROL'
      && !!lifecycle?.authority && lifecycle.authority.intentGeneration === state.generation
      && lifecycle.authority.controlEpoch === state.binding.controlEpoch
      && lifecycle.transportGeneration === state.binding.transportGeneration
      && lifecycle.authority.writeGrantVersion === state.binding.writeGrantVersion
      && lifecycle.authority.mode === 'ACTIVE_CONTROL'
      && !!lifecycle.intent && lifecycle.intent.generation === state.generation
      && lifecycle.intent.binding.accountId === state.binding.accountId
      && lifecycle.child === state;
  };
  const manualSendCurrent = (state: State) => {
    const lifecycle = runtimes.get(state.binding.accountId);
    const mode = state.binding.mode;
    return mode !== 'PAUSED' && state.protocolVerified && state.bindingComplete && state.bindingReady && state.modeAckReady
      && state.acknowledgedMode === mode && !!lifecycle?.authority
      && lifecycle.authority.intentGeneration === state.generation && lifecycle.authority.controlEpoch === state.binding.controlEpoch
      && lifecycle.transportGeneration === state.binding.transportGeneration
      && lifecycle.authority.writeGrantVersion === state.binding.writeGrantVersion && lifecycle.authority.mode === mode
      && !!lifecycle.intent && lifecycle.intent.generation === state.generation && lifecycle.child === state
      && !state.stopping && !state.retired;
  };
  const refreshPhase = (lifecycle: AccountRuntime) => {
    if (lifecycle.quarantine) lifecycle.phase = 'quarantined';
    else if (lifecycle.cleanup) lifecycle.phase = 'retiring';
    else if (lifecycle.child) lifecycle.phase = lifecycle.child.stopping ? 'retiring'
      : lifecycle.child.bindingComplete && lifecycle.child.acknowledgedMode !== null && lifecycle.child.bindingReady ? 'running' : 'launching';
    else if (lifecycle.launch || lifecycle.intent) lifecycle.phase = 'launching';
    else if (lifecycle.restart) lifecycle.phase = 'restarting';
    else lifecycle.phase = lifecycle.lastError ? 'failed' : 'stopped';
  };
  const clearRestart = (lifecycle: AccountRuntime) => {
    if (lifecycle.restart) clearTimeout(lifecycle.restart.timer);
    lifecycle.restart = undefined;
    refreshPhase(lifecycle);
  };
  const cleanupChild = (lifecycle: AccountRuntime, state: State): Promise<void> => {
    if (lifecycle.child !== state) return Promise.resolve();
    if (lifecycle.cleanup?.child === state) return lifecycle.cleanup.task;
    const owner = Symbol('child-cleanup');
    failPendingRelations(state);
    state.stopping = true; state.retired = true; state.domainEvents.length = 0; state.catalogEvents.clear();
    state.binding = { ...state.binding, mode: 'PAUSED' }; state.acknowledgedMode = null;
    lifecycle.phase = 'retiring';
    lifecycle.external?.controller.abort();
    state.modeTask?.controller.abort();
    state.restartTask?.controller.abort();
    if (state.poll) clearInterval(state.poll); clearTimeout(state.protocolTimer);
    for (const [token, pending] of state.downloads) requestCancel(state, token, pending);
    for (const pending of state.sends.values()) {
      pending.cleanup?.(); if (pending.timer) clearTimeout(pending.timer);
      if (pending.started) pending.resolve(unknownSend(state, pending.command as ManualSendCommand));
      else pending.reject(new Error('Worker stopped'));
    }
    state.sends.clear(); state.sendQueue.length = 0;
    cancelPacing(state.binding.accountId);
    const task = (async () => {
      const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([...state.downloads.values()].map((pending) => pending.done)),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, stopTimeoutMs); })]);
        if (timer) clearTimeout(timer);
        state.child.kill();
        await Promise.race([state.exited, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Worker did not confirm exit')), stopTimeoutMs);
        })]);
      } catch (error) {
        lifecycle.lastError = error instanceof Error ? error.message : 'Worker cleanup failed';
      } finally {
        if (timer) clearTimeout(timer);
        if (lifecycle.cleanup?.owner === owner) {
          lifecycle.cleanup.settled = true;
          if (state.exitConfirmed) lifecycle.cleanup = undefined;
        }
        refreshPhase(lifecycle);
      }
    })();
    lifecycle.cleanup = { owner, child: state, task, settled: false };
    void task.catch(() => undefined);
    return task;
  };
  const scheduleRestart = (lifecycle: AccountRuntime, state: State) => {
    const intent = lifecycle.intent;
    // A replacement gets a fresh workerInstanceId, but remains part of the same
    // authority intent. The intent's original binding is lineage, not identity.
    if (!intent || intent.generation !== state.generation) {
      lifecycle.phase = intent ? 'launching' : 'stopped'; return;
    }
    if (lifecycle.restartCount >= (options.maxRestarts ?? 3)) { lifecycle.lastError = 'Worker restart limit reached'; lifecycle.phase = 'failed'; return; }
    const sourceBinding = { ...state.binding };
    const ownerGeneration = intent.generation;
    const delayMs = (options.restartDelayMs ?? 500) * 2 ** lifecycle.restartCount++;
    const timer = setTimeout(() => {
      if (lifecycle.restart?.timer !== timer || lifecycle.generation !== ownerGeneration || lifecycle.intent !== intent) return;
      lifecycle.restart = undefined;
      refreshPhase(lifecycle);
      void launch(lifecycle, intent, true, sourceBinding).catch((error) => {
        if (lifecycle.generation !== ownerGeneration || lifecycle.intent !== intent) return;
        lifecycle.lastError = error instanceof Error ? error.message : 'Worker restart failed';
        refreshPhase(lifecycle);
      });
    }, delayMs);
    lifecycle.restart = { generation: ownerGeneration, sourceBinding, timer };
    lifecycle.phase = 'restarting';
  };
  const launch = (lifecycle: AccountRuntime, intent: Intent, restarting: boolean, sourceBinding?: Bound): Promise<Bound> => {
    if (closing) return Promise.reject(new Error('Worker gateway is closing'));
    if (lifecycle.quarantine) return Promise.reject(new Error('Worker lifecycle quarantined'));
    if (!ownsIntent(lifecycle, intent)) return Promise.reject(new Error('Worker launch cancelled'));
    if (lifecycle.launch) return lifecycle.launch.task;
    if (lifecycle.child) return Promise.reject(new Error('Worker launch refused while a child is still owned'));
    const authority = lifecycle.authority ?? Object.freeze({ intentGeneration: intent.generation,
      controlEpoch: intent.binding.controlEpoch, mode: intent.binding.mode,
      readGrantVersion: 0, writeGrantVersion: 0, downloadGrantVersion: 0 });
    const effective: Bound = { ...(restarting ? intent.binding : intent.binding), mode: authority.mode,
      ...(restarting ? { workerInstanceId: randomUUID() } : {}),
      transportOwnerId: randomUUID(), transportGeneration: ++lifecycle.transportGeneration,
      writeGrantVersion: authority.writeGrantVersion };
    const owner = Symbol('worker-launch');
    const controller = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    void cancelled.catch(() => undefined);
    const cancel = (reason: string) => { controller.abort(); rejectCancelled(new Error(reason)); };
    const launchOwner: NonNullable<AccountRuntime['launch']> = { owner, generation: intent.generation, binding: effective,
      sourceBinding, controller, cancel, task: Promise.resolve(effective) };
    lifecycle.launch = launchOwner;
    lifecycle.phase = 'launching'; lifecycle.lastError = undefined;
    const task = (async () => {
      let state: State | undefined;
      try {
        const cursorValue = options.durableCursor
          ? await runBounded(lifecycle, owner, 'cursor', controller, (signal) => options.durableCursor!(effective.accountId, signal))
          : null;
        const cursor = cursorValue ?? fallbackCursor;
        if (!ownsIntent(lifecycle, intent) || lifecycle.launch !== launchOwner || controller.signal.aborted || lifecycle.quarantine) {
          throw new Error('Worker launch cancelled');
        }
        if (lifecycle.child) throw new Error('Worker launch refused while a child is still owned');
        const child = options.spawn(effective);
        let resolveExited!: () => void;
        const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
        let resolveBindingComplete!: () => void;
        const bindingCompletePromise = new Promise<void>((resolve) => { resolveBindingComplete = resolve; });
        state = { binding: effective, child, generation: intent.generation, bindingComplete: false, bindingCompletePromise, resolveBindingComplete,
          exitConfirmed: false, stopping: false, modeRevision: 0, modeTask: undefined, restartTask: undefined,
          acknowledgedMode: null, modeAckReady: false, bindingReady: !restarting, downloadReady: false, downloadAuthRequests: new Map(),
          domainEvents: [], processingDomainEvents: false, batches: new Map(), catalogEvents: new Map(), processingCatalogEvents: false,
          retired: false, protocolVerified: false,
          protocolTimer: setTimeout(() => {
            if (state!.protocolVerified || state!.stopping || stateFor(effective.accountId) !== state) return;
            state!.stopping = true; lifecycle.phase = 'retiring'; child.kill();
          }, responseTimeoutMs),
          sends: new Map(), unsends: new Map(), sendQueue: [], activeSendId: undefined, uncertainSends: new Map(), downloads: new Map(), relations: new Map(), chatResources: new Map(), ownProfiles: new Map(), usedRelationRequests: new Map(), modeWaiters: new Map(), rawModeWaiters: new Map(), exited, resolveExited,
          poll: effective.purpose === 'DOWNLOAD_ONLY' ? undefined : setInterval(() => { if (stateFor(effective.accountId) === state) child.postMessage({ type: 'poll', ...ownerFields(effective), accountId: effective.accountId,
            workerInstanceId: state!.binding.workerInstanceId, controlEpoch: state!.binding.controlEpoch }); }, options.pollIntervalMs ?? 1500) };
        lifecycle.child = state;
        child.on('message', (value) => {
          void consume(effective.accountId, child, value).catch((error: unknown) => {
            try { options.onDiagnostic?.(diagnosticFailure('line_ingest', 'execute', error), effective.accountId); } catch { /* observer only */ }
            failEventProcessing(effective.accountId, state!);
          });
        });
        child.on('exit', () => {
          resolveExited(); state!.exitConfirmed = true; state!.retired = true; state!.domainEvents.length = 0; state!.catalogEvents.clear();
          try { workerExitListener?.(state!.binding); } catch (error) {
            try { options.onDiagnostic?.(diagnosticFailure('stop', 'publish', error), effective.accountId); } catch { /* observer only */ }
          }
          if (lifecycle.child !== state) return;
          lifecycle.child = undefined; if (state!.poll) clearInterval(state!.poll); clearPending(state!, 'Worker exited');
          const cleanup = lifecycle.cleanup;
          if (cleanup && cleanup.child === state && cleanup.settled) lifecycle.cleanup = undefined;
          state!.resolveBindingComplete();
          if (state!.stopping || lifecycle.generation !== state!.generation || lifecycle.intent?.generation !== state!.generation) {
            refreshPhase(lifecycle); return;
          }
          scheduleRestart(lifecycle, state!);
        });
        child.postMessage({ type: 'init', ...effective, protocolVersion: WORKER_PROTOCOL_VERSION, durableCursor: cursor });
        await runBounded(lifecycle, owner, 'binding', controller, (signal) => bindingListener?.(effective, signal));
        if (!ownsIntent(lifecycle, intent) || lifecycle.launch !== launchOwner || lifecycle.child !== state || controller.signal.aborted || lifecycle.quarantine) {
          throw new Error('Worker launch cancelled');
        }
        state.bindingComplete = true; state.resolveBindingComplete();
        refreshPhase(lifecycle);
        return effective;
      } catch (error) {
        if (state && lifecycle.child === state && !state.stopping) {
          try { options.onDiagnostic?.(diagnosticFailure('init', 'spawn', error), effective.accountId); } catch { /* observer only */ }
          state.stopping = true; state.retired = true; state.domainEvents.length = 0; state.catalogEvents.clear(); lifecycle.phase = 'retiring';
          try { await cleanupChild(lifecycle, state); } catch { /* preserve the launch failure and keep the child owned */ }
        }
        throw error;
      } finally {
        if (lifecycle.launch === launchOwner) lifecycle.launch = undefined;
        if (sourceBinding && lifecycle.restart?.sourceBinding === sourceBinding && lifecycle.restart.generation !== intent.generation) clearRestart(lifecycle);
        if (lifecycle.quarantine) lifecycle.phase = 'quarantined'; else refreshPhase(lifecycle);
      }
    })();
    launchOwner.task = task;
    // Keep cancellation visible to the owning lifecycle without retaining a second launch registry.
    void cancelled.catch(() => undefined);
    return task;
  };
  const retireIntent = (lifecycle: AccountRuntime, reason: string) => {
    lifecycle.generation += 1;
    lifecycle.intent = undefined;
    clearRestart(lifecycle);
    lifecycle.launch?.cancel(reason);
    lifecycle.external?.controller.abort();
  };
  const fenceWriteAuthority = (state: State, mode: Bound['mode'] = 'MONITOR_ONLY') => {
    failPendingRelations(state, 'RELATION_BINDING_REVOKED');
    const lifecycle = lifecycleFor(state.binding.accountId);
    const authority = lifecycle.authority;
    if (authority?.intentGeneration === state.generation) {
      lifecycle.authority = Object.freeze({ ...authority, mode,
        writeGrantVersion: authority.writeGrantVersion + 1 });
    }
    state.binding = { ...state.binding, mode };
    state.modeAckReady = false;
    state.acknowledgedMode = null;
    cancelPacing(state.binding.accountId);
    for (const requestId of state.sendQueue.splice(0)) {
      const pending = state.sends.get(requestId);
      if (!pending || pending.started) continue;
      state.sends.delete(requestId);
      pending.cleanup?.();
      const command = pending.command as ManualSendCommand;
      pending.resolve({ type: 'sendResult', accountId: state.binding.accountId,
        workerInstanceId: state.binding.workerInstanceId, controlEpoch: state.binding.controlEpoch,
        transportOwnerId: state.binding.transportOwnerId, transportGeneration: state.binding.transportGeneration,
        writeGrantVersion: state.binding.writeGrantVersion, requestId,
        operationId: command.operationId, attemptId: command.attemptId,
        status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
    }
  };
  const stopChild = async (lifecycle: AccountRuntime, state = lifecycle.child): Promise<void> => {
    if (!state) return;
    await cleanupChild(lifecycle, state);
    if (!state.exitConfirmed) throw new Error(lifecycle.lastError ?? 'Worker did not confirm exit');
  };
  const enqueueSend = (command: Extract<LineWorkerCommand, { type: 'sendText' }>, manual: boolean,
    signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>> => {
    if (isLocalAgentRoom(command)) throw new Error('Local-only route cannot be sent to LINE');
    const state = currentFor(command);
    if (manual ? !manualSendCurrent(state) : !relationControlCurrent(state)) {
      throw new Error(manual ? 'Worker manual-send capability is not current' : 'Worker mode not acknowledged for LINE send (protocol handshake required)');
    }
    if (state.sends.has(command.requestId) || state.uncertainSends.has(command.requestId)) throw new Error('Duplicate worker request ID');
    if (sendCount(state) >= maxSendsPerAccount || globalSendCount() >= maxSendsGlobal) throw new Error('Worker send queue is full (QUEUE_FULL)');
    const wireCommand = LineWorkerCommandSchema.parse({
      type: manual ? 'manualSendText' : 'sendText', accountId: command.accountId,
      workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: command.chatId, requestId: command.requestId,
      text: command.text, replyToMessageId: command.replyToMessageId,
      ...ownerFields(state.binding), operationId: command.requestId, attemptId: randomUUID(), effectPermit: randomUUID(),
    }) as ManualSendCommand;
    return queueWire(state, command.requestId, wireCommand, signal);
  };
  const acquireMedia = (signal?: AbortSignal): Promise<void> => {
    if (closing) return Promise.reject(new Error('Worker gateway is closing'));
    if (signal?.aborted) return Promise.reject(new ManualSendNotStartedError('Worker send cancelled before media admission.'));
    if (!mediaActive) { mediaActive = true; return Promise.resolve(); }
    if (mediaWaiters.length >= MAX_MEDIA_WAITERS) return Promise.reject(new Error('Worker media queue is full (QUEUE_FULL)'));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = mediaWaiters.indexOf(waiter);
        if (index >= 0) mediaWaiters.splice(index, 1);
        reject(new ManualSendNotStartedError('Worker send cancelled before media admission.'));
      };
      const waiter = { resolve: () => { signal?.removeEventListener('abort', onAbort); resolve(); },
        reject: (error: Error) => { signal?.removeEventListener('abort', onAbort); reject(error); } };
      mediaWaiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  const releaseMedia = () => {
    const next = mediaWaiters.shift();
    if (next) next.resolve(); else mediaActive = false;
  };
  const enqueueSendMedia = async (command: SendMediaRequest, signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>> => {
    if (isLocalAgentRoom(command)) throw new ManualSendNotStartedError('Local-only route cannot be sent to LINE');
    let acquired = false;
    let queued = false;
    try {
      await acquireMedia(signal);
      acquired = true;
      const state = currentFor(command);
      const manual = command.manualSend === true;
      if (manual ? !manualSendCurrent(state) : !relationControlCurrent(state)) throw new Error(manual
        ? 'Worker manual-send capability is not current' : 'Worker mode not acknowledged for LINE send (protocol handshake required)');
      if (state.sends.has(command.requestId) || state.uncertainSends.has(command.requestId)) throw new Error('Duplicate worker request ID');
      if (sendCount(state) >= maxSendsPerAccount || globalSendCount() >= maxSendsGlobal) throw new Error('Worker send queue is full (QUEUE_FULL)');
      const wireCommand = LineWorkerCommandSchema.parse({
        type: 'sendMedia', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId, requestId: command.requestId,
        kind: command.kind, filePath: command.filePath, fileName: command.fileName, sizeBytes: command.sizeBytes,
        sha256: command.sha256, timeoutMs: MEDIA_SEND_TIMEOUT_MS, ...(manual ? { manualSend: true } : {}),
        ...ownerFields(state.binding), operationId: command.requestId, attemptId: randomUUID(), effectPermit: randomUUID(),
      }) as ManualSendCommand;
      const pending = queueWire(state, command.requestId, wireCommand, signal);
      queued = true;
      return await pending;
    } catch (error) {
      if (!queued) throw error instanceof ManualSendNotStartedError ? error
        : new ManualSendNotStartedError(error instanceof Error ? error.message : 'Media send was not admitted to the worker.');
      throw error;
    } finally { if (acquired) releaseMedia(); }
  };
  const queueWire = (state: State, requestId: string, wireCommand: ManualSendCommand,
    signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>> => {
    const command = { requestId };
    return new Promise((resolve, reject) => {
      const pending: Pending<Extract<LineWorkerEvent, { type: 'sendResult' }>> = { resolve, reject, command: wireCommand };
      const abort = () => {
        if (state.sends.get(command.requestId) !== pending) return;
        pending.cleanup?.();
        if (!pending.started) {
          state.sends.delete(command.requestId);
          const index = state.sendQueue.indexOf(command.requestId);
          if (index >= 0) state.sendQueue.splice(index, 1);
        }
        pending.reject(pending.started ? new Error('Worker send cancelled after worker admission')
          : wireCommand.type === 'sendMedia' ? new ManualSendNotStartedError('Worker send cancelled before worker admission.')
            : new Error('Worker send cancelled before worker admission'));
      };
      if (signal) pending.cleanup = () => signal.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(wireCommand.type === 'sendMedia' ? new ManualSendNotStartedError('Worker send cancelled before worker admission.')
          : new Error('Worker send cancelled before worker admission'));
        return;
      }
      state.sends.set(command.requestId, pending);
      state.sendQueue.push(command.requestId);
      signal?.addEventListener('abort', abort, { once: true });
      postNextSend(state);
    });
  };
  const installListener = <T>(get: () => T | undefined, set: (value: T | undefined) => void, next: T): (() => void) => {
    const previous = get();
    set(next);
    let removed = false;
    return () => { if (!removed && get() === next) { removed = true; set(previous); } };
  };
  return {
    responseTimeoutMs,
    onEvent(next) { return installListener(() => listener, (value) => { listener = value; }, next); },
    onBinding(next) { return installListener(() => bindingListener, (value) => { bindingListener = value; }, next); },
    onWorkerExit(next) { return installListener(() => workerExitListener, (value) => { workerExitListener = value; }, next); },
    onRestartBinding(next) { return installListener(() => restartBindingListener, (value) => { restartBindingListener = value; }, next); },
    onModeChange(next) { return installListener(() => modeListener, (value) => { modeListener = value; }, next); },
    async start(accountId, binding) {
      if (closing) throw new Error('Worker gateway is closing');
      const occupied = occupiedAccounts();
      if (!occupied.has(accountId) && occupied.size >= maxWorkers) {
        throw new Error(`Global worker limit reached (${maxWorkers})`);
      }
      launchReservations.add(accountId);
      try {
        const lifecycle = lifecycleFor(accountId);
        const intent: Intent = { generation: lifecycle.generation + 1, binding: Object.freeze({ ...binding }) };
        lifecycle.authority = Object.freeze({ intentGeneration: intent.generation, controlEpoch: binding.controlEpoch,
          mode: binding.mode, readGrantVersion: (lifecycle.authority?.readGrantVersion ?? 0) + 1,
          writeGrantVersion: (lifecycle.authority?.writeGrantVersion ?? 0) + 1,
          downloadGrantVersion: (lifecycle.authority?.downloadGrantVersion ?? 0) + 1 });
        lifecycle.generation = intent.generation; lifecycle.intent = intent; lifecycle.restartCount = 0; lifecycle.lastError = undefined;
        clearRestart(lifecycle);
        const previousLaunch = lifecycle.launch;
        previousLaunch?.cancel('Worker launch superseded');
        if (lifecycle.cleanup) await lifecycle.cleanup.task;
        if (previousLaunch) await previousLaunch.task.catch(() => undefined);
        if (!ownsIntent(lifecycle, intent)) throw new Error('Worker launch cancelled');
        if (lifecycle.quarantine) throw new Error('Worker lifecycle quarantined');
        if (lifecycle.child) await stopChild(lifecycle, lifecycle.child);
        if (!ownsIntent(lifecycle, intent)) throw new Error('Worker launch cancelled');
        if (lifecycle.quarantine) throw new Error('Worker lifecycle quarantined');
        return await launch(lifecycle, intent, false);
      } finally { launchReservations.delete(accountId); }
    },
    health(): ComponentHealth {
      const records = [...runtimes.values()];
      const restartCount = records.reduce((sum, lifecycle) => sum + lifecycle.restartCount, 0);
      const ready = records.some((lifecycle) => lifecycle.phase === 'running' && lifecycle.child?.bindingComplete
        && lifecycle.child.acknowledgedMode !== null && lifecycle.child.bindingReady && !lifecycle.quarantine);
      const uncertainSend = records.some((lifecycle) => !!lifecycle.child?.uncertainSends.size);
      const degraded = records.some((lifecycle) => lifecycle.phase !== 'stopped' && lifecycle.phase !== 'running'
        || !!lifecycle.quarantine || !!lifecycle.cleanup || !!lifecycle.child?.stopping || (!!lifecycle.intent && lifecycle.phase !== 'running'))
        || uncertainSend;
      return { name: 'lineWorker', status: degraded ? 'degraded' : ready ? 'ready' : 'stopped',
        message: degraded ? (uncertainSend ? 'LINE send outcome unknown; receive remains active'
          : records.some((lifecycle) => lifecycle.restart) ? 'LINE worker restarting'
          : records.some((lifecycle) => lifecycle.quarantine) ? 'LINE worker lifecycle quarantined' : 'LINE worker awaiting acknowledgement') : null,
        lastSuccessAt: ready && !degraded ? new Date().toISOString() : null, restartCount };
    },
    async binding(accountId) {
      const state = stateFor(accountId);
      if (!state) return null;
      return state.retired && !state.stopping ? { ...state.binding, mode: 'MONITOR_ONLY' } : state.binding;
    },
    isDownloadReady(binding) {
      const state = stateFor(binding.accountId);
      return !!state && state.binding.purpose === 'DOWNLOAD_ONLY' && state.downloadReady
        && sameWorkerBinding(state.binding, binding) && state.bindingReady && !state.stopping && !state.retired;
    },
    async adoptDownloadAuth(command, signal) {
      const state = currentFor(command);
      if (state.binding.purpose !== 'DOWNLOAD_ONLY' || command.expectedMid !== state.binding.expectedMid
        || state.downloadAuthRequests.size > 0) {
        throw new Error('Download-only credential adoption is not available');
      }
      if (signal?.aborted) throw new Error('Download-only credential adoption cancelled');
      const timeoutMs = Math.max(1, Math.min(20_000, options.responseTimeoutMs ?? 20_000));
      return await new Promise<Extract<LineWorkerEvent, { type: 'downloadAuthResult' }>>((resolve, reject) => {
        const requestId = command.requestId;
        let pending!: Pending<Extract<LineWorkerEvent, { type: 'downloadAuthResult' }>>;
        const settle = (fn: () => void) => {
          if (state.downloadAuthRequests.get(requestId) !== pending) return;
          state.downloadAuthRequests.delete(requestId);
          if (pending.timer) clearTimeout(pending.timer);
          pending.cleanup?.(); fn();
        };
        const timer = setTimeout(() => pending.reject(new Error('Download-only credential adoption timed out')), timeoutMs);
        pending = { timer, resolve: (value) => settle(() => resolve(value)), reject: (error) => settle(() => reject(error)) };
        state.downloadAuthRequests.set(requestId, pending);
        if (signal) {
          const onAbort = () => pending.reject(new Error('Download-only credential adoption cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
          pending.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        try { state.child.postMessage({ ...command, ...ownerFields(state.binding) }); }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('Download-only credential adoption failed')); }
      });
    },
    isCurrentActiveControlBinding(binding) {
      if (typeof binding.transportOwnerId !== 'string' || typeof binding.transportGeneration !== 'number'
        || typeof binding.writeGrantVersion !== 'number') return false;
      const state = stateFor(binding.accountId);
      return !!state && !state.stopping && !state.retired && sameWorkerBinding(state.binding, binding)
        && relationControlCurrent(state);
    },
    isCurrentManualSendBinding(binding) {
      const state = stateFor(binding.accountId);
      return !!state && sameWorkerBinding(state.binding, binding) && manualSendCurrent(state);
    },
    async send(command, signal) {
      if (command.type === 'sendText') return enqueueSend(command, false, signal);
      const state = currentFor(command);
      if (command.type === 'reactMessage') {
        if (!sameWorkerBinding(state.binding, command)) throw new Error('Incomplete or stale worker binding for Reaction');
        if (!relationControlCurrent(state)) throw new Error('Worker mode not acknowledged for Reaction');
      }
      if (command.type === 'revokeControl') fenceWriteAuthority(state);
      state.child.postMessage({ ...command, ...ownerFields(state.binding) });
      if (command.type === 'ackBatch') ackedBatch(state, command.batchId);
      return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        requestId: 'requestId' in command ? command.requestId : 'control', status: 'unknown', messageId: null, error: null };
    },
    async unsend(command, signal) {
      const state = currentFor(command);
      if (!sameWorkerBinding(state.binding, command) || !manualSendCurrent(state)) throw new Error('Worker manual-unsend capability is not current');
      if (state.unsends.size >= 8) throw new Error('Worker unsend queue is full (QUEUE_FULL)');
      if (state.unsends.has(command.requestId)) throw new Error('Duplicate worker unsend request ID');
      return new Promise((resolve, reject) => {
        const wire = LineWorkerCommandSchema.parse({ ...workerBindingFields(state.binding), type: 'unsendMessage',
          requestId: command.requestId, chatType: command.chatType, chatId: command.chatId, messageId: command.messageId });
        const pending: Pending<Extract<LineWorkerEvent, { type: 'unsendResult' }>> = { command: wire, resolve, reject };
        const abort = () => { if (!pending.started && state.unsends.delete(command.requestId)) { if (pending.timer) clearTimeout(pending.timer); reject(new Error('Worker unsend cancelled')); } };
        if (signal?.aborted) { reject(new Error('Worker unsend cancelled')); return; }
        if (signal) pending.cleanup = () => signal.removeEventListener('abort', abort);
        pending.timer = setTimeout(() => {
          if (state.unsends.get(command.requestId) !== pending) return;
          state.unsends.delete(command.requestId); pending.cleanup?.();
          resolve({ ...workerBindingFields(state.binding), type: 'unsendResult', chatType: command.chatType, chatId: command.chatId,
            requestId: command.requestId, messageId: command.messageId, status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
        }, responseTimeoutMs);
        state.unsends.set(command.requestId, pending); signal?.addEventListener('abort', abort, { once: true });
        try { pending.started = true; state.child.postMessage(wire); }
        catch (error) { state.unsends.delete(command.requestId); if (pending.timer) clearTimeout(pending.timer); pending.cleanup?.(); reject(error instanceof Error ? error : new Error('Worker unsend failed')); }
      });
    },
    async sendManual(command, signal) { return enqueueSend(command, true, signal); },
    async sendMedia(command, signal) { return enqueueSendMedia(command, signal); },
    async checkFriendRelation(command) {
      const state = currentFor(command);
      if (!sameWorkerBinding(state.binding, command)) throw new Error('Incomplete or stale worker binding');
      if (!relationControlCurrent(state)) throw new Error('Worker mode not acknowledged for Relation read');
      if (state.relations.size >= 64) throw new Error('Worker Relation queue is full (QUEUE_FULL)');
      if (state.usedRelationRequests.has(command.requestId)) throw new Error('Duplicate worker Relation request ID');
      if (state.usedRelationRequests.size >= maxUsedRelationRequests) throw new Error('Worker Relation request ledger is full (QUEUE_FULL)');
      state.usedRelationRequests.set(command.requestId, { type: 'check', targetMid: command.targetMid });
      return new Promise((resolve, reject) => {
        const pending: Pending<Extract<LineWorkerEvent, { type: 'friendRelationResult' | 'addFriendResult' }>> = {
          command, resolve: (value) => resolve(value as Extract<LineWorkerEvent, { type: 'friendRelationResult' }>), reject,
        };
        pending.timer = setTimeout(() => {
          if (state.relations.get(command.requestId) !== pending) return;
          state.relations.delete(command.requestId);
          pending.resolve(relationUnknown(state, command, 'RELATION_RESPONSE_TIMEOUT') as Extract<LineWorkerEvent, { type: 'friendRelationResult' }>);
        }, responseTimeoutMs);
        state.relations.set(command.requestId, pending);
        try { state.child.postMessage({ ...command, ...ownerFields(state.binding) }); }
        catch (error) {
          state.relations.delete(command.requestId); clearTimeout(pending.timer);
          reject(error instanceof Error ? error : new Error('Worker Relation check failed'));
        }
      });
    },
    async addFriendByMid(command) {
      const state = currentFor(command);
      if (!sameWorkerBinding(state.binding, command)) throw new Error('Incomplete or stale worker binding');
      if (!relationControlCurrent(state)) throw new Error('Worker mode not acknowledged for Relation mutation');
      if (state.relations.size >= 64) throw new Error('Worker Relation queue is full (QUEUE_FULL)');
      if (state.usedRelationRequests.has(command.requestId)) throw new Error('Duplicate worker Relation request ID');
      if (state.usedRelationRequests.size >= maxUsedRelationRequests) throw new Error('Worker Relation request ledger is full (QUEUE_FULL)');
      state.usedRelationRequests.set(command.requestId, { type: 'add', targetMid: command.targetMid });
      return new Promise((resolve, reject) => {
        const pending: Pending<Extract<LineWorkerEvent, { type: 'friendRelationResult' | 'addFriendResult' }>> = {
          command, resolve: (value) => resolve(value as Extract<LineWorkerEvent, { type: 'addFriendResult' }>), reject,
        };
        pending.timer = setTimeout(() => {
          if (state.relations.get(command.requestId) !== pending) return;
          state.relations.delete(command.requestId);
          pending.resolve(relationUnknown(state, command) as Extract<LineWorkerEvent, { type: 'friendRelationResult' | 'addFriendResult' }>);
        }, responseTimeoutMs);
        state.relations.set(command.requestId, pending);
        try {
          state.child.postMessage({ ...command, ...ownerFields(state.binding) });
          pending.started = true;
        } catch (error) {
          state.relations.delete(command.requestId); clearTimeout(pending.timer);
          reject(error instanceof Error ? error : new Error('Worker Relation add failed'));
        }
      });
    },
    async download(command, signal) {
      const state = currentFor(command); if (!state.protocolVerified || state.acknowledgedMode === null || state.acknowledgedMode === 'PAUSED') throw new Error('Worker protocol/mode not acknowledged for attachment download');
      if (state.binding.purpose === 'DOWNLOAD_ONLY' && !state.downloadReady) throw new Error('Download-only worker has no verified account credential');
      if (signal?.aborted) throw new Error('Worker download cancelled');
      if (state.downloads.has(command.attemptToken)) throw new Error('Duplicate attachment attempt');
      return new Promise((resolve, reject) => {
        let pending!: Pending<Extract<LineWorkerEvent, { type: 'attachmentResult' }>>;
        const finish = (settle: () => void) => {
          if (state.downloads.get(command.attemptToken) !== pending) return;
          state.downloads.delete(command.attemptToken); clearTimeout(pending.timer); pending.cleanup?.(); settle(); pending.finishDone?.();
        };
        let finishDone!: () => void;
        const done = new Promise<void>((complete) => { finishDone = complete; });
        const timer = setTimeout(() => requestCancel(state, command.attemptToken, pending, 'Worker download timed out'), command.timeoutMs);
        pending = { timer, done, finishDone, attachmentId: command.attachmentId,
          resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)) };
        state.downloads.set(command.attemptToken, pending);
        if (signal) {
          const abort = () => requestCancel(state, command.attemptToken, pending);
          signal.addEventListener('abort', abort, { once: true });
          pending.cleanup = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
        }
        if (state.downloads.get(command.attemptToken) !== pending) return;
        try { state.child.postMessage({ ...command, ...ownerFields(state.binding) }); }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('Worker download failed')); }
      });
    },
    async readChatResource(command, signal) {
      let state: State;
      try { state = currentFor(command); }
      catch (error) {
        const current = stateFor(command.accountId);
        if (!current) throw chatResourceGatewayError('Worker is unavailable', 'gateway_admission', 'missing_worker');
        if (error instanceof Error && error.message === 'Worker is stopping') throw chatResourceGatewayError(error.message, 'gateway_admission', 'not_ready_worker', true, true, false);
        throw chatResourceGatewayError(error instanceof Error ? error.message : 'Stale worker binding', 'gateway_admission', 'stale_binding', false,
          current.binding.controlEpoch === command.controlEpoch, current.bindingReady);
      }
      if (!state.protocolVerified || !state.bindingReady || state.stopping || state.acknowledgedMode === 'PAUSED') {
        throw chatResourceGatewayError('Worker protocol/mode not acknowledged for chat resource read', 'gateway_admission', 'not_ready_worker', true, true, false);
      }
      if (!sameWorkerBinding(state.binding, command)) throw chatResourceGatewayError('Incomplete or stale worker binding for chat resource read', 'gateway_admission', 'stale_binding', false,
        state.binding.controlEpoch === command.controlEpoch, state.bindingReady);
      if (signal?.aborted) throw new Error('Chat resource read cancelled');
      const totalPending = [...runtimes.values()].reduce((sum, lifecycle) => sum + (lifecycle.child?.chatResources.size ?? 0), 0);
      if (state.chatResources.size >= 4 || totalPending >= 16) throw new Error('Worker chat resource queue is full (QUEUE_FULL)');
      if (state.chatResources.has(command.requestId)) throw new Error('Duplicate chat resource request ID');
      return await new Promise((resolve, reject) => {
        const finish = (settle: () => void) => {
          if (state.chatResources.get(command.requestId) !== pending) return;
          state.chatResources.delete(command.requestId); if (pending.timer) clearTimeout(pending.timer); pending.cleanup?.(); settle();
        };
        const cancel = (reason: string) => {
          try { state.child.postMessage({ type: 'cancelChatResourceRead', ...ownerFields(state.binding), accountId: state.binding.accountId,
            workerInstanceId: state.binding.workerInstanceId, controlEpoch: state.binding.controlEpoch,
            chatType: command.chatType, chatId: command.chatId, requestId: command.requestId }); }
          catch { /* Worker exit cleanup will reject the request. */ }
          const current = stateFor(command.accountId) === state && !state.stopping && !state.retired;
          finish(() => reject(chatResourceGatewayError(reason, 'pending_request', reason.includes('cancel') ? 'pending_stopped' : 'unknown',
            ...(current ? [sameWorkerBinding(state.binding, command), state.binding.controlEpoch === command.controlEpoch,
              state.protocolVerified && state.bindingReady && state.acknowledgedMode !== 'PAUSED'] as const : []))));
        };
        const pending: Pending<Extract<LineWorkerEvent, { type: 'chatResourceResult' }>> = {
          command, resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)),
        };
        pending.timer = setTimeout(() => cancel('Chat resource response timed out'), command.timeoutMs);
        state.chatResources.set(command.requestId, pending);
        if (signal) {
          const abort = () => cancel('Chat resource read cancelled');
          signal.addEventListener('abort', abort, { once: true });
          pending.cleanup = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
        }
        if (state.chatResources.get(command.requestId) !== pending) return;
        try { state.child.postMessage({ ...command, ...ownerFields(state.binding) }); }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('Chat resource read failed')); }
      });
    },
    async refreshOwnProfile(command) {
      const state = currentFor(command);
      if (!state.protocolVerified || !state.bindingReady || state.stopping || state.acknowledgedMode === 'PAUSED') throw new Error('Worker protocol/mode not acknowledged for profile read');
      if (!sameWorkerBinding(state.binding, command)) throw new Error('Incomplete or stale worker binding for profile read');
      if (state.ownProfiles.size >= 1) throw new Error('Worker profile request is already in progress (QUEUE_FULL)');
      if (state.ownProfiles.has(command.requestId)) throw new Error('Duplicate worker profile request ID');
      return await new Promise((resolve, reject) => {
        const finish = (settle: () => void) => {
          if (state.ownProfiles.get(command.requestId) !== pending) return;
          state.ownProfiles.delete(command.requestId); if (pending.timer) clearTimeout(pending.timer); settle();
        };
        const pending: Pending<Extract<LineWorkerEvent, { type: 'ownProfileResult' }>> = {
          command, resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)),
        };
        pending.timer = setTimeout(() => pending.reject(new Error('LINE profile response timed out')), command.timeoutMs);
        state.ownProfiles.set(command.requestId, pending);
        try {
          state.child.postMessage({ ...workerBindingFields(command), type: 'refreshOwnProfile', requestId: command.requestId,
            timeoutMs: command.timeoutMs, ...ownerFields(state.binding) });
        }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('LINE profile read failed')); }
      });
    },
    async waitModeAck(accountId, mode, waitMs) {
      const state = stateFor(accountId); if (!state) return false;
      if (state.acknowledgedMode === mode && state.modeAckReady && state.bindingReady) return true;
      return new Promise<boolean>((resolve) => { const waiters = state.modeWaiters.get(mode) ?? new Set(); let timer: ReturnType<typeof setTimeout>;
        const done = (value: boolean) => { clearTimeout(timer); waiters.delete(done); if (!waiters.size) state.modeWaiters.delete(mode); resolve(value); };
        waiters.add(done); state.modeWaiters.set(mode, waiters); timer = setTimeout(() => done(false), waitMs); });
    },
    async waitRawModeAck(accountId, mode, waitMs) {
      const state = stateFor(accountId); if (!state) return false;
      if (state.acknowledgedMode === mode && state.modeAckReady) return true;
      return new Promise<boolean>((resolve) => { const waiters = state.rawModeWaiters.get(mode) ?? new Set(); let timer: ReturnType<typeof setTimeout>;
        const done = (value: boolean) => { clearTimeout(timer); waiters.delete(done); if (!waiters.size) state.rawModeWaiters.delete(mode); resolve(value); };
        waiters.add(done); state.rawModeWaiters.set(mode, waiters); timer = setTimeout(() => done(false), waitMs); });
    },
    async stop(accountId) {
      const lifecycle = runtimes.get(accountId);
      if (!lifecycle) return;
      retireIntent(lifecycle, 'Worker stopped');
      const launchTask = lifecycle.launch?.task;
      if (lifecycle.child) await stopChild(lifecycle, lifecycle.child);
      if (launchTask) await launchTask.catch(() => undefined);
      refreshPhase(lifecycle);
    },
    async stopBinding(binding) {
      const lifecycle = runtimes.get(binding.accountId);
      if (!lifecycle) return;
      const state = lifecycle.child;
      const ownsChild = !!state && bindingMatches(state.binding, binding);
      const ownsIntent = bindingMatches(lifecycle.intent?.binding, binding);
      const ownsRestart = !!lifecycle.restart && bindingMatches(lifecycle.restart.sourceBinding, binding)
        && lifecycle.restart.generation === lifecycle.intent?.generation;
      const launch = lifecycle.launch;
      const ownsLaunchTarget = !!launch && bindingMatches(launch.binding, binding) && launch.generation === lifecycle.intent?.generation;
      const ownsLaunchSource = !state && !!launch?.sourceBinding && bindingMatches(launch.sourceBinding, binding)
        && launch.generation === lifecycle.intent?.generation;
      if (!ownsChild && !ownsRestart && !ownsLaunchTarget && !ownsLaunchSource) return;
      const ownsCurrentIntent = ownsIntent || ownsRestart || ownsLaunchTarget;
      if (ownsCurrentIntent && (!state || ownsChild || ownsRestart || ownsLaunchTarget)) retireIntent(lifecycle, 'Worker binding stopped');
      if (ownsRestart) clearRestart(lifecycle);
      const launchTask = (ownsLaunchTarget || ownsLaunchSource) ? lifecycle.launch?.task : undefined;
      if (ownsChild && state) await stopChild(lifecycle, state);
      if (launchTask) await launchTask.catch(() => undefined);
      refreshPhase(lifecycle);
    },
    shutdown() {
      closing = true;
      for (const waiter of mediaWaiters.splice(0)) waiter.reject(new Error('Worker gateway is closing'));
      if (!shutdownTask) {
        const task = (async () => {
        const results = await Promise.allSettled([...runtimes.keys()].map((accountId) => this.stop(accountId)));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        })();
        shutdownTask = task;
        // A caller may be awaiting the first shutdown while a second caller
        // observes the same bounded failure. Mark it handled at ownership time.
        void task.catch(() => undefined);
        void task.finally(() => { if (shutdownTask === task) shutdownTask = undefined; }).catch(() => undefined);
      }
      return shutdownTask;
    },
    inventory() {
      const values = [...runtimes.values()];
      const live = values.flatMap((lifecycle) => lifecycle.child ? [lifecycle.child] : []);
      const pendingTasks = live.reduce((sum, state) => sum + state.domainEvents.length + Number(state.processingDomainEvents)
        + state.sends.size + state.unsends.size + state.downloads.size + state.relations.size + state.chatResources.size
        + Number(!!state.modeTask) + Number(!!state.restartTask), 0)
        + values.reduce((sum, lifecycle) => sum + Number(!!lifecycle.launch) + Number(!!lifecycle.cleanup)
          + Number(!!lifecycle.external) + Number(!!lifecycle.quarantine), 0);
      const ownedTimers = values.reduce((sum, lifecycle) => sum + Number(!!lifecycle.restart)
        + (lifecycle.child ? Number(!lifecycle.child.protocolVerified) + 1 + lifecycle.child.sends.size + lifecycle.child.downloads.size + lifecycle.child.relations.size
          + lifecycle.child.unsends.size
          + lifecycle.child.chatResources.size
          + [...lifecycle.child.modeWaiters.values(), ...lifecycle.child.rawModeWaiters.values()].reduce((waiterSum, waiters) => waiterSum + waiters.size, 0) : 0), 0);
      const ownedListeners = live.reduce((sum, state) => sum + (state.child.listenerCount
        ? state.child.listenerCount('message') + state.child.listenerCount('exit') : 2), 0);
      const launching = new Set([...launchReservations, ...[...runtimes.entries()].flatMap(([accountId, lifecycle]) => lifecycle.launch ? [accountId] : [])]);
      return { activeWorkers: live.length,
        launchingWorkers: launching.size,
        restartTimers: values.filter((lifecycle) => !!lifecycle.restart).length,
        pendingTasks, ownedTimers, ownedListeners };
    },
  };
}
