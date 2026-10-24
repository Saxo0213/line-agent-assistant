import {
  AGENT_ROOM_HISTORY_TOOL_NAME,
  LIST_SEND_TARGETS_TOOL_NAME,
  SEND_TO_TARGET_TOOL_NAME,
  ChatTypeSchema,
  McpAgentRoomHistoryOutputSchema,
  MCP_TOOL_PERMISSIONS,
  McpToolOutputUnionSchema,
  McpToolInputUnionSchema,
  type EffectivePermissions,
  McpToolNameSchema,
  normalizeMcpTimeBound,
  type ConversationKey,
  type WorkerBinding,
  type McpMessageRecord,
  type McpServerStatus,
  type McpTokenSummary,
  type McpToolInputUnion,
  type McpToolName,
  type McpToolOutputUnion,
  type McpInternalToolName,
  type McpAgentRoomHistoryOutput,
} from '@line-agent/contracts';
import {
  McpDomainError,
  type InternalAgentExecutionContext,
  type McpTokenRepository,
  type MessageRepository,
  queryAgentRoomHistory,
} from '@line-agent/database';
import type { Pool, PoolClient } from 'pg';
import {
  InternalMcpCapabilityRegistry,
  isInternalMcpToken,
  type InternalMcpCapability,
  type InternalMcpObservation,
} from './internal-mcp-capabilities.js';
import type { AgentApprovalBroker } from './agent-approval-broker.js';
import type { AgentLineSendHandler } from './agent-line-send-service.js';
import type { McpChatResourceReader } from './mcp-chat-resource-reader.js';
import type { SafeDiagnostic } from '@line-agent/contracts';

