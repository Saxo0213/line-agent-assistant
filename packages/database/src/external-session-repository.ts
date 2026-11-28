import type { Pool, PoolClient } from 'pg';
import { McpDomainError } from './mcp-token-repository.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** A session with no activity for this long is closed (docs/design/external-session-reply.md section 5). */
export const EXTERNAL_SESSION_IDLE_DAYS = 7;
export const EXTERNAL_SESSION_REPLY_LIST_MAX = 50;

export interface ExternalSessionRecord {
  sessionKey: string;
  accountId: string;
  seq: number;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  closedAt: string | null;
}

/** An open session that was active within WAITING_SESSION_WINDOW_HOURS, with the stored text of its last sent message (null when unknown). */
export interface WaitingSessionRecord { seq: number; label: string; lastText: string | null }

/** The newest message of the Primary Admin among the messages that started an Agent job (the job and the jobs folded into it). */
export interface AdminTriggerMessage {
  accountId: string;
  messageId: string;
  text: string;
  attachmentIds: string[];
}

/** The most recently active sessions that the Agent prompt lists. */
export const WAITING_SESSION_LIST_MAX = 20;

export interface ExternalSessionReplyAttachment { attachmentId: string; kind: string; name: string }

export interface ExternalSessionReplyRecord {
  replyId: string;
  sessionKey: string;
  source: 'quote' | 'agent';
  inboundMessageId: string;
  text: string;
  attachmentIds: string[];
  note: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface SessionRow {
  session_key: string; account_id: string; seq: number; label: string;
  created_at: Date; last_seen_at: Date; closed_at: Date | null;
}
interface ReplyRow {
  reply_id: string; session_key: string; source: 'quote' | 'agent'; inbound_message_id: string; text: string;
  attachment_ids: string[]; note: string | null; created_at: Date; delivered_at: Date | null;
}

const SESSION_COLUMNS = 'session_key, account_id, seq, label, created_at, last_seen_at, closed_at';
const REPLY_COLUMNS = 'reply_id, session_key, source, inbound_message_id, text, attachment_ids, note, created_at, delivered_at';

const sessionOf = (row: SessionRow): ExternalSessionRecord => ({
  sessionKey: row.session_key, accountId: row.account_id, seq: row.seq, label: row.label,
  createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
  closedAt: row.closed_at ? row.closed_at.toISOString() : null,
});
const replyOf = (row: ReplyRow): ExternalSessionReplyRecord => ({
  replyId: row.reply_id, sessionKey: row.session_key, source: row.source, inboundMessageId: row.inbound_message_id,
  text: row.text, attachmentIds: row.attachment_ids, note: row.note,
  createdAt: row.created_at.toISOString(), deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sessions of external MCP clients, the LINE messages sent for them and the replies of the Primary Admin
 * (docs/design/external-session-reply.md). Reply rows are append-only; a trigger allows only delivered_at NULL to a time.
 */
export class ExternalSessionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Creates the session or renews it. A new key gets the next `seq` of the account. A known key keeps its seq and label,
   * is reopened and gets a new last_seen_at. It must run inside a transaction (the seq lock is a transaction lock).
   * A key that belongs to another account is refused with INVALID_INPUT.
   */
  async upsertSession(client: Pick<PoolClient, 'query'>, input: { accountId: string; sessionKey: string; label: string }): Promise<ExternalSessionRecord> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['external_sessions_seq', input.accountId]);
    const known = await client.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM external_sessions WHERE session_key = $1 FOR UPDATE`, [input.sessionKey]);
    if (known.rows[0]) {
      if (known.rows[0].account_id !== input.accountId) throw new McpDomainError('INVALID_INPUT', 'The session key is not available.');
      const renewed = await client.query<SessionRow>(
        `UPDATE external_sessions SET last_seen_at = clock_timestamp(), closed_at = NULL WHERE session_key = $1 RETURNING ${SESSION_COLUMNS}`,
        [input.sessionKey]);
      return sessionOf(renewed.rows[0]!);
    }
    const created = await client.query<SessionRow>(
      `INSERT INTO external_sessions (session_key, account_id, seq, label)
       SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3 FROM external_sessions WHERE account_id = $2
       RETURNING ${SESSION_COLUMNS}`,
      [input.sessionKey, input.accountId, input.label]);
    return sessionOf(created.rows[0]!);
  }

  /** Stores the LINE message id of one sent message for a session. A repeated id is ignored. */
  async recordMessage(input: { accountId: string; lineMessageId: string; sessionKey: string }, queryable: Queryable = this.pool): Promise<void> {
    await queryable.query(
      `INSERT INTO external_session_messages (account_id, line_message_id, session_key) VALUES ($1,$2,$3)
       ON CONFLICT (account_id, line_message_id) DO NOTHING`,
      [input.accountId, input.lineMessageId, input.sessionKey]);
  }

  /** Closes every open session without activity for EXTERNAL_SESSION_IDLE_DAYS days. Returns the number closed. */
  async closeIdleSessions(queryable: Queryable = this.pool): Promise<number> {
    const result = await queryable.query(
      `UPDATE external_sessions SET closed_at = clock_timestamp()
       WHERE closed_at IS NULL AND last_seen_at < clock_timestamp() - make_interval(days => $1)`, [EXTERNAL_SESSION_IDLE_DAYS]);
    return result.rowCount ?? 0;
  }

  async getSession(accountId: string, sessionKey: string, queryable: Queryable = this.pool): Promise<ExternalSessionRecord | null> {
    const result = await queryable.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM external_sessions WHERE session_key = $1 AND account_id = $2`, [sessionKey, accountId]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }

