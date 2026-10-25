import { randomUUID } from 'node:crypto';
import { parseSafeDiagnostic, type SafeDiagnostic } from '@line-agent/contracts';

export const AUDIT_ACTIONS = [
  'app_start', 'app_stop', 'service_start', 'service_stop', 'worker_start', 'worker_stop', 'worker_restart',
  'worker_quarantine', 'worker_exited', 'line_login_started', 'line_login_qr_ready', 'line_login_pin_ready',
  'line_login_succeeded', 'line_login_failed', 'line_auth_invalidated', 'secret_persisted', 'secret_clear',
  'account_control', 'account_mode', 'agent_provider_status', 'agent_codex_login', 'agent_claude_login',
  'agent_codex_logout', 'agent_claude_logout', 'external_monitor_toggle',
  'audit_sink_failed', 'audit_sink_recovered',
  'friend_enrollment', 'friend_relation_initial', 'friend_add_attempt', 'friend_relation_recheck',
  'friend_authorization_precheck', 'friend_grant_commit',
  'worker_operation_error', 'line_catalog_refresh', 'runtime_error',
  'album_photo_download',
] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];
export const AUDIT_INITIATORS = ['user', 'system', 'worker'] as const;
export type AuditInitiator = typeof AUDIT_INITIATORS[number];
export const AUDIT_PHASES = ['requested', 'succeeded', 'failed', 'observed'] as const;
export type AuditPhase = typeof AUDIT_PHASES[number];
export const AUDIT_REASON_CODES = [
  'operator_action', 'startup', 'shutdown', 'worker_exit', 'auth_invalidated', 'recovery', 'provider_status', 'unknown',
] as const;
export type AuditReasonCode = typeof AUDIT_REASON_CODES[number];
export const AUDIT_ERROR_CODES = [
  'DATABASE_WRITE_FAILED', 'FALLBACK_WRITE_FAILED', 'WORKER_STOP_FAILED', 'WORKER_STOP_TIMEOUT',
  'AGENT_AUTH_FAILED', 'SECRET_CLEAR_FAILED', 'UNKNOWN',
  'RELATION_LIST_RPC_FAILED', 'RELATION_LIST_SHAPE_INVALID', 'RELATION_LIST_LIMIT',
  'RELATION_DETAIL_RPC_FAILED', 'RELATION_DETAIL_SHAPE_INVALID', 'RELATION_CANCELLED',
  'RELATION_BINDING_REVOKED', 'RELATION_RESPONSE_TIMEOUT', 'RELATION_WORKER_EXIT',
  'RELATION_OUTCOME_UNKNOWN', 'ENROLLMENT_BINDING_CHANGED', 'SIDE_EFFECT_DENIED', 'NOT_STARTED',
  'TRANSPORT_OUTCOME_UNKNOWN', 'ENROLLMENT_PRECHECK_FAILED', 'ENROLLMENT_GRANT_FAILED',
  'ENROLLMENT_REPLY_FAILED', 'ENROLLMENT_REPLY_UNKNOWN', 'INVALID_COMMAND', 'QUEUE_FULL',
  'CATALOG_REFRESH_FAILED', 'WORKER_OPERATION_FAILED', 'HISTORY_READ_FAILED', 'CHAT_RESOURCE_READ_FAILED',
  'PROFILE_REFRESH_FAILED', 'MESSAGE_SEND_FAILED', 'MESSAGE_UNSEND_FAILED', 'MESSAGE_REACTION_FAILED',
  'FRIEND_RELATION_CHECK_FAILED', 'FRIEND_ADD_FAILED', 'PRIMARY_ADMIN_NOT_FRIEND', 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED',
  'CREDENTIAL_RESTORE_FAILED', 'LINE_SYNC_FAILED',
] as const;
export type AuditErrorCode = typeof AUDIT_ERROR_CODES[number];
export const AUDIT_RESULT_CODES = ['worker_stopped', 'secret_removed', 'agent_auth_action_completed', 'audit_sink_recovered',
  'relation_friend', 'relation_not_friend', 'relation_unknown', 'add_added', 'add_unknown', 'add_failed',
  'precheck_ready', 'authorization_active', 'grant_committed', 'authorization_active_reply_sent',
  'authorization_active_reply_failed', 'authorization_active_reply_unknown', 'authorization_denied',
  'catalog_refresh_recovered'] as const;
export type AuditResultCode = typeof AUDIT_RESULT_CODES[number];

