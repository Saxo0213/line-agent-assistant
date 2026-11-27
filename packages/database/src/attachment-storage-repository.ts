import { Buffer } from 'node:buffer';
import type { ConversationKey, WritableConversationKey } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';

export type AttachmentStorageKey = WritableConversationKey;
/** The most extra folders of one chat. */
export const ATTACHMENT_STORAGE_FOLDER_LIMIT = 10;
/** The longest description of an extra folder. */
export const ATTACHMENT_STORAGE_DESCRIPTION_MAX = 200;
/** `classified`: a folder that the Agent classifier can choose. `default`: the one folder for what no classification folder gets (path only). */
export type AttachmentStorageFolderKind = 'classified' | 'default';
export type AttachmentStorageFolder = AttachmentStorageKey & { folderId: string; root: string; description: string; kind: AttachmentStorageFolderKind };
/**
 * The folder that receives every ready attachment and the history without a classifier, or null when the classifier works.
 * Default folder and no classification folder: the default folder. No default folder and one classification folder: that folder.
 */
export function singleCopyTarget(folders: readonly AttachmentStorageFolder[]): AttachmentStorageFolder | null {
  const classified = folders.filter((folder) => folder.kind === 'classified');
  const fallback = folders.find((folder) => folder.kind === 'default');
  if (classified.length === 0) return fallback ?? null;
  return classified.length === 1 && !fallback ? classified[0]! : null;
}
export type AttachmentStorageJob = AttachmentStorageKey & { jobId: number; attachmentId: string; targetKind: 'secondary' | 'reclassify'; folderId: string | null; claimToken: string };
export type FolderProgress = { queued: number; claimed: number; failed: number; completed: number };
export type ClassificationDecidedBy = 'agent' | 'default_uncertain' | 'default_failed';
/** A classification that one worker holds. `attempts` counts this run. */
export type ClassificationClaim = AttachmentStorageKey & { classificationId: number; attachmentId: string; attempts: number };
export type ClassificationOutcome = {
  /** The folder that the classifier chose. Null: no choice, the default folder is used. */
  folderId: string | null;
  /** Null: copy to the folder without a stored decision (the chat has one folder only). */
  decidedBy: ClassificationDecidedBy | null;
  reason: string | null;
  errorCode?: string | null;
};
export type ClassificationResult = { status: 'decided' | 'passthrough' | 'dropped'; folderId: string | null; decidedBy: ClassificationDecidedBy | null };
export type ClassificationContext = {
  name: string; kind: 'image' | 'video' | 'audio' | 'file'; mimeType: string | null; sizeBytes: number | null; relativePath: string | null;
  occurredAt: string; ownText: string; nearby: { senderDisplayName: string; text: string; occurredAt: string }[];
};
export type RecentClassification = { attachmentName: string; folderName: string | null; decidedBy: ClassificationDecidedBy; reason: string; decidedAt: string };
export type FolderErrorCode = 'LIMIT_REACHED' | 'DUPLICATE_FOLDER' | 'NOT_FOUND';
/** A folder change that the rules refuse. The code is stable. */
export class AttachmentStorageFolderError extends Error {
  constructor(readonly code: FolderErrorCode) { super(`Attachment folder change refused: ${code}`); }
}
export type StoredAttachmentItem = {
  attachmentId: string; messageId: string; name: string; kind: 'image' | 'video' | 'audio' | 'file'; mimeType: string | null;
  sizeBytes: number | null; occurredAt: string; senderId: string; senderDisplayName: string;
};
export type StoredAttachmentPage = { attachments: StoredAttachmentItem[]; nextCursor: string | null };
export type StoredAttachmentSender = { senderId: string; senderDisplayName: string; count: number };
/** The stored name, or the kind when the name is empty or the placeholder text "undefined" or "null" of a sender client. */
function displayAttachmentName(name: string | null, kind: string): string {
  const trimmed = name?.trim() ?? '';
  return trimmed && !/^(?:undefined|null)$/i.test(trimmed) ? trimmed : kind;
}
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
const lockName = (key: AttachmentStorageKey) => JSON.stringify(['attachment-storage', key.accountId, key.chatType, key.chatId]);
type FolderRow = { folder_id: string; account_id: string; chat_type: AttachmentStorageKey['chatType']; chat_id: string; root: string; description: string; kind: AttachmentStorageFolderKind };
const toFolder = (row: FolderRow): AttachmentStorageFolder => ({ folderId: row.folder_id, accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
  root: row.root, description: row.description, kind: row.kind });
