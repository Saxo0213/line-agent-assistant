import { z } from 'zod';
import { isLineServerErrorCode } from './line-server-error.js';
import { ATTACHMENT_BLOCK_REASONS } from './attachment-block.js';
import { AgentAttachmentSummarySchema, AgentAttachmentUploadsSchema, AgentEventSchema, AgentProviderSchema } from './agent.js';
import { AgentStatusIconsSchema } from './agent-status-icons.js';
import { AgentPersonaSchema } from './agent-persona.js';
import { AgentExtensionToolsSchema, AgentExtensionsStateSchema, AgentMcpImportListingSchema, AgentMcpImportResultSchema, AgentMcpImportSelectionSchema, AgentMcpServerInputSchema, AgentMcpServerSummarySchema } from './agent-extensions.js';
import { AgentScheduleCreateInputSchema, AgentScheduleListRunsInputSchema, AgentScheduleListTargetsInputSchema, AgentSchedulePreviewNewMessagesInputSchema, AgentSchedulePreviewNewMessagesOutputSchema, AgentScheduleRunSchema, AgentScheduleSchema, AgentScheduleTargetOptionSchema, AgentScheduleUpdatePatchSchema } from './agent-schedule.js';
import { AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN } from './agent-status-rotation.js';
import { AutoResponderRuleSchema, AutoResponderSettingsSchema, validateAutoresponderConfig } from './autoresponder.js';
import { AccountModeSchema, ChatTypeSchema, ConversationKeySchema, LineTransportKindSchema, WritableConversationKeySchema } from './account.js';
import { ChromeLtsmInstallResultSchema, ChromeLtsmStatusSchema, ChromeLtsmUnavailableStatusSchema } from './chrome-login.js';
import { MentionRangeSchema, MessageContentSchema, MessageKindSchema, SticonRangeSchema } from './line.js';
import {
  AgentPermissionsViewSchema,
  ChatFolderChatTypeSchema,
  ChatFolderSummarySchema,
  SetAgentFolderLinkInputSchema,
  SetAgentPermissionInputSchema,
  AgentPermissionDefaultsViewSchema,
  SetAgentPermissionDefaultInputSchema,
  SetAgentExecutionPolicyInputSchema,
  AgentExecutionPolicySchema,
  AgentToolAllowlistEntrySchema,
} from './agent-permissions.js';
import {
  McpServerStatusSchema,
  McpToolInputUnionSchema,
  McpToolNameSchema,
  McpToolOutputUnionSchema,
  McpLocalClientKindSchema,
  McpLocalClientStatusSchema,
} from './mcp.js';

const IdSchema = z.string().min(1);
export const MessageSearchScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('account'), accountId: IdSchema }),
  z.strictObject({ kind: z.literal('all') }),
]);
export type MessageSearchScope = z.infer<typeof MessageSearchScopeSchema>;

const TimestampSchema = z.iso.datetime({ offset: true });
const RequestIdSchema = z.strictObject({ requestId: IdSchema });
const PageSchema = z.strictObject({ before: IdSchema.nullable(), limit: z.number().int().min(1).max(100) });
const ChatResourceCursorSchema = z.string().max(2048).nullable();
export const ChatResourceNoteSchema = z.strictObject({ postId: IdSchema.max(256), createdTime: z.number().nullable(), text: z.string().max(262144).nullable(),
  content: z.record(z.string(), z.unknown()).optional() });
export const ChatResourceAlbumSchema = z.strictObject({ albumId: IdSchema.max(256), chatId: IdSchema.max(256), title: z.string().max(20000).nullable(),
  photoCount: z.number().int().min(0).max(100000).nullable(), createTime: z.number().nullable(), updateTime: z.number().nullable(),
  coverPhotoIds: z.array(IdSchema.max(256)).max(2).optional() });
export const ChatResourcePhotoSchema = z.strictObject({ photoId: IdSchema.max(256), oid: IdSchema.max(256), prefix: z.string().max(512),
  shotTime: z.number().nullable(), width: z.number().int().min(0).nullable(), height: z.number().int().min(0).nullable() });
export const AlbumFailureContextSchema = z.strictObject({
  action: z.enum(['album_list', 'album_photos', 'photo_download']),
  stage: z.enum(['resource_read', 'pagination', 'archive_contains', 'archive_write', 'archive_scan']),
  code: z.enum(['ALBUM_RECONCILIATION_FAILED', 'ALBUM_ARCHIVE_INCOMPLETE', 'ALBUM_PHOTO_CURSOR_LOOP']),
});
export type AlbumFailureContextDto = z.infer<typeof AlbumFailureContextSchema>;
export type ChatResourceNote = z.infer<typeof ChatResourceNoteSchema>;
export type ChatResourceAlbum = z.infer<typeof ChatResourceAlbumSchema>;
export type ChatResourcePhoto = z.infer<typeof ChatResourcePhotoSchema>;
export const AgentJobSearchCursorSchema = z.strictObject({ createdAt: TimestampSchema, jobId: IdSchema });
export const AgentJobSearchQuerySchema = z.strictObject({
  keyword: z.string().max(500).optional(), searchPrompt: z.boolean(), searchReply: z.boolean(),
  provider: AgentProviderSchema.optional(), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
  createdFrom: TimestampSchema.optional(), createdToExclusive: TimestampSchema.optional(),
  limit: z.number().int().min(1).max(100), cursor: AgentJobSearchCursorSchema.optional(),
}).superRefine((query, context) => {
  if (query.keyword?.trim() && !query.searchPrompt && !query.searchReply) {
    context.addIssue({ code: 'custom', message: 'Select prompt or reply search', path: ['searchPrompt'] });
  }
  if (query.createdFrom && query.createdToExclusive && Date.parse(query.createdFrom) >= Date.parse(query.createdToExclusive)) {
    context.addIssue({ code: 'custom', message: 'Invalid creation date range', path: ['createdToExclusive'] });
  }
});
export type AgentJobSearchQuery = z.infer<typeof AgentJobSearchQuerySchema>;

