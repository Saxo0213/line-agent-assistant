import type { Pool } from 'pg';

export class AdminRepository {
  constructor(private readonly pool: Pool) {}

  async getPrimaryAdministratorVersion(accountId: string): Promise<number | null> {
    const result = await this.pool.query<{ version: string }>(
      'SELECT version FROM account_administrator_versions WHERE account_id=$1', [accountId]);
    return result.rows[0] ? Number(result.rows[0].version) : null;
  }

  async hasPrimary(accountId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM account_administrators WHERE account_id=$1 AND role=$2', [accountId, 'PRIMARY_ADMIN']);
    return result.rowCount === 1;
  }

  async isPrimaryAdministrator(accountId: string, chatId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM account_administrators
       WHERE account_id=$1 AND chat_type='direct' AND chat_id=$2 AND user_id=$3 AND role='PRIMARY_ADMIN'`,
      [accountId, chatId, userId],
    );
    return result.rowCount === 1;
  }

  async isPrimaryUser(accountId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM account_administrators WHERE account_id=$1 AND user_id=$2 AND role='PRIMARY_ADMIN'`,
      [accountId, userId],
    );
    return result.rowCount === 1;
  }

  async getPrimaryAdministrator(accountId: string): Promise<{ chatId: string; userId: string } | null> {
    const result = await this.pool.query<{ chat_id: string; user_id: string }>(
      `SELECT chat_id,user_id FROM account_administrators
       WHERE account_id=$1 AND chat_type='direct' AND role='PRIMARY_ADMIN'`, [accountId],
    );
    const row = result.rows[0];
    return row ? { chatId: row.chat_id, userId: row.user_id } : null;
  }

  async bindPrimary(accountId: string, chatId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
       VALUES($1,'direct',$2,$3,'PRIMARY_ADMIN') ON CONFLICT (account_id,role) DO NOTHING RETURNING account_id`,
      [accountId, chatId, userId],
    );
    return result.rowCount === 1;
  }
}
