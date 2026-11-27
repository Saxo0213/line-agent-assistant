import { talkServerError, type LineServerErrorCode } from '@line-agent/contracts';
import { InternalError } from '@evex/linejs/base';

const TALK_READ_METHODS = new Set([
  'getProfile', 'getAllChatMids', 'getMessageBoxes', 'getChats', 'getContactsV2',
  'getRecentMessagesV2', 'getPreviousMessagesV2WithRequest', 'acquireEncryptedAccessToken',
  'negotiateE2EEPublicKey', 'getLastE2EEPublicKeys', 'getE2EEGroupSharedKey',
  'getLastE2EEGroupSharedKey',
]);
const TALK_WRITE_METHODS = new Set(['sendMessage', 'unsendMessage', 'react', 'cancelReaction', 'registerE2EEGroupKey']);

export class LineServerRejection extends Error {
  readonly name = 'LineServerRejection';
  constructor(readonly code: LineServerErrorCode, readonly upstreamCode: number) {
    super(code);
  }
}

/** Accept only the pinned LINEJS Thrift RequestError shape, never its text or metadata. */
function trustedTalkErrorName(error: unknown, path: string, method: string, protocol: unknown): string | null {
  if (protocol !== 4 || !((path === '/S4' && (TALK_READ_METHODS.has(method) || TALK_WRITE_METHODS.has(method)))
    || (path === '/SYNC4' && method === 'sync'))) return null;
  try {
    if (!(error instanceof InternalError) || error.name !== 'RequestError') return null;
    const candidate = error as InternalError;
    if (candidate.type !== 'RequestError' || !candidate.data || typeof candidate.data !== 'object' || Array.isArray(candidate.data)) return null;
    const data = candidate.data as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const code = Object.getOwnPropertyDescriptor(data, 'code');
    if (!code || !Object.hasOwn(code, 'value')) return null;
    return typeof code.value === 'string' ? code.value : null;
  } catch { return null; }
}

export function isTalkAuthInvalidation(error: unknown, path: string, method: string, protocol: unknown): boolean {
  const name = trustedTalkErrorName(error, path, method, protocol);
  return name === 'AUTHENTICATION_FAILED' || name === 'NOT_AVAILABLE_USER' || name === 'NOT_AUTHORIZED_DEVICE';
}

/** The LINE error code that made the session invalid. Unlike a rejection, it also covers NOT_AUTHORIZED_DEVICE (upstream 8). */
export type AuthInvalidationDetail = Readonly<{ code: LineServerErrorCode; upstreamCode: number }>;

/** The detail for a TalkException name, or undefined when the name is not a known code. */
export function authInvalidationDetailOfName(name: unknown): AuthInvalidationDetail | undefined {
  const projection = talkServerError(name);
  return projection ? { code: projection.code, upstreamCode: projection.upstreamCode } : undefined;
}

export function talkAuthInvalidationDetail(error: unknown, path: string, method: string, protocol: unknown): AuthInvalidationDetail | undefined {
  return authInvalidationDetailOfName(trustedTalkErrorName(error, path, method, protocol));
}

export function decodeLinejsServerRejection(error: unknown, path: string, method: string, protocol: unknown): LineServerRejection | null {
  const projection = talkServerError(trustedTalkErrorName(error, path, method, protocol));
  if (!projection || projection.upstreamCode === 8 || projection.upstreamCode === 119) return null;
  return new LineServerRejection(projection.code, projection.upstreamCode);
}

export function isLineServerRejection(error: unknown): error is LineServerRejection {
  return error instanceof LineServerRejection;
}

const SQUARE_READ_METHODS = new Set(['fetchMyEvents', 'getSquareChat']);
const SQUARE_ERROR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A SquareException returned by LINE for a community read. `upstreamName` is the SquareErrorCode name and
 * `upstreamCode` its number; each is undefined when LINE gave no usable value. It keeps no LINE text.
 */
export class LineSquareRejection extends Error {
  readonly name = 'LineSquareRejection';
  constructor(readonly upstreamName: string | undefined, readonly upstreamCode: number | undefined) {
    super('LINE_SQUARE_REJECTED');
  }
}

/**
 * Accepts only the pinned LINEJS RequestError shape on /SQ1 for the two community reads. It reads only the
 * `errorCode` field (a SquareErrorCode name or number), never the error text.
 */
export function decodeSquareRejection(error: unknown, method: string): LineSquareRejection | null {
  if (!SQUARE_READ_METHODS.has(method)) return null;
  try {
    if (!(error instanceof InternalError) || error.name !== 'RequestError') return null;
    const data = (error as InternalError).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(data, 'errorCode');
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    const name = typeof value === 'string' && SQUARE_ERROR_NAME.test(value) ? value : undefined;
    const code = typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000 ? value : undefined;
    return new LineSquareRejection(name, code);
  } catch { return null; }
}

export function isLineSquareRejection(error: unknown): error is LineSquareRejection {
  return error instanceof LineSquareRejection;
}