export const LineMediaTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('account'), accountId: IdSchema }),
  z.strictObject({ type: z.literal('conversation') }).merge(ConversationKeySchema),
  z.strictObject({ type: z.literal('member'), memberId: IdSchema }).merge(ConversationKeySchema),
  z.strictObject({ type: z.literal('sticker'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, messageId: IdSchema }),
  z.strictObject({ type: z.literal('sticon'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, messageId: IdSchema,
    index: z.number().int().nonnegative().max(63) }),
  z.strictObject({ type: z.literal('attachment'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, attachmentId: IdSchema }),
  z.strictObject({ type: z.literal('albumPhoto'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, albumId: IdSchema, photoId: IdSchema }),
  /** Paid-reaction icon: served only when the message really carries that reaction; same sticon source and disk cache. */
  z.strictObject({ type: z.literal('reaction'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, messageId: IdSchema,
    productId: z.string().regex(/^[0-9a-f]{24}$/), emojiId: z.string().regex(/^[0-9]{1,6}$/) }),
]);
export type LineMediaTarget = z.infer<typeof LineMediaTargetSchema>;

/** Operator answer to a pending Agent tool approval card. What gets remembered is derived by Main, never by the renderer. */
export const AgentApprovalDecisionSchema = z.enum(['once', 'session', 'always', 'deny']);
export type AgentApprovalDecision = z.infer<typeof AgentApprovalDecisionSchema>;
export const AgentApprovalOutcomeSchema = z.enum(['allowed', 'denied', 'timeout', 'cancelled']);
export type AgentApprovalOutcome = z.infer<typeof AgentApprovalOutcomeSchema>;
/** Error-result codes of decideAgentApproval. */
export const AgentApprovalErrorCodeSchema = z.enum(['APPROVAL_NOT_PENDING', 'APPROVAL_REMEMBER_UNAVAILABLE']);
/** Global pending bound held by the Main approval broker. */
export const MAX_PENDING_AGENT_APPROVALS = 32;
/**
 * A Bash summary is the whole command and is never truncated (the operator approves exactly what runs); commands
 * longer than the remember limit (2000) are still shown but cannot be remembered. An event beyond this bound is
 * dropped by the preload validator, so the request fails closed by timing out to deny.
 */
export const PendingAgentApprovalSchema = z.strictObject({
  approvalId: IdSchema,
  jobId: IdSchema,
  tool: z.string().min(1).max(128),
  summary: z.string().max(100_000),
  deadline: TimestampSchema,
  canRemember: z.boolean(),
});
export type PendingAgentApproval = z.infer<typeof PendingAgentApprovalSchema>;

export const IpcRequestSchema = z.discriminatedUnion('type', [
  RequestIdSchema.extend({ type: z.literal('getSnapshot') }),
  RequestIdSchema.extend({ type: z.literal('reportRendererFailure') }),
  RequestIdSchema.extend({ type: z.literal('searchAgentJobs'), query: AgentJobSearchQuerySchema }),
  /** `lineTransport` selects the login method of the slot that this login reserves. If absent, the slot keeps its method (DESKTOPWIN for a new slot). */
  RequestIdSchema.extend({ type: z.literal('lineAddAccountQr'), lineTransport: LineTransportKindSchema.optional() }),
  RequestIdSchema.extend({ type: z.literal('lineLoginQr'), accountId: IdSchema, lineTransport: LineTransportKindSchema.optional() }),
  RequestIdSchema.extend({ type: z.literal('lineReplaceAgentQr'), accountId: IdSchema, lineTransport: LineTransportKindSchema.optional() }),
  RequestIdSchema.extend({ type: z.literal('lineLogout'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('refreshLineAvatar'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('lineSetAutoLogin'), accountId: IdSchema, enabled: z.boolean() }),
  RequestIdSchema.extend({ type: z.literal('lineBeginAdminPairing'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('lineStart'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('getChromeLoginAvailability') }),
  RequestIdSchema.extend({ type: z.literal('detectChromeLtsm') }),
  /** Main opens the native folder picker. The renderer does not give a path. */
  RequestIdSchema.extend({ type: z.literal('chooseChromeLtsmFolder') }),
  RequestIdSchema.extend({ type: z.literal('openChromeExtensionStore') }),
  RequestIdSchema.extend({ type: z.literal('externalImportStart'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('externalImportStop'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('previewExternalAdminBinding') }),
  RequestIdSchema.extend({ type: z.literal('startExternalMonitorAsAdmin'), mid: z.string().regex(/^u[0-9a-f]{32}$/) }),
  RequestIdSchema.extend({ type: z.literal('officialLineApproveSigner') }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('lineSyncHistory'), cursor: IdSchema.nullable(),
    limit: z.number().int().min(1).max(100).default(50) }),
  // The shared Agent room belongs to the operator, not to a LINE account: none of these calls carries an account.
  // The prompt may be empty only when files are attached (Main then stores the default attachment prompt).
  RequestIdSchema.extend({ type: z.literal('submitAgentRoomPrompt'), provider: AgentProviderSchema, prompt: z.string(),
    attachments: AgentAttachmentUploadsSchema.optional() })
    .refine((request) => request.prompt.trim().length > 0 || (request.attachments?.length ?? 0) > 0, { message: 'Prompt or attachment required', path: ['prompt'] }),
  RequestIdSchema.extend({ type: z.literal('stopAgentRoomJob'), jobId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('retryAgentRoomJob'), jobId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('getAgentRoomJobEvents'), jobId: IdSchema }),
  RequestIdSchema.merge(ConversationKeySchema).merge(PageSchema).extend({ type: z.literal('listMessages') }),
  RequestIdSchema.merge(ConversationKeySchema).merge(PageSchema).extend({ type: z.literal('listAttachments') }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('listChatNotes'), cursor: ChatResourceCursorSchema }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('getChatNote'), postId: IdSchema.max(256) }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('listChatAlbums'), cursor: ChatResourceCursorSchema, refresh: z.boolean().optional() }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('listChatAlbumPhotos'), albumId: IdSchema.max(256), cursor: ChatResourceCursorSchema, refresh: z.boolean().optional() }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('downloadChatAlbumPhoto'), albumId: IdSchema.max(256), photoId: IdSchema.max(256),
    oid: IdSchema.max(256), prefix: z.enum(['album/a', 'album/v']) }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('openChatAlbum'), albumId: IdSchema.max(256) }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('openReadableChatAlbumFolder'), albumId: IdSchema.max(256) }),
  RequestIdSchema.extend({ type: z.literal('cancelChatResourceRequest'), targetRequestId: IdSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('sendText'), text: z.string().min(1) }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('replyText'), replyToMessageId: IdSchema, text: z.string().min(1) }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('sendManualMedia'),
    files: AgentAttachmentUploadsSchema.min(1) }),
  RequestIdSchema.merge(ConversationKeySchema).extend({ type: z.literal('unsendMessage'), messageId: z.string().regex(/^(?:0|[1-9][0-9]*)$/) }),
  RequestIdSchema.extend({ type: z.literal('getManualUnsendWindow') }),
  RequestIdSchema.extend({ type: z.literal('setManualUnsendWindow'), window: z.enum(['1h', '7d']) }),
  RequestIdSchema.extend({ type: z.literal('getAgentPersona') }),
  RequestIdSchema.extend({ type: z.literal('setAgentPersona'), persona: AgentPersonaSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('stopJob'), jobId: IdSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('retryJob'), jobId: IdSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('newSession'), provider: AgentProviderSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('getJobEvents'), jobId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('searchMessages'), query: z.strictObject({ key: ConversationKeySchema.optional(), accountId: IdSchema.optional(), scope: MessageSearchScopeSchema.optional(), senderId: IdSchema.optional(), text: z.string().optional(), from: TimestampSchema.optional(), to: TimestampSchema.optional(), hasAttachment: z.boolean().optional(), attachmentKind: z.enum(['image', 'video', 'audio', 'file']).optional(), limit: z.number().int().positive().max(500) }) }),
  RequestIdSchema.extend({ type: z.literal('openExternalUrl'), url: z.string().min(1).max(8192) }),
  RequestIdSchema.extend({ type: z.literal('openAttachment'), attachmentId: IdSchema }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('downloadAttachment'), attachmentId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('revealAttachment'), attachmentId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('resolveFileTypeIcon'), extension: z.string().regex(/^[a-z0-9]{1,12}$/) }),
  RequestIdSchema.extend({ type: z.literal('subscribeEvents'), topics: z.array(z.enum(['snapshot', 'agentEvent', 'message', 'attachment', 'control', 'health'])).min(1) }),
  RequestIdSchema.merge(WritableConversationKeySchema).extend({ type: z.literal('setConversationAgent'), enabled: z.boolean(), provider: AgentProviderSchema }),
  RequestIdSchema.extend({ type: z.literal('switchControl'), accountId: IdSchema, expectedEpoch: z.number().int().nonnegative() }),
  RequestIdSchema.extend({ type: z.literal('setDefaultAgent'), provider: AgentProviderSchema }),
  RequestIdSchema.extend({ type: z.literal('setWorkspace'), workspacePath: z.string().min(1) }),
  RequestIdSchema.extend({ type: z.literal('getConversationSettings') }),
  RequestIdSchema.extend({ type: z.literal('setConversationSettings'), settings: z.strictObject({
    attachmentAutoAttemptLimit: z.number().int().min(3).max(10), showAgentStatusMarkers: z.boolean(), agentStatusIcons: AgentStatusIconsSchema,
    agentStatusRotationIntervalSeconds: z.number().int().min(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN).max(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX),
  }) }),
  RequestIdSchema.extend({ type: z.literal('getAutoResponderSettings') }),
  z.strictObject({ type: z.literal('setAutoResponderSettings'), requestId: IdSchema,
    expectedVersion: z.number().int().nonnegative(), displayName: z.string().min(1).max(80), fallback: z.string().min(1).max(2000),
    rules: z.array(AutoResponderRuleSchema).max(50) }).superRefine((value, context) => {
      const error = validateAutoresponderConfig(value);
      if (error) context.addIssue({ code: 'custom', message: error });
    }),
  RequestIdSchema.extend({ type: z.literal('agentLogin'), provider: AgentProviderSchema }),
  RequestIdSchema.extend({ type: z.literal('agentLogout'), provider: AgentProviderSchema }),
  RequestIdSchema.extend({ type: z.literal('agentRefreshStatus'), provider: AgentProviderSchema }),
  RequestIdSchema.extend({ type: z.literal('mcpGetStatus') }),
  RequestIdSchema.extend({ type: z.literal('mcpLocalClientStatus') }),
  RequestIdSchema.extend({ type: z.literal('mcpLocalClientConnect'), client: McpLocalClientKindSchema }),
  RequestIdSchema.extend({ type: z.literal('mcpLocalClientDisconnect'), client: McpLocalClientKindSchema }),
  RequestIdSchema.extend({ type: z.literal('mcpCallInternalTool'), tool: McpToolInputUnionSchema }),
  RequestIdSchema.extend({ type: z.literal('getAgentPermissions'), accountId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('getAgentPermissionDefaults') }),
  RequestIdSchema.merge(SetAgentPermissionDefaultInputSchema).extend({ type: z.literal('setAgentPermissionDefault') }),
  RequestIdSchema.extend({ type: z.literal('revokeAgentWhitelistUser'), accountId: IdSchema, targetMid: IdSchema.max(512) }),
  RequestIdSchema.merge(SetAgentPermissionInputSchema).extend({ type: z.literal('setAgentPermission') }),
  RequestIdSchema.extend({ type: z.literal('getAgentExecutionPolicy') }),
  RequestIdSchema.merge(SetAgentExecutionPolicyInputSchema).extend({ type: z.literal('setAgentExecutionPolicy') }),
  RequestIdSchema.extend({ type: z.literal('listAgentToolAllowlist') }),
  RequestIdSchema.extend({ type: z.literal('removeAgentToolAllowlistEntry'), id: z.uuid() }),
  RequestIdSchema.extend({ type: z.literal('clearAgentToolAllowlist') }),
  RequestIdSchema.extend({ type: z.literal('decideAgentApproval'), approvalId: IdSchema, decision: AgentApprovalDecisionSchema }),
  RequestIdSchema.extend({ type: z.literal('listPendingAgentApprovals') }),
  RequestIdSchema.merge(SetAgentFolderLinkInputSchema).extend({ type: z.literal('setAgentFolderLink') }),
  RequestIdSchema.extend({ type: z.literal('createChatFolder'), accountId: IdSchema, chatType: ChatFolderChatTypeSchema, chatId: IdSchema }),
  RequestIdSchema.extend({ type: z.literal('openChatFolder'), folderId: z.uuid() }),
  RequestIdSchema.extend({ type: z.literal('listAgentSchedules') }),
  RequestIdSchema.extend({ type: z.literal('createAgentSchedule'), schedule: AgentScheduleCreateInputSchema }),
  RequestIdSchema.extend({ type: z.literal('updateAgentSchedule'), scheduleId: z.uuid(), patch: AgentScheduleUpdatePatchSchema }),
  RequestIdSchema.extend({ type: z.literal('deleteAgentSchedule'), scheduleId: z.uuid() }),
  RequestIdSchema.merge(AgentScheduleListRunsInputSchema).extend({ type: z.literal('listAgentScheduleRuns') }),
  RequestIdSchema.merge(AgentScheduleListTargetsInputSchema).extend({ type: z.literal('listAgentScheduleTargets') }),
  RequestIdSchema.extend({ type: z.literal('previewAgentScheduleNewMessages'), preview: AgentSchedulePreviewNewMessagesInputSchema }),
  RequestIdSchema.extend({ type: z.literal('getAgentExtensions') }),
  RequestIdSchema.extend({ type: z.literal('saveAgentMcpServer'), server: AgentMcpServerInputSchema }),
  RequestIdSchema.extend({ type: z.literal('deleteAgentMcpServer'), serverId: z.uuid() }),
  RequestIdSchema.extend({ type: z.literal('setAgentMcpServerEnabled'), serverId: z.uuid(), enabled: z.boolean() }),
  RequestIdSchema.extend({ type: z.literal('setAgentExtensionTools'), tools: AgentExtensionToolsSchema }),
  RequestIdSchema.extend({ type: z.literal('listAgentMcpImportCandidates') }),
  RequestIdSchema.extend({ type: z.literal('importAgentMcpServers'), items: z.array(AgentMcpImportSelectionSchema).min(1).max(64) }),
]).superRefine((request, context) => {
  if (request.type === 'switchControl') context.addIssue({ code: 'custom', message: 'Account control is managed internally.' });
});
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export const ComponentHealthSchema = z.strictObject({
  name: z.enum(['database', 'lineWorker', 'codex', 'claude']),
  status: z.enum(['ready', 'degraded', 'stopped']),
  message: z.string().nullable(),
  lastSuccessAt: TimestampSchema.nullable(),
  restartCount: z.number().int().nonnegative(),
});
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

