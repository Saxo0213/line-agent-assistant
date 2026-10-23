import { z } from 'zod';
import { AccountModeSchema, WritableConversationKeySchema, WorkerBindingSchema } from './account.js';
import { NativeAttachmentDownloadInputSchema } from './native-source.js';
import { JsonValueSchema } from './json.js';
import { AttachmentResultSchema, InboundEnvelopeSchema } from './line.js';

const Id = z.string().min(1);
const Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/).refine((value) =>
  /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Expected signed 64-bit decimal');

export const TalkCursorV1Schema = z.strictObject({
  version: z.literal(1), revision: Decimal, globalRev: Decimal, individualRev: Decimal,
});
export type TalkCursorV1Dto = z.infer<typeof TalkCursorV1Schema>;

export const ReadReceiptSchema = z.strictObject({
  chatId: z.string().regex(/^[ucr][0-9a-f]{32}$/),
  readerMid: z.string().regex(/^u[0-9a-f]{32}$/),
  messageId: z.string().regex(/^[0-9]{1,20}$/),
  readAt: z.iso.datetime({ offset: true }),
});
export type ReadReceiptDto = z.infer<typeof ReadReceiptSchema>;

const Bound = WorkerBindingSchema;
export const WORKER_PROTOCOL_VERSION = 4 as const;
const UserMid = z.string().regex(/^u[0-9a-fA-F]{32}$/);
const Conversation = Bound.merge(WritableConversationKeySchema);
const LoginAttempt = Bound.extend({ loginAttemptId: Id });
export const WorkerPurposeSchema = z.enum(['STANDARD', 'DOWNLOAD_ONLY']);
export type WorkerPurpose = z.infer<typeof WorkerPurposeSchema>;
export const LOGIN_FAILURES = {
  LOGIN_TIMEOUT: 'LINE login timed out. Try again.',
  LOGIN_IN_PROGRESS: 'A LINE login is already in progress.',
  LOGIN_ATTEMPT_REPLACED: 'This LINE login attempt was replaced. Try again.',
  LOGIN_FAILED: 'LINE login failed. Try again.',
} as const;
const LoginFailure = z.union([
  LoginAttempt.extend({ type: z.literal('loginFailure'), code: z.literal('LOGIN_TIMEOUT'), message: z.literal(LOGIN_FAILURES.LOGIN_TIMEOUT) }),
  LoginAttempt.extend({ type: z.literal('loginFailure'), code: z.literal('LOGIN_IN_PROGRESS'), message: z.literal(LOGIN_FAILURES.LOGIN_IN_PROGRESS) }),
  LoginAttempt.extend({ type: z.literal('loginFailure'), code: z.literal('LOGIN_ATTEMPT_REPLACED'), message: z.literal(LOGIN_FAILURES.LOGIN_ATTEMPT_REPLACED) }),
  LoginAttempt.extend({ type: z.literal('loginFailure'), code: z.literal('LOGIN_FAILED'), message: z.literal(LOGIN_FAILURES.LOGIN_FAILED) }),
]);
const Secrets = z.strictObject({ token: Id.nullable(), qrCert: Id.nullable(), e2eeStorage: JsonValueSchema.nullable() });
export const ConversationCatalogMemberSchema = z.strictObject({
  memberId: Id,
  displayName: z.string().nullable(),
  /** The name the account owner set locally for this contact (LINE Contact.displayNameOverridden); absent when the response did not carry it. */
  nickname: z.string().max(256).nullable().optional(),
  picturePath: z.string().max(2048).nullable().optional(),
});
export const ConversationCatalogItemSchema = z.strictObject({
  chatType: z.enum(['direct', 'group', 'room']),
  chatId: Id,
  title: z.string().nullable(),
  picturePath: z.string().max(2048).nullable().optional(),
  members: z.array(ConversationCatalogMemberSchema),
});
export type ConversationCatalogItem = z.infer<typeof ConversationCatalogItemSchema>;

export const DownloadAuthProbeSchema = z.strictObject({
  chatType: z.enum(['direct', 'group', 'room']),
  chatId: Id,
  messageId: Id,
  externalAttachmentId: Id,
  kind: z.enum(['image', 'video', 'audio', 'file']),
  lineMessage: JsonValueSchema,
  nativeAttachment: NativeAttachmentDownloadInputSchema.optional(),
});
export type DownloadAuthProbe = z.infer<typeof DownloadAuthProbeSchema>;

export const MEDIA_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_FILE_MAX_BYTES = 100 * 1024 * 1024;

export const LineWorkerCommandSchema = z.discriminatedUnion('type', [
  Bound.extend({ type: z.literal('init'), protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), mode: AccountModeSchema, durableCursor: TalkCursorV1Schema,
    purpose: WorkerPurposeSchema.optional(), expectedMid: Id.optional(), application: z.string().min(1).max(512).optional() }),
  Bound.extend({ type: z.literal('adoptDownloadAuth'), requestId: Id, token: z.string().min(1).max(1024),
    application: z.string().min(1).max(512), expectedMid: Id, probe: DownloadAuthProbeSchema.optional() }),
  LoginAttempt.extend({ type: z.literal('loginQr') }),
  LoginAttempt.extend({ type: z.literal('loginToken') }),
  LoginAttempt.extend({ type: z.literal('setSecretState'), secrets: Secrets }),
  Bound.extend({ type: z.literal('poll') }),
  Bound.extend({ type: z.literal('ackBatch'), batchId: Id, cursorAfter: TalkCursorV1Schema }),
  Conversation.extend({ type: z.literal('history'), requestId: Id, cursor: Id.nullable(), limit: z.number().int().min(1).max(100) }),
  Conversation.extend({ type: z.literal('sendText'), requestId: Id, text: Id, replyToMessageId: Id.nullable(),
    operationId: Id.optional(), attemptId: Id.optional(), effectPermit: Id.optional() }),
  Conversation.extend({ type: z.literal('manualSendText'), requestId: Id, text: Id, replyToMessageId: Id.nullable(),
    operationId: Id.optional(), attemptId: Id.optional(), effectPermit: Id.optional() }),
  Conversation.extend({ type: z.literal('sendMedia'), chatType: z.enum(['direct', 'group']), requestId: Id,
    kind: z.enum(['image', 'file']), filePath: z.string().min(1).max(1024).regex(/^(?:[A-Za-z]:[\\/]|\/)/),
    fileName: z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= 180, 'fileName exceeds 180 bytes'),
    sizeBytes: z.number().int().positive().max(MEDIA_FILE_MAX_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    operationId: Id, attemptId: Id, effectPermit: Id }).refine((command) =>
    command.kind !== 'image' || command.sizeBytes <= MEDIA_IMAGE_MAX_BYTES, 'image exceeds 20 MiB'),
  Conversation.extend({ type: z.literal('reactMessage'), requestId: Id, messageId: Decimal,
    reaction: z.enum(['NICE', 'AMAZING', 'FUN', 'LOVE', 'SAD', 'OMG', 'UNDO']) }),
  Bound.extend({ type: z.literal('checkFriendRelation'), requestId: Id, targetMid: UserMid }),
  Bound.extend({ type: z.literal('addFriendByMid'), requestId: Id, targetMid: UserMid }),
  Conversation.extend({ type: z.literal('downloadAttachment'), requestId: Id, attemptToken: z.uuid(), messageId: Id, attachmentId: z.uuid(), externalAttachmentId: Id, kind: z.enum(['image', 'video', 'audio', 'file']), occurredAt: z.iso.datetime({ offset: true }), originalFileName: z.string(), lineMessage: JsonValueSchema, nativeAttachment: NativeAttachmentDownloadInputSchema.optional(), maxBytes: z.number().int().positive(), timeoutMs: z.number().int().positive() }),
  Bound.extend({ type: z.literal('cancelAttachmentDownload'), attachmentId: z.uuid(), attemptToken: z.uuid() }),
  Bound.extend({ type: z.literal('revokeControl') }),
  Bound.extend({ type: z.literal('stop') }),
]);
export type LineWorkerCommand = z.infer<typeof LineWorkerCommandSchema>;

