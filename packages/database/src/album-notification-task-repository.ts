import type { Pool } from 'pg';
import type { ConversationKey } from '@line-agent/contracts';

export type AlbumNotificationTaskStatus = 'pending' | 'running' | 'retry' | 'completed' | 'skipped';
export type AlbumNotificationTaskErrorStage = 'archive_scan' | 'album_list' | 'album_list_pagination' | 'album_photos'
  | 'photo_download' | 'photo_pagination' | 'archive_contains' | 'archive_write' | 'source_validation' | 'unknown';
export type AlbumNotificationTaskErrorCode = 'ALBUM_RECONCILIATION_FAILED' | 'ALBUM_ARCHIVE_INCOMPLETE'
  | 'ALBUM_PHOTO_CURSOR_LOOP' | 'missing_source' | 'source_deleted' | 'unknown';

export type AlbumNotificationTaskChat = Readonly<{ chatType: 'direct' | 'group' | 'room'; chatId: string }>;
export type AlbumNotificationTaskPage = Readonly<{ chats: AlbumNotificationTaskChat[]; nextChat: AlbumNotificationTaskChat | null }>;
export type AlbumTaskMessagePage = Readonly<{ count: number; nextMessageId: string | null }>;

/** Checks cancellation before every bounded database page, so an invalidated owner never starts another page. */
export async function walkAlbumTaskMessagePages(
  readPage: (afterMessageId?: string) => Promise<AlbumTaskMessagePage>,
  isCurrent: () => boolean,
): Promise<boolean> {
  let afterMessageId: string | undefined;
  for (;;) {
    if (!isCurrent()) return false;
    const page = await readPage(afterMessageId);
    if (!page.nextMessageId || page.count < 64) return true;
    afterMessageId = page.nextMessageId;
  }
}

export type AlbumTaskBindingFence = Readonly<{ workerInstanceId: string; controlEpoch: number }>;

const validSourceSql = `m.account_id = t.account_id AND m.message_id = t.message_id AND m.chat_type = t.chat_type AND m.chat_id = t.chat_id
  AND m.ingestion_source = 'live' AND NOT (m.raw ? 'sourceDeleted')
  AND COALESCE(m.raw #>> '{message,contentMetadata,UNSENT}', '') <> 'true'
  AND m.raw #>> '{message,contentType}' IN ('16', 'POSTNOTIFICATION')
  AND m.raw #>> '{message,contentMetadata,serviceType}' = 'AB'`;

export class AlbumNotificationTaskRepository {
  constructor(private readonly pool: Pool) {}

  /** Inserts only if the exact committed source row is still a live, actionable AB notification. */
  async enqueueCommitted(input: ConversationKey & { messageId: string }): Promise<boolean> {
    const result = await this.pool.query<{ eligible: boolean }>(
      `WITH eligible AS MATERIALIZED (
         SELECT m.account_id, c.chat_type, m.chat_id, m.message_id FROM messages m
         JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
         WHERE m.account_id=$1 AND c.chat_type=$2 AND m.chat_id=$3 AND m.message_id=$4
           AND m.ingestion_source='live' AND NOT (m.raw ? 'sourceDeleted')
           AND COALESCE(m.raw #>> '{message,contentMetadata,UNSENT}', '') <> 'true'
           AND m.raw #>> '{message,contentType}' IN ('16', 'POSTNOTIFICATION')
           AND m.raw #>> '{message,contentMetadata,serviceType}'='AB'
       ), inserted AS (
         INSERT INTO album_notification_tasks(account_id, chat_type, chat_id, message_id, status)
         SELECT eligible.account_id, eligible.chat_type, eligible.chat_id, eligible.message_id, 'pending' FROM eligible
         ON CONFLICT(account_id, chat_type, chat_id, message_id) DO NOTHING RETURNING message_id
       ) SELECT EXISTS(SELECT 1 FROM eligible) AS eligible`,
      [input.accountId, input.chatType, input.chatId, input.messageId]);
    return result.rows[0]?.eligible === true;
  }

