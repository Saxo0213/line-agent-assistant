import {
  DIAGNOSTIC_DETAIL_PATTERN, SEND_DETAIL_MAX_CHARS, SEND_DETAIL_PATTERN, talkServerError,
  type LineWorkerEvent, type SafeDiagnostic,
} from '@line-agent/contracts';
import { AUDIT_ERROR_CODES, type AuditErrorCode, type OperationalAudit } from './operational-audit.js';

/**
 * The real cause of one failed or unknown LINE send item.
 * The worker keeps a code in `sendResult.error`. The gateway keeps its reason in the thrown error.
 * This module keeps both as bounded codes: letters, digits and _ : . - only, and never a path, key, token, ID or message text.
 */
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;

export type GatewayFaultCode =
  | 'queue_full' | 'media_queue_full' | 'mode_not_acknowledged' | 'stale_binding' | 'cancelled'
  | 'duplicate_request' | 'worker_stopping' | 'gateway_error';
export type LocalFaultCode = 'result_mismatch' | 'no_message_id' | 'process_error';
export type SendOutcome = 'failed' | 'unknown';

export type SendFault =
  | { source: 'worker'; outcome: SendOutcome; code: string | null; detail: string | null }
  | { source: 'gateway'; outcome: SendOutcome; code: GatewayFaultCode }
  | { source: 'local'; outcome: SendOutcome; code: LocalFaultCode };

const WORKER_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const DB_CODE_MAX = 64;
/** The DB check on agent_line_sends.error_code allows only a-z and _ (no digits), so the digit 2 of "e2ee" is dropped. */
const STAGE_DB_SLUG: Readonly<Record<string, string>> = {
  media_size: 'media_size', e2ee_flow: 'ee_flow', encrypt: 'encrypt', obs_upload: 'obs_upload',
  obs_preview: 'obs_preview', e2ee_message: 'ee_message',
};

/** Maps a thrown gateway error to a bounded code. The error text itself never leaves this function. */
export function gatewayFaultCode(error: unknown): GatewayFaultCode {
  const message = error instanceof Error ? error.message : '';
  if (/media queue is full/i.test(message)) return 'media_queue_full';
  if (/QUEUE_FULL|queue is full/i.test(message)) return 'queue_full';
  if (/mode not acknowledged/i.test(message)) return 'mode_not_acknowledged';
  if (/stale worker binding|capability is not current/i.test(message)) return 'stale_binding';
  if (/cancel/i.test(message)) return 'cancelled';
  if (/duplicate worker request/i.test(message)) return 'duplicate_request';
  if (/stopping|closing/i.test(message)) return 'worker_stopping';
  return 'gateway_error';
}

export function gatewayFault(error: unknown, outcome: SendOutcome = 'unknown'): SendFault {
  return { source: 'gateway', outcome, code: gatewayFaultCode(error) };
}

export function workerFault(result: Pick<SendResult, 'error' | 'detail'>, outcome: SendOutcome): SendFault {
  const code = typeof result.error === 'string' && WORKER_CODE.test(result.error) ? result.error : null;
  const detail = typeof result.detail === 'string' && result.detail.length <= SEND_DETAIL_MAX_CHARS
    && SEND_DETAIL_PATTERN.test(result.detail) ? result.detail : null;
  return { source: 'worker', outcome, code, detail };
}

/** Detail text for the MCP result and the Agent. Example: `UPLOAD_FAILED:obs_upload:ObsHttpError:403`. */
export function sendFaultDetail(fault: SendFault): string {
  if (fault.source === 'gateway') return `gateway:${fault.code}`;
  if (fault.source === 'local') return fault.code;
  return [fault.code ?? 'worker_no_code', fault.detail].filter((part) => part !== null).join(':').slice(0, SEND_DETAIL_MAX_CHARS);
}

/** Parts of a worker detail: `stage[:class[:number]]`. */
function detailParts(detail: string | null): { stage?: string; errorClass?: string; number?: number } {
  if (detail === null) return {};
  const [stage, second, third] = detail.split(':');
  const parts: { stage?: string; errorClass?: string; number?: number } = {};
  if (stage !== undefined && Object.hasOwn(STAGE_DB_SLUG, stage)) parts.stage = stage;
  for (const segment of [second, third]) {
    if (segment === undefined) continue;
    if (/^-?\d{1,10}$/.test(segment)) parts.number = Number(segment);
    else if (/^[A-Za-z]{1,40}$/.test(segment)) parts.errorClass = segment;
  }
  return parts;
}

/**
 * Code for agent_line_sends.error_code (check `^[a-z_]{1,64}$`). It keeps the worker code, the upload stage and the error class
 * when they fit. A code that does not fit is written as plain `send_failed` / `send_unknown`; the audit row holds the full detail.
 */
