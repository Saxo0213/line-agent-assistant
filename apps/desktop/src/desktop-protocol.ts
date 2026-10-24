import { z } from 'zod';
import { SafeDiagnosticSchema } from '@line-agent/contracts';
import { ConversationKeySchema, GeneratedPreviewSchema, MentionRangeSchema, MessageContentSchema, normalizeMentionRanges, SticonRangeSchema, StickerDescriptorSchema } from '@line-agent/contracts';

const AttachmentSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['image', 'video', 'audio', 'file']), name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative(), status: z.string(), canRetryManually: z.boolean().optional() });
export const MessageReactionSchema = z.strictObject({
  kind: z.enum(['NICE', 'LOVE', 'FUN', 'AMAZING', 'SAD', 'OMG', 'PAID']),
  productId: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  emojiId: z.string().regex(/^[0-9]{1,6}$/).optional(),
  count: z.number().int().min(1).max(10000),
  reactorNames: z.array(z.string().max(100)).max(50),
});
const TimelineMessageBaseSchema =ConversationKeySchema.extend({
  messageId: z.string().min(1), senderId: z.string().min(1), senderName: z.string(), senderAvatarAvailable: z.boolean().optional(), text: z.string().nullable(), occurredAt: z.iso.datetime({ offset: true }),
  direction: z.enum(['inbound', 'outbound']), replyToMessageId: z.string().nullable(),
  replyTo: z.strictObject({ messageId: z.string().min(1), senderId: z.string().min(1), senderName: z.string(),
    direction: z.enum(['inbound', 'outbound']), senderAvatarAvailable: z.boolean(), preview: z.string(), display: GeneratedPreviewSchema.optional() }).nullable(),
  deleted: z.boolean(), attachments: z.array(AttachmentSchema),
  mentionRanges: z.array(MentionRangeSchema),
  sticonRanges: z.array(SticonRangeSchema).max(64).default([]),
  agentJobStatus: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).nullable().optional(),
  agentJobId: z.string().nullable().optional(), agentJobRevision: z.string().regex(/^\d{1,20}$/).nullable().optional(),
  kind: z.enum(['text', 'image', 'video', 'audio', 'file', 'sticker', 'contact', 'event', 'location', 'rich']),
  content: MessageContentSchema.nullable().optional(), sticker: StickerDescriptorSchema.nullable(),
  postNotificationType: z.enum(['note', 'album']).nullable().optional(),
  deletedAtSource: z.boolean().optional(),
  readCount: z.number().int().min(1).max(500).optional(),
  reactions: z.array(MessageReactionSchema).max(20).optional(),
  recalledContent: MessageContentSchema.nullable().optional(),
  recalledKind: z.enum(['text', 'image', 'video', 'audio', 'file', 'sticker', 'contact', 'event', 'location', 'rich']).nullable().optional(),
  recalledText: z.string().nullable().optional(),
});
export const TimelineMessageSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const message = value as Record<string, unknown>;
  return { ...message, mentionRanges: normalizeMentionRanges(typeof message.text === 'string' ? message.text : null, message.mentionRanges) };
}, TimelineMessageBaseSchema);
export const MessagePageSchema = z.strictObject({ messages: z.array(TimelineMessageSchema).max(100), olderCursor: z.string().nullable() });
export const AttachmentStateSchema = z.strictObject({ attachmentId: z.uuid(), messageId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio', 'file']), name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative(),
  status: z.string(), canRetryManually: z.boolean() });