export const LineWorkerEventSchema = z.union([
  LoginFailure,
  LoginAttempt.extend({ type: z.literal('qr'), code: Id }),
  LoginAttempt.extend({ type: z.literal('pin'), pin: Id }),
  LoginAttempt.extend({ type: z.literal('secretRotation'), secrets: Secrets }),
  LoginAttempt.extend({ type: z.literal('login'), displayName: z.string().nullable(), ownMid: Id, picturePath: z.string().max(2048).nullable().optional() }),
  Bound.extend({ type: z.literal('status'), state: z.enum(['disconnected', 'connecting', 'ready', 'degraded', 'stopped', 'PROTOCOL_UNVERIFIED']), message: z.string().nullable() }),
  Bound.extend({ type: z.literal('modeAck'), mode: AccountModeSchema, drained: z.boolean() }),
  Bound.extend({ type: z.literal('workerProtocolAck'), protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), manualSend: z.literal(true) }),
  Bound.extend({ type: z.literal('authInvalidated') }),
  Bound.extend({ type: z.literal('downloadAuthResult'), requestId: Id, accepted: z.boolean(), error: z.enum(['PROFILE_MISMATCH', 'AUTH_UNAVAILABLE', 'APPLICATION_MISMATCH']).nullable() }),
  Bound.extend({ type: z.literal('downloadAuthInvalidated') }),
  Bound.extend({ type: z.literal('downloadReady'), ownMid: Id }),
  Bound.extend({ type: z.literal('catalogRefreshStatus'), state: z.literal('degraded'), code: z.literal('CATALOG_REFRESH_FAILED') }),
  Bound.extend({ type: z.literal('catalogRefreshStatus'), state: z.literal('ready'), code: z.literal('CATALOG_REFRESH_RECOVERED') }),
  Bound.extend({ type: z.literal('batch'), batchId: Id, cursorBefore: TalkCursorV1Schema, cursorAfter: TalkCursorV1Schema, envelopes: z.array(InboundEnvelopeSchema),
    readReceipts: z.array(ReadReceiptSchema).max(500).optional() }),
  Bound.extend({ type: z.literal('conversationCatalog'), conversations: z.array(ConversationCatalogItemSchema) }),
  Conversation.extend({ type: z.literal('historyResult'), requestId: Id, nextCursor: Id.nullable(), envelopes: z.array(InboundEnvelopeSchema) }),
  Bound.extend({ type: z.literal('sendResult'), requestId: Id, status: z.enum(['sent', 'failed', 'unknown']), messageId: Id.nullable(), error: z.string().nullable(),
    operationId: Id.optional(), attemptId: Id.optional() }),
  Bound.extend({ type: z.literal('friendRelationResult'), requestId: Id, targetMid: UserMid,
    status: z.enum(['friend', 'not_friend', 'unknown']), error: z.string().nullable() }),
  Bound.extend({ type: z.literal('addFriendResult'), requestId: Id, targetMid: UserMid,
    status: z.enum(['added', 'failed', 'unknown']), error: z.string().nullable() }),
  Bound.extend({ type: z.literal('error'), code: Id, message: Id, retryable: z.boolean() }),
  AttachmentResultSchema,
  Bound.extend({ type: z.literal('attachmentCancelAck'), attachmentId: z.uuid(), attemptToken: z.uuid(), cancelled: z.boolean() }),
]);
export type LineWorkerEvent = z.infer<typeof LineWorkerEventSchema>;
