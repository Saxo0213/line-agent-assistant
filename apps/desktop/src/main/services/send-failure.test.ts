import { describe, expect, it, vi } from 'vitest';
import { LINE_SERVER_ERROR_CODES, SEND_DETAIL_MAX_CHARS, SEND_DETAIL_PATTERN, parseSafeDiagnostic } from '@line-agent/contracts';
import {
  gatewayFaultCode, recordSendFault, sendFaultDbCode, sendFaultDetail, workerFault, gatewayFault,
  type GatewayFaultCode, type SendFault,
} from './send-failure.js';

const DB_CHECK = /^[a-z_]{1,64}$/;

describe('worker fault mapping', () => {
  const cases: Array<[string, SendFault, string, string]> = [
    ['upload with stage, class and number', workerFault({ error: 'UPLOAD_FAILED', detail: 'obs_upload:ObsHttpError:403' }, 'failed'),
      'send_failed_upload_failed_obs_upload_obshttperror', 'UPLOAD_FAILED:obs_upload:ObsHttpError:403'],
    ['upload preview stage', workerFault({ error: 'UPLOAD_FAILED', detail: 'obs_preview:Error' }, 'failed'),
      'send_failed_upload_failed_obs_preview_error', 'UPLOAD_FAILED:obs_preview:Error'],
    ['upload message seal stage (digit 2 removed from the DB slug)', workerFault({ error: 'UPLOAD_FAILED', detail: 'e2ee_message:TypeError' }, 'failed'),
      'send_failed_upload_failed_ee_message_typeerror', 'UPLOAD_FAILED:e2ee_message:TypeError'],
    ['upload e2ee flow stage', workerFault({ error: 'UPLOAD_FAILED', detail: 'e2ee_flow' }, 'failed'),
      'send_failed_upload_failed_ee_flow', 'UPLOAD_FAILED:e2ee_flow'],
    ['upload encrypt stage', workerFault({ error: 'UPLOAD_FAILED', detail: 'encrypt:RangeError' }, 'failed'),
      'send_failed_upload_failed_encrypt_rangeerror', 'UPLOAD_FAILED:encrypt:RangeError'],
    ['upload without detail', workerFault({ error: 'UPLOAD_FAILED' }, 'failed'), 'send_failed_upload_failed', 'UPLOAD_FAILED'],
    ['file changed', workerFault({ error: 'FILE_CHANGED' }, 'failed'), 'send_failed_file_changed', 'FILE_CHANGED'],
    ['file unreadable', workerFault({ error: 'FILE_UNREADABLE' }, 'failed'), 'send_failed_file_unreadable', 'FILE_UNREADABLE'],
    ['side effect denied', workerFault({ error: 'SIDE_EFFECT_DENIED' }, 'failed'), 'send_failed_side_effect_denied', 'SIDE_EFFECT_DENIED'],
    ['side effect denied in a media stage', workerFault({ error: 'SIDE_EFFECT_DENIED', detail: 'obs_preview:EffectDeniedError' }, 'failed'),
      'send_failed_side_effect_denied_obs_preview_effectdeniederror', 'SIDE_EFFECT_DENIED:obs_preview:EffectDeniedError'],
    ['local route denied', workerFault({ error: 'LOCAL_ROUTE_DENIED' }, 'failed'), 'send_failed_local_route_denied', 'LOCAL_ROUTE_DENIED'],
    ['unknown transport outcome', workerFault({ error: 'TRANSPORT_OUTCOME_UNKNOWN' }, 'unknown'),
      'send_unknown_transport_outcome_unknown', 'TRANSPORT_OUTCOME_UNKNOWN'],
    ['no worker code', workerFault({ error: null }, 'failed'), 'send_failed', 'worker_no_code'],
    ['worker code that is not a plain code', workerFault({ error: 'bad code with spaces' }, 'failed'), 'send_failed', 'worker_no_code'],
    ['worker code with a digit', workerFault({ error: 'CODE_42' }, 'failed'), 'send_failed', 'CODE_42'],
    ['identity mismatch', { source: 'local', outcome: 'unknown', code: 'result_mismatch' }, 'send_unknown_result_mismatch', 'result_mismatch'],
    ['sent without message ID', { source: 'local', outcome: 'unknown', code: 'no_message_id' }, 'send_unknown_no_message_id', 'no_message_id'],
  ];
  it.each(cases)('%s', (_name, fault, dbCode, detail) => {
    expect(sendFaultDbCode(fault)).toBe(dbCode);
    expect(sendFaultDbCode(fault)).toMatch(DB_CHECK);
    expect(sendFaultDetail(fault)).toBe(detail);
    expect(sendFaultDetail(fault)).toMatch(SEND_DETAIL_PATTERN);
  });

  it('writes a DB code that fits the check for every LINE server code', () => {
    for (const code of LINE_SERVER_ERROR_CODES) {
      for (const outcome of ['failed', 'unknown'] as const) {
        const fault = workerFault({ error: code }, outcome);
        expect(sendFaultDbCode(fault)).toMatch(DB_CHECK);
        expect(sendFaultDetail(fault)).toBe(code);
      }
    }
    expect(sendFaultDbCode(workerFault({ error: 'LINE_TALK_ABUSE_BLOCK' }, 'failed'))).toBe('send_failed_line_talk_abuse_block');
  });

  it('falls back to the plain code when the mapped code is longer than 64 characters', () => {
    const longCode = `LINE_TALK_${'A'.repeat(48)}`;
    expect(sendFaultDbCode(workerFault({ error: longCode }, 'failed'))).toBe('send_failed');
    const nearLimit = `LINE_TALK_${'A'.repeat(30)}`;
    const withClass = workerFault({ error: nearLimit, detail: 'obs_upload:ObsHttpError' }, 'failed');
    expect(sendFaultDbCode(withClass)).toMatch(DB_CHECK);
  });

  it('drops a worker detail that is unsafe or too long', () => {
    expect(workerFault({ error: 'UPLOAD_FAILED', detail: '/etc/passwd' }, 'failed')).toMatchObject({ detail: null });
    expect(workerFault({ error: 'UPLOAD_FAILED', detail: 'a'.repeat(SEND_DETAIL_MAX_CHARS + 1) }, 'failed')).toMatchObject({ detail: null });
  });
});

