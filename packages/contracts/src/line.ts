import { z } from 'zod';
import { isLineServerErrorCode } from './line-server-error.js';
import { JsonValueSchema } from './json.js';
import { AccountModeSchema, ChatTypeSchema, WritableChatTypeSchema, ControlEpochSchema, WritableConversationKeySchema, WorkerBindingSchema } from './account.js';

const IdSchema = z.string().min(1);
const TimestampSchema = z.iso.datetime({ offset: true });
const UuidSchema = z.uuid();
const RelativePathSchema = z.string().min(1).refine((path) =>
  !path.includes('\\') &&
  !path.startsWith('/') &&
  !path.includes(':') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Expected a managed relative path',
);

export { ChatTypeSchema };
export type { ChatType } from './account.js';

export const AttachmentDescriptorSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(['image', 'video', 'audio', 'file']),
  name: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;

export const ContactDescriptorSchema = z.strictObject({
  mid: z.string().min(1).max(64),
  displayName: z.string().max(128).nullable(),
});
export type ContactDescriptor = z.infer<typeof ContactDescriptorSchema>;

export const MessageContentSchema = z.discriminatedUnion('type', [
  z.strictObject({ format: z.literal(1), type: z.literal('unsent') }),
  z.strictObject({ format: z.literal(1), type: z.literal('contact'), mid: z.string().max(512).nullable(), displayName: z.string().max(1024).nullable() }),
  z.strictObject({ format: z.literal(1), type: z.literal('location'), title: z.string().max(1024).nullable(), address: z.string().max(2048).nullable(), latitude: z.number().finite().nullable(), longitude: z.number().finite().nullable() }),
  z.strictObject({ format: z.literal(1), type: z.literal('rich'), variant: z.enum(['rich', 'flex']), altText: z.string().max(4096).nullable() }),
  z.strictObject({ format: z.literal(1), type: z.literal('media'), durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }),
  z.strictObject({ format: z.literal(1), type: z.literal('event'), nativeContentType: z.number().int().nullable(), text: z.string().max(4096).nullable(),
    call: z.strictObject({ media: z.enum(['audio', 'video']).nullable(), result: z.string().regex(/^[A-Z0-9_]{1,32}$/).nullable(),
      durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).nullable().optional() }),
  z.strictObject({ format: z.literal(1), type: z.literal('unsupported'), nativeContentType: z.number().int().nullable(), fallbackText: z.string().max(4096).nullable() }),
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;
export const MessageKindSchema = z.enum(['text', 'image', 'video', 'audio', 'file', 'sticker', 'contact', 'event', 'location', 'rich']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MentionRangeSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  userId: IdSchema,
}).refine((range) => range.end > range.start, 'Mention end must follow start');
export type MentionRange = z.infer<typeof MentionRangeSchema>;

export function normalizeMentionRanges(text: string | null, value: unknown): MentionRange[] {
  if (text === null || !Array.isArray(value)) return [];
  const ranges = value.flatMap((candidate): MentionRange[] => {
    const parsed = MentionRangeSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const { start, end } = parsed.data;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > text.length) return [];
    const splitsSurrogate = (offset: number) => offset > 0 && offset < text.length
      && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
      && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
    if (splitsSurrogate(start) || splitsSurrogate(end)) return [];
    return [parsed.data];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: MentionRange[] = [];
  for (const range of ranges) {
    if (normalized.at(-1) && range.start < normalized.at(-1)!.end) continue;
    normalized.push(range);
  }
  return normalized;
}

/** Most mentions one outgoing text may carry. */
export const OUTGOING_MENTIONS_MAX = 20;
/** One outgoing mention: UTF-16 code-unit offsets [start, end) of the `@name` text, and the mentioned member's user MID. */
export const OutgoingMentionSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  userId: z.string().regex(/^u[0-9a-fA-F]{32}$/),
});
export type OutgoingMention = z.infer<typeof OutgoingMentionSchema>;

/**
 * Returns the reason an outgoing mention list is invalid for `text`, or null. Ranges must lie inside the text, must not split a
 * surrogate pair, must not overlap and are limited to OUTGOING_MENTIONS_MAX. Offsets are UTF-16 code units, the same unit
 * normalizeMentionRanges and the inbound MENTION parser use.
 */
export function outgoingMentionsIssue(text: string, mentions: readonly OutgoingMention[]): string | null {
  if (mentions.length > OUTGOING_MENTIONS_MAX) return 'Too many mentions';
  const sorted = [...mentions].sort((left, right) => left.start - right.start || left.end - right.end);
  const splits = (offset: number) => offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
  let previousEnd = 0;
  for (const mention of sorted) {
    if (mention.end <= mention.start) return 'Mention end must follow start';
    if (mention.end > text.length) return 'Mention range exceeds text';
    if (splits(mention.start) || splits(mention.end)) return 'Mention range splits a surrogate pair';
    if (mention.start < previousEnd) return 'Mention ranges overlap';
    previousEnd = mention.end;
  }
  return null;
}

/** Builds the LINE `contentMetadata.MENTION` value (a JSON string) for an outgoing text; the inverse of the inbound MENTION parser. */
export function buildMentionContentMetadata(mentions: readonly OutgoingMention[]): string {
  const sorted = [...mentions].sort((left, right) => left.start - right.start);
  return JSON.stringify({ MENTIONEES: sorted.map((mention) => ({ S: String(mention.start), E: String(mention.end), M: mention.userId })) });
}

export const SticonRangeSchema =z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
  productId: z.string().regex(/^[0-9a-f]{24}$/), sticonId: z.string().regex(/^[0-9]{1,6}$/), animated: z.boolean() });
