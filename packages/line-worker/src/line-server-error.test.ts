import { expect, it } from 'vitest';
import { InternalError } from '@evex/linejs/base';
import { IpcResultSchema, TALK_SERVER_ERRORS, lineResultErrorMessage, lineServerErrorMessage } from '@line-agent/contracts';
import { decodeLinejsServerRejection, isTalkAuthInvalidation, LineServerRejection } from './line-server-error.js';

const secret = 'token=private MID=u12345678901234567890123456789012 message=private';

it.each(Object.entries(TALK_SERVER_ERRORS).filter(([, [number]]) => number !== 8 && number !== 119))
  ('projects every reference open-source Talk error %s through the pinned LINEJS response code field', (name, [number]) => {
    const error = new InternalError('RequestError', secret, { code: name, reason: secret });
    const rejection = decodeLinejsServerRejection(error, '/S4', 'getProfile', 4);
    expect(rejection).toMatchObject({ code: `LINE_TALK_${name}`, upstreamCode: number });
    expect(JSON.stringify(rejection)).not.toContain(secret);
  });

it.each(['AUTHENTICATION_FAILED', 'NOT_AVAILABLE_USER', 'NOT_AUTHORIZED_DEVICE'])
  ('recognizes only path-scoped Talk authentication invalidation for %s', (name) => {
    const error = new InternalError('RequestError', secret, { code: name, reason: secret });
    expect(isTalkAuthInvalidation(error, '/S4', 'getProfile', 4)).toBe(true);
    expect(isTalkAuthInvalidation(error, '/RE4', 'addFriendByMid', 4)).toBe(false);
    expect(isTalkAuthInvalidation(error, '/S4', 'unlistedMethod', 4)).toBe(false);
  });

it.each([
  ['NOT_YOUR_MESSAGE', 28],
  ['MESSAGE_NOT_FOUND', 64],
  ['MESSAGE_NOT_DESTRUCTIBLE', 71],
  ['E2EE_RETRY_ENCRYPT', 82],
  ['SHOULD_RETRY', 115],
] as const)('projects a real Talk RequestError %s to its fixed code and message', (name, number) => {
  const error = new InternalError('RequestError', secret, { code: name, reason: secret,
    parameterMap: { private: secret }, rawBody: secret });
  const rejection = decodeLinejsServerRejection(error, '/S4', 'unsendMessage', 4);
  expect(rejection).toBeInstanceOf(LineServerRejection);
  expect(rejection).toMatchObject({ code: `LINE_TALK_${name}`, upstreamCode: number,
    message: `LINE_TALK_${name}` });
  expect(JSON.stringify(rejection)).not.toContain(secret);
  expect(lineServerErrorMessage(rejection?.code)).toContain(`LINE_TALK_${name}`);
});

it.each([
  [new InternalError('RequestError', secret, { code: 'MESSAGE_NOT_FOUND' }), '/RE4', 'addFriendByMid', 4],
  [new InternalError('RequestError', secret, { code: 'MESSAGE_NOT_FOUND' }), '/CH4', 'issueChannelToken', 4],
  [new InternalError('RequestError', secret, { code: 'MESSAGE_NOT_FOUND' }), '/S4', 'unlistedMethod', 4],
  [new InternalError('RequestError', secret, { code: 'MESSAGE_NOT_FOUND' }), '/S4', 'sendMessage', 3],
  [new InternalError('RequestError', secret, { code: 1 }), '/S4', 'sendMessage', 4],
  [new InternalError('RequestError', secret, { code: 'UNKNOWN_CODE' }), '/S4', 'sendMessage', 4],
  [new InternalError('RequestError', secret, { code: 'NOT_AUTHORIZED_DEVICE' }), '/S4', 'sendMessage', 4],
  [new InternalError('RequestError', secret, { code: 'MUST_REFRESH_V3_TOKEN' }), '/S4', 'sendMessage', 4],
  [new InternalError('WrongType', secret, { code: 'MESSAGE_NOT_FOUND' }), '/S4', 'sendMessage', 4],
  [Object.assign(new Error(secret), { name: 'RequestError', type: 'RequestError', data: { code: 'MESSAGE_NOT_FOUND' } }), '/S4', 'sendMessage', 4],
  [new InternalError('RequestError', secret, Object.create({ code: 'MESSAGE_NOT_FOUND' })), '/S4', 'sendMessage', 4],
] as const)('does not infer a Talk code from another namespace, refresh, or forged shape (%#)', (error, path, method, protocol) => {
  expect(decodeLinejsServerRejection(error, path, method, protocol)).toBeNull();
});

it('ignores accessor code and hostile metadata without reading them', () => {
  const data = Object.defineProperty({}, 'code', { get: () => { throw new Error(secret); } });
  const error = new InternalError('RequestError', secret, data);
  expect(decodeLinejsServerRejection(error, '/S4', 'react', 4)).toBeNull();
});

it('allows the actual Talk sync namespace but no other /SYNC4 method', () => {
  const error = new InternalError('RequestError', secret, { code: 'EXPIRED_REVISION' });
  expect(decodeLinejsServerRejection(error, '/SYNC4', 'sync', 4)).toMatchObject({
    code: 'LINE_TALK_EXPIRED_REVISION', upstreamCode: 52 });
  expect(decodeLinejsServerRejection(error, '/SYNC4', 'getProfile', 4)).toBeNull();
});

it('projects fixed server descriptions to UI and discards poisoned worker error text', () => {
  expect(lineResultErrorMessage('LINE_TALK_NOT_YOUR_MESSAGE', 'fallback')).toBe('fallback');
  expect(lineResultErrorMessage('SIDE_EFFECT_DENIED', 'fallback')).toBe('SIDE_EFFECT_DENIED');
  expect(lineResultErrorMessage(secret, 'LINE message was not sent.')).toBe('LINE message was not sent.');
  expect(lineResultErrorMessage('PRIVATE_SERVER_MESSAGE', 'fallback')).toBe('fallback');
  expect(lineResultErrorMessage('LINE_TALK_FAKE_PRIVATE_CODE', 'fallback')).toBe('fallback');
});

it('allows only known Talk detail codes on IPC errors', () => {
  const event = { type: 'error', requestId: 'one', ok: false, code: 'LINE_SEND_NOT_STARTED',
    message: 'LINE message was not sent.', retryable: false };
  expect(IpcResultSchema.safeParse({ ...event, serverErrorCode: 'LINE_TALK_E2EE_RETRY_ENCRYPT' }).success).toBe(true);
  expect(IpcResultSchema.safeParse({ ...event, serverErrorCode: 'LINE_TALK_PRIVATE_SERVER_MESSAGE' }).success).toBe(false);
  expect(IpcResultSchema.safeParse({ ...event, serverErrorCode: secret }).success).toBe(false);
});