describe('gateway fault mapping', () => {
  const cases: Array<[string, GatewayFaultCode]> = [
    ['Worker send queue is full (QUEUE_FULL)', 'queue_full'],
    ['Worker media queue is full (QUEUE_FULL)', 'media_queue_full'],
    ['Worker mode not acknowledged for LINE send (protocol handshake required)', 'mode_not_acknowledged'],
    ['Stale worker binding', 'stale_binding'],
    ['Worker send cancelled before media admission.', 'cancelled'],
    ['Worker send cancelled before worker admission', 'cancelled'],
    ['Duplicate worker request ID', 'duplicate_request'],
    ['Worker is stopping', 'worker_stopping'],
    ['Worker gateway is closing', 'worker_stopping'],
    ['something else entirely /secret/path token=abc', 'gateway_error'],
  ];
  it.each(cases)('maps "%s" to %s', (message, code) => {
    const fault = gatewayFault(Object.assign(new Error(message), { name: 'ManualSendNotStartedError' }));
    expect(fault).toEqual({ source: 'gateway', outcome: 'unknown', code });
    expect(gatewayFaultCode(new Error(message))).toBe(code);
    expect(sendFaultDbCode(fault)).toBe(`send_unknown_gateway_${code}`);
    expect(sendFaultDbCode(fault)).toMatch(DB_CHECK);
    expect(sendFaultDetail(fault)).toBe(`gateway:${code}`);
    expect(sendFaultDetail(fault)).toMatch(SEND_DETAIL_PATTERN);
  });
  it('maps a value that is not an Error to gateway_error and never copies its text', () => {
    expect(gatewayFaultCode('Stale worker binding')).toBe('gateway_error');
    expect(gatewayFaultCode(null)).toBe('gateway_error');
  });
});

