const FIXED_CODES = new Set([
  'LINE_MEDIA_AUTH_FAILED', 'LINE_E2EE_SELF_KEY_MISSING', 'LINE_E2EE_PEER_KEY_UNAVAILABLE',
  'LINE_E2EE_KEY_MISMATCH', 'LINE_E2EE_UNSUPPORTED', 'LINE_RPC_FAILED', 'LINE_AUTH_INVALIDATED',
  'LINE_E2EE_METADATA_RPC_FAILED', 'LINE_E2EE_METADATA_DECRYPT_FAILED',
  'LINE_OBS_TOKEN_RPC_FAILED', 'LINE_OBS_TOKEN_INVALID',
  'ATTACHMENT_EFFECT_DENIED', 'LINE_DOWNLOAD_TIMEOUT', 'LINE_DOWNLOAD_CANCELLED', 'LINE_NETWORK_FAILED',
  'LINE_NATIVE_DOWNLOAD_FAILED', 'ATTACHMENT_METADATA_INVALID', 'LINE_OBS_OBJECT_NOT_FOUND',
  'LINE_OBS_ENCODING_INCOMPLETE', 'LINE_OBS_HTTP_FAILED', 'LINE_MEDIA_SIZE_LIMIT',
  'LINE_OBS_METADATA_INVALID',
]);

export type AttachmentFailureCode = string & { readonly __attachmentFailureCode: unique symbol };

export function isSafeAttachmentFailureCode(value: unknown): value is AttachmentFailureCode {
  return typeof value === 'string' && (FIXED_CODES.has(value)
    || /^LINE_OBS_HTTP_(?:[45]\d\d)$/.test(value)
      && Number(value.slice('LINE_OBS_HTTP_'.length)) >= 400
      && Number(value.slice('LINE_OBS_HTTP_'.length)) <= 599);
}

export class SafeAttachmentError extends Error {
  readonly code: AttachmentFailureCode;
  constructor(code: string) {
    if (!isSafeAttachmentFailureCode(code)) throw new TypeError('Invalid safe attachment failure code');
    super(code);
    this.name = 'SafeAttachmentError';
    this.code = code;
  }
}
