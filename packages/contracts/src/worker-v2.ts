import { z } from 'zod';
import { DIAGNOSTIC_DETAIL_PATTERN, SafeDiagnosticSchema, SendDetailSchema } from './diagnostics.js';
import { AccountModeSchema, isLinejsTransport, WritableConversationKeySchema, WorkerBindingSchema } from './account.js';
import { JsonValueSchema } from './json.js';
import { ArchiveInboundEnvelopeSchema, AttachmentResultSchema, InboundEnvelopeSchema, OutgoingMentionSchema, OUTGOING_MENTIONS_MAX, outgoingMentionsIssue } from './line.js';
import { lineServerErrorMessage, type LineServerErrorCode } from './line-server-error.js';

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

/** A LINE unsend operation (OpType 64 or 65) seen by the login source. messageId is a signed 64-bit decimal. */
export const UnsendSchema = z.strictObject({
  chatId: z.string().regex(/^[ucr][0-9a-f]{32}$/),
  messageId: Decimal,
  kind: z.enum(['self', 'notified']),
  observedAt: z.iso.datetime({ offset: true }),
});
export type UnsendDto = z.infer<typeof UnsendSchema>;

const Bound = WorkerBindingSchema;
export const WORKER_PROTOCOL_VERSION = 5 as const;
const SquareToken = z.string().min(1).max(4096);
/** Upper bound of envelopes in one squareBatch (LINE returns at most 100 events per fetch). */
export const SQUARE_BATCH_MAX_ENVELOPES = 500;
export const WORKER_ERROR_CODES = ['INVALID_COMMAND', 'QUEUE_FULL', 'CATALOG_REFRESH_FAILED', 'WORKER_OPERATION_FAILED',
  'HISTORY_READ_FAILED', 'CHAT_RESOURCE_READ_FAILED', 'PROFILE_REFRESH_FAILED', 'MESSAGE_SEND_FAILED',
  'MESSAGE_UNSEND_FAILED', 'MESSAGE_REACTION_FAILED', 'FRIEND_RELATION_CHECK_FAILED', 'FRIEND_ADD_FAILED',
  'ATTACHMENT_DOWNLOAD_OPERATION_FAILED', 'CREDENTIAL_RESTORE_FAILED', 'LINE_SYNC_FAILED', 'CHROME_LTSM_UNAVAILABLE', 'LINE_CONNECTION_SUSPENDED', 'LINE_SQUARE_SUSPENDED'] as const;
export type WorkerErrorCode = typeof WORKER_ERROR_CODES[number] | LineServerErrorCode;
const WorkerErrorCodeSchema = z.union([z.enum(WORKER_ERROR_CODES),
  z.custom<LineServerErrorCode>((value) => lineServerErrorMessage(value) !== null)]);
const UserMid = z.string().regex(/^u[0-9a-fA-F]{32}$/);
export const CONTACT_LOOKUP_RELATIONS = ['friend', 'not_friend', 'blocked', 'self', 'unknown'] as const;
export const ContactLookupSchema = z.strictObject({
  mid: UserMid,
  displayName: z.string().max(256).nullable(),
  statusMessage: z.string().max(1024).nullable(),
  picturePath: z.string().max(2048).nullable(),
  relation: z.enum(CONTACT_LOOKUP_RELATIONS),
});
export type ContactLookupDto = z.infer<typeof ContactLookupSchema>;
const SourceChatMid = z.string().regex(/^[ucr][0-9a-fA-F]{32}$/);
const Conversation = Bound.merge(WritableConversationKeySchema);
const LoginAttempt = Bound.extend({ loginAttemptId: Id });
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
  LoginAttempt.extend({ type: z.literal('loginFailure'), code: z.literal('LOGIN_FAILED'), message: z.literal(LOGIN_FAILURES.LOGIN_FAILED),
    detail: z.string().regex(DIAGNOSTIC_DETAIL_PATTERN).optional(), upstreamStatus: z.number().int().min(100).max(599).optional() }),
]);
const Secrets = z.strictObject({ token: Id.nullable(), qrCert: Id.nullable(), e2eeStorage: JsonValueSchema.nullable() });
export const ConversationCatalogMemberSchema = z.strictObject({
  memberId: Id,
  displayName: z.string().nullable(),
  /** The name the account owner set locally for this contact (LINE Contact.displayNameOverridden); absent when the response did not carry it. */
  nickname: z.string().max(256).nullable().optional(),
  picturePath: z.string().max(2048).nullable().optional(),
  /** True: on the friend list. False: a blocked friend. Absent: the response did not say. */
  friend: z.boolean().optional(),
});
export const ConversationCatalogItemSchema = z.strictObject({
  chatType: z.enum(['direct', 'group', 'room']),
  chatId: Id,
  title: z.string().nullable(),
  picturePath: z.string().max(2048).nullable().optional(),
  members: z.array(ConversationCatalogMemberSchema),
});
export type ConversationCatalogItem = z.infer<typeof ConversationCatalogItemSchema>;

