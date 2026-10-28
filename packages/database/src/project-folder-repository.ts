import type { Pool } from 'pg';
import { withBoundedTransaction, type BoundedTransactionClient } from './bounded-transaction.js';

export type ProjectFolderChatType = 'direct' | 'group' | 'room';
export type ProjectFolderMode = 'READ' | 'READ_WRITE';
export interface ProjectFolderKey { accountId: string; chatType: ProjectFolderChatType; chatId: string }
export interface ProjectFolderRow extends ProjectFolderKey { path: string; mode: ProjectFolderMode; createdBy: string; createdAt: Date; updatedAt: Date }

/** Most folders one chat can have. */
export const PROJECT_FOLDERS_PER_CHAT_MAX = 8;

export type ProjectFolderBindResult =
  | { status: 'created' | 'updated' | 'unchanged'; row: ProjectFolderRow }
  | { status: 'limit' };

interface DbRow { account_id: string; chat_type: ProjectFolderChatType; chat_id: string; path: string; mode: ProjectFolderMode;
  created_by: string; created_at: Date; updated_at: Date }
const COLUMNS = 'account_id, chat_type, chat_id, path, mode, created_by, created_at, updated_at';
const toRow = (row: DbRow): ProjectFolderRow => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, path: row.path,
  mode: row.mode, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });

/** The audit action recorded in agent_permission_audit (audit_kind PROJECT_FOLDER). */
export type ProjectFolderAuditAction = 'bind' | 'update' | 'unbind' | 'unbind_all' | 'skipped';

async function audit(client: BoundedTransactionClient, key: ProjectFolderKey, actor: string, action: ProjectFolderAuditAction,
  detail: Record<string, unknown>): Promise<void> {
  // The chat columns require a USER subject; system actors (job start) keep the chat inside `detail`.
  const userActor = !actor.startsWith('system:');
  await client.query(
    `INSERT INTO agent_permission_audit (account_id, subject_kind, subject_mid, chat_type, chat_id, permission, new_version, actor, audit_kind, detail)
     VALUES ($1, $2, $3, $4, $5, 'project_folder', 1, $6, 'PROJECT_FOLDER', $7::jsonb)`,
    [key.accountId, userActor ? 'USER' : 'EVERYONE', userActor ? actor : null, userActor ? key.chatType : null, userActor ? key.chatId : null,
      actor, JSON.stringify({ action, chatType: key.chatType, chatId: key.chatId, ...detail })]);
}

/** Durable /folder bindings (docs/architecture/project-folders.md). Every change is audited in the same transaction. */
export class ProjectFolderRepository {
  constructor(private readonly pool: Pool) {}

  async list(key: ProjectFolderKey): Promise<ProjectFolderRow[]> {
    const result = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM agent_project_folders WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 ORDER BY created_at, path`,
      [key.accountId, key.chatType, key.chatId]);
    return result.rows.map(toRow);
  }

  /** Binds `path` (already canonical) or updates its mode. A ninth folder is refused (`limit`). */
  async bind(key: ProjectFolderKey, path: string, mode: ProjectFolderMode, actor: string): Promise<ProjectFolderBindResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['project-folders', key.accountId, key.chatType, key.chatId])]);
      const current = (await client.query<DbRow>(
        `SELECT ${COLUMNS} FROM agent_project_folders WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND path = $4 FOR UPDATE`,
        [key.accountId, key.chatType, key.chatId, path])).rows[0];
      if (current) {
        if (current.mode === mode) return { status: 'unchanged' as const, row: toRow(current) };
        const updated = (await client.query<DbRow>(
          `UPDATE agent_project_folders SET mode = $5, updated_at = clock_timestamp()
           WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND path = $4 RETURNING ${COLUMNS}`,
          [key.accountId, key.chatType, key.chatId, path, mode])).rows[0]!;
        await audit(client, key, actor, 'update', { path, from: current.mode, mode });
        return { status: 'updated' as const, row: toRow(updated) };
      }
      const count = Number((await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM agent_project_folders WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
        [key.accountId, key.chatType, key.chatId])).rows[0]!.n);
      if (count >= PROJECT_FOLDERS_PER_CHAT_MAX) return { status: 'limit' as const };
      const inserted = (await client.query<DbRow>(
        `INSERT INTO agent_project_folders (account_id, chat_type, chat_id, path, mode, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING ${COLUMNS}`, [key.accountId, key.chatType, key.chatId, path, mode, actor])).rows[0]!;
      await audit(client, key, actor, 'bind', { path, mode });
      return { status: 'created' as const, row: toRow(inserted) };
    });
  }

  /** Removes one folder. Returns true when it existed. */
  async unbind(key: ProjectFolderKey, path: string, actor: string): Promise<boolean> {
    return withBoundedTransaction(this.pool, async (client) => {
      const removed = await client.query<{ mode: ProjectFolderMode }>(
        'DELETE FROM agent_project_folders WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND path = $4 RETURNING mode',
        [key.accountId, key.chatType, key.chatId, path]);
      if (!removed.rows[0]) return false;
      await audit(client, key, actor, 'unbind', { path, mode: removed.rows[0].mode });
      return true;
    });
  }

  /** Removes every folder of the chat and returns the removed paths. */
  async unbindAll(key: ProjectFolderKey, actor: string): Promise<string[]> {
    return withBoundedTransaction(this.pool, async (client) => {
      const removed = await client.query<{ path: string }>(
        'DELETE FROM agent_project_folders WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 RETURNING path',
        [key.accountId, key.chatType, key.chatId]);
      const paths = removed.rows.map((row) => row.path).sort();
      if (paths.length > 0) await audit(client, key, actor, 'unbind_all', { paths });
      return paths;
    });
  }

  /** A folder that was not mounted at job start (missing, moved, or no longer an allowed location). */
  async recordSkipped(key: ProjectFolderKey, path: string, reason: string, actor = 'system:agent-job'): Promise<void> {
    await withBoundedTransaction(this.pool, (client) => audit(client, key, actor, 'skipped', { path, reason }));
  }
}