export const LineAccountSummarySchema = z.strictObject({
  accountId: IdSchema,
  displayName: z.string(),
  status: z.enum(['connected', 'disconnected', 'degraded', 'reauth_required']),
  lastSyncedAt: TimestampSchema.nullable(),
  mode: AccountModeSchema,
  productRole: z.enum(['AGENT', 'PRIMARY_ADMIN']).nullable().optional(),
  /** Agent lineage membership: the current Agent account or a former Agent account; absent for every other account. */
  agentLineage: z.enum(['current', 'former']).optional(),
  hasPrimaryAdmin: z.boolean().optional(),
  autoLoginOnStartup: z.boolean().optional(),
  /** Login method of this account. If absent (older payloads), it means DESKTOPWIN. */
  lineTransport: LineTransportKindSchema.optional(),
  hasVerifiedLineIdentity: z.boolean().optional(),
  avatarAvailable: z.boolean().optional(),
  canSendManually: z.boolean().optional(),
  canStartExternalImport: z.boolean().optional(),
  /** Primary Admin only: the official LINE build seen by the last reader session. Never carries paths, hashes or keys. */
  officialLineBuild: z.strictObject({
    version: z.string().regex(/^\d{1,5}(\.\d{1,5}){3}$/).nullable(),
    status: z.enum(['accepted', 'candidate', 'key_scan_failed', 'schema_changed', 'rotation', 'untrusted']),
  }).nullable().optional(),
  externalImportProgress: z.strictObject({
    stage: z.enum(['checking_source', 'closing_line_window', 'copying_snapshot', 'counting_rows', 'importing_history', 'syncing', 'monitoring', 'complete', 'failed']),
    copiedBytes: z.string().regex(/^\d+$/).nullable(),
    totalBytes: z.string().regex(/^\d+$/).nullable(),
    committedRows: z.string().regex(/^\d+$/),
    eligibleRows: z.string().regex(/^\d+$/).nullable(),
    message: z.string().max(500).nullable(),
  }).nullable().optional(),
});
export type LineAccountSummary = z.infer<typeof LineAccountSummarySchema>;

