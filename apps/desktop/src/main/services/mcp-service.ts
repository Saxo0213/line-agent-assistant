import {
  AGENT_ROOM_HISTORY_TOOL_NAME,
  AGENT_SCHEDULE_CHAT_NUMBER_METRICS,
  AGENT_SCHEDULE_MESSAGE_DIRECTIONS,
  AGENT_SCHEDULE_MESSAGE_KINDS,
  AGENT_SCHEDULE_NUMBER_OPS,
  LIST_SEND_TARGETS_TOOL_NAME,
  SEND_TO_TARGET_TOOL_NAME,
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
} from '@line-agent/contracts';
import {
  AgentScheduleError,
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
import type { AgentLineSendHandler, AuthorizeOutcome } from './agent-line-send-service.js';
import { isScheduledRunRequestId, type AgentScheduleService } from './agent-schedule-service.js';
import { formatTaipei } from './agent-schedule-prompt.js';
import type { McpChatResourceReader } from './mcp-chat-resource-reader.js';
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

const MESSAGE_FILTER_JSON_PROPERTIES = {
  excludeChatIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Skip messages of these chats (chatId values, exact match).' },
  direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'inbound = received messages only; outbound = messages sent by the account only.' },
  kinds: { type: 'array', minItems: 1, items: { type: 'string', enum: McpMessageKindSchema.options }, description: 'Keep only these message kinds. Cannot be combined with excludeKinds.' },
  excludeKinds: { type: 'array', minItems: 1, items: { type: 'string', enum: McpMessageKindSchema.options }, description: 'Drop these message kinds. Cannot be combined with kinds.' },
} as const;

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'list_targets',
    description:
      'List authorized LINE conversations and participants grouped by (accountId, chatType, chatId). Rows with role primary_admin are the administrator\'s (Primary Admin) direct chat with the Agent account. Present results as a numbered list using no. If the user later answers with a number, use that no from the most recent list_targets result and pass its exact accountId, chatType, and chatId to the query tool.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string', description: 'Optional LINE account ID filter.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        query: { type: 'string', description: 'Optional keyword matching conversation title, chatId, or member name.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: 'query_target_messages',
    description:
      'Query archived LINE messages for a specified target (conversation title, chatId, sender displayName, or senderId) within authorized account scopes. A number refers to the no in the most recent list_targets result. Messages are returned newest first. Results come in pages of up to 200 (limit above 200 is clamped to 200). When hasMore is true, call again with the same filters and cursor set to nextCursor until hasMore is false; process the messages page by page. Never report a time window as empty or complete unless the last page returned hasMore=false.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        target: { type: 'string', description: 'Target conversation title, chatId, speaker displayName, or senderId.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        chatId: { type: 'string' },
        conversationTitle: { type: 'string' },
        senderId: { type: 'string' },
        senderName: { type: 'string' },
        text: { type: 'string' },
        limit: { type: 'integer', minimum: 1, default: 50, description: 'Page size; values above 200 are clamped to 200.' },
        cursor: { type: 'string', maxLength: 512, description: 'nextCursor from the previous page of the same query.' },
      },
    },
  },
  {
    name: 'query_target_messages_by_time',
    description:
      'Query archived LINE messages within an explicit [from, to] time window (ISO-8601 datetime with offset or YYYY-MM-DD). A YYYY-MM-DD value is a full day in Taiwan time (Asia/Taipei, UTC+08:00): from starts at 00:00:00.000 and to ends at 23:59:59.999 of that day. To read new messages from all chats, omit every target field and give from. One call returns the messages of all readable chats, and each message has its accountId, chatType, chatId and conversationTitle. Do not call this tool once per chat. Do not call list_targets first for this purpose. To see which chats have new messages and how many, call list_active_chats first, then read only the chats you need with chatId. To skip chats you do not want, pass excludeChatIds. To keep or drop message kinds, pass kinds or excludeKinds (not both); direction keeps only inbound (received) or only outbound (sent by the account) messages. These four filters apply to every page, so pass the same values together with cursor. To read one chat, give a target field (a number refers to the no in the most recent list_targets result). from is required when no target field is given. Messages are returned oldest first (chronological) within the window. Results come in pages of up to 200 (limit above 200 is clamped to 200). When hasMore is true, call again with the same filters and cursor set to nextCursor until hasMore is false; process the messages page by page. Never report a time window as empty or complete unless the last page returned hasMore=false.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        target: { type: 'string', description: 'Target conversation title, chatId, speaker displayName, or senderId. Omit to read all chats.' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        chatId: { type: 'string' },
        conversationTitle: { type: 'string' },
        senderId: { type: 'string' },
        senderName: { type: 'string' },
        text: { type: 'string' },
        from: { type: 'string', description: 'Start timestamp (ISO-8601 with offset or YYYY-MM-DD). YYYY-MM-DD starts at 00:00:00.000 Taiwan time (Asia/Taipei).' },
        to: { type: 'string', description: 'End timestamp (ISO-8601 with offset or YYYY-MM-DD). YYYY-MM-DD ends at 23:59:59.999 Taiwan time (Asia/Taipei).' },
        ...MESSAGE_FILTER_JSON_PROPERTIES,
        limit: { type: 'integer', minimum: 1, default: 50, description: 'Page size; values above 200 are clamped to 200.' },
        cursor: { type: 'string', maxLength: 512, description: 'nextCursor from the previous page of the same query.' },
      },
    },
  },
  {
    name: 'list_active_chats',
    description:
      'List the chats that have messages in a [from, to] time window, with the message count, the number of different senders and the time of the newest message of each chat. It returns no message text. Use this tool first to see which chats have new messages and how many, and then read only the chats that you need with query_target_messages_by_time (give chatId, and accountId when needed). from is required; to is optional (ISO-8601 datetime with offset or YYYY-MM-DD; YYYY-MM-DD is a full day in Taiwan time, Asia/Taipei, UTC+08:00). The counts are the messages that query_target_messages_by_time returns for the same window and the same filters, so excludeChatIds, direction, kinds and excludeKinds work the same way. Chats are sorted by the newest message first. limit defaults to 200 and values above 500 are clamped to 500; when truncated is true, more chats exist than were returned, so narrow the window or the filters.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Start timestamp (ISO-8601 with offset or YYYY-MM-DD). YYYY-MM-DD starts at 00:00:00.000 Taiwan time (Asia/Taipei).' },
        to: { type: 'string', description: 'End timestamp (ISO-8601 with offset or YYYY-MM-DD). YYYY-MM-DD ends at 23:59:59.999 Taiwan time (Asia/Taipei).' },
        accountId: { type: 'string' },
        chatType: { type: 'string', enum: ChatTypeSchema.options },
        ...MESSAGE_FILTER_JSON_PROPERTIES,
        limit: { type: 'integer', minimum: 1, default: MCP_ACTIVE_CHATS_DEFAULT_LIMIT, description: 'Maximum chats returned; values above 500 are clamped to 500.' },
      },
      required: ['from'],
    },
  },
  {
    name: 'list_chat_notes', description: 'List saved Note archives for an explicitly selected conversation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 512 } }, required: ['accountId', 'chatType', 'chatId'] },
  },
  {
    name: 'get_chat_note', description: 'Read one saved Note archive by its stable post ID.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, noteId: { type: 'string' } }, required: ['accountId', 'chatType', 'chatId', 'noteId'] },
  },
  {
    name: 'list_chat_albums', description: 'List saved Album archives for an explicitly selected conversation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { accountId: { type: 'string' }, chatType: { type: 'string', enum: ['direct', 'group', 'room'] }, chatId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 512 } }, required: ['accountId', 'chatType', 'chatId'] },
  },
  {
    name: 'get_chat_album', description: 'Read one saved Album archive by its stable album ID, with bounded photo metadata and image availability. Image bytes are not returned.',
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
    "Read the local Agent room conversation history (the operator's prompts and the Agent's final replies), newest first. Page through results with nextCursor; narrow by keyword (query), provider, or time window (from, to). Each item has an origin: agent_room, or line_admin_direct for the operator's shared 1:1 LINE chat with the Agent. Text is truncated and flagged by promptTruncated / replyTruncated. Query only when earlier context is needed, and prefer a keyword over reading every page.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Case-insensitive keyword matched against prompts and replies.' },
      provider: { type: 'string', enum: ['codex', 'claude'] },
      from: { type: 'string', description: 'Start timestamp (ISO-8601 datetime with offset).' },
      to: { type: 'string', description: 'End timestamp (ISO-8601 datetime with offset).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
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
    'Rows with role primary_admin are the administrator (Primary Admin); a query such as 管理員, 主要管理者, admin or me returns that row first. List the LINE chats the Agent account can send to (direct chats, groups and rooms; communities are never included) whose title, member name or nickname contains the query. Call this first with the name the admin gave. If exactly one target matches, send to it. If more than one matches, reply to the admin with the numbered list (use no), wait for the admin\'s choice in the next message, then send to the chosen target. If none matches, tell the admin. Pass the chosen chatType and chatId to send_to_target.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1, maxLength: 100, description: 'Name to match, case-insensitive substring.' } },
    required: ['query'],
  },
} as const;
export const SEND_TO_TARGET_TOOL_DEFINITION = {
  name: SEND_TO_TARGET_TOOL_NAME,
  description:
    'Send messages to one LINE chat of the Agent account (chatType direct, group or room; never a community). Each item becomes one LINE message, sent in order: {type:"text", text} (up to 5000 characters), {type:"message", accountId, chatType, chatId, messageId} to forward an archived message (use the ids from the query_target_messages results; text, images and files are forwarded), {type:"attachment", attachmentId} to send a stored attachment, or {type:"file", path} to send a file in the authorized workspace (the job workspace for internal calls, the configured Agent workspace for external local calls; jpg, jpeg, png and gif are sent as images, anything else as a file). Images up to 20 MiB, files up to 100 MiB; media cannot be sent to a room chat. At most 10 items per call and 30 per job. Results are returned per item as sent, failed, unknown or skipped; the first failed or unknown item stops the call and later items are skipped. Never repeat an item whose status is unknown: tell the admin instead, because it may have been delivered.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      chatType: { type: 'string', enum: ['direct', 'group', 'room'] },
      chatId: { type: 'string', minLength: 1 },
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
              properties: { type: { const: 'file' }, path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Path inside the authorized Agent workspace.' } } },
          ],
        },
      },
    },
    required: ['chatType', 'chatId', 'items'],
  },
} as const;
const SEND_TOOLS = [LIST_SEND_TARGETS_TOOL_DEFINITION, SEND_TO_TARGET_TOOL_DEFINITION] as const;

