import { LineWorkerCommandSchema, LineWorkerEventSchema, LOGIN_FAILURES,
  type LineWorkerCommand, type LineWorkerEvent, type WorkerErrorCode } from '@line-agent/contracts';
import { createLinejsAdapter } from './linejs-adapter.js';
import { LineWorkerLoop, type LineTransport, type LineWorkerOptions } from './worker-loop.js';
import { createWindowsAttachmentBroker } from './windows-attachment-broker.js';
import { DIAGNOSTIC_OPERATIONS, diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';

const COMMAND_TYPES: ReadonlySet<string> = new Set(LineWorkerCommandSchema.options.map((option) => option.shape.type.value));
const DIAGNOSTIC_OPERATION_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_OPERATIONS);
/** Only a known command discriminator that is also a valid diagnostic operation; no other raw input value is read. */
function rejectedOperation(input: unknown): SafeDiagnostic['operation'] {
  const type = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as { type?: unknown }).type : undefined;
  return typeof type === 'string' && COMMAND_TYPES.has(type) && DIAGNOSTIC_OPERATION_SET.has(type) ? type as SafeDiagnostic['operation'] : 'unknown';
}
function rejectedRequestId(input: unknown): string | undefined {
  const id = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as { requestId?: unknown }).requestId : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined;
}

type Init = Extract<LineWorkerCommand, { type: 'init' }>;