export const MAX_CONCURRENT_MCP_REQUESTS = 8;
export const DEFAULT_MCP_RATE_LIMIT_PER_MINUTE = 60;
const MAX_TRACKED_TOKEN_BUCKETS = 256;
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

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'list_targets',
    description:
      'List authorized LINE conversations and participants grouped by (accountId, chatType, chatId). Present results as a numbered list using no. If the user later answers with a number, use that no from the most recent list_targets result and pass its exact accountId, chatType, and chatId to the query tool.',
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
      'Query archived LINE messages for a specified target (conversation title, chatId, sender displayName, or senderId) within authorized account scopes. A number refers to the no in the most recent list_targets result.',
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
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: 'query_target_messages_by_time',
    description:
      'Query archived LINE messages for a specified target within an explicit [from, to] time window (ISO-8601 datetime or YYYY-MM-DD). A number refers to the no in the most recent list_targets result.',
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
        from: { type: 'string', description: 'Start timestamp (ISO-8601 with offset or YYYY-MM-DD).' },
        to: { type: 'string', description: 'End timestamp (ISO-8601 with offset or YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
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
 * Internal-only LINE send tools (docs/architecture/agent-line-send-2026-10-22.md). Listed and callable only for the
 * Primary Admin's LINE jobs and the desktop operator; tools/call re-checks on every call.
 */
export const LIST_SEND_TARGETS_TOOL_DEFINITION = {
  name: LIST_SEND_TARGETS_TOOL_NAME,
  description:
    'List the LINE chats the Agent account can send to (direct chats, groups and rooms; communities are never included) whose title, member name or nickname contains the query. Call this first with the name the admin gave. If exactly one target matches, send to it. If more than one matches, reply to the admin with the numbered list (use no), wait for the admin\'s choice in the next message, then send to the chosen target. If none matches, tell the admin. Pass the chosen chatType and chatId to send_to_target.',
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
    'Send messages to one LINE chat of the Agent account (chatType direct, group or room; never a community). Each item becomes one LINE message, sent in order: {type:"text", text} (up to 5000 characters), {type:"message", accountId, chatType, chatId, messageId} to forward an archived message (use the ids from the query_target_messages results; text, images and files are forwarded), {type:"attachment", attachmentId} to send a stored attachment, or {type:"file", path} to send a file you made in the job workspace (jpg, jpeg, png and gif are sent as images, anything else as a file). Images up to 20 MiB, files up to 100 MiB; media cannot be sent to a room chat. At most 10 items per call and 30 per job. Results are returned per item as sent, failed, unknown or skipped; the first failed or unknown item stops the call and later items are skipped. Never repeat an item whose status is unknown: tell the admin instead, because it may have been delivered.',
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
              properties: { type: { const: 'file' }, path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Path inside the job workspace.' } } },
          ],
        },
      },
    },
    required: ['chatType', 'chatId', 'items'],
  },
} as const;
const SEND_TOOLS = [LIST_SEND_TARGETS_TOOL_DEFINITION, SEND_TO_TARGET_TOOL_DEFINITION] as const;

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
  private readonly activeControllers = new Set<AbortController>();
  private readonly tokenRateBuckets = new Map<string, number[]>();
  private closing = false;
  readonly internalCapabilities: InternalMcpCapabilityRegistry;

  constructor(private readonly options: McpServiceOptions) {
    this.internalCapabilities = new InternalMcpCapabilityRegistry(options.maxInternalCapabilities, options.onInternalObservation);
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? MAX_CONCURRENT_MCP_REQUESTS;
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_MCP_RATE_LIMIT_PER_MINUTE;
  }

  private track<T>(work: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    if (this.closing) {
      return Promise.reject(new McpDomainError('RATE_LIMITED', 'MCP service is shutting down.'));
    }
    if (this.inFlight.size >= this.maxConcurrentRequests) {
      return Promise.reject(
        new McpDomainError('RATE_LIMITED', 'Maximum concurrent MCP requests exceeded.'),
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason ?? new Error('MCP request cancelled'));
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    this.activeControllers.add(controller);
    const promise = Promise.resolve().then(() => work(controller.signal));
    this.inFlight.add(promise);
    void promise.then(
      () => { this.inFlight.delete(promise); this.activeControllers.delete(controller); parentSignal?.removeEventListener('abort', abort); },
      () => { this.inFlight.delete(promise); this.activeControllers.delete(controller); parentSignal?.removeEventListener('abort', abort); },
    );
    return promise;
  }

  private checkTokenRateLimit(tokenId: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const existing = (this.tokenRateBuckets.get(tokenId) ?? []).filter((ts) => ts > cutoff);
    if (existing.length >= this.rateLimitPerMinute) {
      this.tokenRateBuckets.delete(tokenId);
      this.tokenRateBuckets.set(tokenId, existing);
      return false;
    }
    existing.push(now);
    this.tokenRateBuckets.delete(tokenId);
    this.tokenRateBuckets.set(tokenId, existing);
    while (this.tokenRateBuckets.size > MAX_TRACKED_TOKEN_BUCKETS) {
      const oldestKey = this.tokenRateBuckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.tokenRateBuckets.delete(oldestKey);
    }
    return true;
  }

  async issueToken(input: {
    deviceLabel: string;
    principalId?: string;
    accountScopes: readonly string[];
    toolScopes: readonly McpToolName[];
    expiration: import('@line-agent/contracts').McpTokenExpiration;
  }): Promise<{ token: McpTokenSummary; plaintextToken: string }> {
    return this.options.tokens.issueToken(input);
  }

  async listTokens(): Promise<McpTokenSummary[]> {
    return this.options.tokens.listTokens();
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    this.tokenRateBuckets.delete(tokenId);
    return this.options.tokens.revokeToken(tokenId);
  }

  async getStatus(transport: {
    running: boolean;
    endpoint: string | null;
    host: '127.0.0.1';
    port: number | null;
  }): Promise<McpServerStatus> {
    const activeTokenCount = await this.options.tokens.countActiveTokens();
    return {
      running: transport.running && !this.closing,
      endpoint: transport.endpoint,
      host: '127.0.0.1',
      port: transport.port,
      activeTokenCount,
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
      const targets = numberMcpTargets(listedTargets);
      return {
        output: { toolName: 'list_targets', targets },
        resultCount: targets.length,
      };
    }

    if (tool.name === 'query_target_messages') {
      const rows = await this.options.messages.queryTargetMessages(
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
          ...(tool.arguments.limit ? { limit: tool.arguments.limit } : {}),
        },
        client,
      );
      const messages = redactMessages(rows);
      return {
        output: { toolName: 'query_target_messages', messages },
        resultCount: messages.length,
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
    const rows = await this.options.messages.queryTargetMessages(
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
        ...(tool.arguments.limit ? { limit: tool.arguments.limit } : {}),
      },
      client,
    );
    const messages = redactMessages(rows);
    return {
      output: {
        toolName: 'query_target_messages_by_time',
        messages,
        from: normalizedFrom,
        to: normalizedTo,
      },
      resultCount: messages.length,
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
          execute: async ({ client }) => {
            const output = await handler.listTargets(client, rawArguments);
            return { data: output, resultCount: output.targets.length };
          },
        }), signal) };
      }
      const outcome = await this.track(() => this.options.tokens.executeForInternalAgent({
        context, toolName, signal,
        execute: async ({ client, principalId }) => {
          const authorized = await handler.authorize(client, { jobId: capability.jobId, principalId, rawInput: rawArguments });
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
    bearerToken: string | null,
    rawPayload: unknown,
    parentSignal?: AbortSignal,
  ): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
    const diagnosticIdentity = { correlationId: crypto.randomUUID() };
    return this.track(async (signal) => {
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

      const tokenString = bearerToken?.trim() ?? '';

      try {
        if (rpc.method === 'initialize') {
          await this.options.tokens.executeWithVerifiedToken({
            bearerToken: tokenString,
            toolName: null,
            signal,
            rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
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
          await this.options.tokens.executeWithVerifiedToken({
            bearerToken: tokenString,
            toolName: null,
            signal,
            rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
            execute: async () => ({ data: true }),
          });
          return { httpStatus: 202, body: null };
        }

        if (rpc.method === 'ping') {
          await this.options.tokens.executeWithVerifiedToken({
            bearerToken: tokenString,
            toolName: null,
            signal,
            rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
            execute: async () => ({ data: true }),
          });
          return {
            httpStatus: 200,
            body: { jsonrpc: '2.0', id, result: {} },
          };
        }

        if (rpc.method === 'tools/list') {
          const tools = await this.options.tokens.executeWithVerifiedToken({
            bearerToken: tokenString,
            toolName: null,
            signal,
            rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
            execute: async ({ toolScopes }) => ({
              data: MCP_TOOL_DEFINITIONS.filter((def) => toolScopes.includes(def.name)
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
          const toolNameCheck = McpToolNameSchema.safeParse(params.name);
          if (!toolNameCheck.success) {
            await this.options.tokens.executeWithVerifiedToken({
              bearerToken: tokenString,
              toolName: null,
              signal,
              rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
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

          // Verify token, tool scope, and account scope first, then validate arguments and execute
          const output = await this.options.tokens.executeWithVerifiedToken({
            bearerToken: tokenString,
            toolName,
            signal,
            ...(requestedAccountId ? { requestedAccountId } : {}),
            rateLimiter: (tokenId) => this.checkTokenRateLimit(tokenId),
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
          | (typeof SEND_TOOLS)[number]> = allowedTools(permissions);
        if (roomHistory) tools.push(AGENT_ROOM_HISTORY_TOOL_DEFINITION);
        if (lineSend && this.options.lineSend) tools.push(...SEND_TOOLS);
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
    this.tokenRateBuckets.clear();
  }
}