export const AttachmentStateListSchema = z.array(AttachmentStateSchema).max(225);
export const WorkRecordSchema = z.strictObject({
  id: z.string().min(1), title: z.string(), status: z.enum(['todo', 'doing', 'waiting', 'done']), key: ConversationKeySchema,
  messageIds: z.array(z.string()), attachmentIds: z.array(z.uuid()), updatedAt: z.iso.datetime({ offset: true }),
});
export const FRIEND_LIST_LIMIT = 5000;
export const FriendRowSchema = z.strictObject({ mid: z.string().min(1), name: z.string(), avatarAvailable: z.boolean(), hasConversation: z.boolean() });
export const FriendListSchema = z.array(FriendRowSchema).max(FRIEND_LIST_LIMIT);
export const MESSAGE_READER_LIMIT = 500;
export const MessageReaderSchema = z.strictObject({ mid: z.string().min(1), name: z.string(), readAt: z.iso.datetime({ offset: true }) });
export const MessageReadersSchema = z.strictObject({ readers: z.array(MessageReaderSchema).max(MESSAGE_READER_LIMIT) });
export const ControlStateSchema = z.strictObject({ activeAccountId: z.string().nullable(), epoch: z.number().int().nonnegative(), pendingOutbound: z.number().int().nonnegative() });
const SystemActionLabel = z.enum(['系統操作失敗', '系統啟動', '系統關閉', '服務啟動', '服務停止', '工作程序啟動', '工作程序停止', '工作程序重新啟動',
  '工作程序隔離', '工作程序結束', 'LINE 登入開始', 'LINE QR Code 已準備', 'LINE PIN 已準備', 'LINE 登入完成', 'LINE 登入失敗',
  'LINE 登入失效', '登入資訊已更新', '清除登入資訊', '帳號控制變更', '帳號模式變更', 'Agent 狀態變更', 'Codex 登入', 'Claude 登入',
  'Codex 登出', 'Claude 登出', '外部監控設定變更', '系統紀錄儲存失敗', '系統紀錄儲存恢復', '系統作業', '圖片下載', '影片下載',
  '語音下載', '檔案下載', '附件下載', 'LINE 操作失敗', 'LINE 聯絡人／群組清單更新', '新增使用者（好友授權）', '新增使用者：確認 LINE 好友關係',
  '新增使用者：加入 LINE 好友', '新增使用者：重新確認好友', '新增使用者：授權預檢', '新增使用者：寫入白名單', '相簿照片下載']);
const SystemPhaseLabel = z.enum(['已提出', '已完成', '失敗', '已記錄']);
const AttachmentStatusLabel = z.enum(['等待下載', '下載中', '已完成', '已過期', '重試中', '下載失敗']);
const SystemErrorCode = z.enum(['DATABASE_WRITE_FAILED', 'FALLBACK_WRITE_FAILED', 'WORKER_STOP_FAILED', 'WORKER_STOP_TIMEOUT',
  'AGENT_AUTH_FAILED', 'SECRET_CLEAR_FAILED', 'OPERATOR_ACTION_FAILED', 'STARTUP_FAILED', 'SHUTDOWN_FAILED', 'WORKER_EXITED',
  'AUTH_INVALIDATED', 'RECOVERY_FAILED', 'PROVIDER_STATUS_FAILED', 'ATTACHMENT_EXPIRED', 'ATTACHMENT_DOWNLOAD_FAILED',
  'RELATION_LIST_RPC_FAILED', 'RELATION_LIST_SHAPE_INVALID', 'RELATION_LIST_LIMIT', 'RELATION_DETAIL_RPC_FAILED',
  'RELATION_DETAIL_SHAPE_INVALID', 'RELATION_CANCELLED', 'RELATION_BINDING_REVOKED', 'RELATION_RESPONSE_TIMEOUT',
  'RELATION_WORKER_EXIT', 'RELATION_OUTCOME_UNKNOWN', 'ENROLLMENT_BINDING_CHANGED', 'SIDE_EFFECT_DENIED', 'NOT_STARTED',
  'TRANSPORT_OUTCOME_UNKNOWN', 'ENROLLMENT_PRECHECK_FAILED', 'ENROLLMENT_GRANT_FAILED', 'ENROLLMENT_REPLY_FAILED',
  'ENROLLMENT_REPLY_UNKNOWN', 'INVALID_COMMAND', 'QUEUE_FULL', 'CATALOG_REFRESH_FAILED', 'WORKER_OPERATION_FAILED',
  'HISTORY_READ_FAILED', 'CHAT_RESOURCE_READ_FAILED', 'PROFILE_REFRESH_FAILED', 'MESSAGE_SEND_FAILED',
  'MESSAGE_UNSEND_FAILED', 'MESSAGE_REACTION_FAILED', 'FRIEND_RELATION_CHECK_FAILED', 'FRIEND_ADD_FAILED',
  'ATTACHMENT_DOWNLOAD_OPERATION_FAILED', 'CREDENTIAL_RESTORE_FAILED', 'LINE_SYNC_FAILED',
  'UNKNOWN_ERROR']);
