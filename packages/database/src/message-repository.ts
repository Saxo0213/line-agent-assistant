import { createHash, randomUUID } from 'node:crypto';
import { InboundEnvelopeSchema, normalizeMentionRanges, ReadReceiptSchema, type ReadReceiptDto, TalkCursorV1Schema, type MessageContent, type AgentProvider, type ConversationKey, type InboundEnvelope, type JsonValue, type LineWorkerEvent, type McpActiveChat, type McpMessageRecord, type McpTargetSummary, type MessageSearchScope, type MentionRange, type TalkCursorV1Dto } from '@line-agent/contracts';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { parseLineStickerDescriptor, type StickerDescriptor } from './sticker-descriptor.js';
import { CONVERSATION_TITLE_SQL, MEMBER_NAME_SQL, NAME_RESOLUTION_GROUP_COLUMNS, nameFragments, ownMessageSql, PEER_CONTACT_JOIN, SENDER_CONTACT_JOIN, SENDER_NAME_SQL, upsertLineContacts, type LineContactInput } from './name-resolution.js';
import { NativeSourceEnvelopeSchema, type NativeSourceEnvelope } from '@line-agent/contracts';
import { ATTACHMENT_BLOCK_REASONS, isAttachmentBlockReason, type AttachmentBlockReason } from '@line-agent/contracts';
import { bridgeLiveMessage, liveChatEventMids, postNotificationSubtypeFromRaw } from './content-bridge/index.js';
import { loadChatEventNames } from './content-bridge/chat-event-names.js';
import { nativeReactions, type MessageReaction } from './native-reactions.js';
import { ensureLineageSessionRow, expandAgentLineage, mergeLineageConversations, resolveAgentLineage } from './agent-lineage.js';
import { promptWithContactCards } from './agent-contact-cards.js';
import { stageSystemLoginObservation, type ExternalObservation } from './external-monitor-repository.js';

export type ReadPositionChange = Readonly<{ key: ConversationKey; messageId: string }>;
const ReadReceiptsSchema = ReadReceiptSchema.array().max(500);

/** Upper bound for a stored pre-recall native envelope returned to the desktop timeline. */
const RECALL_ORIGINAL_MAX_BYTES = 262144;
export type TimelineMessageRecord = MessageListResult & { sourceDeleted: boolean; recallOriginal: NativeSourceEnvelope | null };
function parseRecallOriginal(value: unknown): NativeSourceEnvelope | null {
  if (value === null || value === undefined) return null;
  const parsed = NativeSourceEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}


import { lockAndCheckAgentAuthorization, type AgentAdmissionAuthorization } from './agent-authorization.js';
export type { AgentAdmissionAuthorization };

/** Layer 2 at insert time: content, rule version and reply id bridged from the live raw inside the insert transaction. */
function liveProjectionValues(envelope: InboundEnvelope): [string | null, number, string | null] {
  const bridged = bridgeLiveMessage({ raw: envelope.raw, contact: envelope.contact });
  return [bridged?.content ? JSON.stringify(bridged.content) : null, bridged?.version ?? 0,
    bridged?.replyToMessageId ?? envelope.replyToMessageId];
}

function systemLoginObservation(envelope: InboundEnvelope, receipt?: { controlEpoch: number;
  receiptMode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; sensitive: boolean }): ExternalObservation {
  return { observationId: envelope.messageId, canonicalMessageId: envelope.messageId,
    nativeConversationKind: envelope.chatType, nativeConversationId: envelope.chatId, nativeMessageId: envelope.messageId,
    chatType: envelope.chatType, chatId: envelope.chatId, senderId: envelope.senderId,
    livePayload: { raw: envelope.raw, eventId: envelope.eventId, ...(envelope.contact ? { contact: envelope.contact } : {}),
      ...(receipt && envelope.ingestion.source === 'live' ? { recovery: { envelope, ...receipt } } : {}) },
    mentionIds: envelope.mentionIds, mentionRanges: envelope.mentionRanges,
    attachments: envelope.attachments.map((item) => ({ ...item, expiresAt: null })),
    kind: envelope.kind, text: envelope.text, occurredAt: envelope.occurredAt };
}

export type RoutingDecision =
  | { eligible: false; action?: 'ignore' | 'stop' | 'new' | 'status'; primaryAdminSenderId?: string }
  | { eligible: false; workspaceFailure: { provider: AgentProvider; prompt: string; workspacePath: string | null;
      code: 'INVALID_WORKSPACE'; reason: string }; authorization?: AgentAdmissionAuthorization; primaryAdminSenderId?: string }
  | { eligible: true; provider: AgentProvider; prompt: string; workspacePath: string;
      authorization?: AgentAdmissionAuthorization; primaryAdminSenderId?: string };

export type PendingRouteAction = 'stop' | 'new' | 'status';
export type PendingRoute = { key: ConversationKey; messageId: string };
export type UnroutedLiveSourceMessage = Readonly<{ observationId: string; envelope: InboundEnvelope | null; receiptMode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; receiptControlEpoch: number; sensitive: boolean }>;

export interface IngestResult {
  disposition: 'inserted' | 'duplicate';
  durableCursor: string | null;
  messageChanged?: boolean;
  jobId?: string;
  jobStatus?: { accountId: string; chatType: ConversationKey['chatType']; chatId: string; sourceMessageId: string; jobId: string; status: 'queued' | 'failed'; revision: string };
}

export interface MessageSearchQuery {
  key?: ConversationKey;
  accountId?: string;
  /** Takes precedence over accountId; 'agent' spans every account in the Agent lineage. */
  scope?: MessageSearchScope;
  senderId?: string;
  text?: string;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  attachmentKind?: Attachment['kind'];
  limit: number;
}

export interface MessageSearchResult {
  accountId: string;
  chatType: ConversationKey['chatType'];
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string | null;
  isOwn?: boolean;
  conversationTitle?: string | null;
  text: string | null;
  occurredAt: string;
  /** 'agent' when the source account belongs to the Agent lineage (current or former). */
  lineage?: 'agent' | null;
}

export type MessageListResult = MessageSearchResult & {
  kind: InboundEnvelope['kind'];
  content: MessageContent | null;
  sticker: StickerDescriptor | null;
  mentionRanges: MentionRange[];
  /** Readers whose position covers this own message (direct/group/room); absent when not applicable or 0. */
  readCount?: number;
  /** Reactions derived from raw.native.row._reactionStatus; absent when the message has none. */
  reactions?: Array<MessageReaction & { reactorNames: string[] }>;
};

export interface MessageReaderRecord { mid: string; name: string; readAt: string }

const NUMERIC_ID_SQL = (col: string): string => `(CASE WHEN ${col} ~ '^[0-9]{1,20}$' THEN ${col}::numeric END)`;

export interface Attachment {
  attachmentId: string;
  externalAttachmentId: string;
  accountId: string;
  chatType: ConversationKey['chatType'];
  chatId: string;
  messageId: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  name: string | null;
  mimeType: string | null;
  status: 'queued' | 'downloading' | 'ready' | 'failed' | 'expired';
  relativePath: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  occurredAt: string;
  retryCount: number;
  retryAfter: string | null;
  createdAt: string;
  expiresAt: string | null;
  updatedAt: string;
  lineMessage: JsonValue;
  externalSource: boolean;
  nativePayload?: NativeSourceEnvelope;
}

/** Display-only attachment name fallback; provider and database IDs are never labels. */
export const ATTACHMENT_DISPLAY_NAME_SQL = `COALESCE(NULLIF(BTRIM(a.name), ''), CASE a.kind
  WHEN 'image' THEN '圖片' WHEN 'video' THEN '影片' WHEN 'audio' THEN '語音' ELSE '檔案' END)`;

export type AttachmentPriorState = Pick<Attachment, 'status' | 'retryCount' | 'retryAfter' | 'expiresAt' | 'error'>;

export type AttachmentMutation = ConversationKey & {
  attachmentId: string;
  workerInstanceId: string;
  controlEpoch: number;
};

export type AttachmentAttemptMutation = Omit<AttachmentMutation, 'controlEpoch'> & { attemptToken: string; ownerId: string };

export type AttachmentActivityRecord = {
  accountId: string; chatType: ConversationKey['chatType']; chatId: string;
  kind: Attachment['kind']; status: Attachment['status']; retryCount: number; updatedAt: string;
};
export type AttachmentStateRecord = {
  attachmentId: string; messageId: string; kind: Attachment['kind']; name: string; mimeType: string;
  sizeBytes: number; status: Attachment['status']; canRetryManually: boolean;
  /** Why a queued attachment cannot download now. It is absent when the row has no block reason. */
  blockReason?: AttachmentBlockReason;
};
export type TerminalAttachmentErrorRecord = Pick<AttachmentActivityRecord, 'accountId' | 'chatType' | 'chatId' | 'kind' | 'status' | 'retryCount' | 'updatedAt'>;

export type ConversationCatalogEntry = Readonly<{
  chatType: ConversationKey['chatType'];
  chatId: string;
  title: string;
  picturePath?: string | null;
  members: readonly Readonly<{ memberId: string; displayName: string | null; nickname?: string | null; picturePath?: string | null }>[];
}>;

/** Agent/MCP-visible messages hide recalled and source-deleted content in projections and in every filter predicate. */
const AGENT_MASKED_SQL = "(m.content->>'type' = 'unsent' OR m.raw ? 'sourceDeleted')";
const AGENT_VISIBLE_TEXT_SQL = `CASE WHEN ${AGENT_MASKED_SQL} THEN NULL ELSE m.text_content END`;

/** The direction of a stored message as an MCP record reports it; the direction filter compares against this same expression. */
const MESSAGE_DIRECTION_SQL = `CASE WHEN ${ownMessageSql('m', 'la')} THEN 'outbound' ELSE 'inbound' END`;

/** SQL placeholders (such as '$1') for the visibility rules that every MCP message read shares. */
interface MessageScopePlaceholders {
  accountIds: string;
  scopeAccountIds: string;
  scopeChatType: string;
  scopeChatId: string;
  extraScopes: string;
  lineageOrder: string;
}

/**
 * Which stored messages an MCP principal may see (alias m): authorized accounts, local Agent room excluded, conversation scope
 * with linked chats, and one copy of each message across the Agent lineage. queryTargetMessageRows and listActiveChats both embed
 * this fragment so that their row sets cannot differ.
 */
function messageScopeWhereSql(p: MessageScopePlaceholders): string {
  return `m.account_id = ANY(${p.accountIds}::text[])
         AND (m.kind <> 'event' OR m.content IS NOT NULL)
         AND m.chat_id <> '__local_agent_room__'
         AND (${p.scopeAccountIds}::text[] IS NULL OR (m.account_id = ANY(${p.scopeAccountIds}::text[]) AND m.chat_type = ${p.scopeChatType} AND m.chat_id = ${p.scopeChatId})
           OR EXISTS (SELECT 1 FROM jsonb_to_recordset(${p.extraScopes}::jsonb) AS x(chat_type text, chat_id text)
                      WHERE m.account_id = ANY(${p.scopeAccountIds}::text[]) AND x.chat_type = m.chat_type AND x.chat_id = m.chat_id))
         AND (cardinality(${p.lineageOrder}::text[]) = 0 OR NOT EXISTS (
           SELECT 1 FROM messages m2 WHERE m2.account_id = ANY(${p.accountIds}::text[]) AND m2.chat_type = m.chat_type AND m2.chat_id = m.chat_id
             AND m2.message_id = m.message_id
             AND array_position(${p.lineageOrder}::text[], m2.account_id) < array_position(${p.lineageOrder}::text[], m.account_id)))`;
}

/** Values for MessageScopePlaceholders, in the order scopeAccountIds, scopeChatType, scopeChatId, extraScopes, lineageOrder. */
function messageScopeValues(
  lineage: { scopeAccountIds: string[] | null; order: string[] },
  input: { conversationScope?: ConversationKey; extraConversationScopes?: readonly Pick<ConversationKey, 'chatType' | 'chatId'>[] },
): [string[] | null, string | null, string | null, string, string[]] {
  return [
    lineage.scopeAccountIds,
    input.conversationScope?.chatType ?? null,
    input.conversationScope?.chatId ?? null,
    JSON.stringify((input.extraConversationScopes ?? []).map((scope) => ({ chat_type: scope.chatType, chat_id: scope.chatId }))),
    lineage.order,
  ];
}

interface MessageFilterPlaceholders {
  chatType: string;
  from: string;
  to: string;
  excludeChatIds: string;
  direction: string;
  kinds: string;
  excludeKinds: string;
}

/** Filters shared by query_target_messages_by_time and list_active_chats (aliases m, la). A null value turns a filter off. */
function messageFilterWhereSql(p: MessageFilterPlaceholders): string {
  return `(${p.chatType}::text IS NULL OR m.chat_type = ${p.chatType})
         AND (${p.from}::timestamptz IS NULL OR m.occurred_at >= ${p.from}::timestamptz)
         AND (${p.to}::timestamptz IS NULL OR m.occurred_at <= ${p.to}::timestamptz)
         AND (${p.excludeChatIds}::text[] IS NULL OR NOT (m.chat_id = ANY(${p.excludeChatIds}::text[])))
         AND (${p.direction}::text IS NULL OR ${MESSAGE_DIRECTION_SQL} = ${p.direction}::text)
         AND (${p.kinds}::text[] IS NULL OR m.kind = ANY(${p.kinds}::text[]))
         AND (${p.excludeKinds}::text[] IS NULL OR NOT (m.kind = ANY(${p.excludeKinds}::text[])))`;
}

/** Optional filters of the by-time read; arrays that are absent or empty are off. */
interface MessageFilterInput {
  excludeChatIds?: readonly string[];
  direction?: McpMessageRecord['direction'];
  kinds?: readonly McpMessageRecord['kind'][];
  excludeKinds?: readonly McpMessageRecord['kind'][];
}

/** Values for MessageFilterPlaceholders after chatType/from/to: excludeChatIds, direction, kinds, excludeKinds. */
function messageFilterValues(input: MessageFilterInput): [string[] | null, string | null, string[] | null, string[] | null] {
  const list = <T extends string>(values: readonly T[] | undefined): T[] | null => (values && values.length > 0 ? [...values] : null);
  return [list(input.excludeChatIds), input.direction ?? null, list(input.kinds), list(input.excludeKinds)];
}

/** Chat types the Agent may send to. Community and thread are never writable. */
export const SEND_CHAT_TYPES = ['direct', 'group', 'room'] as const;
export type SendChatType = (typeof SEND_CHAT_TYPES)[number];
/** Attachment status that means the file is stored on disk (what markAttachmentReady writes). */
export const ATTACHMENT_STORED_STATUS = 'ready' as const;

export type SendTargetRecord = Readonly<{
  no: number; chatType: SendChatType; chatId: string; title: string | null; members: string[]; memberCount: number;
}>;
export type SendAttachment = Readonly<{
  attachmentId: string; accountId: string; kind: Attachment['kind']; name: string | null; status: Attachment['status'];
  relativePath: string | null; sha256: string | null; sizeBytes: number | null;
}>;
export type SendSourceMessage = Readonly<{ kind: string; text: string | null; masked: boolean; attachments: SendAttachment[] }>;
export type LineSendAuditRow = Readonly<{
  jobId: string; accountId: string; principalId: string; chatType: SendChatType; chatId: string; itemIndex: number;
  itemKind: 'text' | 'message' | 'attachment' | 'file'; byteSize: number; status: 'sent' | 'failed' | 'unknown' | 'denied'; errorCode?: string | null;
}>;
type SendAttachmentRow = {
  attachment_id: string; account_id: string; kind: Attachment['kind']; name: string | null; status: Attachment['status'];
  relative_path: string | null; sha256: string | null; size_bytes: string | null;
};
const toSendAttachment = (row: SendAttachmentRow): SendAttachment => ({
  attachmentId: row.attachment_id, accountId: row.account_id, kind: row.kind, name: row.name, status: row.status, relativePath: row.relative_path,
  sha256: row.sha256, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
});

export class MessageRepository {
  private pendingAttachmentConnections = 0;
  private readonly pendingReadFences = new Set<Promise<void>>();
  private static readonly MAX_PENDING_ATTACHMENT_CONNECTIONS = 4;
  constructor(private readonly pool: Pool) {}

