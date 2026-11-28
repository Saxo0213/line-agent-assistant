import {
  AGENT_ROOM_HISTORY_TOOL_NAME,
  GET_SUMMARY_GUIDE_TOOL_NAME,
  SET_SUMMARY_GUIDE_TOOL_NAME,
  AGENT_SCHEDULE_CHAT_NUMBER_METRICS,
  AGENT_SCHEDULE_MESSAGE_DIRECTIONS,
  AGENT_SCHEDULE_MESSAGE_KINDS,
  AGENT_SCHEDULE_NUMBER_OPS,
  LIST_SEND_TARGETS_TOOL_NAME,
  SEND_TO_TARGET_TOOL_NAME,
  READ_MESSAGE_ATTACHMENT_TOOL_NAME,
  WAIT_FOR_ADMIN_REPLY_TOOL_NAME,
  LIST_ADMIN_REPLIES_TOOL_NAME,
  CLOSE_SESSION_TOOL_NAME,
  FORWARD_TO_SESSION_NOTE_MAX_CHARS,
  FORWARD_TO_SESSION_TOOL_NAME,
  EXTERNAL_SESSION_KEY_PATTERN,
  EXTERNAL_SESSION_LABEL_MAX_CHARS,
  EXTERNAL_SESSION_WAIT_DEFAULT_SECONDS,
  EXTERNAL_SESSION_WAIT_MAX_SECONDS,
  isExternalSessionToolName,
  CHAT_EXTRA_FOLDER_DESCRIPTION_MAX,
  CHAT_EXTRA_FOLDER_LIMIT,
  LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME,
  ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
  SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME,
  SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME,
  REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
  ListChatDownloadFoldersToolInputSchema,
  AddChatDownloadFolderToolInputSchema,
  SetChatDownloadFolderDescriptionToolInputSchema,
  SetChatDefaultDownloadFolderToolInputSchema,
  RemoveChatDownloadFolderToolInputSchema,
  isChatDownloadFolderToolName,
  type ChatDownloadFolderToolName,
  type WritableConversationKey,
  McpReadMessageAttachmentInputSchema,
  LIST_SCHEDULES_TOOL_NAME,
  CREATE_SCHEDULE_TOOL_NAME,
  UPDATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_TOOL_NAME,
  CreateScheduleToolInputSchema,
  UpdateScheduleToolInputSchema,
  DeleteScheduleToolInputSchema,
  ListSchedulesToolInputSchema,
  isScheduleToolName,
  type AgentScheduleRecurrence,
  type ScheduleToolRecurrence,
  type ScheduleToolName,
  ChatTypeSchema,
  McpAgentRoomHistoryOutputSchema,
  MCP_TOOL_PERMISSIONS,
  MCP_ACTIVE_CHATS_DEFAULT_LIMIT,
  McpMessageKindSchema,
  McpToolOutputUnionSchema,
  McpToolInputUnionSchema,
  type EffectivePermissions,
  McpToolNameSchema,
  normalizeMcpTimeBound,
  decodeMcpMessageCursor,
  encodeMcpMessageCursor,
  type ConversationKey,
  type WorkerBinding,
  type McpMessageRecord,
  type McpListSendTargetsOutput,
  type McpServerStatus,
  type McpToolInputUnion,
  type McpToolName,
  type McpToolOutputUnion,
  type McpInternalToolName,
  McpInternalToolNameSchema,
  type McpAgentRoomHistoryOutput,
  type McpReadMessageAttachmentOutput,
  type ForwardToSessionOutput,
} from '@line-agent/contracts';
import {
  AgentScheduleError,
  CHAT_FOLDER_ADMIN_ONLY_MESSAGE,
  type ChatFolderScope,
  findSharedAdminChat,
  McpDomainError,
  type InternalAgentExecutionContext,
  type McpTokenRepository,
  type MessageRepository,
  queryAgentRoomHistory,
} from '@line-agent/database';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  InternalMcpCapabilityRegistry,
  isInternalMcpToken,
  type InternalMcpCapability,
  type InternalMcpObservation,
} from './internal-mcp-capabilities.js';
import type { AgentApprovalBroker } from './agent-approval-broker.js';
import type { AttachmentStorageService } from './attachment-storage-service.js';
import type { AgentLineSendHandler, AuthorizeOutcome } from './agent-line-send-service.js';
import type { ExternalSessionPlan, ExternalSessionService } from './external-session-service.js';
import { isScheduledRunRequestId, type AgentScheduleService } from './agent-schedule-service.js';
import { formatTaipei } from './agent-schedule-prompt.js';
import type { McpChatResourceReader } from './mcp-chat-resource-reader.js';
import { readMessageAttachmentForJob, type MessageAttachmentAccess } from './mcp-attachment-read.js';
import type { SafeDiagnostic } from '@line-agent/contracts';

export const MAX_CONCURRENT_MCP_REQUESTS = 8;
export const DEFAULT_MCP_RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CHAT_RESOURCE_RESPONSE_BYTES = 512 * 1024;

export function redactMcpSensitiveText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/(authorization\s*["']?\s*[:=]\s*["']?)(?:bearer|basic)\s+[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?\b[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|secret|password|token|certificate|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bla_mcp_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/(\b(?:postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bLW-[A-HJ-NP-Z2-9]{8}\b/g, '[REDACTED_VERIFICATION_CODE]')
    .replace(/\bRA-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function redactMessages(messages: readonly McpMessageRecord[]): McpMessageRecord[] {
  return messages.map((message) => ({
    ...message,
    text: redactMcpSensitiveText(message.text),
  }));
}

function pickMessageShape(args: { accountId?: string | undefined; target?: string | undefined; chatType?: string | undefined; chatId?: string | undefined; conversationTitle?: string | undefined; senderId?: string | undefined; senderName?: string | undefined; text?: string | undefined }): Record<string, unknown> {
  return { a: args.accountId ?? null, t: args.target ?? null, ct: args.chatType ?? null, c: args.chatId ?? null, ti: args.conversationTitle ?? null, si: args.senderId ?? null, sn: args.senderName ?? null, x: args.text ?? null };
}

function formatValidationIssues(error: { issues: ReadonlyArray<{ message: string; path: readonly PropertyKey[] }> }): string {
  return error.issues.slice(0, 5).map(({ message, path }) => `${path.length ? `${path.map(String).join('.')}: ` : ''}${message}`).join('; ')
    || 'Invalid input.';
}

/** Cursor shape of the by-time filters; absent filters add no key, so a cursor from an unfiltered query keeps its hash. */
function pickMessageFilterShape(args: { excludeChatIds?: readonly string[] | undefined; direction?: string | undefined; kinds?: readonly string[] | undefined; excludeKinds?: readonly string[] | undefined }): Record<string, unknown> {
  const sorted = (values: readonly string[] | undefined) => (values && values.length > 0 ? [...new Set(values)].sort() : null);
  const excludeChatIds = sorted(args.excludeChatIds);
  const kinds = sorted(args.kinds);
  const excludeKinds = sorted(args.excludeKinds);
  return {
    ...(excludeChatIds ? { xc: excludeChatIds } : {}),
    ...(args.direction ? { d: args.direction } : {}),
    ...(kinds ? { k: kinds } : {}),
    ...(excludeKinds ? { xk: excludeKinds } : {}),
  };
}

/** Message query filters of the by-time tools in the form the repository takes. */
function messageFilterArgs(args: { excludeChatIds?: string[] | undefined; direction?: 'inbound' | 'outbound' | undefined; kinds?: McpMessageRecord['kind'][] | undefined; excludeKinds?: McpMessageRecord['kind'][] | undefined }) {
  return {
    ...(args.excludeChatIds ? { excludeChatIds: args.excludeChatIds } : {}),
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.kinds ? { kinds: args.kinds } : {}),
    ...(args.excludeKinds ? { excludeKinds: args.excludeKinds } : {}),
  };
}

type MessageQueryBase = Parameters<MessageRepository['queryTargetMessagePage']>[0];

/** One keyset page of archived messages; the cursor is bound to the query shape so it cannot be replayed on another query. */
async function queryMessagePage(
  repo: MessageRepository,
  base: MessageQueryBase,
  args: { cursor?: string | undefined; limit?: number | undefined },
  shape: Record<string, unknown>,
  order: 'asc' | 'desc',
  client: PoolClient,
): Promise<{ messages: McpMessageRecord[]; hasMore: boolean; nextCursor: string | null; page: { returned: number; limit: number; hasMore: boolean; nextCursor: string | null } }> {
  const queryHash = createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
  let after: { occurredAt: string; messageId: string } | undefined;
  if (args.cursor !== undefined) {
    const decoded = decodeMcpMessageCursor(args.cursor);
    if (!decoded) throw new McpDomainError('INVALID_INPUT', 'Invalid cursor.');
    if (decoded.queryHash !== queryHash) {
      throw new McpDomainError('INVALID_INPUT', 'This cursor was issued for a different query. Pass nextCursor only to a call with the same target, text, sender and time range filters.');
    }
    after = { occurredAt: decoded.occurredAt, messageId: decoded.messageId };
  }
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const result = await repo.queryTargetMessagePage({ ...base, limit, order, ...(after ? { after } : {}) }, client);
  const messages = redactMessages(result.messages);
  const nextCursor = result.hasMore && result.lastKey ? encodeMcpMessageCursor({ ...result.lastKey, queryHash }) : null;
  return { messages, hasMore: nextCursor !== null, nextCursor, page: { returned: messages.length, limit, hasMore: nextCursor !== null, nextCursor } };
}

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Added to the descriptions of the two message query tools. */
const EVENT_ROW_GUIDANCE = ' An event row has `kind: "event"`. `text` of an event row is the system line, for example a join or a removal by an admin. The sender of a removal event is the admin who removed the member. The `target`, `senderId` and `senderName` filters also return the events that name the member as joiner, actor or target. `recalled: true` also marks a message that the official LINE client removed, for example after an admin removed the member. Before you say that the sender recalled a message: check the event rows near that time.';

const MESSAGE_FILTER_JSON_PROPERTIES = {
  excludeChatIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Skips the messages of these chats (`chatId` values, exact match).' },
  direction: { type: 'string', enum: ['inbound', 'outbound'], description: '`inbound` keeps only received messages. `outbound` keeps only messages that the account sent.' },
  kinds: { type: 'array', minItems: 1, items: { type: 'string', enum: McpMessageKindSchema.options }, description: 'Keeps only these message kinds. Give `kinds` or `excludeKinds`, not both.' },
  excludeKinds: { type: 'array', minItems: 1, items: { type: 'string', enum: McpMessageKindSchema.options }, description: 'Drops these message kinds. Give `kinds` or `excludeKinds`, not both.' },
} as const;

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'list_targets',
    description:
      'Lists the authorized LINE conversations and participants, one row for each `accountId`, `chatType` and `chatId`. Number the list with `no`. Show the list for the user to choose a chat. When the user replies with a number, take `accountId`, `chatType` and `chatId` of that `no` from the most recent `list_targets` result and pass them to the query tool. `role: "primary_admin"` is the direct chat of the Primary Admin with the Agent account.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string', description: 'Keeps only the rows of this LINE account.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        query: { type: 'string', description: 'Keeps only the rows whose conversation title, `chatId`, member name, nickname or member ID contains `query` (case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: 'query_target_messages',
    description:
      'Searches the archived LINE messages of one target in the authorized accounts. The newest message is first. A page has 200 messages at most. When `hasMore` is true, call again with the same filters and `cursor` = `nextCursor`. Repeat until `hasMore` is false. Process the messages page by page. Say that a time window is empty or complete only when the last page has `hasMore=false`.' + EVENT_ROW_GUIDANCE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        target: { type: 'string', description: 'Conversation title, `chatId`, speaker `displayName` or `senderId`. A number is the `no` in the most recent `list_targets` result.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        chatId: { type: 'string' },
        conversationTitle: { type: 'string' },
        senderId: { type: 'string' },
        senderName: { type: 'string' },
        text: { type: 'string' },
        limit: { type: 'integer', minimum: 1, default: 50, description: 'Page size. A value above 200 becomes 200.' },
        cursor: { type: 'string', maxLength: 512, description: 'Take the `nextCursor` of the previous page of the same query.' },
      },
    },
  },
  {
    name: 'query_target_messages_by_time',
    description:
      'Searches the archived LINE messages in the time window [`from`, `to`]. Format of `from` and `to`: ISO-8601 datetime with offset, or `YYYY-MM-DD`. A `YYYY-MM-DD` value is a full day in Taiwan time (Asia/Taipei, UTC+08:00): `from` starts at 00:00:00.000 and `to` ends at 23:59:59.999. With a time condition, use the smallest time range. To read all chats: omit every target field and give `from`. One call returns the messages of all readable chats. Each message has `accountId`, `chatType`, `chatId` and `conversationTitle`. To read one chat: give a target field. A number is the `no` in the most recent `list_targets` result. `from` is required when no target field is given. Call `list_active_chats` first to see which chats have new messages and how many. Then read only the chats that you need with `chatId`. Filters: `excludeChatIds` skips chats. `kinds` keeps and `excludeKinds` drops message kinds: give `kinds` or `excludeKinds`, not both. `direction` keeps only inbound or only outbound messages. The four filters apply to every page. Send the same values with `cursor`. The oldest message is first. A page has 200 messages at most. When `hasMore` is true, call again with the same filters and `cursor` = `nextCursor`. Repeat until `hasMore` is false. Process the messages page by page. Say that a time window is empty or complete only when the last page has `hasMore=false`.' + EVENT_ROW_GUIDANCE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        target: { type: 'string', description: 'Conversation title, `chatId`, speaker `displayName` or `senderId`. Omit to read all chats.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        chatId: { type: 'string' },
        conversationTitle: { type: 'string' },
        senderId: { type: 'string' },
        senderName: { type: 'string' },
        text: { type: 'string' },
        from: { type: 'string', description: 'Start of the window. ISO-8601 with offset, or `YYYY-MM-DD` (starts at 00:00:00.000 Taiwan time, Asia/Taipei).' },
        to: { type: 'string', description: 'End of the window. ISO-8601 with offset, or `YYYY-MM-DD` (ends at 23:59:59.999 Taiwan time, Asia/Taipei).' },
        ...MESSAGE_FILTER_JSON_PROPERTIES,
        limit: { type: 'integer', minimum: 1, default: 50, description: 'Page size. A value above 200 becomes 200.' },
        cursor: { type: 'string', maxLength: 512, description: 'Take the `nextCursor` of the previous page of the same query.' },
      },
    },
  },
  {
    name: 'list_active_chats',
    description:
      'Lists the chats that have messages in the time window [`from`, `to`]. Each chat has the message count, the number of different senders and the time of the newest message. Call this tool first to see which chats have new messages and how many. Then read only the chats that you need with `query_target_messages_by_time` (give `chatId`, and `accountId` when needed). `to` is optional. Format of `from` and `to`: ISO-8601 datetime with offset, or `YYYY-MM-DD` (a full day in Taiwan time, Asia/Taipei, UTC+08:00). The counts are the messages that `query_target_messages_by_time` returns for the same window and filters. `excludeChatIds`, `direction`, `kinds` and `excludeKinds` work as in that tool. Give `kinds` or `excludeKinds`, not both. The newest chat is first. `limit` defaults to 200. A value above 500 becomes 500. When `truncated` is true, more chats exist: use a smaller window or add a filter.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Start of the window. ISO-8601 with offset, or `YYYY-MM-DD` (starts at 00:00:00.000 Taiwan time, Asia/Taipei).' },
        to: { type: 'string', description: 'End of the window. ISO-8601 with offset, or `YYYY-MM-DD` (ends at 23:59:59.999 Taiwan time, Asia/Taipei).' },
        accountId: { type: 'string' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        ...MESSAGE_FILTER_JSON_PROPERTIES,
        limit: { type: 'integer', minimum: 1, default: MCP_ACTIVE_CHATS_DEFAULT_LIMIT, description: 'Maximum chats returned. A value above 500 becomes 500.' },
      },
      required: ['from'],
    },
  },
  {
    name: 'list_chat_notes', description: 'Lists the saved Note archives of the chat that you name with `accountId`, `chatType` and `chatId`.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 512 } }, required: ['accountId', 'chatType', 'chatId'] },
  },
  {
    name: 'get_chat_note', description: 'Reads one saved Note archive. Give the chat (`accountId`, `chatType`, `chatId`) and `noteId` (the stable post ID).',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, noteId: { type: 'string' } }, required: ['accountId', 'chatType', 'chatId', 'noteId'] },
  },
  {
    name: 'list_chat_albums', description: 'Lists the saved Album archives of the chat that you name with `accountId`, `chatType` and `chatId`.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 512 } }, required: ['accountId', 'chatType', 'chatId'] },
  },
  {
    name: 'get_chat_album', description: 'Reads one saved Album archive. Give the chat (`accountId`, `chatType`, `chatId`) and `albumId` (the stable album ID). The result has bounded photo metadata and image availability.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, albumId: { type: 'string' } }, required: ['accountId', 'chatType', 'chatId', 'albumId'] },
  },
];

/**
 * Internal-only (never in MCP_TOOL_DEFINITIONS, so never on the external endpoint or in a token scope). Offered on the
 * built-in Agent endpoint only to the Agent room or its shared admin-direct chat; tools/call re-checks every time.
 */
