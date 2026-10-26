import { expect, it, vi } from 'vitest';
import { AttachmentResultSchema, LineWorkerEventSchema, type LineWorkerEvent } from '@line-agent/contracts';
import { recordAttachmentServerResult, recordKnownServerResult, recordWorkerDiagnostic,
  type ConnectedFacadeOptions } from './connected-facade.js';
import { createOperationalAudit } from './services/operational-audit.js';
import { projectSystemErrors } from './services/system-records.js';

const identity = { accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 1 };

it('records only fixed Talk and Relation codes, with no server prose in audit', () => {
  const failure = vi.fn();
  const options = { audit: { failure } } as unknown as ConnectedFacadeOptions;
  const send = { type: 'sendResult', ...identity, requestId: 'send-a', status: 'failed', messageId: null,
    error: 'LINE_TALK_NOT_YOUR_MESSAGE' } as Extract<LineWorkerEvent, { type: 'sendResult' }>;
  recordKnownServerResult(options, send);
  expect(failure).toHaveBeenCalledWith({ operation: 'sendText', stage: 'response', category: 'denied',
    recovery: 'none', upstreamCode: 28 }, { initiator: 'worker', accountId: 'account-a',
    workerInstanceId: 'worker-a', requestId: 'send-a' }, 'LINE_TALK_NOT_YOUR_MESSAGE', 'worker_operation_error');
  const relation = { type: 'addFriendResult', ...identity, requestId: 'add-a', targetMid: `u${'a'.repeat(32)}`,
    status: 'failed', error: 'LINE_RELATION_ADD_AGE_VALIDATION' } as Extract<LineWorkerEvent, { type: 'addFriendResult' }>;
  recordKnownServerResult(options, relation);
  expect(failure).toHaveBeenLastCalledWith({ operation: 'addFriendByMid', stage: 'response', category: 'denied',
    recovery: 'none', upstreamCode: 2 }, { initiator: 'worker', accountId: 'account-a',
    workerInstanceId: 'worker-a', requestId: 'add-a' }, 'LINE_RELATION_ADD_AGE_VALIDATION', 'friend_add_attempt');
  expect(JSON.stringify(failure.mock.calls)).not.toContain('targetMid');
  recordKnownServerResult(options, { ...send, requestId: 'poisoned', error: 'token=private MID=u12345678901234567890123456789012' });
  expect(failure).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(failure.mock.calls)).not.toContain('token=private');
});

it('moves a trusted attachment Talk code through the worker result, audit and system errors', async () => {
  const records: Parameters<typeof projectSystemErrors>[0][number][] = [];
  const audit = createOperationalAudit({ append: async (event) => { records.push(event); },
    appendFallback: async () => {}, logSinkState: () => {} });
  const options = { audit } as unknown as ConnectedFacadeOptions;
  const event = AttachmentResultSchema.parse({ type: 'attachmentResult', ...identity,
    chatType: 'group', chatId: 'c-group', attachmentId: '11111111-1111-4111-8111-111111111111',
    attemptToken: '22222222-2222-4222-8222-222222222222', status: 'failed',
    error: 'LINE_OBS_TOKEN_RPC_FAILED', serverErrorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', upstreamCode: 84 });
  if (event.status !== 'failed') throw new Error('fixture was not a failed attachment');
  recordAttachmentServerResult(options, event);
  await audit.flush();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ errorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY',
    diagnostic: { operation: 'downloadAttachment', upstreamCode: 84 } });
  const rows = projectSystemErrors(records, []);
  expect(rows).toMatchObject([{ code: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY',
    diagnostic: { upstreamCode: 84 } }]);
  expect(event.error).toBe('LINE_OBS_TOKEN_RPC_FAILED');
  expect(JSON.stringify({ event, records, rows })).not.toContain('token=private');
  recordAttachmentServerResult(options, { ...event, serverErrorCode: 'token=private' } as typeof event);
  recordAttachmentServerResult(options, { ...event, upstreamCode: 999 } as typeof event);
  await audit.flush();
  expect(records).toHaveLength(1);
});

it('coalesces repeated poll Talk failures into a bounded system error and preserves recovery', async () => {
  const records: Parameters<typeof projectSystemErrors>[0][number][] = [];
  const audit = createOperationalAudit({ append: async (event) => { records.push(event); },
    appendFallback: async () => {}, logSinkState: () => {} });
  const options = { audit } as unknown as ConnectedFacadeOptions;
  const event = LineWorkerEventSchema.parse({ type: 'error', ...identity, code: 'LINE_TALK_EXCESSIVE_ACCESS',
    message: 'LINE_TALK_EXCESSIVE_ACCESS', retryable: false,
    diagnostic: { operation: 'poll', stage: 'response', category: 'denied', recovery: 'none', upstreamCode: 4 } });
  if (event.type !== 'error') throw new Error('fixture was not a worker error');
  for (let attempt = 0; attempt < 25; attempt++) recordWorkerDiagnostic(options, event);
  await audit.flush();
  expect(records).toHaveLength(1);
  expect(projectSystemErrors(records, [])).toMatchObject([{ code: 'LINE_TALK_EXCESSIVE_ACCESS',
    diagnostic: { operation: 'poll', upstreamCode: 4 } }]);
  expect(audit.health().failureKeys).toBe(1);
  expect(JSON.stringify(records)).not.toContain('token=private');
});
