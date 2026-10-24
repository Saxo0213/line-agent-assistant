import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const EXTERNAL_MONITOR_FAILURE_CODES = [
  'external_monitor_authority_stale',
  'external_monitor_checkpoint_changed',
  'external_monitor_source_changed',
  'external_monitor_reader_startup_failed',
  'external_monitor_reader_failed',
  'external_monitor_database_failed',
  'external_monitor_unknown',
] as const;

export type ExternalMonitorFailureCode = typeof EXTERNAL_MONITOR_FAILURE_CODES[number];
export type ExternalMonitorFailureStage = 'startup' | 'runtime';
export const EXTERNAL_MONITOR_FAILURE_PHASES = [
  'facade_checkpoint_fence', 'facade_startup_selection', 'reader_resource_verification', 'private_directory_preparation', 'reader_request_resources', 'owner_admission_marker', 'child_identity',
  'protocol_source_ready', 'directory_callback_ack', 'first_poll_callback_ack', 'cleanup',
] as const;
export type ExternalMonitorFailurePhase = typeof EXTERNAL_MONITOR_FAILURE_PHASES[number];
export const EXTERNAL_MONITOR_DIAGNOSTIC_PRODUCERS = ['manual_start', 'startup_resume'] as const;
export type ExternalMonitorDiagnosticProducer = typeof EXTERNAL_MONITOR_DIAGNOSTIC_PRODUCERS[number];
export type ExternalMonitorFailureDetail =
  | 'reader_source_io_error' | 'reader_source_identity_changed' | 'reader_source_changed'
  | 'node_enoent' | 'node_eacces' | 'node_eperm' | 'node_enotdir' | 'node_eisdir'
  | 'node_emfile' | 'node_enfile' | 'node_ebusy' | 'node_eio' | 'node_epipe' | 'node_etimedout'
  | 'private_directory_path_validation' | 'private_directory_acl_command_failed'
  | 'private_directory_acl_command_timeout' | 'private_directory_acl_unexpected_output';
const externalMonitorFailureDetails: readonly ExternalMonitorFailureDetail[] = [
  'reader_source_io_error', 'reader_source_identity_changed', 'reader_source_changed',
  'node_enoent', 'node_eacces', 'node_eperm', 'node_enotdir', 'node_eisdir', 'node_emfile',
  'node_enfile', 'node_ebusy', 'node_eio', 'node_epipe', 'node_etimedout',
  'private_directory_path_validation', 'private_directory_acl_command_failed',
  'private_directory_acl_command_timeout', 'private_directory_acl_unexpected_output',
];