export function sendFaultDbCode(fault: SendFault): string {
  const base = fault.outcome === 'failed' ? 'send_failed' : 'send_unknown';
  const fits = (value: string): boolean => value.length <= DB_CODE_MAX && /^[a-z_]+$/.test(value);
  if (fault.source !== 'worker') {
    const mapped = `${base}_${fault.source === 'gateway' ? 'gateway_' : ''}${fault.code}`;
    return fits(mapped) ? mapped : base;
  }
  if (fault.code === null) return base;
  const code = `${base}_${fault.code.toLowerCase()}`;
  if (!fits(code)) return base;
  const { stage, errorClass } = detailParts(fault.detail);
  const withStage = stage === undefined ? code : `${code}_${STAGE_DB_SLUG[stage]}`;
  if (!fits(withStage)) return code;
  const withClass = errorClass === undefined ? withStage : `${withStage}_${errorClass.toLowerCase()}`;
  return fits(withClass) ? withClass : withStage;
}

const SERVER_CODE = /^LINE_(?:TALK|RELATION_ADD)_[A-Z_]+$/;

function auditErrorCode(fault: SendFault): AuditErrorCode {
  if (fault.source === 'gateway') {
    if (fault.code === 'queue_full' || fault.code === 'media_queue_full') return 'QUEUE_FULL';
    return fault.code === 'gateway_error' ? 'MESSAGE_SEND_FAILED' : 'NOT_STARTED';
  }
  if (fault.source === 'worker' && fault.code !== null && fault.code !== 'UNKNOWN'
    && AUDIT_ERROR_CODES.includes(fault.code as AuditErrorCode)) return fault.code as AuditErrorCode;
  return 'MESSAGE_SEND_FAILED';
}

export type SendFaultOperation = 'sendText' | 'manualSendText' | 'sendMedia' | 'unsendMessage';

function auditDiagnostic(fault: SendFault, operation: SendFaultOperation): SafeDiagnostic {
  const parts = fault.source === 'worker' ? detailParts(fault.detail) : {};
  const stage = parts.stage;
  // A LINE Talk code keeps its numeric upstream code; any other worker detail keeps its trailing number.
  const talkName = fault.source === 'worker' && fault.code?.startsWith('LINE_TALK_') ? fault.code.slice('LINE_TALK_'.length) : undefined;
  const number = talkName === undefined ? parts.number : talkServerError(talkName)?.upstreamCode ?? parts.number;
  const category = ((): SafeDiagnostic['category'] => {
    if (fault.source === 'gateway') {
      if (fault.code === 'queue_full' || fault.code === 'media_queue_full') return 'queue_full';
      if (fault.code === 'mode_not_acknowledged' || fault.code === 'stale_binding') return 'stale_binding';
      return fault.code === 'cancelled' ? 'cancelled' : 'unavailable';
    }
    if (fault.source === 'local') return 'invalid_response';
    if (fault.outcome === 'unknown' || fault.code === 'TRANSPORT_OUTCOME_UNKNOWN') return 'outcome_unknown';
    if (fault.code === 'UPLOAD_FAILED') return 'transport_failed';
    if (fault.code === 'FILE_UNREADABLE') return 'unavailable';
    if (fault.code === 'FILE_CHANGED') return 'invalid_input';
    if (fault.code !== null && (fault.code === 'SIDE_EFFECT_DENIED' || fault.code === 'LOCAL_ROUTE_DENIED' || SERVER_CODE.test(fault.code))) return 'denied';
    return 'unknown';
  })();
  const auditStage = ((): SafeDiagnostic['stage'] => {
    if (fault.source === 'gateway') return 'admission';
    if (stage === 'media_size' || stage === 'e2ee_flow' || stage === 'encrypt') return 'prepare';
    if (stage === 'obs_upload' || stage === 'obs_preview') return 'write';
    return stage === 'e2ee_message' ? 'execute' : 'response';
  })();
  // The full cause text goes into the diagnostic detail when it fits the audit pattern; otherwise the row keeps the enums only.
  const text = sendFaultDetail(fault);
  return { operation, stage: auditStage, category,
    ...(DIAGNOSTIC_DETAIL_PATTERN.test(text) ? { detail: text } : {}),
    recovery: fault.outcome === 'unknown' ? 'inspect_outcome' : category === 'denied' ? 'check_configuration' : 'retry',
    outcome: fault.source === 'gateway' ? 'not_started' : fault.outcome,
    ...(number === undefined ? {} : number >= 100 && number <= 599 ? { upstreamStatus: number } : { upstreamCode: number }) };
}

/**
 * Writes one operational audit row for a failed or unknown send item. The row holds enums and numbers only (the audit table
 * has no free-text field), so the full text detail also goes to agent_line_sends.error_code and to the MCP result.
 */
export function recordSendFault(audit: Pick<OperationalAudit, 'observed'> | undefined,
  input: { accountId: string; jobId?: string; requestId: string; operation: SendFaultOperation }, fault: SendFault): void {
  if (!audit) return;
  try {
    audit.observed('worker_operation_error', { initiator: 'system', accountId: input.accountId, requestId: input.requestId,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      errorCode: auditErrorCode(fault), diagnostic: auditDiagnostic(fault, input.operation) });
  } catch { /* The audit never blocks or changes a send result. */ }
}
