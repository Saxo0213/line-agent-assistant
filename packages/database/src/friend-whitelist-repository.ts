import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkerBinding } from '@line-agent/contracts';

export type EnrollmentActivation = WorkerBinding & {
  selectedSourceId: string | null; selectedSourceGeneration: number | null;
  adminChatId: string; adminUserId: string; adminVersion: number;
  targetMid: string; scope: FriendWhitelistScope;
};

export type FriendWhitelistScope =
  | { kind: 'ACCOUNT' }
  | { kind: 'CHAT'; chatType: 'group' | 'room'; chatId: string };

export interface FriendWhitelistAuthorization {
  grantId: string;
  accountId: string;
  targetMid: string;
  capability: 'AGENT_USE';
  scopeKind: 'ACCOUNT' | 'CHAT';
  chatType: 'group' | 'room' | null;
  chatId: string | null;
  state: 'ACTIVE' | 'REVOKED';
  version: number;
}

interface GrantRow {
  grant_id: string;
  account_id: string;
  target_mid: string;
  capability: 'AGENT_USE';
  scope_kind: 'ACCOUNT' | 'CHAT';
  chat_type: 'group' | 'room' | null;
  chat_id: string | null;
  state: FriendWhitelistAuthorization['state'];
  version: string;
}

function fromRow(row: GrantRow): FriendWhitelistAuthorization {
  return { grantId: row.grant_id, accountId: row.account_id, targetMid: row.target_mid,
    capability: row.capability, scopeKind: row.scope_kind, chatType: row.chat_type, chatId: row.chat_id,
    state: row.state, version: Number(row.version) };
}

async function lockScope(client: PoolClient, accountId: string, targetMid: string, scope: FriendWhitelistScope): Promise<void> {
  const accountKey = JSON.stringify([accountId, targetMid, 'ACCOUNT']);
  if (scope.kind === 'ACCOUNT') {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [accountKey]);
    return;
  }
  const chatKey = JSON.stringify([accountId, targetMid, 'CHAT', scope.chatType, scope.chatId]);
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [accountKey]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chatKey]);
}

const columns = 'grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, state, version';

function scopePredicate(scope: FriendWhitelistScope, start = 1): { sql: string; values: unknown[] } {
  return scope.kind === 'ACCOUNT'
    ? { sql: `scope_kind = 'ACCOUNT' AND chat_type IS NULL AND chat_id IS NULL`, values: [] }
    : { sql: `scope_kind = 'CHAT' AND chat_type = $${start} AND chat_id = $${start + 1}`, values: [scope.chatType, scope.chatId] };
}

export class FriendWhitelistRepository {
  constructor(private readonly pool: Pool) {}

  async activate(accountId: string, targetMid: string, actorId: string | null = null,
    scope: FriendWhitelistScope = { kind: 'ACCOUNT' }): Promise<FriendWhitelistAuthorization> {
    return this.activateInternal(accountId, targetMid, actorId, scope);
  }

  async activateForEnrollment(input: EnrollmentActivation): Promise<FriendWhitelistAuthorization> {
    if (!/^u[0-9a-fA-F]{32}$/.test(input.targetMid)) throw new Error('ENROLLMENT_AUTHORITY_CHANGED');
    return this.activateInternal(input.accountId, input.targetMid, input.adminUserId, input.scope, input);
  }