export const MEDIA_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const CHAT_RESOURCE_MAX_BYTES = 20 * 1024 * 1024;
const ChatResourceAction = z.enum(['listNotes', 'getNote', 'listAlbums', 'listAlbumPhotos', 'downloadAlbumPhoto']);
const ResourceCursor = z.string().max(2048).nullable();
const ResourceId = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const ChatResourceNote = z.strictObject({ postId: ResourceId, createdTime: z.number().int().nonnegative().nullable(),
  text: z.string().max(64 * 1024).nullable(), content: z.record(z.string().max(128), JsonValueSchema).optional() });
const ChatResourceAlbum = z.strictObject({ albumId: ResourceId, chatId: Id.max(256), title: z.string().max(512).nullable(),
  photoCount: z.number().int().nonnegative().nullable(), createTime: z.number().int().nonnegative().nullable(),
  updateTime: z.number().int().nonnegative().nullable() });
const ChatResourcePhoto = z.strictObject({ photoId: ResourceId, oid: ResourceId, prefix: z.enum(['album/a', 'album/v']),
  shotTime: z.number().int().nonnegative().nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable() });
export const ChatResourceReadCommandSchema = Conversation.extend({ type: z.literal('chatResourceRead'), requestId: Id.max(128),
  action: ChatResourceAction, cursor: ResourceCursor.optional(), limit: z.number().int().min(1).max(50).optional(),
  /** The LINE one-to-one chat id of a direct chat ("o" + 32 lowercase hex). Notes and albums of a direct chat use it, not the peer MID. */
  homeChatId: z.string().regex(/^o[0-9a-f]{32}$/).optional(),
  postId: ResourceId.optional(), albumId: ResourceId.optional(), photoId: ResourceId.optional(), oid: ResourceId.optional(),
  prefix: z.enum(['album/a', 'album/v']).optional(), maxBytes: z.number().int().positive().max(CHAT_RESOURCE_MAX_BYTES).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000) }).superRefine((command, context) => {
  const required: Partial<Record<typeof command.action, (keyof typeof command)[]>> = {
    getNote: ['postId'], listAlbumPhotos: ['albumId'], downloadAlbumPhoto: ['albumId', 'photoId', 'oid', 'prefix', 'maxBytes'],
  };
  for (const key of required[command.action] ?? []) if (command[key] === undefined) context.addIssue({ code: 'custom', path: [key], message: 'Required for action' });
});
export type ChatResourceReadCommand = z.infer<typeof ChatResourceReadCommandSchema>;
export const ChatResourcePhotoPageShapeSchema = z.strictObject({ rawPhotoCount: z.number().int().min(0).max(1_000_000),
  hasMorePresent: z.boolean(), hasMore: z.boolean().optional(), nextCursorRelation: z.enum(['absent', 'same', 'advanced']) })
  .superRefine((shape, context) => {
    if (!shape.hasMorePresent && shape.hasMore !== undefined) context.addIssue({ code: 'custom', path: ['hasMore'], message: 'A missing hasMore field cannot have a value' });
  });
