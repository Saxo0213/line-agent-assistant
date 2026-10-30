import { z } from 'zod';
import { ChatTypeSchema } from './account.js';
import { SCHEDULE_TOOL_NAMES } from './agent-schedule.js';
import { SendDetailSchema } from './diagnostics.js';

export const McpToolNameSchema = z.enum([
  'list_targets',
  'query_target_messages',
  'query_target_messages_by_time',
  'list_chat_notes',
  'get_chat_note',
  'list_chat_albums',
  'get_chat_album',
]);
export const MCP_TOOL_NAMES = McpToolNameSchema.options;
export type McpToolName = z.infer<typeof McpToolNameSchema>;
export const MCP_TOOL_EFFECTS: Readonly<Record<McpToolName, 'read' | 'effect'>> = {
  list_targets: 'read',
  query_target_messages: 'read',
  query_target_messages_by_time: 'read',
  list_chat_notes: 'read',
  get_chat_note: 'read',
  list_chat_albums: 'read',
  get_chat_album: 'read',
};

export const McpServerStatusSchema = z.strictObject({
  running: z.boolean(),
  endpoint: z.string().nullable(),
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(0).max(65535).nullable(),
  inFlightRequests: z.number().int().nonnegative(),
  maxConcurrentRequests: z.number().int().positive(),
});
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpLocalClientKindSchema = z.enum(['claude-desktop', 'codex']);
export const McpLocalClientStatusSchema = z.strictObject({
  client: McpLocalClientKindSchema,
  installed: z.boolean(),
  connected: z.boolean(),
});
export type McpLocalClientKind = z.infer<typeof McpLocalClientKindSchema>;
export type McpLocalClientStatus = z.infer<typeof McpLocalClientStatusSchema>;

export const McpTargetMemberSchema = z.strictObject({
  memberId: z.string().min(1),
  displayName: z.string().nullable(),
});
export type McpTargetMember = z.infer<typeof McpTargetMemberSchema>;

export const McpTargetSummarySchema = z.strictObject({
  accountId: z.string().min(1),
  accountDisplayName: z.string().nullable(),
  chatType: ChatTypeSchema,
  chatId: z.string().min(1),
  conversationTitle: z.string().nullable(),
  members: z.array(McpTargetMemberSchema),
  /** Present only on the administrator's (Primary Admin) direct chat with the Agent account. */
  role: z.literal('primary_admin').optional(),
});
export type McpTargetSummary = z.infer<typeof McpTargetSummarySchema>;

export const McpListedTargetSummarySchema = McpTargetSummarySchema.extend({
  no: z.number().int().positive(),
});
export type McpListedTargetSummary = z.infer<typeof McpListedTargetSummarySchema>;

export const McpMessageAttachmentSchema = z.strictObject({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio', 'file']),
  name: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  status: z.enum(['queued', 'downloading', 'ready', 'failed', 'expired']),
});
export type McpMessageAttachment = z.infer<typeof McpMessageAttachmentSchema>;

export const McpMessageRecordSchema = z.strictObject({
  accountId: z.string().min(1),
  accountDisplayName: z.string().nullable(),
  chatType: ChatTypeSchema,
  chatId: z.string().min(1),
  conversationTitle: z.string().nullable(),
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().nullable(),
  direction: z.enum(['inbound', 'outbound']),
  kind: z.enum(['text', 'image', 'video', 'audio', 'file', 'sticker', 'contact', 'event', 'location', 'rich']),
  text: z.string().nullable(),
  recalled: z.boolean(),
  occurredAt: z.iso.datetime({ offset: true }),
  attachments: z.array(McpMessageAttachmentSchema),
});
export type McpMessageRecord = z.infer<typeof McpMessageRecordSchema>;

export function normalizeMcpTimeBound(value: string, bound: 'from' | 'to'): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const candidate = bound === 'from' ? `${trimmed}T00:00:00.000Z` : `${trimmed}T23:59:59.999Z`;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) return null;
    const normalized = new Date(parsed).toISOString();
    return normalized.startsWith(trimmed) ? normalized : null;
  }
  if (!z.iso.datetime({ offset: true }).safeParse(trimmed).success) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function hasTargetSelector(value: {
  target?: string | undefined;
  chatId?: string | undefined;
  conversationTitle?: string | undefined;
  senderId?: string | undefined;
  senderName?: string | undefined;
}): boolean {
  return Boolean(
    value.target?.trim() ||
      value.chatId?.trim() ||
      value.conversationTitle?.trim() ||
      value.senderId?.trim() ||
      value.senderName?.trim(),
  );
}

