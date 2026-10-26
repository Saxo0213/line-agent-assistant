import { expect, it } from 'vitest';
import { LineWorkerCommandSchema, LineWorkerEventSchema } from './worker-v2.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1, revision: '1', globalRev: '2', individualRev: '3' };

it('binds logout commands and results to the complete worker identity and request id', () => {
  const command = { type: 'logout', ...binding, requestId: 'logout-1' };
  expect(LineWorkerCommandSchema.safeParse(command).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...command, path: '/RS4' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'logoutResult', ...binding, requestId: 'logout-1', ok: true, error: null }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'logoutResult', ...binding, requestId: 'logout-1', ok: false,
    error: 'LINE_AUTH_INVALIDATED' }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'logoutResult', ...binding, requestId: 'logout-1', ok: true,
    error: 'LINE_AUTH_INVALIDATED' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'logoutResult', ...binding, requestId: 'logout-1', ok: false,
    error: 'private server message' }).success).toBe(false);
});

it('accepts only restricted Talk codes on failed attachment IPC events', () => {
  const event = { type: 'attachmentResult', ...binding, chatType: 'group', chatId: 'c-group',
    attachmentId: '11111111-1111-4111-8111-111111111111',
    attemptToken: '22222222-2222-4222-8222-222222222222', status: 'failed',
    error: 'LINE_OBS_TOKEN_RPC_FAILED', serverErrorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', upstreamCode: 84 };
  expect(LineWorkerEventSchema.safeParse(event).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...event, serverErrorCode: 'LINE_TALK_PRIVATE_SERVER_MESSAGE' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...event, serverErrorCode: 'token=private' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...event, upstreamCode: 'token=private' }).success).toBe(false);
});

it('bounds chat resource reads and image result payloads', () => {
  const command = { type: 'chatResourceRead', ...binding, chatType: 'group', chatId: `c${'a'.repeat(32)}`,
    requestId: 'resource-1', action: 'downloadAlbumPhoto', albumId: 'album-1', photoId: 'photo-1', oid: 'oid-1',
    prefix: 'album/a', maxBytes: 1024, timeoutMs: 10_000 };
  expect(LineWorkerCommandSchema.safeParse(command).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...command, maxBytes: 20 * 1024 * 1024 + 1 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, albumId: undefined }).success).toBe(false);
  const event = { type: 'chatResourceResult', ...binding, chatType: 'group', chatId: command.chatId,
    requestId: command.requestId, action: command.action, ok: true, error: null, bytes: new Uint8Array([1, 2]) };
  expect(LineWorkerEventSchema.safeParse(event).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...event, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }).success).toBe(false);
  const { bytes: _bytes, ...eventBase } = event;
  const failed = { ...eventBase, action: 'listNotes', ok: false, error: 'response_code_invalid' };
  for (const responseCode of [-1_000_000_000, 1_000_000_000, 'missing', 'non_numeric']) {
    expect(LineWorkerEventSchema.safeParse({ ...failed, responseCode }).success).toBe(true);
  }
  expect(LineWorkerEventSchema.safeParse({ ...event, responseCode: 403 }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...failed, action: 'listAlbums', responseCode: 403 }).success).toBe(false);
  for (const responseCode of [-1_000_000_001, 1_000_000_001, 'private response']) {
    expect(LineWorkerEventSchema.safeParse({ ...failed, responseCode }).success).toBe(false);
  }
  const albumFailure = { ...eventBase, action: 'listAlbums', ok: false, error: 'response_code_invalid',
    failureKind: 'linejs_internal', upstreamCode: 102001 };
  expect(LineWorkerEventSchema.safeParse(albumFailure).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...albumFailure, upstreamCode: 'private response' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...albumFailure, upstreamStatus: 503 }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...event, failureKind: 'other' }).success).toBe(false);
});

