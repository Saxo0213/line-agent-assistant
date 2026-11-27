import { z } from 'zod';

export const StoredAttachmentItemSchema = z.strictObject({
  attachmentId: z.uuid(), messageId: z.string().min(1), name: z.string().min(1), kind: z.enum(['image','video','audio','file']),
  mimeType: z.string().nullable(), sizeBytes: z.number().int().nonnegative().nullable(), occurredAt: z.iso.datetime({ offset: true }),
  senderId: z.string().min(1), senderDisplayName: z.string().min(1),
});
export type StoredAttachmentItem = z.infer<typeof StoredAttachmentItemSchema>;
export const StoredAttachmentPageSchema = z.strictObject({ attachments: z.array(StoredAttachmentItemSchema).max(100), nextCursor: z.string().max(2048).nullable() });
export type StoredAttachmentPage = z.infer<typeof StoredAttachmentPageSchema>;

/** Extra (secondary) attachment folder of one chat: configured folder and copy progress. */
export const ChatExtraFolderStatusSchema = z.strictObject({
  root: z.string().min(1).max(1024).nullable(),
  queued: z.number().int().nonnegative(), claimed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
});
export type ChatExtraFolderStatus = z.infer<typeof ChatExtraFolderStatusSchema>;
export const CHAT_EXTRA_FOLDER_ERROR_CODES = ['NOT_ABSOLUTE', 'NOT_DIRECTORY', 'REPARSE_POINT', 'PROTECTED_FOLDER', 'OTHER_CHAT_FOLDER', 'FAILED'] as const;
export const ChatExtraFolderResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), root: z.string().min(1).max(1024).nullable() }),
  z.strictObject({ ok: z.literal(false), code: z.enum(CHAT_EXTRA_FOLDER_ERROR_CODES) }),
]);
export type ChatExtraFolderResult = z.infer<typeof ChatExtraFolderResultSchema>;
