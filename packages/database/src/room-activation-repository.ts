import { createHmac, randomUUID } from 'node:crypto';
import type { ConversationKey } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { conversationTitleSql, PEER_CONTACT_JOIN } from './name-resolution.js';

export interface RoomActivationScope extends ConversationKey {
  chatType: 'group' | 'room';
}

export type RoomActivationRequestResult =
  | { disposition: 'created' | 'coalesced' | 'duplicate'; requestId: string; waitExpiresAt: Date; state: string }
  | { disposition: 'rate_limited' | 'capacity_reached' | 'admin_unbound' | 'room_missing' | 'already_enabled' };

export interface WaitingChallengeClaim {
  requestId: string;
  leaseToken: string;
  accountId: string;
  adminChatId: string;
  adminUserId: string;
}

export type ConfirmationResult =
  | { disposition: 'enabled' }
  | { disposition: 'wrong_token' | 'duplicate_attempt' | 'out_of_scope' | 'already_consumed' | 'expired' | 'cancelled' | 'exhausted' };

export type PrimaryAdminEnableResult = {
  disposition: 'enabled' | 'already_enabled' | 'duplicate' | 'not_primary_admin' | 'room_missing';
};

export interface RoomAgentPolicy {
  accountId: string;
  chatType: RoomActivationScope['chatType'];
  chatId: string;
  state: 'DISABLED' | 'PENDING_CONFIRMATION' | 'ENABLED';
  authorityVersion: number;
}

export interface ActiveRoomAgentAuthorization {
  grantId: string;
  version: number;
}

interface ActivationRequestRow {
  request_id: string;
  account_id: string;
  chat_type: RoomActivationScope['chatType'];
  chat_id: string;
  admin_chat_id: string;
  admin_user_id: string;
  admin_version: string;
  room_authority_version: string;
  state: string;
  wait_expires_at: Date;
  confirm_expires_at: Date | null;
  request_version: string;
}

async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function keyedDigest(token: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(token, 'utf8').digest();
}

export class RoomActivationRepository {
  constructor(private readonly pool: Pool) {}