/**
 * Local MCP schedule tools. A job started by a schedule cannot mutate schedules.
 */
const RECURRENCE_JSON_SCHEMA = {
  description: 'When to fire. once {at} or once {inMinutes: 1..10080} (a one-time run that many minutes from now; use it for "in 5 minutes" / 5 分鐘後); daily {time}; weekly {days (0=Sunday..6=Saturday), time}; interval {everyMinutes (5..10080), anchorAt}; cron {expression: 5 fields minute hour day-of-month month day-of-week}. time is HH:mm in the schedule timezone; at and anchorAt are ISO-8601 datetimes with offset.',
  oneOf: [
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
  description: 'List scheduled triggers with their next fire time and last outcome. Each schedule has execution (program = Main does all the work, agent = an Agent job does the work) and mayUseLlm (true when a run can start an LLM). By default it returns only active (enabled) schedules. Pass status "all" (or "disabled") when the user asks about disabled or all schedules. Before updating, deleting or re-enabling a schedule that may be disabled, call it with status "all" to get its scheduleId.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { status: { type: 'string', enum: ['active', 'disabled', 'all'], default: 'active', description: 'active = enabled schedules only (default); disabled = disabled schedules only; all = both.' } },
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
      value: { description: 'message.direction: inbound or outbound. message.kind: ' + AGENT_SCHEDULE_MESSAGE_KINDS.join(', ') + '. A string for == and !=, an array (1..100) for in and not_in.',
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
const SCHEDULE_TASK_PROPERTIES = {
  jitterMinutes: { type: 'integer', minimum: 0, maximum: 5, description: 'Random start delay: each run starts a random 0..N minutes (whole seconds) after its scheduled time, never before it, and never past the next occurrence. 0 (default when omitted on create) means no delay. Set it only when the user asks for a random or irregular start time.' },
  targets: { type: 'array', maxItems: 20, items: READ_TARGET_JSON_SCHEMA,
    description: 'Chats the run reads (groups, rooms, direct chats and communities), up to 20 and without duplicates. Only chats the user names in the current request; never one carried over from earlier conversation; leave empty when none is named. Resolve each with list_targets (use its exact accountId, chatType and chatId) and refer to it by title when talking to the user. The local Agent room is not allowed.' },
  task: { description: 'What the run does. custom (default): run the prompt as written. summary {focus?}: per-target summary of the window (topics, decisions, action items, mentions of the admin, unanswered questions); needs targets. keyword_digest {keywords: 1..20}: list messages that match any keyword; needs targets. For summary and keyword_digest the prompt is optional extra instructions. new_messages {messageFilter?, rules?, maxMessagesPerChat?, maxTextChars?, sendWhenEmpty?}: a PROGRAM task; Main reads the new messages of the window itself and lists them (targets empty = every readable chat), and runs an LLM only for chats whose rule says then="llm". Use it for every request to list, forward or filter new messages (never custom). messageFilter keeps only the messages that match (metrics message.direction, message.kind with ops == != in not_in; message.textContains with any_of or none_of). rules (at most 20; for each chat the first rule whose when is true decides, none = list): when is a condition on chat.messageCount, chat.senderCount, chat.textChars, run.messageCount, run.chatCount, run.listedChars (ops > >= < <= == !=; integer value), chat.keywordHits (same ops, plus keywords 1..20), chat.id or chat.type (ops == != in not_in); then is list (send the messages), skip (drop the chat) or llm (an Agent summarizes the chat). A condition is a leaf {metric, op, value} or a group {all:[…]} / {any:[…]} that nests at most 2 levels; a task has at most 50 leaves in messageFilter and rules together. maxMessagesPerChat 1..200 (default 20), maxTextChars 20..2000 (default 200), sendWhenEmpty (default false: nothing is sent when there is nothing to list). Delivery is never record_only. Example: {type:"new_messages", messageFilter:{metric:"message.direction",op:"==",value:"inbound"}, rules:[{when:{metric:"chat.id",op:"==",value:"<chatId>"},then:"skip"},{when:{any:[{metric:"chat.messageCount",op:">",value:20},{metric:"run.listedChars",op:">",value:2000}]},then:"llm"}]}. message {text}: a fixed system message (alarm / reminder / fixed notice) that Main sends by itself at fire time, with NO Agent run; use it for every 提醒我… / 鬧鐘 / 定時通知 request; text is the user\'s wording as-is (1..5000 chars) and may contain {{date}} (YYYY-MM-DD), {{time}} (HH:mm) and {{weekday}} (星期一…星期日), filled in Asia/Taipei; targets, window and prompt are not used and delivery must not be record_only.',
    oneOf: [
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
  window: { description: 'Which messages the run covers, ending at the fire time. since_last_run (default): from the last submitted run (or one recurrence period). lookback {minutes: 5..10080}. Never longer than 7 days.',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'since_last_run' } } },
      { type: 'object', additionalProperties: false, required: ['mode', 'minutes'], properties: { mode: { const: 'lookback' }, minutes: { type: 'integer', minimum: 5, maximum: 10080 } } },
    ] },
  delivery: { description: 'Where the result goes. primary_admin (default; omit delivery): the job sends the final result to the administrator (Primary Admin) by LINE; 我 / 給我 / 傳給我 means the administrator. record_only: nothing is sent, the job reply stays in the schedule run history (Agent tasks only; never for message). line_target {target}: use only when the user names another chat; resolve target with list_send_targets (direct, group or room of the Agent account; never a community).',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'primary_admin' } } },
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'record_only' } } },
      { type: 'object', additionalProperties: false, required: ['mode', 'target'], properties: { mode: { const: 'line_target' }, target: SEND_TARGET_JSON_SCHEMA } },
    ] },
} as const;
export const CREATE_SCHEDULE_TOOL_DEFINITION = {
  name: CREATE_SCHEDULE_TOOL_NAME,
  description: 'Create a scheduled trigger now, without asking the user to confirm fields they did not mention. There are two kinds of schedule. Program: message (a fixed text) and new_messages (list the new messages by rules); Main does all the work and a program schedule uses no LLM, except for chats where a rule selects then="llm". Agent: custom, summary, keyword_digest, for work that needs judgment; every run starts an Agent. A request to list or forward new messages must use new_messages, not custom. A condition such as "too many messages means summarize" is a rule with then="llm". Defaults: results go to the administrator (Primary Admin) by LINE (我 / 給我 means the administrator, so omit delivery); task summary when the user names chats (targets), else custom with the request as prompt and empty targets; window since the last run (pass window {mode: "lookback", minutes} when the user states a range, e.g. 過去 6 小時 = 360); timezone Asia/Taipei; provider of the current job; enabled. For "in 5 minutes" / 5 分鐘後 use recurrence {kind: "once", inMinutes: 5}. Resolve chats yourself with list_targets (communities included) and refer to them by title. Ask a question only when a chat name matches several conversations or the user gave no time at all. After creating, reply with a short summary (target, next run time, range, task, delivery) using nextFireAtTaipei and deliveryLabel from the result, and say the user can ask to change it. For summary and keyword_digest leave prompt empty unless the user gave extra requirements, and never restate source, time, range, output or rules in prompt (the system adds them); a custom prompt is one or two sentences of what to do. At each fire time an unattended job runs in its own new session (never the Agent room). A reminder, alarm or fixed notice (提醒我…) is a message task: pass task {type: "message", text} with the user\'s reminder text as written and no prompt; Main sends it directly with no Agent run. Up to 50 schedules can be enabled. Use targets (and summary or keyword_digest) only for chats the user names in the current request; never carry a chat over from earlier conversation. When the request names no chat, create a custom task whose prompt restates the request and leave targets empty: at each run the Agent chooses the chats to read.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['title', 'recurrence'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', maxLength: 4000, description: 'Required for the custom task: one or two sentences of what to do. For summary and keyword_digest leave it empty unless the user gave extra requirements. Never restate source, time, range, output or rules.' },
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
  description: 'Change a scheduled Agent trigger: any of title, prompt, recurrence, timezone, provider, targets, task, window, delivery, jitterMinutes, or enabled (false pauses it, true resumes it). Returns the updated schedule with nextFireAt.' + ' Set targets only to chats the user names in the current request, never from earlier conversation; a request that names no chat is a custom task with the request as prompt and empty targets.',
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
  description: 'Permanently delete a scheduled Agent trigger and its run history. Confirm with the user first.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['scheduleId'], properties: { scheduleId: { type: 'string' } } },
} as const;
const SCHEDULE_TOOLS = [LIST_SCHEDULES_TOOL_DEFINITION, CREATE_SCHEDULE_TOOL_DEFINITION, UPDATE_SCHEDULE_TOOL_DEFINITION, DELETE_SCHEDULE_TOOL_DEFINITION] as const;
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
  /** Main approval broker behind the internal `request_permission` prompt tool; absent means it is never offered. */
  approvalBroker?: Pick<AgentApprovalBroker, 'request'>;
  /** Agent LINE send behind list_send_targets / send_to_target; absent means the tools are never offered. */
  lineSend?: AgentLineSendHandler;
  /** Scheduled Agent triggers behind list/create/update/delete_schedule; absent means the tools are never offered. */
  schedules?: AgentScheduleToolHandler;
  /** Clock for schedule conveniences such as once.inMinutes (tests). */
  now?: () => Date;
  chatResources?: McpChatResourceReader;
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
  description: 'Internal LINEJS permission prompt for the built-in Agent. Not a user-facing tool.',
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
      const invalid = (error: { issues: ReadonlyArray<{ message: string }> }) =>
        ({ error: { code: 'INVALID_INPUT', message: error.issues[0]?.message ?? 'Invalid input.' } }) as const;
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

  /** External local-client schedule mutation happens after the short audited MCP transaction commits. */
  private async callExternalScheduleTool(toolName: ScheduleToolName, rawArguments: Record<string, unknown>, authorizedAccountIds: readonly string[], signal: AbortSignal): Promise<unknown> {
    const handler = this.options.schedules;
    if (!handler) return { error: { code: 'schedule_not_permitted' } };
    if (!handler.listExternal || !handler.createExternal || !handler.updateExternal || !handler.deleteExternal) return { error: { code: 'schedule_not_permitted' } };
    const invalid = (error: { issues: ReadonlyArray<{ message: string }> }) =>
      ({ error: { code: 'INVALID_INPUT', message: error.issues[0]?.message ?? 'Invalid input.' } });
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
              data: [...MCP_TOOL_DEFINITIONS, ...(this.options.lineSend ? SEND_TOOLS : []), ...(this.options.schedules ? SCHEDULE_TOOLS : [])].filter((def) => !DISABLED_NOTE_TOOLS.has(def.name as McpToolName) && toolScopes.includes(def.name)
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
                if (!parsed.success) throw new McpDomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input.');
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
    const capability = isInternalMcpToken(bearerToken) ? this.internalCapabilities.validate(bearerToken) : null;
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
        const { permissions, roomHistory, lineSend } = await verify();
        await finalCheck(null);
        this.internalCapabilities.observe(capability, 'tools_listed');
        // Listing is only a hint of the current permissions; tools/call re-resolves them and is the authority.
        const tools: Array<McpToolDefinition | typeof AGENT_ROOM_HISTORY_TOOL_DEFINITION | typeof REQUEST_PERMISSION_TOOL_DEFINITION
          | (typeof SEND_TOOLS)[number] | (typeof SCHEDULE_TOOLS)[number]> = allowedTools(permissions);
        if (roomHistory) tools.push(AGENT_ROOM_HISTORY_TOOL_DEFINITION);
        if (lineSend && this.options.lineSend) tools.push(...SEND_TOOLS);
        if (lineSend && this.options.schedules) tools.push(...SCHEDULE_TOOLS);
        if (capability.approval && this.options.approvalBroker) tools.push(REQUEST_PERMISSION_TOOL_DEFINITION);
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
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.internalCapabilities.releaseAll();
    for (const controller of this.activeControllers) controller.abort(new Error('MCP service shutting down'));
    await Promise.allSettled([...this.inFlight]);
    this.externalRequestTimes = [];
  }
}