/** Display-only metadata. Original preview text and persisted messages remain unchanged. */
export const GeneratedPreviewSchema = z.strictObject({
  kind: z.enum(['deleted', 'unsent', 'image', 'video', 'audio', 'file', 'sticker', 'contact', 'location', 'rich', 'unsupported', 'call', 'gift', 'post', 'post_note', 'post_album', 'chat_event', 'system', 'message']),
  name: z.string().optional(),
  status: z.enum(['queued', 'downloading', 'ready', 'failed', 'expired']).optional(),
  /** Why a queued attachment cannot download now. The renderer shows it in place of the plain queued text. */
  blockReason: z.enum(ATTACHMENT_BLOCK_REASONS).optional(),
  /** Call event facts. The renderer builds the localized call text from them, as the chat timeline does. */
  call: z.strictObject({ media: z.enum(['audio', 'video']).nullable(), result: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(), direction: z.enum(['inbound', 'outbound']) }).optional(),
});
export type GeneratedPreview = z.infer<typeof GeneratedPreviewSchema>;
export const ConversationSummarySchema = z.strictObject({
  accountId: IdSchema,
  chatId: IdSchema,
  chatType: ChatTypeSchema,
  title: z.string(),
  agentEnabled: z.boolean(),
  defaultProvider: AgentProviderSchema,
  unreadCount: z.number().int().nonnegative(),
  localOnly: z.boolean().optional(),
  latestMessagePreview: z.string().nullable().optional(),
  latestMessageDisplay: GeneratedPreviewSchema.optional(),
  latestMessageAt: TimestampSchema.nullable().optional(),
  /** Message id of the latest row; the target of `latestSticonRanges` sticon media. */
  latestMessageId: IdSchema.nullable().optional(),
  /** Sticon ranges over `latestMessagePreview` (one U+FFFC placeholder each); range i is sticon i of that message. */
  latestSticonRanges: z.array(SticonRangeSchema).max(16).optional(),
  latestAttachmentStatus: z.enum(['queued', 'downloading', 'ready', 'failed', 'expired']).nullable().optional(),
  avatarAvailable: z.boolean().optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const AgentJobSummarySchema = z.strictObject({
  jobId: IdSchema,
  /** null for the shared Agent room's jobs (they belong to no LINE account); LINE jobs always carry all three. */
  accountId: IdSchema.nullable(),
  chatType: ChatTypeSchema.nullable(),
  chatId: IdSchema.nullable(),
  provider: AgentProviderSchema,
  prompt: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  createdAt: TimestampSchema,
  /** At most 240 Unicode code points from a stored completed reply, projected by Main for the Tasks list. */
  replyPreview: z.string().max(480).refine((value) => Array.from(value).length <= 240).optional(),
  /**
   * Stamped by Main for jobs the Agent room shows (its own, or the admin's direct LINE chat while that chat is shared), and
   * 'schedule' for scheduled runs, which the Jobs page lists but the Agent room never shows.
   */
  origin: z.enum(['agent_room', 'line_admin_direct', 'schedule']).optional(),
  /** Files attached in the Agent room, for display only (no paths). Absent when there are none. */
  attachments: z.array(AgentAttachmentSummarySchema).max(10).optional(),
});
export type AgentJobSummary = z.infer<typeof AgentJobSummarySchema>;

export const ProviderStatusSchema = z.strictObject({
  provider: AgentProviderSchema,
  status: z.enum(['unknown', 'logged_in', 'logged_out', 'not_installed', 'error']),
  detail: z.string().nullable(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ControlSnapshotSchema = z.strictObject({
  epoch: z.number().int().nonnegative(),
  activeAccountId: IdSchema.nullable(),
  phase: z.enum(['idle', 'revoking', 'granting', 'failed']),
  targetAccountId: IdSchema.nullable(),
});
export type ControlSnapshot = z.infer<typeof ControlSnapshotSchema>;

export const AppSnapshotSchema = z.strictObject({
  control: ControlSnapshotSchema,
  defaultProvider: AgentProviderSchema,
  components: z.array(ComponentHealthSchema),
  queueDepth: z.number().int().nonnegative(),
  accounts: z.array(LineAccountSummarySchema),
  conversations: z.array(ConversationSummarySchema),
  jobs: z.array(AgentJobSummarySchema),
  providers: z.array(ProviderStatusSchema),
});
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const IpcEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshotChanged'), snapshot: AppSnapshotSchema }),
  z.strictObject({ type: z.literal('agentEvent'), jobId: IdSchema, event: AgentEventSchema }),
  z.strictObject({ type: z.literal('agentJobStatusChanged'), accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema, sourceMessageId: IdSchema, jobId: IdSchema, status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']), revision: z.string().regex(/^\d{1,20}$/) }),
  z.strictObject({ type: z.literal('messageStored'), key: ConversationKeySchema, messageId: IdSchema,
    conversation: ConversationSummarySchema }),
  z.strictObject({ type: z.literal('externalMonitorRoundComplete'), accountId: IdSchema }),
  z.strictObject({ type: z.literal('lineAvatarRefreshed'), accountId: IdSchema, ownMid: IdSchema }),
  /** Reading phase of the official-LINE identity read behind the external-monitor dialog. */
  z.strictObject({ type: z.literal('externalAdminBindingProgress'), phase: z.enum(['locating', 'reading_identity']) }),
  z.strictObject({ type: z.literal('attachmentChanged'), attachmentId: IdSchema }),
  z.strictObject({ type: z.literal('controlChanged'), control: ControlSnapshotSchema }),
  z.strictObject({ type: z.literal('healthChanged'), component: ComponentHealthSchema }),
  z.strictObject({ type: z.literal('lineQr'), accountId: IdSchema, loginAttemptId: IdSchema,
    imageDataUrl: z.string().max(256_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/) }),
  z.strictObject({ type: z.literal('linePin'), accountId: IdSchema, loginAttemptId: IdSchema, pin: IdSchema }),
  z.strictObject({ type: z.literal('lineLoginState'), accountId: IdSchema, loginAttemptId: IdSchema.nullable(),
    state: z.enum(['connecting', 'connected', 'disconnected', 'degraded', 'reauth_required']), message: z.string().nullable() }),
  z.strictObject({ type: z.literal('agentIdentityMismatch'), accountId: IdSchema, loginAttemptId: IdSchema,
    oldDisplayName: z.string().max(256), scannedDisplayName: z.string().max(256).nullable() }),
  ConversationKeySchema.extend({ type: z.literal('lineHistorySynced'), requestId: IdSchema,
    nextCursor: IdSchema.nullable() }),
  z.strictObject({ type: z.literal('agentApprovalRequested'), approval: PendingAgentApprovalSchema }),
  z.strictObject({ type: z.literal('agentApprovalResolved'), approvalId: IdSchema, jobId: IdSchema, outcome: AgentApprovalOutcomeSchema }),
  /** The execution policy changed (operator UI or LINE /權限); subscribers re-read it. Carries no policy data. */
  z.strictObject({ type: z.literal('agentExecutionPolicyChanged') }),
  /** A schedule or a schedule run changed (UI, Agent tool or the trigger tick); subscribers re-read. Carries no schedule data. */
  z.strictObject({ type: z.literal('agentSchedulesChanged') }),
]);
export type IpcEvent = z.infer<typeof IpcEventSchema>;

export const MessageSearchResultSchema = z.strictObject({
  accountId: IdSchema,
  chatType: ChatTypeSchema,
  chatId: IdSchema,
  messageId: IdSchema,
  senderId: z.string(),
  senderName: z.string().nullable().optional(),
  /** Read-only ownership projection; absent only in older payloads. */
  isOwn: z.boolean().optional(),
  conversationTitle: z.string().nullable().optional(),
  text: z.string().nullable(),
  occurredAt: TimestampSchema,
  /** 'agent' when the source account belongs to the Agent lineage (current or former Agent account). */
  lineage: z.literal('agent').nullable().optional(),
});
export type MessageSearchResult = z.infer<typeof MessageSearchResultSchema>;

export const StickerDescriptorSchema = z.strictObject({
  stickerId: z.string().regex(/^\d{1,20}$/),
  animated: z.boolean(),
  altText: z.string().max(200).nullable(),
});
export type StickerDescriptor = z.infer<typeof StickerDescriptorSchema>;

export const MessageListResultSchema = MessageSearchResultSchema.extend({
  kind: MessageKindSchema,
  content: MessageContentSchema.nullable().optional(),
  postNotificationType: z.enum(['note', 'album']).nullable().optional(),
  sticker: StickerDescriptorSchema.nullable(),
  mentionRanges: z.array(MentionRangeSchema).optional(),
  agentJobStatus: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).nullable().optional(),
});
export type MessageListResult = z.infer<typeof MessageListResultSchema>;

export const AttachmentSummarySchema = z.strictObject({
  attachmentId: IdSchema, accountId: IdSchema, chatType: ChatTypeSchema, chatId: IdSchema,
  messageId: IdSchema, kind: z.enum(['image', 'video', 'audio', 'file']), name: z.string().nullable(),
  mimeType: z.string().nullable(), status: z.enum(['queued', 'downloading', 'ready', 'failed', 'expired']),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const IpcResultSchema = z.union([
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('getSnapshot'), requestId: IdSchema, ok: z.literal(true), snapshot: AppSnapshotSchema }),
    z.strictObject({ type: z.literal('searchAgentJobs'), requestId: IdSchema, ok: z.literal(true), jobs: z.array(AgentJobSummarySchema).max(100), nextCursor: AgentJobSearchCursorSchema.nullable() }),
    z.strictObject({ type: z.literal('getAutoResponderSettings'), requestId: IdSchema, ok: z.literal(true), settings: AutoResponderSettingsSchema }),
    z.strictObject({ type: z.literal('getConversationSettings'), requestId: IdSchema, ok: z.literal(true), settings: z.strictObject({
      attachmentAutoAttemptLimit: z.number().int().min(3).max(10), showAgentStatusMarkers: z.boolean(), agentStatusIcons: AgentStatusIconsSchema,
      agentStatusRotationIntervalSeconds: z.number().int().min(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN).max(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX),
    }) }),
    z.strictObject({ type: z.literal('setConversationSettings'), requestId: IdSchema, ok: z.literal(true), settings: z.strictObject({
      attachmentAutoAttemptLimit: z.number().int().min(3).max(10), showAgentStatusMarkers: z.boolean(), agentStatusIcons: AgentStatusIconsSchema,
      agentStatusRotationIntervalSeconds: z.number().int().min(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN).max(AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX),
    }) }),
    z.strictObject({ type: z.literal('getManualUnsendWindow'), requestId: IdSchema, ok: z.literal(true), window: z.enum(['1h', '7d']) }),
    z.strictObject({ type: z.literal('setManualUnsendWindow'), requestId: IdSchema, ok: z.literal(true), window: z.enum(['1h', '7d']) }),
    z.strictObject({ type: z.literal('getAgentPersona'), requestId: IdSchema, ok: z.literal(true), persona: AgentPersonaSchema }),
    z.strictObject({ type: z.literal('setAgentPersona'), requestId: IdSchema, ok: z.literal(true), persona: AgentPersonaSchema }),
    z.strictObject({ type: z.literal('setAutoResponderSettings'), requestId: IdSchema, ok: z.literal(true), version: z.number().int().positive() }),
    z.strictObject({ type: z.literal('accepted'), requestId: IdSchema, ok: z.literal(true), ownMid: z.string().regex(/^u[0-9a-fA-F]{32}$/).optional() }),
    z.strictObject({ type: z.literal('lineAdminPairing'), requestId: IdSchema, ok: z.literal(true), token: z.string().regex(/^\d{6}$/), expiresAt: TimestampSchema }),
    z.strictObject({ type: z.literal('submitAgentRoomPrompt'), requestId: IdSchema, ok: z.literal(true), jobId: IdSchema }),
    z.strictObject({ type: z.literal('getAgentRoomJobEvents'), requestId: IdSchema, ok: z.literal(true), events: z.array(AgentEventSchema) }),
    z.strictObject({ type: z.literal('previewExternalAdminBinding'), requestId: IdSchema, ok: z.literal(true),
      identity: z.strictObject({ mid: z.string().regex(/^u[0-9a-f]{32}$/), displayName: z.string().min(1).max(256).nullable(), picturePath: z.string().max(2048).nullable().optional() }),
      otherCandidates: z.number().int().min(0).max(7) }),
    z.strictObject({ type: z.literal('startExternalMonitorAsAdmin'), requestId: IdSchema, ok: z.literal(true),
      bound: z.literal(true), started: z.boolean(), message: z.string().nullable() }),
    z.strictObject({ type: z.literal('searchMessages'), requestId: IdSchema, ok: z.literal(true), messages: z.array(MessageSearchResultSchema) }),
    z.strictObject({ type: z.literal('listMessages'), requestId: IdSchema, ok: z.literal(true), messages: z.array(MessageListResultSchema), nextCursor: IdSchema.nullable() }),
    z.strictObject({ type: z.literal('listAttachments'), requestId: IdSchema, ok: z.literal(true), attachments: z.array(AttachmentSummarySchema), nextCursor: IdSchema.nullable() }),
    z.strictObject({ type: z.literal('listChatNotes'), requestId: IdSchema, ok: z.literal(true), notes: z.array(ChatResourceNoteSchema).max(50), nextCursor: ChatResourceCursorSchema }),
    z.strictObject({ type: z.literal('getChatNote'), requestId: IdSchema, ok: z.literal(true), note: ChatResourceNoteSchema }),
    z.strictObject({ type: z.literal('listChatAlbums'), requestId: IdSchema, ok: z.literal(true), albums: z.array(ChatResourceAlbumSchema).max(50), nextCursor: ChatResourceCursorSchema }),
    z.strictObject({ type: z.literal('listChatAlbumPhotos'), requestId: IdSchema, ok: z.literal(true), photos: z.array(ChatResourcePhotoSchema).max(50), nextCursor: ChatResourceCursorSchema }),
    z.strictObject({ type: z.literal('downloadChatAlbumPhoto'), requestId: IdSchema, albumId: IdSchema.max(256), photoId: IdSchema.max(256), ok: z.literal(true), sizeBytes: z.number().int().min(1).max(20971520) }),
    z.strictObject({ type: z.literal('openChatAlbum'), requestId: IdSchema, ok: z.literal(true), albumId: IdSchema.max(256),
      savedCount: z.number().int().min(0).max(500), failedCount: z.number().int().min(0).max(500), totalCount: z.number().int().min(0).max(500),
      byteCount: z.number().int().min(0).max(268435456), complete: z.boolean(), failureCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/)).max(500),
      errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/).nullable(), failureContext: AlbumFailureContextSchema.optional() }),
      z.strictObject({ type: z.literal('openReadableChatAlbumFolder'), requestId: IdSchema, ok: z.literal(true), albumId: IdSchema.max(256),
        exportedCount: z.number().int().min(0).max(500), failedCount: z.number().int().min(0).max(500), totalCount: z.number().int().min(0).max(500),
        complete: z.boolean(), failureCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/)).max(500), folderName: IdSchema.max(96), opened: z.boolean() }),
    z.strictObject({ type: z.literal('cancelChatResourceRequest'), requestId: IdSchema, ok: z.literal(true), cancelled: z.boolean() }),
    z.strictObject({ type: z.literal('getJobEvents'), requestId: IdSchema, ok: z.literal(true), events: z.array(AgentEventSchema) }),
    z.strictObject({ type: z.literal('openAttachment'), requestId: IdSchema, ok: z.literal(true), opened: z.boolean() }),
    z.strictObject({ type: z.literal('openExternalUrl'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('getChromeLoginAvailability'), requestId: IdSchema, ok: z.literal(true), status: ChromeLtsmStatusSchema }),
    z.strictObject({ type: z.literal('detectChromeLtsm'), requestId: IdSchema, ok: z.literal(true), result: ChromeLtsmInstallResultSchema }),
    z.strictObject({ type: z.literal('chooseChromeLtsmFolder'), requestId: IdSchema, ok: z.literal(true),
      result: z.union([ChromeLtsmInstallResultSchema, z.strictObject({ kind: z.literal('cancelled') })]) }),
    z.strictObject({ type: z.literal('openChromeExtensionStore'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('revealAttachment'), requestId: IdSchema, ok: z.literal(true), revealed: z.boolean() }),
    z.strictObject({ type: z.literal('resolveFileTypeIcon'), requestId: IdSchema, ok: z.literal(true), dataUrl: z.string().nullable() }),
    z.strictObject({ type: z.literal('mcpGetStatus'), requestId: IdSchema, ok: z.literal(true), status: McpServerStatusSchema }),
    z.strictObject({ type: z.literal('mcpLocalClientStatus'), requestId: IdSchema, ok: z.literal(true), clients: z.array(McpLocalClientStatusSchema) }),
    z.strictObject({ type: z.literal('mcpLocalClientConnect'), requestId: IdSchema, ok: z.literal(true), status: McpLocalClientStatusSchema }),
    z.strictObject({ type: z.literal('mcpLocalClientDisconnect'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('mcpCallInternalTool'), requestId: IdSchema, ok: z.literal(true), result: McpToolOutputUnionSchema }),
    z.strictObject({ type: z.literal('getAgentPermissions'), requestId: IdSchema, ok: z.literal(true), view: AgentPermissionsViewSchema }),
    z.strictObject({ type: z.literal('getAgentPermissionDefaults'), requestId: IdSchema, ok: z.literal(true), defaults: AgentPermissionDefaultsViewSchema }),
    z.strictObject({ type: z.literal('setAgentPermissionDefault'), requestId: IdSchema, ok: z.literal(true), version: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('revokeAgentWhitelistUser'), requestId: IdSchema, ok: z.literal(true), revoked: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('setAgentPermission'), requestId: IdSchema, ok: z.literal(true), version: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('getAgentExecutionPolicy'), requestId: IdSchema, ok: z.literal(true), policy: AgentExecutionPolicySchema }),
    z.strictObject({ type: z.literal('setAgentExecutionPolicy'), requestId: IdSchema, ok: z.literal(true), version: z.number().int().positive() }),
    z.strictObject({ type: z.literal('listAgentToolAllowlist'), requestId: IdSchema, ok: z.literal(true), entries: z.array(AgentToolAllowlistEntrySchema) }),
    z.strictObject({ type: z.literal('removeAgentToolAllowlistEntry'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('clearAgentToolAllowlist'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('decideAgentApproval'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('listPendingAgentApprovals'), requestId: IdSchema, ok: z.literal(true),
      approvals: z.array(PendingAgentApprovalSchema).max(MAX_PENDING_AGENT_APPROVALS) }),
    z.strictObject({ type: z.literal('setAgentFolderLink'), requestId: IdSchema, ok: z.literal(true), version: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('createChatFolder'), requestId: IdSchema, ok: z.literal(true), folder: ChatFolderSummarySchema }),
    z.strictObject({ type: z.literal('openChatFolder'), requestId: IdSchema, ok: z.literal(true), opened: z.boolean() }),
    z.strictObject({ type: z.literal('listAgentSchedules'), requestId: IdSchema, ok: z.literal(true), schedules: z.array(AgentScheduleSchema).max(200) }),
    z.strictObject({ type: z.literal('createAgentSchedule'), requestId: IdSchema, ok: z.literal(true), schedule: AgentScheduleSchema }),
    z.strictObject({ type: z.literal('updateAgentSchedule'), requestId: IdSchema, ok: z.literal(true), schedule: AgentScheduleSchema }),
    z.strictObject({ type: z.literal('deleteAgentSchedule'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('listAgentScheduleRuns'), requestId: IdSchema, ok: z.literal(true), runs: z.array(AgentScheduleRunSchema).max(50) }),
    z.strictObject({ type: z.literal('listAgentScheduleTargets'), requestId: IdSchema, ok: z.literal(true), targets: z.array(AgentScheduleTargetOptionSchema).max(50) }),
    z.strictObject({ type: z.literal('previewAgentScheduleNewMessages'), requestId: IdSchema, ok: z.literal(true), preview: AgentSchedulePreviewNewMessagesOutputSchema }),
    z.strictObject({ type: z.literal('getAgentExtensions'), requestId: IdSchema, ok: z.literal(true), extensions: AgentExtensionsStateSchema }),
    z.strictObject({ type: z.literal('saveAgentMcpServer'), requestId: IdSchema, ok: z.literal(true), server: AgentMcpServerSummarySchema }),
    z.strictObject({ type: z.literal('deleteAgentMcpServer'), requestId: IdSchema, ok: z.literal(true) }),
    z.strictObject({ type: z.literal('setAgentMcpServerEnabled'), requestId: IdSchema, ok: z.literal(true), server: AgentMcpServerSummarySchema }),
    z.strictObject({ type: z.literal('setAgentExtensionTools'), requestId: IdSchema, ok: z.literal(true), tools: AgentExtensionToolsSchema }),
    z.strictObject({ type: z.literal('listAgentMcpImportCandidates'), requestId: IdSchema, ok: z.literal(true), listing: AgentMcpImportListingSchema }),
    z.strictObject({ type: z.literal('importAgentMcpServers'), requestId: IdSchema, ok: z.literal(true), result: AgentMcpImportResultSchema }),
  ]),
  z.strictObject({ type: z.literal('error'), requestId: IdSchema, ok: z.literal(false), code: z.string().min(1),
    message: z.string().min(1), retryable: z.boolean(),
    serverErrorCode: z.string().max(80).refine(isLineServerErrorCode).optional(),
    /** Present with code CHROME_LTSM_UNAVAILABLE. It gives the reason why CHROMEOS login cannot start. */
    chromeLtsmStatus: ChromeLtsmUnavailableStatusSchema.optional() }),
]);
export type IpcResult = z.infer<typeof IpcResultSchema>;