  async setPrimaryAdministrator(accountId: string, chatId: string, userId: string, expectedVersion: number | null): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lock(client, `room-activation:account-capacity:${accountId}`);
      await client.query(
        `SELECT request_id FROM room_activation_requests WHERE account_id = $1
          AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN') ORDER BY request_id FOR UPDATE`, [accountId],
      );
      await client.query(
        'SELECT chat_type, chat_id FROM room_agent_policies WHERE account_id = $1 ORDER BY chat_type, chat_id FOR UPDATE', [accountId],
      );
      await lock(client, `room-activation-admin:${accountId}`);
      const current = await client.query<{ version: string }>(
        'SELECT version FROM account_administrator_versions WHERE account_id = $1 FOR UPDATE', [accountId],
      );
      if (expectedVersion === null ? current.rowCount !== 0 : Number(current.rows[0]?.version) !== expectedVersion) {
        await client.query('COMMIT');
        return null;
      }
      if (current.rowCount) await client.query('DELETE FROM account_administrators WHERE account_id = $1 AND role = $2', [accountId, 'PRIMARY_ADMIN']);
      await client.query(
        `INSERT INTO account_administrators(account_id, chat_type, chat_id, user_id, role)
         VALUES ($1, 'direct', $2, $3, 'PRIMARY_ADMIN')`, [accountId, chatId, userId],
      );
      await client.query(
        `UPDATE room_activation_requests SET state = 'CANCELLED', request_version = request_version + 1, updated_at = clock_timestamp()
         WHERE account_id = $1 AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN')`, [accountId],
      );
      await client.query(
        `UPDATE room_activation_challenges c SET invalidated_at = clock_timestamp()
         FROM room_activation_requests r WHERE r.request_id = c.request_id AND r.account_id = $1
          AND c.consumed_at IS NULL AND c.invalidated_at IS NULL`, [accountId],
      );
      const changedPolicies = await client.query<{ chat_type: RoomActivationScope['chatType']; chat_id: string; authority_version: string }>(
        `UPDATE room_agent_policies SET state = 'DISABLED', authority_version = authority_version + 1,
          confirmed_request_id = NULL, authorizing_admin_user_id = NULL, authorizing_admin_version = NULL, updated_at = clock_timestamp()
         WHERE account_id = $1 AND state <> 'DISABLED' RETURNING chat_type, chat_id, authority_version`, [accountId],
      );
      await client.query(
        `UPDATE room_agent_grants SET state = 'REVOKED', revoked_at = clock_timestamp()
         WHERE account_id = $1 AND state = 'ACTIVE'`, [accountId],
      );
      for (const item of changedPolicies.rows) {
        await client.query(
          `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, event, authority_version)
           VALUES ($1,$2,$3,'ADMIN_CHANGED',$4)`,
          [accountId, item.chat_type, item.chat_id, item.authority_version],
        );
      }
      const updated = await client.query<{ version: string }>(
        'SELECT version FROM account_administrator_versions WHERE account_id = $1', [accountId],
      );
      await client.query('COMMIT');
      return Number(updated.rows[0]?.version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async requestActivation(input: RoomActivationScope & { sourceMessageId: string; requesterId: string }): Promise<RoomActivationRequestResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lock(client, 'room-activation:global-capacity');
      await lock(client, `room-activation:account-capacity:${input.accountId}`);
      const room = await client.query(
        `SELECT 1 FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR SHARE`,
        [input.accountId, input.chatType, input.chatId],
      );
      if (!room.rowCount) { await client.query('COMMIT'); return { disposition: 'room_missing' }; }
      await client.query(
        `INSERT INTO room_agent_policies(account_id, chat_type, chat_id) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, chat_type, chat_id) DO NOTHING`, [input.accountId, input.chatType, input.chatId],
      );
      const policy = await client.query<{ state: string; authority_version: string }>(
        `SELECT state, authority_version FROM room_agent_policies WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR UPDATE`,
        [input.accountId, input.chatType, input.chatId],
      );
      const priorSource = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND source_message_id = $4`,
        [input.accountId, input.chatType, input.chatId, input.sourceMessageId],
      );
      if (priorSource.rows[0]) {
        await client.query('COMMIT');
        const row = priorSource.rows[0];
        return { disposition: 'duplicate', requestId: row.request_id, waitExpiresAt: row.wait_expires_at, state: row.state };
      }
      if (policy.rows[0]?.state === 'ENABLED') { await client.query('COMMIT'); return { disposition: 'already_enabled' }; }
      const active = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
          AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN')`,
        [input.accountId, input.chatType, input.chatId],
      );
      if (active.rows[0]) {
        await client.query('COMMIT');
        const row = active.rows[0];
        return { disposition: 'coalesced', requestId: row.request_id, waitExpiresAt: row.wait_expires_at, state: row.state };
      }
      const admin = await client.query<{ chat_id: string; user_id: string; version: string }>(
        `SELECT a.chat_id, a.user_id, v.version FROM account_administrators a
         JOIN account_administrator_versions v USING (account_id)
         WHERE a.account_id = $1 AND a.role = 'PRIMARY_ADMIN' FOR SHARE OF a, v`, [input.accountId],
      );
      if (!admin.rows[0]) { await client.query('COMMIT'); return { disposition: 'admin_unbound' }; }
      const recentRoom = await client.query(
        `SELECT 1 FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
          AND created_at > clock_timestamp() - interval '1 minute' LIMIT 1`, [input.accountId, input.chatType, input.chatId],
      );
      const recentAdmin = await client.query(
        `SELECT 1 FROM room_activation_requests WHERE account_id = $1 AND admin_user_id = $2
          AND created_at > clock_timestamp() - interval '1 minute'`, [input.accountId, admin.rows[0].user_id],
      );
      if (recentRoom.rowCount || (recentAdmin.rowCount ?? 0) >= 3) { await client.query('COMMIT'); return { disposition: 'rate_limited' }; }
      const capacity = await client.query<{ account_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE account_id = $1)::text AS account_count, count(*)::text AS global_count
         FROM room_activation_requests WHERE state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN')`, [input.accountId],
      );
      if (Number(capacity.rows[0]?.account_count) >= 8 || Number(capacity.rows[0]?.global_count) >= 64) {
        await client.query('COMMIT'); return { disposition: 'capacity_reached' };
      }
      const requestId = randomUUID();
      const created = await client.query<{ wait_expires_at: Date }>(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
          admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'WAITING_TO_SEND',clock_timestamp() + interval '60 seconds')
         RETURNING wait_expires_at`,
        [requestId, input.accountId, input.chatType, input.chatId, input.sourceMessageId, input.requesterId,
          admin.rows[0].chat_id, admin.rows[0].user_id, admin.rows[0].version, policy.rows[0]?.authority_version],
      );
      await client.query(
        `UPDATE room_agent_policies SET state = 'PENDING_CONFIRMATION', updated_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3`, [input.accountId, input.chatType, input.chatId],
      );
      await client.query(
        `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
         VALUES ($1,$2,$3,$4,'REQUESTED',$5,$6)`,
        [input.accountId, input.chatType, input.chatId, requestId, input.requesterId, policy.rows[0]?.authority_version],
      );
      await client.query('COMMIT');
      return { disposition: 'created', requestId, waitExpiresAt: created.rows[0]!.wait_expires_at, state: 'WAITING_TO_SEND' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async claimWaitingToSend(requestId: string, owner: string, leaseMs: number): Promise<WaitingChallengeClaim | null> {
    const leaseToken = randomUUID();
    const result = await this.pool.query<{
      request_id: string; account_id: string; admin_chat_id: string; admin_user_id: string;
    }>(
      `UPDATE room_activation_requests SET lease_owner = $2, lease_token = $3,
        lease_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'), updated_at = clock_timestamp()
       WHERE request_id = $1 AND state = 'WAITING_TO_SEND' AND wait_expires_at > clock_timestamp()
         AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
       RETURNING request_id, account_id, admin_chat_id, admin_user_id`,
      [requestId, owner, leaseToken, Math.max(1, Math.min(60_000, Math.floor(leaseMs)))],
    );
    const row = result.rows[0];
    return row ? { requestId: row.request_id, accountId: row.account_id, adminChatId: row.admin_chat_id, adminUserId: row.admin_user_id, leaseToken } : null;
  }

  async prepareChallengeSend(input: {
    requestId: string; leaseToken: string; token: string; digestKey: Buffer; digestKeyVersion: number;
  }): Promise<boolean> {
    const tokenPayload = input.token.slice(3);
    if (!/^RA-[A-Za-z0-9_-]{43}$/.test(input.token) || Buffer.from(tokenPayload, 'base64url').length !== 32
      || Buffer.from(tokenPayload, 'base64url').toString('base64url') !== tokenPayload
      || input.digestKey.length !== 32 || !Number.isInteger(input.digestKeyVersion) || input.digestKeyVersion < 1) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE request_id = $1 FOR UPDATE`, [input.requestId],
      );
      const request = row.rows[0];
      if (!request || request.state !== 'WAITING_TO_SEND') { await client.query('COMMIT'); return false; }
      const valid = await client.query(
        `SELECT 1 FROM room_activation_requests r
         JOIN room_agent_policies p ON p.account_id = r.account_id AND p.chat_type = r.chat_type AND p.chat_id = r.chat_id
         JOIN account_administrator_versions v ON v.account_id = r.account_id
         JOIN account_administrators a ON a.account_id = r.account_id AND a.role = 'PRIMARY_ADMIN'
           AND a.chat_id = r.admin_chat_id AND a.user_id = r.admin_user_id
         WHERE r.request_id = $1 AND r.lease_token = $2 AND r.lease_expires_at > clock_timestamp()
           AND r.wait_expires_at > clock_timestamp() AND r.admin_version = v.version
           AND r.room_authority_version = p.authority_version AND p.state = 'PENDING_CONFIRMATION'`,
        [input.requestId, input.leaseToken],
      );
      if (!valid.rowCount) { await client.query('COMMIT'); return false; }
      const updated = await client.query(
        `UPDATE room_activation_requests SET state = 'PENDING_CONFIRMATION', request_version = request_version + 1,
          confirm_expires_at = clock_timestamp() + interval '60 seconds', lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE request_id = $1 AND state = 'WAITING_TO_SEND' AND lease_token = $2 AND wait_expires_at > clock_timestamp()
         RETURNING confirm_expires_at`, [input.requestId, input.leaseToken],
      );
      const expiresAt = updated.rows[0]?.confirm_expires_at as Date | undefined;
      if (!expiresAt) { await client.query('COMMIT'); return false; }
      await client.query(
        `INSERT INTO room_activation_challenges(request_id, token_digest, digest_key_version, send_state, expires_at)
         VALUES ($1,$2,$3,'MAY_HAVE_STARTED',$4)`,
        [input.requestId, keyedDigest(input.token, input.digestKey), input.digestKeyVersion, expiresAt],
      );
      await client.query(
        `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
         VALUES ($1,$2,$3,$4,'CHALLENGE_MAY_HAVE_STARTED',$5,$6)`,
        [request.account_id, request.chat_type, request.chat_id, input.requestId, null, request.room_authority_version],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async markChallengeDeliveryUnknown(requestId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query("SELECT state FROM room_activation_requests WHERE request_id = $1 FOR UPDATE", [requestId]);
      if (request.rows[0]?.state !== 'PENDING_CONFIRMATION') { await client.query('COMMIT'); return false; }
      const result = await client.query(
        `UPDATE room_activation_challenges SET send_state = 'UNKNOWN'
         WHERE request_id = $1 AND send_state = 'MAY_HAVE_STARTED' AND consumed_at IS NULL AND invalidated_at IS NULL
         RETURNING request_id`, [requestId],
      );
      if (!result.rowCount) { await client.query('COMMIT'); return false; }
      await client.query("UPDATE room_activation_requests SET state = 'DELIVERY_UNKNOWN', request_version = request_version + 1, updated_at = clock_timestamp() WHERE request_id = $1 AND state = 'PENDING_CONFIRMATION'", [requestId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async confirmActivation(input: RoomActivationScope & {
    sourceMessageId: string; senderUserId: string; token: string; digestKey: Buffer; digestKeyVersion: number;
  }): Promise<ConfirmationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
          AND state IN ('PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN', 'CONSUMED', 'EXPIRED', 'CANCELLED', 'EXHAUSTED')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.accountId, input.chatType, input.chatId],
      );
      const request = requestResult.rows[0];
      if (!request) { await client.query('COMMIT'); return { disposition: 'out_of_scope' }; }
      if (request.state === 'CONSUMED') { await client.query('COMMIT'); return { disposition: 'already_consumed' }; }
      if (request.state === 'EXPIRED') { await client.query('COMMIT'); return { disposition: 'expired' }; }
      if (request.state === 'CANCELLED') { await client.query('COMMIT'); return { disposition: 'cancelled' }; }
      if (request.state === 'EXHAUSTED') { await client.query('COMMIT'); return { disposition: 'exhausted' }; }
      if (input.senderUserId !== request.admin_user_id) { await client.query('COMMIT'); return { disposition: 'out_of_scope' }; }
      if (input.digestKey.length !== 32) { await client.query('COMMIT'); return { disposition: 'wrong_token' }; }
      const policy = await client.query<{ authority_version: string; state: string }>(
        `SELECT authority_version, state FROM room_agent_policies WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR UPDATE`,
        [input.accountId, input.chatType, input.chatId],
      );
      const admin = await client.query<{ version: string }>(
        `SELECT v.version FROM account_administrator_versions v JOIN account_administrators a USING (account_id)
         WHERE v.account_id = $1 AND a.role = 'PRIMARY_ADMIN' AND a.chat_id = $2 AND a.user_id = $3 FOR SHARE OF v, a`,
        [input.accountId, request.admin_chat_id, input.senderUserId],
      );
      if (!admin.rowCount || input.senderUserId !== request.admin_user_id
        || Number(admin.rows[0]?.version) !== Number(request.admin_version)
        || Number(policy.rows[0]?.authority_version) !== Number(request.room_authority_version)
        || policy.rows[0]?.state !== 'PENDING_CONFIRMATION') {
        await this.cancelLockedRequest(client, request, 'ADMIN_CHANGED');
        await client.query('COMMIT');
        return { disposition: 'cancelled' };
      }
      const challenge = await client.query<{ token_digest: Buffer; digest_key_version: number; attempts: number; is_expired: boolean }>(
        `SELECT token_digest, digest_key_version, attempts, expires_at <= clock_timestamp() AS is_expired
         FROM room_activation_challenges WHERE request_id = $1 FOR UPDATE`, [request.request_id],
      );
      const stored = challenge.rows[0];
      if (!stored) { await client.query('COMMIT'); return { disposition: 'cancelled' }; }
      if (stored.is_expired) {
        await this.expireLockedRequest(client, request);
        await client.query('COMMIT');
        return { disposition: 'expired' };
      }
      if (stored.digest_key_version !== input.digestKeyVersion) { await client.query('COMMIT'); return { disposition: 'wrong_token' }; }
      const digestMatches = keyedDigest(input.token, input.digestKey).equals(stored.token_digest);
      const repeated = await client.query(
        'SELECT 1 FROM room_activation_confirmation_attempts WHERE request_id = $1 AND source_message_id = $2',
        [request.request_id, input.sourceMessageId],
      );
      if (repeated.rowCount) { await client.query('COMMIT'); return { disposition: 'duplicate_attempt' }; }
      if (!digestMatches) {
        const attempts = Number(stored.attempts) + 1;
        const exhausted = attempts >= 5;
        await client.query(
          'INSERT INTO room_activation_confirmation_attempts(request_id, source_message_id, disposition) VALUES ($1,$2,$3)',
          [request.request_id, input.sourceMessageId, exhausted ? 'EXHAUSTED' : 'WRONG_TOKEN'],
        );
        await client.query(
          `UPDATE room_activation_challenges SET attempts = $2, invalidated_at = CASE WHEN $2 >= 5 THEN clock_timestamp() ELSE invalidated_at END
           WHERE request_id = $1`, [request.request_id, attempts],
        );
        if (exhausted) {
          await client.query("UPDATE room_activation_requests SET state = 'EXHAUSTED', request_version = request_version + 1, updated_at = clock_timestamp() WHERE request_id = $1", [request.request_id]);
          await client.query("UPDATE room_agent_policies SET state = 'DISABLED', authority_version = authority_version + 1, updated_at = clock_timestamp() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3", [input.accountId, input.chatType, input.chatId]);
          await client.query(
            `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
             VALUES ($1,$2,$3,$4,'EXHAUSTED',$5,$6)`,
            [input.accountId, input.chatType, input.chatId, request.request_id, input.senderUserId, request.room_authority_version],
          );
        }
        await client.query('COMMIT');
        return { disposition: exhausted ? 'exhausted' : 'wrong_token' };
      }
      const consumed = await client.query(
        `UPDATE room_activation_requests SET state = 'CONSUMED', request_version = request_version + 1, updated_at = clock_timestamp()
         WHERE request_id = $1 AND state IN ('PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN') AND confirm_expires_at > clock_timestamp()
         RETURNING request_id`, [request.request_id],
      );
      if (!consumed.rowCount) {
        await this.expireLockedRequest(client, request);
        await client.query('COMMIT');
        return { disposition: 'expired' };
      }
      await client.query(
        `INSERT INTO room_activation_confirmation_attempts(request_id, source_message_id, disposition) VALUES ($1,$2,'ENABLED')`,
        [request.request_id, input.sourceMessageId],
      );
      await client.query('UPDATE room_activation_challenges SET consumed_at = clock_timestamp() WHERE request_id = $1', [request.request_id]);
      const policyUpdate = await client.query<{ authority_version: string }>(
        `UPDATE room_agent_policies SET state = 'ENABLED', authority_version = authority_version + 1,
          confirmed_request_id = $4, authorizing_admin_user_id = $5, authorizing_admin_version = $6, updated_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND authority_version = $7 AND state = 'PENDING_CONFIRMATION'
         RETURNING authority_version`,
        [input.accountId, input.chatType, input.chatId, request.request_id, input.senderUserId, request.admin_version, request.room_authority_version],
      );
      if (!policyUpdate.rowCount) throw new Error('Room authority changed while consuming activation challenge');
      const grantVersion = Number(policyUpdate.rows[0]!.authority_version);
      await client.query(
        `INSERT INTO room_agent_grants(grant_id, account_id, chat_type, chat_id, capability, version, state, request_id)
         VALUES ($1,$2,$3,$4,'AGENT_USE_ROOM',$5,'ACTIVE',$6)`,
        [randomUUID(), input.accountId, input.chatType, input.chatId, grantVersion, request.request_id],
      );
      await client.query(
        `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
         VALUES ($1,$2,$3,$4,'CONFIRMED',$5,$6)`,
        [input.accountId, input.chatType, input.chatId, request.request_id, input.senderUserId, grantVersion],
      );
      await client.query('COMMIT');
      return { disposition: 'enabled' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /**
   * Enables a room on the word of the account's PRIMARY_ADMIN: a message whose sender is that administrator is already
   * the consent a token round-trip would collect. One transaction creates the ENABLED policy and the ACTIVE grant
   * (bound to a CONSUMED request row that also makes the source message idempotent) and cancels any pending request.
   */
  async enableByPrimaryAdmin(scope: RoomActivationScope, input: { sourceMessageId: string; adminUserId: string }): Promise<PrimaryAdminEnableResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lock(client, `room-activation:account-capacity:${scope.accountId}`);
      const room = await client.query(
        'SELECT 1 FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR SHARE',
        [scope.accountId, scope.chatType, scope.chatId],
      );
      if (!room.rowCount) { await client.query('COMMIT'); return { disposition: 'room_missing' }; }
      const admin = await client.query<{ chat_id: string; version: string }>(
        `SELECT a.chat_id, v.version FROM account_administrators a
         JOIN account_administrator_versions v USING (account_id)
         WHERE a.account_id = $1 AND a.role = 'PRIMARY_ADMIN' AND a.user_id = $2 FOR SHARE OF a, v`,
        [scope.accountId, input.adminUserId],
      );
      if (!admin.rows[0]) { await client.query('COMMIT'); return { disposition: 'not_primary_admin' }; }
      const prior = await client.query(
        `SELECT 1 FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND source_message_id = $4`,
        [scope.accountId, scope.chatType, scope.chatId, input.sourceMessageId],
      );
      if (prior.rowCount) { await client.query('COMMIT'); return { disposition: 'duplicate' }; }
      const pending = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
          AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN') ORDER BY request_id FOR UPDATE`,
        [scope.accountId, scope.chatType, scope.chatId],
      );
      await client.query(
        `INSERT INTO room_agent_policies(account_id, chat_type, chat_id) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, chat_type, chat_id) DO NOTHING`, [scope.accountId, scope.chatType, scope.chatId],
      );
      const policy = await client.query<{ state: string; authority_version: string }>(
        'SELECT state, authority_version FROM room_agent_policies WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR UPDATE',
        [scope.accountId, scope.chatType, scope.chatId],
      );
      if (policy.rows[0]?.state === 'ENABLED') { await client.query('COMMIT'); return { disposition: 'already_enabled' }; }
      for (const request of pending.rows) {
        await client.query(
          `UPDATE room_activation_requests SET state = 'CANCELLED', request_version = request_version + 1, updated_at = clock_timestamp()
           WHERE request_id = $1`, [request.request_id],
        );
        await client.query('UPDATE room_activation_challenges SET invalidated_at = clock_timestamp() WHERE request_id = $1 AND consumed_at IS NULL', [request.request_id]);
        await client.query(
          `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
           VALUES ($1,$2,$3,$4,'CANCELLED',$5,$6)`,
          [scope.accountId, scope.chatType, scope.chatId, request.request_id, input.adminUserId, policy.rows[0]!.authority_version],
        );
      }
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
          admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONSUMED',clock_timestamp())`,
        [requestId, scope.accountId, scope.chatType, scope.chatId, input.sourceMessageId, input.adminUserId,
          admin.rows[0].chat_id, input.adminUserId, admin.rows[0].version, policy.rows[0]!.authority_version],
      );
      const updated = await client.query<{ authority_version: string }>(
        `UPDATE room_agent_policies SET state = 'ENABLED', authority_version = authority_version + 1,
          confirmed_request_id = $4, authorizing_admin_user_id = $5, authorizing_admin_version = $6, updated_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND authority_version = $7
         RETURNING authority_version`,
        [scope.accountId, scope.chatType, scope.chatId, requestId, input.adminUserId, admin.rows[0].version, policy.rows[0]!.authority_version],
      );
      if (!updated.rowCount) throw new Error('Room authority changed while enabling the room');
      const grantVersion = Number(updated.rows[0]!.authority_version);
      await client.query(
        `INSERT INTO room_agent_grants(grant_id, account_id, chat_type, chat_id, capability, version, state, request_id)
         VALUES ($1,$2,$3,$4,'AGENT_USE_ROOM',$5,'ACTIVE',$6)`,
        [randomUUID(), scope.accountId, scope.chatType, scope.chatId, grantVersion, requestId],
      );
      await client.query(
        `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
         VALUES ($1,$2,$3,$4,'ADMIN_DIRECT_ENABLED',$5,$6)`,
        [scope.accountId, scope.chatType, scope.chatId, requestId, input.adminUserId, grantVersion],
      );
      await client.query('COMMIT');
      return { disposition: 'enabled' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async revokeRoom(scope: RoomActivationScope, actorId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT request_id FROM room_activation_requests WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
          AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN') ORDER BY request_id FOR UPDATE`,
        [scope.accountId, scope.chatType, scope.chatId],
      );
      const policy = await client.query<{ authority_version: string }>(
        'SELECT authority_version FROM room_agent_policies WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR UPDATE',
        [scope.accountId, scope.chatType, scope.chatId],
      );
      if (!policy.rowCount) { await client.query('COMMIT'); return false; }
      await client.query(
        `UPDATE room_activation_requests SET state = 'CANCELLED', request_version = request_version + 1, updated_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN')`,
        [scope.accountId, scope.chatType, scope.chatId],
      );
      await client.query(
        `UPDATE room_activation_challenges c SET invalidated_at = clock_timestamp()
         FROM room_activation_requests r WHERE r.request_id = c.request_id AND r.account_id = $1 AND r.chat_type = $2 AND r.chat_id = $3
          AND c.consumed_at IS NULL AND c.invalidated_at IS NULL`, [scope.accountId, scope.chatType, scope.chatId],
      );
      const updated = await client.query<{ authority_version: string }>(
        `UPDATE room_agent_policies SET state = 'DISABLED', authority_version = authority_version + 1,
          confirmed_request_id = NULL, authorizing_admin_user_id = NULL, authorizing_admin_version = NULL, updated_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 RETURNING authority_version`,
        [scope.accountId, scope.chatType, scope.chatId],
      );
      await client.query(
        `UPDATE room_agent_grants SET state = 'REVOKED', revoked_at = clock_timestamp()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND state = 'ACTIVE'`, [scope.accountId, scope.chatType, scope.chatId],
      );
      await client.query(
        `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, event, actor_id, authority_version)
         VALUES ($1,$2,$3,'REVOKED',$4,$5)`, [scope.accountId, scope.chatType, scope.chatId, actorId, updated.rows[0]!.authority_version],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE room_activation_requests SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
       WHERE state = 'WAITING_TO_SEND' AND wait_expires_at > clock_timestamp() AND lease_expires_at <= clock_timestamp()
       RETURNING request_id`,
    );
    return result.rowCount ?? 0;
  }

  async expireRequest(requestId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ActivationRequestRow>(
        `SELECT request_id, account_id, chat_type, chat_id, admin_chat_id, admin_user_id, admin_version,
          room_authority_version, state, wait_expires_at, confirm_expires_at, request_version
         FROM room_activation_requests WHERE request_id = $1 FOR UPDATE`, [requestId],
      );
      const request = result.rows[0];
      if (!request || !['WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN'].includes(request.state)) {
        await client.query('COMMIT'); return false;
      }
      const due = await client.query(
        `SELECT 1 WHERE CASE WHEN $1 IN ('PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN')
          THEN $2::timestamptz <= clock_timestamp() ELSE $3::timestamptz <= clock_timestamp() END`,
        [request.state, request.confirm_expires_at, request.wait_expires_at],
      );
      if (!due.rowCount) { await client.query('COMMIT'); return false; }
      await client.query(
        `SELECT 1 FROM room_agent_policies WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 FOR UPDATE`,
        [request.account_id, request.chat_type, request.chat_id],
      );
      await this.expireLockedRequest(client, request);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async getPolicy(scope: RoomActivationScope): Promise<RoomAgentPolicy> {
    const result = await this.pool.query<{
      account_id: string; chat_type: RoomActivationScope['chatType']; chat_id: string; state: RoomAgentPolicy['state']; authority_version: string;
    }>(
      `SELECT account_id, chat_type, chat_id, state, authority_version FROM room_agent_policies
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3`, [scope.accountId, scope.chatType, scope.chatId],
    );
    const row = result.rows[0];
    return row ? { accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, state: row.state, authorityVersion: Number(row.authority_version) }
      : { ...scope, state: 'DISABLED', authorityVersion: 1 };
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

  async hasActiveRoomGrant(scope: RoomActivationScope): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM room_agent_policies p
       JOIN room_agent_grants g ON g.account_id = p.account_id AND g.chat_type = p.chat_type AND g.chat_id = p.chat_id
         AND g.capability = 'AGENT_USE_ROOM' AND g.state = 'ACTIVE' AND g.version = p.authority_version
       WHERE p.account_id = $1 AND p.chat_type = $2 AND p.chat_id = $3 AND p.state = 'ENABLED'
       LIMIT 1`, [scope.accountId, scope.chatType, scope.chatId],
    );
    return result.rowCount === 1;
  }

  async getActiveRoomAuthorization(scope: RoomActivationScope): Promise<ActiveRoomAgentAuthorization | null> {
    const result = await this.pool.query<{ grant_id: string; version: string }>(
      `SELECT g.grant_id, g.version FROM room_agent_policies p
       JOIN room_agent_grants g ON g.account_id = p.account_id AND g.chat_type = p.chat_type AND g.chat_id = p.chat_id
         AND g.capability = 'AGENT_USE_ROOM' AND g.state = 'ACTIVE' AND g.version = p.authority_version
       WHERE p.account_id = $1 AND p.chat_type = $2 AND p.chat_id = $3 AND p.state = 'ENABLED'
       LIMIT 1`, [scope.accountId, scope.chatType, scope.chatId],
    );
    const row = result.rows[0];
    return row ? { grantId: row.grant_id, version: Number(row.version) } : null;
  }

  private async cancelLockedRequest(client: PoolClient, request: ActivationRequestRow, event: 'ADMIN_CHANGED' | 'CANCELLED'): Promise<void> {
    await client.query(
      `UPDATE room_activation_requests SET state = 'CANCELLED', request_version = request_version + 1, updated_at = clock_timestamp()
       WHERE request_id = $1`, [request.request_id],
    );
    await client.query('UPDATE room_activation_challenges SET invalidated_at = clock_timestamp() WHERE request_id = $1 AND consumed_at IS NULL', [request.request_id]);
    await client.query(
      `UPDATE room_agent_policies SET state = 'DISABLED', authority_version = authority_version + 1, updated_at = clock_timestamp()
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND authority_version = $4`,
      [request.account_id, request.chat_type, request.chat_id, request.room_authority_version],
    );
    await client.query(
      `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [request.account_id, request.chat_type, request.chat_id, request.request_id, event, null, request.room_authority_version],
    );
  }

  private async expireLockedRequest(client: PoolClient, request: ActivationRequestRow): Promise<void> {
    await client.query("UPDATE room_activation_requests SET state = 'EXPIRED', request_version = request_version + 1, updated_at = clock_timestamp() WHERE request_id = $1", [request.request_id]);
    await client.query('UPDATE room_activation_challenges SET invalidated_at = clock_timestamp() WHERE request_id = $1 AND consumed_at IS NULL', [request.request_id]);
    await client.query(
      `UPDATE room_agent_policies SET state = 'DISABLED', authority_version = authority_version + 1, updated_at = clock_timestamp()
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND authority_version = $4`,
      [request.account_id, request.chat_type, request.chat_id, request.room_authority_version],
    );
    await client.query(
      `INSERT INTO room_activation_audit(account_id, chat_type, chat_id, request_id, event, actor_id, authority_version)
       VALUES ($1,$2,$3,$4,'EXPIRED',$5,$6)`,
      [request.account_id, request.chat_type, request.chat_id, request.request_id, null, request.room_authority_version],
    );
  }
}