const operationErrors: Partial<Record<LineWorkerCommand['type'], Readonly<{ code: WorkerErrorCode; message: string }>>> = {
  history: { code: 'HISTORY_READ_FAILED', message: 'LINE chat history could not be read.' },
  chatResourceRead: { code: 'CHAT_RESOURCE_READ_FAILED', message: 'LINE chat resources could not be read.' },
  refreshOwnProfile: { code: 'PROFILE_REFRESH_FAILED', message: 'The LINE profile could not be refreshed.' },
  sendText: { code: 'MESSAGE_SEND_FAILED', message: 'The LINE message could not be sent.' },
  manualSendText: { code: 'MESSAGE_SEND_FAILED', message: 'The LINE message could not be sent.' },
  sendMedia: { code: 'MESSAGE_SEND_FAILED', message: 'The LINE attachment could not be sent.' },
  unsendMessage: { code: 'MESSAGE_UNSEND_FAILED', message: 'The LINE message could not be unsent.' },
  reactMessage: { code: 'MESSAGE_REACTION_FAILED', message: 'The LINE reaction could not be applied.' },
  checkFriendRelation: { code: 'FRIEND_RELATION_CHECK_FAILED', message: 'The LINE friend relationship could not be checked.' },
  addFriendByMid: { code: 'FRIEND_ADD_FAILED', message: 'The LINE friend could not be added.' },
  downloadAttachment: { code: 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED', message: 'The LINE attachment could not be downloaded.' },
  setSecretState: { code: 'CREDENTIAL_RESTORE_FAILED', message: 'LINE credentials could not be restored.' },
  poll: { code: 'LINE_SYNC_FAILED', message: 'LINE updates could not be synchronized.' },
};

function operationError(command: LineWorkerCommand | undefined): Readonly<{ code: WorkerErrorCode; message: string }> {
  return command ? operationErrors[command.type] ?? { code: 'WORKER_OPERATION_FAILED', message: 'The LINE worker operation failed.' }
    : { code: 'INVALID_COMMAND', message: 'Worker command rejected' };
}

export interface WorkerPort {
  onMessage(handler: (value: unknown) => void): void;
  postMessage(value: LineWorkerEvent): void | Promise<void>;
}

/** Production transport preserves LINEJS's native deadline and cancellation signal. */
export function fetchLineRequest(request: Request): Promise<Response> {
  return fetch(request);
}

export type WorkerHostOptions = Readonly<Pick<LineWorkerOptions, 'attachmentRoot' | 'attachmentRuntime' | 'minFreeBytes'> & {
  validateLease?: LineWorkerOptions['validateLease'];
}>;

export async function fetchWithTimeout(
  request: Request,
  timeoutMs: number,
  fetchImpl: (request: Request) => Promise<Response> = (input) => fetch(input),
): Promise<Response> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener('abort', abortFromRequest, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('LINE request timed out')), timeoutMs);
  let cleaned = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abortFromRequest);
    controller.signal.removeEventListener('abort', abortBody);
  };
  const abortBody = () => {
    const reason = controller.signal.reason ?? new Error('LINE request aborted');
    try { outputController?.error(reason); } catch { /* already closed */ }
    if (reader) void reader.cancel(reason).then(() => reader?.releaseLock(), () => undefined);
    cleanup();
  };
  try {
    const response = await fetchImpl(new Request(request, { signal: controller.signal }));
    if (!response.body) { cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        outputController = streamController;
        controller.signal.addEventListener('abort', abortBody, { once: true });
        if (controller.signal.aborted) abortBody();
      },
      async pull(streamController) {
        try {
          const item = await reader!.read();
          if (item.done) { streamController.close(); cleanup(); }
          else streamController.enqueue(item.value);
        } catch (error) {
          try { streamController.error(error); } catch { /* already aborted */ }
          cleanup();
        }
      },
      async cancel(reason) {
        try { await reader?.cancel(reason); }
        finally { cleanup(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The first init owns the process for its entire lifetime, including a failed bootstrap. */
export function runWorkerLoopOnPort(port: WorkerPort, factory: (init: Init) => Promise<LineTransport>,
  options: WorkerHostOptions = {}): void {
  let binding: Init | undefined;
  let reservedBinding: Init | undefined;
  let loop: LineWorkerLoop | undefined;
  let initializing = false;
  let initializationReady: Promise<void> | undefined;
  let resolveInitialization: (() => void) | undefined;
  let sendTail = Promise.resolve();
  let sendPending = 0;
  let pollPending = false;
  let reactionActive = false;
  let reactionPending: Extract<LineWorkerCommand, { type: 'reactMessage' }> | undefined;
  let urgentFence = false;
  const urgentTasks = new Map<string, Promise<void>>();
  const capabilityPending = new Map<string, number>();
  const loginTasks = new Map<string, Promise<void>>();
  const MAX_SENDS_PER_WORKER = 64;
  const MAX_CAPABILITY_PENDING = 64;
  const workerIdentity = () => binding ? ({ accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
    controlEpoch: binding.controlEpoch,
    ...(binding.transportOwnerId === undefined ? {} : { transportOwnerId: binding.transportOwnerId }),
    ...(binding.transportGeneration === undefined ? {} : { transportGeneration: binding.transportGeneration }),
    ...(binding.writeGrantVersion === undefined ? {} : { writeGrantVersion: binding.writeGrantVersion }) }) : undefined;
  const capabilityKey = (command: LineWorkerCommand) => command.type === 'history'
    ? `history:${command.accountId}:${command.workerInstanceId}`
    : command.type === 'chatResourceRead' ? `chat-resource:${command.accountId}:${command.workerInstanceId}`
    : command.type === 'downloadAttachment' ? `attachment:${command.accountId}:${command.workerInstanceId}`
      : command.type === 'cancelAttachmentDownload' ? `cancel:${command.accountId}:${command.workerInstanceId}`
        : `control:${command.accountId}:${command.workerInstanceId}`;
  const emit = (event: LineWorkerEvent) => port.postMessage(LineWorkerEventSchema.parse(event));
  const execute = async (input: unknown, supplied?: LineWorkerCommand): Promise<void> => {
    let command: LineWorkerCommand | undefined;
    let commandExecutionStarted = false;
    try {
      command = supplied ?? LineWorkerCommandSchema.parse(input);
      if (!binding) {
        if (command.type !== 'init' || initializing) throw new Error('worker requires a single init');
        initializing = true;
        binding = Object.freeze({ ...command });
        try {
          const transport = await factory(binding);
          loop = new LineWorkerLoop({ transport, emit,
            validateLease: options.validateLease ?? (() => true),
            ...(options.attachmentRoot === undefined ? {} : { attachmentRoot: options.attachmentRoot }),
            ...(options.attachmentRuntime === undefined ? {} : { attachmentRuntime: options.attachmentRuntime }),
            ...(options.minFreeBytes === undefined ? {} : { minFreeBytes: options.minFreeBytes }),
          });
          await loop.handle(command);
        } finally { resolveInitialization?.(); }
        return;
      }
      if (!loop) throw new Error('worker initialization failed');
      if (command.accountId !== binding.accountId || command.workerInstanceId !== binding.workerInstanceId ||
        command.controlEpoch !== binding.controlEpoch || command.transportOwnerId !== binding.transportOwnerId ||
        command.transportGeneration !== binding.transportGeneration || command.writeGrantVersion !== binding.writeGrantVersion) {
        throw new Error('worker binding mismatch');
      }
      if (urgentFence && (command.type === 'sendText' || command.type === 'manualSendText')) {
        await emit({ type: 'sendResult', ...workerIdentity()!, requestId: command.requestId,
          operationId: command.operationId, attemptId: command.attemptId, status: 'failed', messageId: null,
          error: 'SIDE_EFFECT_DENIED' });
        return;
      }
      commandExecutionStarted = true;
      await loop.handle(command);
    } catch (error) {
      if (!binding) return; // There is no trusted account/instance to address.
      const identity = workerIdentity()!;
      if (command?.type === 'loginQr' || command?.type === 'loginToken') {
        if (loop?.authInvalidated) return;
        const details = error instanceof Error ? error : null;
        const localMessage = details?.message;
        const code = details?.name === 'TimeoutError' ? 'LOGIN_TIMEOUT'
          : localMessage === 'login in progress' || localMessage === 'secret restore in progress' ? 'LOGIN_IN_PROGRESS'
            : localMessage === 'login attempt mismatch' || localMessage === 'LINE credential operation is stale'
              ? 'LOGIN_ATTEMPT_REPLACED' : 'LOGIN_FAILED';
        await emit({ type: 'loginFailure', ...identity, loginAttemptId: command.loginAttemptId, code,
          message: LOGIN_FAILURES[code] } as Extract<LineWorkerEvent, { type: 'loginFailure' }>);
      } else if (error instanceof Error && 'code' in error && error.code === 'PROTOCOL_UNVERIFIED') {
        await emit({ type: 'status', ...identity, state: 'PROTOCOL_UNVERIFIED', message: null });
      } else {
        const diagnostic = commandExecutionStarted ? operationError(command)
          : { code: 'INVALID_COMMAND' as const, message: 'Worker command rejected' };
        await emit({ type: 'error', ...identity, ...diagnostic, retryable: false,
          diagnostic: diagnosticFailure(command?.type ?? rejectedOperation(input), commandExecutionStarted ? 'execute'
            : command?.type === 'init' && initializing ? 'bootstrap' : 'admission', error),
          ...(command ? ('requestId' in command ? { requestId: command.requestId } : {})
            : rejectedRequestId(input) !== undefined ? { requestId: rejectedRequestId(input)! } : {}) });
      }
    }
  };
  const runReaction = (command: Extract<LineWorkerCommand, { type: 'reactMessage' }>): void => {
    void execute(command, command).finally(() => {
      const next = reactionPending;
      if (next) {
        reactionPending = undefined;
        runReaction(next);
      } else reactionActive = false;
    });
  };
  port.onMessage((input) => {
    const parsed = LineWorkerCommandSchema.safeParse(input);
    if (parsed.success && parsed.data.type === 'init' && !binding && !reservedBinding) {
      reservedBinding = parsed.data;
      initializationReady = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    }
    const expectedBinding = binding ?? reservedBinding;
    if (parsed.success && (parsed.data.type === 'revokeControl' || parsed.data.type === 'stop' || parsed.data.type === 'cancelAttachmentDownload' || parsed.data.type === 'cancelChatResourceRead') && expectedBinding &&
      parsed.data.accountId === expectedBinding.accountId && parsed.data.workerInstanceId === expectedBinding.workerInstanceId &&
      parsed.data.controlEpoch === expectedBinding.controlEpoch &&
      parsed.data.transportOwnerId === expectedBinding.transportOwnerId &&
      parsed.data.transportGeneration === expectedBinding.transportGeneration &&
      parsed.data.writeGrantVersion === expectedBinding.writeGrantVersion) {
      if (parsed.data.type === 'revokeControl' || parsed.data.type === 'stop') urgentFence = true;
      const taskKey = parsed.data.type === 'cancelAttachmentDownload'
        ? `cancel:${parsed.data.attemptToken}` : parsed.data.type === 'cancelChatResourceRead'
          ? `cancel-chat-resource:${parsed.data.requestId}` : parsed.data.type;
      if (!urgentTasks.has(taskKey)) {
        const ready = loop ? Promise.resolve() : initializationReady ?? Promise.resolve();
        const type = taskKey;
        const task = ready.then(() => execute(input, parsed.data));
        urgentTasks.set(type, task);
        void task.finally(() => { if (urgentTasks.get(type) === task) urgentTasks.delete(type); }).catch(() => undefined);
      }
      return;
    }
    if (!parsed.success) {
      void execute(input).catch(() => undefined);
      return;
    }
    const command = parsed.data;
    if (command.type === 'sendText' || command.type === 'manualSendText') {
      if (sendPending >= MAX_SENDS_PER_WORKER) {
        void emit({ type: 'sendResult', ...workerIdentity()!,
          requestId: command.requestId,
          ...(command.operationId === undefined ? {} : { operationId: command.operationId }),
          ...(command.attemptId === undefined ? {} : { attemptId: command.attemptId }),
          status: 'failed', messageId: null, error: 'QUEUE_FULL' });
        return;
      }
      sendPending += 1;
      const ready = loop ? Promise.resolve() : initializationReady ?? Promise.resolve();
      const task = sendTail.then(() => ready).then(() => urgentFence
        ? emit({ type: 'sendResult', ...workerIdentity()!, requestId: command.requestId,
          operationId: command.operationId, attemptId: command.attemptId, status: 'failed', messageId: null,
          error: 'SIDE_EFFECT_DENIED' })
        : execute(input, command)).catch(() => undefined).finally(() => { sendPending -= 1; });
      sendTail = task.then(() => undefined);
      return;
    }
    if (command.type === 'poll') {
      if (pollPending) return;
      pollPending = true;
      const ready = loop ? Promise.resolve() : initializationReady ?? Promise.resolve();
      const loginKey = `${command.accountId}:${command.workerInstanceId}`;
      void ready.then(() => loginTasks.get(loginKey) ?? Promise.resolve())
        .then(() => execute(input, command)).catch(() => undefined).finally(() => { pollPending = false; });
      return;
    }
    if (command.type === 'reactMessage') {
      if (reactionActive) reactionPending = command;
      else { reactionActive = true; runReaction(command); }
      return;
    }

    const key = capabilityKey(command);
    const pending = capabilityPending.get(key) ?? 0;
    if (pending >= MAX_CAPABILITY_PENDING) {
      const requestBinding = { accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch,
        ...(command.transportOwnerId === undefined ? {} : { transportOwnerId: command.transportOwnerId }),
        ...(command.transportGeneration === undefined ? {} : { transportGeneration: command.transportGeneration }),
        ...(command.writeGrantVersion === undefined ? {} : { writeGrantVersion: command.writeGrantVersion }) };
      if (command.type === 'checkFriendRelation') {
        void emit({ type: 'friendRelationResult', ...requestBinding, requestId: command.requestId,
          targetMid: command.targetMid, status: 'unknown', error: 'QUEUE_FULL' });
      } else if (command.type === 'addFriendByMid') {
        void emit({ type: 'addFriendResult', ...requestBinding, requestId: command.requestId,
          targetMid: command.targetMid, status: 'failed', error: 'QUEUE_FULL' });
      } else {
        void emit({ type: 'error', ...requestBinding,
          code: 'QUEUE_FULL', message: 'Worker capability is busy', retryable: true });
      }
      return;
    }
    capabilityPending.set(key, pending + 1);
    const ready = command.type === 'init' || loop ? Promise.resolve() : initializationReady ?? Promise.resolve();
    const run = () => ready.then(() => execute(input, command)).catch(() => undefined).finally(() => {
      const remaining = (capabilityPending.get(key) ?? 1) - 1;
      if (remaining === 0) capabilityPending.delete(key); else capabilityPending.set(key, remaining);
    });
    if (command.type === 'setSecretState' || command.type === 'loginQr' || command.type === 'loginToken') {
      const loginKey = `${command.accountId}:${command.workerInstanceId}`;
      const previous = loginTasks.get(loginKey) ?? Promise.resolve();
      const task = previous.then(run).catch(() => undefined);
      loginTasks.set(loginKey, task);
      void task.finally(() => { if (loginTasks.get(loginKey) === task) loginTasks.delete(loginKey); }).catch(() => undefined);
      return;
    }
    void run();
  });
}

/** Production bootstrap: no renderer-supplied method names or physical transport state. */
export function startLineWorkerProcess(port: WorkerPort, options: Readonly<{ attachmentRoot: string }>): void {
  runWorkerLoopOnPort(port, (init) => createLinejsAdapter({
    accountId: init.accountId, workerInstanceId: init.workerInstanceId,
    controlEpoch: init.controlEpoch, mode: init.mode,
    ...(init.purpose === 'DOWNLOAD_ONLY' && init.application ? { application: init.application } : {}),
    validateLease: () => true,
    physicalTransport: fetchLineRequest,
  }), { attachmentRoot: options.attachmentRoot,
    attachmentRuntime: { windowsSafetyBroker: createWindowsAttachmentBroker() } });
}