  /** Bounded keyset backfill; caller persists only the last source-message cursor in memory. */
  async backfillMissingPage(input: { accountId: string; afterMessageId?: string; limit?: number }): Promise<{ count: number; nextMessageId: string | null }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 64)));
    const candidates = await this.pool.query<{ chat_type: ConversationKey['chatType']; chat_id: string; message_id: string }>(
      `SELECT c.chat_type, m.chat_id, m.message_id FROM messages m
       JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
       LEFT JOIN album_notification_tasks t ON t.account_id=m.account_id AND t.chat_type=c.chat_type
         AND t.chat_id=m.chat_id AND t.message_id=m.message_id
       WHERE m.account_id=$1 AND m.ingestion_source='live' AND t.message_id IS NULL
         AND m.message_id > $2 AND NOT (m.raw ? 'sourceDeleted')
         AND COALESCE(m.raw #>> '{message,contentMetadata,UNSENT}', '') <> 'true'
         AND m.raw #>> '{message,contentType}' IN ('16', 'POSTNOTIFICATION')
         AND m.raw #>> '{message,contentMetadata,serviceType}'='AB'
       ORDER BY m.message_id LIMIT $3`, [input.accountId, input.afterMessageId ?? '', limit]);
    if (!candidates.rows.length) return { count: 0, nextMessageId: null };
    await this.pool.query(
      `INSERT INTO album_notification_tasks(account_id, chat_type, chat_id, message_id, status)
       SELECT $1, item.chat_type, item.chat_id, item.message_id, 'pending'
       FROM jsonb_to_recordset($2::jsonb) AS item(chat_type text, chat_id text, message_id text)
       ON CONFLICT(account_id, chat_type, chat_id, message_id) DO NOTHING`,
      [input.accountId, JSON.stringify(candidates.rows)]);
    return { count: candidates.rows.length, nextMessageId: candidates.rows.at(-1)!.message_id };
  }

  async recoverRunning(accountId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE album_notification_tasks SET status='pending', next_attempt_at=NULL, updated_at=clock_timestamp()
       WHERE account_id=$1 AND status='running'`, [accountId]);
    return result.rowCount ?? 0;
  }

  async skipInvalidPage(input: { accountId: string; afterMessageId?: string; limit?: number; chat?: AlbumNotificationTaskChat }): Promise<{ count: number; nextMessageId: string | null }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 64)));
    const result = await this.pool.query<{ message_id: string }>(
      `WITH invalid AS (
         SELECT t.account_id,t.chat_type,t.chat_id,t.message_id,
           CASE WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.message_id=t.message_id)
             THEN 'missing_source' ELSE 'source_deleted' END AS error_code
         FROM album_notification_tasks t
         WHERE t.account_id=$1 AND t.status IN ('pending','retry') AND t.message_id > $2
           AND ($3::text IS NULL OR t.chat_type=$3) AND ($4::text IS NULL OR t.chat_id=$4)
           AND NOT EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})
         ORDER BY t.message_id LIMIT $5
       ), changed AS (
         UPDATE album_notification_tasks t SET status='skipped',next_attempt_at=NULL,error_stage='source_validation',
           error_code=invalid.error_code,updated_at=clock_timestamp()
         FROM invalid WHERE t.account_id=invalid.account_id AND t.chat_type=invalid.chat_type
           AND t.chat_id=invalid.chat_id AND t.message_id=invalid.message_id
         RETURNING t.message_id
       ) SELECT message_id FROM changed ORDER BY message_id`,
      [input.accountId, input.afterMessageId ?? '', input.chat?.chatType ?? null, input.chat?.chatId ?? null, limit]);
    return { count: result.rows.length, nextMessageId: result.rows.at(-1)?.message_id ?? null };
  }

  async claimChat(key: ConversationKey): Promise<{ claimed: boolean; retryAt: number | null }> {
    const blocked = await this.pool.query<{ retry_at: Date | null }>(
      `SELECT min(next_attempt_at) AS retry_at FROM album_notification_tasks
       WHERE account_id=$1 AND status='retry' AND next_attempt_at > clock_timestamp()`, [key.accountId]);
    const retryAt = blocked.rows[0]?.retry_at?.getTime() ?? null;
    if (retryAt !== null) return { claimed: false, retryAt };
    const result = await this.pool.query(
      `UPDATE album_notification_tasks t SET status='running',attempt_count=attempt_count+1,next_attempt_at=NULL,
         error_stage=NULL,error_code=NULL,updated_at=clock_timestamp()
       WHERE t.account_id=$1 AND t.chat_type=$2 AND t.chat_id=$3 AND t.status IN ('pending','retry')
         AND (t.status='pending' OR t.next_attempt_at <= clock_timestamp())
         AND EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})`,
      [key.accountId, key.chatType, key.chatId]);
    return { claimed: (result.rowCount ?? 0) > 0, retryAt: null };
  }

  async completeClaimedChat(key: ConversationKey, binding: AlbumTaskBindingFence): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query<{ control_epoch: string; mode: string; worker_instance_id: string | null;
        worker_binding_epoch: string | null }>(
        `SELECT ac.control_epoch,a.mode,a.worker_instance_id,a.worker_binding_epoch
         FROM account_control ac JOIN line_accounts a ON a.account_id=$1
         WHERE ac.singleton=true FOR SHARE OF ac,a`, [key.accountId]);
      const row = authority.rows[0];
      if (!row || row.mode !== 'ACTIVE_CONTROL' || row.worker_instance_id !== binding.workerInstanceId
        || Number(row.control_epoch) !== binding.controlEpoch || Number(row.worker_binding_epoch) !== binding.controlEpoch) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
      `UPDATE album_notification_tasks t SET status=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})
           THEN 'completed' ELSE 'skipped' END,
         error_stage=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql}) THEN NULL ELSE 'source_validation' END,
         error_code=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql}) THEN NULL
           WHEN EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.message_id=t.message_id)
           THEN 'source_deleted' ELSE 'missing_source' END,updated_at=clock_timestamp()
       WHERE t.account_id=$1 AND t.chat_type=$2 AND t.chat_id=$3 AND t.status='running'`,
      [key.accountId, key.chatType, key.chatId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async retryClaimedChat(key: ConversationKey, binding: AlbumTaskBindingFence,
    error: { stage: AlbumNotificationTaskErrorStage; code: AlbumNotificationTaskErrorCode }): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query<{ control_epoch: string; mode: string; worker_instance_id: string | null;
        worker_binding_epoch: string | null }>(
        `SELECT ac.control_epoch,a.mode,a.worker_instance_id,a.worker_binding_epoch
         FROM account_control ac JOIN line_accounts a ON a.account_id=$1
         WHERE ac.singleton=true FOR SHARE OF ac,a`, [key.accountId]);
      const row = authority.rows[0];
      if (!row || row.mode !== 'ACTIVE_CONTROL' || row.worker_instance_id !== binding.workerInstanceId
        || Number(row.control_epoch) !== binding.controlEpoch || Number(row.worker_binding_epoch) !== binding.controlEpoch) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query<{ retry_at: Date | null }>(
      `WITH changed AS (
         UPDATE album_notification_tasks t SET status=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})
             THEN 'retry' ELSE 'skipped' END,
           next_attempt_at=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})
             THEN clock_timestamp() + make_interval(secs => LEAST(60, 5 * power(2, LEAST(attempt_count - 1, 4)))) ELSE NULL END,
           error_stage=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql}) THEN $4 ELSE 'source_validation' END,
           error_code=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql}) THEN $5
             WHEN EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.message_id=t.message_id)
             THEN 'source_deleted' ELSE 'missing_source' END,updated_at=clock_timestamp()
         WHERE t.account_id=$1 AND t.chat_type=$2 AND t.chat_id=$3 AND t.status='running'
         RETURNING next_attempt_at
       ) SELECT min(next_attempt_at) AS retry_at FROM changed`,
      [key.accountId, key.chatType, key.chatId, error.stage, error.code]);
    const retryAt = result.rows[0]?.retry_at?.getTime();
      await client.query('COMMIT');
      return retryAt === undefined || !Number.isFinite(retryAt) ? null : retryAt;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async dueChatsPage(input: { accountId: string; after?: AlbumNotificationTaskChat; limit?: number }): Promise<AlbumNotificationTaskPage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 32)));
    const result = await this.pool.query<{ chat_type: AlbumNotificationTaskChat['chatType']; chat_id: string }>(
      `SELECT t.chat_type,t.chat_id FROM album_notification_tasks t
       WHERE t.account_id=$1 AND (t.status='pending' OR (t.status='retry' AND t.next_attempt_at <= clock_timestamp()))
         AND ($2::text IS NULL OR t.chat_type > $2 OR (t.chat_type=$2 AND t.chat_id > $3))
         AND EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})
         AND NOT EXISTS(SELECT 1 FROM album_notification_tasks retry
           WHERE retry.account_id=t.account_id AND retry.status='retry' AND retry.next_attempt_at > clock_timestamp())
       GROUP BY t.chat_type,t.chat_id ORDER BY t.chat_type,t.chat_id LIMIT $4`,
      [input.accountId, input.after?.chatType ?? null, input.after?.chatId ?? null, limit]);
    const chats = result.rows.map((row) => ({ chatType: row.chat_type, chatId: row.chat_id }));
    return { chats, nextChat: chats.length === limit ? chats.at(-1)! : null };
  }

  async nextRetryAt(accountId: string): Promise<number | null> {
    const result = await this.pool.query<{ retry_at: Date | null }>(
      `SELECT min(t.next_attempt_at) AS retry_at FROM album_notification_tasks t
       WHERE t.account_id=$1 AND t.status='retry' AND t.next_attempt_at > clock_timestamp()
         AND EXISTS(SELECT 1 FROM messages m WHERE ${validSourceSql})`, [accountId]);
    const value = result.rows[0]?.retry_at?.getTime();
    return value === undefined || !Number.isFinite(value) ? null : value;
  }
}