const nativeFailureCodes = new Set([
  'unsupported_build', 'build_rotation', 'candidate_missing', 'candidate_ambiguous', 'candidate_limit',
  'process_missing', 'process_ambiguous', 'process_limit', 'source_reparse_or_type', 'source_too_large',
  'source_io_error', 'owner_invalid', 'key_unavailable', 'snapshot_hot_journal', 'snapshot_source_changed',
  'snapshot_backup_failed', 'snapshot_backup_init_failed', 'snapshot_backup_no_progress', 'snapshot_source_unavailable',
  'snapshot_key_mismatch', 'snapshot_wal_no_commit', 'snapshot_wal_invalid', 'snapshot_database_header_invalid',
  'snapshot_size_limit', 'mid_or_schema_mismatch', 'official_account_not_active', 'deadline_invalid', 'protocol_invalid',
  'line_window_ambiguous', 'line_window_close_failed', 'source_row_invalid', 'source_row_too_large',
  'source_conversation_invalid', 'source_schema_unsupported', 'source_result_too_large', 'cancelled',
  'reader_request_invalid', 'reader_cancelled', 'reader_resource_integrity_failed', 'reader_handshake_invalid',
  'reader_inventory_shape_invalid', 'reader_process_count_invalid', 'reader_source_identity_changed',
  'reader_monitor_ready_invalid', 'reader_progress_invalid', 'reader_auxiliary_queue_full',
  'reader_attachment_request_invalid', 'reader_auth_candidates_invalid', 'reader_attachment_metadata_invalid',
  'reader_directory_page_invalid', 'reader_page_invalid', 'reader_cursor_invalid', 'reader_process_failed',
  'reader_process_closed', 'reader_owner_request_invalid', 'reader_owner_marker_invalid', 'reader_owner_marker_changed',
  'reader_owner_directory_invalid', 'reader_owner_directory_changed', 'reader_deadline_exceeded',
  'reader_inventory_invalid', 'reader_source_unsupported', 'reader_close_invalid', 'reader_result_invalid',
  'reader_admission_required', 'reader_already_active', 'reader_auxiliary_failed', 'reader_catalog_callback_required',
  'reader_catalog_page_invalid', 'reader_child_unavailable', 'reader_cleanup_uncertain', 'reader_child_closed_before_ready',
  'reader_child_identity_invalid', 'reader_child_identity_changed', 'reader_closed_early', 'reader_closed',
  'reader_completion_invalid', 'reader_fixture_bridge_invalid', 'reader_fixture_root_invalid', 'reader_frame_invalid',
  'reader_frame_queue_full', 'reader_inventory_result_invalid', 'reader_main_identity_invalid', 'reader_process_image_invalid',
  'reader_owner_cleanup_uncertain', 'reader_owner_identity_unavailable', 'reader_queue_limit_invalid', 'reader_trailing_bytes',
  'reader_trailing_frame', 'reader_waiter_limit', 'reader_progress_timeout', 'reader_request_root_changed',
  'reader_request_root_invalid', 'reader_stale_entry_changed', 'reader_stale_entry_unknown', 'reader_stale_inventory_limit',
  'reader_stale_marker_changed', 'reader_stale_marker_invalid', 'reader_stale_owner_live', 'reader_stale_owner_unknown',
  'reader_stale_provisional_not_expired', 'reader_inventory_result_invalid', 'reader_process_count_invalid',
  'reader_owner_directory_invalid', 'reader_owner_marker_invalid', 'reader_owner_marker_changed',
]);

const errorCodePattern = /^[a-z][a-z0-9_]*$/;

export class ExternalMonitorDiagnosticFailure extends Error {
  constructor(readonly code: ExternalMonitorFailureCode, readonly stage: ExternalMonitorFailureStage,
    readonly detail?: ExternalMonitorFailureDetail, readonly phase?: ExternalMonitorFailurePhase) {
    super(code);
    this.name = 'ExternalMonitorDiagnosticFailure';
  }
}

export function classifyExternalMonitorFailure(error: unknown, stage: ExternalMonitorFailureStage): ExternalMonitorFailureCode {
  if (error instanceof ExternalMonitorDiagnosticFailure) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (message === 'External source authority is stale') return 'external_monitor_authority_stale';
  if (message === 'Direct LINE source checkpoint or authority changed.'
    || message === 'Completed LINE import checkpoint could not be verified.'
    || message === 'Persisted LINE import cursor is invalid') return 'external_monitor_checkpoint_changed';
  if (message === 'source_changed' || message === 'reader_source_identity_changed'
    || message === 'reader_source_unsupported:source_changed') return 'external_monitor_source_changed';
  if (nativeFailureCodes.has(message) || nativeFailureCodeFromUnsupported(message) !== null) {
    return stage === 'startup' ? 'external_monitor_reader_startup_failed' : 'external_monitor_reader_failed';
  }
  if (externalMonitorFailureDetail(error)?.startsWith('node_')) {
    return stage === 'startup' ? 'external_monitor_reader_startup_failed' : 'external_monitor_reader_failed';
  }
  return 'external_monitor_unknown';
}

