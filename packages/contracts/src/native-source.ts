import { z } from 'zod';

export const NATIVE_PICTURE_ORIGINS = ['https://profile.line-scdn.net', 'https://obs.line-apps.com', 'https://obs.line-scdn.net'] as const;
const NATIVE_PICTURE_ORIGIN_SET = new Set<string>(NATIVE_PICTURE_ORIGINS);

/** Normalize official LINE picture paths and OBS hashes to safe, bounded HTTPS URLs. */
export function normalizeNativePicturePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let candidate = raw;
  if (candidate.startsWith('/')) {
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*$/.test(candidate)) return null;
    if (candidate.slice(1).split('/').some((segment) => segment === '.' || segment === '..')) return null;
    candidate = `https://profile.line-scdn.net${candidate}`;
  } else if (/^[A-Za-z0-9_-]{16,256}$/.test(candidate)) {
    candidate = `https://obs.line-scdn.net/${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !NATIVE_PICTURE_ORIGIN_SET.has(url.origin)
      || url.username !== '' || url.password !== '' || url.hash !== '') return null;
    return candidate;
  } catch { return null; }
}

export const NATIVE_CATALOG_TABLES = [
  '_chat',
  '_chatOption',
  '_contact',
  '_profile',
  '_profileMappedId',
  '_groupChat',
  '_room',
  '_square',
  '_squareChat',
  '_squareMember',
  '_squareThread',
  '_squareBot',
  '_buddyDetail',
  '_buddyStatusBar',
  '_message_sticker',
  '_stickerProductNew',
  '_sticker_history',
  '_sticonProduct',
  '_sticon_mapping',
] as const;

export const NativeCatalogTableSchema = z.enum(NATIVE_CATALOG_TABLES);
export type NativeCatalogTable = z.infer<typeof NativeCatalogTableSchema>;

const NativeSourceTableSchema = z.enum(['_message', ...NATIVE_CATALOG_TABLES]);
const NativeSourceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NativeProtectedDataSchema = z.string().min(4).max(8 * 1024 * 1024)
  .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Expected bounded base64 ciphertext');
/** One SQLite cell of a plain row: NULL, a UTF-8 text string, or a type-preserving tagged object (integer/real/non-UTF-8 text/blob). */
const NativeCellSchema = z.union([z.string().max(8 * 1024 * 1024), z.null(), z.strictObject({
  sqliteType: z.enum(['integer', 'real', 'text', 'blob']),
  value: z.string().max(32).optional(),
  encoding: z.enum(['ieee754-be', 'base64']).optional(),
  data: z.string().max(8 * 1024 * 1024).optional(),
})]);
const NativePlainRowSchema = z.strictObject({
  columns: z.array(z.string().min(1).max(128)).max(128),
  cells: z.array(NativeCellSchema).max(128),
}).refine((row) => row.columns.length === row.cells.length, 'Row columns and cells must have equal length');
export const NativeSourceEnvelopeSchema = z.discriminatedUnion('format', [z.strictObject({
  format: z.literal(1),
  table: NativeSourceTableSchema,
  sourceDigest: NativeSourceDigestSchema,
  encoding: z.literal('dpapi'),
  data: NativeProtectedDataSchema,
}), z.strictObject({
  format: z.literal(2), table: NativeSourceTableSchema, sourceDigest: NativeSourceDigestSchema,
  encoding: z.literal('plain'), row: NativePlainRowSchema,
})]);
export type NativeSourceEnvelope = z.infer<typeof NativeSourceEnvelopeSchema>;

export const NativeCatalogRecordSchema = z.strictObject({
  tableName: NativeCatalogTableSchema,
  recordKey: z.string().min(1).max(4096),
  nativePayload: NativeSourceEnvelopeSchema,
}).superRefine((record, context) => {
  if (record.nativePayload.table !== record.tableName) {
    context.addIssue({ code: 'custom', path: ['nativePayload', 'table'], message: 'Catalog envelope table must match tableName' });
  }
});
export type NativeCatalogRecord = z.infer<typeof NativeCatalogRecordSchema>;

export const NativeStickerMetadataSchema = z.strictObject({
  STKID: z.string().regex(/^\d{1,20}$/),
  STKPKGID: z.string().regex(/^\d{1,20}$/).optional(),
  STKVER: z.string().regex(/^\d{1,20}$/).optional(),
  STKTXT: z.string().max(200).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value), 'Sticker text contains unsafe control characters')
    .transform((value) => value.replace(/\s+/gu, ' ').trim()).optional(),
  STKOPT: z.literal('A').optional(),
});
export type NativeStickerMetadata = z.infer<typeof NativeStickerMetadataSchema>;

export const NativeAttachmentDescriptorSchema = z.strictObject({
  id: z.string().min(1).max(512),
  kind: z.enum(['image', 'video', 'audio', 'file']),
  name: z.string().max(1024).nullable(),
  mimeType: z.string().max(255).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type NativeAttachmentDescriptor = z.infer<typeof NativeAttachmentDescriptorSchema>;

export const NativeAttachmentDownloadInputSchema = z.strictObject({
  messageId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
  from: z.string().min(1).max(512).nullable(),
  to: z.string().min(1).max(512).nullable(),
  toType: z.number().int().min(0).max(7).nullable(),
  contentType: z.number().int().min(0).max(255).nullable(),
  contentMetadata: z.strictObject({
    OID: z.string().max(128).nullable(), SID: z.string().max(32).nullable(),
    OBS_POP: z.string().max(256).nullable(), FILE_SIZE: z.string().max(20).nullable(),
    MEDIA_CONTENT_INFO: z.string().max(4096).nullable(), DOWNLOAD_URL: z.string().max(8192).nullable(),
  }),
  keyMaterial: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).nullable(),
  fileName: z.string().max(1024).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type NativeAttachmentDownloadInput = z.infer<typeof NativeAttachmentDownloadInputSchema>;

export const OfficialAuthCandidateSchema = z.strictObject({
  token: z.string().min(1).max(1024),
  application: z.string().min(1).max(512),
});
export type OfficialAuthCandidate = z.infer<typeof OfficialAuthCandidateSchema>;

export const NativeAttachmentMetadataSchema = z.strictObject({
  messageId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
  from: z.string().min(1).max(512).nullable(),
  to: z.string().min(1).max(512).nullable(),
  toType: z.number().int().min(0).max(7).nullable(),
  contentType: z.number().int().min(0).max(255).nullable(),
  contentMetadata: z.strictObject({
    OID: z.string().max(128).nullable(), SID: z.string().max(32).nullable(),
    OBS_POP: z.string().max(256).nullable(), FILE_SIZE: z.string().max(20).nullable(),
    MEDIA_CONTENT_INFO: z.string().max(4096).nullable(), DOWNLOAD_URL: z.string().max(8192).nullable(),
  }),
  keyMaterial: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).nullable(),
  fileName: z.string().max(1024).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type NativeAttachmentMetadata = z.infer<typeof NativeAttachmentMetadataSchema>;

/** One friend row from the official `_contact` table (names and picture path; no phone or status text). */
export const NativeDirectoryContactSchema = z.strictObject({
  kind: z.literal('contact'),
  mid: z.string().min(1).max(512),
  displayName: z.string().min(1).max(256).nullable(),
  nickname: z.string().min(1).max(256).nullable(),
  type: z.number().int().nullable(),
  status: z.number().int().nullable(),
  picturePath: z.string().max(2048).nullable().optional(),
});
export type NativeDirectoryContact = z.infer<typeof NativeDirectoryContactSchema>;

/** One official `_chat` row with its computed conversation title (the native reader owns the name rules). */
export const NativeDirectoryConversationSchema = z.strictObject({
  kind: z.literal('conversation'),
  chatId: z.string().min(1).max(512),
  chatType: z.enum(['direct', 'group', 'room', 'community', 'thread']),
  title: z.string().min(1).max(256).nullable(),
  picturePath: z.string().max(2048).nullable().optional(),
  nativeMetadata: z.strictObject({
    midType: z.number().int().nonnegative().nullable(),
    parentChatId: z.string().max(256).nullable(),
    communityId: z.string().max(256).nullable(),
  }),
});
export type NativeDirectoryConversation = z.infer<typeof NativeDirectoryConversationSchema>;

export const NativeDirectoryRowSchema = z.discriminatedUnion('kind', [NativeDirectoryContactSchema, NativeDirectoryConversationSchema]);
export type NativeDirectoryRow = z.infer<typeof NativeDirectoryRowSchema>;