export type ChatResourcePhotoPageShape = z.infer<typeof ChatResourcePhotoPageShapeSchema>;
export const ChatResourceReadResultSchema = Conversation.extend({ type: z.literal('chatResourceResult'), requestId: Id.max(128),
  action: ChatResourceAction, ok: z.boolean(), error: z.string().max(80).nullable(),
  responseCode: z.union([z.number().finite().min(-1_000_000_000).max(1_000_000_000), z.enum(['missing', 'non_numeric'])]).optional(),
  failureKind: z.enum(['linejs_internal', 'effect_denied', 'type_error', 'range_error', 'timeout_error', 'abort_error', 'other']).optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  upstreamCode: z.union([z.number().finite().min(-1_000_000_000).max(1_000_000_000), z.enum(['missing', 'non_numeric'])]).optional(),
  /** Bounded LINE `message` text of a failed reply: at most 200 characters, no control characters. */
  upstreamMessage: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/).optional(),
  nextCursor: ResourceCursor.optional(),
  photoPageShape: ChatResourcePhotoPageShapeSchema.optional(),
  notes: z.array(ChatResourceNote).max(50).optional(), note: ChatResourceNote.optional(), albums: z.array(ChatResourceAlbum).max(50).optional(),
  photos: z.array(ChatResourcePhoto).max(50).optional(), bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array)
    .refine((value) => value.byteLength <= CHAT_RESOURCE_MAX_BYTES).optional() }).superRefine((result, context) => {
  const payload = ['notes', 'note', 'albums', 'photos', 'bytes'].some((key) => Object.hasOwn(result, key));
  if (result.photoPageShape !== undefined && (result.action !== 'listAlbumPhotos' || !result.ok)) {
    context.addIssue({ code: 'custom', path: ['photoPageShape'], message: 'Photo page shape is restricted to successful album photo reads' });
  }
  if (result.responseCode !== undefined && (result.ok || result.error !== 'response_code_invalid'
    || (result.action !== 'listNotes' && result.action !== 'getNote'))) {
    context.addIssue({ code: 'custom', path: ['responseCode'], message: 'Response code is restricted to failed Note reads' });
  }
  if ((result.failureKind !== undefined || result.upstreamStatus !== undefined || result.upstreamCode !== undefined
    || result.upstreamMessage !== undefined) && result.ok) {
    context.addIssue({ code: 'custom', path: ['failureKind'], message: 'Failure diagnostics require a failed read' });
  }
  if (!result.ok) {
    if (result.error === null || payload) context.addIssue({ code: 'custom', path: ['error'], message: 'Failed reads require an error without payload' });
    return;
  }
  if (result.error !== null) context.addIssue({ code: 'custom', path: ['error'], message: 'Successful reads cannot include an error' });
  const expected = result.action === 'listNotes' ? 'notes' : result.action === 'getNote' ? 'note'
    : result.action === 'listAlbums' ? 'albums' : result.action === 'listAlbumPhotos' ? 'photos' : 'bytes';
  if (!Object.hasOwn(result, expected)) context.addIssue({ code: 'custom', path: [expected], message: 'Successful read is missing its payload' });
  for (const key of ['notes', 'note', 'albums', 'photos', 'bytes']) if (key !== expected && Object.hasOwn(result, key)) {
    context.addIssue({ code: 'custom', path: [key], message: 'Payload does not match action' });
  }
});