const samePathText = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
/** The base name of a folder path (Windows or POSIX separators). */
export const folderBaseName = (root: string): string => root.split(/[\\/]+/).filter(Boolean).pop() ?? root;

/** Durable extra folders of each chat, bounded and restartable copy/reclassification claims, and the classifier queue. */
export class AttachmentStorageRepository {
  constructor(private readonly pool: Pool) {}

  /** The extra folders of one chat, oldest first. */
  async listFolders(key: AttachmentStorageKey): Promise<AttachmentStorageFolder[]> {
    return this.listFoldersOn(this.pool, key);
  }

  private async listFoldersOn(client: Pool | PoolClient, key: AttachmentStorageKey): Promise<AttachmentStorageFolder[]> {
    const result = await client.query<FolderRow>(
      `SELECT folder_id,account_id,chat_type,chat_id,root,description,kind FROM attachment_storage_folders
       WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 ORDER BY created_at,folder_id`, [key.accountId, key.chatType, key.chatId]);
    return result.rows.map(toFolder);
  }

  private async locked<T>(key: AttachmentStorageKey, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockName(key)]);
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /**
   * Add a classification folder (at most 10). Refuses the same path as any folder of the chat, the default folder included.
   * Returns the folders of the chat after the change.
   */
  async addFolder(key: AttachmentStorageKey, root: string, description = ''): Promise<{ folder: AttachmentStorageFolder; folders: AttachmentStorageFolder[] }> {
    return this.locked(key, async (client) => {
      const existing = await this.listFoldersOn(client, key);
      if (existing.filter((folder) => folder.kind === 'classified').length >= ATTACHMENT_STORAGE_FOLDER_LIMIT) throw new AttachmentStorageFolderError('LIMIT_REACHED');
      if (existing.some((folder) => samePathText(folder.root, root))) throw new AttachmentStorageFolderError('DUPLICATE_FOLDER');
      const result = await client.query<FolderRow>(
        `INSERT INTO attachment_storage_folders (account_id,chat_type,chat_id,root,description,kind) VALUES ($1,$2,$3,$4,$5,'classified')
         RETURNING folder_id,account_id,chat_type,chat_id,root,description,kind`,
        [key.accountId, key.chatType, key.chatId, root, description.slice(0, ATTACHMENT_STORAGE_DESCRIPTION_MAX)]);
      const folder = toFolder(result.rows[0]!);
      return { folder, folders: [...existing, folder] };
    });
  }

  /**
   * Set (or replace) the default folder. The same path as the current default folder changes nothing.
   * Refuses the path of a classification folder. A replaced default folder is removed like any folder (its waiting copies stop).
   */
  async setDefaultRoot(key: AttachmentStorageKey, root: string): Promise<{ folder: AttachmentStorageFolder; folders: AttachmentStorageFolder[] }> {
    return this.locked(key, async (client) => {
      const existing = await this.listFoldersOn(client, key);
      const current = existing.find((folder) => folder.kind === 'default');
      if (current && samePathText(current.root, root)) return { folder: current, folders: existing };
      if (existing.some((folder) => folder.kind === 'classified' && samePathText(folder.root, root))) throw new AttachmentStorageFolderError('DUPLICATE_FOLDER');
      if (current) {
        await this.supersedeJobsOf(client, current.folderId);
        await client.query('DELETE FROM attachment_storage_folders WHERE folder_id=$1', [current.folderId]);
      }
      const result = await client.query<FolderRow>(
        `INSERT INTO attachment_storage_folders (account_id,chat_type,chat_id,root,description,kind) VALUES ($1,$2,$3,$4,'','default')
         RETURNING folder_id,account_id,chat_type,chat_id,root,description,kind`, [key.accountId, key.chatType, key.chatId, root]);
      const folder = toFolder(result.rows[0]!);
      return { folder, folders: [...existing.filter((entry) => entry.folderId !== current?.folderId), folder] };
    });
  }

  private async supersedeJobsOf(client: PoolClient, folderId: string): Promise<void> {
    await client.query(`UPDATE attachment_storage_jobs SET status='superseded',claim_token=NULL,claimed_at=NULL,updated_at=clock_timestamp()
      WHERE folder_id=$1 AND target_kind='secondary' AND status IN ('queued','claimed','failed')`, [folderId]);
  }

  /** Remove a folder of either kind. Its waiting copy jobs become superseded. The files on disk stay. */
  async removeFolder(key: AttachmentStorageKey, folderId: string): Promise<{ remaining: AttachmentStorageFolder[] }> {
    return this.locked(key, async (client) => {
      const existing = await this.listFoldersOn(client, key);
      if (!existing.some((folder) => folder.folderId === folderId)) throw new AttachmentStorageFolderError('NOT_FOUND');
      await this.supersedeJobsOf(client, folderId);
      await client.query('DELETE FROM attachment_storage_folders WHERE folder_id=$1', [folderId]);
      return { remaining: existing.filter((folder) => folder.folderId !== folderId) };
    });
  }

  /** Change the description of a classification folder. The default folder has none. */
  async setFolderDescription(key: AttachmentStorageKey, folderId: string, description: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE attachment_storage_folders SET description=$5,updated_at=clock_timestamp()
      WHERE folder_id=$4 AND account_id=$1 AND chat_type=$2 AND chat_id=$3 AND kind='classified'`,
      [key.accountId, key.chatType, key.chatId, folderId, description.slice(0, ATTACHMENT_STORAGE_DESCRIPTION_MAX)]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Queue one secondary copy of a ready attachment to one folder of its chat. A job for another folder, or a finished job, is queued again. */
  async admitReadyAttachment(key: AttachmentStorageKey, attachmentId: string, folderId: string, client: Pool | PoolClient = this.pool): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO attachment_storage_jobs (account_id,chat_type,chat_id,attachment_id,target_kind,generation,status,folder_id)
       SELECT a.account_id,a.chat_type,a.chat_id,a.attachment_id,'secondary',0,'queued',f.folder_id
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       JOIN attachment_storage_folders f ON f.folder_id=$5::uuid AND f.account_id=a.account_id AND f.chat_type=a.chat_type AND f.chat_id=m.chat_id
         WHERE a.attachment_id=$4 AND a.status='ready' AND a.relative_path IS NOT NULL
         AND a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3
       ON CONFLICT (attachment_id,target_kind) DO UPDATE SET folder_id=EXCLUDED.folder_id,status='queued',available_at=clock_timestamp(),
         claim_token=NULL,claimed_at=NULL,safe_error_code=NULL,updated_at=clock_timestamp()
       WHERE attachment_storage_jobs.folder_id IS DISTINCT FROM EXCLUDED.folder_id OR attachment_storage_jobs.status IN ('failed','completed')
       RETURNING job_id`, [key.accountId, key.chatType, key.chatId, attachmentId, folderId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** One page of the history back-fill. `folderId` is the target folder of a secondary page and null for a reclassify page. */
  async admitReadyPage(key: AttachmentStorageKey, folderId: string | null, targetKind: 'secondary' | 'reclassify', afterAttachmentId: string | null, limit = 100): Promise<{ selected: number; lastAttachmentId: string | null }> {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.pool.query<{ selected_count: string; last_attachment_id: string | null }>(
      `WITH picked AS (
         SELECT a.account_id,a.chat_type,m.chat_id,a.attachment_id FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
         WHERE a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND a.status='ready' AND a.relative_path IS NOT NULL
           AND ($5::uuid IS NULL OR a.attachment_id>$5::uuid)
           AND (($4='secondary' AND EXISTS (SELECT 1 FROM attachment_storage_folders f WHERE f.folder_id=$6::uuid
               AND f.account_id=a.account_id AND f.chat_type=a.chat_type AND f.chat_id=m.chat_id))
             OR ($4='reclassify' AND a.chat_type IN ('group','room') AND a.relative_path ~ '/(19|20)[0-9]{2}/[0-9]{2}/'))
         ORDER BY a.attachment_id LIMIT $7
       ), inserted AS (
         INSERT INTO attachment_storage_jobs (account_id,chat_type,chat_id,attachment_id,target_kind,generation,status,folder_id)
         SELECT account_id,chat_type,chat_id,attachment_id,$4,0,'queued',$6::uuid FROM picked
         ON CONFLICT (attachment_id,target_kind) DO UPDATE SET folder_id=EXCLUDED.folder_id,status='queued',available_at=clock_timestamp(),
           claim_token=NULL,claimed_at=NULL,safe_error_code=NULL,updated_at=clock_timestamp()
         WHERE attachment_storage_jobs.folder_id IS DISTINCT FROM EXCLUDED.folder_id OR attachment_storage_jobs.status='failed'
         RETURNING job_id
       ) SELECT (SELECT count(*) FROM picked)::text AS selected_count,
         (SELECT attachment_id FROM picked ORDER BY attachment_id DESC LIMIT 1) AS last_attachment_id,
         (SELECT count(*) FROM inserted) AS inserted_count`,
      [key.accountId,key.chatType,key.chatId,targetKind,afterAttachmentId,folderId,bounded]);
    const row = result.rows[0]!;
    return { selected: Number(row.selected_count), lastAttachmentId: row.last_attachment_id };
  }

  /** Queue the failed copies again. A secondary job is queued only while its folder still exists. */
  async retryFailed(key: AttachmentStorageKey, targetKind: 'secondary' | 'reclassify' = 'secondary'): Promise<number> {
    const result = await this.pool.query(`UPDATE attachment_storage_jobs SET status='queued',available_at=clock_timestamp(),safe_error_code=NULL,updated_at=clock_timestamp()
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND target_kind=$4 AND status='failed'
        AND ($4<>'secondary' OR EXISTS (SELECT 1 FROM attachment_storage_folders f WHERE f.folder_id=attachment_storage_jobs.folder_id))`,
      [key.accountId,key.chatType,key.chatId,targetKind]);
    return result.rowCount ?? 0;
  }

  /** The copy progress of each extra folder of one chat. */
  async getFolderProgress(key: AttachmentStorageKey): Promise<Map<string, FolderProgress>> {
    const result = await this.pool.query<{ folder_id: string; status: string; count: string }>(`SELECT folder_id,status,count(*)::text AS count FROM attachment_storage_jobs
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND target_kind='secondary' AND folder_id IS NOT NULL GROUP BY folder_id,status`, [key.accountId,key.chatType,key.chatId]);
    const progress = new Map<string, FolderProgress>();
    for (const row of result.rows) {
      const entry = progress.get(row.folder_id) ?? { queued: 0, claimed: 0, failed: 0, completed: 0 };
      if (row.status === 'queued' || row.status === 'claimed' || row.status === 'failed' || row.status === 'completed') entry[row.status] = Number(row.count);
      progress.set(row.folder_id, entry);
    }
    return progress;
  }

  async listRecoveryChats(): Promise<AttachmentStorageKey[]> {
    const result = await this.pool.query<{ account_id: string; chat_type: AttachmentStorageKey['chatType']; chat_id: string }>(
      `SELECT DISTINCT account_id,chat_type,chat_id FROM attachment_storage_folders
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
    const result = await this.pool.query<{ job_id: string; account_id: string; chat_type: AttachmentStorageJob['chatType']; chat_id: string; attachment_id: string; target_kind: AttachmentStorageJob['targetKind']; folder_id: string | null; claim_token: string }>(
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
       RETURNING j.job_id::text,j.account_id,j.chat_type,j.chat_id,j.attachment_id,j.target_kind,j.folder_id::text,j.claim_token::text`,
      [bounded,JSON.stringify(excludedChats.map(({accountId,chatType,chatId})=>({account_id:accountId,chat_type:chatType,chat_id:chatId})))]);
    return result.rows.map((row) => ({ jobId: Number(row.job_id), accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      attachmentId: row.attachment_id, targetKind: row.target_kind, folderId: row.folder_id, claimToken: row.claim_token }));
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
           AND EXISTS (SELECT 1 FROM attachment_storage_folders f WHERE f.folder_id=$6::uuid AND f.account_id=$2 AND f.chat_type=$4 AND f.chat_id=$5)`,
        [job.attachmentId,job.accountId,expectedRelativePath,job.chatType,job.chatId,job.folderId]);
      if (update.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      const done = await client.query(`UPDATE attachment_storage_jobs SET status='completed',target_relative_path=$3,claim_token=NULL,claimed_at=NULL,
        safe_error_code=NULL,updated_at=clock_timestamp() WHERE job_id=$1 AND claim_token=$2::uuid AND status='claimed'`,
        [job.jobId,job.claimToken,nextRelativePath]);
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

  // ---- Classifier queue and decisions ----

  /** Put a ready attachment into the classifier queue. An attachment that already has a row keeps it. */
  async enqueueClassification(key: AttachmentStorageKey, attachmentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO attachment_storage_classifications (account_id,chat_type,chat_id,attachment_id)
       SELECT a.account_id,a.chat_type,m.chat_id,a.attachment_id FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       WHERE a.attachment_id=$4 AND a.status='ready' AND a.relative_path IS NOT NULL AND a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3
       ON CONFLICT (attachment_id) DO NOTHING RETURNING classification_id`, [key.accountId, key.chatType, key.chatId, attachmentId]);
    return (result.rowCount ?? 0) > 0;
  }

  async getClassification(attachmentId: string): Promise<{ status: 'pending' | 'claimed' | 'decided' | 'superseded'; folderId: string | null } | null> {
    const result = await this.pool.query<{ status: 'pending' | 'claimed' | 'decided' | 'superseded'; folder_id: string | null }>(
      'SELECT status,folder_id::text FROM attachment_storage_classifications WHERE attachment_id=$1', [attachmentId]);
    const row = result.rows[0];
    return row ? { status: row.status, folderId: row.folder_id } : null;
  }

  async countWaitingClassifications(key: AttachmentStorageKey): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM attachment_storage_classifications
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND status IN ('pending','claimed')`, [key.accountId, key.chatType, key.chatId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** The next waiting classification, or null. A claim older than 5 minutes (a stopped app) is taken again. */
  async claimClassification(): Promise<ClassificationClaim | null> {
    const result = await this.pool.query<{ classification_id: string; account_id: string; chat_type: AttachmentStorageKey['chatType']; chat_id: string; attachment_id: string; attempts: number }>(
      `UPDATE attachment_storage_classifications c SET status='claimed',attempts=c.attempts+1,claimed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE c.classification_id=(SELECT classification_id FROM attachment_storage_classifications
         WHERE (status='pending' AND available_at<=clock_timestamp()) OR (status='claimed' AND claimed_at<clock_timestamp()-interval '5 minutes')
         ORDER BY available_at,classification_id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING c.classification_id::text,c.account_id,c.chat_type,c.chat_id,c.attachment_id,c.attempts`);
    const row = result.rows[0];
    return row ? { classificationId: Number(row.classification_id), accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
      attachmentId: row.attachment_id, attempts: row.attempts } : null;
  }

  /** Put a failed run back in the queue after a delay. */
  async retryClassificationLater(claim: ClassificationClaim, delayMs: number, errorCode: string): Promise<void> {
    const safeCode = /^[A-Z0-9_]{2,48}$/.test(errorCode) ? errorCode : 'CLASSIFIER_FAILED';
    await this.pool.query(`UPDATE attachment_storage_classifications SET status='pending',claimed_at=NULL,
      available_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),safe_error_code=$4,updated_at=clock_timestamp()
      WHERE classification_id=$1 AND status='claimed' AND attempts=$2`, [claim.classificationId, claim.attempts, Math.max(0, Math.trunc(delayMs)), safeCode]);
  }

  /**
   * Store the decision and queue the copy in one transaction. An unknown folder, or no folder choice, uses the default folder;
   * with no default folder the decision has no folder and nothing is copied. `decidedBy: null` copies to `folderId` without a stored decision.
   */
  async completeClassification(claim: ClassificationClaim, outcome: ClassificationOutcome): Promise<ClassificationResult> {
    const key: AttachmentStorageKey = { accountId: claim.accountId, chatType: claim.chatType, chatId: claim.chatId };
    return this.locked(key, async (client) => {
      const folders = await this.listFoldersOn(client, key);
      const chosen = outcome.folderId ? folders.find((folder) => folder.folderId === outcome.folderId) : undefined;
      const fallback = folders.find((folder) => folder.kind === 'default');
      const dropped = { status: 'dropped' as const, folderId: null, decidedBy: null };
      const close = (status: 'superseded') => client.query(`UPDATE attachment_storage_classifications SET status='${status}',claimed_at=NULL,updated_at=clock_timestamp()
        WHERE classification_id=$1 AND status='claimed'`, [claim.classificationId]);
      if (outcome.decidedBy === null) {
        // Single-folder behaviour: copy without a stored decision. No folder left: nothing to copy.
        const target = chosen ?? singleCopyTarget(folders);
        const update = await close('superseded');
        if (!target || update.rowCount !== 1) return dropped;
        await this.admitReadyAttachment(key, claim.attachmentId, target.folderId, client);
        return { status: 'passthrough' as const, folderId: target.folderId, decidedBy: null };
      }
      // A decision: the chosen classification folder, else the default folder, else no folder (the fixed location only).
      const target = chosen?.kind === 'classified' ? chosen : fallback;
      const decidedBy = outcome.decidedBy === 'agent' && target !== chosen ? 'default_uncertain' as const : outcome.decidedBy;
      const code = outcome.errorCode && /^[A-Z0-9_]{2,48}$/.test(outcome.errorCode) ? outcome.errorCode : null;
      const update = await client.query(`UPDATE attachment_storage_classifications SET status='decided',claimed_at=NULL,folder_id=$2,folder_name=$3,decided_by=$4,reason=$5,
          safe_error_code=$6,decided_at=clock_timestamp(),updated_at=clock_timestamp() WHERE classification_id=$1 AND status='claimed'`,
        [claim.classificationId, target?.folderId ?? null, target ? folderBaseName(target.root).slice(0, 260) : null, decidedBy, (outcome.reason ?? '').slice(0, 200), code]);
      if (update.rowCount !== 1) return dropped;
      if (target) await this.admitReadyAttachment(key, claim.attachmentId, target.folderId, client);
      return { status: 'decided' as const, folderId: target?.folderId ?? null, decidedBy };
    });
  }

  /** What the classifier reads about an attachment: its facts, the text of its own message and the nearest text messages (±10 minutes). */
  async getClassificationContext(attachmentId: string, nearbyLimit = 5): Promise<ClassificationContext | null> {
    const own = await this.pool.query<{ account_id: string; chat_type: string; chat_id: string; message_id: string; name: string | null; kind: ClassificationContext['kind'];
      mime_type: string | null; size_bytes: string | null; relative_path: string | null; occurred_at: Date; text_content: string | null }>(
      `SELECT a.account_id,m.chat_type,m.chat_id,m.message_id,a.name,a.kind,a.mime_type,a.size_bytes,a.relative_path,m.occurred_at,m.text_content
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id WHERE a.attachment_id=$1`, [attachmentId]);
    const row = own.rows[0];
    if (!row) return null;
    const near = await this.pool.query<{ sender: string; text_content: string; occurred_at: Date }>(
      `SELECT COALESCE(NULLIF(c.nickname,''),NULLIF(c.display_name,''),'') AS sender,m.text_content,m.occurred_at
       FROM messages m LEFT JOIN line_contacts c ON c.account_id=m.account_id AND c.mid=m.sender_id
       WHERE m.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND m.message_id<>$4
         AND m.text_content IS NOT NULL AND btrim(m.text_content)<>''
         AND m.occurred_at BETWEEN $5::timestamptz-interval '10 minutes' AND $5::timestamptz+interval '10 minutes'
       ORDER BY abs(extract(epoch FROM (m.occurred_at-$5::timestamptz))),m.message_id LIMIT $6`,
      [row.account_id, row.chat_type, row.chat_id, row.message_id, row.occurred_at.toISOString(), Math.max(0, Math.min(10, Math.trunc(nearbyLimit)))]);
    return { name: displayAttachmentName(row.name, row.kind), kind: row.kind, mimeType: row.mime_type, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      relativePath: row.relative_path, occurredAt: row.occurred_at.toISOString(), ownText: row.text_content ?? '',
      nearby: near.rows.map((item) => ({ senderDisplayName: item.sender.trim(), text: item.text_content, occurredAt: item.occurred_at.toISOString() }))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) };
  }

  async listRecentClassifications(key: AttachmentStorageKey, limit = 10): Promise<RecentClassification[]> {
    const result = await this.pool.query<{ name: string | null; kind: string; folder_name: string | null; decided_by: ClassificationDecidedBy; reason: string | null; decided_at: Date }>(
      `SELECT a.name,a.kind,c.folder_name,c.decided_by,c.reason,c.decided_at FROM attachment_storage_classifications c
       JOIN attachments a ON a.attachment_id=c.attachment_id
       WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3 AND c.status='decided' ORDER BY c.decided_at DESC,c.classification_id DESC LIMIT $4`,
      [key.accountId, key.chatType, key.chatId, Math.max(1, Math.min(50, Math.trunc(limit)))]);
    return result.rows.map((row) => ({ attachmentName: displayAttachmentName(row.name, row.kind), folderName: row.folder_name, decidedBy: row.decided_by,
      reason: row.reason ?? '', decidedAt: row.decided_at.toISOString() }));
  }

  /** The senders who have saved files in one chat, with their file counts. Same rows as `listStoredAttachments`. */
  async listStoredAttachmentSenders(key: ConversationKey): Promise<StoredAttachmentSender[]> {
    const result = await this.pool.query<{ sender_id: string; sender_display_name: string | null; count: string }>(
      `SELECT m.sender_id,COALESCE(NULLIF(max(c.nickname),''),NULLIF(max(c.display_name),'')) AS sender_display_name,count(*)::text AS count
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       LEFT JOIN line_contacts c ON c.account_id=m.account_id AND c.mid=m.sender_id
       WHERE a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND a.status='ready' AND a.relative_path IS NOT NULL
       GROUP BY m.sender_id`, [key.accountId, key.chatType, key.chatId]);
    return result.rows.map((row) => ({ senderId: row.sender_id, named: Boolean(row.sender_display_name?.trim()),
      senderDisplayName: row.sender_display_name?.trim() || '未知發言人', count: Number(row.count) }))
      // Equal counts: senders with a name first, the unnamed sender last, then by name.
      .sort((a, b) => b.count - a.count || Number(b.named) - Number(a.named) || a.senderDisplayName.localeCompare(b.senderDisplayName) || a.senderId.localeCompare(b.senderId))
      .map(({ senderId, senderDisplayName, count }) => ({ senderId, senderDisplayName, count }));
  }

  async listStoredAttachments(key: ConversationKey, cursor: string | null, limit = 50, senderId: string | null = null): Promise<StoredAttachmentPage> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const decoded = decodeCursor(cursor);
    const result = await this.pool.query<{ attachment_id: string; message_id: string; name: string | null; kind: StoredAttachmentItem['kind']; mime_type: string | null; size_bytes: string | null; occurred_at: Date; sender_id: string; sender_display_name: string | null }>(
      `SELECT a.attachment_id,m.message_id,a.name,a.kind,a.mime_type,a.size_bytes,m.occurred_at,m.sender_id,
         COALESCE(NULLIF(c.nickname,''),NULLIF(c.display_name,'')) AS sender_display_name
       FROM attachments a JOIN messages m ON m.account_id=a.account_id AND m.message_id=a.message_id
       LEFT JOIN line_contacts c ON c.account_id=m.account_id AND c.mid=m.sender_id
       WHERE a.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND a.status='ready' AND a.relative_path IS NOT NULL
         AND ($4::timestamptz IS NULL OR (m.occurred_at,a.attachment_id)<($4::timestamptz,$5::uuid))
         AND ($7::text IS NULL OR m.sender_id=$7::text)
       ORDER BY m.occurred_at DESC,a.attachment_id DESC LIMIT $6`,
      [key.accountId,key.chatType,key.chatId,decoded?.occurredAt ?? null,decoded?.attachmentId ?? null,bounded+1,senderId]);
    const hasMore = result.rows.length > bounded;
    const rows = result.rows.slice(0,bounded);
    const attachments = rows.map((row) => ({ attachmentId: row.attachment_id,messageId: row.message_id,name: displayAttachmentName(row.name, row.kind),
      kind: row.kind,mimeType: row.mime_type,sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),occurredAt: row.occurred_at.toISOString(),
      senderId: row.sender_id,senderDisplayName: row.sender_display_name?.trim() || '未知發言人' }));
    const last = rows.at(-1);
    return { attachments, nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurred_at.toISOString(),attachmentId: last.attachment_id }) : null };
  }
}