export interface AuditEvent {
  diagnostic?: SafeDiagnostic;
  action: AuditAction;
  phase: AuditPhase;
  initiator: AuditInitiator;
  correlationId: string;
  accountId?: string;
  workerInstanceId?: string;
  loginAttemptId?: string;
  requestId?: string;
  jobId?: string;
  reasonCode?: AuditReasonCode;
  resultCode?: AuditResultCode;
  errorCode?: AuditErrorCode;
  droppedCount?: number;
  createdAt: string;
}

export type AuditFields = Pick<AuditEvent, 'initiator'> & Partial<Pick<AuditEvent,
  'accountId' | 'workerInstanceId' | 'loginAttemptId' | 'requestId' | 'jobId' | 'reasonCode' | 'diagnostic'>>;
export interface OperationalAuditDependencies {
  append(event: AuditEvent): Promise<void>;
  appendFallback(event: AuditEvent): Promise<void>;
  logSinkState(state: 'failed' | 'recovered', errorCode: AuditErrorCode, droppedCount: number): void;
  capacity?: number;
  sinkTimeoutMs?: number;
  fallbackTimeoutMs?: number;
  retryDelayMs?: number;
  flushTimeoutMs?: number;
}

const maxIdLength = 128;
const maxRecordBytes = 8 * 1024;
const boundedId = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || /token|password|secret|oauth|qr|pin/i.test(value)) return undefined;
  if (value.length >= 40 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    && !/^account-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return undefined;
  return value;
};

export function parseOperationalAuditEvent(value: unknown): AuditEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!AUDIT_ACTIONS.includes(input.action as AuditAction) || !AUDIT_PHASES.includes(input.phase as AuditPhase)
    || !AUDIT_INITIATORS.includes(input.initiator as AuditInitiator) || typeof input.correlationId !== 'string'
    || input.correlationId.length < 1 || input.correlationId.length > maxIdLength
    || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) return null;
  const event: AuditEvent = { action: input.action as AuditAction, phase: input.phase as AuditPhase,
    initiator: input.initiator as AuditInitiator, correlationId: input.correlationId, createdAt: input.createdAt };
  if (input.diagnostic !== undefined) {
    const diagnostic = parseSafeDiagnostic(input.diagnostic);
    if (!diagnostic) return null;
    event.diagnostic = diagnostic;
  }
  for (const key of ['accountId', 'workerInstanceId', 'loginAttemptId', 'requestId', 'jobId'] as const) {
    const field = input[key];
    if (field !== undefined) {
      if (typeof field !== 'string' || field.length < 1 || field.length > maxIdLength) return null;
      event[key] = field;
    }
  }
  if (input.reasonCode !== undefined) {
    if (!AUDIT_REASON_CODES.includes(input.reasonCode as AuditReasonCode)) return null;
    event.reasonCode = input.reasonCode as AuditReasonCode;
  }
  if (input.resultCode !== undefined) {
    if (!AUDIT_RESULT_CODES.includes(input.resultCode as AuditResultCode)) return null;
    event.resultCode = input.resultCode as AuditResultCode;
  }
  if (input.errorCode !== undefined) {
    if (!AUDIT_ERROR_CODES.includes(input.errorCode as AuditErrorCode)) return null;
    event.errorCode = input.errorCode as AuditErrorCode;
  }
  if (input.droppedCount !== undefined) {
    if (typeof input.droppedCount !== 'number' || !Number.isSafeInteger(input.droppedCount) || input.droppedCount < 0) return null;
    event.droppedCount = input.droppedCount;
  }
  return event;
}