it('carries optional nullable picture paths through login identity and scoped catalog entries', () => {
  const login = LineWorkerEventSchema.parse({ type: 'login', ...binding, loginAttemptId: 'attempt-1',
    ownMid: 'u-self', displayName: 'Agent', picturePath: 'https://profile.line-scdn.net/avatar.png' });
  const cleared = LineWorkerEventSchema.parse({ type: 'login', ...binding, loginAttemptId: 'attempt-1',
    ownMid: 'u-self', displayName: 'Agent', picturePath: null });
  const catalog = LineWorkerEventSchema.parse({ type: 'conversationCatalog', ...binding, conversations: [{
    chatType: 'group', chatId: 'c-room', title: 'Room', picturePath: null,
    members: [{ memberId: 'u-peer', displayName: 'Peer', picturePath: 'https://obs.line-apps.com/p.png' }],
  }] });

  expect(login).toMatchObject({ picturePath: 'https://profile.line-scdn.net/avatar.png' });
  expect(cleared).toMatchObject({ picturePath: null });
  expect(catalog).toMatchObject({ conversations: [{ picturePath: null,
    members: [{ picturePath: 'https://obs.line-apps.com/p.png' }] }] });
  const unknown = LineWorkerEventSchema.parse({ type: 'login', ...binding, loginAttemptId: 'attempt-1',
    ownMid: 'u-self', displayName: 'Agent' });
  expect(unknown).not.toHaveProperty('picturePath');
});

it('requires identity and login-attempt correlation on QR bootstrap and private secret commands', () => {
  expect(LineWorkerCommandSchema.safeParse({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' }).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ type: 'loginQr', ...binding }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'qr', ...binding, loginAttemptId: 'login-1', code: 'url' }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'qr', code: 'url' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: null, qrCert: null, e2eeStorage: {} } }).success).toBe(true);
});

it('accepts only fixed, attempt-correlated terminal login failure diagnostics', () => {
  const failure = { type: 'loginFailure', ...binding, loginAttemptId: 'attempt-1', code: 'LOGIN_TIMEOUT',
    message: 'LINE login timed out. Try again.' };
  expect(LineWorkerEventSchema.safeParse(failure).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...failure, loginAttemptId: undefined }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...failure, code: 'NOT_AUTHORIZED_DEVICE' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...failure, message: 'token:secret' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...failure, rawError: 'response body' }).success).toBe(false);
});

it('accepts only enumerated worker command failure codes', () => {
  const failure = { type: 'error', ...binding, code: 'HISTORY_READ_FAILED',
    message: 'LINE chat history could not be read.', retryable: false };
  expect(LineWorkerEventSchema.safeParse(failure).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...failure, code: 'private exception text' }).success).toBe(false);
});

it('requires the owner-bound worker protocol version on init and acknowledges only the same version', () => {
  expect(LineWorkerCommandSchema.safeParse({ type: 'init', ...binding, mode: 'MONITOR_ONLY', durableCursor: cursor }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ type: 'init', ...binding, transportOwnerId: 'owner-1', transportGeneration: 1,
    writeGrantVersion: 1, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'workerProtocolAck', ...binding, transportOwnerId: 'owner-1',
    transportGeneration: 1, writeGrantVersion: 1, protocolVersion: 4, manualSend: true }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'workerProtocolAck', ...binding, transportOwnerId: 'owner-1',
    transportGeneration: 1, writeGrantVersion: 1, protocolVersion: 4 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ type: 'init', ...binding, protocolVersion: 2, mode: 'MONITOR_ONLY', durableCursor: cursor }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'workerProtocolAck', ...binding, protocolVersion: 2 }).success).toBe(false);
});

it('rejects forged RPC names and unknown fields from Main commands', () => {
  expect(LineWorkerCommandSchema.safeParse({ type: 'sendText', ...binding,
    chatType: 'group', chatId: 'c1', requestId: 'send-1', text: 'hello', methodName: 'sendMessage' }).success).toBe(false);
});

it('correlates a physical send with transport owner, grant, operation, attempt, and one-shot permit identities', () => {
  const command = { type: 'sendText', ...binding, transportOwnerId: 'owner-1', transportGeneration: 3,
    writeGrantVersion: 8, operationId: 'operation-1', attemptId: 'attempt-1', effectPermit: 'permit-1',
    chatType: 'group', chatId: 'c1', requestId: 'send-1', text: 'hello', replyToMessageId: null };
  expect(LineWorkerCommandSchema.safeParse(command).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...command, transportGeneration: -1 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, effectPermit: '' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'sendResult', accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, transportOwnerId: 'owner-1',
    transportGeneration: 3, writeGrantVersion: 8, operationId: 'operation-1', attemptId: 'attempt-1',
    requestId: 'send-1', status: 'unknown', messageId: null, error: 'TRANSPORT_OUTCOME_UNKNOWN' }).success).toBe(true);
});