export const LineWorkerCommandSchema = z.discriminatedUnion('type', [
  Bound.extend({ type: z.literal('init'), protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), mode: AccountModeSchema, durableCursor: TalkCursorV1Schema,
    /** Absolute path of the ltsm store root under app userData. Only meaningful (and only allowed) for CHROMEOS. */
    chromeLtsmDir: z.string().min(1).max(1024).regex(/^(?:[A-Za-z]:[\\/]|\/)/).optional(),
    /** Absolute path of the LINE traffic log directory under app userData. A worker without it does not log. */
    trafficLogDir: z.string().min(1).max(1024).regex(/^(?:[A-Za-z]:[\\/]|\/)/).optional(),
    /** True turns on the LEGY encrypted transport. Absent or false means the plain transport. Only allowed for the linejs devices. */
    legyEncrypted: z.boolean().optional(),
    /** Stored community (Square) sync token. Absent or null means no stored token (first run). */
    squareCursor: SquareToken.nullable().optional(),
    /** True turns on community message receive. Absent or false means off. Only allowed for the linejs devices. */
    squareReceive: z.boolean().optional() }).superRefine((command, context) => {
    if (isLinejsTransport(command.lineTransport)) {
      if (command.chromeLtsmDir !== undefined) context.addIssue({ code: 'custom', path: ['chromeLtsmDir'], message: 'chromeLtsmDir requires lineTransport CHROMEOS' });
      // IOSIPAD has no LEGY encrypted transport. Its direct legacy token never goes to the LEGY outer URL.
      if (command.lineTransport === 'IOSIPAD' && command.legyEncrypted === true) {
        context.addIssue({ code: 'custom', path: ['legyEncrypted'], message: 'legyEncrypted is not available for lineTransport IOSIPAD' });
      }
      return;
    }
    if (command.squareReceive === true) context.addIssue({ code: 'custom', path: ['squareReceive'], message: 'squareReceive requires a linejs lineTransport' });
    if (command.legyEncrypted !== undefined) context.addIssue({ code: 'custom', path: ['legyEncrypted'], message: 'legyEncrypted requires a linejs lineTransport' });
  }),
  LoginAttempt.extend({ type: z.literal('loginQr') }),
  LoginAttempt.extend({ type: z.literal('loginToken') }),
  LoginAttempt.extend({ type: z.literal('setSecretState'), secrets: Secrets }),
  Bound.extend({ type: z.literal('poll') }),
  /** One user-started catalog read (`listConversations`). The worker answers with a `conversationCatalog` event and nothing else. */
  Bound.extend({ type: z.literal('refreshCatalog') }),
  Bound.extend({ type: z.literal('ackBatch'), batchId: Id, cursorAfter: TalkCursorV1Schema,
    /** Releases startup suppression only after the final startup batch was durably stored. */
    startupComplete: z.boolean().optional() }),
  /** Confirms that a squareBatch was durably stored. tokenAfter must match the batch. */
  Bound.extend({ type: z.literal('ackSquareBatch'), batchId: Id.max(128), tokenAfter: SquareToken }),
  Conversation.extend({ type: z.literal('history'), requestId: Id, cursor: Id.nullable(), limit: z.number().int().min(1).max(100) }),
  ChatResourceReadCommandSchema,
  Bound.extend({ type: z.literal('refreshOwnProfile'), requestId: Id.max(128), timeoutMs: z.number().int().min(1_000).max(30_000) }),
  Bound.extend({ type: z.literal('logout'), requestId: Id.max(128) }),
  Conversation.extend({ type: z.literal('cancelChatResourceRead'), requestId: Id.max(128) }),
  Conversation.extend({ type: z.literal('sendText'), requestId: Id, text: Id, replyToMessageId: Id.nullable(),
    mentions: z.array(OutgoingMentionSchema).max(OUTGOING_MENTIONS_MAX).optional(),
    operationId: Id.optional(), attemptId: Id.optional(), effectPermit: Id.optional() }).superRefine((command, context) => {
    const issue = command.mentions && command.mentions.length > 0 ? outgoingMentionsIssue(command.text, command.mentions) : null;
    if (issue) context.addIssue({ code: 'custom', path: ['mentions'], message: issue });
  }),
  Conversation.extend({ type: z.literal('manualSendText'), requestId: Id, text: Id, replyToMessageId: Id.nullable(),
    mentions: z.array(OutgoingMentionSchema).max(OUTGOING_MENTIONS_MAX).optional(),
    operationId: Id.optional(), attemptId: Id.optional(), effectPermit: Id.optional() }).superRefine((command, context) => {
    const issue = command.mentions && command.mentions.length > 0 ? outgoingMentionsIssue(command.text, command.mentions) : null;
    if (issue) context.addIssue({ code: 'custom', path: ['mentions'], message: issue });
  }),
  Conversation.extend({ type: z.literal('sendMedia'), chatType: z.enum(['direct', 'group']), requestId: Id,
    manualSend: z.literal(true).optional(),
    kind: z.enum(['image', 'file']), filePath: z.string().min(1).max(1024).regex(/^(?:[A-Za-z]:[\\/]|\/)/),
    fileName: z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= 180, 'fileName exceeds 180 bytes'),
    sizeBytes: z.number().int().positive().max(MEDIA_FILE_MAX_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    operationId: Id, attemptId: Id, effectPermit: Id }).refine((command) =>
    command.kind !== 'image' || command.sizeBytes <= MEDIA_IMAGE_MAX_BYTES, 'image exceeds 20 MiB'),
  Conversation.extend({ type: z.literal('reactMessage'), requestId: Id, messageId: Decimal,
    reaction: z.enum(['NICE', 'AMAZING', 'FUN', 'LOVE', 'SAD', 'OMG', 'UNDO']) }),
  Conversation.extend({ type: z.literal('unsendMessage'), requestId: Id, messageId: Decimal }),
  Bound.extend({ type: z.literal('checkFriendRelation'), requestId: Id, targetMid: UserMid }),
  Bound.extend({ type: z.literal('addFriendByMid'), requestId: Id, targetMid: UserMid, sourceChatMid: SourceChatMid.optional() }),
  /** One user-started contact read (getContactsV3). It never adds a friend and never sends a message. */
  Bound.extend({ type: z.literal('lookupContact'), requestId: Id.max(128), targetMid: UserMid }),
  Conversation.extend({ type: z.literal('downloadAttachment'), requestId: Id, attemptToken: z.uuid(), messageId: Id, attachmentId: z.uuid(), externalAttachmentId: Id, kind: z.enum(['image', 'video', 'audio', 'file']), occurredAt: z.iso.datetime({ offset: true }), originalFileName: z.string(), senderId: Id.optional(), senderDisplayName: z.string().max(256).nullable().optional(), lineMessage: JsonValueSchema, maxBytes: z.number().int().positive(), timeoutMs: z.number().int().positive() }),
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
  Bound.extend({ type: z.literal('authInvalidated'), code: z.custom<LineServerErrorCode>((value) => lineServerErrorMessage(value) !== null).optional(),
    upstreamCode: z.union([z.number().finite().min(-1_000_000_000).max(1_000_000_000), z.enum(['missing', 'non_numeric'])]).optional() }),
  Bound.extend({ type: z.literal('syncConfirmed') }),
  Bound.extend({ type: z.literal('catalogRefreshStatus'), state: z.literal('degraded'), code: z.literal('CATALOG_REFRESH_FAILED'),
    serverError: z.string().max(80).refine((value) => lineServerErrorMessage(value) !== null).optional() }),
  Bound.extend({ type: z.literal('catalogRefreshStatus'), state: z.literal('ready'), code: z.literal('CATALOG_REFRESH_RECOVERED') }),
  z.discriminatedUnion('ok', [
    Bound.extend({ type: z.literal('ownProfileResult'), requestId: Id.max(128), ok: z.literal(true), error: z.null(), ownMid: UserMid,
      displayName: z.string().max(256).nullable(), picturePath: z.string().max(2048).nullable().optional() }),
    Bound.extend({ type: z.literal('ownProfileResult'), requestId: Id.max(128), ok: z.literal(false), error: z.string().max(80) }),
  ]),
  z.discriminatedUnion('ok', [
    Bound.extend({ type: z.literal('logoutResult'), requestId: Id.max(128), ok: z.literal(true), error: z.null() }),
    Bound.extend({ type: z.literal('logoutResult'), requestId: Id.max(128), ok: z.literal(false), error: z.enum(['LINE_LOGOUT_FAILED', 'LINE_AUTH_INVALIDATED']) }),
  ]),
  Bound.extend({ type: z.literal('batch'), batchId: Id, cursorBefore: TalkCursorV1Schema, cursorAfter: TalkCursorV1Schema, envelopes: z.array(InboundEnvelopeSchema),
    /** Startup sync batches are archived without inbound automation. */
    startupSync: z.boolean().optional(), startupFinal: z.boolean().optional(),
    readReceipts: z.array(ReadReceiptSchema).max(500).optional(),
    unsends: z.array(UnsendSchema).max(500).optional() }),
  /** Community (Square) events for archive only. tokenBefore is null on the first run (no stored token). */
  Bound.extend({ type: z.literal('squareBatch'), batchId: Id.max(128), tokenBefore: SquareToken.nullable(), tokenAfter: SquareToken,
    envelopes: z.array(ArchiveInboundEnvelopeSchema).max(SQUARE_BATCH_MAX_ENVELOPES),
    titles: z.array(z.strictObject({ chatId: z.string().regex(/^m[0-9a-f]{32}$/), title: z.string().min(1).max(256) }))
      .max(SQUARE_BATCH_MAX_ENVELOPES).optional() }),
  Bound.extend({ type: z.literal('startupSyncComplete'), batchId: Id }),
  Bound.extend({ type: z.literal('conversationCatalog'), conversations: z.array(ConversationCatalogItemSchema) }),
  Conversation.extend({ type: z.literal('historyResult'), requestId: Id, nextCursor: Id.nullable(), envelopes: z.array(InboundEnvelopeSchema) }),
  ChatResourceReadResultSchema,
  Bound.extend({ type: z.literal('sendResult'), requestId: Id, status: z.enum(['sent', 'failed', 'unknown']), messageId: Id.nullable(), error: z.string().nullable(),
    /** Bounded failure detail (for example the media upload stage); see SendDetailSchema. */
    detail: SendDetailSchema.optional(),
    operationId: Id.optional(), attemptId: Id.optional() }),
  Conversation.extend({ type: z.literal('unsendResult'), requestId: Id, messageId: Decimal, status: z.enum(['unsent', 'failed', 'unknown']), error: z.string().nullable() }),
  Bound.extend({ type: z.literal('friendRelationResult'), requestId: Id, targetMid: UserMid,
    status: z.enum(['friend', 'not_friend', 'unknown']), error: z.string().nullable(),
    failureKind: z.enum(['linejs_internal', 'effect_denied', 'type_error', 'range_error', 'timeout_error', 'abort_error', 'other']).optional(),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    upstreamCode: z.union([z.number().int().min(-1_000_000_000).max(1_000_000_000), z.enum(['missing', 'non_numeric'])]).optional()
  }).superRefine((result, context) => {
    if ((result.failureKind !== undefined || result.upstreamStatus !== undefined || result.upstreamCode !== undefined)
      && (result.status !== 'unknown' || result.error !== 'RELATION_DETAIL_RPC_FAILED')) {
      context.addIssue({ code: 'custom', path: ['failureKind'], message: 'Failure diagnostics require a failed friend-detail read' });
    }
  }),
  Bound.extend({ type: z.literal('addFriendResult'), requestId: Id, targetMid: UserMid,
    status: z.enum(['added', 'failed', 'unknown']), error: z.string().nullable() }),
  z.discriminatedUnion('status', [
    Bound.extend({ type: z.literal('contactLookupResult'), requestId: Id.max(128), status: z.literal('ok'), error: z.null(),
      contact: ContactLookupSchema }),
    Bound.extend({ type: z.literal('contactLookupResult'), requestId: Id.max(128), status: z.literal('failed'), error: z.string().min(1).max(80) }),
  ]),
  Bound.extend({ type: z.literal('error'), code: WorkerErrorCodeSchema, message: Id, retryable: z.boolean(),
    diagnostic: SafeDiagnosticSchema.optional(), requestId: Id.max(128).optional(),
    /** Status of the CHROMEOS ltsm store; present only with code CHROME_LTSM_UNAVAILABLE. */
    chromeLtsmStatus: z.enum(['missing', 'wrong-version', 'corrupt']).optional() }),
  AttachmentResultSchema,
  Bound.extend({ type: z.literal('attachmentCancelAck'), attachmentId: z.uuid(), attemptToken: z.uuid(), cancelled: z.boolean() }),
]);
export type LineWorkerEvent = z.infer<typeof LineWorkerEventSchema>;