describe('audit row', () => {
  const run = (fault: SendFault, operation: 'sendText' | 'sendMedia' = 'sendMedia') => {
    const observed = vi.fn();
    recordSendFault({ observed }, { accountId: 'acct-1', jobId: 'job-1', requestId: 'req-1', operation }, fault);
    return observed;
  };
  it('writes an allowed action, error code and a valid safe diagnostic for a media upload failure', () => {
    const observed = run(workerFault({ error: 'UPLOAD_FAILED', detail: 'obs_upload:ObsHttpError:403' }, 'failed'));
    expect(observed).toHaveBeenCalledTimes(1);
    const [action, fields] = observed.mock.calls[0]!;
    expect(action).toBe('worker_operation_error');
    expect(fields).toMatchObject({ initiator: 'system', accountId: 'acct-1', jobId: 'job-1', requestId: 'req-1', errorCode: 'MESSAGE_SEND_FAILED',
      diagnostic: { operation: 'sendMedia', stage: 'write', category: 'transport_failed', outcome: 'failed', upstreamStatus: 403,
        detail: 'UPLOAD_FAILED:obs_upload:ObsHttpError:403' } });
    expect(parseSafeDiagnostic(fields.diagnostic)).toBeDefined();
  });
  it('keeps a numeric LINE code outside the HTTP range as upstreamCode', () => {
    const [, fields] = run(workerFault({ error: 'UPLOAD_FAILED', detail: 'e2ee_message:ChromeApiError:10051' }, 'failed')).mock.calls[0]!;
    expect(fields.diagnostic).toMatchObject({ stage: 'execute', upstreamCode: 10051 });
    expect(fields.diagnostic).not.toHaveProperty('upstreamStatus');
  });
  it('uses the worker code as the audit error code when the audit allows it', () => {
    expect(run(workerFault({ error: 'SIDE_EFFECT_DENIED' }, 'failed')).mock.calls[0]![1]).toMatchObject({
      errorCode: 'SIDE_EFFECT_DENIED', diagnostic: { category: 'denied', stage: 'response' } });
    expect(run(workerFault({ error: 'TRANSPORT_OUTCOME_UNKNOWN' }, 'unknown'), 'sendText').mock.calls[0]![1]).toMatchObject({
      errorCode: 'TRANSPORT_OUTCOME_UNKNOWN', diagnostic: { operation: 'sendText', category: 'outcome_unknown', recovery: 'inspect_outcome', outcome: 'unknown' } });
    // Migration 081 lets the audit table take the LINE server codes, so the real code is written with its numeric upstream code.
    const talk = run(workerFault({ error: 'LINE_TALK_ABUSE_BLOCK' }, 'failed')).mock.calls[0]![1];
    expect(talk).toMatchObject({ errorCode: 'LINE_TALK_ABUSE_BLOCK', diagnostic: { category: 'denied', upstreamCode: 35 } });
    expect(parseSafeDiagnostic(talk.diagnostic)).toBeDefined();
  });
  it('maps gateway faults to not-started diagnostics', () => {
    expect(run(gatewayFault(new Error('Worker media queue is full (QUEUE_FULL)'))).mock.calls[0]![1]).toMatchObject({
      errorCode: 'QUEUE_FULL', diagnostic: { category: 'queue_full', stage: 'admission', outcome: 'not_started' } });
    expect(run(gatewayFault(new Error('Stale worker binding'))).mock.calls[0]![1]).toMatchObject({
      errorCode: 'NOT_STARTED', diagnostic: { category: 'stale_binding' } });
    expect(run(gatewayFault(new Error('Worker send cancelled before media admission.'))).mock.calls[0]![1]).toMatchObject({
      diagnostic: { category: 'cancelled' } });
  });
  it('puts the gateway cause and the worker code in the diagnostic detail', () => {
    expect(run(gatewayFault(new Error('Stale worker binding'))).mock.calls[0]![1].diagnostic).toMatchObject({ detail: 'gateway:stale_binding' });
    expect(run(workerFault({ error: 'FILE_CHANGED' }, 'failed')).mock.calls[0]![1].diagnostic).toMatchObject({ detail: 'FILE_CHANGED' });
  });
  it('never throws when the audit throws and does nothing without an audit', () => {
    const fault = workerFault({ error: 'UPLOAD_FAILED' }, 'failed');
    expect(() => recordSendFault({ observed: () => { throw new Error('sink down'); } }, { accountId: 'a', requestId: 'r', operation: 'sendMedia' }, fault)).not.toThrow();
    expect(() => recordSendFault(undefined, { accountId: 'a', requestId: 'r', operation: 'sendMedia' }, fault)).not.toThrow();
  });
});