  private async boundedRead<T extends QueryResultRow>(query: string, values: unknown[] = []): Promise<QueryResult<T>> {
    let client: PoolClient | undefined;
    let timedOut = false;
    let acquired = false;
    let released = false;
    const release = (destroy = false) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    const acquisition = this.pool.connect().then((value) => {
      acquired = true;
      client = value;
      if (timedOut) { release(true); throw new Error('ATTACHMENT_READ_TIMEOUT'); }
      return value;
    });
    let read!: Promise<QueryResult<T>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        release(true);
        const fence = read.then(() => undefined, () => undefined);
        this.pendingReadFences.add(fence);
        void fence.then(() => this.pendingReadFences.delete(fence));
        reject(new Error('ATTACHMENT_READ_TIMEOUT'));
      }, 2000);
    });
    read = (async () => {
      const connection = await acquisition;
      try {
        await connection.query('BEGIN READ ONLY');
        await connection.query("SET LOCAL statement_timeout = '2000ms'");
        const result = await connection.query<T>(query, values);
        if (timedOut) throw new Error('ATTACHMENT_READ_TIMEOUT');
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        if (!timedOut) await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { release(timedOut); }
    })();
    try { return await Promise.race([read, deadline]); }
    finally {
      if (timer) clearTimeout(timer);
      if (!acquired) void acquisition.then(() => release(true), () => undefined);
    }
  }

  async waitForReadDrain(): Promise<void> { await Promise.all([...this.pendingReadFences]); }

  private async withAttachmentTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.pendingAttachmentConnections >= MessageRepository.MAX_PENDING_ATTACHMENT_CONNECTIONS) {
      throw new Error('Attachment database connection admission limit exceeded');
    }
    this.pendingAttachmentConnections += 1;
    let client: PoolClient | undefined;
    let released = false;
    let timedOut = false;
    const release = (destroy: boolean) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    const acquisition = this.pool.connect().then((acquired) => {
      this.pendingAttachmentConnections -= 1;
      client = acquired;
      if (timedOut) release(true);
      return acquired;
    }, (error: unknown) => {
      this.pendingAttachmentConnections -= 1;
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline!: (error: Error) => void;
    const deadlineError = new Error('Attachment database transaction deadline exceeded');
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    timer = setTimeout(() => {
      timedOut = true;
      release(true);
      rejectDeadline(deadlineError);
    }, 500);
    const run = async (): Promise<T> => {
      const connection = await acquisition;
      const ensureActive = () => { if (timedOut) throw deadlineError; };
      ensureActive();
      try {
        await connection.query('BEGIN'); ensureActive();
        await connection.query("SET LOCAL statement_timeout = '500ms'"); ensureActive();
        await connection.query("SET LOCAL lock_timeout = '400ms'"); ensureActive();
        const result = await operation(connection); ensureActive();
        await connection.query('COMMIT'); ensureActive();
        return result;
      } catch (error) {
        if (!timedOut) await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    };
    try { return await Promise.race([run(), deadline]); }
    finally {
      if (timer) clearTimeout(timer);
      release(timedOut);
    }
  }

  async upsertConversationCatalog(accountId: string, conversations: readonly ConversationCatalogEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const contacts = new Map<string, LineContactInput>();
      for (const conversation of conversations) {
        await client.query(
          `INSERT INTO conversations(account_id,chat_type,chat_id,title,picture_path) VALUES($1,$2,$3,$4,$6)
           ON CONFLICT (account_id,chat_type,chat_id) DO UPDATE SET
             title=CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE conversations.title END,
             picture_path=CASE WHEN $5::boolean THEN EXCLUDED.picture_path ELSE conversations.picture_path END, updated_at=now()`,
          [accountId, conversation.chatType, conversation.chatId, conversation.title,
            conversation.picturePath !== undefined, conversation.picturePath ?? null],
        );
        for (const member of conversation.members) contacts.set(member.memberId, {
          mid: member.memberId, displayName: member.displayName, ...(member.nickname === undefined ? {} : { nickname: member.nickname }) });
        for (const member of conversation.members) await client.query(
          `INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id,display_name,picture_path) VALUES($1,$2,$3,$4,$5,$7)
           ON CONFLICT(account_id,chat_type,chat_id,member_id) DO UPDATE SET
             display_name=COALESCE(EXCLUDED.display_name,conversation_members.display_name),
             picture_path=CASE WHEN $6::boolean THEN EXCLUDED.picture_path ELSE conversation_members.picture_path END,updated_at=now()`,
          [accountId, conversation.chatType, conversation.chatId, member.memberId, member.displayName,
            member.picturePath !== undefined, member.picturePath ?? null],
        );
      }
      // The same per-account contact store the native directory pass writes (source neutrality).
      await upsertLineContacts(client, accountId, [...contacts.values()]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async getLiveCursor(accountId: string, signal?: AbortSignal): Promise<TalkCursorV1Dto | null> {
    if (signal?.aborted) throw new Error('Live cursor lookup cancelled');
    const result = await this.pool.query<{ cursor: string }>(
      "SELECT cursor FROM sync_cursors WHERE account_id = $1 AND source = 'live'", [accountId]);
    if (signal?.aborted) throw new Error('Live cursor lookup cancelled');
    return result.rows[0]?.cursor ? TalkCursorV1Schema.parse(JSON.parse(result.rows[0].cursor)) : null;
  }

  async prepareBatchConversations(batch: Extract<LineWorkerEvent, { type: 'batch' }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton=true FOR SHARE');
      const account = await client.query<{ mode: string; worker_instance_id: string | null; worker_binding_epoch: string | null;
        connection_mode: string; own_mid: string | null; selected_source_id: string | null; selected_source_generation: string | null;
        source_type: string | null; source_state: string | null; verified_account_mid: string | null }>(
        `SELECT a.mode,a.worker_instance_id,a.worker_binding_epoch,a.connection_mode,a.own_mid,a.selected_source_id,
          a.selected_source_generation,s.source_type,s.state AS source_state,s.verified_account_mid
         FROM line_accounts a LEFT JOIN line_account_sources s ON s.account_id=a.account_id
           AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR SHARE OF a`, [batch.accountId]);
      const row = account.rows[0];
      if (row?.connection_mode === 'EXTERNAL_MONITOR') throw new Error('External monitor is read-only');
      if (!row || row.worker_instance_id !== batch.workerInstanceId || Number(row.worker_binding_epoch) !== batch.controlEpoch
        || batch.controlEpoch > Number(control.rows[0]?.control_epoch)
        || (row.mode === 'ACTIVE_CONTROL' && batch.controlEpoch !== Number(control.rows[0]?.control_epoch))) throw new Error('Stale batch control epoch');
      if (row.connection_mode !== 'SYSTEM_LOGIN' || !row.selected_source_id || row.source_type !== 'SYSTEM_LOGIN'
        || row.source_state !== 'ACTIVE' || row.own_mid !== row.verified_account_mid) throw new Error('Stale login batch authority');
      for (const envelope of batch.envelopes) {
        if (envelope.accountId !== batch.accountId) throw new Error('Batch envelope account mismatch');
        await client.query(`INSERT INTO conversations(account_id,chat_type,chat_id) VALUES($1,$2,$3)
          ON CONFLICT(account_id,chat_type,chat_id) DO NOTHING`, [batch.accountId,envelope.chatType,envelope.chatId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** Compatibility entry point for existing repository callers and test doubles. */
  async ingestBatchAndRoute(batch: Extract<LineWorkerEvent, { type: 'batch' }>, decisions: readonly RoutingDecision[]) {
    if (batch.envelopes.length !== decisions.length) throw new Error('One routing decision is required per envelope');
    await this.prepareBatchConversations(batch);
    const stored = await this.ingestBatchSource(batch);
    const admitted = await this.admitLiveBatch(batch, decisions);
    await this.recordBatchRoutes(batch, admitted.routeDecisions, new Set(admitted.jobStatuses.map((status) => status.sourceMessageId)));
    return { ...stored, ...admitted };
  }

  async ingestBatchSource(
    batch: Extract<LineWorkerEvent, { type: 'batch' }>,
    sensitiveMessageIds: ReadonlySet<string> = new Set(),
  ): Promise<{ inserted: number; duplicate: number; insertedMessageIds: string[]; changedMessageIds: string[]; jobIds: string[]; jobMessageIds: string[]; primaryAdminActionMessageIds: string[]; jobStatuses: NonNullable<IngestResult['jobStatus']>[];
    readPositionsChanged: number; readPositionChanges: ReadPositionChange[] }> {
    const readReceipts = ReadReceiptsSchema.parse(batch.readReceipts ?? []);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>(
        'SELECT control_epoch FROM account_control WHERE singleton = true FOR SHARE',
      );
      const authority = await client.query<{ mode: string; worker_instance_id: string | null; worker_binding_epoch: string | null;
        connection_mode: string; own_mid: string | null; selected_source_id: string | null; selected_source_generation: string | null;
        source_type: string | null; source_state: string | null; verified_account_mid: string | null }>(
        `SELECT a.mode,a.worker_instance_id,a.worker_binding_epoch,a.connection_mode,a.own_mid,a.selected_source_id,
          a.selected_source_generation,s.source_type,s.state AS source_state,s.verified_account_mid
         FROM line_accounts a LEFT JOIN line_account_sources s ON s.account_id=a.account_id
           AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR SHARE OF a`, [batch.accountId],
      );
      const account = authority.rows[0];
      if (!account || account.worker_instance_id !== batch.workerInstanceId
        || Number(account.worker_binding_epoch) !== batch.controlEpoch
        || batch.controlEpoch > Number(control.rows[0]?.control_epoch)
        || (account.mode === 'ACTIVE_CONTROL' && batch.controlEpoch !== Number(control.rows[0]?.control_epoch))) {
        throw new Error('Stale batch control epoch');
      }
      if (account.connection_mode === 'EXTERNAL_MONITOR') {
        throw new Error('External monitor is read-only');
      }
      if (account.connection_mode !== 'SYSTEM_LOGIN' || !account.selected_source_id
        || account.source_type !== 'SYSTEM_LOGIN' || account.source_state !== 'ACTIVE'
        || account.own_mid !== account.verified_account_mid || !account.selected_source_generation) {
        throw new Error('Logged-in source authority is stale');
      }
      const sourceId = account.selected_source_id;
      const sourceGeneration = Number(account.selected_source_generation);
      if (!['ACTIVE_CONTROL', 'MONITOR_ONLY', 'PAUSED'].includes(account.mode)) throw new Error('Invalid login receipt mode');
      const receiptMode = account.mode as 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED';
      const batchDigest = createHash('sha256').update(JSON.stringify({ cursorBefore: batch.cursorBefore,
        cursorAfter: batch.cursorAfter, envelopes: batch.envelopes, readReceipts }), 'utf8').digest('hex');
      const priorSourceBatch = await client.query<{ payload_digest: string }>(
        'SELECT payload_digest FROM external_source_batches WHERE source_id=$1 AND generation=$2 AND batch_id=$3 FOR UPDATE',
        [sourceId, sourceGeneration, batch.batchId]);
      if (priorSourceBatch.rows[0] && priorSourceBatch.rows[0].payload_digest !== batchDigest) {
        throw new Error('Login source batch replay digest mismatch');
      }
      const sourceBatchReplay = Boolean(priorSourceBatch.rows[0]);
      if (!sourceBatchReplay) {
        const checkpoint = await client.query<{ cursor: TalkCursorV1Dto }>(
          'SELECT cursor FROM external_source_checkpoints WHERE source_id=$1 AND account_id=$2 AND generation=$3 FOR UPDATE',
          [sourceId, batch.accountId, sourceGeneration]);
        const currentCursor = checkpoint.rows[0]?.cursor;
        if (!currentCursor || currentCursor.revision !== batch.cursorBefore.revision
          || currentCursor.globalRev !== batch.cursorBefore.globalRev || currentCursor.individualRev !== batch.cursorBefore.individualRev) {
          throw new Error('Login source predecessor checkpoint mismatch');
        }
        await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
          VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
        [sourceId, batch.accountId, sourceGeneration, batch.batchId, batchDigest]);
      }
      let inserted = 0;
      let duplicate = 0;
      const insertedMessageIds: string[] = [];
      const changedMessageIds: string[] = [];
      const jobIds: string[] = [];
      const jobMessageIds: string[] = [];
      for (const [index, envelope] of batch.envelopes.entries()) {
        if (envelope.accountId !== batch.accountId) throw new Error('Batch envelope account mismatch');
        const staged = sourceBatchReplay ? { changed: false, conflict: false } : await stageSystemLoginObservation(client, {
          accountId: batch.accountId, sourceId, generation: sourceGeneration, batchId: batch.batchId,
          origin: envelope.ingestion.source === 'live' ? 'SYSTEM_LOGIN_LIVE' : 'SYSTEM_LOGIN_HISTORY',
          captureCanonicalExistence: true,
          observation: systemLoginObservation(envelope, { controlEpoch: batch.controlEpoch, receiptMode,
            sensitive: sensitiveMessageIds.has(envelope.messageId) }),
        });
        if (staged.conflict) throw new Error('Login source observation ID was reused with changed identity');
        const existed = sourceBatchReplay || staged.canonicalExisted === true;
        if (existed) {
          duplicate++;
          if (staged.changed) changedMessageIds.push(envelope.messageId);
          continue;
        }
        inserted++;
        insertedMessageIds.push(envelope.messageId);
        if (staged.changed) changedMessageIds.push(envelope.messageId);
        if (envelope.ingestion.source === 'live' && envelope.kind !== 'event') await client.query(
          `UPDATE conversations c SET unread_count=unread_count+1, updated_at=now()
           WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3 AND EXISTS
             (SELECT 1 FROM line_accounts la WHERE la.account_id=$1 AND la.own_mid IS DISTINCT FROM $4)`,
          [envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId]);
      }
      const { readPositionsChanged, readPositionChanges } = await this.upsertReadPositions(client, batch.accountId, readReceipts);
      const source = 'live';
      const previous = await client.query<{ cursor: string }>(
        'SELECT cursor FROM sync_cursors WHERE account_id = $1 AND source = $2 FOR UPDATE', [batch.accountId, source],
      );
      const prior = previous.rows[0]?.cursor ? JSON.parse(previous.rows[0].cursor) as typeof batch.cursorAfter : null;
      const maxDecimal = (left: string, right: string) => BigInt(left) > BigInt(right) ? left : right;
      const cursorAfter = prior ? {
        version: 1,
        revision: maxDecimal(prior.revision, batch.cursorAfter.revision),
        globalRev: maxDecimal(prior.globalRev, batch.cursorAfter.globalRev),
        individualRev: maxDecimal(prior.individualRev, batch.cursorAfter.individualRev),
      } : batch.cursorAfter;
      await client.query(
        `INSERT INTO sync_cursors (account_id, source, cursor) VALUES ($1,$2,$3)
         ON CONFLICT (account_id, source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
        [batch.accountId, source, JSON.stringify(cursorAfter)],
      );
      if (!sourceBatchReplay) {
        await client.query(`UPDATE external_source_checkpoints SET cursor=$4::jsonb,updated_at=now()
          WHERE source_id=$1 AND account_id=$2 AND generation=$3`,
        [sourceId, batch.accountId, sourceGeneration, JSON.stringify(cursorAfter)]);
        await client.query(`UPDATE external_source_batches SET result=$4::jsonb
          WHERE source_id=$1 AND generation=$2 AND batch_id=$3`,
        [sourceId, sourceGeneration, batch.batchId, JSON.stringify({ inserted, duplicate })]);
      }
      await client.query('COMMIT');
      return { inserted, duplicate, insertedMessageIds, changedMessageIds: [...new Set(changedMessageIds)], jobIds: [], jobMessageIds: [], primaryAdminActionMessageIds: [], jobStatuses: [],
        readPositionsChanged, readPositionChanges };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async admitLiveBatch(batch: Extract<LineWorkerEvent, { type: 'batch' }>, decisions: readonly RoutingDecision[]): Promise<{
    jobIds: string[]; jobMessageIds: string[]; jobStatuses: NonNullable<IngestResult['jobStatus']>[]; primaryAdminActionMessageIds: string[];
    routeDecisions: RoutingDecision[];
  }> {
    if (batch.envelopes.length !== decisions.length) throw new Error('One routing decision is required per envelope');
    const client = await this.pool.connect();
    const jobIds: string[] = [], jobMessageIds: string[] = [], jobStatuses: NonNullable<IngestResult['jobStatus']>[] = [], primaryAdminActionMessageIds: string[] = [];
    const routeDecisions = [...decisions];
    try {
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton=true FOR SHARE');
      const authority = await client.query<{ mode: string; worker_instance_id: string | null; worker_binding_epoch: string | null;
        connection_mode: string; own_mid: string | null; selected_source_id: string | null; selected_source_generation: string | null;
        source_type: string | null; source_state: string | null; verified_account_mid: string | null }>(
        `SELECT a.mode,a.worker_instance_id,a.worker_binding_epoch,a.connection_mode,a.own_mid,a.selected_source_id,
          a.selected_source_generation,s.source_type,s.state AS source_state,s.verified_account_mid
         FROM line_accounts a LEFT JOIN line_account_sources s ON s.account_id=a.account_id
           AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR SHARE OF a`, [batch.accountId]);
      const account = authority.rows[0];
      if (!account || account.worker_instance_id !== batch.workerInstanceId
        || Number(account.worker_binding_epoch) !== batch.controlEpoch || batch.controlEpoch > Number(control.rows[0]?.control_epoch)
        || (account.mode === 'ACTIVE_CONTROL' && batch.controlEpoch !== Number(control.rows[0]?.control_epoch))
        || account.connection_mode !== 'SYSTEM_LOGIN' || !account.selected_source_id || account.source_type !== 'SYSTEM_LOGIN'
        || account.source_state !== 'ACTIVE' || account.own_mid !== account.verified_account_mid) throw new Error('Stale login admission authority');
      if (account.mode !== 'ACTIVE_CONTROL') {
        routeDecisions.fill({ eligible: false, action: 'ignore' });
        await client.query('COMMIT');
        return { jobIds, jobMessageIds, jobStatuses, primaryAdminActionMessageIds, routeDecisions };
      }
      for (const [index, envelope] of batch.envelopes.entries()) {
        if (envelope.ingestion.source !== 'live' || envelope.accountId !== batch.accountId) continue;
        const priorRoute = await client.query<{ action: string }>(
          'SELECT action FROM message_routes WHERE account_id=$1 AND message_id=$2 FOR SHARE',
          [batch.accountId, envelope.messageId]);
        if (priorRoute.rows[0]?.action === 'prompt') {
          const existing = await client.query<{ job_id: string; status: 'queued' | 'failed'; revision: string }>(
            `SELECT job_id,status,((extract(epoch FROM updated_at)*1000000)::numeric(20,0))::text revision
             FROM agent_jobs WHERE account_id=$1 AND source_type='line' AND source_message_id=$2 AND retry_of_job_id IS NULL`,
            [batch.accountId, envelope.messageId]);
          const job = existing.rows[0];
          if (job) {
            jobIds.push(job.job_id);
            jobStatuses.push({ accountId: batch.accountId, chatType: envelope.chatType, chatId: envelope.chatId,
              sourceMessageId: envelope.messageId, jobId: job.job_id, status: job.status, revision: job.revision });
            if (job.status === 'queued') jobMessageIds.push(envelope.messageId);
          }
          continue;
        }
        if (priorRoute.rowCount) continue;
        const requested = decisions[index]!;
        const primaryAdminStillBound = requested.primaryAdminSenderId === undefined || (await client.query(
          `SELECT 1 FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN' AND user_id=$2 FOR SHARE`,
          [batch.accountId, requested.primaryAdminSenderId])).rowCount === 1;
        const requestedAuthorization = requested.eligible || 'workspaceFailure' in requested ? requested.authorization : undefined;
        const grantAuthorized = requestedAuthorization ? await this.lockAndCheckAgentAuthorization(client, batch.accountId,
          envelope.chatType, envelope.chatId, envelope.senderId, requestedAuthorization) : true;
        const decision: RoutingDecision = !grantAuthorized || !primaryAdminStillBound ? { eligible: false, action: 'ignore' } : requested;
        routeDecisions[index] = decision;
        if ('primaryAdminSenderId' in decision && decision.primaryAdminSenderId
          && (decision.eligible || 'workspaceFailure' in decision || ('action' in decision && decision.action !== 'ignore'))) {
          primaryAdminActionMessageIds.push(envelope.messageId);
        }
        const failure = !decision.eligible && 'workspaceFailure' in decision ? decision.workspaceFailure : undefined;
        if (!decision.eligible && !failure) continue;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))', [`${batch.accountId}:${envelope.messageId}`]);
        const existing = await client.query<{ job_id: string; status: 'queued' | 'failed'; revision: string }>(
          `SELECT job_id,status,((extract(epoch FROM updated_at)*1000000)::numeric(20,0))::text revision
           FROM agent_jobs WHERE account_id=$1 AND source_type='line' AND source_message_id=$2 AND retry_of_job_id IS NULL`, [batch.accountId,envelope.messageId]);
        let job = existing.rows[0];
        if (!job) {
          const provider = decision.eligible ? decision.provider : failure!.provider;
          const prompt = decision.eligible ? await promptWithContactCards(client, envelope, decision.prompt, batch.envelopes.slice(0, index)) : failure!.prompt;
          const workspacePath = decision.eligible ? decision.workspacePath : failure!.workspacePath ?? '';
          await ensureLineageSessionRow(client, { accountId: batch.accountId, chatType: envelope.chatType, chatId: envelope.chatId, provider });
          const session = await client.query<{ generation: number }>(`SELECT generation FROM agent_sessions WHERE account_id=$1
            AND chat_type=$2 AND chat_id=$3 AND provider=$4 AND source_type='line' FOR UPDATE`,
            [batch.accountId,envelope.chatType,envelope.chatId,provider]);
          const jobId = randomUUID();
          const inserted = await client.query<{ job_id: string; status: 'queued'|'failed'; revision: string }>(
            `INSERT INTO agent_jobs(job_id,account_id,chat_type,chat_id,provider,source_type,source_message_id,source_sender_id,prompt,workspace_path,
               generation,creation_epoch,status,completed_at,direct_friend_grant_id,direct_friend_grant_version,room_agent_grant_id,room_agent_grant_version)
             VALUES($1,$2,$3,$4,$5,'line',$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12='failed' THEN now() ELSE NULL END,$13,$14,$15,$16)
             ON CONFLICT(account_id,source_message_id) WHERE source_type='line' AND retry_of_job_id IS NULL DO NOTHING
             RETURNING job_id,status,((extract(epoch FROM updated_at)*1000000)::numeric(20,0))::text revision`,
            [jobId,batch.accountId,envelope.chatType,envelope.chatId,provider,envelope.messageId,envelope.senderId,prompt,workspacePath,session.rows[0]!.generation,
              batch.controlEpoch,failure?'failed':'queued',requestedAuthorization?.directGrantId??null,requestedAuthorization?.directGrantVersion??null,
              requestedAuthorization?.roomGrantId??null,requestedAuthorization?.roomGrantVersion??null]);
          job = inserted.rows[0] ?? (await client.query<{ job_id: string; status: 'queued'|'failed'; revision: string }>(
            `SELECT job_id,status,((extract(epoch FROM updated_at)*1000000)::numeric(20,0))::text revision
             FROM agent_jobs WHERE account_id=$1 AND source_type='line' AND source_message_id=$2 AND retry_of_job_id IS NULL`, [batch.accountId,envelope.messageId])).rows[0];
          if (!job) throw new Error('Agent job insert did not produce or find a job');
          if (failure && inserted.rowCount) await client.query('INSERT INTO agent_events(job_id,event) VALUES($1,$2::jsonb)',
            [job.job_id,JSON.stringify({type:'failed',code:failure.code,message:failure.reason,retryable:false})]);
        }
        jobIds.push(job.job_id);
        jobStatuses.push({ accountId:batch.accountId,chatType:envelope.chatType,chatId:envelope.chatId,
          sourceMessageId:envelope.messageId,jobId:job.job_id,status:job.status,revision:job.revision });
        if (job.status === 'queued') jobMessageIds.push(envelope.messageId);
      }
      await client.query('COMMIT');
      return { jobIds, jobMessageIds, jobStatuses, primaryAdminActionMessageIds, routeDecisions };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async recordBatchRoutes(batch: Extract<LineWorkerEvent, { type: 'batch' }>, decisions: readonly RoutingDecision[], completedPrompts: ReadonlySet<string>): Promise<void> {
    if (batch.envelopes.length !== decisions.length) throw new Error('One routing decision is required per envelope');
    for (const [index, envelope] of batch.envelopes.entries()) {
      if (envelope.ingestion.source !== 'live') continue;
      const decision = decisions[index]!;
      const failure = !decision.eligible && 'workspaceFailure' in decision ? decision.workspaceFailure : undefined;
      if ((decision.eligible || failure) && !completedPrompts.has(envelope.messageId)) continue;
      const action = decision.eligible || failure ? 'prompt' : ('action' in decision ? decision.action : undefined) ?? 'ignore';
      await this.pool.query(`INSERT INTO message_routes(account_id,message_id,action,provider,creation_epoch)
        SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM messages WHERE account_id=$1 AND message_id=$2)
        ON CONFLICT(account_id,message_id) DO NOTHING`, [envelope.accountId,envelope.messageId,action,
          action === 'prompt' ? decision.eligible ? decision.provider : failure?.provider ?? null : null,
          action === 'ignore' ? null : batch.controlEpoch]);
    }
  }

  async existingLiveRoutes(batch: Extract<LineWorkerEvent, { type: 'batch' }>): Promise<Set<string>> {
    const messageIds = batch.envelopes.filter((envelope) => envelope.ingestion.source === 'live'
      && envelope.accountId === batch.accountId).map((envelope) => envelope.messageId);
    if (!messageIds.length) return new Set();
    const result = await this.pool.query<{ message_id: string }>(
      'SELECT message_id FROM message_routes WHERE account_id=$1 AND message_id=ANY($2::text[])',
      [batch.accountId, messageIds]);
    return new Set(result.rows.map((row) => row.message_id));
  }

  async listUnroutedLiveSourceMessages(input: { accountId: string; workerInstanceId: string; controlEpoch: number;
    afterObservationId?: string; limit?: number }): Promise<UnroutedLiveSourceMessage[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 100)));
    const result = await this.pool.query<{ observation_id: string; recovery: Record<string, unknown> | null }>(
      `SELECT o.observation_id,o.normalized_payload->'livePayload'->'recovery' AS recovery
       FROM line_accounts a
       JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
         AND s.generation=a.selected_source_generation AND s.source_type='SYSTEM_LOGIN' AND s.state='ACTIVE'
       JOIN message_source_provenance p ON p.account_id=a.account_id AND p.source_id=s.source_id
         AND p.generation=s.generation AND p.origin='SYSTEM_LOGIN_LIVE'
       JOIN external_source_observations o ON o.source_id=p.source_id AND o.generation=p.generation
         AND o.observation_id=p.observation_id AND o.canonical_message_id=p.message_id
       JOIN account_control ac ON ac.singleton=true
       LEFT JOIN message_routes r ON r.account_id=p.account_id AND r.message_id=p.message_id
       WHERE a.account_id=$1 AND a.connection_mode='SYSTEM_LOGIN' AND a.mode='ACTIVE_CONTROL'
         AND a.worker_instance_id=$2 AND a.worker_binding_epoch=$3 AND ac.control_epoch=$3
         AND a.own_mid=s.verified_account_mid AND r.message_id IS NULL
         AND COALESCE(o.normalized_payload->'livePayload'->'recovery'->>'startupSuppressed','false') <> 'true'
         AND o.normalized_payload->'livePayload'->'recovery'->'envelope' IS NOT NULL
         AND o.observation_id > $4
       ORDER BY o.observation_id ASC LIMIT $5`,
      [input.accountId, input.workerInstanceId, input.controlEpoch, input.afterObservationId ?? '', limit]);
    return result.rows.map((row) => {
      const recovery = row.recovery ?? {};
      const parsed = InboundEnvelopeSchema.safeParse(recovery.envelope);
      const receiptMode = recovery.receiptMode === 'ACTIVE_CONTROL' || recovery.receiptMode === 'MONITOR_ONLY' || recovery.receiptMode === 'PAUSED'
        ? recovery.receiptMode : 'PAUSED';
      const receiptControlEpoch = Number.isSafeInteger(recovery.controlEpoch) && Number(recovery.controlEpoch) >= 0
        ? Number(recovery.controlEpoch) : -1;
      return { observationId: row.observation_id, envelope: parsed.success ? parsed.data : null,
        receiptMode, receiptControlEpoch, sensitive: recovery.sensitive === true };
    });
  }

  /** Close pending inbound effects before startup catch-up; suppression leaves effect_applied_at untouched. */
  async suppressPendingRouteActions(input: { accountId: string; workerInstanceId: string; controlEpoch: number }): Promise<void> {
    await this.pool.query(
      `UPDATE message_routes r SET action='ignore', provider=NULL
       FROM line_accounts a JOIN account_control c ON c.singleton=true
       WHERE r.account_id=$1 AND a.account_id=r.account_id AND a.worker_instance_id=$2
         AND a.worker_binding_epoch=$3 AND a.mode='ACTIVE_CONTROL' AND c.control_epoch=$3
         AND r.action IN ('stop','new','status') AND r.effect_applied_at IS NULL AND r.creation_epoch=$3`,
      [input.accountId, input.workerInstanceId, input.controlEpoch],
    );
  }

  /** Mark unrouted live observations suppressed so later bind recovery cannot turn them into automation. */
  async suppressUnroutedLiveSourceMessages(input: { accountId: string; workerInstanceId: string; controlEpoch: number }): Promise<void> {
    await this.pool.query(
      `UPDATE external_source_observations o
       SET normalized_payload=jsonb_set(o.normalized_payload,
         '{livePayload,recovery,startupSuppressed}','true'::jsonb,true)
       FROM message_source_provenance p
       JOIN line_account_sources s ON s.account_id=p.account_id AND s.source_id=p.source_id
         AND s.generation=p.generation AND s.source_type='SYSTEM_LOGIN' AND s.state='ACTIVE'
       JOIN line_accounts a ON a.account_id=s.account_id AND a.selected_source_id=s.source_id
         AND a.selected_source_generation=s.generation
       JOIN account_control ac ON ac.singleton=true
       LEFT JOIN message_routes r ON r.account_id=p.account_id AND r.message_id=p.message_id
       WHERE o.source_id=p.source_id AND o.generation=p.generation AND o.observation_id=p.observation_id
         AND p.account_id=$1 AND p.origin='SYSTEM_LOGIN_LIVE' AND r.message_id IS NULL
         AND a.connection_mode='SYSTEM_LOGIN' AND a.mode='ACTIVE_CONTROL' AND a.worker_instance_id=$2
         AND a.worker_binding_epoch=$3 AND ac.control_epoch=$3 AND a.own_mid=s.verified_account_mid
         AND o.normalized_payload->'livePayload'->'recovery'->'envelope' IS NOT NULL
         AND COALESCE(o.normalized_payload->'livePayload'->'recovery'->>'startupSuppressed','false') <> 'true'`,
      [input.accountId, input.workerInstanceId, input.controlEpoch],
    );
  }

  /** Forward-only read-position upsert, one statement per batch. Receipts for unknown conversations are dropped. */
  private async upsertReadPositions(client: PoolClient, accountId: string,
    receipts: readonly ReadReceiptDto[]): Promise<{ readPositionsChanged: number; readPositionChanges: ReadPositionChange[] }> {
    if (receipts.length === 0) return { readPositionsChanged: 0, readPositionChanges: [] };
    const merged = new Map<string, ReadReceiptDto>();
    for (const receipt of receipts) {
      const id = JSON.stringify([receipt.chatId, receipt.readerMid]);
      const prior = merged.get(id);
      if (!prior || BigInt(receipt.messageId) > BigInt(prior.messageId)) merged.set(id, receipt);
    }
    const rows = [...merged.values()].map((receipt) => ({ chat_id: receipt.chatId, reader_mid: receipt.readerMid,
      message_id: receipt.messageId, read_at: receipt.readAt }));
    const result = await client.query<{ chat_type: ConversationKey['chatType']; chat_id: string; last_read_message_id: string }>(
      `WITH input AS (
         SELECT r.chat_id, r.reader_mid, r.message_id, r.read_at,
           CASE left(r.chat_id, 1) WHEN 'c' THEN 'group' WHEN 'r' THEN 'room' ELSE 'direct' END AS chat_type
         FROM jsonb_to_recordset($2::jsonb) AS r(chat_id text, reader_mid text, message_id text, read_at timestamptz)
       )
       INSERT INTO message_read_positions (account_id, chat_type, chat_id, reader_mid, last_read_message_id, last_read_at)
       SELECT $1, i.chat_type, i.chat_id, i.reader_mid, i.message_id, i.read_at
       FROM input i JOIN conversations c ON c.account_id = $1 AND c.chat_type = i.chat_type AND c.chat_id = i.chat_id
       ON CONFLICT (account_id, chat_type, chat_id, reader_mid) DO UPDATE
         SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at
         WHERE EXCLUDED.last_read_message_id::numeric > message_read_positions.last_read_message_id::numeric
       RETURNING chat_type, chat_id, last_read_message_id`,
      [accountId, JSON.stringify(rows)]);
    const changes = new Map<string, ReadPositionChange>();
    for (const row of result.rows) {
      const id = JSON.stringify([row.chat_type, row.chat_id]);
      const prior = changes.get(id);
      if (!prior || BigInt(row.last_read_message_id) > BigInt(prior.messageId)) {
        changes.set(id, { key: { accountId, chatType: row.chat_type, chatId: row.chat_id }, messageId: row.last_read_message_id });
      }
    }
    return { readPositionsChanged: result.rowCount ?? result.rows.length, readPositionChanges: [...changes.values()] };
  }

  /** Read positions for one conversation (one row per reader), for the timeline read-count query. */
  async readPositionsForConversation(key: ConversationKey, opts: { limit?: number } = {}):
    Promise<{ readerMid: string; lastReadMessageId: string; lastReadAt: string }[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 500);
    const result = await this.pool.query<{ reader_mid: string; last_read_message_id: string; last_read_at: Date }>(
      `SELECT reader_mid, last_read_message_id, last_read_at FROM message_read_positions
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
       ORDER BY last_read_at DESC, reader_mid LIMIT $4`,
      [key.accountId, key.chatType, key.chatId, limit]);
    return result.rows.map((row) => ({ readerMid: row.reader_mid, lastReadMessageId: row.last_read_message_id,
      lastReadAt: row.last_read_at.toISOString() }));
  }

  private async lockAndCheckAgentAuthorization(
    client: PoolClient, accountId: string, chatType: ConversationKey['chatType'], chatId: string, senderId: string,
    authorization: AgentAdmissionAuthorization,
  ): Promise<boolean> {
    return lockAndCheckAgentAuthorization(client, accountId, chatType, chatId, senderId, authorization);
  }

  async pendingRouteAction(key: ConversationKey, messageId: string): Promise<PendingRouteAction | null> {
    const result = await this.pool.query<{ action: PendingRouteAction }>(
      `SELECT r.action FROM message_routes r JOIN messages m
         ON m.account_id = r.account_id AND m.message_id = r.message_id
       JOIN line_accounts a ON a.account_id = r.account_id
       JOIN account_control c ON c.singleton = true
       WHERE r.account_id = $1 AND r.message_id = $4 AND m.chat_type = $2 AND m.chat_id = $3
         AND r.action IN ('stop', 'new', 'status') AND r.effect_applied_at IS NULL
         AND a.mode = 'ACTIVE_CONTROL' AND r.creation_epoch = c.control_epoch`,
      [key.accountId, key.chatType, key.chatId, messageId],
    );
    return result.rows[0]?.action ?? null;
  }

  async listPendingRouteActions(accountId: string, workerInstanceId: string): Promise<PendingRoute[]> {
    const result = await this.pool.query<{
      chat_type: ConversationKey['chatType']; chat_id: string; message_id: string;
    }>(
      `SELECT m.chat_type, m.chat_id, r.message_id FROM message_routes r
       JOIN messages m ON m.account_id = r.account_id AND m.message_id = r.message_id
       JOIN line_accounts a ON a.account_id = r.account_id
       JOIN account_control c ON c.singleton = true
       WHERE r.account_id = $1 AND a.worker_instance_id = $2 AND a.mode = 'ACTIVE_CONTROL'
         AND a.worker_binding_epoch = c.control_epoch AND r.creation_epoch = c.control_epoch
         AND r.action IN ('stop', 'new', 'status') AND r.effect_applied_at IS NULL
       ORDER BY r.route_position`, [accountId, workerInstanceId],
    );
    return result.rows.map((row) => ({
      key: { accountId, chatType: row.chat_type, chatId: row.chat_id }, messageId: row.message_id,
    }));
  }

  async applyPendingRouteAction(key: ConversationKey, messageId: string, workerInstanceId: string,
    apply: (action: PendingRouteAction) => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [`${key.accountId}:${messageId}`]);
      const pending = await client.query<{ action: PendingRouteAction }>(
        `SELECT r.action FROM message_routes r
         JOIN messages m ON m.account_id = r.account_id AND m.message_id = r.message_id
         JOIN line_accounts a ON a.account_id = r.account_id
         JOIN account_control c ON c.singleton = true
         WHERE r.account_id = $1 AND r.message_id = $4 AND m.chat_type = $2 AND m.chat_id = $3
           AND a.worker_instance_id = $5 AND a.mode = 'ACTIVE_CONTROL'
           AND a.worker_binding_epoch = c.control_epoch AND r.creation_epoch = c.control_epoch
           AND r.action IN ('stop', 'new', 'status') AND r.effect_applied_at IS NULL`,
        [key.accountId, key.chatType, key.chatId, messageId, workerInstanceId],
      );
      const action = pending.rows[0]?.action;
      if (!action) { await client.query('COMMIT'); return false; }
      await apply(action);
      await client.query(
        `UPDATE message_routes SET effect_applied_at = now()
         WHERE account_id = $1 AND message_id = $2 AND action = $3 AND effect_applied_at IS NULL`,
        [key.accountId, messageId, action],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async markRouteApplied(key: ConversationKey, messageId: string, action: PendingRouteAction): Promise<void> {
    await this.pool.query(
      `UPDATE message_routes r SET effect_applied_at = now()
       FROM messages m WHERE r.account_id = $1 AND r.message_id = $4 AND r.action = $5
         AND r.effect_applied_at IS NULL AND m.account_id = r.account_id AND m.message_id = r.message_id
         AND m.chat_type = $2 AND m.chat_id = $3`,
      [key.accountId, key.chatType, key.chatId, messageId, action],
    );
  }

  /** Record a confirmed LINE unsend through the selected system-login source copy and its canonical projector. */
  async recordManualUnsend(key: ConversationKey, messageId: string, ownMid: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query<{ own_mid: string | null; connection_mode: string; source_id: string | null;
        generation: string | null; source_type: string | null; source_state: string | null; verified_account_mid: string | null }>(
        `SELECT a.own_mid,a.connection_mode,a.selected_source_id AS source_id,a.selected_source_generation AS generation,
          s.source_type,s.state AS source_state,s.verified_account_mid
         FROM line_accounts a LEFT JOIN line_account_sources s ON s.account_id=a.account_id
           AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR SHARE OF a`, [key.accountId]);
      const account = authority.rows[0];
      if (!account || account.connection_mode !== 'SYSTEM_LOGIN' || account.own_mid !== ownMid
        || account.verified_account_mid !== ownMid || account.source_type !== 'SYSTEM_LOGIN' || account.source_state !== 'ACTIVE'
        || !account.source_id || !account.generation) throw new Error('Logged-in source authority is stale');

      const message = await client.query<{ chat_type: string; chat_id: string; sender_id: string; content: MessageContent | null }>(
        'SELECT chat_type,chat_id,sender_id,content FROM messages WHERE account_id=$1 AND message_id=$2', [key.accountId, messageId]);
      const current = message.rows[0];
      if (!current || current.chat_type !== key.chatType || current.chat_id !== key.chatId || current.sender_id !== ownMid) {
        throw new Error('Message is not an owned message in the selected conversation');
      }
      if (current.content?.type === 'unsent') { await client.query('COMMIT'); return false; }

      const source = await client.query<{ normalized_payload: ExternalObservation }>(
        `SELECT normalized_payload FROM external_source_observations
         WHERE source_id=$1 AND account_id=$2 AND generation=$3 AND canonical_message_id=$4 AND status='PROJECTED'
         ORDER BY observation_id LIMIT 1`, [account.source_id, key.accountId, Number(account.generation), messageId]);
      const prior = source.rows[0]?.normalized_payload;
      if (!prior?.livePayload) throw new Error('Message source copy is unavailable for unsend reconciliation');
      const raw = prior.livePayload.raw;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Message source copy is unavailable for unsend reconciliation');
      const rawRecord = raw as Record<string, JsonValue>;
      const nativeMessage = rawRecord.message;
      if (nativeMessage === null || typeof nativeMessage !== 'object' || Array.isArray(nativeMessage)) {
        throw new Error('Message source copy is unavailable for unsend reconciliation');
      }
      const nativeRecord = nativeMessage as Record<string, JsonValue>;
      const metadata = nativeRecord.contentMetadata;
      const metadataRecord = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, JsonValue> : {};
      const observation: ExternalObservation = { ...prior, text: null, livePayload: { ...prior.livePayload,
        raw: { ...rawRecord, message: { ...nativeRecord, text: '', contentMetadata: { ...metadataRecord, UNSENT: true } } } } };
      const batchId = `manual-unsend:${randomUUID()}`;
      const payloadDigest = createHash('sha256').update(JSON.stringify(observation), 'utf8').digest('hex');
      await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
        VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [account.source_id, key.accountId, Number(account.generation), batchId, payloadDigest]);
      const staged = await stageSystemLoginObservation(client, { accountId: key.accountId, sourceId: account.source_id,
        generation: Number(account.generation), batchId, origin: 'SYSTEM_LOGIN_LIVE', observation });
      if (staged.conflict) throw new Error('Message source copy changed while reconciling unsend');
      await client.query('COMMIT');
      return staged.changed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async ingestAndRoute(envelope: InboundEnvelope, routingDecision: RoutingDecision): Promise<IngestResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton = true FOR SHARE');
      await client.query('INSERT INTO line_accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING', [envelope.accountId]);
      const source = await client.query<{ connection_mode: string; own_mid: string | null; source_id: string | null;
        generation: string | null; source_type: string | null; source_state: string | null; verified_account_mid: string | null }>(
        `SELECT a.connection_mode,a.own_mid,a.selected_source_id AS source_id,a.selected_source_generation AS generation,
          s.source_type,s.state AS source_state,s.verified_account_mid FROM line_accounts a LEFT JOIN line_account_sources s
            ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR SHARE OF a`, [envelope.accountId]);
      if (source.rows[0]?.connection_mode === 'EXTERNAL_MONITOR') throw new Error('External monitor is read-only');
      const loginSource = source.rows[0]?.connection_mode === 'SYSTEM_LOGIN' && source.rows[0]?.source_type === 'SYSTEM_LOGIN'
        && source.rows[0]?.source_state === 'ACTIVE' && source.rows[0]?.own_mid === source.rows[0]?.verified_account_mid
        ? { sourceId: source.rows[0]!.source_id!, generation: Number(source.rows[0]!.generation) } : null;
      if (envelope.ingestion.source === 'history' && source.rows[0]?.connection_mode === 'SYSTEM_LOGIN'
        && source.rows[0]?.own_mid !== null && !loginSource) throw new Error('Logged-in history source authority is stale');
      await client.query(
        'INSERT INTO conversations (account_id, chat_id, chat_type) VALUES ($1, $2, $3) ON CONFLICT (account_id, chat_type, chat_id) DO NOTHING',
        [envelope.accountId, envelope.chatId, envelope.chatType],
      );
      let inserted = true;
      let messageChanged = false;
      if (loginSource) {
        const observation = systemLoginObservation(envelope);
        const observationDigest = createHash('sha256').update(JSON.stringify(observation), 'utf8').digest('hex');
        const batchId = `history:${observationDigest}`;
        const priorBatch = await client.query<{ payload_digest: string }>(
          'SELECT payload_digest FROM external_source_batches WHERE source_id=$1 AND generation=$2 AND batch_id=$3 FOR UPDATE',
          [loginSource.sourceId, loginSource.generation, batchId]);
        if (priorBatch.rows[0] && priorBatch.rows[0].payload_digest !== observationDigest) throw new Error('Login history replay digest mismatch');
        if (!priorBatch.rows[0]) {
          await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
            VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
          [loginSource.sourceId, envelope.accountId, loginSource.generation, batchId, observationDigest]);
          const staged = await stageSystemLoginObservation(client, { accountId: envelope.accountId, sourceId: loginSource.sourceId,
            generation: loginSource.generation, batchId, origin: envelope.ingestion.source === 'live' ? 'SYSTEM_LOGIN_LIVE' : 'SYSTEM_LOGIN_HISTORY',
            observation, captureCanonicalExistence: true });
          if (staged.conflict) throw new Error('Login source observation ID was reused with changed identity');
          messageChanged = staged.changed;
          inserted = staged.canonicalExisted === false;
        } else {
          inserted = false;
        }
      } else {
        const priorMessage = await client.query('SELECT 1 FROM messages WHERE account_id=$1 AND message_id=$2 FOR UPDATE',
          [envelope.accountId, envelope.messageId]);
        inserted = !priorMessage.rowCount;
        const directInsert = await client.query(
          `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, content, content_rule_version, reply_to_message_id, mention_ids, mention_ranges, ingestion_source, occurred_at, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb)
           ON CONFLICT (account_id, message_id) DO NOTHING RETURNING message_id`,
          [envelope.accountId, envelope.messageId, envelope.eventId, envelope.chatId, envelope.chatType, envelope.senderId, envelope.kind, envelope.text, ...liveProjectionValues(envelope), JSON.stringify(envelope.mentionIds), JSON.stringify(envelope.mentionRanges), envelope.ingestion.source, envelope.occurredAt, JSON.stringify(envelope.raw)],
        );
        inserted = Boolean(directInsert.rowCount);
      }
      let jobId: string | undefined;
      let jobStatus: NonNullable<IngestResult['jobStatus']> | undefined;
      if (inserted) {
        if (envelope.ingestion.source === 'live' && envelope.kind !== 'event') await client.query(
          `UPDATE conversations c SET unread_count=unread_count+1, updated_at=now()
           WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3 AND EXISTS
             (SELECT 1 FROM line_accounts la WHERE la.account_id=$1 AND la.own_mid IS DISTINCT FROM $4)`,
          [envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId]);
        if (envelope.ingestion.cursor !== null) {
          await client.query(
            `INSERT INTO sync_cursors (account_id, source, cursor) VALUES ($1, $2, $3)
             ON CONFLICT (account_id, source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
            [envelope.accountId, envelope.ingestion.source, envelope.ingestion.cursor],
          );
        }
        for (const attachment of envelope.attachments) {
          await client.query(
            `INSERT INTO attachments (external_attachment_id, account_id, chat_type, chat_id, message_id, kind, name, mime_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (account_id, chat_type, chat_id, message_id, external_attachment_id) DO NOTHING`,
            [attachment.id, envelope.accountId, envelope.chatType, envelope.chatId, envelope.messageId, attachment.kind, attachment.name, attachment.mimeType, attachment.sizeBytes],
          );
        }
        if (envelope.ingestion.source === 'live' && routingDecision.eligible) {
          const authority = await client.query(
            `SELECT account_id FROM line_accounts WHERE account_id = $1 AND mode = 'ACTIVE_CONTROL' FOR SHARE`,
            [envelope.accountId],
          );
          if (authority.rows[0]) {
            await ensureLineageSessionRow(client, { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId, provider: routingDecision.provider });
            const session = await client.query<{ generation: number }>(
            "SELECT generation FROM agent_sessions WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = 'line' FOR UPDATE",
            [envelope.accountId, envelope.chatType, envelope.chatId, routingDecision.provider],
            );
            jobId = randomUUID();
            const insertedJob = await client.query<{ status: 'queued'; revision: string }>(
            `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch)
             VALUES ($1, $2, $3, $4, $5, 'line', $6, $7, $8, $9, $10)
             RETURNING status,((extract(epoch FROM updated_at) * 1000000)::numeric(20,0))::text AS revision`,
            [jobId, envelope.accountId, envelope.chatType, envelope.chatId, routingDecision.provider, envelope.messageId, await promptWithContactCards(client, envelope, routingDecision.prompt), routingDecision.workspacePath, session.rows[0]?.generation, control.rows[0]!.control_epoch],
            );
            const committedJob = insertedJob.rows[0];
            if (committedJob) jobStatus = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId,
              sourceMessageId: envelope.messageId, jobId, status: committedJob.status, revision: committedJob.revision };
          }
        }
      } else {
        const existing = await client.query<{ job_id: string }>(
          `SELECT job_id FROM agent_jobs WHERE account_id = $1 AND source_type = 'line' AND source_message_id = $2 AND retry_of_job_id IS NULL`,
          [envelope.accountId, envelope.messageId],
        );
        jobId = existing.rows[0]?.job_id;
      }
      const cursor = await client.query<{ cursor: string }>(
        'SELECT cursor FROM sync_cursors WHERE account_id = $1 AND source = $2 FOR SHARE',
        [envelope.accountId, envelope.ingestion.source],
      );
      await client.query('COMMIT');
      const result: IngestResult = { disposition: inserted ? 'inserted' : 'duplicate', durableCursor: cursor.rows[0]?.cursor ?? null };
      if (jobId) result.jobId = jobId;
      if (jobStatus) result.jobStatus = jobStatus;
      if (messageChanged) result.messageChanged = true;
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async searchMessages(query: MessageSearchQuery): Promise<MessageSearchResult[]> {
    const lineage = await resolveAgentLineage(this.pool);
    const lineageIds = new Set(lineage.accountIds);
    let accountIds: string[] | null = null;
    if (query.scope?.kind === 'agent') accountIds = lineage.accountIds;
    else if (query.scope?.kind === 'account') accountIds = [query.scope.accountId];
    else if (!query.scope && (query.key?.accountId ?? query.accountId)) accountIds = [(query.key?.accountId ?? query.accountId)!];
    if (accountIds && accountIds.length === 0) return [];
    const result = await this.pool.query<{
      account_id: string; chat_type: ConversationKey['chatType']; chat_id: string; message_id: string; sender_id: string;
      sender_name: string | null; is_own: boolean; conversation_title: string | null; text_content: string | null; occurred_at: Date;
    }>(
      `SELECT m.account_id, m.chat_type, m.chat_id, m.message_id, m.sender_id,
         ${SENDER_NAME_SQL} AS sender_name,
         ${ownMessageSql('m', 'la')} AS is_own,
         ${CONVERSATION_TITLE_SQL} AS conversation_title, m.text_content, m.occurred_at
       FROM messages m
       JOIN line_accounts la ON la.account_id = m.account_id
       LEFT JOIN conversations c ON c.account_id = m.account_id AND c.chat_type = m.chat_type AND c.chat_id = m.chat_id
       LEFT JOIN conversation_members cm ON cm.account_id = m.account_id AND cm.chat_type = m.chat_type
         AND cm.chat_id = m.chat_id AND cm.member_id = m.sender_id
       ${SENDER_CONTACT_JOIN}
       ${PEER_CONTACT_JOIN}
       WHERE (m.kind <> 'event' OR m.content IS NOT NULL)
         AND ($1::text[] IS NULL OR m.account_id = ANY($1::text[]))
         AND ($2::text IS NULL OR m.chat_type = $2)
         AND ($3::text IS NULL OR m.chat_id = $3)
         AND ($4::text IS NULL OR m.sender_id = $4)
         AND ($5::text IS NULL OR position(lower($5) in lower(coalesce(m.text_content, ''))) > 0
           OR position(lower($5) in lower(coalesce(${SENDER_NAME_SQL}, ''))) > 0
           OR position(lower($5) in lower(coalesce(${CONVERSATION_TITLE_SQL}, ''))) > 0
           OR (m.chat_type NOT IN ('community', 'thread')
             AND (position(lower($5) in lower(coalesce(sender_contact.nickname, ''))) > 0
               OR position(lower($5) in lower(coalesce(sender_contact.display_name, ''))) > 0))
           OR position(lower($5) in lower(coalesce(peer_contact.nickname, ''))) > 0
           OR position(lower($5) in lower(coalesce(peer_contact.display_name, ''))) > 0)
         AND ($6::timestamptz IS NULL OR m.occurred_at >= $6)
         AND ($7::timestamptz IS NULL OR m.occurred_at <= $7)
         AND ($8::boolean IS NULL OR $8 = EXISTS (
           SELECT 1 FROM attachments a WHERE a.account_id = m.account_id AND a.chat_type = m.chat_type
             AND a.chat_id = m.chat_id AND a.message_id = m.message_id))
         AND ($9::text IS NULL OR EXISTS (
           SELECT 1 FROM attachments a WHERE a.account_id = m.account_id AND a.chat_type = m.chat_type
             AND a.chat_id = m.chat_id AND a.message_id = m.message_id AND a.kind = $9))
       ORDER BY m.occurred_at DESC, m.message_id DESC LIMIT $10`,
      [accountIds, query.key?.chatType ?? null, query.key?.chatId ?? null,
        query.senderId ?? null, query.text ?? null, query.from ?? null, query.to ?? null,
        query.hasAttachment ?? null, query.attachmentKind ?? null, query.limit],
    );
    return result.rows.map((row) => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      messageId: row.message_id, senderId: row.sender_id, senderName: row.sender_name, isOwn: row.is_own,
      conversationTitle: row.conversation_title, text: row.text_content, occurredAt: row.occurred_at.toISOString(),
      lineage: lineageIds.has(row.account_id) ? 'agent' as const : null }));
  }

  async listMessages(key: ConversationKey, before: string | null, limit: number, exactMessageId?: string): Promise<{ messages: TimelineMessageRecord[]; nextCursor: string | null }> {
    const result = await this.pool.query<{
      account_id: string; chat_type: ConversationKey['chatType']; chat_id: string; message_id: string;
      sender_id: string; text_content: string | null; content: MessageContent | null; occurred_at: Date; kind: InboundEnvelope['kind']; raw: unknown; mention_ranges?: unknown;
      source_deleted: boolean; recall_original: unknown; read_count: string | number | null;
    }>(
      `SELECT m.account_id, m.chat_type, m.chat_id, m.message_id, m.sender_id, m.text_content, m.content, m.occurred_at, m.kind, m.raw, m.mention_ranges,
         (m.raw ? 'sourceDeleted') AS source_deleted,
         CASE WHEN m.chat_type IN ('direct', 'group', 'room') AND ${ownMessageSql('m', 'la')} AND ${NUMERIC_ID_SQL('m.message_id')} IS NOT NULL THEN (
           SELECT count(*) FROM message_read_positions p
           WHERE p.account_id = m.account_id AND p.chat_type = m.chat_type AND p.chat_id = m.chat_id
             AND ${NUMERIC_ID_SQL('p.last_read_message_id')} >= ${NUMERIC_ID_SQL('m.message_id')}) END AS read_count,
         CASE WHEN octet_length((m.raw->'recall'->'original')::text) <= ${RECALL_ORIGINAL_MAX_BYTES} THEN m.raw->'recall'->'original' END AS recall_original
       FROM messages m LEFT JOIN line_accounts la ON la.account_id = m.account_id
       WHERE m.account_id = $1 AND m.chat_type = $2 AND m.chat_id = $3 AND (m.kind <> 'event' OR m.content IS NOT NULL)
         AND ($6::text IS NULL OR m.message_id=$6)
         AND ($4::text IS NULL OR (m.occurred_at, m.message_id) < (
           SELECT occurred_at, message_id FROM messages
           WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND message_id = $4))
       ORDER BY m.occurred_at DESC, m.message_id DESC LIMIT $5`,
      [key.accountId, key.chatType, key.chatId, before, limit + 1, exactMessageId ?? null],
    );
    const page = result.rows.slice(0, limit);
    const nextCursor = result.rows.length > limit ? page.at(-1)!.message_id : null;
    const eventMids = [...new Set(page.flatMap((row) => liveChatEventMids(row.raw)).slice(0, 10_500))];
    const chatEventNames = eventMids.length > 0
      ? await loadChatEventNames(this.pool, key.accountId, key.chatType, key.chatId, eventMids) : undefined;
    const reactionsByMessage = new Map(page.map((row) => [row.message_id, nativeReactions(row.raw)] as const).filter(([, list]) => list.length > 0));
    const reactorIds = [...new Set([...reactionsByMessage.values()].flatMap((list) => list.flatMap((group) => group.reactorIds)))];
    const reactorNames = new Map<string, string>();
    if (reactorIds.length > 0) { // One batched lookup per page.
      const names = await this.pool.query<{ mid: string; name: string | null }>(
        `SELECT r.mid, CASE WHEN la.own_mid = r.mid THEN NULLIF(la.display_name, '') ELSE ${MEMBER_NAME_SQL} END AS name
         FROM unnest($4::text[]) AS r(mid)
         LEFT JOIN line_accounts la ON la.account_id = $1
         LEFT JOIN conversation_members cm ON cm.account_id = $1 AND cm.chat_type = $2 AND cm.chat_id = $3 AND cm.member_id = r.mid
         LEFT JOIN line_contacts member_contact ON member_contact.account_id = $1 AND member_contact.mid = r.mid`,
        [key.accountId, key.chatType, key.chatId, reactorIds]);
      for (const row of names.rows) if (row.name) reactorNames.set(row.mid, row.name);
    }
    const nameOf = (mid: string): string => reactorNames.get(mid) ?? `…${mid.slice(-4)}`;
    return { messages: [...page].reverse().map((row) => ({ accountId: row.account_id, chatType: row.chat_type,
      chatId: row.chat_id, messageId: row.message_id, senderId: row.sender_id, text: row.text_content,
      occurredAt: row.occurred_at.toISOString(), kind: row.kind,
      content: (() => {
        if (!chatEventNames || liveChatEventMids(row.raw).length === 0) return row.content;
        const projected = bridgeLiveMessage({ raw: row.raw, names: chatEventNames });
        return projected?.content ?? row.content;
      })(),
      postNotificationType: postNotificationSubtypeFromRaw(row.raw),
      sticker: row.kind === 'sticker' ? parseLineStickerDescriptor(row.raw) : null,
      mentionRanges: normalizeMentionRanges(row.text_content, row.mention_ranges),
      sourceDeleted: row.source_deleted === true,
      ...(Number(row.read_count) > 0 ? { readCount: Number(row.read_count) } : {}),
      ...(reactionsByMessage.has(row.message_id)
        ? { reactions: reactionsByMessage.get(row.message_id)!.map((group) => ({ ...group, reactorNames: group.reactorIds.map(nameOf) })) } : {}),
      recallOriginal: parseRecallOriginal(row.recall_original) })), nextCursor };
  }

  async getMessage(key: ConversationKey, messageId: string): Promise<TimelineMessageRecord | null> {
    const page = await this.listMessages(key, null, 1, messageId);
    return page.messages[0] ?? null;
  }

  /** Readers of one own message (position >= messageId), newest read first. Empty for non-own or unsupported chats. */
  async listMessageReaders(key: ConversationKey, messageId: string, opts: { limit?: number } = {}): Promise<MessageReaderRecord[]> {
    if (!['direct', 'group', 'room'].includes(key.chatType)) return [];
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 500);
    const result = await this.pool.query<{ reader_mid: string; name: string | null; last_read_at: Date }>(
      `SELECT p.reader_mid, ${MEMBER_NAME_SQL} AS name, p.last_read_at
       FROM messages m
       JOIN line_accounts la ON la.account_id = m.account_id
       JOIN message_read_positions p ON p.account_id = m.account_id AND p.chat_type = m.chat_type AND p.chat_id = m.chat_id
       LEFT JOIN conversation_members cm ON cm.account_id = p.account_id AND cm.chat_type = p.chat_type
         AND cm.chat_id = p.chat_id AND cm.member_id = p.reader_mid
       LEFT JOIN line_contacts member_contact ON member_contact.account_id = p.account_id AND member_contact.mid = p.reader_mid
       WHERE m.account_id = $1 AND m.chat_type = $2 AND m.chat_id = $3 AND m.message_id = $4
         AND ${ownMessageSql('m', 'la')} AND ${NUMERIC_ID_SQL('m.message_id')} IS NOT NULL
         AND ${NUMERIC_ID_SQL('p.last_read_message_id')} >= ${NUMERIC_ID_SQL('m.message_id')}
       ORDER BY p.last_read_at DESC, p.reader_mid LIMIT $5`,
      [key.accountId, key.chatType, key.chatId, messageId, limit]);
    return result.rows.map((row) => ({ mid: row.reader_mid, name: row.name ?? '', readAt: row.last_read_at.toISOString() }));
  }

  async listAttachmentStates(key: ConversationKey, attachmentIds: readonly string[], automaticAttemptLimit = 3): Promise<AttachmentStateRecord[]> {
    if (attachmentIds.length > 225) throw new Error('Attachment state lookup exceeds 225 IDs');
    if (attachmentIds.length === 0) return [];
    const result = await this.boundedRead<{
      attachment_id: string; message_id: string; kind: Attachment['kind']; name: string; mime_type: string;
      size_bytes: string | number; status: Attachment['status']; can_retry_manually: boolean; block_reason: string | null;
    }>(
      `SELECT a.attachment_id, a.message_id, a.kind, COALESCE(NULLIF(BTRIM(a.name), ''), '') AS name,
         COALESCE(a.mime_type,'application/octet-stream') AS mime_type, COALESCE(a.size_bytes,0) AS size_bytes,
         CASE WHEN a.status <> 'ready' AND m.occurred_at < now() - interval '7 days'
             AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
               AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR') THEN 'expired'
           WHEN a.status='failed' AND a.retry_count < $5 AND a.retry_after IS DISTINCT FROM 'infinity'::timestamptz
             AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
               AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR')
           THEN 'queued' ELSE a.status END AS status,
         COALESCE(la.status='connected' AND (m.occurred_at >= now() - interval '7 days' OR NOT EXISTS (SELECT 1 FROM message_source_provenance p
             WHERE p.account_id=a.account_id AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR'))
           AND (a.status='expired' OR (a.status='failed' AND (a.retry_count >= $5 OR a.retry_after='infinity'::timestamptz
             OR EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
               AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR')))
           OR (a.status='queued' AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
             AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR'))), FALSE) AS can_retry_manually,
         CASE WHEN a.status='queued' AND a.error = ANY($6::text[]) THEN a.error END AS block_reason
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.chat_type=a.chat_type
         AND m.chat_id=a.chat_id AND m.message_id=a.message_id
       JOIN line_accounts la ON la.account_id=a.account_id
       WHERE a.account_id=$1 AND a.chat_type=$2 AND a.chat_id=$3 AND a.attachment_id=ANY($4::uuid[])
       LIMIT 225`,
      [key.accountId, key.chatType, key.chatId, [...new Set(attachmentIds)], automaticAttemptLimit, [...ATTACHMENT_BLOCK_REASONS]],
    );
    return result.rows.map((row) => ({ attachmentId: row.attachment_id, messageId: row.message_id, kind: row.kind,
      name: row.name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), status: row.status,
      canRetryManually: row.can_retry_manually,
      ...(row.status === 'queued' && isAttachmentBlockReason(row.block_reason) ? { blockReason: row.block_reason } : {}) }));
  }

  async listAttachmentActivity(limit = 100): Promise<AttachmentActivityRecord[]> {
    const result = await this.boundedRead<{
      account_id: string; chat_type: ConversationKey['chatType']; chat_id: string;
      kind: Attachment['kind']; status: Attachment['status']; retry_count: number; updated_at: Date;
    }>(
      `SELECT a.account_id, c.chat_type, a.chat_id, a.kind, a.status, a.retry_count, a.updated_at
       FROM attachments a JOIN conversations c ON c.account_id = a.account_id AND c.chat_type = a.chat_type AND c.chat_id = a.chat_id
       JOIN line_accounts la ON la.account_id = a.account_id AND la.connection_mode <> 'EXTERNAL_MONITOR'
       ORDER BY a.updated_at DESC, a.attachment_id DESC LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
    );
    return result.rows.map((row) => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      kind: row.kind, status: row.status, retryCount: row.retry_count, updatedAt: row.updated_at.toISOString() }));
  }

  async listTerminalAttachmentErrors(limit = 100, automaticAttemptLimit = 3): Promise<TerminalAttachmentErrorRecord[]> {
    const result = await this.boundedRead<{
      account_id: string; chat_type: ConversationKey['chatType']; chat_id: string;
      kind: Attachment['kind']; status: 'failed' | 'expired'; retry_count: number; updated_at: Date;
    }>(
      `SELECT a.account_id, c.chat_type, a.chat_id, a.kind, a.status, a.retry_count, a.updated_at
       FROM attachments a JOIN conversations c ON c.account_id = a.account_id AND c.chat_type = a.chat_type AND c.chat_id = a.chat_id
       JOIN line_accounts la ON la.account_id = a.account_id AND la.connection_mode <> 'EXTERNAL_MONITOR'
       WHERE a.status = 'expired' OR (a.status = 'failed' AND (a.retry_count >= $1 OR a.retry_after = 'infinity'::timestamptz))
       ORDER BY a.updated_at DESC, a.attachment_id DESC LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
      [automaticAttemptLimit],
    );
    return result.rows.map((row) => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      kind: row.kind, status: row.status, retryCount: row.retry_count, updatedAt: row.updated_at.toISOString() }));
  }

  async markConversationRead(key: ConversationKey): Promise<void> {
    await this.pool.query('UPDATE conversations SET unread_count=0, updated_at=now() WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [key.accountId, key.chatType, key.chatId]);
  }

  async listAttachments(key: ConversationKey, before: string | null, limit: number): Promise<{
    attachments: Array<Pick<Attachment, 'attachmentId' | 'accountId' | 'chatType' | 'chatId' | 'messageId' | 'kind' | 'name' | 'mimeType' | 'status' | 'sizeBytes'>>;
    nextCursor: string | null;
  }> {
    const result = await this.pool.query<{
      attachment_id: string; account_id: string; chat_type: Attachment['chatType']; chat_id: string; message_id: string;
      kind: Attachment['kind']; name: string; mime_type: string | null; status: Attachment['status']; size_bytes: string | null;
    }>(
      `SELECT a.attachment_id, a.account_id, a.chat_type, a.chat_id, a.message_id, a.kind, ${ATTACHMENT_DISPLAY_NAME_SQL} AS name,
         a.mime_type, a.status, a.size_bytes FROM attachments a
       WHERE a.account_id = $1 AND a.chat_type = $2 AND a.chat_id = $3
         AND ($4::uuid IS NULL OR (a.created_at, a.attachment_id) < (
           SELECT created_at, attachment_id FROM attachments WHERE attachment_id = $4))
       ORDER BY a.created_at DESC, a.attachment_id DESC LIMIT $5`,
      [key.accountId, key.chatType, key.chatId, before, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    return { attachments: page.map((row) => ({ attachmentId: row.attachment_id, accountId: row.account_id,
      chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id, kind: row.kind, name: row.name,
      mimeType: row.mime_type, status: row.status, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes) })),
      nextCursor: result.rows.length > limit ? page.at(-1)!.attachment_id : null };
  }

  async wasDeliveredByAgent(key: ConversationKey, lineMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM agent_deliveries WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
       AND status = 'sent' AND line_message_id = $4 LIMIT 1`,
      [key.accountId, key.chatType, key.chatId, lineMessageId],
    );
    return result.rowCount === 1;
  }

  async getAttachment(attachmentId: string): Promise<Attachment | null> {
    const result = await this.pool.query<{
      attachment_id: string; external_attachment_id: string; account_id: string; chat_type: Attachment['chatType']; chat_id: string; message_id: string; kind: Attachment['kind']; name: string | null; mime_type: string | null; status: Attachment['status']; relative_path: string | null; sha256: string | null; size_bytes: string | null; error: string | null; occurred_at: Date; retry_count: number; retry_after: string | null; created_at: Date; expires_at: string | null; updated_at: Date; raw: JsonValue; external_source: boolean;
    }>(`SELECT a.attachment_id, a.external_attachment_id, a.account_id, a.chat_type, a.chat_id, a.message_id,
        a.kind, a.name, a.mime_type,
        CASE WHEN a.status <> 'ready' AND m.occurred_at < now() - interval '7 days'
          AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
            AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR') THEN 'expired' ELSE a.status END AS status,
        a.relative_path, a.sha256, a.size_bytes, a.error,
        m.occurred_at, a.retry_count, a.retry_after::text AS retry_after, a.created_at, a.expires_at::text AS expires_at, a.updated_at, m.raw,
        EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id AND p.message_id=a.message_id
          AND p.origin='EXTERNAL_MONITOR') AS external_source FROM attachments a JOIN messages m
        ON m.account_id = a.account_id AND m.chat_type = a.chat_type AND m.chat_id = a.chat_id AND m.message_id = a.message_id
        WHERE a.attachment_id = $1`, [attachmentId]);
    const row = result.rows[0];
    if (!row) return null;
    const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)
      ? row.raw as Record<string, JsonValue> : {};
    const nativePayload = NativeSourceEnvelopeSchema.safeParse(raw.native);
    return { attachmentId: row.attachment_id, externalAttachmentId: row.external_attachment_id, accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id, kind: row.kind, name: row.name, mimeType: row.mime_type, status: row.status, relativePath: row.relative_path, sha256: row.sha256, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), error: row.error, occurredAt: row.occurred_at.toISOString(), retryCount: row.retry_count, retryAfter: row.retry_after, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at, updatedAt: row.updated_at.toISOString(), lineMessage: raw.message ?? raw,
      externalSource: row.external_source, ...(nativePayload.success && nativePayload.data.table === '_message' ? { nativePayload: nativePayload.data } : {}) };
  }

  async getRecentExternalAttachmentsForDownloadProbe(accountId: string, limit = 5): Promise<Attachment[]> {
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(16, Math.trunc(limit))) : 5;
    const result = await this.pool.query<{
      attachment_id: string; external_attachment_id: string; account_id: string; chat_type: Attachment['chatType']; chat_id: string; message_id: string; kind: Attachment['kind']; name: string | null; mime_type: string | null; status: Attachment['status']; relative_path: string | null; sha256: string | null; size_bytes: string | null; error: string | null; occurred_at: Date; retry_count: number; retry_after: string | null; created_at: Date; expires_at: string | null; updated_at: Date; raw: JsonValue;
    }>(`SELECT a.attachment_id, a.external_attachment_id, a.account_id, a.chat_type, a.chat_id, a.message_id,
        a.kind, a.name, a.mime_type, a.status, a.relative_path, a.sha256, a.size_bytes, a.error,
        m.occurred_at, a.retry_count, a.retry_after::text AS retry_after, a.created_at, a.expires_at::text AS expires_at, a.updated_at, m.raw
        FROM attachments a JOIN messages m
        ON m.account_id = a.account_id AND m.chat_type = a.chat_type AND m.chat_id = a.chat_id AND m.message_id = a.message_id
        WHERE a.account_id = $1
          AND a.chat_type IN ('direct', 'group', 'room')
          AND m.occurred_at >= now() - interval '7 days'
          AND jsonb_typeof(m.raw -> 'native') = 'object'
          AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id = a.account_id
            AND p.message_id = a.message_id AND p.origin = 'EXTERNAL_MONITOR')
        ORDER BY m.occurred_at DESC, a.created_at DESC, a.attachment_id DESC
        LIMIT $2`, [accountId, boundedLimit]);
    const items: Attachment[] = [];
    for (const row of result.rows) {
      const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)
        ? row.raw as Record<string, JsonValue> : {};
      const nativePayload = NativeSourceEnvelopeSchema.safeParse(raw.native);
      if (!nativePayload.success || nativePayload.data.table !== '_message') continue;
      items.push({
        attachmentId: row.attachment_id, externalAttachmentId: row.external_attachment_id, accountId: row.account_id,
        chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id, kind: row.kind, name: row.name,
        mimeType: row.mime_type, status: row.status, relativePath: row.relative_path, sha256: row.sha256,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), error: row.error,
        occurredAt: row.occurred_at.toISOString(), retryCount: row.retry_count, retryAfter: row.retry_after,
        createdAt: row.created_at.toISOString(), expiresAt: row.expires_at, updatedAt: row.updated_at.toISOString(),
        lineMessage: raw.message ?? raw, externalSource: true, nativePayload: nativePayload.data,
      });
    }
    return items;
  }

  async claimAttachmentDownload(mutation: AttachmentMutation & { ownerId: string }, options: { manual?: boolean; expected?: AttachmentPriorState; automaticAttemptLimit?: number } = {}): Promise<string | null> {
    const attemptToken = randomUUID();
    return this.withAttachmentTransaction(async (client) => {
      await client.query('INSERT INTO attachment_execution_owners(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING', [mutation.ownerId]);
      const owner = await client.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM attachment_execution_owners WHERE owner_id = $1 FOR SHARE', [mutation.ownerId]);
      if (!owner.rows[0] || owner.rows[0].revoked_at) return null;
      const account = await client.query<{ worker_instance_id: string | null; worker_binding_epoch: string | null }>(
        'SELECT worker_instance_id, worker_binding_epoch FROM line_accounts WHERE account_id = $1 FOR SHARE', [mutation.accountId]);
      const binding = account.rows[0];
      if (binding?.worker_instance_id !== mutation.workerInstanceId || Number(binding?.worker_binding_epoch) !== mutation.controlEpoch) return null;
      const result = await client.query<{ attachment_id: string }>(
      `UPDATE attachments SET status = 'downloading', download_worker_instance_id = $5, download_worker_binding_epoch = $6,
         download_lease_expires_at = now() + interval '3 minutes', download_attempt_token = $7, download_owner_id = $8,
         retry_count = CASE WHEN $9::boolean THEN retry_count + 1 ELSE retry_count + 1 END,
         retry_after = CASE WHEN $9::boolean THEN 'infinity'::timestamptz ELSE NULL END,
         expires_at = COALESCE(expires_at, CASE WHEN EXISTS (SELECT 1 FROM message_source_provenance p
           WHERE p.account_id=attachments.account_id AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           THEN NULL ELSE created_at + interval '7 days' END),
         error = NULL, updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND (NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
           AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR') OR EXISTS (
           SELECT 1 FROM messages m WHERE m.account_id=attachments.account_id AND m.chat_type=attachments.chat_type
             AND m.chat_id=attachments.chat_id AND m.message_id=attachments.message_id
             AND m.occurred_at >= now() - interval '7 days'))
         AND ((NOT $9::boolean AND status IN ('queued', 'failed') AND NOT EXISTS (SELECT 1 FROM message_source_provenance p
               WHERE p.account_id=attachments.account_id AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
               AND retry_count < $14::integer
               AND retry_after IS DISTINCT FROM 'infinity'::timestamptz AND (retry_after <= now() OR (status = 'queued' AND retry_after IS NULL) OR (retry_after IS NULL AND updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) <= now())) AND COALESCE(expires_at, created_at + interval '7 days') > now())
         OR ($9::boolean AND ((status IN ('failed', 'expired') AND (status = 'expired' OR retry_count >= $14::integer OR retry_after = 'infinity'::timestamptz
             OR EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
               AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')))
             OR (status='queued' AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
               AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')))))
         AND ($10::text IS NULL OR status = $10)
         AND ($11::integer IS NULL OR retry_count = $11)
         AND (NOT $13::boolean OR retry_after IS NOT DISTINCT FROM $12::timestamptz)
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId,
        mutation.controlEpoch, attemptToken, mutation.ownerId, options.manual === true,
        options.expected?.status ?? null, options.expected?.retryCount ?? null, options.expected?.retryAfter ?? null,
        options.expected !== undefined, options.automaticAttemptLimit ?? 3],
    );
    return result.rowCount === 1 ? attemptToken : null;
    });
  }

  async recoverAttachments(accountId?: string, afterAttachmentId?: string, automaticAttemptLimit = 3): Promise<string[]> {
    return this.withAttachmentTransaction(async (client) => {
      await this.recoverAttachmentRows(client, accountId, automaticAttemptLimit);
      const result = await client.query<{ attachment_id: string }>(
        `SELECT attachment_id FROM attachments WHERE status IN ('queued','failed')
           AND ($1::text IS NULL OR account_id = $1)
           AND ($2::uuid IS NULL OR attachment_id > $2::uuid)
           AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
             AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           AND retry_count < $3 AND retry_after IS DISTINCT FROM 'infinity'::timestamptz
           AND COALESCE(expires_at, created_at + interval '7 days') > now()
           AND (retry_after <= now() OR (status = 'queued' AND retry_after IS NULL) OR (retry_after IS NULL AND updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) <= now())) ORDER BY attachment_id LIMIT 256`, [accountId ?? null, afterAttachmentId ?? null, automaticAttemptLimit],
      );
      return result.rows.map((row) => row.attachment_id);
    });
  }

  private async recoverAttachmentRows(client: PoolClient, accountId?: string, automaticAttemptLimit = 3): Promise<void> {
    await client.query(
      `UPDATE attachments SET status = 'expired', download_attempt_token = NULL, download_owner_id = NULL,
         download_worker_instance_id = NULL, download_worker_binding_epoch = NULL, download_lease_expires_at = NULL,
         error = COALESCE(NULLIF(error, ''), 'Attachment retry expired'), updated_at = now()
       WHERE ($1::text IS NULL OR account_id = $1) AND status IN ('queued','failed')
         AND ((expires_at IS NOT NULL AND expires_at <= now()) OR (NOT EXISTS (SELECT 1 FROM message_source_provenance p
           WHERE p.account_id=attachments.account_id AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           AND created_at + interval '7 days' <= now())
           -- An External Monitor row expires 7 days after the message time. The UI already projects this state.
           OR (EXISTS (SELECT 1 FROM message_source_provenance p
             WHERE p.account_id=attachments.account_id AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id=attachments.account_id AND m.chat_type=attachments.chat_type
             AND m.chat_id=attachments.chat_id AND m.message_id=attachments.message_id
             AND m.occurred_at < now() - interval '7 days')))`, [accountId ?? null],
    );
    await client.query(
      `UPDATE attachments a SET status = CASE WHEN a.expires_at <= now() THEN 'expired' ELSE 'failed' END,
         retry_after = CASE WHEN a.retry_after = 'infinity'::timestamptz THEN a.retry_after
           WHEN a.expires_at <= now() OR a.retry_count >= $2 THEN NULL
           ELSE now() + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(a.retry_count - 1, 0))) END,
         download_attempt_token = NULL, download_owner_id = NULL, download_worker_instance_id = NULL, download_worker_binding_epoch = NULL,
         download_lease_expires_at = NULL, updated_at = now()
       WHERE ($1::text IS NULL OR a.account_id = $1) AND a.status = 'downloading'
         AND (a.download_attempt_token IS NULL OR a.download_owner_id IS NULL OR a.download_lease_expires_at IS NULL
           OR a.download_lease_expires_at <= now() OR NOT EXISTS (
           SELECT 1 FROM line_accounts owner
           WHERE owner.account_id = a.account_id AND owner.worker_instance_id = a.download_worker_instance_id
             AND owner.worker_binding_epoch = a.download_worker_binding_epoch
         ) OR NOT EXISTS (SELECT 1 FROM attachment_execution_owners attempt_owner
           WHERE attempt_owner.owner_id = a.download_owner_id AND attempt_owner.revoked_at IS NULL))`, [accountId ?? null, automaticAttemptLimit],
    );
  }

  async recoverAttachmentPage(afterAccountId: string | null, limit = 16, automaticAttemptLimit = 3): Promise<{
    items: Array<{ accountId: string; attachmentId: string }>;
    hasMore: boolean;
  }> {
    return this.withAttachmentTransaction(async (client) => {
      await this.recoverAttachmentRows(client, undefined, automaticAttemptLimit);
      const result = await client.query<{ account_id: string; attachment_id: string }>(
        `SELECT accounts.account_id, candidate.attachment_id
         FROM (SELECT DISTINCT account_id FROM attachments WHERE status IN ('queued','failed')
           AND retry_count < $3::integer AND retry_after IS DISTINCT FROM 'infinity'::timestamptz
           AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
             AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           AND COALESCE(expires_at, created_at + interval '7 days') > now()
           AND (retry_after <= now() OR (status = 'queued' AND retry_after IS NULL) OR (retry_after IS NULL AND updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) <= now()))
           AND ($1::text IS NULL OR account_id > $1)) accounts
         CROSS JOIN LATERAL (
           SELECT attachment_id FROM attachments WHERE account_id = accounts.account_id
             AND status IN ('queued','failed') AND retry_count < $3::integer AND retry_after IS DISTINCT FROM 'infinity'::timestamptz
             AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
               AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
             AND COALESCE(expires_at, created_at + interval '7 days') > now() AND (retry_after <= now() OR (status = 'queued' AND retry_after IS NULL) OR (retry_after IS NULL AND updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) <= now()))
           ORDER BY created_at, attachment_id LIMIT 1
         ) candidate
         ORDER BY accounts.account_id LIMIT $2`, [afterAccountId, Math.max(1, Math.min(64, limit)), automaticAttemptLimit],
      );
      const items = result.rows.map((row) => ({ accountId: row.account_id, attachmentId: row.attachment_id }));
      const hasMore = items.length > 0 && Boolean((await client.query(
        `SELECT 1 FROM attachments WHERE status IN ('queued','failed') AND retry_count < $2::integer AND retry_after IS DISTINCT FROM 'infinity'::timestamptz
         AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
           AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
         AND COALESCE(expires_at, created_at + interval '7 days') > now() AND (retry_after <= now() OR (status = 'queued' AND retry_after IS NULL) OR (retry_after IS NULL AND updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) <= now()))
         AND account_id > $1 LIMIT 1`, [items.at(-1)!.accountId, automaticAttemptLimit],
      )).rowCount);
      return { items, hasMore };
    });
  }

  async nextAttachmentWakeAt(automaticAttemptLimit = 3): Promise<number | null> {
    const result = await this.pool.query<{ wake_at: Date | null }>(
      `SELECT min(wake_at) AS wake_at FROM (
         SELECT COALESCE(expires_at, created_at + interval '7 days') AS wake_at FROM attachments
           WHERE status IN ('queued','failed') AND COALESCE(expires_at, created_at + interval '7 days') IS DISTINCT FROM 'infinity'::timestamptz
           AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
             AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
           AND COALESCE(expires_at, created_at + interval '7 days') > now()
         UNION ALL
         SELECT COALESCE(retry_after, updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0)))) AS wake_at
           FROM attachments WHERE status = 'failed' AND retry_count < $1 AND retry_after IS DISTINCT FROM 'infinity'::timestamptz
             AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=attachments.account_id
               AND p.message_id=attachments.message_id AND p.origin='EXTERNAL_MONITOR')
             AND COALESCE(retry_after, updated_at + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0)))) > now()
         UNION ALL
         SELECT download_lease_expires_at AS wake_at FROM attachments
           WHERE status = 'downloading' AND download_lease_expires_at IS DISTINCT FROM 'infinity'::timestamptz
             AND download_lease_expires_at > now()
       ) due WHERE wake_at > now()`,
      [automaticAttemptLimit],
    );
    return result.rows[0]?.wake_at?.getTime() ?? null;
  }

  /**
   * Keep the reason why a queued attachment cannot download now in `error`.
   * It writes only when the value changes, and only on a queued row with no error or with a block reason.
   * It does not claim the row and does not change the retry count or the download order.
   */
  async setAttachmentBlockReason(attachmentId: string, reason: AttachmentBlockReason): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE attachments SET error = $2 WHERE attachment_id = $1 AND status = 'queued'
         AND error IS DISTINCT FROM $2 AND (error IS NULL OR error = ANY($3::text[]))`,
      [attachmentId, reason, [...ATTACHMENT_BLOCK_REASONS]]);
    return result.rowCount === 1;
  }

  /**
   * One bounded backfill for old External Monitor rows. No scan selects them, so they keep no reason.
   * It returns the number of rows changed. The caller repeats it while the count equals the limit.
   */
  async backfillExternalAttachmentBlockReasons(limit = 1000): Promise<number> {
    const bounded = Math.max(1, Math.min(5000, Math.trunc(limit)));
    const result = await this.pool.query(
      `UPDATE attachments SET error = 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' WHERE attachment_id IN (
         SELECT a.attachment_id FROM attachments a WHERE a.status = 'queued' AND a.error IS NULL
           AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
             AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR')
         ORDER BY a.attachment_id LIMIT $1)`, [bounded]);
    return result.rowCount ?? 0;
  }

  async getAttachmentBySource(key: ConversationKey, messageId: string, externalAttachmentId: string): Promise<Attachment | null> {
    const result = await this.pool.query<{ attachment_id: string }>(
      `SELECT attachment_id FROM attachments WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
       AND message_id = $4 AND external_attachment_id = $5`,
      [key.accountId, key.chatType, key.chatId, messageId, externalAttachmentId],
    );
    return result.rows[0] ? this.getAttachment(result.rows[0].attachment_id) : null;
  }

  async markAttachmentDownloading(mutation: AttachmentMutation & { ownerId?: string }): Promise<boolean> {
    const attemptToken = randomUUID();
    const ownerId = mutation.ownerId ?? randomUUID();
    const result = await this.withAttachmentTransaction(async (client) => {
      await client.query('INSERT INTO attachment_execution_owners(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING', [ownerId]);
      const account = await client.query<{ worker_instance_id: string | null; worker_binding_epoch: string | null }>(
        'SELECT worker_instance_id, worker_binding_epoch FROM line_accounts WHERE account_id = $1 FOR SHARE', [mutation.accountId]);
      if (account.rows[0]?.worker_instance_id !== mutation.workerInstanceId
        || Number(account.rows[0]?.worker_binding_epoch) !== mutation.controlEpoch) return { rowCount: 0 };
      return client.query(
      `UPDATE attachments SET status = 'downloading', download_worker_instance_id = $5, download_worker_binding_epoch = $8,
       download_lease_expires_at = now() + interval '3 minutes', download_attempt_token = $6, download_owner_id = $7,
       error = NULL, updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND status IN ('queued', 'failed')
         AND EXISTS (SELECT 1 FROM line_accounts owner WHERE owner.account_id = $2 AND owner.worker_instance_id = $5 AND owner.worker_binding_epoch = $8)
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId,
        attemptToken, ownerId, mutation.controlEpoch],
    );
    });
    return result.rowCount === 1;
  }

  private async attachmentAttemptUpdate(mutation: AttachmentAttemptMutation, query: string, values: unknown[], requireBinding = true): Promise<boolean> {
    return this.withAttachmentTransaction(async (client) => {
      const owner = await client.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM attachment_execution_owners WHERE owner_id = $1 FOR SHARE', [mutation.ownerId]);
      if (!owner.rows[0] || owner.rows[0].revoked_at) return false;
      let bindingEpoch: string | null = null;
      if (requireBinding) {
        const account = await client.query<{ worker_instance_id: string | null; worker_binding_epoch: string | null }>(
          'SELECT worker_instance_id, worker_binding_epoch FROM line_accounts WHERE account_id = $1 FOR SHARE', [mutation.accountId]);
        if (account.rows[0]?.worker_instance_id !== mutation.workerInstanceId) return false;
        bindingEpoch = account.rows[0].worker_binding_epoch;
        if (bindingEpoch === null) return false;
      }
      const result = await client.query(query, requireBinding ? [...values, bindingEpoch] : values);
      return result.rowCount === 1;
    });
  }

  async markAttachmentReady(mutation: AttachmentAttemptMutation, data: { relativePath: string; sha256: string; sizeBytes: number; name?: string }): Promise<boolean> {
    return this.attachmentAttemptUpdate(mutation,
      `UPDATE attachments SET status = 'ready', relative_path = $6, sha256 = $7, size_bytes = $8,
         download_lease_expires_at = NULL, download_attempt_token = NULL, download_owner_id = NULL, download_worker_binding_epoch = NULL,
         retry_after = NULL,
         name = COALESCE($9, name), error = NULL, updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND download_worker_instance_id = $5 AND status = 'downloading'
         AND download_attempt_token = $10 AND download_owner_id = $11
         AND download_worker_binding_epoch = $12
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId, data.relativePath,
        data.sha256, data.sizeBytes, data.name ?? null, mutation.attemptToken, mutation.ownerId],
    );
  }

  async markAttachmentFailed(mutation: AttachmentAttemptMutation, error: string, automaticAttemptLimit = 3): Promise<boolean> {
    return this.attachmentAttemptUpdate(mutation,
      `UPDATE attachments SET status = 'failed', download_lease_expires_at = NULL, download_attempt_token = NULL, download_owner_id = NULL, download_worker_binding_epoch = NULL, error = $6,
         retry_after = CASE WHEN retry_after = 'infinity'::timestamptz THEN retry_after
           WHEN retry_count >= $9 THEN NULL ELSE now() + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) END,
         updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND download_worker_instance_id = $5 AND status = 'downloading'
         AND download_attempt_token = $7 AND download_owner_id = $8
         AND download_worker_binding_epoch = $10
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId, error,
        mutation.attemptToken, mutation.ownerId, automaticAttemptLimit],
    );
  }

  async markAttachmentExpired(mutation: AttachmentAttemptMutation, error: string): Promise<boolean> {
    return this.attachmentAttemptUpdate(mutation,
      `UPDATE attachments SET status = 'expired', download_lease_expires_at = NULL, download_attempt_token = NULL, download_owner_id = NULL, download_worker_binding_epoch = NULL, error = $6, updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND download_worker_instance_id = $5 AND status = 'downloading'
         AND download_attempt_token = $7 AND download_owner_id = $8
         AND download_worker_binding_epoch = $9
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId, error,
        mutation.attemptToken, mutation.ownerId],
    );
  }

  async cancelAttachmentDownload(mutation: AttachmentAttemptMutation, automaticAttemptLimit = 3): Promise<boolean> {
    return this.attachmentAttemptUpdate(mutation,
      `UPDATE attachments SET status = 'failed', download_lease_expires_at = NULL, download_attempt_token = NULL, download_worker_binding_epoch = NULL,
         download_owner_id = NULL, download_worker_instance_id = NULL, error = 'Attachment download cancelled',
         retry_after = CASE WHEN retry_after = 'infinity'::timestamptz THEN retry_after WHEN retry_count >= $8 THEN NULL
           ELSE now() + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) END,
         updated_at = now()
       WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
         AND download_worker_instance_id = $5 AND status = 'downloading' AND download_attempt_token = $6 AND download_owner_id = $7
       RETURNING attachment_id`,
      [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId,
        mutation.attemptToken, mutation.ownerId, automaticAttemptLimit], false,
    );
  }

  async cancelAttachmentDownloadBeforeDispatch(
    mutation: AttachmentAttemptMutation,
    prior: AttachmentPriorState,
  ): Promise<boolean> {
    return this.withAttachmentTransaction(async (client) => {
      const owner = await client.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM attachment_execution_owners WHERE owner_id = $1 FOR SHARE', [mutation.ownerId]);
      if (!owner.rows[0] || owner.rows[0].revoked_at) return false;
      const result = await client.query(
        `UPDATE attachments SET status = $8, retry_count = $9, retry_after = $10::timestamptz,
           expires_at = $11::timestamptz, error = $12, download_lease_expires_at = NULL,
           download_attempt_token = NULL, download_owner_id = NULL, download_worker_instance_id = NULL,
           download_worker_binding_epoch = NULL, updated_at = now()
         WHERE attachment_id = $1 AND account_id = $2 AND chat_type = $3 AND chat_id = $4
           AND download_worker_instance_id = $5 AND status = 'downloading'
           AND download_attempt_token = $6 AND download_owner_id = $7
         RETURNING attachment_id`,
        [mutation.attachmentId, mutation.accountId, mutation.chatType, mutation.chatId, mutation.workerInstanceId,
          mutation.attemptToken, mutation.ownerId, prior.status, prior.retryCount, prior.retryAfter, prior.expiresAt, prior.error],
      );
      return result.rowCount === 1;
    });
  }

  async revokeAttachmentOwner(ownerId: string, automaticAttemptLimit = 3): Promise<void> {
    await this.withAttachmentTransaction(async (client) => {
      await client.query(
        `INSERT INTO attachment_execution_owners(owner_id, revoked_at) VALUES ($1, now())
         ON CONFLICT(owner_id) DO UPDATE SET revoked_at = COALESCE(attachment_execution_owners.revoked_at, now())`, [ownerId]);
      await client.query(
      `UPDATE attachments SET status = 'failed', download_lease_expires_at = NULL, download_attempt_token = NULL, download_worker_binding_epoch = NULL,
         download_owner_id = NULL, download_worker_instance_id = NULL, error = 'Attachment owner stopped',
         retry_after = CASE WHEN retry_after = 'infinity'::timestamptz THEN retry_after WHEN retry_count >= $2 THEN NULL
           ELSE now() + LEAST(interval '300 seconds', interval '10 seconds' * power(2, GREATEST(retry_count - 1, 0))) END,
         updated_at = now() WHERE status = 'downloading' AND download_owner_id = $1`, [ownerId, automaticAttemptLimit],
      );
    });
  }

  async createWorkRecord(title: string, references: ReadonlyArray<{ key: ConversationKey; messageId: string }>): Promise<string> {
    const client = await this.pool.connect();
    const workRecordId = randomUUID();
    try {
      await client.query('BEGIN');
      const first = references[0];
      await client.query(
        'INSERT INTO work_records (work_record_id, title, account_id, chat_type, chat_id) VALUES ($1, $2, $3, $4, $5)',
        [workRecordId, title, first?.key.accountId ?? null, first?.key.chatType ?? null, first?.key.chatId ?? null],
      );
      for (const reference of references) {
        await client.query(
          'INSERT INTO work_record_messages (work_record_id, account_id, chat_type, chat_id, message_id) VALUES ($1, $2, $3, $4, $5)',
          [workRecordId, reference.key.accountId, reference.key.chatType, reference.key.chatId, reference.messageId],
        );
      }
      await client.query('COMMIT');
      return workRecordId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listWorkRecordMessages(workRecordId: string): Promise<Array<ConversationKey & { messageId: string }>> {
    const result = await this.pool.query<{ account_id: string; chat_type: ConversationKey['chatType']; chat_id: string; message_id: string }>(
      'SELECT account_id, chat_type, chat_id, message_id FROM work_record_messages WHERE work_record_id = $1 ORDER BY account_id, chat_type, chat_id, message_id',
      [workRecordId],
    );
    return result.rows.map((row) => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id }));
  }

  async listConversationTargets(
    input: {
      accountIds: readonly string[];
      /** When set, SQL restricts rows to exactly this conversation. */
      conversationScope?: ConversationKey;
      /** Further chats of the same account that stay visible next to conversationScope (linked folders). */
      extraConversationScopes?: readonly Pick<ConversationKey, 'chatType' | 'chatId'>[];
      chatType?: ConversationKey['chatType'];
      /** Restricts rows to these chat types (applied in SQL, before the limit). */
      chatTypes?: readonly ConversationKey['chatType'][];
      query?: string;
      limit?: number;
      /** Non-admin principals: member and conversation names ignore the owner's local nicknames. */
      ownLineNamesOnly?: boolean;
      /** Write-side callers read only the listed accounts and skip the Agent lineage expansion. */
      currentAccountOnly?: boolean;
    },
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<McpTargetSummary[]> {
    if (input.accountIds.length === 0) return [];
    const lineage = input.currentAccountOnly
      ? { accountIds: [...input.accountIds], order: [] as string[], scopeAccountIds: input.conversationScope ? [input.conversationScope.accountId] : null }
      : await expandAgentLineage(queryable, input.accountIds, input.conversationScope?.accountId);
    const names = nameFragments(input.ownLineNamesOnly === true);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const search = input.query?.trim() ? input.query.trim() : null;
    const result = await queryable.query<{
      account_id: string;
      account_display_name: string | null;
      chat_type: ConversationKey['chatType'];
      chat_id: string;
      conversation_title: string | null;
      members: Array<{ memberId: string; displayName: string | null }>;
    }>(
      `SELECT c.account_id,
              NULLIF(la.display_name, '') AS account_display_name,
              c.chat_type,
              c.chat_id,
              ${names.title} AS conversation_title,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'memberId', cm.member_id,
                    'displayName', ${names.member}
                  ) ORDER BY cm.member_id ASC
                ) FILTER (WHERE cm.member_id IS NOT NULL),
                '[]'::jsonb
              ) AS members
       FROM conversations c
       JOIN line_accounts la ON la.account_id = c.account_id
       ${PEER_CONTACT_JOIN}
       LEFT JOIN conversation_members cm
         ON cm.account_id = c.account_id
        AND cm.chat_type = c.chat_type
        AND cm.chat_id = c.chat_id
       LEFT JOIN line_contacts member_contact
         ON member_contact.account_id = c.account_id
        AND c.chat_type NOT IN ('community', 'thread')
        AND member_contact.mid = cm.member_id
       WHERE c.account_id = ANY($1::text[])
         AND c.chat_id <> '__local_agent_room__'
         AND ($5::text[] IS NULL OR (c.account_id = ANY($5::text[]) AND c.chat_type = $6 AND c.chat_id = $7)
           OR EXISTS (SELECT 1 FROM jsonb_to_recordset($8::jsonb) AS x(chat_type text, chat_id text)
                      WHERE c.account_id = ANY($5::text[]) AND x.chat_type = c.chat_type AND x.chat_id = c.chat_id))
         AND (cardinality($10::text[]) = 0 OR NOT EXISTS (
           SELECT 1 FROM conversations c2 WHERE c2.account_id = ANY($1::text[]) AND c2.chat_type = c.chat_type AND c2.chat_id = c.chat_id
             AND array_position($10::text[], c2.account_id) < array_position($10::text[], c.account_id)))
         AND ($2::text IS NULL OR c.chat_type = $2)
         AND ($9::text[] IS NULL OR c.chat_type = ANY($9::text[]))
         AND (
           $3::text IS NULL
           OR position(lower($3) in lower(coalesce(${names.title}, ''))) > 0
           OR position(lower($3) in lower(${names.nickname('peer_contact')})) > 0
           OR position(lower($3) in lower(coalesce(peer_contact.display_name, ''))) > 0
           OR position(lower($3) in lower(c.chat_id)) > 0
           OR EXISTS (
             SELECT 1 FROM conversation_members cm_match
             LEFT JOIN line_contacts match_contact
               ON match_contact.account_id = cm_match.account_id
              AND cm_match.chat_type NOT IN ('community', 'thread')
              AND match_contact.mid = cm_match.member_id
             WHERE cm_match.account_id = c.account_id
               AND cm_match.chat_type = c.chat_type
               AND cm_match.chat_id = c.chat_id
               AND (
                 position(lower($3) in lower(coalesce(cm_match.display_name, ''))) > 0
                 OR position(lower($3) in lower(${names.nickname('match_contact')})) > 0
                 OR position(lower($3) in lower(coalesce(match_contact.display_name, ''))) > 0
                 OR position(lower($3) in lower(cm_match.member_id)) > 0
               )
           )
         )
       GROUP BY c.account_id, la.display_name, c.chat_type, c.chat_id, c.title, c.updated_at,
                peer_contact.nickname, peer_contact.display_name
       ORDER BY c.updated_at DESC, c.account_id ASC, c.chat_type ASC, c.chat_id ASC
       LIMIT $4`,
      [
        lineage.accountIds, input.chatType ?? null, search, limit,
        lineage.scopeAccountIds,
        input.conversationScope?.chatType ?? null,
        input.conversationScope?.chatId ?? null,
        JSON.stringify((input.extraConversationScopes ?? []).map((scope) => ({ chat_type: scope.chatType, chat_id: scope.chatId }))),
        input.chatTypes ? [...input.chatTypes] : null,
        lineage.order,
      ],
    );
    return mergeLineageConversations(result.rows.map((row) => ({
      accountId: row.account_id,
      accountDisplayName: row.account_display_name,
      chatType: row.chat_type,
      chatId: row.chat_id,
      conversationTitle: row.conversation_title,
      members: row.members ?? [],
    })), lineage.order);
  }

  /** The single Agent account that can write LINE (product_role AGENT, system login), or null. */
  async findAgentSendAccount(queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool): Promise<string | null> {
    const result = await queryable.query<{ account_id: string }>(
      "SELECT account_id FROM line_accounts WHERE product_role = 'AGENT' AND connection_mode = 'SYSTEM_LOGIN' LIMIT 1");
    return result.rows[0]?.account_id ?? null;
  }

  /** Send targets of one account: direct/group/room only, never the local Agent room; most recent first. */
  async listSendTargets(
    input: { accountId: string; query?: string; limit?: number },
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<SendTargetRecord[]> {
    const rows = await this.listConversationTargets({
      accountIds: [input.accountId],
      currentAccountOnly: true,
      chatTypes: SEND_CHAT_TYPES,
      ...(input.query?.trim() ? { query: input.query } : {}),
      limit: input.limit ?? 20,
    }, queryable);
    return rows.map((row, index) => ({
      no: index + 1,
      chatType: row.chatType as SendChatType,
      chatId: row.chatId,
      title: row.conversationTitle,
      members: row.members.map((member) => member.displayName).filter((name): name is string => Boolean(name)).slice(0, 5),
      memberCount: row.members.length,
    }));
  }

  /** The conversation if it exists, is not the local room and has a writable chat type; otherwise null. */
  async getSendTarget(
    accountId: string, chatType: string, chatId: string,
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<{ accountId: string; chatType: SendChatType; chatId: string } | null> {
    if (!(SEND_CHAT_TYPES as readonly string[]).includes(chatType) || chatId === '__local_agent_room__') return null;
    const result = await queryable.query<{ chat_type: SendChatType }>(
      'SELECT chat_type FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [accountId, chatType, chatId]);
    const row = result.rows[0];
    return row ? { accountId, chatType: row.chat_type, chatId } : null;
  }

  /** The archived message to forward. `masked` is true for recalled and source-deleted messages (text is then null). */
  async resolveSendSourceMessage(
    input: { accountId: string; chatType: string; chatId: string; messageId: string },
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<SendSourceMessage | null> {
    const message = await queryable.query<{ kind: string; text: string | null; masked: boolean }>(
      `SELECT m.kind, ${AGENT_VISIBLE_TEXT_SQL} AS text, COALESCE(${AGENT_MASKED_SQL}, false) AS masked
       FROM messages m
       WHERE m.account_id = $1 AND m.chat_type = $2 AND m.chat_id = $3 AND m.message_id = $4`,
      [input.accountId, input.chatType, input.chatId, input.messageId]);
    const row = message.rows[0];
    if (!row) return null;
    if (row.masked) return { kind: row.kind, text: null, masked: true, attachments: [] };
    const attachments = await queryable.query<SendAttachmentRow>(
      `SELECT a.attachment_id, a.account_id, a.kind, a.name, a.status, a.relative_path, a.sha256, a.size_bytes
       FROM attachments a
       WHERE a.account_id = $1 AND a.chat_type = $2 AND a.chat_id = $3 AND a.message_id = $4
       ORDER BY a.created_at ASC, a.attachment_id ASC`,
      [input.accountId, input.chatType, input.chatId, input.messageId]);
    return { kind: row.kind, text: row.text, masked: false, attachments: attachments.rows.map(toSendAttachment) };
  }

  /** One stored attachment plus the masked flag of its message; null when unknown. */
  async getSendAttachment(
    attachmentId: string,
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<(SendAttachment & { masked: boolean }) | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)) return null;
    const result = await queryable.query<SendAttachmentRow & { masked: boolean }>(
      `SELECT a.attachment_id, a.account_id, a.kind, a.name, a.status, a.relative_path, a.sha256, a.size_bytes, COALESCE(${AGENT_MASKED_SQL}, false) AS masked
       FROM attachments a
       JOIN messages m ON m.account_id = a.account_id AND m.chat_type = a.chat_type AND m.chat_id = a.chat_id AND m.message_id = a.message_id
       WHERE a.attachment_id = $1`,
      [attachmentId]);
    const row = result.rows[0];
    return row ? { ...toSendAttachment(row), masked: row.masked } : null;
  }

  /** Appends one audit row. It never stores message text or a file name. */
  async recordLineSend(row: LineSendAuditRow, queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    await queryable.query(
      `INSERT INTO agent_line_sends (job_id, account_id, principal_id, chat_type, chat_id, item_index, item_kind, byte_size, status, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.jobId, row.accountId, row.principalId, row.chatType, row.chatId, row.itemIndex, row.itemKind, row.byteSize, row.status, row.errorCode ?? null]);
  }

  /** Items of one job that reached LINE or may have (sent, unknown, failed); the 30-per-job cap counts these. */
  async countJobLineSends(jobId: string, queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool): Promise<number> {
    const result = await queryable.query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_line_sends WHERE job_id = $1 AND status IN ('sent','unknown','failed')", [jobId]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * Chats that have messages in the window, with counts, from the same row set queryTargetMessageRows returns for the same
   * scope and filters (messageScopeWhereSql, messageFilterWhereSql). Lineage accounts merge by (chatType, chatId) and the
   * highest-ranked account supplies the key and names, like listConversationTargets. Newest chat activity first.
   */
  async listActiveChats(
    input: {
      accountIds: readonly string[];
      conversationScope?: ConversationKey;
      extraConversationScopes?: readonly Pick<ConversationKey, 'chatType' | 'chatId'>[];
      chatType?: ConversationKey['chatType'];
      from: string;
      to?: string;
      limit: number;
      ownLineNamesOnly?: boolean;
    } & MessageFilterInput,
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<{ chats: McpActiveChat[]; truncated: boolean }> {
    if (input.accountIds.length === 0) return { chats: [], truncated: false };
    const lineage = await expandAgentLineage(queryable, input.accountIds, input.conversationScope?.accountId);
    const names = nameFragments(input.ownLineNamesOnly === true);
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const result = await queryable.query<{
      account_id: string;
      account_display_name: string | null;
      chat_type: ConversationKey['chatType'];
      chat_id: string;
      conversation_title: string | null;
      message_count: number;
      sender_count: number;
      last_message_at: Date;
    }>(
      `WITH visible AS (
         SELECT m.account_id, m.chat_type, m.chat_id, m.sender_id, m.occurred_at,
                NULLIF(la.display_name, '') AS account_display_name,
                ${names.title} AS conversation_title,
                array_position($9::text[], m.account_id) AS lineage_rank
         FROM messages m
         JOIN line_accounts la ON la.account_id = m.account_id
         LEFT JOIN conversations c
           ON c.account_id = m.account_id
          AND c.chat_type = m.chat_type
          AND c.chat_id = m.chat_id
         ${PEER_CONTACT_JOIN}
         WHERE ${messageScopeWhereSql({ accountIds: '$1', scopeAccountIds: '$5', scopeChatType: '$6', scopeChatId: '$7', extraScopes: '$8', lineageOrder: '$9' })}
           AND ${messageFilterWhereSql({ chatType: '$2', from: '$3', to: '$4', excludeChatIds: '$10', direction: '$11', kinds: '$12', excludeKinds: '$13' })}
       )
       SELECT (array_agg(account_id ORDER BY lineage_rank NULLS LAST, account_id))[1] AS account_id,
              (array_agg(account_display_name ORDER BY lineage_rank NULLS LAST, account_id))[1] AS account_display_name,
              chat_type,
              chat_id,
              (array_agg(conversation_title ORDER BY lineage_rank NULLS LAST, account_id))[1] AS conversation_title,
              count(*)::int AS message_count,
              count(DISTINCT sender_id)::int AS sender_count,
              max(occurred_at) AS last_message_at
       FROM visible
       GROUP BY chat_type, chat_id, CASE WHEN lineage_rank IS NULL THEN account_id END
       ORDER BY max(occurred_at) DESC, chat_type ASC, chat_id ASC, min(account_id) ASC
       LIMIT $14`,
      [
        lineage.accountIds,
        input.chatType ?? null,
        input.from,
        input.to ?? null,
        ...messageScopeValues(lineage, input),
        ...messageFilterValues(input),
        limit + 1,
      ],
    );
    const chats = result.rows.slice(0, limit).map((row) => ({
      accountId: row.account_id,
      accountDisplayName: row.account_display_name,
      chatType: row.chat_type,
      chatId: row.chat_id,
      conversationTitle: row.conversation_title,
      messageCount: row.message_count,
      senderCount: row.sender_count,
      lastMessageAt: row.last_message_at.toISOString(),
    }));
    return { chats, truncated: result.rows.length > limit };
  }

  async queryTargetMessages(
    input: {
      accountIds: readonly string[];
      /** When set, SQL restricts rows to exactly this conversation. */
      conversationScope?: ConversationKey;
      /** Further chats of the same account that stay visible next to conversationScope (linked folders). */
      extraConversationScopes?: readonly Pick<ConversationKey, 'chatType' | 'chatId'>[];
      target?: string;
      chatType?: ConversationKey['chatType'];
      chatId?: string;
      conversationTitle?: string;
      senderId?: string;
      senderName?: string;
      text?: string;
      from?: string;
      to?: string;
      limit?: number;
      /** Sort direction on (occurred_at, message_id); default newest first. */
      order?: 'asc' | 'desc';
      /** Keyset position: only rows strictly after this (occurredAt microsecond ISO, messageId) in `order` are returned. */
      after?: { occurredAt: string; messageId: string };
      /** Non-admin principals: sender and conversation names ignore the owner's local nicknames. */
      ownLineNamesOnly?: boolean;
    } & MessageFilterInput,
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<McpMessageRecord[]> {
    return (await this.queryTargetMessagePage(input, queryable)).messages;
  }

  /** One keyset page: `messages` holds at most `limit` rows; `lastKey` is the cursor position when `hasMore`. */
  async queryTargetMessagePage(
    input: Parameters<MessageRepository['queryTargetMessages']>[0],
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.pool,
  ): Promise<{ messages: McpMessageRecord[]; hasMore: boolean; lastKey: { occurredAt: string; messageId: string } | null }> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const rows = await this.queryTargetMessageRows({ ...input, limit: limit + 1 }, queryable);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { messages: page.map((row) => row.record), hasMore, lastKey: hasMore && last ? last.key : null };
  }

  private async queryTargetMessageRows(
    input: Parameters<MessageRepository['queryTargetMessages']>[0],
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  ): Promise<Array<{ record: McpMessageRecord; key: { occurredAt: string; messageId: string } }>> {
    if (input.accountIds.length === 0) return [];
    const lineage = await expandAgentLineage(queryable, input.accountIds, input.conversationScope?.accountId);
    const names = nameFragments(input.ownLineNamesOnly === true);
    const limit = Math.max(1, Math.min(201, Math.trunc(input.limit ?? 50)));
    const ascending = input.order === 'asc';
    const afterTime = input.after?.occurredAt ?? null;
    const afterId = input.after?.messageId ?? null;
    const target = input.target?.trim() ? input.target.trim() : null;
    const chatType = input.chatType ?? null;
    const chatId = input.chatId?.trim() ? input.chatId.trim() : null;
    const conversationTitle = input.conversationTitle?.trim() ? input.conversationTitle.trim() : null;
    const senderId = input.senderId?.trim() ? input.senderId.trim() : null;
    const senderName = input.senderName?.trim() ? input.senderName.trim() : null;
    const text = input.text?.trim() ? input.text.trim() : null;
    const from = input.from ?? null;
    const to = input.to ?? null;

    const result = await queryable.query<{
      account_id: string;
      account_display_name: string | null;
      chat_type: ConversationKey['chatType'];
      chat_id: string;
      conversation_title: string | null;
      message_id: string;
      sender_id: string;
      sender_name: string | null;
      direction: 'inbound' | 'outbound';
      kind: McpMessageRecord['kind'];
      text_content: string | null;
      recalled: boolean;
      occurred_at: Date;
      occurred_key: string;
      attachments: McpMessageRecord['attachments'];
    }>(
      `SELECT m.account_id,
              NULLIF(la.display_name, '') AS account_display_name,
              m.chat_type,
              m.chat_id,
              ${names.title} AS conversation_title,
              m.message_id,
              m.sender_id,
              ${names.sender} AS sender_name,
              ${MESSAGE_DIRECTION_SQL} AS direction,
              m.kind,
              COALESCE(${AGENT_MASKED_SQL}, false) AS recalled,
              ${AGENT_VISIBLE_TEXT_SQL} AS text_content,
              m.occurred_at,
              to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_key,
              CASE WHEN ${AGENT_MASKED_SQL} THEN '[]'::jsonb ELSE COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'attachmentId', a.attachment_id,
                    'kind', a.kind,
                    'name', ${ATTACHMENT_DISPLAY_NAME_SQL},
                    'mimeType', a.mime_type,
                    'sizeBytes', a.size_bytes,
                    'status', a.status
                  ) ORDER BY a.created_at ASC, a.attachment_id ASC
                ) FILTER (WHERE a.attachment_id IS NOT NULL),
                '[]'::jsonb
              ) END AS attachments
       FROM messages m
       JOIN line_accounts la ON la.account_id = m.account_id
       LEFT JOIN conversations c
         ON c.account_id = m.account_id
        AND c.chat_type = m.chat_type
        AND c.chat_id = m.chat_id
       LEFT JOIN conversation_members cm
         ON cm.account_id = m.account_id
        AND cm.chat_type = m.chat_type
        AND cm.chat_id = m.chat_id
        AND cm.member_id = m.sender_id
       ${SENDER_CONTACT_JOIN}
       ${PEER_CONTACT_JOIN}
       LEFT JOIN attachments a
         ON a.account_id = m.account_id
        AND a.chat_type = m.chat_type
        AND a.chat_id = m.chat_id
        AND a.message_id = m.message_id
       WHERE ${messageScopeWhereSql({ accountIds: '$1', scopeAccountIds: '$12', scopeChatType: '$13', scopeChatId: '$14', extraScopes: '$15', lineageOrder: '$16' })}
         AND ${messageFilterWhereSql({ chatType: '$2', from: '$9', to: '$10', excludeChatIds: '$19', direction: '$20', kinds: '$21', excludeKinds: '$22' })}
         AND ($3::text IS NULL OR m.chat_id = $3)
         AND ($4::text IS NULL OR position(lower($4) in lower(coalesce(${names.title}, ''))) > 0)
         AND ($5::text IS NULL OR m.sender_id = $5)
         AND (
           $6::text IS NULL
           OR position(lower($6) in lower(coalesce(${names.sender}, ''))) > 0
         )
         AND (
           $7::text IS NULL
           OR position(lower($7) in lower(coalesce(${names.title}, ''))) > 0
           OR lower(m.chat_id) = lower($7)
           OR lower(m.sender_id) = lower($7)
           OR position(lower($7) in lower(coalesce(cm.display_name, ''))) > 0
           OR (m.chat_type NOT IN ('community', 'thread')
             AND (position(lower($7) in lower(${names.nickname('sender_contact')})) > 0
               OR position(lower($7) in lower(coalesce(sender_contact.display_name, ''))) > 0))
           OR position(lower($7) in lower(${names.nickname('peer_contact')})) > 0
           OR position(lower($7) in lower(coalesce(peer_contact.display_name, ''))) > 0
           OR EXISTS (
             SELECT 1 FROM conversation_members cm_any
             LEFT JOIN line_contacts any_contact
               ON any_contact.account_id = cm_any.account_id
              AND cm_any.chat_type NOT IN ('community', 'thread')
              AND any_contact.mid = cm_any.member_id
             WHERE cm_any.account_id = m.account_id
               AND cm_any.chat_type = m.chat_type
               AND cm_any.chat_id = m.chat_id
               AND (
                 position(lower($7) in lower(coalesce(cm_any.display_name, ''))) > 0
                 OR position(lower($7) in lower(${names.nickname('any_contact')})) > 0
                 OR position(lower($7) in lower(coalesce(any_contact.display_name, ''))) > 0
                 OR lower(cm_any.member_id) = lower($7)
               )
           )
         )
         AND ($8::text IS NULL OR position(lower($8) in lower(coalesce(${AGENT_VISIBLE_TEXT_SQL}, ''))) > 0)
         AND ($17::timestamptz IS NULL OR (m.occurred_at, m.message_id) ${ascending ? '>' : '<'} ($17::timestamptz, $18::text))
       GROUP BY m.account_id, m.chat_type, m.chat_id, m.message_id, m.sender_id, m.kind, m.content, m.text_content, m.occurred_at, m.raw, la.own_mid,
                ${NAME_RESOLUTION_GROUP_COLUMNS}
       ORDER BY m.occurred_at ${ascending ? 'ASC' : 'DESC'}, m.message_id ${ascending ? 'ASC' : 'DESC'}
       LIMIT $11`,
      [
        lineage.accountIds,
        chatType,
        chatId,
        conversationTitle,
        senderId,
        senderName,
        target,
        text,
        from,
        to,
        limit,
        ...messageScopeValues(lineage, input),
        afterTime,
        afterId,
        ...messageFilterValues(input),
      ],
    );

    return result.rows.map((row) => ({ key: { occurredAt: row.occurred_key, messageId: row.message_id }, record: {
      accountId: row.account_id,
      accountDisplayName: row.account_display_name,
      chatType: row.chat_type,
      chatId: row.chat_id,
      conversationTitle: row.conversation_title,
      messageId: row.message_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      direction: row.direction,
      kind: row.kind,
      text: row.text_content,
      recalled: row.recalled,
      occurredAt: row.occurred_at.toISOString(),
      attachments: (row.attachments ?? []).map((att) => ({
        attachmentId: att.attachmentId,
        kind: att.kind,
        name: att.name ?? null,
        mimeType: att.mimeType ?? null,
        sizeBytes: att.sizeBytes === null || att.sizeBytes === undefined ? null : Number(att.sizeBytes),
        status: att.status,
      })),
    } }));
  }
}
