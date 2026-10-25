import { z } from 'zod';
import { IPC_ACTION_CODES } from './ipc-actions.js';

/** Existing application-owned identities only; never URLs, paths or external RPC IDs. */
export type DiagnosticIdentity = { accountId?: string; workerInstanceId?: string; requestId?: string; jobId?: string; loginAttemptId?: string; correlationId?: string; background?: boolean };

/** Operational evidence only. Never add caller-controlled text or error objects here. */
export const DIAGNOSTIC_OPERATIONS = [
  'init', 'adoptDownloadAuth', 'loginQr', 'loginToken', 'setSecretState', 'poll', 'ackBatch', 'history',
  'chatResourceRead', 'refreshOwnProfile', 'cancelChatResourceRead', 'sendText', 'manualSendText', 'sendMedia',
  'unsendMessage', 'reactMessage', 'checkFriendRelation', 'addFriendByMid', 'downloadAttachment',
  'cancelAttachmentDownload', 'revokeControl', 'stop', 'ipc', 'database', 'attachment', 'agent', 'mcp',
  'external_monitor', 'chat_resource', 'startup', 'shutdown', 'snapshot', 'audit_sink', 'line_ingest',
  'delivery', 'secret_store', 'provider_auth', 'native_reader', 'renderer', 'catalog_refresh', 'unknown',
  'note_list', 'note_detail', 'album_list', 'album_photos', 'photo_download',
] as const;
export const DIAGNOSTIC_STAGES = ['admission', 'bootstrap', 'dispatch', 'execute', 'response', 'persist',
  'publish', 'read', 'write', 'spawn', 'parse', 'cancel', 'cleanup', 'shutdown', 'recover', 'authenticate',
  'queue', 'store', 'download', 'prepare', 'unknown', 'archive_contains', 'facade_checkpoint_fence', 'facade_startup_selection',
  'reader_resource_verification', 'private_directory_preparation', 'reader_request_resources', 'owner_admission_marker',
  'child_identity', 'protocol_source_ready', 'directory_callback_ack', 'first_poll_callback_ack'] as const;
export const DIAGNOSTIC_CATEGORIES = ['unavailable', 'invalid_input', 'unsupported', 'invalid_response',
  'timeout', 'cancelled', 'denied', 'stale_binding', 'authentication_required', 'persistence_failed',
  'transport_failed', 'process_start_failed', 'process_exit', 'event_publish_failed', 'queue_full',
  'outcome_unknown', 'unknown'] as const;
export const DIAGNOSTIC_RECOVERIES = ['retry', 'reconnect', 'relogin', 'check_configuration', 'reopen_app',
  'wait', 'none', 'inspect_outcome'] as const;
export const DIAGNOSTIC_REASONS = ['external_monitor_authority_stale', 'external_monitor_checkpoint_changed',
  'external_monitor_source_changed', 'external_monitor_reader_startup_failed', 'external_monitor_reader_failed',
  'external_monitor_database_failed', 'external_monitor_unknown', 'bootstrap_failure', 'list_get_transport_failure',
  'response_code_invalid', 'response_shape_invalid', 'normalization_failure', 'response_validation',
  'timeout', 'cancellation', 'unknown', 'AGENT_IDENTITY_MISMATCH', 'LOGIN_TIMEOUT', 'LOGIN_IN_PROGRESS', 'LOGIN_ATTEMPT_REPLACED', 'LOGIN_FAILED'] as const;
export const DIAGNOSTIC_FAILURE_KINDS = ['linejs_internal', 'effect_denied', 'type_error', 'range_error', 'timeout_error', 'abort_error', 'other'] as const;
export const SafeDiagnosticSchema = z.object({
  ipcAction: z.enum(IPC_ACTION_CODES).optional(),
  operation: z.enum(DIAGNOSTIC_OPERATIONS), stage: z.enum(DIAGNOSTIC_STAGES),
  category: z.enum(DIAGNOSTIC_CATEGORIES), recovery: z.enum(DIAGNOSTIC_RECOVERIES),
  reason: z.enum(DIAGNOSTIC_REASONS).optional(),
  failureKind: z.enum(DIAGNOSTIC_FAILURE_KINDS).optional(),
  provider: z.enum(['codex', 'claude']).optional(),
  outcome: z.enum(['not_started', 'failed', 'unknown', 'recovered']).optional(),
  statusCode: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  upstreamCode: z.union([z.number().int().min(-1_000_000_000).max(1_000_000_000), z.enum(['missing', 'non_numeric'])]).optional(),
});
export type SafeDiagnostic = z.infer<typeof SafeDiagnosticSchema>;
export function parseSafeDiagnostic(value: unknown): SafeDiagnostic | undefined {
  try { const result = SafeDiagnosticSchema.safeParse(value); return result.success ? result.data : undefined; }
  catch { return undefined; }
}

/** Inspect only platform-controlled discriminants; exception text/cause never leaves the caller. */
export function diagnosticFailure(operation: SafeDiagnostic['operation'], stage: SafeDiagnostic['stage'], error?: unknown,
  outcome: SafeDiagnostic['outcome'] = 'failed'): SafeDiagnostic {
  let value: { name?: unknown; code?: unknown } = {};
  try {
    if (error && typeof error === 'object') {
      const candidate = error as { name?: unknown; code?: unknown };
      value = { name: candidate.name, code: candidate.code };
    }
  } catch { /* Hostile getters are not diagnostic evidence. */ }
  const category: SafeDiagnostic['category'] = value.name === 'AbortError' ? 'cancelled'
    : value.code === 'WORKER_EVENT_QUEUE_FULL' ? 'queue_full' : value.code === 'WORKER_EVENT_SINK_FAILED' ? 'event_publish_failed'
    : value.name === 'TimeoutError' || value.code === 'ETIMEDOUT' ? 'timeout'
      : value.code === 'ENOENT' ? 'unavailable' : value.code === 'EACCES' || value.code === 'EPERM' ? 'denied'
        : stage === 'persist' || stage === 'write' ? 'persistence_failed'
          : stage === 'spawn' ? 'process_start_failed' : stage === 'parse' || stage === 'response' ? 'invalid_response'
            : stage === 'publish' ? 'event_publish_failed' : 'unknown';
  return { operation, stage, category, outcome,
    recovery: outcome === 'unknown' ? 'inspect_outcome' : category === 'cancelled' ? 'none'
      : category === 'denied' || category === 'unavailable' ? 'check_configuration' : 'retry' };
}