export const McpListTargetsInputSchema = z.strictObject({
  accountId: z.string().trim().min(1).optional(),
  chatType: ChatTypeSchema.optional(),
  query: z.string().trim().max(256).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type McpListTargetsInput = z.infer<typeof McpListTargetsInputSchema>;

export const MCP_MESSAGE_PAGE_MAX = 200;
const MCP_MESSAGE_CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MCP_MESSAGE_CURSOR_HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface McpMessageCursor {
  /** Microsecond UTC `occurred_at` of the last returned message: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  occurredAt: string;
  messageId: string;
  /** Short hash of the query shape (tool, selectors, text, time range) the cursor was issued for. */
  queryHash: string;
}

export function encodeMcpMessageCursor(cursor: McpMessageCursor): string {
  return btoa(JSON.stringify({ t: cursor.occurredAt, i: cursor.messageId, h: cursor.queryHash })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict decode: any malformed, non-canonical or out-of-format cursor returns null. */
export function decodeMcpMessageCursor(value: string): McpMessageCursor | null {
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    parsed = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'h' || keys[1] !== 'i' || keys[2] !== 't') return null;
  const { t, i, h } = record;
  if (typeof t !== 'string' || typeof i !== 'string' || typeof h !== 'string') return null;
  if (!MCP_MESSAGE_CURSOR_TIME_PATTERN.test(t) || !MCP_MESSAGE_CURSOR_HASH_PATTERN.test(h) || i.length < 1 || i.length > 256) return null;
  const millis = Date.parse(`${t.slice(0, 23)}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== `${t.slice(0, 23)}Z`) return null;
  const cursor = { occurredAt: t, messageId: i, queryHash: h };
  return encodeMcpMessageCursor(cursor) === value ? cursor : null;
}

const McpMessageCursorSchema = z.string().min(1).max(512).refine((value) => decodeMcpMessageCursor(value) !== null, { message: 'Invalid cursor.' });

export const McpMessagePageSchema = z.strictObject({
  returned: z.number().int().min(0).max(MCP_MESSAGE_PAGE_MAX),
  limit: z.number().int().min(1).max(MCP_MESSAGE_PAGE_MAX),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(512).nullable(),
});

const TargetSelectorBaseSchema = z.strictObject({
  accountId: z.string().trim().min(1).optional(),
  target: z.string().trim().min(1).max(256).optional(),
  chatType: ChatTypeSchema.optional(),
  chatId: z.string().trim().min(1).max(256).optional(),
  conversationTitle: z.string().trim().min(1).max(256).optional(),
  senderId: z.string().trim().min(1).max(256).optional(),
  senderName: z.string().trim().min(1).max(256).optional(),
  text: z.string().trim().max(512).optional(),
  /** Values above the page size are clamped to MCP_MESSAGE_PAGE_MAX instead of rejected; use cursor to read further. */
  limit: z.number().int().min(1).transform((value) => Math.min(value, MCP_MESSAGE_PAGE_MAX)).optional(),
  cursor: McpMessageCursorSchema.optional(),
});

export const McpQueryTargetMessagesInputSchema = TargetSelectorBaseSchema.superRefine((value, ctx) => {
  if (!hasTargetSelector(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'At least one target selector (target, chatId, conversationTitle, senderId, or senderName) is required.',
    });
  }
});
export type McpQueryTargetMessagesInput = z.infer<typeof McpQueryTargetMessagesInputSchema>;

export const McpQueryTargetMessagesByTimeInputSchema = TargetSelectorBaseSchema.extend({
  from: z.string().trim().min(1).max(64).optional(),
  to: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  if (!hasTargetSelector(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'At least one target selector (target, chatId, conversationTitle, senderId, or senderName) is required.',
    });
  }
  if (!value.from && !value.to) {
    ctx.addIssue({
      code: 'custom',
      message: 'At least one time bound (from or to) is required for query_target_messages_by_time.',
    });
    return;
  }
  const normalizedFrom = value.from ? normalizeMcpTimeBound(value.from, 'from') : null;
  if (value.from && !normalizedFrom) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid from timestamp; expected ISO-8601 datetime with offset or YYYY-MM-DD.',
    });
  }
  const normalizedTo = value.to ? normalizeMcpTimeBound(value.to, 'to') : null;
  if (value.to && !normalizedTo) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid to timestamp; expected ISO-8601 datetime with offset or YYYY-MM-DD.',
    });
  }
  if (normalizedFrom && normalizedTo && Date.parse(normalizedFrom) > Date.parse(normalizedTo)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Invalid time range: from must be less than or equal to to.',
    });
  }
});
export type McpQueryTargetMessagesByTimeInput = z.infer<typeof McpQueryTargetMessagesByTimeInputSchema>;

const McpResourceChatTypeSchema = z.enum(['direct', 'group', 'room']);
const ChatResourceSelectorSchema = z.strictObject({ accountId: z.string().trim().min(1).max(256), chatType: McpResourceChatTypeSchema, chatId: z.string().trim().min(1).max(256) });
export const McpChatResourceListInputSchema = ChatResourceSelectorSchema.extend({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(512).optional() });
export const McpChatResourceGetNoteInputSchema = ChatResourceSelectorSchema.extend({ noteId: z.string().trim().min(1).max(256) });
export const McpChatResourceGetAlbumInputSchema = ChatResourceSelectorSchema.extend({ albumId: z.string().trim().min(1).max(256) });

export const McpToolInputUnionSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('list_targets'),
    arguments: McpListTargetsInputSchema.default({}),
  }),
  z.strictObject({
    name: z.literal('query_target_messages'),
    arguments: McpQueryTargetMessagesInputSchema,
  }),
  z.strictObject({
    name: z.literal('query_target_messages_by_time'),
    arguments: McpQueryTargetMessagesByTimeInputSchema,
  }),
  z.strictObject({ name: z.literal('list_chat_notes'), arguments: McpChatResourceListInputSchema }),
  z.strictObject({ name: z.literal('get_chat_note'), arguments: McpChatResourceGetNoteInputSchema }),
  z.strictObject({ name: z.literal('list_chat_albums'), arguments: McpChatResourceListInputSchema }),
  z.strictObject({ name: z.literal('get_chat_album'), arguments: McpChatResourceGetAlbumInputSchema }),
]);
export type McpToolInputUnion = z.infer<typeof McpToolInputUnionSchema>;

const McpSavedAtSchema = z.iso.datetime({ offset: true }).nullable();
const McpArchivedNoteSummarySchema = z.strictObject({ noteId: z.string().min(1).max(256), savedAt: McpSavedAtSchema });
const McpArchivedNoteSchema = McpArchivedNoteSummarySchema.extend({ markdown: z.string().max(384 * 1024) });
const McpArchivedAlbumSchema = z.strictObject({
  albumId: z.string().min(1).max(256), chatId: z.string().min(1).max(256), title: z.string().max(20_000).nullable(),
  photoCount: z.number().int().min(0).max(100_000).nullable(), createTime: z.number().int().nonnegative().nullable(), updateTime: z.number().int().nonnegative().nullable(),
});
const McpArchivedAlbumPhotoSchema = z.strictObject({ photoId: z.string().min(1).max(256), shotTime: z.number().int().nonnegative().nullable(),
  width: z.number().int().nonnegative().nullable(), height: z.number().int().nonnegative().nullable(), available: z.boolean() });

export const McpToolOutputUnionSchema = z.discriminatedUnion('toolName', [
  z.strictObject({
    toolName: z.literal('list_targets'),
    targets: z.array(McpListedTargetSummarySchema),
  }),
  z.strictObject({
    toolName: z.literal('query_target_messages'),
    messages: z.array(McpMessageRecordSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(512).nullable(),
    page: McpMessagePageSchema,
  }),
  z.strictObject({
    toolName: z.literal('query_target_messages_by_time'),
    messages: z.array(McpMessageRecordSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(512).nullable(),
    page: McpMessagePageSchema,
    from: z.iso.datetime({ offset: true }).nullable(),
    to: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({ toolName: z.literal('list_chat_notes'), accountId: z.string(), chatType: McpResourceChatTypeSchema, chatId: z.string(), notes: z.array(McpArchivedNoteSummarySchema).max(50), nextCursor: z.string().max(512).nullable(), savedAt: McpSavedAtSchema }),
  z.strictObject({ toolName: z.literal('get_chat_note'), accountId: z.string(), chatType: McpResourceChatTypeSchema, chatId: z.string(), note: McpArchivedNoteSchema.nullable(), savedAt: McpSavedAtSchema }),
  z.strictObject({ toolName: z.literal('list_chat_albums'), accountId: z.string(), chatType: McpResourceChatTypeSchema, chatId: z.string(), albums: z.array(McpArchivedAlbumSchema).max(50), nextCursor: z.string().max(512).nullable(), savedAt: McpSavedAtSchema }),
  z.strictObject({ toolName: z.literal('get_chat_album'), accountId: z.string(), chatType: McpResourceChatTypeSchema, chatId: z.string(), album: McpArchivedAlbumSchema.nullable(), photos: z.array(McpArchivedAlbumPhotoSchema).max(50), savedAt: McpSavedAtSchema }),
]);
export type McpToolOutputUnion = z.infer<typeof McpToolOutputUnionSchema>;

/**
 * Internal-only tool: reads the shared Agent room conversation history. It is deliberately NOT part of
 * McpToolNameSchema / MCP_TOOL_NAMES, so an external token scope can never name it.
 */
export const AGENT_ROOM_HISTORY_TOOL_NAME = 'query_agent_room_history' as const;
export const LIST_SEND_TARGETS_TOOL_NAME = 'list_send_targets' as const;
export const SEND_TO_TARGET_TOOL_NAME = 'send_to_target' as const;
export const McpInternalToolNameSchema = z.enum([
  ...McpToolNameSchema.options, AGENT_ROOM_HISTORY_TOOL_NAME, LIST_SEND_TARGETS_TOOL_NAME, SEND_TO_TARGET_TOOL_NAME, ...SCHEDULE_TOOL_NAMES,
]);
export type McpInternalToolName = z.infer<typeof McpInternalToolNameSchema>;
/** The principal of an Agent room job or the local console UI; an admin-direct LINE job is also allowed while the room shares that chat. */
export const AGENT_ROOM_HISTORY_PRINCIPAL_ID = 'internal:ui';

export const AGENT_ROOM_HISTORY_PROMPT_MAX_CHARS = 4_000;
export const AGENT_ROOM_HISTORY_REPLY_MAX_CHARS = 8_000;
export const AGENT_ROOM_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
export const AGENT_ROOM_HISTORY_DEFAULT_LIMIT = 20;
export const AGENT_ROOM_HISTORY_MAX_LIMIT = 50;

const AGENT_ROOM_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond-precision UTC timestamp, exactly as PostgreSQL stores `created_at`; ms precision would break keyset paging. */
const AGENT_ROOM_CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface AgentRoomHistoryCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` */
  createdAt: string;
  jobId: string;
}

export function encodeAgentRoomHistoryCursor(cursor: AgentRoomHistoryCursor): string {
  return btoa(JSON.stringify({ t: cursor.createdAt, i: cursor.jobId })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict decode: any malformed, non-canonical or out-of-format cursor returns null. */
export function decodeAgentRoomHistoryCursor(value: string): AgentRoomHistoryCursor | null {
  if (value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    parsed = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'i' || keys[1] !== 't') return null;
  const { t, i } = record;
  if (typeof t !== 'string' || typeof i !== 'string') return null;
  if (!AGENT_ROOM_CURSOR_TIME_PATTERN.test(t) || !AGENT_ROOM_JOB_ID_PATTERN.test(i)) return null;
  const millis = Date.parse(`${t.slice(0, 23)}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== `${t.slice(0, 23)}Z`) return null;
  const cursor = { createdAt: t, jobId: i };
  return encodeAgentRoomHistoryCursor(cursor) === value ? cursor : null;
}

export const AgentRoomHistoryProviderSchema = z.enum(['codex', 'claude']);
export const AgentRoomHistoryStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);

export const McpAgentRoomHistoryInputSchema = z.strictObject({
  query: z.string().min(1).max(200).optional(),
  provider: AgentRoomHistoryProviderSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(AGENT_ROOM_HISTORY_MAX_LIMIT).optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid time range: from must be less than or equal to to.' });
  }
  if (value.cursor !== undefined && decodeAgentRoomHistoryCursor(value.cursor) === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid cursor.' });
  }
});
export type McpAgentRoomHistoryInput = z.infer<typeof McpAgentRoomHistoryInputSchema>;

export const McpAgentRoomHistoryOriginSchema = z.enum(["agent_room", "line_admin_direct"]);

export const McpAgentRoomHistoryItemSchema = z.strictObject({
  origin: McpAgentRoomHistoryOriginSchema,
  jobId: z.string().regex(AGENT_ROOM_JOB_ID_PATTERN),
  provider: AgentRoomHistoryProviderSchema,
  createdAt: z.iso.datetime({ offset: true }),
  status: AgentRoomHistoryStatusSchema,
  prompt: z.string(),
  reply: z.string().nullable(),
  promptTruncated: z.boolean(),
  replyTruncated: z.boolean(),
});
export type McpAgentRoomHistoryItem = z.infer<typeof McpAgentRoomHistoryItemSchema>;

export const McpAgentRoomHistoryPageSchema = z.strictObject({
  items: z.array(McpAgentRoomHistoryItemSchema).max(AGENT_ROOM_HISTORY_MAX_LIMIT),
  nextCursor: z.string().min(1).max(256).nullable(),
});
export type McpAgentRoomHistoryPage = z.infer<typeof McpAgentRoomHistoryPageSchema>;

export const McpAgentRoomHistoryOutputSchema = McpAgentRoomHistoryPageSchema.extend({
  toolName: z.literal(AGENT_ROOM_HISTORY_TOOL_NAME),
});
export type McpAgentRoomHistoryOutput = z.infer<typeof McpAgentRoomHistoryOutputSchema>;

/** Agent LINE send (internal-only tools; see docs/architecture/agent-line-send.md). */
export const SEND_ITEMS_MAX = 10;
export const SEND_TEXT_MAX_CHARS = 5_000;
export const SEND_ITEMS_PER_JOB_MAX = 30;
export const SEND_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const SEND_FILE_MAX_BYTES = 100 * 1024 * 1024;

export const SendChatTypeSchema = z.enum(['direct', 'group', 'room']);
export type SendChatType = z.infer<typeof SendChatTypeSchema>;

export const SendErrorCodeSchema = z.enum([
  'send_not_permitted', 'send_target_invalid', 'send_line_unavailable',
  'send_source_unavailable', 'send_kind_unsupported', 'send_attachment_unavailable', 'send_file_invalid',
  'send_too_large', 'send_media_unsupported_chat', 'send_limit_exceeded',
  'send_failed', 'send_unknown',
]);
export const SEND_ERROR_CODES = SendErrorCodeSchema.options;
export type SendErrorCode = z.infer<typeof SendErrorCodeSchema>;

export const McpListSendTargetsInputSchema = z.strictObject({ query: z.string().min(1).max(100) });
export type McpListSendTargetsInput = z.infer<typeof McpListSendTargetsInputSchema>;

export const McpSendTargetSchema = z.strictObject({
  no: z.number().int().positive(),
  chatType: SendChatTypeSchema,
  chatId: z.string().min(1),
  title: z.string().nullable(),
  members: z.array(z.string()).max(5),
  memberCount: z.number().int().nonnegative(),
  /** Present only on the administrator's (Primary Admin) direct chat with the Agent account. */
  role: z.literal('primary_admin').optional(),
});
export type McpSendTarget = z.infer<typeof McpSendTargetSchema>;

export const McpListSendTargetsOutputSchema = z.strictObject({
  targets: z.array(McpSendTargetSchema).max(20),
});
export type McpListSendTargetsOutput = z.infer<typeof McpListSendTargetsOutputSchema>;

export const McpSendItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(SEND_TEXT_MAX_CHARS) }),
  z.strictObject({
    type: z.literal('message'),
    accountId: z.string().min(1),
    chatType: ChatTypeSchema,
    chatId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.strictObject({ type: z.literal('attachment'), attachmentId: z.string().min(1) }),
  z.strictObject({ type: z.literal('file'), path: z.string().min(1).max(1024) }),
]);
export type McpSendItem = z.infer<typeof McpSendItemSchema>;

export const McpSendToTargetInputSchema = z.strictObject({
  chatType: SendChatTypeSchema,
  chatId: z.string().min(1),
  items: z.array(McpSendItemSchema).min(1).max(SEND_ITEMS_MAX),
});
export type McpSendToTargetInput = z.infer<typeof McpSendToTargetInputSchema>;

export const McpSendResultSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  status: z.enum(['sent', 'failed', 'unknown', 'skipped']),
  code: SendErrorCodeSchema.optional(),
  /** Real cause of a failed or unknown item (worker code, upload stage, error class, number, gateway code). Bounded and secret-free. */
  detail: SendDetailSchema.optional(),
});
export type McpSendResult = z.infer<typeof McpSendResultSchema>;

export const McpSendToTargetOutputSchema = z.strictObject({
  results: z.array(McpSendResultSchema).min(1).max(SEND_ITEMS_MAX),
});
export type McpSendToTargetOutput = z.infer<typeof McpSendToTargetOutputSchema>;
