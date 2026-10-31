import { Buffer } from 'node:buffer';
import type { ConversationKey, WritableConversationKey } from '@line-agent/contracts';
import type { Pool } from 'pg';

export type AttachmentStorageKey = WritableConversationKey;
export type AttachmentStorageSetting = AttachmentStorageKey & { secondaryRoot: string | null; generation: number };
export type AttachmentStorageJob = AttachmentStorageKey & { jobId: number; attachmentId: string; targetKind: 'secondary' | 'reclassify'; generation: number; claimToken: string };
export type StoredAttachmentItem = {
  attachmentId: string; messageId: string; name: string; kind: 'image' | 'video' | 'audio' | 'file'; mimeType: string | null;
  sizeBytes: number | null; occurredAt: string; senderId: string; senderDisplayName: string;
};
export type StoredAttachmentPage = { attachments: StoredAttachmentItem[]; nextCursor: string | null };
type Cursor = { occurredAt: string; attachmentId: string };
function decodeCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof decoded.occurredAt !== 'string' || !Number.isFinite(Date.parse(decoded.occurredAt))
      || typeof decoded.attachmentId !== 'string' || !decoded.attachmentId) throw new Error();
    return { occurredAt: decoded.occurredAt, attachmentId: decoded.attachmentId };
  } catch { throw new Error('Invalid stored attachment cursor'); }
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }

/** Durable per-chat secondary-root generations and bounded, restartable copy/reclassification claims. */
export class AttachmentStorageRepository {
  constructor(private readonly pool: Pool) {}