export const AGENT_ROOM_HISTORY_TOOL_DEFINITION = {
  name: AGENT_ROOM_HISTORY_TOOL_NAME,
  description:
    "Reads the local Agent room conversation history: the prompts of the operator and the final replies of the Agent. The newest item is first. Call this tool only when the earlier context is needed. Narrow the result with `query` (keyword), `provider`, or the time window `from` and `to`. Prefer a keyword to reading every page. When `nextCursor` is not null, call again with `cursor` = `nextCursor` for the next page. `origin` of an item is `agent_room`, or `line_admin_direct` for the shared 1:1 LINE chat of the operator with the Agent. When `promptTruncated` or `replyTruncated` is true, the text is cut.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Keyword. Case-insensitive match against prompts and replies.' },
      provider: { type: 'string', enum: ['codex', 'claude'] },
      from: { type: 'string', description: 'Start of the window. ISO-8601 datetime with offset.' },
      to: { type: 'string', description: 'End of the window. ISO-8601 datetime with offset.' },
      cursor: { type: 'string', description: 'Take the `nextCursor` of the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
} as const;

/**
 * Local MCP LINE send tools. The external endpoint is loopback-only and rechecks account/write authority per call.
 */
export const LIST_SEND_TARGETS_TOOL_DEFINITION = {
  name: LIST_SEND_TARGETS_TOOL_NAME,
  description:
    'Lists the LINE chats that the Agent account can send to (direct chats, groups and rooms only) whose title, member name or nickname contains `query`. Call this tool first with the name that the admin gave. When one row matches: send to that row. When many rows match: show the admin a numbered list (use `no`) and wait for the choice in the next message. When no row matches: tell the admin. Pass `chatType` and `chatId` of the chosen row to `send_to_target`. ' +
    '`role: "primary_admin"` is the Primary Admin. A `query` such as 管理員, 主要管理者, admin or me returns that row first. The result has a top-level `accountId`. Use it as the `accountId` of a schedule delivery target. ' +
    'When a message ends with `[聯絡人卡片] 名稱（mid: …）`: that contact is the send target. Call this tool with that mid or name. Take the row with `chatType: "direct"` and `chatId` equal to that mid. When no row matches: tell the user.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1, maxLength: 100, description: 'Name to match (case-insensitive substring).' } },
    required: ['query'],
  },
} as const;
export const SEND_TO_TARGET_TOOL_DEFINITION = {
  name: SEND_TO_TARGET_TOOL_NAME,
  description:
    'Sends messages to one LINE chat of the Agent account (`chatType` `direct`, `group` or `room`). `chatId` of a direct chat can be the user MID (`u` + 32 hex characters) of a friend, or of a member of a group or room, of the Agent account. A chat with that user need not exist. The tool refuses strangers, blocked users and the Agent account itself. Each item becomes one LINE message. The tool sends the items in order. Item types: `{type:"text", text}` (up to 5000 characters). `{type:"message", accountId, chatType, chatId, messageId}` forwards an archived message (take the ids from the `query_target_messages` results; text, images and files are forwarded). `{type:"attachment", attachmentId}` sends a stored attachment. `{type:"file", path}` sends a file in the authorized workspace (the job workspace for internal calls, the configured Agent workspace for external local calls), or in a project folder that is bound to this chat and that the job may read; give a project folder file by its own path. `jpg`, `jpeg`, `png` and `gif` files go as images. Other files go as files. Images: 20 MiB at most. Files: 100 MiB at most. Media can go to direct and group chats only. A call has 10 items at most. A job has 30 items at most. The result has a status for each item: `sent`, `failed`, `unknown` or `skipped`. The first `failed` or `unknown` item stops the call. The later items are `skipped`. When an item has status `unknown`: tell the admin. Send that item once only, because the item may be delivered.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      chatType: { type: 'string', enum: ['direct', 'group', 'room'] },
      chatId: { type: 'string', minLength: 1, description: 'Take `chatId` from `list_send_targets`. For a direct chat, the user MID (`u` + 32 hex characters) of a friend, or of a member of a group or room, of the Agent account is also valid.' },
      items: {
        type: 'array', minItems: 1, maxItems: 10,
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['type', 'text'],
              properties: { type: { const: 'text' }, text: { type: 'string', minLength: 1, maxLength: 5000 } } },
            { type: 'object', additionalProperties: false, required: ['type', 'accountId', 'chatType', 'chatId', 'messageId'],
              properties: { type: { const: 'message' }, accountId: { type: 'string', minLength: 1 }, chatType: { type: 'string', enum: ChatTypeSchema.options },
                chatId: { type: 'string', minLength: 1 }, messageId: { type: 'string', minLength: 1 } } },
            { type: 'object', additionalProperties: false, required: ['type', 'attachmentId'],
              properties: { type: { const: 'attachment' }, attachmentId: { type: 'string', minLength: 1 } } },
            { type: 'object', additionalProperties: false, required: ['type', 'path'],
              properties: { type: { const: 'file' }, path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Path inside the authorized Agent workspace (a relative path starts at the workspace), or the full path of a file inside a project folder bound to this chat.' } } },
          ],
        },
      },
    },
    required: ['chatType', 'chatId', 'items'],
  },
} as const;
/**
 * Internal-only (never in MCP_TOOL_DEFINITIONS, so never on the external endpoint or in a token scope). It is offered to every
 * Agent job that may call query_target_messages, and tools/call re-checks the same permission and message visibility.
 */
export const READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION = {
  name: READ_MESSAGE_ATTACHMENT_TOOL_NAME,
  description:
    'Gives a local copy of one message attachment (image, video, audio or file). When the user asks about a file or an attachment: find the message with a message query to get the `attachmentId`. The result has `available`, `absolutePath`, `relativePath` and `reason`. When `available` is true: open `absolutePath` with your file reading tools. When `available` is false: ask the user to send the file again. `reason` gives the cause.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { attachmentId: { type: 'string', minLength: 1, maxLength: 128, description: '`attachmentId` of an attachment in a message record.' } },
    required: ['attachmentId'],
  },
} as const;
/** The summary rules: the global editable text and the chat rule (`rules/摘要.md`) of one chat. */
export interface McpSummaryGuideAccess {
  /** The global text, plus the chat rule of `chat` when it has one. Null when no text is available. */
  read: (chat: { accountId: string; chatType: string; chatId: string } | null) => Promise<string | null>;
  write: (text: string) => Promise<'saved' | 'invalid' | 'io'>;
  reset: () => Promise<boolean>;
}

/** Internal-only. Offered to every Agent job that may call query_target_messages; tools/call re-checks the same permission. */
export const GET_SUMMARY_GUIDE_TOOL_DEFINITION = {
  name: GET_SUMMARY_GUIDE_TOOL_NAME,
  description:
    'Returns the rules for a LINE chat summary. Give the chat when the summary is for one chat. Call it before you write a summary, a digest or the content of a period.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      accountId: { type: 'string', description: '`accountId` of the chat.' },
      chatType: { type: 'string', enum: ['direct', 'group', 'room', 'community', 'thread'] },
      chatId: { type: 'string', description: '`chatId` of the chat.' },
    },
  },
} as const;

/** Internal-only. Offered only to a job of the Primary Admin in the 1:1 chat and to an Agent room job. */
export const SET_SUMMARY_GUIDE_TOOL_DEFINITION = {
  name: SET_SUMMARY_GUIDE_TOOL_NAME,
  description:
    'Replaces the LINE chat summary rules with `text`, or restores the default rules with `reset: true`. Call `get_summary_guide` first, change only the part that the Primary Admin asks for, and send the full new text.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'The full new text of the summary rules.' },
      reset: { type: 'boolean', description: '`true` restores the default rules. Give `text` or `reset`, not both.' },
    },
  },
} as const;
const SEND_TOOLS = [LIST_SEND_TARGETS_TOOL_DEFINITION, SEND_TO_TARGET_TOOL_DEFINITION] as const;

/**
 * External endpoint only (docs/design/external-session-reply.md). send_to_target there has the optional `session`; the built-in
 * Agent never sees it.
 */
export const EXTERNAL_SEND_TO_TARGET_TOOL_DEFINITION = {
  ...SEND_TO_TARGET_TOOL_DEFINITION,
  description: `${SEND_TO_TARGET_TOOL_DEFINITION.description} ` +
    'Add `session` when you want the Primary Admin to answer you. Use `session` only when the target is the direct chat of the Primary Admin (`role: "primary_admin"` in `list_send_targets`). ' +
    '`session.key` is a stable string that you create once and use in every call of the same task. `session.label` is a short name of the task. ' +
    'The tool puts 【label #n】 in front of the first text item. When no item is text, the tool sends the tag as a text message first. ' +
    'When the admin quotes (replies to) one of these messages in LINE: call `wait_for_admin_reply` with the same key to get the answer.',
  inputSchema: {
    ...SEND_TO_TARGET_TOOL_DEFINITION.inputSchema,
    properties: {
      ...SEND_TO_TARGET_TOOL_DEFINITION.inputSchema.properties,
      session: {
        type: 'object', additionalProperties: false, required: ['key', 'label'],
        properties: {
          key: { type: 'string', pattern: EXTERNAL_SESSION_KEY_PATTERN.source, minLength: 8, maxLength: 128, description: 'Stable session key, 8 to 128 characters of A-Z, a-z, 0-9, _ and -.' },
          label: { type: 'string', minLength: 1, maxLength: EXTERNAL_SESSION_LABEL_MAX_CHARS, description: 'Short display name of the session, 1 to 24 characters.' },
        },
      },
    },
  },
} as const;
const EXTERNAL_SEND_TOOLS = [LIST_SEND_TARGETS_TOOL_DEFINITION, EXTERNAL_SEND_TO_TARGET_TOOL_DEFINITION] as const;

const SESSION_KEY_SCHEMA = { type: 'string', pattern: EXTERNAL_SESSION_KEY_PATTERN.source, minLength: 8, maxLength: 128,
  description: 'The `session.key` that you gave to `send_to_target`.' } as const;
export const WAIT_FOR_ADMIN_REPLY_TOOL_DEFINITION = {
  name: WAIT_FOR_ADMIN_REPLY_TOOL_NAME,
  description:
    'Waits for a reply of the Primary Admin to a session that `send_to_target` started. The admin replies when the admin quotes one of your messages in LINE, or when the Agent of LINEJS forwards a message to the session. ' +
    'When undelivered replies exist: the tool returns all of them at once and marks them delivered. When none exist: the tool waits for a new reply for `timeoutSeconds` at most. ' +
    'When the time ends, the result is `{replies: []}`. Call the tool again to keep waiting. ' +
    'Each reply has `replyId`, `source` (`quote` or `agent`), `text`, `attachments` (`attachmentId`, `kind`, `name`), `note` (the explanation of the Agent, or null) and `receivedAt`. ' +
    'To get a file: give its `attachmentId` to `read_message_attachment`. `sessionClosed: true` means that the session is closed.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['sessionKey'],
    properties: {
      sessionKey: SESSION_KEY_SCHEMA,
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: EXTERNAL_SESSION_WAIT_MAX_SECONDS, default: EXTERNAL_SESSION_WAIT_DEFAULT_SECONDS,
        description: 'How long to wait for a new reply, in seconds.' },
    },
  },
} as const;
export const LIST_ADMIN_REPLIES_TOOL_DEFINITION = {
  name: LIST_ADMIN_REPLIES_TOOL_NAME,
  description:
    'Lists the replies of the Primary Admin to one session, delivered and not delivered, oldest first (50 at most). The tool does not mark a reply as delivered. ' +
    '`since` (an ISO-8601 datetime with offset) keeps only the replies after that time. The reply fields are the same as in `wait_for_admin_reply`.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['sessionKey'],
    properties: { sessionKey: SESSION_KEY_SCHEMA, since: { type: 'string', description: 'Keeps only the replies after this time. ISO-8601 datetime with offset.' } },
  },
} as const;
export const CLOSE_SESSION_TOOL_DEFINITION = {
  name: CLOSE_SESSION_TOOL_NAME,
  description:
    'Closes one session. After the close, a quoted reply of the admin to a message of the session goes to the Agent of LINEJS, and the admin gets a notice. ' +
    'When the task is finished: call this tool. A session without activity for 7 days closes by itself. A new `send_to_target` call with the same key opens the session again.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['sessionKey'], properties: { sessionKey: SESSION_KEY_SCHEMA } },
} as const;
/** read_message_attachment on the external endpoint: only an attachment that a reply of a session lists. */
export const EXTERNAL_READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION = {
  name: READ_MESSAGE_ATTACHMENT_TOOL_NAME,
  description:
    'Gives a local copy of one attachment of a reply of the Primary Admin (image, video, audio or file). Take `attachmentId` from the `wait_for_admin_reply` or `list_admin_replies` results. ' +
    'The result has `available`, `absolutePath`, `relativePath` and `reason`. When `available` is true: open `absolutePath` with your file reading tools. When `available` is false: `reason` gives the cause.',
  inputSchema: READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION.inputSchema,
} as const;
const EXTERNAL_SESSION_TOOLS = [WAIT_FOR_ADMIN_REPLY_TOOL_DEFINITION, LIST_ADMIN_REPLIES_TOOL_DEFINITION, CLOSE_SESSION_TOOL_DEFINITION, EXTERNAL_READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION] as const;
/**
 * Internal-only (never in MCP_TOOL_DEFINITIONS, never on the external endpoint, never in a token scope). Offered only to a job of the
 * Primary Admin in the direct chat of the Agent account; tools/call re-checks the principal and the chat every time.
 */
export const FORWARD_TO_SESSION_TOOL_DEFINITION = {
  name: FORWARD_TO_SESSION_TOOL_NAME,
  description:
    'Gives the current message of the Primary Admin to one waiting external session. When the message answers a session in the list "Waiting external sessions" of the prompt: call this tool with `seq` (the number after # in the list) and, if useful, `note` (500 characters at most) that tells the session why you forwarded the message. ' +
    'The result has `forwarded`, `replyId` and `session`. After the call: tell the admin in one short sentence that you forwarded the message. ' +
    'The tool accepts an open session only. A repeated call for the same message returns the first `replyId`.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['seq'],
    properties: {
      seq: { type: 'integer', minimum: 1, description: 'The number of the session (the number after # in the list).' },
      note: { type: 'string', maxLength: FORWARD_TO_SESSION_NOTE_MAX_CHARS, description: 'Short explanation for the session, 500 characters at most.' },
    },
  },
} as const;
/** The jobId of the copy folder of an external read_message_attachment (a fixed folder, so a file is reused). */
const EXTERNAL_ATTACHMENT_FOLDER_ID = 'e57e0000-0000-4000-8000-000000000001';

/**
 * Local MCP schedule tools. A job started by a schedule cannot mutate schedules.
 */
const RECURRENCE_JSON_SCHEMA = {
  description: 'When the schedule fires. `once {at}`. `once {inMinutes: 1..10080}` (one run that many minutes from now; use it for "in 5 minutes" / 5 分鐘後). `daily {time}`. `weekly {days (0=Sunday..6=Saturday), time}`. `interval {everyMinutes (5..10080), anchorAt}`. `cron {expression}` (5 fields: minute hour day-of-month month day-of-week). `time` is HH:mm in the schedule timezone. `at` and `anchorAt` are ISO-8601 datetimes with offset.',
  oneOf: [
    {type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'message'}},description:'A new matching message fires the schedule (`message_forward` only). No time is needed.'},
    { type: 'object', additionalProperties: false, required: ['kind', 'at'], properties: { kind: { const: 'once' }, at: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'inMinutes'], properties: { kind: { const: 'once' }, inMinutes: { type: 'integer', minimum: 1, maximum: 10080 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'time'], properties: { kind: { const: 'daily' }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'days', 'time'],
      properties: { kind: { const: 'weekly' }, days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'everyMinutes', 'anchorAt'],
      properties: { kind: { const: 'interval' }, everyMinutes: { type: 'integer', minimum: 5, maximum: 10080 }, anchorAt: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'expression'], properties: { kind: { const: 'cron' }, expression: { type: 'string', maxLength: 256 } } },
  ],
} as const;
export const LIST_SCHEDULES_TOOL_DEFINITION = {
  name: LIST_SCHEDULES_TOOL_NAME,
  description: 'Lists the scheduled triggers with the next fire time and the last outcome of each. Each schedule has `execution` (`program`: Main does all the work; `agent`: an Agent job does the work) and `mayUseLlm` (true when a run can start an LLM). The default result has the enabled schedules only. When the user asks about disabled or all schedules: pass `status: "disabled"` or `status: "all"`. Before you update, delete or re-enable a schedule: call this tool with `status: "all"` to get its `scheduleId`. The system skips a missed fire time. When the last run still runs, the system skips the fire.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { status: { type: 'string', enum: ['active', 'disabled', 'all'], default: 'active', description: '`active`: enabled schedules only (default). `disabled`: disabled schedules only. `all`: both.' } },
  },
} as const;
const READ_TARGET_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['accountId', 'chatType', 'chatId'],
  properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room', 'community', 'thread'] }, chatId: { type: 'string' }, title: { type: 'string', maxLength: 200 } },
} as const;

