/**
 * Bounded reason codes for a queued attachment that the app cannot download now.
 * A code is kept in `attachments.error` while the status stays `queued`.
 * A real download failure keeps its own error text and is not one of these codes.
 */
export const ATTACHMENT_BLOCK_REASONS = [
  'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE',
  'ATTACHMENT_WORKER_UNAVAILABLE',
  'ATTACHMENT_WORKER_NOT_READY',
] as const;
export type AttachmentBlockReason = (typeof ATTACHMENT_BLOCK_REASONS)[number];

export function isAttachmentBlockReason(value: unknown): value is AttachmentBlockReason {
  return typeof value === 'string' && (ATTACHMENT_BLOCK_REASONS as readonly string[]).includes(value);
}