it('accepts sendMedia only for direct and group chats with bounded size, name and hash', () => {
  const command = { type: 'sendMedia', ...binding, chatType: 'group', chatId: 'c1', requestId: 'media-1', kind: 'image',
    filePath: 'C:\\work\\a.png', fileName: 'a.png', sizeBytes: 10, sha256: 'a'.repeat(64), timeoutMs: 120_000,
    operationId: 'op-1', attemptId: 'attempt-1', effectPermit: 'permit-1' };
  expect(LineWorkerCommandSchema.safeParse(command).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...command, chatType: 'direct', kind: 'file', sizeBytes: 100 * 1024 * 1024 }).success).toBe(true);
  for (const chatType of ['room', 'community', 'thread']) {
    expect(LineWorkerCommandSchema.safeParse({ ...command, chatType }).success).toBe(false);
  }
  expect(LineWorkerCommandSchema.safeParse({ ...command, sizeBytes: 20 * 1024 * 1024 + 1 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, kind: 'file', sizeBytes: 100 * 1024 * 1024 + 1 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, sizeBytes: 0 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, fileName: 'x'.repeat(181) }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, fileName: '\u4e2d'.repeat(61) }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, fileName: '' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, sha256: 'A'.repeat(64) }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, filePath: 'relative/a.png' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, effectPermit: '' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, kind: 'video' }).success).toBe(false);
});

it('accepts only owner-bound reaction commands for a decimal source message and supported reaction', () => {
  const command = { type: 'reactMessage', ...binding, transportOwnerId: 'owner-1', transportGeneration: 3,
    writeGrantVersion: 8, chatType: 'direct', chatId: 'u-peer', requestId: 'reaction-1',
    messageId: '987654321', reaction: 'AMAZING' };
  expect(LineWorkerCommandSchema.safeParse(command).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...command, messageId: 'not-decimal' }).success).toBe(false);
  for (const reaction of ['NICE', 'AMAZING', 'FUN', 'LOVE', 'SAD', 'OMG', 'UNDO']) {
    expect(LineWorkerCommandSchema.safeParse({ ...command, reaction }).success).toBe(true);
  }
  expect(LineWorkerCommandSchema.safeParse({ ...command, reaction: 'HEART' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, transportGeneration: -1 }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...command, rpcName: 'react' }).success).toBe(false);
});

it('binds relation commands and results to the exact LINE user MID and current worker identity', () => {
  const owner = { ...binding, transportOwnerId: 'owner-1', transportGeneration: 4, writeGrantVersion: 9 };
  const check = { type: 'checkFriendRelation', ...owner, requestId: 'check-1', targetMid: `u${'a'.repeat(32)}` };
  const add = { type: 'addFriendByMid', ...owner, requestId: 'add-1', targetMid: `u${'b'.repeat(32)}` };
  expect(LineWorkerCommandSchema.safeParse(check).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse(add).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...add, sourceChatMid: `c${'d'.repeat(32)}` }).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...add, sourceChatMid: 'invalid-chat' }).success).toBe(false);
  for (const targetMid of ['u-peer', `c${'a'.repeat(32)}`, `u${'g'.repeat(32)}`, `u${'a'.repeat(31)}`]) {
    expect(LineWorkerCommandSchema.safeParse({ ...check, targetMid }).success).toBe(false);
  }
  expect(LineWorkerEventSchema.safeParse({ type: 'friendRelationResult', ...owner, requestId: 'check-1',
    targetMid: check.targetMid, status: 'friend', error: null }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'addFriendResult', ...owner, requestId: 'add-1',
    targetMid: add.targetMid, status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'addFriendResult', ...binding, requestId: 'add-1',
    targetMid: add.targetMid, status: 'added', error: null }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'friendRelationResult', ...binding, requestId: 'check-1',
    targetMid: 'u-peer', status: 'friend', error: null }).success).toBe(false);
});

it('requires batch and cursor-after identities on durable acknowledgement', () => {
  expect(LineWorkerCommandSchema.safeParse({ type: 'ackBatch', ...binding, batchId: 'batch-1', cursorAfter: cursor }).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ type: 'ackBatch', ...binding, cursorAfter: cursor }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ type: 'ackBatch', ...binding, batchId: 'batch-1',
    cursorAfter: { ...cursor, revision: 1 } }).success).toBe(false);
});