const DISABLED_NOTE_TOOLS = new Set<McpToolName>(['list_chat_notes', 'get_chat_note']);
const SEND_TARGET_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['accountId', 'chatType', 'chatId'],
  properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, title: { type: 'string', maxLength: 200 } },
} as const;
const NUMBER_OPS_JSON = [...AGENT_SCHEDULE_NUMBER_OPS];
const TEXT_VALUE_JSON = { oneOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 } }] } as const;
const RULE_LEAF_JSON = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'],
    properties: { metric: { enum: [...AGENT_SCHEDULE_CHAT_NUMBER_METRICS] }, op: { enum: NUMBER_OPS_JSON }, value: { type: 'integer', minimum: 0 } } },
  { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value', 'keywords'],
    properties: { metric: { const: 'chat.keywordHits' }, op: { enum: NUMBER_OPS_JSON }, value: { type: 'integer', minimum: 0 },
      keywords: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 50 } } } },
  { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'],
    properties: { metric: { enum: ['chat.id', 'chat.type'] }, op: { enum: ['==', '!=', 'in', 'not_in'] }, value: TEXT_VALUE_JSON } },
] } as const;
const MESSAGE_LEAF_JSON = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'],
    properties: { metric: { enum: ['message.direction', 'message.kind'] }, op: { enum: ['==', '!=', 'in', 'not_in'] },
      value: { description: '`message.direction`: `inbound` or `outbound`. `message.kind`: ' + AGENT_SCHEDULE_MESSAGE_KINDS.join(', ') + '. Use a string for `==` and `!=`. Use an array (1..100) for `in` and `not_in`.',
        oneOf: [{ type: 'string', enum: [...AGENT_SCHEDULE_MESSAGE_DIRECTIONS, ...AGENT_SCHEDULE_MESSAGE_KINDS] },
          { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', enum: [...AGENT_SCHEDULE_MESSAGE_DIRECTIONS, ...AGENT_SCHEDULE_MESSAGE_KINDS] } }] } } },
  { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'],
    properties: { metric: { const: 'message.textContains' }, op: { enum: ['any_of', 'none_of'] },
      value: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 50 } } } },
] } as const;
/** A condition: a leaf, or a group {all}/{any} of leaves and groups, two group levels at most. */
const conditionJson = <L extends object>(leaf: L) => {
  const group = <C extends object>(child: C) => ({ oneOf: [
    { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', minItems: 1, maxItems: 50, items: child } } },
    { type: 'object', additionalProperties: false, required: ['any'], properties: { any: { type: 'array', minItems: 1, maxItems: 50, items: child } } },
  ] });
  return { oneOf: [leaf, group({ oneOf: [leaf, group(leaf)] })] };
};
/** The pointer that create_schedule and update_schedule carry; the rules are in the message_forward variant of `task`. */
const MESSAGE_FORWARD_SENTENCE = 'Message forwarding: use `task.type: "message_forward"` and `recurrence: {kind: "message"}`. The `task` field gives the rules.';
const MESSAGE_FORWARD_TOOL_GUIDANCE =
  'Immediate message forwarding fires on an event and needs no time. Use recurrence {kind:"message"}. ' +
  'Sender rule: task {type:"message_forward",match:{mode:"sender"},sender:{accountId:"<source-accountId>",mid:"<sender-MID>"}}. Take `sender.mid` from `senderId` in the `query_target_messages` results. Take `sender.accountId` from the selected source target. `sender.label` is optional display text. ' +
  'Contains rule: task {type:"message_forward",match:{mode:"contains",keywords:["<literal>"]}}. ' +
  'Exact rule: task {type:"message_forward",match:{mode:"exact",text:"<literal>"}}. ' +
  'Photo text rule (照片裡的字 / 照片文字包含 / 照片有寫…): task {type:"message_forward",match:{mode:"image_text",keywords:["<literal>"],verifyUnclear:true},actions:{forward:true,notify:false,agent:{target:<same as delivery.target>}}} with a `line_target` delivery. `actions.forward` must be true. When `verifyUnclear` is true, `actions.agent` is required. When the user says that unclear photos can be skipped: set `verifyUnclear:false`. The `image_text` mode checks photos only. ' +
  'Mention rule (@mentions): task {type:"message_forward",match:{mode:"mention",admin?:boolean,members?:[{accountId,mid,label?}],all?:boolean}}. `admin` = mentions of the Primary Admin. `members` = up to 20 account+MID pairs. `all` = @All. Give at least one of them. ' +
  'Optional task.actions = {forward:boolean (default true: forward the original message to `delivery`), notify:boolean (default false: show one desktop notification), agent:null|{prompt?:string,target:{accountId,chatType,chatId}} (start one Agent job per matching message; the Agent job may send its result to `target`)}. At least one action must be on. ' +
  'Resolve source targets with `list_targets`. An empty `targets` array means every readable chat of the Agent and Primary Admin accounts. ' +
  'Delivery: when `actions.forward` is true, use {mode:"line_target",target:{accountId:"<list_send_targets.accountId>",chatType:"direct",chatId:"<selected target.chatId>"}}; `group` is also valid. Take `accountId` from the top-level `list_send_targets` output. Take `chatType` and `chatId` from the selected target row. `title` is optional. When `actions.forward` is false, use {mode:"record_only"}. ' +
  'These task and target keys replace the general summary/custom defaults and the general request-for-time wording.';
const SCHEDULE_TASK_PROPERTIES = {
  jitterMinutes: { type: 'integer', minimum: 0, maximum: 5, description: 'Each run starts a random 0..N minutes (whole seconds) after the scheduled time and before the next occurrence. `0` means no delay (default on create). When the user asks for a random or irregular start time: set it.' },
  targets: { type: 'array', maxItems: 20, items: READ_TARGET_JSON_SCHEMA,
    description: 'Chats that the run reads (groups, rooms, direct chats and communities), up to 20, each one unique. For `message_forward`, empty means every readable chat. Use only chats that the user names in the current request. Take chats from the current request only. When the user names no chat: leave `targets` empty. Resolve each chat with `list_targets` and use its exact `accountId`, `chatType` and `chatId`. The local Agent room is not a valid target.' },
  task: { description: 'What the run does. `custom` (default): runs `prompt` as written. `summary {focus?}`: a summary of the window for each target that follows the linejs-summary rules; needs `targets`. `keyword_digest {keywords: 1..20}`: lists the messages that match any keyword; needs `targets`. For `summary` and `keyword_digest`, `prompt` is optional extra instructions. `new_messages {messageFilter?, rules?, maxMessagesPerChat?, maxTextChars?, sendWhenEmpty?}`: a program task. Main reads the new messages of the window and lists them (empty `targets` = every readable chat). Main runs an LLM only for chats whose rule says `then="llm"`. Use it to list or filter the messages of a scheduled time window. Immediate original forwarding uses `message_forward` and a message event recurrence. `messageFilter` keeps only the matching messages (metrics `message.direction` and `message.kind` with ops `==` `!=` `in` `not_in`; `message.textContains` with `any_of` or `none_of`). `rules` (at most 20; for each chat the first rule whose `when` is true decides; when no rule is true, the result is `list`): `when` is a condition on `chat.messageCount`, `chat.senderCount`, `chat.textChars`, `run.messageCount`, `run.chatCount`, `run.listedChars` (ops `>` `>=` `<` `<=` `==` `!=`; integer value), `chat.keywordHits` (same ops, plus `keywords` 1..20), `chat.id` or `chat.type` (ops `==` `!=` `in` `not_in`). `then` is `list` (send the messages), `skip` (drop the chat) or `llm` (an Agent summarizes the chat). A condition is a leaf {metric, op, value} or a group {all:[…]} / {any:[…]} that nests at most 2 levels. A task has at most 50 leaves in `messageFilter` and `rules` together. `maxMessagesPerChat` 1..200 (default 20). `maxTextChars` 20..2000 (default 200). `sendWhenEmpty` (default false): when true, Main sends one notice line if nothing is to be listed. Delivery is `primary_admin` or `line_target`. Example: {type:"new_messages", messageFilter:{metric:"message.direction",op:"==",value:"inbound"}, rules:[{when:{metric:"chat.id",op:"==",value:"<chatId>"},then:"skip"},{when:{any:[{metric:"chat.messageCount",op:">",value:20},{metric:"run.listedChars",op:">",value:2000}]},then:"llm"}]}. `message {text}`: a fixed system message (alarm, reminder, fixed notice). Main sends it at fire time with no Agent run. Use it for every 提醒我… / 鬧鐘 / 定時通知 request. `text` is the wording of the user as written (1..5000 chars). `text` can contain {{date}} (YYYY-MM-DD), {{time}} (HH:mm) and {{weekday}} (星期一…星期日), filled in Asia/Taipei. Leave out `targets`, `window` and `prompt`. Delivery is `primary_admin` or `line_target`.',
    oneOf: [
      {type:'object',additionalProperties:false,required:['type','match'],description:'Immediate message rule. ' + MESSAGE_FORWARD_TOOL_GUIDANCE + ' Forwarding uses no AI. Literal text is case-sensitive. A sender-only rule also forwards attachment-only receipts. Images and files go as the original. Video and audio go as files. The rule forwards new messages only, and only when the send is certain.',
        properties:{type:{const:'message_forward'},match:{oneOf:[
          {type:'object',additionalProperties:false,required:['mode','keywords'],description:'Use mode:"contains" with 1..20 literal keywords.',properties:{mode:{const:'contains'},keywords:{type:'array',minItems:1,maxItems:20,items:{type:'string',minLength:1,maxLength:200}}}},
          {type:'object',additionalProperties:false,required:['mode','text'],description:'Use mode:"exact" with the exact message text.',properties:{mode:{const:'exact'},text:{type:'string',minLength:1,maxLength:20000}}},
          {type:'object',additionalProperties:false,required:['mode','keywords'],description:'Use `mode:"image_text"` for a new photo whose text contains one of 1..20 literal keywords. The local OCR engine reads the text (no AI). `verifyUnclear` (default true): a photo that is unclear or a near match goes to the Agent job in `actions.agent`. The Agent job sends the photo only when it confirms a keyword.',properties:{mode:{const:'image_text'},keywords:{type:'array',minItems:1,maxItems:20,items:{type:'string',minLength:1,maxLength:200}},verifyUnclear:{type:'boolean',default:true}}},
          {type:'object',additionalProperties:false,required:['mode'],description:'Use mode:"sender" with the separate sender object.',properties:{mode:{const:'sender'}}},
          {type:'object',additionalProperties:false,required:['mode'],description:'Use `mode:"mention"` for a new message that mentions the Primary Admin (`admin`), one of the listed `members` (account + MID), or everyone (`all`). Give at least one of them.',properties:{mode:{const:'mention'},admin:{type:'boolean',default:false},members:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['accountId','mid'],properties:{accountId:{type:'string'},mid:{type:'string',description:'LINE member MID.'},label:{type:'string',maxLength:200}}}},all:{type:'boolean',default:false}}}]},
          actions:{type:'object',additionalProperties:false,description:'What a matching message does. When omitted: forward only. At least one action must be on. `forward` needs a `line_target` delivery. Without `forward`, the delivery is `record_only`.',properties:{forward:{type:'boolean',default:true},notify:{type:'boolean',default:false},agent:{description:'`null`: no Agent job. Otherwise: one Agent job for each matching message. The Agent job may send its result once to `target` (a direct, group or room chat of the Agent account).',oneOf:[{type:'null'},{type:'object',additionalProperties:false,required:['target'],properties:{prompt:{type:'string',maxLength:4000,description:'Instruction for the Agent. When empty, the Agent decides how to handle the message.'},target:{...SEND_TARGET_JSON_SCHEMA,description:'Take `accountId` from the top level of the `list_send_targets` result. Take `chatType` and `chatId` from the selected row.'}}}]}}},
          sender:{type:'object',additionalProperties:false,required:['accountId','mid'],description:'Use when `match.mode` is `sender`. `accountId` is the account of a selected source. `mid` is the LINE sender MID. `label` is optional.',properties:{accountId:{type:'string',description:'Exact `accountId` of one selected source target.'},mid:{type:'string',description:'LINE sender MID.'},label:{type:'string',maxLength:200}}}}},
      { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'custom' } } },
      { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: { type: { const: 'message' }, text: { type: 'string', minLength: 1, maxLength: 5000 } } },
      { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'summary' }, focus: { type: 'string', maxLength: 500 } } },
      { type: 'object', additionalProperties: false, required: ['type', 'keywords'],
        properties: { type: { const: 'keyword_digest' }, keywords: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 50 } } } },
      { type: 'object', additionalProperties: false, required: ['type'],
        properties: { type: { const: 'new_messages' }, messageFilter: conditionJson(MESSAGE_LEAF_JSON),
          rules: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['when', 'then'],
            properties: { when: conditionJson(RULE_LEAF_JSON), then: { enum: ['list', 'skip', 'llm'] } } } },
          maxMessagesPerChat: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, maxTextChars: { type: 'integer', minimum: 20, maximum: 2000, default: 200 },
          sendWhenEmpty: { type: 'boolean', default: false } } },
    ] },
  window: { description: 'The messages that the run covers, ending at the fire time. `since_last_run` (default): from the last submitted run (or one recurrence period). `lookback {minutes: 5..10080}`. The window is 7 days at most.',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'since_last_run' } } },
      { type: 'object', additionalProperties: false, required: ['mode', 'minutes'], properties: { mode: { const: 'lookback' }, minutes: { type: 'integer', minimum: 5, maximum: 10080 } } },
    ] },
  delivery: { description: 'Where the result goes. `primary_admin` (default; omit `delivery`): the job sends the final result to the Primary Admin by LINE. 我 / 給我 / 傳給我 means the Primary Admin. `record_only`: the job reply stays in the schedule run history and nothing is sent (Agent tasks only; not for `message`). `line_target {target}`: use it when the user names another chat. Resolve `target` with `list_send_targets` (a direct chat, group or room of the Agent account). For `message_forward`: use `line_target` when `actions.forward` is on (default) and `record_only` when it is off. Example: {mode:"line_target",target:{accountId:"<list_send_targets.accountId>",chatType:"direct",chatId:"<selected target.chatId>"}}; `group` is also valid. Take `accountId` from the top level of the result. Take `chatType` and `chatId` from the selected target row. `title` is optional.',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'primary_admin' } } },
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'record_only' } } },
      { type: 'object', additionalProperties: false, required: ['mode', 'target'], properties: { mode: { const: 'line_target' }, target: { ...SEND_TARGET_JSON_SCHEMA, description: 'Take `accountId` from the top level of the `list_send_targets` result. Take `chatType` and `chatId` from the selected row. `title` is optional; give it as a string.' } } },
    ] },
} as const;
export const CREATE_SCHEDULE_TOOL_DEFINITION = {
  name: CREATE_SCHEDULE_TOOL_NAME,
  description: 'Creates a scheduled trigger. For each field that the user did not give: use the default. There are two kinds of schedule. Program (`message`, `new_messages`): Main does all the work and uses no LLM, except for chats where a rule says `then: "llm"`. Agent (`custom`, `summary`, `keyword_digest`): each run starts an Agent for work that needs judgment. ' + MESSAGE_FORWARD_SENTENCE + ' A `message_forward` rule forwards or notifies without an AI job. For a request to list the messages of a time window: use `new_messages`. For a condition such as "too many messages means summarize": use a rule with `then: "llm"`. Defaults: `delivery` is the Primary Admin (我 / 給我 means the Primary Admin: omit `delivery`). `task` is `summary` when the user names chats (`targets`), else `custom` with the request as `prompt` and empty `targets` (`message_forward` needs its own task). At each run the Agent chooses the chats to read. `window` is since the last run (when the user states a range, pass `window: {mode: "lookback", minutes}`, for example 過去 6 小時 = 360). `timezone` is Asia/Taipei. `provider` is the provider of the current job. `enabled` is true. For "in 5 minutes" / 5 分鐘後: use `recurrence: {kind: "once", inMinutes: 5}`. For a reminder, alarm or fixed notice (提醒我…): use `task: {type: "message", text}` with the reminder text of the user as written. Main sends the text with no Agent run. Resolve chats with `list_targets` (communities included). Use `targets` only for chats that the user names in the current request. Ask a question in only two cases: a chat name matches several conversations; the user gave no time (`message_forward` needs no time). Each run is an unattended job in its own new session (not the Agent room). Up to 50 schedules can be enabled. After the call: give `nextFireAtTaipei` as the next run time and `deliveryLabel` as the receiver. Reply with a short summary (target, next run time, range, task, receiver) and use the titles of the chats. Tell the user that they can ask for a change. When the result is `SCHEDULE_LIMIT`: ask the user to disable or delete other schedules first.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['title', 'recurrence'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', maxLength: 4000, description: 'Required for the `custom` task: one or two sentences of what to do. For `summary` and `keyword_digest`: leave it empty unless the user gave extra requirements. The system adds the source, time, range, output and rules.' },
      ...SCHEDULE_TASK_PROPERTIES,
      recurrence: RECURRENCE_JSON_SCHEMA,
      timezone: { type: 'string', maxLength: 64, description: 'IANA timezone. Default Asia/Taipei.' },
      provider: { type: 'string', enum: ['codex', 'claude'], description: 'Default: the provider of the current job.' },
      enabled: { type: 'boolean', description: 'Default true.' },
    },
  },
} as const;
export const UPDATE_SCHEDULE_TOOL_DEFINITION = {
  name: UPDATE_SCHEDULE_TOOL_NAME,
  description: 'Changes a scheduled Agent trigger. Fields: any of `title`, `prompt`, `recurrence`, `timezone`, `provider`, `targets`, `task`, `window`, `delivery`, `jitterMinutes`, `enabled` (`false` pauses, `true` resumes). Give only the fields that the user asks to change. Omitted fields keep their current values. The result is the updated schedule with `nextFireAt`. When you update a forwarding rule: keep its current `task` (including `task.actions`), `recurrence`, `targets` and `delivery` unless the user asks to change them. Use `targets` only for chats that the user names in the current request. When the request names no chat: use a `custom` task with the request as `prompt` and empty `targets`. ' + MESSAGE_FORWARD_SENTENCE,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['scheduleId'],
    properties: {
      scheduleId: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', maxLength: 4000 },
      ...SCHEDULE_TASK_PROPERTIES,
      recurrence: RECURRENCE_JSON_SCHEMA,
      timezone: { type: 'string', maxLength: 64 },
      provider: { type: 'string', enum: ['codex', 'claude'] },
      enabled: { type: 'boolean' },
    },
  },
} as const;
export const DELETE_SCHEDULE_TOOL_DEFINITION = {
  name: DELETE_SCHEDULE_TOOL_NAME,
  description: 'Deletes a scheduled Agent trigger and its run history. The deletion is permanent. Before the call: ask the user to confirm.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['scheduleId'], properties: { scheduleId: { type: 'string' } } },
} as const;
const SCHEDULE_TOOLS = [LIST_SCHEDULES_TOOL_DEFINITION, CREATE_SCHEDULE_TOOL_DEFINITION, UPDATE_SCHEDULE_TOOL_DEFINITION, DELETE_SCHEDULE_TOOL_DEFINITION] as const;
/**
 * Internal-only download folder tools (never in MCP_TOOL_DEFINITIONS). Offered only to the Primary Admin and the Agent room;
 * tools/call checks the principal again. They do what Settings and the gear dialog do for the extra attachment folders of a chat.
 */
