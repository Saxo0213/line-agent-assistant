import { z } from 'zod';

export const StoredAttachmentItemSchema = z.strictObject({
  attachmentId: z.uuid(), messageId: z.string().min(1), name: z.string().min(1), kind: z.enum(['image','video','audio','file']),
  mimeType: z.string().nullable(), sizeBytes: z.number().int().nonnegative().nullable(), occurredAt: z.iso.datetime({ offset: true }),
  senderId: z.string().min(1), senderDisplayName: z.string().min(1),
});
export type StoredAttachmentItem = z.infer<typeof StoredAttachmentItemSchema>;
export const StoredAttachmentPageSchema = z.strictObject({ attachments: z.array(StoredAttachmentItemSchema).max(100), nextCursor: z.string().max(2048).nullable() });
export type StoredAttachmentPage = z.infer<typeof StoredAttachmentPageSchema>;