it('requires a correlated mode acknowledgement for grants and drained revoke', () => {
  expect(LineWorkerEventSchema.safeParse({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY' }).success).toBe(false);
});

it('requires scoped internal and external attachment identities plus a supported kind', () => {
  const base = { type: 'downloadAttachment', ...binding, chatType: 'group', chatId: 'c-group',
    requestId: 'download-1', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', messageId: '9', attachmentId: '11111111-1111-4111-8111-111111111111',
    externalAttachmentId: 'OID_123', occurredAt: '2026-10-15T10:00:00.000Z', originalFileName: 'photo.png',
    lineMessage: { id: '9', chunks: [{ encoding: 'base64', data: 'AQID' }] },
    maxBytes: 1024, timeoutMs: 1000 };
  expect(LineWorkerCommandSchema.safeParse({ ...base, kind: 'image' }).success).toBe(true);
  expect(LineWorkerCommandSchema.safeParse({ ...base, kind: 'sticker' }).success).toBe(false);
  expect(LineWorkerCommandSchema.safeParse({ ...base, kind: 'image', accountId: '' }).success).toBe(false);
});

it('correlates attachment cancellation acknowledgement and result to one attempt token', () => {
  const attemptToken = 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1';
  expect(LineWorkerCommandSchema.safeParse({ type: 'cancelAttachmentDownload', ...binding,
    attachmentId: '11111111-1111-4111-8111-111111111111', attemptToken }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'attachmentCancelAck', ...binding,
    attachmentId: '11111111-1111-4111-8111-111111111111', attemptToken, cancelled: true }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'attachmentResult', accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, chatType: 'group', chatId: 'c-group',
    attachmentId: '11111111-1111-4111-8111-111111111111', attemptToken, status: 'failed', error: 'CANCELLED' }).success).toBe(true);
});

it('validates a strict conversation catalog without coercing identifiers or exposing secret fields', () => {
  const event = {
    type: 'conversationCatalog', ...binding,
    conversations: [{
      chatType: 'group', chatId: 'c-group', title: 'Project',
      members: [{ memberId: 'u-alice', displayName: 'Alice' }],
    }],
  };
  expect(LineWorkerEventSchema.safeParse(event).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ ...event,
    conversations: [{ ...event.conversations[0], chatId: 123 }],
  }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...event, token: 'must-not-cross-worker-boundary' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...event,
    conversations: [{ ...event.conversations[0], members: [{ memberId: 'u-alice', displayName: 'Alice', authToken: 'secret' }] }],
  }).success).toBe(false);
});

it('accepts only classified catalog refresh health events without raw diagnostic fields', () => {
  expect(LineWorkerEventSchema.safeParse({ type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'catalogRefreshStatus', ...binding,
    state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' }).success).toBe(true);
  expect(LineWorkerEventSchema.safeParse({ type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'https://profile.line-scdn.net/path?token=secret' }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED', message: 'raw error' }).success).toBe(false);
});

const receiptBatch = { type: 'batch', ...binding, batchId: 'batch-1', cursorBefore: cursor, cursorAfter: cursor, envelopes: [] };
const validReceipt = { chatId: `c${'1'.repeat(32)}`, readerMid: `u${'a'.repeat(32)}`, messageId: '123', readAt: '2026-10-22T01:02:03.000Z' };

it('accepts batches with valid read receipts and batches from older workers without the field', () => {
  expect(LineWorkerEventSchema.parse({ ...receiptBatch, readReceipts: [validReceipt] })).toMatchObject({ readReceipts: [validReceipt] });
  expect(LineWorkerEventSchema.parse({ ...receiptBatch, readReceipts: [{ ...validReceipt, readAt: '2026-10-22T09:02:03+08:00' }] })).toBeTruthy();
  expect(LineWorkerEventSchema.parse(receiptBatch)).not.toHaveProperty('readReceipts');
});

it('rejects oversize or malformed read receipts', () => {
  const many = Array.from({ length: 501 }, () => validReceipt);
  expect(LineWorkerEventSchema.safeParse({ ...receiptBatch, readReceipts: many }).success).toBe(false);
  expect(LineWorkerEventSchema.safeParse({ ...receiptBatch, readReceipts: many.slice(0, 500) }).success).toBe(true);
  for (const bad of [{ chatId: 'u-admin' }, { chatId: `m${'1'.repeat(32)}` }, { readerMid: `c${'a'.repeat(32)}` },
    { readerMid: 'u-short' }, { messageId: 'abc' }, { messageId: '' }, { messageId: '1'.repeat(21) }, { readAt: 'yesterday' },
    { extra: true }]) {
    expect(LineWorkerEventSchema.safeParse({ ...receiptBatch, readReceipts: [{ ...validReceipt, ...bad }] }).success).toBe(false);
  }
});