export function externalMonitorFailureDetail(error: unknown): ExternalMonitorFailureDetail | undefined {
  if (error instanceof ExternalMonitorDiagnosticFailure) return error.detail;
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code === 'string') {
    const nodeDetails: Record<string, ExternalMonitorFailureDetail> = {
      ENOENT: 'node_enoent', EACCES: 'node_eacces', EPERM: 'node_eperm', ENOTDIR: 'node_enotdir',
      EISDIR: 'node_eisdir', EMFILE: 'node_emfile', ENFILE: 'node_enfile', EBUSY: 'node_ebusy',
      EIO: 'node_eio', EPIPE: 'node_epipe', ETIMEDOUT: 'node_etimedout',
    };
    if (nodeDetails[candidate.code]) return nodeDetails[candidate.code];
  }
  const message = candidate.message;
  if (typeof message === 'string') {
    if (nativeFailureCodes.has(message)) return message as ExternalMonitorFailureDetail;
    const unsupportedCode = nativeFailureCodeFromUnsupported(message);
    if (unsupportedCode) return unsupportedCode as ExternalMonitorFailureDetail;
  }
  if (message === 'source_io_error') return 'reader_source_io_error';
  if (message === 'reader_source_identity_changed') return 'reader_source_identity_changed';
  if (message === 'source_changed' || message === 'reader_source_unsupported:source_changed') return 'reader_source_changed';
  return undefined;
}

/** Discards repository exception text and any attached database details immediately. */
export function externalMonitorDatabaseFailure(error: unknown, stage: ExternalMonitorFailureStage): ExternalMonitorDiagnosticFailure {
  const known = classifyExternalMonitorFailure(error, stage);
  return new ExternalMonitorDiagnosticFailure(known === 'external_monitor_unknown'
    ? 'external_monitor_database_failed' : known, stage);
}

export async function recordExternalMonitorDiagnostic(
  filePath: string | undefined,
  stage: ExternalMonitorFailureStage,
  code: ExternalMonitorFailureCode,
  detail?: ExternalMonitorFailureDetail,
  phase?: ExternalMonitorFailurePhase,
  producer?: ExternalMonitorDiagnosticProducer,
  onSinkFailure?: () => void,
  correlationId?: string,
): Promise<void> {
  if (!filePath) return;
  const safeCode = EXTERNAL_MONITOR_FAILURE_CODES.includes(code) ? code : 'external_monitor_unknown';
  const safeDetail = detail && (externalMonitorFailureDetails.includes(detail) || nativeFailureCodes.has(detail)) ? detail : undefined;
  const safePhase = phase && EXTERNAL_MONITOR_FAILURE_PHASES.includes(phase) ? phase : undefined;
  const safeProducer = producer && EXTERNAL_MONITOR_DIAGNOSTIC_PRODUCERS.includes(producer) ? producer : undefined;
  const record = { version: 1, createdAt: new Date().toISOString(), stage, code: safeCode,
    ...(correlationId && /^[A-Za-z0-9_-]{1,128}$/.test(correlationId) && !/token|password|secret|oauth|qr|pin/i.test(correlationId) ? { correlationId } : {}),
    ...(safeProducer ? { producer: safeProducer } : {}),
    ...(safePhase ? { phase: safePhase } : {}),
    ...(safeDetail ? { detail: safeDetail } : {}) };
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > 512) return;
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch {
    try { onSinkFailure?.(); } catch { /* Diagnostics cannot affect monitor ownership. */ }
    // A best-effort local diagnostic must never affect monitor ownership or state.
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function clearExternalMonitorDiagnostic(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await rm(filePath, { force: true }).catch(() => undefined);
}

function nativeFailureCodeFromUnsupported(message: string): string | null {
  const prefix = 'reader_source_unsupported:';
  if (!message.startsWith(prefix)) return null;
  const code = message.slice(prefix.length);
  return errorCodePattern.test(code) && nativeFailureCodes.has(code) ? code : null;
}
