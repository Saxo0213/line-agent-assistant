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

export function decodeLinejsServerRejection(error: unknown, path: string, method: string, protocol: unknown): LineServerRejection | null {
  const projection = talkServerError(trustedTalkErrorName(error, path, method, protocol));
  if (!projection || projection.upstreamCode === 8 || projection.upstreamCode === 119) return null;
  return new LineServerRejection(projection.code, projection.upstreamCode);
}

export function isLineServerRejection(error: unknown): error is LineServerRejection {
  return error instanceof LineServerRejection;
}