const SystemActivityAuditSchema = z.strictObject({ kind: z.literal('audit'), createdAt: z.iso.datetime({ offset: true }),
  action: SystemActionLabel, phase: SystemPhaseLabel });
const SystemActivityAttachmentSchema = z.strictObject({ kind: z.literal('attachment'), createdAt: z.iso.datetime({ offset: true }),
  action: z.enum(['圖片下載', '影片下載', '語音下載', '檔案下載']), status: AttachmentStatusLabel, attachmentKind: z.enum(['image', 'video', 'audio', 'file']),
  retryCount: z.number().int().min(0).max(1000), key: ConversationKeySchema });
export const SystemActivitySchema = z.discriminatedUnion('kind', [SystemActivityAuditSchema, SystemActivityAttachmentSchema]);
export type SystemActivity = z.infer<typeof SystemActivitySchema>;
export const SystemActivityResultSchema = z.strictObject({ activity: z.array(SystemActivitySchema).max(100), partial: z.boolean() });
export const SystemErrorRowSchema = z.strictObject({ createdAt: z.iso.datetime({ offset: true }), action: SystemActionLabel, code: SystemErrorCode,
  diagnostic: SafeDiagnosticSchema.optional(), correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() });
export type SystemErrorRow = z.infer<typeof SystemErrorRowSchema>;
export type SystemErrorCode = SystemErrorRow['code'];
export const SystemErrorsResultSchema = z.strictObject({ errors: z.array(SystemErrorRowSchema).max(100), partial: z.boolean() });
export type SystemActivityResult = z.infer<typeof SystemActivityResultSchema>;
export type SystemErrorsResult = z.infer<typeof SystemErrorsResultSchema>;
export const DesktopReadRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('listMessages'), key: ConversationKeySchema, cursor: z.string().nullable(), limit: z.number().int().min(1).max(100), messageId: z.string().min(1).optional() }),
  z.strictObject({ type: z.literal('listAttachmentStates'), key: ConversationKeySchema, attachmentIds: z.array(z.uuid()).max(225) }),
  z.strictObject({ type: z.literal('listAgentStatuses'), key: ConversationKeySchema, messageIds: z.array(z.string().min(1)).max(225) }),
  z.strictObject({ type: z.literal('listWorkRecords') }),
  z.strictObject({ type: z.literal('listFriends'), accountId: z.string().min(1) }),
  z.strictObject({ type: z.literal('listMessageReaders'), key: ConversationKeySchema, messageId: z.string().min(1) }),
  z.strictObject({ type: z.literal('listSystemActivity') }),
  z.strictObject({ type: z.literal('listSystemErrors') }),
  z.strictObject({ type: z.literal('getControlState') }),
]);
export type DesktopReadRequest = z.infer<typeof DesktopReadRequestSchema>;
export const DesktopReadResultSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('listMessages'), page: MessagePageSchema }),
  z.strictObject({ type: z.literal('listAttachmentStates'), attachments: AttachmentStateListSchema }),
  z.strictObject({ type: z.literal('listAgentStatuses'), statuses: z.array(z.strictObject({ messageId: z.string(), jobId: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']), revision: z.string().regex(/^\d{1,20}$/) })).max(225) }),
  z.strictObject({ type: z.literal('listWorkRecords'), records: z.array(WorkRecordSchema) }),
  z.strictObject({ type: z.literal('listFriends'), friends: FriendListSchema }),
  z.strictObject({ type: z.literal('listMessageReaders'), ...MessageReadersSchema.shape }),
  z.strictObject({ type: z.literal('listSystemActivity'), ...SystemActivityResultSchema.shape }),
  z.strictObject({ type: z.literal('listSystemErrors'), ...SystemErrorsResultSchema.shape }),
  z.strictObject({ type: z.literal('getControlState'), state: ControlStateSchema }),
]);