  private async activateInternal(accountId: string, targetMid: string, actorId: string | null,
    scope: FriendWhitelistScope, enrollment?: EnrollmentActivation): Promise<FriendWhitelistAuthorization> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (enrollment) {
        const control = await client.query<{ control_epoch: string }>(
          'SELECT control_epoch FROM account_control WHERE singleton=true FOR SHARE');
        if (Number(control.rows[0]?.control_epoch) !== enrollment.controlEpoch) throw new Error('ENROLLMENT_AUTHORITY_CHANGED');
      }
      const account = await client.query<{ connection_mode: string; selected_source_id: string | null;
        selected_source_generation: string | null; worker_instance_id: string | null; worker_binding_epoch: string | null;
        mode: string; source_type: string | null; source_state: string | null }>(
        `SELECT a.connection_mode,a.selected_source_id,a.selected_source_generation,a.worker_instance_id,a.worker_binding_epoch,a.mode,s.source_type,s.state AS source_state
         FROM line_accounts a LEFT JOIN line_account_sources s
           ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR ${enrollment ? 'NO KEY UPDATE' : 'UPDATE'} OF a`, [accountId]);
      const currentAccount = account.rows[0];
      if (!currentAccount || currentAccount.connection_mode !== 'SYSTEM_LOGIN'
        || (currentAccount.selected_source_id !== null
          && (currentAccount.source_type !== 'SYSTEM_LOGIN' || currentAccount.source_state !== 'ACTIVE'))) {
        throw new Error('EXTERNAL_MONITOR_READ_ONLY');
      }
      // Match admission's account-row -> ACCOUNT advisory -> CHAT advisory order.
      await lockScope(client, accountId, targetMid, scope);
      if (enrollment) {
        if (currentAccount.mode !== 'ACTIVE_CONTROL' || currentAccount.worker_instance_id !== enrollment.workerInstanceId
          || Number(currentAccount.worker_binding_epoch) !== enrollment.controlEpoch
          || currentAccount.selected_source_id !== enrollment.selectedSourceId
          || (currentAccount.selected_source_generation === null ? null : Number(currentAccount.selected_source_generation)) !== enrollment.selectedSourceGeneration) {
          throw new Error('ENROLLMENT_AUTHORITY_CHANGED');
        }
        const version = await client.query<{ version: string }>(
          'SELECT version FROM account_administrator_versions WHERE account_id=$1 FOR SHARE', [accountId]);
        if (!version.rows[0] || Number(version.rows[0].version) !== enrollment.adminVersion) throw new Error('ENROLLMENT_AUTHORITY_CHANGED');
        const admin = await client.query(
          `SELECT 1 FROM account_administrators WHERE account_id=$1 AND chat_type='direct'
           AND chat_id=$2 AND user_id=$3 AND role='PRIMARY_ADMIN'`, [accountId, enrollment.adminChatId, enrollment.adminUserId]);
        if (admin.rowCount !== 1) throw new Error('ENROLLMENT_AUTHORITY_CHANGED');
      }
      const predicate = scopePredicate(scope, 3);
      const current = await client.query<GrantRow>(
        `SELECT ${columns} FROM line_friend_whitelist_grants
         WHERE account_id = $1 AND target_mid = $2 AND ${predicate.sql} AND state = 'ACTIVE' FOR UPDATE`,
        [accountId, targetMid, ...predicate.values],
      );
      if (current.rows[0]) {
        await client.query('COMMIT');
        return fromRow(current.rows[0]);
      }
      const latest = await client.query<{ version: string }>(
        `SELECT COALESCE(MAX(version), 0)::text AS version FROM line_friend_whitelist_grants
         WHERE account_id = $1 AND target_mid = $2 AND ${predicate.sql}`,
        [accountId, targetMid, ...predicate.values],
      );
      const version = Number(latest.rows[0]?.version ?? 0) + 1;
      const grantId = randomUUID();
      const created = await client.query<GrantRow>(
        `INSERT INTO line_friend_whitelist_grants
           (grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, version, state)
         VALUES ($1, $2, $3, 'AGENT_USE', $4, $5, $6, $7, 'ACTIVE')
         RETURNING ${columns}`,
        [grantId, accountId, targetMid, scope.kind, scope.kind === 'CHAT' ? scope.chatType : null,
          scope.kind === 'CHAT' ? scope.chatId : null, version],
      );
      await client.query(
        `INSERT INTO line_friend_whitelist_audit
           (grant_id, account_id, target_mid, scope_kind, chat_type, chat_id, action, actor_id, grant_version)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVATED', $7, $8)`,
        [grantId, accountId, targetMid, scope.kind, scope.kind === 'CHAT' ? scope.chatType : null,
          scope.kind === 'CHAT' ? scope.chatId : null, actorId, version],
      );
      await client.query('COMMIT');
      return fromRow(created.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(accountId: string, targetMid: string, actorId: string | null = null,
    scope: FriendWhitelistScope = { kind: 'ACCOUNT' }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockScope(client, accountId, targetMid, scope);
      const predicate = scopePredicate(scope, 3);
      const current = await client.query<GrantRow>(
        `SELECT ${columns} FROM line_friend_whitelist_grants
         WHERE account_id = $1 AND target_mid = $2 AND ${predicate.sql} AND state = 'ACTIVE' FOR UPDATE`,
        [accountId, targetMid, ...predicate.values],
      );
      const grant = current.rows[0];
      if (!grant) {
        await client.query('COMMIT');
        return false;
      }
      const revoked = await client.query<{ version: string }>(
        `UPDATE line_friend_whitelist_grants SET state = 'REVOKED', version = version + 1, revoked_at = clock_timestamp()
         WHERE grant_id = $1 AND state = 'ACTIVE' RETURNING version`, [grant.grant_id],
      );
      await client.query(
        `INSERT INTO line_friend_whitelist_audit
           (grant_id, account_id, target_mid, scope_kind, chat_type, chat_id, action, actor_id, grant_version)
         VALUES ($1, $2, $3, $4, $5, $6, 'REVOKED', $7, $8)`,
        [grant.grant_id, accountId, targetMid, grant.scope_kind, grant.chat_type, grant.chat_id, actorId, revoked.rows[0]!.version],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Revokes every currently active Agent grant for one user atomically, including account and chat scopes. */
  async revokeAll(accountId: string, targetMid: string, actorId: string | null = null): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      // Chat activation takes a shared lock on this account/user key, so the exclusive lock fences new scopes
      // while this transaction revokes the complete active set.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([accountId, targetMid, 'ACCOUNT'])]);
      const revoked = await client.query<GrantRow>(
        `UPDATE line_friend_whitelist_grants
         SET state='REVOKED', version=version+1, revoked_at=clock_timestamp()
         WHERE account_id=$1 AND target_mid=$2 AND capability='AGENT_USE' AND state='ACTIVE'
         RETURNING ${columns}`,
        [accountId, targetMid]);
      for (const grant of revoked.rows) {
        await client.query(
          `INSERT INTO line_friend_whitelist_audit
             (grant_id, account_id, target_mid, scope_kind, chat_type, chat_id, action, actor_id, grant_version)
           VALUES ($1,$2,$3,$4,$5,$6,'REVOKED',$7,$8)`,
          [grant.grant_id, accountId, targetMid, grant.scope_kind, grant.chat_type, grant.chat_id, actorId, grant.version]);
      }
      await client.query('COMMIT');
      return revoked.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveAuthorization(accountId: string, targetMid: string,
    scope: FriendWhitelistScope = { kind: 'ACCOUNT' }): Promise<FriendWhitelistAuthorization | null> {
    if (scope.kind === 'CHAT') {
      const chat = await this.pool.query<GrantRow>(
        `SELECT ${columns} FROM line_friend_whitelist_grants
         WHERE account_id = $1 AND target_mid = $2 AND scope_kind = 'CHAT' AND chat_type = $3 AND chat_id = $4 AND state = 'ACTIVE'`,
        [accountId, targetMid, scope.chatType, scope.chatId]);
      if (chat.rows[0]) return fromRow(chat.rows[0]);
      const account = await this.pool.query<GrantRow>(
        `SELECT ${columns} FROM line_friend_whitelist_grants
         WHERE account_id = $1 AND target_mid = $2 AND scope_kind = 'ACCOUNT' AND state = 'ACTIVE'`, [accountId, targetMid]);
      if (account.rows[0]) return fromRow(account.rows[0]);
    }
    const predicate = scopePredicate(scope, 3);
    const result = await this.pool.query<GrantRow>(
      `SELECT ${columns} FROM line_friend_whitelist_grants
       WHERE account_id = $1 AND target_mid = $2 AND ${predicate.sql} AND state = 'ACTIVE'`,
      [accountId, targetMid, ...predicate.values],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
}