  async getSessionBySeq(accountId: string, seq: number, queryable: Queryable = this.pool): Promise<ExternalSessionRecord | null> {
    const result = await queryable.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM external_sessions WHERE account_id = $1 AND seq = $2`, [accountId, seq]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }

  /**
   * Open sessions of the account with activity in the last `windowHours` hours, in seq order (the WAITING_SESSION_LIST_MAX most
   * recently active ones). `lastText` is the stored text of the last LINE message that was sent for the session, or null when the
   * message is not stored or has no text.
   */
  async listWaitingSessions(accountId: string, windowHours: number, queryable: Queryable = this.pool): Promise<WaitingSessionRecord[]> {
    const result = await queryable.query<{ seq: number; label: string; text_content: string | null }>(
      `SELECT s.seq, s.label, last_message.text_content
       FROM external_sessions s
       LEFT JOIN LATERAL (
         SELECT m.text_content
         FROM external_session_messages x
         LEFT JOIN messages m ON m.account_id = x.account_id AND m.message_id = x.line_message_id
         WHERE x.session_key = s.session_key
         ORDER BY x.sent_at DESC, x.line_message_id DESC
         LIMIT 1
       ) last_message ON true
       WHERE s.account_id = $1 AND s.closed_at IS NULL AND s.last_seen_at > clock_timestamp() - make_interval(hours => $2)
       ORDER BY s.last_seen_at DESC, s.seq DESC
       LIMIT $3`, [accountId, windowHours, WAITING_SESSION_LIST_MAX]);
    return result.rows.map((row) => ({ seq: row.seq, label: row.label, lastText: row.text_content })).sort((a, b) => a.seq - b.seq);
  }

  /**
   * The newest message of the Primary Admin that started the Agent job `jobId` (the job itself and the jobs folded into it), with its
   * stored text and attachment ids. Only a LINE job in a direct chat counts. Null when there is no such message.
   */
  async findAdminTriggerMessage(jobId: string, queryable: Queryable = this.pool): Promise<AdminTriggerMessage | null> {
    const result = await queryable.query<{ account_id: string; message_id: string; text: string; attachment_ids: string[] }>(
      `SELECT j.account_id, m.message_id, COALESCE(m.text_content, '') AS text,
              COALESCE((SELECT array_agg(a.attachment_id::text ORDER BY a.created_at, a.attachment_id) FROM attachments a
                        WHERE a.account_id = m.account_id AND a.message_id = m.message_id), '{}') AS attachment_ids
       FROM agent_jobs j
       JOIN messages m ON m.account_id = j.account_id AND m.message_id = j.source_message_id
       JOIN account_administrators aa ON aa.account_id = m.account_id AND aa.user_id = m.sender_id AND aa.role = 'PRIMARY_ADMIN'
       WHERE (j.job_id = $1 OR j.folded_into = $1) AND j.source_type = 'line' AND j.chat_type = 'direct'
       ORDER BY m.occurred_at DESC, j.queue_position DESC
       LIMIT 1`, [jobId]);
    const row = result.rows[0];
    return row ? { accountId: row.account_id, messageId: row.message_id, text: row.text, attachmentIds: row.attachment_ids } : null;
  }

  /** The session of a LINE message that was sent for a session (a quoted message). An idle session is closed first. */
  async findByQuotedMessage(accountId: string, lineMessageId: string, queryable: Queryable = this.pool): Promise<ExternalSessionRecord | null> {
    await this.closeIdleSessions(queryable);
    const result = await queryable.query<SessionRow>(
      `SELECT s.session_key, s.account_id, s.seq, s.label, s.created_at, s.last_seen_at, s.closed_at
       FROM external_session_messages m JOIN external_sessions s ON s.session_key = m.session_key
       WHERE m.account_id = $1 AND m.line_message_id = $2`, [accountId, lineMessageId]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }

  /** Sets last_seen_at to now. */
  async touchSession(sessionKey: string, queryable: Queryable = this.pool): Promise<void> {
    await queryable.query('UPDATE external_sessions SET last_seen_at = clock_timestamp() WHERE session_key = $1', [sessionKey]);
  }

  /** Sets closed_at. It returns false when the session is unknown or already closed. */
  async closeSession(accountId: string, sessionKey: string, queryable: Queryable = this.pool): Promise<boolean> {
    const result = await queryable.query(
      'UPDATE external_sessions SET closed_at = clock_timestamp() WHERE session_key = $1 AND account_id = $2 AND closed_at IS NULL',
      [sessionKey, accountId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Writes one reply. An inbound message goes to one session only: a second write of the same inbound message returns
   * the existing row with `inserted` false.
   */
  async insertReply(input: { sessionKey: string; source: 'quote' | 'agent'; inboundMessageId: string; text: string;
    attachmentIds: readonly string[]; note?: string | null }, queryable: Queryable = this.pool): Promise<{ reply: ExternalSessionReplyRecord; inserted: boolean }> {
    const inserted = await queryable.query<ReplyRow>(
      `INSERT INTO external_session_replies (session_key, source, inbound_message_id, text, attachment_ids, note)
       VALUES ($1,$2,$3,$4,$5::uuid[],$6) ON CONFLICT (inbound_message_id) DO NOTHING RETURNING ${REPLY_COLUMNS}`,
      [input.sessionKey, input.source, input.inboundMessageId, input.text, [...input.attachmentIds], input.note ?? null]);
    if (inserted.rows[0]) return { reply: replyOf(inserted.rows[0]), inserted: true };
    const existing = await queryable.query<ReplyRow>(
      `SELECT ${REPLY_COLUMNS} FROM external_session_replies WHERE inbound_message_id = $1`, [input.inboundMessageId]);
    return { reply: replyOf(existing.rows[0]!), inserted: false };
  }

  /** Marks every undelivered reply of the session as delivered and returns them, oldest first. */
  async takeUndeliveredReplies(sessionKey: string): Promise<ExternalSessionReplyRecord[]> {
    const result = await this.pool.query<ReplyRow>(
      `WITH due AS (
         SELECT reply_id FROM external_session_replies WHERE session_key = $1 AND delivered_at IS NULL
         ORDER BY created_at, reply_id FOR UPDATE SKIP LOCKED
       )
       UPDATE external_session_replies r SET delivered_at = clock_timestamp() FROM due WHERE r.reply_id = due.reply_id
       RETURNING ${REPLY_COLUMNS.split(', ').map((column) => `r.${column}`).join(', ')}`, [sessionKey]);
    return result.rows.map(replyOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.replyId.localeCompare(b.replyId));
  }

  /** Replies of one session (delivered or not), oldest first, at most EXTERNAL_SESSION_REPLY_LIST_MAX rows. */
  async listReplies(sessionKey: string, since?: Date, queryable: Queryable = this.pool): Promise<ExternalSessionReplyRecord[]> {
    const result = await queryable.query<ReplyRow>(
      `SELECT ${REPLY_COLUMNS} FROM external_session_replies WHERE session_key = $1 AND ($2::timestamptz IS NULL OR created_at > $2)
       ORDER BY created_at, reply_id LIMIT $3`, [sessionKey, since ?? null, EXTERNAL_SESSION_REPLY_LIST_MAX]);
    return result.rows.map(replyOf);
  }

  /** Kind and display name of attachments, for the reply fields. An unknown id is left out. */
  async describeAttachments(attachmentIds: readonly string[], queryable: Queryable = this.pool): Promise<ExternalSessionReplyAttachment[]> {
    const ids = attachmentIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return [];
    const result = await queryable.query<{ attachment_id: string; kind: string; name: string }>(
      `SELECT a.attachment_id, a.kind, COALESCE(NULLIF(BTRIM(a.name), ''), CASE a.kind
         WHEN 'image' THEN '圖片' WHEN 'video' THEN '影片' WHEN 'audio' THEN '語音' ELSE '檔案' END) AS name
       FROM attachments a WHERE a.attachment_id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(result.rows.map((row) => [row.attachment_id, { attachmentId: row.attachment_id, kind: row.kind, name: row.name }]));
    return ids.flatMap((id) => byId.get(id.toLowerCase()) ?? []);
  }

  /** True when a reply of this account lists the attachment id; read_message_attachment of an external client needs it. */
  async isAttachmentListed(accountId: string, attachmentId: string, queryable: Queryable = this.pool): Promise<boolean> {
    if (!UUID_PATTERN.test(attachmentId)) return false;
    const result = await queryable.query(
      `SELECT 1 FROM external_session_replies r JOIN external_sessions s ON s.session_key = r.session_key
       WHERE s.account_id = $1 AND $2::uuid = ANY(r.attachment_ids) LIMIT 1`, [accountId, attachmentId]);
    return (result.rowCount ?? 0) > 0;
  }
}