const CHAT_FOLDER_TARGET_JSON_PROPERTIES = {
  accountId: { type: 'string', description: 'LINE account of the chat. Give it with `chatType` and `chatId`. In the Agent room, it is required when you name a chat. A job from LINE uses its own account.' },
  chatType: { type: 'string', enum: ['direct', 'group', 'room'], description: 'Chat type. Give it with `chatId`. To use the chat of this job, omit both (not possible in the Agent room).' },
  chatId: { type: 'string', minLength: 1, maxLength: 256, description: 'Take `chatId` from `list_targets`. Give it with `chatType`.' },
} as const;
const CHAT_FOLDER_TARGET_GUIDANCE = ' The default chat is the chat of this job. An admin job can name another chat of the same account with `chatType` and `chatId` (and `accountId` in the Agent room). Valid chats: direct, group and room chats. The fixed attachment location does not change. A download folder is an extra place that receives copies of new attachments.';
const CHAT_FOLDER_ERROR_GUIDANCE = ' When the call fails: tell the admin the real `error.code`. Codes: NOT_ABSOLUTE, NOT_DIRECTORY, REPARSE_POINT, PROTECTED_FOLDER, OTHER_CHAT_FOLDER, ACCESS_DENIED, UNREACHABLE, DUPLICATE_FOLDER, LIMIT_REACHED, NOT_FOUND, FAILED, TARGET_REQUIRED, CHAT_NOT_FOUND, ACCOUNT_MISMATCH, INVALID_INPUT.';
export const LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_DEFINITION = {
  name: LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME,
  description: 'Lists the download folders of one chat: the fixed attachment location, the default folder and the classification folders (`folderId`, `path`, `description`). Each folder has the copy counts `queued`, `claimed`, `completed` and `failed`.' + CHAT_FOLDER_TARGET_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...CHAT_FOLDER_TARGET_JSON_PROPERTIES } },
} as const;
export const ADD_CHAT_DOWNLOAD_FOLDER_TOOL_DEFINITION = {
  name: ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
  description: `Adds a classification folder to one chat. \`path\` is an absolute local path or a \\\\server\\share path of an existing real directory. The tool refuses a link, a system folder and the workspace folder of another chat. \`description\` (1 to ${CHAT_EXTRA_FOLDER_DESCRIPTION_MAX} characters) tells the classifier which attachments belong there. A chat has ${CHAT_EXTRA_FOLDER_LIMIT} classification folders at most. Add each path once.` + CHAT_FOLDER_TARGET_GUIDANCE + CHAT_FOLDER_ERROR_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'description'], properties: { ...CHAT_FOLDER_TARGET_JSON_PROPERTIES,
    path: { type: 'string', minLength: 1, maxLength: 1024 }, description: { type: 'string', minLength: 1, maxLength: CHAT_EXTRA_FOLDER_DESCRIPTION_MAX } } },
} as const;
export const SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_DEFINITION = {
  name: SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME,
  description: `Changes the \`description\` (1 to ${CHAT_EXTRA_FOLDER_DESCRIPTION_MAX} characters) of one classification folder of a chat. Take \`folderId\` from \`list_chat_download_folders\`.` + CHAT_FOLDER_TARGET_GUIDANCE + CHAT_FOLDER_ERROR_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, required: ['folderId', 'description'], properties: { ...CHAT_FOLDER_TARGET_JSON_PROPERTIES,
    folderId: { type: 'string', format: 'uuid' }, description: { type: 'string', minLength: 1, maxLength: CHAT_EXTRA_FOLDER_DESCRIPTION_MAX } } },
} as const;
export const SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_DEFINITION = {
  name: SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME,
  description: 'Sets or replaces the default folder of one chat by `path` (the same checks as `add_chat_download_folder`). The default folder receives the attachments that the classifier cannot place. A replaced default folder stops receiving copies.' + CHAT_FOLDER_TARGET_GUIDANCE + CHAT_FOLDER_ERROR_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { ...CHAT_FOLDER_TARGET_JSON_PROPERTIES, path: { type: 'string', minLength: 1, maxLength: 1024 } } },
} as const;
export const REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_DEFINITION = {
  name: REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
  description: 'Removes one classification folder of a chat (`folderId` from `list_chat_download_folders`), or clears the default folder (`clearDefault: true`). Give exactly one of them. Waiting copies stop. The files on disk stay. Before the call: ask the admin to confirm.' + CHAT_FOLDER_TARGET_GUIDANCE + CHAT_FOLDER_ERROR_GUIDANCE,
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...CHAT_FOLDER_TARGET_JSON_PROPERTIES,
    folderId: { type: 'string', format: 'uuid' }, clearDefault: { const: true } } },
} as const;
const CHAT_FOLDER_TOOLS = [LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_DEFINITION, ADD_CHAT_DOWNLOAD_FOLDER_TOOL_DEFINITION, SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_DEFINITION,
  SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_DEFINITION, REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_DEFINITION] as const;
/**
 * The same tools as a whitelisted user's job sees them (own-chat authority): no chat target, no default folder tool, and `path` is a
 * subfolder of the default folder. tools/call applies the limits again; these definitions are only a hint.
 */
const OWN_CHAT_FOLDER_GUIDANCE = ' This tool acts on the chat of this job. The default folder of the chat is fixed. Only the admin can change the default folder.';
const OWN_CHAT_FOLDER_ERROR_GUIDANCE = ' When the call fails: tell the user the real `error.code`. Codes: NO_DEFAULT_FOLDER, INVALID_SUBFOLDER, OUTSIDE_DEFAULT_FOLDER, NOT_DIRECTORY, PROTECTED_FOLDER, ACCESS_DENIED, UNREACHABLE, DUPLICATE_FOLDER, LIMIT_REACHED, NOT_FOUND, FAILED, TARGET_NOT_ALLOWED, ADMIN_ONLY, CHAT_NOT_FOUND, INVALID_INPUT.';
const OWN_CHAT_FOLDER_TOOLS = [
  { name: LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME,
    description: 'Lists the download folders of this chat: the default folder and the classification folders (`folderId`, `path`, `description`). Each folder has the copy counts `queued`, `claimed`, `completed` and `failed`.' + OWN_CHAT_FOLDER_GUIDANCE,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
    description: `Adds a classification folder to this chat. \`path\` is a subfolder name or a relative path with "/" under the default folder of the chat, for example "invoices" or "2026/invoices". The tool creates the folder when the folder does not exist. The tool refuses "..", a drive letter, a network path, a reserved Windows name and the characters < > : " | ? * \\. \`description\` (1 to ${CHAT_EXTRA_FOLDER_DESCRIPTION_MAX} characters) tells the classifier which attachments belong there. A chat has ${CHAT_EXTRA_FOLDER_LIMIT} classification folders at most. Add each folder once. The chat needs a default folder.` + OWN_CHAT_FOLDER_GUIDANCE + OWN_CHAT_FOLDER_ERROR_GUIDANCE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'description'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Subfolder name or relative path under the default folder.' },
      description: { type: 'string', minLength: 1, maxLength: CHAT_EXTRA_FOLDER_DESCRIPTION_MAX } } } },
  { name: SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME,
    description: `Changes the \`description\` (1 to ${CHAT_EXTRA_FOLDER_DESCRIPTION_MAX} characters) of one classification folder of this chat. Take \`folderId\` from \`list_chat_download_folders\`.` + OWN_CHAT_FOLDER_GUIDANCE + OWN_CHAT_FOLDER_ERROR_GUIDANCE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['folderId', 'description'], properties: {
      folderId: { type: 'string', format: 'uuid' }, description: { type: 'string', minLength: 1, maxLength: CHAT_EXTRA_FOLDER_DESCRIPTION_MAX } } } },
  { name: REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
    description: 'Removes one classification folder setting of this chat (`folderId` from `list_chat_download_folders`). The folder and its files stay on disk. Waiting copies stop.' + OWN_CHAT_FOLDER_GUIDANCE + OWN_CHAT_FOLDER_ERROR_GUIDANCE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['folderId'], properties: { folderId: { type: 'string', format: 'uuid' } } } },
] as const;
/** The download folder operations McpService needs; AttachmentStorageService provides them. */
export type AgentChatFolderHandler = Pick<AttachmentStorageService, 'getStatus' | 'addFolder' | 'addSubfolder' | 'setDefaultFolder' | 'removeFolder' | 'setFolderDescription'>
  & { readonly fixedLocation: string };

/** The schedule operations McpService needs; AgentScheduleService provides them. */
export type AgentScheduleToolHandler = Pick<AgentScheduleService, 'list' | 'create' | 'update' | 'delete' | 'primaryAdminChat'>
  & Partial<Pick<AgentScheduleService, 'listExternal' | 'createExternal' | 'updateExternal' | 'deleteExternal'>>;

export function numberMcpTargets<T extends {
  accountId: string;
  chatType: string;
  chatId: string;
  conversationTitle: string | null;
}>(listedTargets: readonly T[]): Array<T & { no: number }> {
  const chatTypeOrder: Record<string, number> = { community: 0, group: 0, room: 1, direct: 2 };
  return [...listedTargets]
    .sort((a, b) =>
      (chatTypeOrder[a.chatType] ?? 3) - (chatTypeOrder[b.chatType] ?? 3) ||
      (a.conversationTitle ?? '').localeCompare(b.conversationTitle ?? '') ||
      a.chatId.localeCompare(b.chatId) ||
      a.accountId.localeCompare(b.accountId) ||
      a.chatType.localeCompare(b.chatType),
    )
    .map((target, index) => ({ ...target, no: index + 1 }));
}

export interface McpServiceOptions {
  onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void;
  pool: Pool;
  tokens: McpTokenRepository;
  messages: MessageRepository;
  maxConcurrentRequests?: number;
  rateLimitPerMinute?: number;
  /** Maximum simultaneously valid built-in Agent capabilities (the Agent active-job bound). */
  maxInternalCapabilities?: number;
  /** Authenticated, authorized handshake observations on an internal capability. */
  onInternalObservation?: (jobId: string, observation: InternalMcpObservation) => void;
  /** Called with +1 before and -1 after every tools/call of a job capability. A throw is ignored. */
  onInternalToolActivity?: (jobId: string, delta: 1 | -1) => void;
  /** Main approval broker behind the internal `request_permission` prompt tool; absent means it is never offered. */
  approvalBroker?: Pick<AgentApprovalBroker, 'request'>;
  /** Agent LINE send behind list_send_targets / send_to_target; absent means the tools are never offered. */
  lineSend?: AgentLineSendHandler;
  /** Sessions and Primary Admin replies behind wait_for_admin_reply, list_admin_replies, close_session and the external read_message_attachment. */
  externalSessions?: Pick<ExternalSessionService, 'authorize' | 'run' | 'authorizeAttachment' | 'forward' | 'notifyReply'>;
  /** Folder where an external read_message_attachment makes its copy (the configured Agent workspace). */
  externalAttachmentWorkspace?: () => Promise<string | null>;
  /** Scheduled Agent triggers behind list/create/update/delete_schedule; absent means the tools are never offered. */
  schedules?: AgentScheduleToolHandler;
  /** Download folders behind list/add/set/remove_chat_download_folder(s); absent means the tools are never offered. */
  chatFolders?: AgentChatFolderHandler;
  /** Clock for schedule conveniences such as once.inMinutes (tests). */
  now?: () => Date;
  chatResources?: McpChatResourceReader;
  /** Local file access behind read_message_attachment; absent means the tool is never offered. */
  /** The prepared run directory and file-read grant of a running Agent job (late wiring to the Agent service). */
  jobFileAccess?: (jobId: string) => { workspacePath: string; fileRead: boolean } | null;
  attachments?: Pick<MessageAttachmentAccess, 'recoverFromLocalDownloads' | 'resolveReadyPath'>;
  /** The summary rules behind get_summary_guide and set_summary_guide; absent means the tools are never offered. */
  summaryGuide?: McpSummaryGuideAccess;
  /** Returns the current authenticated LOGIN binding; archive queries fail closed when absent. */
  getLiveLoginBinding?: (accountId: string) => Promise<WorkerBinding | null>;
}

/**
 * Internal-only permission prompt tool (Claude `--permission-prompt-tool`). Offered only on the built-in Agent endpoint to
 * a capability carrying an approval binding; never part of MCP_TOOL_DEFINITIONS, external grants or LINEJS_MCP_TOOLS.
 */
export const REQUEST_PERMISSION_TOOL_NAME = 'request_permission';
export const REQUEST_PERMISSION_TOOL_DEFINITION = {
  name: REQUEST_PERMISSION_TOOL_NAME,
  description: 'Internal LINEJS permission prompt for the built-in Agent.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
} as const;
const APPROVAL_UNAVAILABLE = { behavior: 'deny', message: 'Interactive approval is unavailable.' } as const;
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};
function safeArchiveTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || value.length > 64) throw new Error('Archived resource timestamp is malformed.');
  return value;
}
function safeArchiveCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512) throw new Error('Archived resource cursor is malformed.');
  return value;
}
function safeAlbumMetadata(value: unknown, chatId: string): Record<string, unknown> {
  if (!isPlainObject(value) || typeof value.albumId !== 'string' || value.albumId.length > 256 || value.chatId !== chatId
    || (value.title !== null && (typeof value.title !== 'string' || Buffer.byteLength(value.title, 'utf8') > 20_000))
    || (value.photoCount !== null && (!Number.isInteger(value.photoCount) || Number(value.photoCount) < 0 || Number(value.photoCount) > 100_000))) {
    throw new Error('Archived Album is malformed.');
  }
  return { albumId: value.albumId, chatId, title: value.title, photoCount: value.photoCount,
    createTime: safeArchiveNumber(value.createTime), updateTime: safeArchiveNumber(value.updateTime) };
}
function safeArchiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Archived resource metadata is malformed.');
  return value;
}

const SUPPORTED_MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export function negotiateMcpProtocol(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_MCP_PROTOCOLS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOLS[0];
}

export class McpService {
  private readonly maxConcurrentRequests: number;
  private readonly rateLimitPerMinute: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly requestSlots = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private externalRequestTimes: number[] = [];
  private closing = false;
  readonly internalCapabilities: InternalMcpCapabilityRegistry;

  constructor(private readonly options: McpServiceOptions) {
    this.internalCapabilities = new InternalMcpCapabilityRegistry(options.maxInternalCapabilities, options.onInternalObservation);
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? MAX_CONCURRENT_MCP_REQUESTS;
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_MCP_RATE_LIMIT_PER_MINUTE;
  }

  private track<T>(work: (signal: AbortSignal, releaseRequestSlot: () => void) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    if (this.closing) {
      return Promise.reject(new McpDomainError('RATE_LIMITED', 'MCP service is shutting down.'));
    }
    if (this.requestSlots.size >= this.maxConcurrentRequests) {
      return Promise.reject(
        new McpDomainError('RATE_LIMITED', 'Maximum concurrent MCP requests exceeded.'),
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason ?? new Error('MCP request cancelled'));
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    this.activeControllers.add(controller);
    let promise: Promise<T>;
    let requestSlotReleased = false;
    const releaseRequestSlot = () => {
      if (requestSlotReleased) return;
      requestSlotReleased = true;
      if (promise) this.requestSlots.delete(promise);
    };
    promise = Promise.resolve().then(() => work(controller.signal, releaseRequestSlot));
    this.inFlight.add(promise);
    this.requestSlots.add(promise);
    void promise.then(
      () => { this.inFlight.delete(promise); this.requestSlots.delete(promise); this.activeControllers.delete(controller); parentSignal?.removeEventListener('abort', abort); },
      () => { this.inFlight.delete(promise); this.requestSlots.delete(promise); this.activeControllers.delete(controller); parentSignal?.removeEventListener('abort', abort); },
    );
    return promise;
  }

  /** One fixed bucket limits all external requests. */
  private checkExternalRateLimit(): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    this.externalRequestTimes = this.externalRequestTimes.filter((ts) => ts > cutoff);
    if (this.externalRequestTimes.length >= this.rateLimitPerMinute) return false;
    this.externalRequestTimes.push(now);
    return true;
  }