  async getSetting(key: AttachmentStorageKey): Promise<AttachmentStorageSetting> {
    const result = await this.pool.query<{ secondary_root: string | null; generation: string }>(
      'SELECT secondary_root, generation::text FROM attachment_storage_settings WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [key.accountId, key.chatType, key.chatId]);
    return { ...key, secondaryRoot: result.rows[0]?.secondary_root ?? null, generation: Number(result.rows[0]?.generation ?? 0) };
  }

  async setSecondaryRoot(key: AttachmentStorageKey, root: string | null): Promise<AttachmentStorageSetting> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['attachment-storage',key.accountId,key.chatType,key.chatId])]);
      const result = await client.query<{ secondary_root: string | null; generation: string }>(
        `INSERT INTO attachment_storage_settings (account_id,chat_type,chat_id,secondary_root,generation)
         VALUES ($1,$2,$3,$4,1) ON CONFLICT (account_id,chat_type,chat_id) DO UPDATE
         SET secondary_root=EXCLUDED.secondary_root,generation=attachment_storage_settings.generation+1,updated_at=clock_timestamp()
         RETURNING secondary_root,generation::text`, [key.accountId, key.chatType, key.chatId, root]);
      const row = result.rows[0]!;
      const generation = Number(row.generation);
      await client.query(`UPDATE attachment_storage_jobs SET status='superseded',claim_token=NULL,claimed_at=NULL,updated_at=clock_timestamp()
        WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND target_kind='secondary' AND generation<>$4 AND status IN ('queued','claimed','failed')`,
        [key.accountId,key.chatType,key.chatId,generation]);
      await client.query('COMMIT');
      return { ...key, secondaryRoot: row.secondary_root, generation };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async admitReadyAttachment(key: AttachmentStorageKey, attachmentId: string, generation: number): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO attachment_storage_jobs (account_id,chat_type,chat_id,attachment_id,target_kind,generation,status)
       SELECT a.account_id,a.chat_type,a.chat_id,a.attachment_id,'secondary',$5,'queued'
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       JOIN attachment_storage_settings s ON s.account_id=a.account_id AND s.chat_type=a.chat_type AND s.chat_id=m.chat_id
         WHERE a.attachment_id=$4 AND a.status='ready' AND a.relative_path IS NOT NULL
         AND a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND s.generation=$5 AND s.secondary_root IS NOT NULL
       ON CONFLICT (attachment_id,target_kind) DO UPDATE SET generation=EXCLUDED.generation,status='queued',available_at=clock_timestamp(),
         claim_token=NULL,claimed_at=NULL,safe_error_code=NULL,updated_at=clock_timestamp()
       WHERE attachment_storage_jobs.generation<>EXCLUDED.generation OR attachment_storage_jobs.status IN ('failed','completed')
       RETURNING job_id`, [key.accountId, key.chatType, key.chatId, attachmentId, generation]);
    return (result.rowCount ?? 0) > 0;
  }

  async admitReadyPage(key: AttachmentStorageKey, generation: number, targetKind: 'secondary' | 'reclassify', afterAttachmentId: string | null, limit = 100): Promise<{ selected: number; lastAttachmentId: string | null }> {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.pool.query<{ selected_count: string; last_attachment_id: string | null }>(
      `WITH picked AS (
         SELECT a.account_id,a.chat_type,m.chat_id,a.attachment_id FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
         LEFT JOIN attachment_storage_settings s ON s.account_id=a.account_id AND s.chat_type=a.chat_type AND s.chat_id=m.chat_id
         WHERE a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND a.status='ready' AND a.relative_path IS NOT NULL
           AND ($5::uuid IS NULL OR a.attachment_id>$5::uuid)
           AND (($4='secondary' AND s.generation=$6 AND s.secondary_root IS NOT NULL)
             OR ($4='reclassify' AND a.chat_type IN ('group','room') AND a.relative_path ~ '/(19|20)[0-9]{2}/[0-9]{2}/'))
         ORDER BY a.attachment_id LIMIT $7
       ), inserted AS (
         INSERT INTO attachment_storage_jobs (account_id,chat_type,chat_id,attachment_id,target_kind,generation,status)
         SELECT account_id,chat_type,chat_id,attachment_id,$4,$6,'queued' FROM picked
         ON CONFLICT (attachment_id,target_kind) DO UPDATE SET generation=EXCLUDED.generation,status='queued',available_at=clock_timestamp(),
           claim_token=NULL,claimed_at=NULL,safe_error_code=NULL,updated_at=clock_timestamp()
         WHERE attachment_storage_jobs.generation<>EXCLUDED.generation OR attachment_storage_jobs.status='failed'
         RETURNING job_id
       ) SELECT (SELECT count(*) FROM picked)::text AS selected_count,
         (SELECT attachment_id FROM picked ORDER BY attachment_id DESC LIMIT 1) AS last_attachment_id,
         (SELECT count(*) FROM inserted) AS inserted_count`,
      [key.accountId,key.chatType,key.chatId,targetKind,afterAttachmentId,generation,bounded]);
    const row = result.rows[0]!;
    return { selected: Number(row.selected_count), lastAttachmentId: row.last_attachment_id };
  }

  async retryFailed(key: AttachmentStorageKey, targetKind: 'secondary' | 'reclassify' = 'secondary'): Promise<number> {
    const result = await this.pool.query(`UPDATE attachment_storage_jobs SET status='queued',available_at=clock_timestamp(),safe_error_code=NULL,updated_at=clock_timestamp()
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND target_kind=$4 AND status='failed'
        AND ($4<>'secondary' OR EXISTS (SELECT 1 FROM attachment_storage_settings s WHERE s.account_id=$1 AND s.chat_type=$2 AND s.chat_id=$3 AND s.generation=attachment_storage_jobs.generation AND s.secondary_root IS NOT NULL))`,
      [key.accountId,key.chatType,key.chatId,targetKind]);
    return result.rowCount ?? 0;
  }

  async getProgress(key: AttachmentStorageKey): Promise<{ queued: number; claimed: number; failed: number; completed: number }> {
    const result = await this.pool.query<{ status: string; count: string }>(`SELECT status,count(*)::text AS count FROM attachment_storage_jobs
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND target_kind='secondary' GROUP BY status`, [key.accountId,key.chatType,key.chatId]);
    const counts = new Map(result.rows.map((row) => [row.status,row.count]));
    return { queued: Number(counts.get('queued') ?? 0),claimed: Number(counts.get('claimed') ?? 0),failed: Number(counts.get('failed') ?? 0),completed: Number(counts.get('completed') ?? 0) };
  }

  async listRecoveryChats(): Promise<AttachmentStorageKey[]> {
    const result = await this.pool.query<{ account_id: string; chat_type: AttachmentStorageKey['chatType']; chat_id: string }>(
      `SELECT account_id,chat_type,chat_id FROM attachment_storage_settings WHERE secondary_root IS NOT NULL
       UNION SELECT DISTINCT a.account_id,m.chat_type,m.chat_id FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       WHERE a.status='ready' AND a.relative_path ~ '/(19|20)[0-9]{2}/[0-9]{2}/' AND m.chat_type IN ('group','room')`);
    return result.rows.map((row)=>({accountId:row.account_id,chatType:row.chat_type,chatId:row.chat_id}));
  }

  async queueReclassification(key: AttachmentStorageKey, attachmentId: string): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO attachment_storage_jobs (account_id,chat_type,chat_id,attachment_id,target_kind,generation,status)
      SELECT a.account_id,m.chat_type,m.chat_id,a.attachment_id,'reclassify',0,'queued'
      FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
      WHERE a.attachment_id=$4 AND a.status='ready' AND a.relative_path ~ '/(19|20)[0-9]{2}/[0-9]{2}/'
        AND a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND m.chat_type IN ('group','room')
      ON CONFLICT (attachment_id,target_kind) DO UPDATE SET status='queued',available_at=clock_timestamp(),claim_token=NULL,claimed_at=NULL,
        safe_error_code=NULL,updated_at=clock_timestamp() WHERE attachment_storage_jobs.status='failed'
      RETURNING job_id`,[key.accountId,key.chatType,key.chatId,attachmentId]);
    return (result.rowCount ?? 0)>0;
  }

  async claimJobs(limit = 4, excludedChats: readonly AttachmentStorageKey[] = []): Promise<AttachmentStorageJob[]> {
    const bounded = Math.max(1, Math.min(8, Math.trunc(limit)));
    const result = await this.pool.query<{ job_id: string; account_id: string; chat_type: AttachmentStorageJob['chatType']; chat_id: string; attachment_id: string; target_kind: AttachmentStorageJob['targetKind']; generation: string; claim_token: string }>(
      `WITH candidates AS (
         SELECT j.job_id FROM attachment_storage_jobs j
         WHERE ((j.status IN ('queued','failed') AND j.available_at<=clock_timestamp())
            OR (j.status='claimed' AND j.claimed_at<clock_timestamp()-interval '5 minutes'))
           AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS paused(account_id text,chat_type text,chat_id text)
             WHERE paused.account_id=j.account_id AND paused.chat_type=j.chat_type AND paused.chat_id=j.chat_id)
         ORDER BY j.available_at,j.job_id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE attachment_storage_jobs j SET status='claimed',attempts=j.attempts+1,claim_token=gen_random_uuid(),claimed_at=clock_timestamp(),
         safe_error_code=NULL,updated_at=clock_timestamp()
       FROM candidates c WHERE j.job_id=c.job_id
       RETURNING j.job_id::text,j.account_id,j.chat_type,j.chat_id,j.attachment_id,j.target_kind,j.generation::text,j.claim_token::text`,
      [bounded,JSON.stringify(excludedChats.map(({accountId,chatType,chatId})=>({account_id:accountId,chat_type:chatType,chat_id:chatId})))]);
    return result.rows.map((row) => ({ jobId: Number(row.job_id), accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      attachmentId: row.attachment_id, targetKind: row.target_kind, generation: Number(row.generation), claimToken: row.claim_token }));
  }

  async completeClaim(job: AttachmentStorageJob, expectedRelativePath: string, nextRelativePath: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const update = job.targetKind === 'reclassify' ? await client.query(
        `UPDATE attachments a SET relative_path=$4,updated_at=clock_timestamp()
         WHERE a.attachment_id=$1 AND a.account_id=$2 AND a.status='ready' AND a.relative_path=$3
           AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id=a.account_id AND m.message_id=a.message_id AND m.chat_type=$5 AND m.chat_id=$6)
         `,[job.attachmentId,job.accountId,expectedRelativePath,nextRelativePath,job.chatType,job.chatId])
        : await client.query(
        `SELECT 1 FROM attachments a WHERE a.attachment_id=$1 AND a.account_id=$2 AND a.status='ready' AND a.relative_path=$3
           AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id=a.account_id AND m.message_id=a.message_id AND m.chat_type=$4 AND m.chat_id=$5)
           AND EXISTS (SELECT 1 FROM attachment_storage_settings s WHERE s.account_id=$2 AND s.chat_type=$4 AND s.chat_id=$5 AND s.generation=$6 AND s.secondary_root IS NOT NULL)`,
        [job.attachmentId,job.accountId,expectedRelativePath,job.chatType,job.chatId,job.generation]);
      if (update.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      const done = await client.query(`UPDATE attachment_storage_jobs SET status='completed',target_relative_path=$4,claim_token=NULL,claimed_at=NULL,
        safe_error_code=NULL,updated_at=clock_timestamp() WHERE job_id=$1 AND claim_token=$2::uuid AND generation=$3 AND status='claimed'`,
        [job.jobId,job.claimToken,job.generation,nextRelativePath]);
      if (done.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async failClaim(job: AttachmentStorageJob, code: string): Promise<void> {
    const safeCode = /^[A-Z0-9_]{2,48}$/.test(code) ? code : 'COPY_FAILED';
    await this.pool.query(`UPDATE attachment_storage_jobs SET status='failed',available_at=clock_timestamp()+LEAST(interval '1 hour',interval '5 seconds'*power(2,LEAST(attempts,9))),
      claim_token=NULL,claimed_at=NULL,safe_error_code=$3,updated_at=clock_timestamp() WHERE job_id=$1 AND claim_token=$2::uuid AND status='claimed'`,
      [job.jobId,job.claimToken,safeCode]);
  }

  async releaseClaim(job: AttachmentStorageJob): Promise<void> {
    await this.pool.query(`UPDATE attachment_storage_jobs SET status='queued',available_at=clock_timestamp(),claim_token=NULL,claimed_at=NULL,
      updated_at=clock_timestamp() WHERE job_id=$1 AND claim_token=$2::uuid AND status='claimed'`, [job.jobId,job.claimToken]);
  }

  async listStoredAttachments(key: ConversationKey, cursor: string | null, limit = 50): Promise<StoredAttachmentPage> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const decoded = decodeCursor(cursor);
    const result = await this.pool.query<{ attachment_id: string; message_id: string; name: string | null; kind: StoredAttachmentItem['kind']; mime_type: string | null; size_bytes: string | null; occurred_at: Date; sender_id: string; sender_display_name: string | null }>(
      `SELECT a.attachment_id,m.message_id,a.name,a.kind,a.mime_type,a.size_bytes,m.occurred_at,m.sender_id,
         COALESCE(NULLIF(c.nickname,''),NULLIF(c.display_name,'')) AS sender_display_name
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       LEFT JOIN line_contacts c ON c.account_id=m.account_id AND c.mid=m.sender_id
       WHERE a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND a.status='ready' AND a.relative_path IS NOT NULL
         AND ($4::timestamptz IS NULL OR (m.occurred_at,a.attachment_id)<($4::timestamptz,$5::uuid))
       ORDER BY m.occurred_at DESC,a.attachment_id DESC LIMIT $6`,
      [key.accountId,key.chatType,key.chatId,decoded?.occurredAt ?? null,decoded?.attachmentId ?? null,bounded+1]);
    const hasMore = result.rows.length > bounded;
    const rows = result.rows.slice(0,bounded);
    const attachments = rows.map((row) => ({ attachmentId: row.attachment_id,messageId: row.message_id,name: row.name?.trim() || row.kind,
      kind: row.kind,mimeType: row.mime_type,sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),occurredAt: row.occurred_at.toISOString(),
      senderId: row.sender_id,senderDisplayName: row.sender_display_name?.trim() || '未知發言人' }));
    const last = rows.at(-1);
    return { attachments, nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurred_at.toISOString(),attachmentId: last.attachment_id }) : null };
  }
}