export type SticonRange = z.infer<typeof SticonRangeSchema>;
export const STICON_REPLACE_MAX_BYTES = 16_384;

function utf8LengthAtMost(value: string, limit: number): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff ? (i++, 4) : 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Parses LINE REPLACE sticon metadata. S/E use JavaScript UTF-16 code-unit offsets, as do native MENTION ranges. */
export function parseSticonRanges(text: string | null, contentMetadata: unknown): SticonRange[] {
  try {
    if (text === null || text.length > 16_384 || !contentMetadata || typeof contentMetadata !== 'object' || Array.isArray(contentMetadata)) return [];
    const metadata = contentMetadata as Record<string, unknown>;
    if (typeof metadata.REPLACE !== 'string' || utf8LengthAtMost(metadata.REPLACE, STICON_REPLACE_MAX_BYTES) > STICON_REPLACE_MAX_BYTES) return [];
    const replace: unknown = JSON.parse(metadata.REPLACE);
    if (!replace || typeof replace !== 'object' || Array.isArray(replace)) return [];
    const sticon = (replace as Record<string, unknown>).sticon;
    if (!sticon || typeof sticon !== 'object' || Array.isArray(sticon)) return [];
    const resources = (sticon as Record<string, unknown>).resources;
    if (!Array.isArray(resources) || resources.length > 64) return [];
    const ranges: SticonRange[] = [];
    for (const resource of resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return [];
      const item = resource as Record<string, unknown>;
      const start = item.S, end = item.E;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > text.length
        || typeof item.productId !== 'string' || !/^[0-9a-f]{24}$/.test(item.productId)
        || typeof item.sticonId !== 'string' || !/^[0-9]{1,6}$/.test(item.sticonId)
        || (item.resourceType !== 'ANIMATION' && item.resourceType !== 'STATIC')) return [];
      const splitsSurrogate = (offset: number) => offset > 0 && offset < text.length
        && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
        && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
      if (splitsSurrogate(start as number) || splitsSurrogate(end as number)) return [];
      ranges.push({ start: start as number, end: end as number, productId: item.productId, sticonId: item.sticonId, animated: item.resourceType === 'ANIMATION' });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) return [];
    return ranges;
  } catch { return []; }
}

export const InboundEnvelopeSchema = z.strictObject({
  eventId: IdSchema,
  accountId: IdSchema,
  chatId: IdSchema,
  chatType: WritableChatTypeSchema,
  senderId: IdSchema,
  messageId: IdSchema,
  kind: MessageKindSchema,
  contact: ContactDescriptorSchema.optional(),
  text: z.string().nullable(),
  mentionIds: z.array(IdSchema),
  mentionRanges: z.array(MentionRangeSchema),
  replyToMessageId: IdSchema.nullable(),
  ingestion: z.strictObject({ source: z.enum(['live', 'history']), cursor: IdSchema.nullable() }),
  occurredAt: TimestampSchema,
  attachments: z.array(AttachmentDescriptorSchema),
  raw: JsonValueSchema,
}).superRefine((envelope, context) => {
  if ((envelope.kind === 'contact') !== (envelope.contact !== undefined)) {
    context.addIssue({ code: 'custom', path: ['contact'], message: 'Contact descriptor must appear only on contact envelopes' });
  }
  for (const [index, range] of envelope.mentionRanges.entries()) {
    if (envelope.text === null || range.end > envelope.text.length) {
      context.addIssue({ code: 'custom', path: ['mentionRanges', index], message: 'Mention range exceeds text' });
    }
    if (!envelope.mentionIds.includes(range.userId)) {
      context.addIssue({ code: 'custom', path: ['mentionRanges', index, 'userId'], message: 'Mention user is absent from mentionIds' });
    }
  }
});
export type InboundEnvelope = z.infer<typeof InboundEnvelopeSchema>;