  async getStatus(transport: {
    running: boolean;
    endpoint: string | null;
    host: '127.0.0.1';
    port: number | null;
  }): Promise<McpServerStatus> {
    return {
      running: transport.running && !this.closing,
      endpoint: transport.endpoint,
      host: '127.0.0.1',
      port: transport.port,
      inFlightRequests: this.inFlight.size,
      maxConcurrentRequests: this.maxConcurrentRequests,
    };
  }

  private async executeParsedTool(
    client: PoolClient,
    authorizedAccountIds: readonly string[],
    tool: McpToolInputUnion,
    conversationScope?: ConversationKey,
    ownLineNamesOnly = false,
    extraConversationScopes: ReadonlyArray<Pick<ConversationKey, 'chatType' | 'chatId'>> = [],
    signal?: AbortSignal,
  ): Promise<{ output: McpToolOutputUnion; resultCount: number }> {
    if (DISABLED_NOTE_TOOLS.has(tool.name)) throw new McpDomainError('SCOPE_DENIED', 'Chat notes are disabled.');
    const scopeFilter = {
      ...(conversationScope ? { conversationScope } : {}),
      ...(extraConversationScopes.length > 0 ? { extraConversationScopes } : {}),
      ...(ownLineNamesOnly ? { ownLineNamesOnly: true } : {}),
    };
    if (tool.name === 'list_targets') {
      const listedTargets = await this.options.messages.listConversationTargets(
        {
          accountIds: authorizedAccountIds,
          ...scopeFilter,
          ...(tool.arguments.chatType ? { chatType: tool.arguments.chatType } : {}),
          ...(tool.arguments.query ? { query: tool.arguments.query } : {}),
          ...(tool.arguments.limit ? { limit: tool.arguments.limit } : {}),
        },
        client,
      );
      // Full-scope principals see which direct chat is the administrator's; chat-scoped ones never do.
      const admin = ownLineNamesOnly ? null : await findSharedAdminChat(client).catch(() => null);
      const targets = numberMcpTargets(listedTargets).map((target) =>
        admin !== null && target.accountId === admin.accountId && target.chatType === 'direct' && target.chatId === admin.adminMid
          ? { ...target, role: 'primary_admin' as const } : target);
      return {
        output: { toolName: 'list_targets', targets },
        resultCount: targets.length,
      };
    }

    if (tool.name === 'query_target_messages') {
      const paged = await queryMessagePage(
        this.options.messages,
        {
          accountIds: authorizedAccountIds,
          ...scopeFilter,
          ...(tool.arguments.target ? { target: tool.arguments.target } : {}),
          ...(tool.arguments.chatType ? { chatType: tool.arguments.chatType } : {}),
          ...(tool.arguments.chatId ? { chatId: tool.arguments.chatId } : {}),
          ...(tool.arguments.conversationTitle ? { conversationTitle: tool.arguments.conversationTitle } : {}),
          ...(tool.arguments.senderId ? { senderId: tool.arguments.senderId } : {}),
          ...(tool.arguments.senderName ? { senderName: tool.arguments.senderName } : {}),
          ...(tool.arguments.text ? { text: tool.arguments.text } : {}),
        },
        tool.arguments,
        { tool: tool.name, ...pickMessageShape(tool.arguments) },
        'desc',
        client,
      );
      return {
        output: { toolName: 'query_target_messages', ...paged },
        resultCount: paged.messages.length,
      };
    }

    if (tool.name === 'list_active_chats') {
      const from = normalizeMcpTimeBound(tool.arguments.from, 'from');
      const to = tool.arguments.to ? normalizeMcpTimeBound(tool.arguments.to, 'to') : null;
      if (!from) throw new McpDomainError('INVALID_INPUT', 'Invalid from timestamp.');
      const { chats, truncated } = await this.options.messages.listActiveChats(
        {
          accountIds: authorizedAccountIds,
          ...scopeFilter,
          ...(tool.arguments.chatType ? { chatType: tool.arguments.chatType } : {}),
          ...messageFilterArgs(tool.arguments),
          from,
          ...(to ? { to } : {}),
          limit: tool.arguments.limit ?? MCP_ACTIVE_CHATS_DEFAULT_LIMIT,
        },
        client,
      );
      return {
        output: { toolName: 'list_active_chats', from, to, chats, truncated },
        resultCount: chats.length,
      };
    }

    if (tool.name === 'list_chat_notes' || tool.name === 'list_chat_albums' || tool.name === 'get_chat_note' || tool.name === 'get_chat_album') {
      const args = tool.arguments as { accountId: string; chatType: ConversationKey['chatType']; chatId: string; limit?: number; cursor?: string; noteId?: string; albumId?: string };
      const key: ConversationKey = { accountId: args.accountId, chatType: args.chatType, chatId: args.chatId };
      if (!authorizedAccountIds.includes(key.accountId)) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      const visible = !conversationScope || (conversationScope.chatType === key.chatType && conversationScope.chatId === key.chatId)
        || extraConversationScopes.some((scope) => scope.chatType === key.chatType && scope.chatId === key.chatId);
      if (!visible) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      if (!this.options.getLiveLoginBinding) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      const initialBinding = await this.options.getLiveLoginBinding(key.accountId);
      if (!initialBinding || initialBinding.accountId !== key.accountId) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      const exists = await client.query('SELECT 1 FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 LIMIT 1', [key.accountId, key.chatType, key.chatId]);
      if (exists.rowCount !== 1) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      if (!this.options.chatResources) throw new McpDomainError('RATE_LIMITED', 'Archived chat resources are unavailable.');
      const readArchive = async <T>(operation: Promise<T>): Promise<T> => {
        try { return await operation; }
        catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          throw new McpDomainError('INVALID_INPUT', 'Saved chat resources are unavailable or malformed.');
        }
      };
      let output: McpToolOutputUnion;
      if (tool.name === 'list_chat_notes') {
        const result = await readArchive(this.options.chatResources.listNotes(key, (tool.arguments as Extract<McpToolInputUnion, { name: 'list_chat_notes' }>['arguments']).limit ?? 20,
          (tool.arguments as Extract<McpToolInputUnion, { name: 'list_chat_notes' }>['arguments']).cursor, signal));
        if (!Array.isArray(result.notes) || result.notes.length > 50 || result.notes.some((row) => !isPlainObject(row) || typeof row.noteId !== 'string' || row.noteId.length > 256)) throw new Error('Archived Note list is malformed.');
        output = McpToolOutputUnionSchema.parse({ toolName: tool.name, ...key, notes: result.notes.map((row) => ({ noteId: (row as Record<string, unknown>).noteId as string,
          savedAt: safeArchiveTimestamp((row as Record<string, unknown>).savedAt) })), nextCursor: safeArchiveCursor(result.nextCursor), savedAt: safeArchiveTimestamp(result.savedAt) });
      } else if (tool.name === 'get_chat_note') {
        const result = await readArchive(this.options.chatResources.getNote(key, (tool.arguments as Extract<McpToolInputUnion, { name: 'get_chat_note' }>['arguments']).noteId, signal));
        const note = result.note;
        if (note !== null && (!isPlainObject(note) || note.noteId !== args.noteId || typeof note.markdown !== 'string' || Buffer.byteLength(note.markdown, 'utf8') > 384 * 1024)) throw new Error('Archived Note is malformed or oversized.');
        const noteRecord = note as Record<string, unknown> | null;
        output = McpToolOutputUnionSchema.parse({ toolName: tool.name, ...key, note: noteRecord === null ? null : { noteId: args.noteId, markdown: noteRecord.markdown,
          savedAt: safeArchiveTimestamp(noteRecord.savedAt) }, savedAt: safeArchiveTimestamp(result.savedAt) });
      } else if (tool.name === 'list_chat_albums') {
        const result = await readArchive(this.options.chatResources.listAlbums(key, (tool.arguments as Extract<McpToolInputUnion, { name: 'list_chat_albums' }>['arguments']).limit ?? 20,
          (tool.arguments as Extract<McpToolInputUnion, { name: 'list_chat_albums' }>['arguments']).cursor, signal));
        if (!Array.isArray(result.albums) || result.albums.length > 50) throw new Error('Archived Album list is malformed.');
        output = McpToolOutputUnionSchema.parse({ toolName: tool.name, ...key, albums: result.albums.map((row) => safeAlbumMetadata(row, key.chatId)), nextCursor: safeArchiveCursor(result.nextCursor), savedAt: safeArchiveTimestamp(result.savedAt) });
      } else {
        const result = await readArchive(this.options.chatResources.getAlbum(key, (tool.arguments as Extract<McpToolInputUnion, { name: 'get_chat_album' }>['arguments']).albumId, signal));
        const album = result.album === null ? null : safeAlbumMetadata(result.album, key.chatId);
        if (album && album.albumId !== (tool.arguments as Extract<McpToolInputUnion, { name: 'get_chat_album' }>['arguments']).albumId) throw new Error('Archived Album ID does not match.');
        if (!Array.isArray(result.photos) || result.photos.length > 50) throw new Error('Archived photo metadata is malformed.');
        const photos = result.photos.map((photo) => {
          if (!isPlainObject(photo) || typeof photo.photoId !== 'string' || photo.photoId.length > 256 || typeof photo.available !== 'boolean') throw new Error('Archived photo metadata is malformed.');
          const optionalInteger = (value: unknown): number | null => {
            if (value === null || value === undefined) return null;
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Archived photo metadata is malformed.');
            return value;
          };
          return { photoId: photo.photoId, shotTime: optionalInteger(photo.shotTime), width: optionalInteger(photo.width), height: optionalInteger(photo.height), available: photo.available };
        });
        output = McpToolOutputUnionSchema.parse({ toolName: tool.name, ...key, album, photos, savedAt: safeArchiveTimestamp(result.savedAt) });
      }
      if (signal?.aborted) throw signal.reason ?? new Error('MCP request cancelled.');
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_CHAT_RESOURCE_RESPONSE_BYTES) throw new Error('Archived resource response exceeds the bounded size.');
      const currentBinding = await this.options.getLiveLoginBinding(key.accountId);
      if (!currentBinding || currentBinding.accountId !== initialBinding.accountId
        || currentBinding.workerInstanceId !== initialBinding.workerInstanceId || currentBinding.controlEpoch !== initialBinding.controlEpoch
        || currentBinding.transportOwnerId !== initialBinding.transportOwnerId || currentBinding.transportGeneration !== initialBinding.transportGeneration
        || currentBinding.writeGrantVersion !== initialBinding.writeGrantVersion) {
        throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      }
      const resultCount = output.toolName === 'list_chat_notes' ? output.notes.length
        : output.toolName === 'list_chat_albums' ? output.albums.length
          : output.toolName === 'get_chat_album' ? output.photos.length
            : output.toolName === 'get_chat_note' ? (output.note ? 1 : 0) : 0;
      return { output, resultCount };
    }

    const normalizedFrom = tool.arguments.from ? normalizeMcpTimeBound(tool.arguments.from, 'from') : null;
    const normalizedTo = tool.arguments.to ? normalizeMcpTimeBound(tool.arguments.to, 'to') : null;
    const paged = await queryMessagePage(
      this.options.messages,
      {
        accountIds: authorizedAccountIds,
        ...scopeFilter,
        ...(tool.arguments.target ? { target: tool.arguments.target } : {}),
        ...(tool.arguments.chatType ? { chatType: tool.arguments.chatType } : {}),
        ...(tool.arguments.chatId ? { chatId: tool.arguments.chatId } : {}),
        ...(tool.arguments.conversationTitle ? { conversationTitle: tool.arguments.conversationTitle } : {}),
        ...(tool.arguments.senderId ? { senderId: tool.arguments.senderId } : {}),
        ...(tool.arguments.senderName ? { senderName: tool.arguments.senderName } : {}),
        ...(tool.arguments.text ? { text: tool.arguments.text } : {}),
        ...(normalizedFrom ? { from: normalizedFrom } : {}),
        ...(normalizedTo ? { to: normalizedTo } : {}),
        ...messageFilterArgs(tool.arguments),
      },
      tool.arguments,
      { tool: tool.name, ...pickMessageShape(tool.arguments), from: normalizedFrom, to: normalizedTo, ...pickMessageFilterShape(tool.arguments) },
      'asc',
      client,
    );
    return {
      output: {
        toolName: 'query_target_messages_by_time',
        ...paged,
        from: normalizedFrom,
        to: normalizedTo,
      },
      resultCount: paged.messages.length,
    };
  }

  async callInternalTool(
    rawToolInput: McpToolInputUnion,
    context: InternalAgentExecutionContext = { sourceType: 'ui' },
    parentSignal?: AbortSignal,
  ): Promise<McpToolOutputUnion> {
    return this.track(async (signal) => {
      const parsed = McpToolInputUnionSchema.safeParse(rawToolInput);
      if (!parsed.success) {
        throw new McpDomainError(
          'INVALID_INPUT',
          parsed.error.issues[0]?.message ?? 'Invalid MCP tool input.',
        );
      }
      const tool = parsed.data;
      const requestedAccountId = tool.arguments.accountId?.trim();
      return this.options.tokens.executeForInternalAgent({
        context,
        toolName: tool.name,
        signal,
        ...(requestedAccountId ? { requestedAccountId } : {}),
        requestedChat: {
          ...(tool.arguments.chatType ? { chatType: tool.arguments.chatType } : {}),
          ...('chatId' in tool.arguments && tool.arguments.chatId ? { chatId: tool.arguments.chatId } : {}),
        },
        execute: async ({ client, authorizedAccountIds, conversationScope, ownLineNamesOnly, extraConversationScopes }) => {
          const { output, resultCount } = await this.executeParsedTool(client, authorizedAccountIds, tool, conversationScope, ownLineNamesOnly, extraConversationScopes, signal);
          return { data: output, resultCount };
        },
      });
    }, parentSignal);
  }

  /**
   * read_message_attachment: the job may read the attachment only when the owning message is visible to it through the same
   * rules as query_target_messages (permission, accounts, conversation scope). An unknown id and a hidden id give the same error.
   * The file copy runs after the authorization transaction commits.
   */
  private async callReadMessageAttachment(
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<McpReadMessageAttachmentOutput> {
    const access = this.options.attachments;
    if (!access) throw new McpDomainError('SCOPE_DENIED', 'Attachment reading is unavailable.');
    const messages = this.options.messages;
    const authorized = await this.track(() => this.options.tokens.executeForInternalAgent({
      context, toolName: READ_MESSAGE_ATTACHMENT_TOOL_NAME, signal,
      execute: async ({ client, authorizedAccountIds, conversationScope, extraConversationScopes }) => {
        const parsed = McpReadMessageAttachmentInputSchema.safeParse(rawArguments);
        if (!parsed.success) throw new McpDomainError('INVALID_INPUT', formatValidationIssues(parsed.error));
        const found = await messages.getReadableMessageAttachment({
          attachmentId: parsed.data.attachmentId, accountIds: authorizedAccountIds,
          ...(conversationScope ? { conversationScope } : {}),
          ...(extraConversationScopes && extraConversationScopes.length > 0 ? { extraConversationScopes } : {}),
        }, client);
        if (!found) throw new McpDomainError('SCOPE_DENIED', 'The requested attachment is unavailable.');
        return { data: { attachmentId: found.attachmentId, displayName: found.name }, resultCount: 1 };
      },
    }), signal);
    return readMessageAttachmentForJob(
      { getAttachment: (attachmentId) => messages.getAttachment(attachmentId), recoverFromLocalDownloads: (attachmentId) => access.recoverFromLocalDownloads(attachmentId),
        resolveReadyPath: (attachmentId) => access.resolveReadyPath(attachmentId) },
      { attachmentId: authorized.attachmentId, displayName: authorized.displayName, jobId: context.jobId, fileAccess: this.options.jobFileAccess?.(context.jobId) ?? null }, signal);
  }

  /** Agent room history: authorization (re-resolved per call, audited) runs before the input is parsed or any row is read. */
  private async callAgentRoomHistory(
    rawArguments: unknown,
    context: InternalAgentExecutionContext,
    parentSignal?: AbortSignal,
  ): Promise<McpAgentRoomHistoryOutput> {
    return this.track(async (signal) => this.options.tokens.executeForInternalAgent({
      context,
      toolName: AGENT_ROOM_HISTORY_TOOL_NAME,
      signal,
      execute: async ({ client, sharedAdminChat }) => {
        const page = await queryAgentRoomHistory(client, rawArguments ?? {}, sharedAdminChat ?? null);
        const output = McpAgentRoomHistoryOutputSchema.parse({ toolName: AGENT_ROOM_HISTORY_TOOL_NAME, ...page });
        return { data: output, resultCount: output.items.length };
      },
    }), parentSignal);
  }

  /**
   * Agent LINE send tools. The principal is re-resolved and audited inside the short authorization transaction; the
   * LINE effects of send_to_target run after it commits, in the send service's queue. Returns null-free data or an error code.
   */
  private async callSendTool(
    toolName: typeof LIST_SEND_TARGETS_TOOL_NAME | typeof SEND_TO_TARGET_TOOL_NAME,
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    capability: InternalMcpCapability,
    signal: AbortSignal,
  ): Promise<{ data: unknown } | { error: 'send_not_permitted' }> {
    const handler = this.options.lineSend;
    const notPermitted = { error: 'send_not_permitted' } as const;
    if (!handler) return notPermitted;
    try {
      if (toolName === LIST_SEND_TARGETS_TOOL_NAME) {
        return { data: await this.track(() => this.options.tokens.executeForInternalAgent({
          context, toolName, signal,
          execute: async ({ client, accountScope }) => {
            const output = await handler.listTargets(client, rawArguments, accountScope);
            return { data: output, resultCount: output.targets.length };
          },
        }), signal) };
      }
      const outcome = await this.track(() => this.options.tokens.executeForInternalAgent({
        context, toolName, signal,
        execute: async ({ client, principalId, accountScope }) => {
          const authorized = await handler.authorize(client, { jobId: capability.jobId, principalId, rawInput: rawArguments,
            ...(accountScope !== undefined ? { accountScope } : {}) });
          const count = authorized.kind === 'plan' ? authorized.plan.items.length : authorized.output.results.length;
          return { data: authorized, resultCount: count };
        },
      }), signal);
      if (outcome.kind === 'rejected') return { data: outcome.output };
      return { data: await handler.run(outcome.plan, { signal, isLive: () => this.internalCapabilities.isLive(capability) }) };
    } catch (error) {
      if (error instanceof McpDomainError && (error.code === 'PERMISSION_DENIED' || error.code === 'SCOPE_DENIED')) return notPermitted;
      throw error;
    }
  }

  /**
   * forward_to_session. The principal (Primary Admin, direct chat) is re-resolved and audited inside the short transaction, which also
   * writes the reply. The waiting client wakes after the commit. A refusal is a McpDomainError (INVALID_INPUT, PERMISSION_DENIED).
   */
  private async callForwardToSession(
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<ForwardToSessionOutput> {
    const sessions = this.options.externalSessions;
    if (!sessions) throw new McpDomainError('SCOPE_DENIED', 'Session tools are unavailable.');
    const forwarded = await this.track(() => this.options.tokens.executeForInternalAgent({
      context, toolName: FORWARD_TO_SESSION_TOOL_NAME, signal,
      execute: async ({ client }) => ({ data: await sessions.forward(client, { jobId: context.jobId, rawInput: rawArguments }), resultCount: 1 }),
    }), signal);
    sessions.notifyReply(forwarded.sessionKey);
    return forwarded.output;
  }

  /**
   * get_summary_guide: the same permission and chat visibility as query_target_messages (a chat-scoped job may name only its own
   * chats). The chat rule is read only for the chat that the call names, or else for the chat of a chat-scoped job.
   */
  private async callGetSummaryGuide(
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<{ toolName: typeof GET_SUMMARY_GUIDE_TOOL_NAME; text: string }> {
    const access = this.options.summaryGuide;
    if (!access) throw new McpDomainError('SCOPE_DENIED', 'The summary rules are unavailable.');
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const accountId = text(rawArguments.accountId);
    const chatType = text(rawArguments.chatType);
    const chatId = text(rawArguments.chatId);
    const guide = await this.track(() => this.options.tokens.executeForInternalAgent({
      context, toolName: GET_SUMMARY_GUIDE_TOOL_NAME, signal,
      ...(accountId ? { requestedAccountId: accountId } : {}),
      requestedChat: { ...(chatType ? { chatType: chatType as ConversationKey['chatType'] } : {}), ...(chatId ? { chatId } : {}) },
      execute: async ({ conversationScope }) => {
        const chat = accountId && chatType && chatId ? { accountId, chatType, chatId }
          : conversationScope ? { accountId: conversationScope.accountId, chatType: conversationScope.chatType, chatId: conversationScope.chatId }
            : null;
        return { data: await access.read(chat), resultCount: 1 };
      },
    }), signal);
    if (guide === null) throw new McpDomainError('SCOPE_DENIED', 'The summary rules are unavailable.');
    return { toolName: GET_SUMMARY_GUIDE_TOOL_NAME, text: guide };
  }

  /** set_summary_guide: only a job of the Primary Admin in the 1:1 chat or an Agent room job. Exactly one of text and reset. */
  private async callSetSummaryGuide(
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<{ toolName: typeof SET_SUMMARY_GUIDE_TOOL_NAME; status: 'saved' | 'reset' }> {
    const access = this.options.summaryGuide;
    if (!access) throw new McpDomainError('SCOPE_DENIED', 'The summary rules are unavailable.');
    return this.track(() => this.options.tokens.executeForInternalAgent<{ toolName: typeof SET_SUMMARY_GUIDE_TOOL_NAME; status: 'saved' | 'reset' }>({
      context, toolName: SET_SUMMARY_GUIDE_TOOL_NAME, signal,
      execute: async () => {
        const { text, reset } = rawArguments;
        const hasText = text !== undefined;
        const hasReset = reset !== undefined;
        if (hasText === hasReset || (hasText && (typeof text !== 'string' || text.trim() === '')) || (hasReset && reset !== true)) {
          throw new McpDomainError('INVALID_INPUT', 'Give either a non-empty text or reset: true.');
        }
        if (hasText) {
          const saved = await access.write(text as string);
          if (saved === 'invalid') throw new McpDomainError('INVALID_INPUT', 'The text is empty.');
          if (saved === 'io') throw new McpDomainError('SCOPE_DENIED', 'The summary rules could not be saved.');
          return { data: { toolName: SET_SUMMARY_GUIDE_TOOL_NAME, status: 'saved' as const }, resultCount: 1 };
        }
        if (!(await access.reset())) throw new McpDomainError('SCOPE_DENIED', 'The default summary rules could not be restored.');
        return { data: { toolName: SET_SUMMARY_GUIDE_TOOL_NAME, status: 'reset' as const }, resultCount: 1 };
      },
    }), signal);
  }

  /** Converts the tool-only { kind: 'once', inMinutes } into the stored { kind: 'once', at }. */
  private scheduleRecurrence(recurrence: ScheduleToolRecurrence): AgentScheduleRecurrence {
    if ('inMinutes' in recurrence) return { kind: 'once', at: new Date((this.options.now?.() ?? new Date()).getTime() + recurrence.inMinutes * 60_000).toISOString() };
    return recurrence;
  }

  /**
   * Schedule tools. The principal is re-resolved and audited inside the short authorization transaction (the same
   * principals as the send tools); the schedule work runs after it commits. A job started by a schedule (source type
   * `schedule`, request id `schedule:...`) may list but never create, update or delete schedules.
   */
  private async callScheduleTool(
    toolName: ScheduleToolName,
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<{ data: unknown } | { error: { code: string; message?: string } }> {
    const handler = this.options.schedules;
    const notPermitted = { error: { code: 'schedule_not_permitted' } } as const;
    if (!handler) return notPermitted;
    try {
      const job = await this.track(() => this.options.tokens.executeForInternalAgent({
        context, toolName, signal,
        execute: async ({ client, accountScope }) => {
          const row = (await client.query<{ source_type: string; source_request_id: string | null; provider: 'codex' | 'claude' }>(
            'SELECT source_type, source_request_id, provider FROM agent_jobs WHERE job_id = $1', [context.jobId])).rows[0];
          return { data: { scheduledRun: row?.source_type === 'schedule' || isScheduledRunRequestId(row?.source_request_id), provider: row?.provider ?? 'claude' as const,
            accountScope }, resultCount: 0 };
        },
      }), signal);
      if (toolName !== LIST_SCHEDULES_TOOL_NAME && job.scheduledRun) {
        return { error: { code: 'SCHEDULE_RUN_FORBIDDEN', message: 'A job started by a schedule cannot create, update or delete schedules.' } };
      }
      const invalid = (error: { issues: ReadonlyArray<{ message: string; path: readonly PropertyKey[] }> }) =>
        ({ error: { code: 'INVALID_INPUT', message: formatValidationIssues(error) } }) as const;
      if (toolName === LIST_SCHEDULES_TOOL_NAME) {
        const parsed = ListSchedulesToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        const { status } = parsed.data;
        const schedules = (job.accountScope == null ? await handler.list() : await handler.listExternal?.(job.accountScope) ?? []).filter((schedule) => status === 'all' || schedule.enabled === (status === 'active'));
        return { data: { toolName, schedules } };
      }
      if (toolName === CREATE_SCHEDULE_TOOL_NAME) {
        const parsed = CreateScheduleToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        const input = parsed.data;
        const targets = input.targets ?? [];
        const schedule = await handler.create({
          title: input.title, prompt: input.prompt ?? '', recurrence: this.scheduleRecurrence(input.recurrence), provider: input.provider ?? job.provider,
          timezone: input.timezone ?? 'Asia/Taipei', targets, task: input.task ?? (targets.length > 0 ? { type: 'summary' } : { type: 'custom' }),
          window: input.window ?? { mode: 'since_last_run' }, delivery: input.delivery ?? { mode: 'primary_admin' }, enabled: input.enabled ?? true,
          jitterMinutes: input.jitterMinutes ?? 0,
        });
        let deliveryLabel: string;
        if (schedule.delivery.mode === 'primary_admin') {
          const adminTitle = (await handler.primaryAdminChat())?.title.trim();
          deliveryLabel = adminTitle ? `管理員（${adminTitle}）` : '管理員';
        } else deliveryLabel = schedule.delivery.mode === 'line_target' ? schedule.delivery.target.title.trim() || schedule.delivery.target.chatId : '只保存在排程紀錄';
        return { data: { toolName, schedule, nextFireAtTaipei: schedule.nextFireAt ? formatTaipei(new Date(schedule.nextFireAt)) : null, deliveryLabel } };
      }
      if (toolName === UPDATE_SCHEDULE_TOOL_NAME) {
        const parsed = UpdateScheduleToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        const { scheduleId, recurrence, ...rest } = parsed.data;
        const patch = { ...rest, ...(recurrence ? { recurrence: this.scheduleRecurrence(recurrence) } : {}) };
        return { data: { toolName, schedule: await handler.update(scheduleId, patch) } };
      }
      const parsed = DeleteScheduleToolInputSchema.safeParse(rawArguments);
      if (!parsed.success) return invalid(parsed.error);
      if (!await handler.delete(parsed.data.scheduleId)) return { error: { code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found.' } };
      return { data: { toolName, deleted: true, scheduleId: parsed.data.scheduleId } };
    } catch (error) {
      if (error instanceof McpDomainError && (error.code === 'PERMISSION_DENIED' || error.code === 'SCOPE_DENIED')) return notPermitted;
      if (error instanceof AgentScheduleError) return { error: { code: error.code, message: error.message } };
      throw error;
    }
  }

  /**
   * Download folder tools. The principal (Primary Admin or Agent room) is re-resolved and audited inside the short authorization
   * transaction, which also parses the input and resolves the target chat from the job row; the folder work runs after it commits,
   * through the same service calls and path checks as the Settings and gear dialog actions. Result codes are the real folder codes.
   */
  private async callChatFolderTool(
    toolName: ChatDownloadFolderToolName,
    rawArguments: Record<string, unknown>,
    context: Extract<InternalAgentExecutionContext, { sourceType: 'job' }>,
    signal: AbortSignal,
  ): Promise<{ data: unknown } | { error: { code: string; message?: string } }> {
    const storage = this.options.chatFolders;
    const notPermitted = { error: { code: 'chat_folder_not_permitted' } } as const;
    if (!storage) return notPermitted;
    type Staged =
      | { kind: 'invalid'; message: string }
      | { kind: 'error'; code: string; message: string }
      | { kind: 'target'; key: WritableConversationKey; args: Record<string, unknown>; scope: ChatFolderScope };
    try {
      const requestedAccountId = typeof rawArguments.accountId === 'string' && rawArguments.accountId.trim() ? rawArguments.accountId.trim() : undefined;
      const staged = await this.track(() => this.options.tokens.executeForInternalAgent<Staged>({
        context, toolName, signal, ...(requestedAccountId ? { requestedAccountId } : {}),
        execute: async ({ client, authorizedAccountIds, chatFolderScope }) => {
          // The authority is derived by the repository from the durable job row in this transaction; never from the arguments.
          // Absent means the narrower authority (fail closed).
          const authority: ChatFolderScope = chatFolderScope ?? 'own_chat';
          const schema = toolName === LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME ? ListChatDownloadFoldersToolInputSchema
            : toolName === ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME ? AddChatDownloadFolderToolInputSchema
              : toolName === SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME ? SetChatDownloadFolderDescriptionToolInputSchema
                : toolName === SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME ? SetChatDefaultDownloadFolderToolInputSchema
                  : RemoveChatDownloadFolderToolInputSchema;
          const parsed = schema.safeParse(rawArguments);
          if (!parsed.success) return { data: { kind: 'invalid', message: formatValidationIssues(parsed.error) }, resultCount: 0 };
          const { accountId, chatType, chatId, ...args } = parsed.data as { accountId?: string; chatType?: WritableConversationKey['chatType']; chatId?: string } & Record<string, unknown>;
          // The own chat of the job comes from the durable job row; an Agent room job has no account and no chat.
          const job = (await client.query<{ account_id: string | null; chat_type: string | null; chat_id: string | null }>(
            'SELECT account_id, chat_type, chat_id FROM agent_jobs WHERE job_id = $1', [context.jobId])).rows[0];
          let key: WritableConversationKey;
          if (authority === 'own_chat') {
            // Whitelisted user: only the chat of the job. Any explicit target that is not that chat is refused and audited.
            const ownType = job?.chat_type;
            const own: WritableConversationKey | null = job?.account_id && job.chat_id && (ownType === 'direct' || ownType === 'group' || ownType === 'room')
              ? { accountId: job.account_id, chatType: ownType, chatId: job.chat_id } : null;
            if (!own) return { data: { kind: 'error', code: 'TARGET_NOT_ALLOWED', message: 'This job has no chat of its own.' }, resultCount: 0, refused: 'SCOPE_DENIED' as const };
            const explicit = chatType !== undefined || chatId !== undefined || accountId !== undefined;
            if (explicit && (chatType !== own.chatType || chatId !== own.chatId || (accountId !== undefined && accountId !== own.accountId))) {
              return { data: { kind: 'error', code: 'TARGET_NOT_ALLOWED', message: 'You may manage the download folders of this chat only.' }, resultCount: 0, refused: 'SCOPE_DENIED' as const };
            }
            if (toolName === SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME || (toolName === REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME && args.clearDefault === true)) {
              return { data: { kind: 'error', code: 'ADMIN_ONLY', message: 'Only the admin can set or clear the default folder.' }, resultCount: 0, refused: 'PERMISSION_DENIED' as const };
            }
            key = own;
          } else if (chatType !== undefined && chatId !== undefined) {
            const account = accountId ?? job?.account_id ?? undefined;
            if (!account) return { data: { kind: 'error', code: 'TARGET_REQUIRED', message: 'Give accountId, chatType and chatId in the Agent room.' }, resultCount: 0 };
            if ((job?.account_id && account !== job.account_id) || !authorizedAccountIds.includes(account)) {
              return { data: { kind: 'error', code: 'ACCOUNT_MISMATCH', message: 'The chat must belong to the LINE account of this job.' }, resultCount: 0 };
            }
            key = { accountId: account, chatType, chatId };
          } else {
            const ownType = job?.chat_type;
            const own: WritableConversationKey | null = job?.account_id && job.chat_id && (ownType === 'direct' || ownType === 'group' || ownType === 'room')
              ? { accountId: job.account_id, chatType: ownType, chatId: job.chat_id } : null;
            if (!own) return { data: { kind: 'error', code: 'TARGET_REQUIRED', message: 'This job has no chat of its own. Give accountId, chatType and chatId.' }, resultCount: 0 };
            key = own;
          }
          const exists = await client.query('SELECT 1 FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 LIMIT 1', [key.accountId, key.chatType, key.chatId]);
          if (exists.rowCount !== 1) return { data: { kind: 'error', code: 'CHAT_NOT_FOUND', message: 'No such chat.' }, resultCount: 0 };
          return { data: { kind: 'target', key, args, scope: authority }, resultCount: 1 };
        },
      }), signal);
      if (staged.kind === 'invalid') return { error: { code: 'INVALID_INPUT', message: staged.message } };
      if (staged.kind === 'error') return { error: { code: staged.code, message: staged.message } };
      const { key, args, scope } = staged;
      const ownChatOnly = scope === 'own_chat';
      const chat = { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId };
      const failed = (result: { ok: false; code: string }) => ({ error: { code: result.code } });
      // A whitelisted user changes only classification folders of its own chat, never the default folder.
      const isClassified = async (folderId: string) => (await storage.getStatus(key)).folders.some((folder) => folder.folderId === folderId);
      if (toolName === LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME) {
        const status = await storage.getStatus(key);
        // The fixed attachment location is an app-internal path; a whitelisted user does not get it.
        return { data: { toolName, ...chat, ...(ownChatOnly ? {} : { fixedLocation: storage.fixedLocation }), defaultFolder: status.defaultFolder, folders: status.folders,
          waitingClassification: status.waitingClassification, folderLimit: CHAT_EXTRA_FOLDER_LIMIT } };
      }
      if (toolName === ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME) {
        const result = ownChatOnly ? await storage.addSubfolder(key, args.path as string, args.description as string)
          : await storage.addFolder(key, args.path as string, args.description as string);
        return result.ok ? { data: { toolName, ok: true, ...chat, folderId: result.folderId ?? null, root: result.root ?? null, folderCount: result.count, historyCopyStarted: result.backfill ?? false } } : failed(result);
      }
      if (toolName === SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME) {
        if (ownChatOnly && !await isClassified(args.folderId as string)) return { error: { code: 'NOT_FOUND' } };
        const result = await storage.setFolderDescription(key, args.folderId as string, args.description as string);
        return result.ok ? { data: { toolName, ok: true, ...chat, folderId: args.folderId } } : failed(result);
      }
      if (toolName === SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME) {
        if (ownChatOnly) return { error: { code: 'ADMIN_ONLY' } };
        const result = await storage.setDefaultFolder(key, args.path as string);
        return result.ok ? { data: { toolName, ok: true, ...chat, folderId: result.folderId ?? null, root: result.root ?? null, historyCopyStarted: result.backfill ?? false } } : failed(result);
      }
      if (ownChatOnly && (args.clearDefault === true || !await isClassified(args.folderId as string))) return { error: { code: args.clearDefault === true ? 'ADMIN_ONLY' : 'NOT_FOUND' } };
      const folderId = args.clearDefault === true ? (await storage.getStatus(key)).defaultFolder?.folderId : (args.folderId as string | undefined);
      if (!folderId) return { error: { code: 'NOT_FOUND' } };
      const result = await storage.removeFolder(key, folderId);
      return result.ok ? { data: { toolName, ok: true, ...chat, folderId, folderCount: result.count } } : failed(result);
    } catch (error) {
      if (error instanceof McpDomainError && error.code === 'PERMISSION_DENIED' && error.message === CHAT_FOLDER_ADMIN_ONLY_MESSAGE) return { error: { code: 'ADMIN_ONLY' } };
      if (error instanceof McpDomainError && (error.code === 'PERMISSION_DENIED' || error.code === 'SCOPE_DENIED')) return notPermitted;
      throw error;
    }
  }

  /** External local-client schedule mutation happens after the short audited MCP transaction commits. */
  private async callExternalScheduleTool(toolName: ScheduleToolName, rawArguments: Record<string, unknown>, authorizedAccountIds: readonly string[], signal: AbortSignal): Promise<unknown> {
    const handler = this.options.schedules;
    if (!handler) return { error: { code: 'schedule_not_permitted' } };
    if (!handler.listExternal || !handler.createExternal || !handler.updateExternal || !handler.deleteExternal) return { error: { code: 'schedule_not_permitted' } };
    const invalid = (error: { issues: ReadonlyArray<{ message: string; path: readonly PropertyKey[] }> }) =>
      ({ error: { code: 'INVALID_INPUT', message: formatValidationIssues(error) } });
    try {
      if (toolName === LIST_SCHEDULES_TOOL_NAME) {
        const parsed = ListSchedulesToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        return { toolName, schedules: (await handler.listExternal(authorizedAccountIds)).filter((schedule) => parsed.data.status === 'all' || schedule.enabled === (parsed.data.status === 'active')) };
      }
      if (toolName === CREATE_SCHEDULE_TOOL_NAME) {
        const parsed = CreateScheduleToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        const input = parsed.data;
        const targets = input.targets ?? [];
        const delivery = input.delivery ?? { mode: 'primary_admin' as const };
        const referencedAccounts = [...new Set([...targets.map((target) => target.accountId), ...(delivery.mode === 'line_target' ? [delivery.target.accountId] : [])])];
        const accountScope = [...authorizedAccountIds];
        if (referencedAccounts.some((accountId) => !authorizedAccountIds.includes(accountId))) {
          return { error: { code: 'SCHEDULE_INVALID_TARGET', message: 'Schedule target is outside the authorized account scope.' } };
        }
        const schedule = await handler.createExternal({ title: input.title, prompt: input.prompt ?? '', recurrence: this.scheduleRecurrence(input.recurrence),
          provider: input.provider ?? 'claude', timezone: input.timezone ?? 'Asia/Taipei', targets,
          task: input.task ?? (targets.length ? { type: 'summary' } : { type: 'custom' }), window: input.window ?? { mode: 'since_last_run' },
          delivery, enabled: input.enabled ?? true, jitterMinutes: input.jitterMinutes ?? 0 }, accountScope, signal);
        const deliveryLabel = schedule.delivery.mode === 'primary_admin' ? '管理員'
          : schedule.delivery.mode === 'line_target' ? schedule.delivery.target.title.trim() || schedule.delivery.target.chatId : '只保存在排程紀錄';
        return { toolName, schedule, nextFireAtTaipei: schedule.nextFireAt ? formatTaipei(new Date(schedule.nextFireAt)) : null, deliveryLabel };
      }
      if (toolName === UPDATE_SCHEDULE_TOOL_NAME) {
        const parsed = UpdateScheduleToolInputSchema.safeParse(rawArguments);
        if (!parsed.success) return invalid(parsed.error);
        const { scheduleId, recurrence, ...rest } = parsed.data;
        return { toolName, schedule: await handler.updateExternal(scheduleId, { ...rest, ...(recurrence ? { recurrence: this.scheduleRecurrence(recurrence) } : {}) }, authorizedAccountIds, signal) };
      }
      const parsed = DeleteScheduleToolInputSchema.safeParse(rawArguments);
      if (!parsed.success) return invalid(parsed.error);
      if (!await handler.deleteExternal(parsed.data.scheduleId, authorizedAccountIds, signal)) return { error: { code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found.' } };
      return { toolName, deleted: true, scheduleId: parsed.data.scheduleId };
    } catch (error) {
      if (error instanceof AgentScheduleError) return { error: { code: error.code, message: error.message } };
      throw error;
    }
  }

  async resolvePromptContext(job: {
    jobId: string;
    sourceType: 'line' | 'ui';
    prompt: string;
  }): Promise<{ enrichedPrompt: string } | null> {
    const trimmed = job.prompt.trim();
    if (!/^\/mcp(?:\s|$)/i.test(trimmed)) return null;

    const context: InternalAgentExecutionContext =
      job.sourceType === 'line'
        ? { sourceType: 'line', jobId: job.jobId }
        : { sourceType: 'ui' };

    const rest = trimmed.replace(/^\/mcp\s*/i, '');
    const match = /^([a-z_]+)(?:\s+([\s\S]*))?$/i.exec(rest);
    const candidateName = match?.[1] ?? 'list_targets';
    const toolNameParsed = McpToolNameSchema.safeParse(candidateName);
    const toolName: McpToolName = toolNameParsed.success ? toolNameParsed.data : 'list_targets';

    // Always verify principal first if toolName or syntax is questionable so unauthorized callers are audited and denied
    let parsedArgs: Record<string, unknown> = {};
    let userInstruction = '';
    const remainder = match?.[2]?.trim() ?? '';
    if (remainder.startsWith('{')) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let endIdx = -1;
      for (let i = 0; i < remainder.length; i++) {
        const ch = remainder[i]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
      }
      if (endIdx !== -1) {
        try {
          parsedArgs = JSON.parse(remainder.slice(0, endIdx + 1)) as Record<string, unknown>;
          userInstruction = remainder.slice(endIdx + 1).trim();
        } catch {
          throw new McpDomainError('INVALID_INPUT', 'Invalid JSON arguments in /mcp command.');
        }
      }
    } else if (remainder) {
      if (toolName === 'list_targets') {
        parsedArgs = { query: remainder };
      } else {
        parsedArgs = { target: remainder };
      }
    }

    const validatedTool = McpToolInputUnionSchema.safeParse({
      name: toolName,
      arguments: parsedArgs,
    });
    if (!validatedTool.success) {
      // Still enforce principal check via executeForInternalAgent before throwing INVALID_INPUT
      await this.options.tokens.executeForInternalAgent({
        context,
        toolName,
        execute: async () => ({ data: null, resultCount: 0 }),
      });
      throw new McpDomainError(
        'INVALID_INPUT',
        validatedTool.error.issues[0]?.message ?? 'Invalid /mcp arguments.',
      );
    }

    const output = await this.callInternalTool(validatedTool.data, context);
    const enrichedPrompt = [
      `[MCP Internal Archive Query Result (${output.toolName})]`,
      JSON.stringify(output, null, 2),
      userInstruction || `Analyze the above ${output.toolName} archive query result.`,
    ].join('\n\n');
    return { enrichedPrompt };
  }

  async handleExternalJsonRpc(
    rawPayload: unknown,
    parentSignal?: AbortSignal,
  ): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
    const diagnosticIdentity = { correlationId: crypto.randomUUID() };
    return this.track(async (signal, releaseRequestSlot) => {
      if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        return {
          httpStatus: 400,
          body: {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' },
          },
        };
      }
      const rpc = rawPayload as {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      const id =
        typeof rpc.id === 'string' || typeof rpc.id === 'number' || rpc.id === null
          ? rpc.id
          : null;
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        return {
          httpStatus: 400,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32600, message: 'Invalid JSON-RPC 2.0 envelope.' },
          },
        };
      }

      try {
        if (rpc.method === 'initialize') {
          await this.options.tokens.executeLocalClientRead({
            toolName: null,
            signal,
            rateLimiter: () => this.checkExternalRateLimit(),
            execute: async () => ({ data: true }),
          });
          return {
            httpStatus: 200,
            body: {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'line-agent-mcp', version: '1.0.0' },
              },
            },
          };
        }

        if (rpc.method === 'notifications/initialized') {
          await this.options.tokens.executeLocalClientRead({
            toolName: null,
            signal,
            rateLimiter: () => this.checkExternalRateLimit(),
            execute: async () => ({ data: true }),
          });
          return { httpStatus: 202, body: null };
        }

        if (rpc.method === 'ping') {
          await this.options.tokens.executeLocalClientRead({
            toolName: null,
            signal,
            rateLimiter: () => this.checkExternalRateLimit(),
            execute: async () => ({ data: true }),
          });
          return {
            httpStatus: 200,
            body: { jsonrpc: '2.0', id, result: {} },
          };
        }

        if (rpc.method === 'tools/list') {
          const tools = await this.options.tokens.executeLocalClientRead({
            toolName: null,
            signal,
            rateLimiter: () => this.checkExternalRateLimit(),
            execute: async ({ toolScopes }) => ({
              data: [...MCP_TOOL_DEFINITIONS, ...(this.options.lineSend ? (this.options.externalSessions ? EXTERNAL_SEND_TOOLS : SEND_TOOLS) : []),
                ...(this.options.schedules ? SCHEDULE_TOOLS : []), ...(this.options.externalSessions ? EXTERNAL_SESSION_TOOLS : [])].filter((def) => !DISABLED_NOTE_TOOLS.has(def.name as McpToolName) && toolScopes.includes(def.name)
                && (this.options.chatResources || !def.name.startsWith('list_chat_') && !def.name.startsWith('get_chat_'))),
            }),
          });
          return {
            httpStatus: 200,
            body: { jsonrpc: '2.0', id, result: { tools } },
          };
        }

        if (rpc.method === 'tools/call') {
          const params =
            rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
              ? (rpc.params as { name?: unknown; arguments?: unknown })
              : {};
          const toolNameCheck = McpInternalToolNameSchema.safeParse(params.name);
          if (!toolNameCheck.success) {
            await this.options.tokens.executeLocalClientRead({
              toolName: null,
              signal,
              rateLimiter: () => this.checkExternalRateLimit(),
              execute: async () => ({ data: null }),
            });
            return {
              httpStatus: 400,
              body: {
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: `Unsupported MCP tool: ${String(params.name)}` },
              },
            };
          }

          const toolName = toolNameCheck.data;
          const rawArgs =
            params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          const requestedAccountId =
            typeof rawArgs.accountId === 'string' && rawArgs.accountId.trim()
              ? rawArgs.accountId.trim()
              : undefined;

          if (toolName === LIST_SEND_TARGETS_TOOL_NAME || toolName === SEND_TO_TARGET_TOOL_NAME) {
            const handler = this.options.lineSend;
            if (!handler) throw new McpDomainError('SCOPE_DENIED', 'LINE send tools are unavailable.');
            const requestId = randomUUID();
            const principalId = `local-client:${requestId}`;
            const staged = toolName === LIST_SEND_TARGETS_TOOL_NAME
              ? await this.options.tokens.executeLocalClientRead<McpListSendTargetsOutput>({
                toolName, principalId, signal, ...(requestedAccountId ? { requestedAccountId } : {}),
                rateLimiter: () => this.checkExternalRateLimit(),
                execute: async ({ client, authorizedAccountIds }) => {
                  const data = await handler.listTargets(client, rawArgs, authorizedAccountIds);
                  return { data, resultCount: data.targets.length };
                },
              })
              : await this.options.tokens.executeLocalClientRead<AuthorizeOutcome>({
                toolName, principalId, signal, ...(requestedAccountId ? { requestedAccountId } : {}),
                rateLimiter: () => this.checkExternalRateLimit(),
                execute: async ({ client, authorizedAccountIds }) => ({ data: await handler.authorize(client, { jobId: requestId, principalId, rawInput: rawArgs, accountScope: authorizedAccountIds }) }),
              });
            let data: unknown;
            if ('targets' in staged) data = staged;
            else if (staged.kind === 'plan') {
              releaseRequestSlot();
              data = await handler.run(staged.plan, { signal, isLive: () => !signal.aborted && !this.closing });
            }
            else data = staged.output;
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } } };
          }

          // Session tools (docs/design/external-session-reply.md). The short part runs in the audited transaction; a long wait runs after it.
          if (isExternalSessionToolName(toolName)) {
            const sessions = this.options.externalSessions;
            if (!sessions) throw new McpDomainError('SCOPE_DENIED', 'Session tools are unavailable.');
            const requestId = randomUUID();
            const staged = await this.options.tokens.executeLocalClientRead<ExternalSessionPlan>({
              toolName, principalId: `local-client:${requestId}`, signal,
              rateLimiter: () => this.checkExternalRateLimit(),
              execute: async ({ client, authorizedAccountIds }) => {
                const plan = await sessions.authorize(client, { toolName, rawInput: rawArgs, accountScope: authorizedAccountIds });
                return { data: plan, resultCount: plan.kind === 'done' ? plan.resultCount : 0 };
              },
            });
            let data: unknown;
            if (staged.kind === 'wait') {
              // The wait holds no request slot and no database connection.
              releaseRequestSlot();
              data = await sessions.run(staged, { signal });
            } else data = staged.output;
            const isError = !!data && typeof data === 'object' && 'error' in data;
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } } };
          }

          // read_message_attachment on the external endpoint: only an attachment that a reply of a session lists.
          if (toolName === READ_MESSAGE_ATTACHMENT_TOOL_NAME) {
            const sessions = this.options.externalSessions;
            const access = this.options.attachments;
            const workspaceOf = this.options.externalAttachmentWorkspace;
            if (!sessions || !access || !workspaceOf) throw new McpDomainError('SCOPE_DENIED', 'Attachment reading is unavailable.');
            const messages = this.options.messages;
            const requestId = randomUUID();
            const authorized = await this.options.tokens.executeLocalClientRead({
              toolName, principalId: `local-client:${requestId}`, signal,
              rateLimiter: () => this.checkExternalRateLimit(),
              execute: async ({ client, authorizedAccountIds }) => ({
                data: await sessions.authorizeAttachment(client, { rawInput: rawArgs, accountScope: authorizedAccountIds }), resultCount: 1 }),
            });
            releaseRequestSlot();
            const workspacePath = await workspaceOf().catch(() => null);
            const output = await readMessageAttachmentForJob(
              { getAttachment: (attachmentId) => messages.getAttachment(attachmentId), recoverFromLocalDownloads: (attachmentId) => access.recoverFromLocalDownloads(attachmentId),
                resolveReadyPath: (attachmentId) => access.resolveReadyPath(attachmentId) },
              { attachmentId: authorized.attachmentId, displayName: authorized.displayName, jobId: EXTERNAL_ATTACHMENT_FOLDER_ID,
                fileAccess: workspacePath ? { workspacePath, fileRead: true } : null }, signal);
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: false } } };
          }

          if (isScheduleToolName(toolName)) {
            const handler = this.options.schedules;
            if (!handler) throw new McpDomainError('SCOPE_DENIED', 'Schedule tools are unavailable.');
            const requestId = randomUUID();
            const authorizedAccountIds = await this.options.tokens.executeLocalClientRead({ toolName, principalId: `local-client:${requestId}`, signal,
              rateLimiter: () => this.checkExternalRateLimit(), execute: async ({ authorizedAccountIds }) => {
                const parsed = toolName === CREATE_SCHEDULE_TOOL_NAME ? CreateScheduleToolInputSchema.safeParse(rawArgs)
                  : toolName === UPDATE_SCHEDULE_TOOL_NAME ? UpdateScheduleToolInputSchema.safeParse(rawArgs)
                    : toolName === DELETE_SCHEDULE_TOOL_NAME ? DeleteScheduleToolInputSchema.safeParse(rawArgs)
                      : ListSchedulesToolInputSchema.safeParse(rawArgs);
                if (!parsed.success) throw new McpDomainError('INVALID_INPUT', formatValidationIssues(parsed.error));
                return { data: authorizedAccountIds };
              } });
            if (signal.aborted || this.closing) return { httpStatus: 200, body: { jsonrpc: '2.0', id,
              error: { code: -32800, message: 'Request cancelled before schedule operation started.' } } };
            releaseRequestSlot();
            const result = await this.callExternalScheduleTool(toolName, rawArgs, authorizedAccountIds, signal);
            const isError = !!result && typeof result === 'object' && 'error' in result;
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError } } };
          }

          // Verify tool and account scope first, then validate arguments and execute
          const output = await this.options.tokens.executeLocalClientRead({
            toolName,
            signal,
            ...(requestedAccountId ? { requestedAccountId } : {}),
            rateLimiter: () => this.checkExternalRateLimit(),
            execute: async ({ client, authorizedAccountIds }) => {
              const parsedInput = McpToolInputUnionSchema.safeParse({
                name: toolName,
                arguments: rawArgs,
              });
              if (!parsedInput.success) {
                throw new McpDomainError(
                  'INVALID_INPUT',
                  parsedInput.error.issues[0]?.message ?? 'Invalid MCP tool arguments.',
                );
              }
              const { output: toolOutput, resultCount } = await this.executeParsedTool(
                client,
                authorizedAccountIds,
                parsedInput.data,
                undefined,
                false,
                [],
                signal,
              );
              return { data: toolOutput, resultCount };
            },
          });

          return {
            httpStatus: 200,
            body: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(output) }],
                structuredContent: output,
                isError: false,
              },
            },
          };
        }

        return {
          httpStatus: 404,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${rpc.method}` },
          },
        };
      } catch (error) {
        return this.mapErrorToJsonRpc(id, error, diagnosticIdentity);
      }
    }, parentSignal).catch((error) => this.mapErrorToJsonRpc(null, error, diagnosticIdentity));
  }

  private mapErrorToJsonRpc(
    id: string | number | null,
    error: unknown,
    identity?: import('@line-agent/contracts').DiagnosticIdentity,
  ): { httpStatus: number; body: Record<string, unknown> } {
    if (error instanceof McpDomainError) {
      if (error.code === 'AUTH_INVALID' || error.code === 'REVOKED' || error.code === 'EXPIRED') {
        return {
          httpStatus: 401,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32001, message: error.message, data: { code: error.code } },
          },
        };
      }
      if (error.code === 'SCOPE_DENIED' || error.code === 'PERMISSION_DENIED' || error.code === 'APPROVAL_REQUIRED') {
        return {
          httpStatus: 403,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32003, message: error.message, data: { code: error.code } },
          },
        };
      }
      if (error.code === 'CONTROL_CHANGED') {
        return {
          httpStatus: 409,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32009, message: 'Account control changed during the request; the client may retry.', data: { code: error.code } },
          },
        };
      }
      if (error.code === 'RATE_LIMITED') {
        return {
          httpStatus: 429,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32005, message: error.message, data: { code: error.code } },
          },
        };
      }
      if (error.code === 'INVALID_INPUT' || error.code === 'MCP_INVALID_ACCOUNT_SCOPE') {
        return {
          httpStatus: 400,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: error.message, data: { code: error.code } },
          },
        };
      }
    }
    try { this.options.onDiagnostic?.({ operation: 'mcp', stage: 'execute', category: 'unknown', recovery: 'retry', outcome: 'failed' }, identity); }
    catch { /* Diagnostics cannot affect the response or disclose the exception. */ }
    return {
      httpStatus: 500,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal MCP server error.',
        },
      },
    };
  }

  async handleInternalJsonRpc(
    bearerToken: string | null,
    endpointInstance: string,
    rawPayload: unknown,
    parentSignal?: AbortSignal,
  ): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
    const resolved = isInternalMcpToken(bearerToken) ? this.internalCapabilities.resolveToken(bearerToken) : null;
    if (resolved?.kind === 'idle' && resolved.endpointInstance === endpointInstance) {
      return this.handleIdleResidentRequest(resolved.slotKey, rawPayload);
    }
    const capability = resolved?.kind === 'job' ? resolved.capability : null;
    if (!capability || capability.endpointInstance !== endpointInstance) {
      // Audit the rejection without any token bytes, like the external path.
      await this.options.tokens.recordAudit({
        tokenId: null, principalId: 'internal:job:unknown', initiator: 'internal_agent', action: 'AUTH_REJECTED', toolName: null,
        accountScopes: [], grantVersion: null, disposition: 'AUTH_INVALID', resultCount: null,
      }).catch(() => undefined);
      return this.mapErrorToJsonRpc(null, new McpDomainError('AUTH_INVALID', 'Invalid or released MCP capability.'));
    }
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return { httpStatus: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' } } };
    }
    const rpc = rawPayload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' || rpc.id === null ? rpc.id : null;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return { httpStatus: 400, body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 envelope.' } } };
    }
    const signal = parentSignal ? AbortSignal.any([parentSignal, capability.controller.signal]) : capability.controller.signal;
    const context = { sourceType: 'job' as const, jobId: capability.jobId, generation: capability.generation, accountId: capability.accountId };
    const verify = () => this.track(() => this.options.tokens.verifyInternalAgentAccess({ context, signal }), signal);
    const allowedTools = (permissions: EffectivePermissions) => MCP_TOOL_DEFINITIONS.filter(
      (definition) => MCP_TOOL_PERMISSIONS[definition.name].some((permission) => permissions[permission] === 'ALLOW')
        && !DISABLED_NOTE_TOOLS.has(definition.name)
        && (this.options.chatResources || !definition.name.startsWith('list_chat_') && !definition.name.startsWith('get_chat_')));
    const finalCheck = async (toolName: McpInternalToolName | null): Promise<void> => {
      if (this.internalCapabilities.isLive(capability) && !signal.aborted) return;
      await this.options.tokens.recordAudit({
        tokenId: null, principalId: 'internal:job:released', initiator: 'internal_agent', action: 'AUTH_REJECTED', toolName,
        accountScopes: capability.accountId === null ? [] : [capability.accountId], grantVersion: null, disposition: 'SCOPE_DENIED', resultCount: null,
      }).catch(() => undefined);
      throw new McpDomainError('SCOPE_DENIED', 'The Agent job is no longer authorized to use LINEJS MCP tools.');
    };
    const trackActivity = rpc.method === 'tools/call';
    if (trackActivity) this.notifyToolActivity(capability.jobId, 1);
    try {
      if (rpc.method === 'initialize') {
        await verify();
        await finalCheck(null);
        this.internalCapabilities.observe(capability, 'initialized');
        const requested = rpc.params && typeof rpc.params === 'object' ? (rpc.params as { protocolVersion?: unknown }).protocolVersion : undefined;
        return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
          protocolVersion: negotiateMcpProtocol(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'line-agent-mcp', version: '1.0.0' },
        } } };
      }
      if (rpc.method === 'notifications/initialized') {
        await verify();
        await finalCheck(null);
        this.internalCapabilities.observe(capability, 'initialized');
        return { httpStatus: 202, body: null };
      }
      if (rpc.method === 'ping') {
        await verify();
        await finalCheck(null);
        return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {} } };
      }
      if (rpc.method === 'tools/list') {
        const { permissions, roomHistory, lineSend, chatFolders, chatFolderScope, forwardToSession, summaryGuideWrite } = await verify();
        await finalCheck(null);
        this.internalCapabilities.observe(capability, 'tools_listed');
        // Listing is only a hint of the current permissions; tools/call re-resolves them and is the authority.
        const tools: Array<McpToolDefinition | typeof AGENT_ROOM_HISTORY_TOOL_DEFINITION | typeof REQUEST_PERMISSION_TOOL_DEFINITION
          | (typeof SEND_TOOLS)[number] | (typeof SCHEDULE_TOOLS)[number] | (typeof CHAT_FOLDER_TOOLS)[number] | (typeof OWN_CHAT_FOLDER_TOOLS)[number] | typeof READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION
          | typeof FORWARD_TO_SESSION_TOOL_DEFINITION | typeof GET_SUMMARY_GUIDE_TOOL_DEFINITION | typeof SET_SUMMARY_GUIDE_TOOL_DEFINITION> = allowedTools(permissions);
        if (forwardToSession === true && this.options.externalSessions) tools.push(FORWARD_TO_SESSION_TOOL_DEFINITION);
        if (roomHistory) tools.push(AGENT_ROOM_HISTORY_TOOL_DEFINITION);
        if (lineSend && this.options.lineSend) tools.push(...SEND_TOOLS);
        if (lineSend && this.options.schedules) tools.push(...SCHEDULE_TOOLS);
        if (chatFolders && this.options.chatFolders) tools.push(...(chatFolderScope === 'own_chat' ? OWN_CHAT_FOLDER_TOOLS : CHAT_FOLDER_TOOLS));
        if (this.options.attachments && MCP_TOOL_PERMISSIONS.query_target_messages.some((permission) => permissions[permission] === 'ALLOW')) tools.push(READ_MESSAGE_ATTACHMENT_TOOL_DEFINITION);
        if (this.options.summaryGuide && MCP_TOOL_PERMISSIONS.query_target_messages.some((permission) => permissions[permission] === 'ALLOW')) tools.push(GET_SUMMARY_GUIDE_TOOL_DEFINITION);
        if (this.options.summaryGuide && summaryGuideWrite) tools.push(SET_SUMMARY_GUIDE_TOOL_DEFINITION);
        if (capability.approval && this.options.approvalBroker) tools.push(REQUEST_PERMISSION_TOOL_DEFINITION);
        this.internalCapabilities.recordToolList(capability, tools);
        return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { tools } } };
      }
      if (rpc.method === 'tools/call') {
        const params = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
          ? (rpc.params as { name?: unknown; arguments?: unknown }) : {};
        if (params.name === REQUEST_PERMISSION_TOOL_NAME) {
          await verify();
          const approval = capability.approval;
          const broker = this.options.approvalBroker;
          const respond = (decision: unknown) => ({ httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false,
          } } });
          if (!approval || !broker) {
            await finalCheck(null);
            return respond(APPROVAL_UNAVAILABLE);
          }
          const args = isPlainObject(params.arguments) ? params.arguments : null;
          const toolName = args?.tool_name;
          const toolInput = args?.input;
          if (typeof toolName !== 'string' || toolName.length < 1 || toolName.length > 128 || !isPlainObject(toolInput)
            || (args?.tool_use_id !== undefined && typeof args.tool_use_id !== 'string')) {
            return { httpStatus: 400, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid request_permission arguments.' } } };
          }
          // The wait is bounded by the broker (global and per-job pending limits, policy timeout) and ends when the
          // capability is released or the HTTP request aborts; it does not hold one of the short-request slots.
          const decision = await broker.request({ jobId: capability.jobId, sessionKey: approval.sessionKey,
            workspaceRoot: approval.workspaceRoot, tool: toolName, input: toolInput, signal });
          await finalCheck(null);
          return respond(decision);
        }
        const rawCallArgs = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>) : {};
        if (params.name === AGENT_ROOM_HISTORY_TOOL_NAME) {
          const history = await this.callAgentRoomHistory(rawCallArgs, context, signal);
          await finalCheck(AGENT_ROOM_HISTORY_TOOL_NAME);
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(history) }],
            structuredContent: history,
            isError: false,
          } } };
        }
        if (params.name === LIST_SEND_TARGETS_TOOL_NAME || params.name === SEND_TO_TARGET_TOOL_NAME) {
          const sent = await this.callSendTool(params.name, rawCallArgs, context, capability, signal);
          if (params.name === LIST_SEND_TARGETS_TOOL_NAME) await finalCheck(params.name);
          if ('error' in sent) {
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: JSON.stringify({ error: { code: sent.error } }) }], isError: true } } };
          }
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(sent.data) }], structuredContent: sent.data, isError: false } } };
        }
        if (params.name === FORWARD_TO_SESSION_TOOL_NAME) {
          // Like send_to_target, a reply that already committed is reported, not turned into an error by a late release.
          const forwarded = await this.callForwardToSession(rawCallArgs, context, signal);
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(forwarded) }],
            structuredContent: forwarded,
            isError: false,
          } } };
        }
        if (params.name === GET_SUMMARY_GUIDE_TOOL_NAME) {
          const guide = await this.callGetSummaryGuide(rawCallArgs, context, signal);
          await finalCheck(GET_SUMMARY_GUIDE_TOOL_NAME);
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: guide.text }],
            structuredContent: guide,
            isError: false,
          } } };
        }
        if (params.name === SET_SUMMARY_GUIDE_TOOL_NAME) {
          const saved = await this.callSetSummaryGuide(rawCallArgs, context, signal);
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(saved) }],
            structuredContent: saved,
            isError: false,
          } } };
        }
        if (params.name === READ_MESSAGE_ATTACHMENT_TOOL_NAME) {
          const attachment = await this.callReadMessageAttachment(rawCallArgs, context, signal);
          await finalCheck(READ_MESSAGE_ATTACHMENT_TOOL_NAME);
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(attachment) }],
            structuredContent: attachment,
            isError: false,
          } } };
        }
        if (isScheduleToolName(params.name)) {
          const scheduled = await this.callScheduleTool(params.name, rawCallArgs, context, signal);
          // Like send_to_target, a mutation that already committed is reported, not turned into an error by a late release.
          if (params.name === LIST_SCHEDULES_TOOL_NAME) await finalCheck(params.name);
          if ('error' in scheduled) {
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: JSON.stringify({ error: scheduled.error }) }], isError: true } } };
          }
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(scheduled.data) }], structuredContent: scheduled.data, isError: false } } };
        }
        if (isChatDownloadFolderToolName(params.name)) {
          const folders = await this.callChatFolderTool(params.name, rawCallArgs, context, signal);
          if (params.name === LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME) await finalCheck(params.name);
          if ('error' in folders) {
            return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: JSON.stringify({ error: folders.error }) }], isError: true } } };
          }
          return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(folders.data) }], structuredContent: folders.data, isError: false } } };
        }
        const toolNameCheck = McpToolNameSchema.safeParse(params.name);
        if (!toolNameCheck.success) {
          await verify();
          return { httpStatus: 400, body: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unsupported MCP tool: ${String(params.name)}` } } };
        }
        const rawArgs = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>) : {};
        const output = await this.callInternalTool(
          { name: toolNameCheck.data, arguments: rawArgs } as McpToolInputUnion,
          context,
          signal,
        );
        await finalCheck(toolNameCheck.data);
        return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
          isError: false,
        } } };
      }
      return { httpStatus: 404, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpc.method}` } } };
    } catch (error) {
      return this.mapErrorToJsonRpc(id, error, { correlationId: crypto.randomUUID(), ...(capability.accountId ? { accountId: capability.accountId } : {}), jobId: capability.jobId });
    } finally {
      if (trackActivity) this.notifyToolActivity(capability.jobId, -1);
    }
  }

  private notifyToolActivity(jobId: string, delta: 1 | -1): void {
    try { this.options.onInternalToolActivity?.(jobId, delta); } catch { /* A callback failure must not change the tool result. */ }
  }

  /** Answers a valid resident token that has no live job. It reads no database and authorizes no tool. */
  private async handleIdleResidentRequest(slotKey: string, rawPayload: unknown): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return { httpStatus: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' } } };
    }
    const rpc = rawPayload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' || rpc.id === null ? rpc.id : null;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return { httpStatus: 400, body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 envelope.' } } };
    }
    if (rpc.method === 'initialize') {
      const requested = rpc.params && typeof rpc.params === 'object' ? (rpc.params as { protocolVersion?: unknown }).protocolVersion : undefined;
      return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {
        protocolVersion: negotiateMcpProtocol(requested),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'line-agent-mcp', version: '1.0.0' },
      } } };
    }
    if (rpc.method === 'notifications/initialized') return { httpStatus: 202, body: null };
    if (rpc.method === 'ping') return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: {} } };
    if (rpc.method === 'tools/list') {
      return { httpStatus: 200, body: { jsonrpc: '2.0', id, result: { tools: this.internalCapabilities.idleToolList(slotKey) ?? [] } } };
    }
    if (rpc.method === 'tools/call') {
      const params = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params) ? (rpc.params as { name?: unknown }) : {};
      const toolName = McpToolNameSchema.safeParse(params.name);
      await this.options.tokens.recordAudit({
        tokenId: null, principalId: 'internal:job:idle', initiator: 'internal_agent', action: 'AUTH_REJECTED',
        toolName: toolName.success ? toolName.data : null,
        accountScopes: [], grantVersion: null, disposition: 'SCOPE_DENIED', resultCount: null,
      }).catch(() => undefined);
      return this.mapErrorToJsonRpc(id, new McpDomainError('SCOPE_DENIED', 'The Agent job is no longer authorized to use LINEJS MCP tools.'));
    }
    return { httpStatus: 404, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpc.method}` } } };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.internalCapabilities.releaseAll();
    for (const controller of this.activeControllers) controller.abort(new Error('MCP service shutting down'));
    await Promise.allSettled([...this.inFlight]);
    this.externalRequestTimes = [];
  }
}