export function createOperationalAudit(dependencies: OperationalAuditDependencies) {
  const capacity = Math.max(1, dependencies.capacity ?? 2048);
  const queue: AuditEvent[] = [];
  const pendingActions = new Map<string, { action: AuditAction; fields: AuditFields }>();
  // One bounded coalescer for background failures; no per-operation timers or retained errors.
  const recentFailures = new Map<string, { at: number; correlationId: string }>();
  let droppedCount = 0;
  let draining: Promise<void> | undefined;
  let dbFailed = false;
  let fallbackFailed = false;
  const sinkReports = new Set<string>();
  let sinkFailureEvent: AuditEvent | undefined;
  let shutdownAbandoned = false;
  const sinkTimeoutMs = Math.max(1, dependencies.sinkTimeoutMs ?? 2000);
  const fallbackTimeoutMs = Math.max(1, dependencies.fallbackTimeoutMs ?? 2000);
  const retryDelayMs = Math.max(0, dependencies.retryDelayMs ?? 100);
  const flushTimeoutMs = Math.max(1, dependencies.flushTimeoutMs ?? 2000);
  const withTimeout = async <T>(work: () => Promise<T>, timeoutMs: number, code: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); });
    try { return await Promise.race([Promise.resolve().then(work), deadline]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const reportSink = (state: 'failed' | 'recovered', errorCode: AuditErrorCode) => {
    const key = `${state}:${errorCode}`;
    if (sinkReports.has(key)) return;
    sinkReports.add(key);
    sinkReports.delete(`${state === 'failed' ? 'recovered' : 'failed'}:${errorCode}`);
    try { dependencies.logSinkState(state, errorCode, droppedCount); } catch { /* Logging must not escape into lifecycle work. */ }
    const event = makeEvent(state === 'failed' ? 'audit_sink_failed' : 'audit_sink_recovered', 'observed', {
      initiator: 'system', correlationId: randomUUID(), ...(state === 'failed' ? { errorCode } : { resultCode: 'audit_sink_recovered' }),
      diagnostic: { operation: 'audit_sink', stage: 'write', category: 'persistence_failed',
        recovery: state === 'failed' ? 'check_configuration' : 'none', outcome: state === 'failed' ? 'failed' : 'recovered' }, droppedCount });
    // Do not feed a failure into its failed sink. Retain one fixed event and persist it with recovery.
    if (state === 'failed') sinkFailureEvent = event;
    else { if (sinkFailureEvent) enqueue(sinkFailureEvent); sinkFailureEvent = undefined; enqueue(event); }
  };

  const enqueue = (event: AuditEvent): void => {
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > maxRecordBytes) return;
    if (shutdownAbandoned) { droppedCount += 1; return; }
    if (queue.length >= capacity) { queue.shift(); droppedCount += 1; }
    queue.push(event);
    if (!draining) {
      draining = drain().finally(() => { draining = undefined; if (queue.length) startDrain(); });
    }
  };
  const startDrain = () => {
    if (!draining) draining = drain().finally(() => { draining = undefined; if (queue.length) startDrain(); });
  };
  async function drain(): Promise<void> {
    while (queue.length) {
      const event = queue.shift()!;
      let writeError = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await withTimeout(() => dependencies.append(event), sinkTimeoutMs, 'AUDIT_DB_TIMEOUT'); writeError = false; break; }
        catch {
          writeError = true;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
        }
      }
      if (writeError) {
        const wasOnline = !dbFailed;
        dbFailed = true;
        if (wasOnline) reportSink('failed', 'DATABASE_WRITE_FAILED');
        await withTimeout(() => dependencies.appendFallback(event), fallbackTimeoutMs, 'AUDIT_FALLBACK_TIMEOUT').then(() => {
          if (fallbackFailed) { fallbackFailed = false; reportSink('recovered', 'FALLBACK_WRITE_FAILED'); }
        }, () => {
          fallbackFailed = true;
          droppedCount += 1;
          reportSink('failed', 'FALLBACK_WRITE_FAILED');
        });
      } else {
        if (dbFailed) {
          dbFailed = false;
          reportSink('recovered', 'DATABASE_WRITE_FAILED');
        }
      }
    }
  }
  const makeEvent = (action: AuditAction, phase: AuditPhase, fields: AuditFields & {
    correlationId: string; resultCode?: AuditResultCode; errorCode?: AuditErrorCode; droppedCount?: number;
  }): AuditEvent => {
    const event: AuditEvent = { action, phase, initiator: fields.initiator,
      correlationId: boundedId(fields.correlationId)!, createdAt: new Date().toISOString() };
    const accountId = boundedId(fields.accountId);
    const workerInstanceId = boundedId(fields.workerInstanceId);
    const loginAttemptId = boundedId(fields.loginAttemptId);
    const requestId = boundedId(fields.requestId);
    const jobId = boundedId(fields.jobId);
    if (accountId) event.accountId = accountId;
    if (workerInstanceId) event.workerInstanceId = workerInstanceId;
    if (loginAttemptId) event.loginAttemptId = loginAttemptId;
    if (requestId) event.requestId = requestId;
    if (jobId) event.jobId = jobId;
    if (fields.reasonCode) event.reasonCode = fields.reasonCode;
    if (fields.resultCode) event.resultCode = fields.resultCode;
    if (fields.errorCode) event.errorCode = fields.errorCode;
    const diagnostic = parseSafeDiagnostic(fields.diagnostic);
    if (diagnostic) event.diagnostic = diagnostic;
    if (fields.droppedCount !== undefined) event.droppedCount = Math.max(0, Math.trunc(fields.droppedCount));
    return event;
  };

  return {
    failure(diagnostic: SafeDiagnostic, fields: Partial<AuditFields> & { correlationId?: string; background?: boolean } = {}, errorCode: AuditErrorCode = 'UNKNOWN', action: AuditAction = 'runtime_error'): string | undefined {
      const safe = parseSafeDiagnostic(diagnostic);
      if (!safe || safe.category === 'cancelled') return;
      const now = Date.now();
      const key = JSON.stringify([action, errorCode, safe.operation, safe.stage, safe.category, safe.reason, safe.provider, safe.statusCode, safe.outcome,
        boundedId(fields.accountId), boundedId(fields.workerInstanceId), boundedId(fields.requestId), boundedId(fields.jobId), boundedId(fields.loginAttemptId)]);
      // Foreground attempts remain separate even when they reuse a job/attachment ID.
      // Only an owner may explicitly declare a repeating background failure.
      const coalesce = fields.background === true;
      const scopedKey = `${key}:${boundedId(fields.correlationId) ?? ''}`;
      const recent = coalesce ? recentFailures.get(scopedKey) : undefined;
      if (recent && now - recent.at < 30_000) return recent.correlationId;
      if (coalesce && recentFailures.size >= 128) recentFailures.delete(recentFailures.keys().next().value!);
      const correlationId = boundedId(fields.correlationId) ?? boundedId(fields.requestId) ?? randomUUID();
      if (coalesce) recentFailures.set(scopedKey, { at: now, correlationId });
      enqueue(makeEvent(action, 'observed', { ...fields, initiator: fields.initiator ?? 'system',
        correlationId, errorCode, diagnostic: safe }));
      return correlationId;
    },
    request(action: AuditAction, fields: AuditFields): string {
      const correlationId = boundedId(fields.requestId) ?? randomUUID();
      if (pendingActions.size >= capacity) {
        const oldest = pendingActions.keys().next().value as string | undefined;
        if (oldest) { pendingActions.delete(oldest); droppedCount += 1; }
      }
      pendingActions.set(correlationId, { action, fields });
      enqueue(makeEvent(action, 'requested', { ...fields, correlationId }));
      return correlationId;
    },
    complete(correlationId: string, phase: 'succeeded' | 'failed', fields: Partial<AuditFields> & { resultCode?: AuditResultCode; errorCode?: AuditErrorCode } = {}): void {
      const pending = pendingActions.get(correlationId);
      if (!pending) return;
      pendingActions.delete(correlationId);
      enqueue(makeEvent(pending.action, phase, { ...pending.fields, ...fields, correlationId }));
    },
    observed(action: AuditAction, fields: AuditFields & { correlationId?: string; resultCode?: AuditResultCode; errorCode?: AuditErrorCode; droppedCount?: number }): void {
      enqueue(makeEvent(action, 'observed', { ...fields, correlationId: fields.correlationId ?? randomUUID() }));
    },
    outcome(action: AuditAction, phase: 'succeeded' | 'failed', fields: AuditFields & {
      correlationId?: string; resultCode?: AuditResultCode; errorCode?: AuditErrorCode;
    }): void {
      enqueue(makeEvent(action, phase, { ...fields, correlationId: fields.correlationId ?? randomUUID() }));
    },
    async flush(): Promise<void> {
      if (!draining || shutdownAbandoned) return;
      const activeDrain = draining;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        activeDrain.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), flushTimeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        shutdownAbandoned = true;
        droppedCount += queue.length + 1; // Count queued events and the in-flight event with unknown outcome.
        queue.length = 0;
      }
    },
    get droppedCount(): number { return droppedCount; },
    health() { return { databaseFailed: dbFailed, fallbackFailed, droppedCount, queuedCount: queue.length, failureKeys: recentFailures.size }; },
    sinkEvents(): AuditEvent[] { return sinkFailureEvent ? [sinkFailureEvent] : []; },
    get pendingActionCount(): number { return pendingActions.size; },
  };
}

export type OperationalAudit = ReturnType<typeof createOperationalAudit>;