export const WorkerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('loginQr') }),
  z.strictObject({ type: z.literal('loginToken'), token: z.string().min(1) }),
  z.strictObject({ type: z.literal('setSecretState'), accountId: IdSchema, workerInstanceId: IdSchema, secrets: z.strictObject({ token: z.string().nullable(), e2eeStorage: JsonValueSchema.nullable() }) }),
  z.strictObject({ type: z.literal('start'), accountId: IdSchema, workerInstanceId: IdSchema }),
  z.strictObject({ type: z.literal('syncHistory'), accountId: IdSchema, cursor: IdSchema.nullable() }),
  z.strictObject({ type: z.literal('ackDurableCursor'), accountId: IdSchema, cursor: IdSchema, disposition: z.enum(['inserted', 'duplicate']) }),
  WorkerBindingSchema.extend({ type: z.literal('applyAccountMode'), mode: AccountModeSchema }),
  WorkerBindingSchema.extend({ type: z.literal('revokeControl') }),
  WorkerBindingSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('sendText'), requestId: IdSchema, text: z.string().min(1) }),
  WorkerBindingSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('replyText'), requestId: IdSchema, replyToMessageId: IdSchema, text: z.string().min(1) }),
  WritableConversationKeySchema.extend({ type: z.literal('downloadAttachment'), workerInstanceId: IdSchema, messageId: IdSchema, attachmentId: UuidSchema }),
  z.strictObject({ type: z.literal('stop') }),
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;

export const WorkerErrorSchema = z.strictObject({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type WorkerError = z.infer<typeof WorkerErrorSchema>;

export const AttachmentResultSchema = z.discriminatedUnion('status', [
  WritableConversationKeySchema.extend({ type: z.literal('attachmentResult'), attachmentId: UuidSchema, attemptToken: UuidSchema, workerInstanceId: IdSchema,
    controlEpoch: ControlEpochSchema.optional(), transportOwnerId: IdSchema.optional(), transportGeneration: ControlEpochSchema.optional(),
    writeGrantVersion: ControlEpochSchema.optional(), status: z.literal('ready'), relativePath: RelativePathSchema,
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), sizeBytes: z.number().int().nonnegative(), name: z.string().min(1) }),
  WritableConversationKeySchema.extend({ type: z.literal('attachmentResult'), attachmentId: UuidSchema, attemptToken: UuidSchema, workerInstanceId: IdSchema,
    controlEpoch: ControlEpochSchema.optional(), transportOwnerId: IdSchema.optional(), transportGeneration: ControlEpochSchema.optional(),
    writeGrantVersion: ControlEpochSchema.optional(), status: z.enum(['failed', 'expired']), error: z.string().min(1),
    serverErrorCode: z.string().max(80).refine((value) => value.startsWith('LINE_TALK_') && isLineServerErrorCode(value)).optional(),
    upstreamCode: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional() }),
]);
export type AttachmentResult = z.infer<typeof AttachmentResultSchema>;

export const WorkerEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('qr'), code: z.string().min(1) }),
  z.strictObject({ type: z.literal('pin'), pin: z.string().min(1) }),
  z.strictObject({ type: z.literal('login'), accountId: IdSchema, workerInstanceId: IdSchema, displayName: z.string().nullable() }),
  z.strictObject({ type: z.literal('status'), accountId: IdSchema.nullable(), state: z.enum(['disconnected', 'connecting', 'ready', 'degraded', 'stopped']), message: z.string().nullable() }),
  z.strictObject({ type: z.literal('envelope'), envelope: InboundEnvelopeSchema }),
  z.strictObject({ type: z.literal('sendResult'), requestId: IdSchema, status: z.enum(['sent', 'failed']), messageId: IdSchema.nullable(), error: z.string().nullable() }),
  z.strictObject({ type: z.literal('secretRotation'), accountId: IdSchema, workerInstanceId: IdSchema, secrets: z.strictObject({ token: z.string().nullable(), e2eeStorage: JsonValueSchema.nullable() }) }),
  z.strictObject({ type: z.literal('modeAck'), accountId: IdSchema, workerInstanceId: IdSchema, mode: AccountModeSchema, controlEpoch: ControlEpochSchema }),
  WorkerErrorSchema,
  AttachmentResultSchema,
]);
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
