import type { ConversationKey } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { conversationTitleSql, PEER_CONTACT_JOIN } from './name-resolution.js';

export interface RoomActivationScope extends ConversationKey {
  chatType: 'group' | 'room';
}

async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/**
 * First part of an administrator replacement: the account lock of the administrator writers.
 * A caller that owns a larger transaction runs this before it locks the administrator rows,
 * so that its lock order is the same as the other administrator writers.
 */
export async function lockAccountForAdministratorChange(client: PoolClient, accountId: string): Promise<void> {
  await lock(client, `room-activation:account-capacity:${accountId}`);
}

/**
 * Second part: compare the administrator version, replace the administrator row, and stop the free mode
 * that the old administrator turned on. The caller owns the transaction and has run lockAccountForAdministratorChange.
 * Returns the new version, or null if the version differs.
 */
export async function replacePrimaryAdministratorRow(client: PoolClient, accountId: string, chatId: string, userId: string,
  expectedVersion: number | null): Promise<number | null> {
  await lock(client, `room-activation-admin:${accountId}`);
  const current = await client.query<{ version: string }>(
    'SELECT version FROM account_administrator_versions WHERE account_id = $1 FOR UPDATE', [accountId],
  );
  if (expectedVersion === null ? current.rowCount !== 0 : Number(current.rows[0]?.version) !== expectedVersion) return null;
  if (current.rowCount) await client.query('DELETE FROM account_administrators WHERE account_id = $1 AND role = $2', [accountId, 'PRIMARY_ADMIN']);
  await client.query(
    `INSERT INTO account_administrators(account_id, chat_type, chat_id, user_id, role)
     VALUES ($1, 'direct', $2, $3, 'PRIMARY_ADMIN')`, [accountId, chatId, userId],
  );
  // Free mode belongs to the former administrator: it stops with the change.
  await client.query('DELETE FROM room_free_mode WHERE account_id = $1', [accountId]);
  const updated = await client.query<{ version: string }>(
    'SELECT version FROM account_administrator_versions WHERE account_id = $1', [accountId],
  );
  return Number(updated.rows[0]?.version);
}

export class RoomActivationRepository {
  constructor(private readonly pool: Pool) {}

  async setPrimaryAdministrator(accountId: string, chatId: string, userId: string, expectedVersion: number | null): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockAccountForAdministratorChange(client, accountId);
      const version = await replacePrimaryAdministratorRow(client, accountId, chatId, userId, expectedVersion);
      await client.query('COMMIT');
      return version;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** The room's display name by the app-wide conversation title rule (name-resolution.ts), or null when it has none. */
  async getRoomTitle(scope: RoomActivationScope): Promise<string | null> {
    const result = await this.pool.query<{ title: string | null }>(
      `SELECT ${conversationTitleSql()} AS title FROM conversations c ${PEER_CONTACT_JOIN}
       WHERE c.account_id = $1 AND c.chat_type = $2 AND c.chat_id = $3`, [scope.accountId, scope.chatType, scope.chatId],
    );
    const title = result.rows[0]?.title?.trim();
    return title ? title : null;
  }
}
