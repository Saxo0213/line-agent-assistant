import { relationAddServerError, type RelationAddServerErrorCode } from '@line-agent/contracts';

const FRIEND_ADD_RESULT_ERRORS = [
  'UNKNOWN', 'INVALID_TARGET_USER', 'AGE_VALIDATION', 'TOO_MANY_FRIENDS', 'TOO_MANY_REQUESTS',
  'MALFORMED_REQUEST', 'TRACKING_META_QRCODE_FAVORED', 'TRACKING_META_UPGRADE_FAVORED',
] as const;
const FRIEND_ADD_REJECTION_NAMES = new Set<string>(FRIEND_ADD_RESULT_ERRORS);

export function friendAddResultCode(value: unknown): RelationAddServerErrorCode | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < FRIEND_ADD_RESULT_ERRORS.length) {
    return relationAddServerError(FRIEND_ADD_RESULT_ERRORS[value])?.code ?? null;
  }
  return null;
}

export function friendAddRejectionReason(value: unknown): RelationAddServerErrorCode | null {
  return friendAddResultCode(value) ?? (typeof value === 'string' && FRIEND_ADD_REJECTION_NAMES.has(value)
    ? relationAddServerError(value)?.code ?? null : null);
}
