import { randomUUID } from 'node:crypto';
import type { AgentProvider, WritableConversationKey } from '@line-agent/contracts';
import type { Pool } from 'pg';
import { ensureLineageSessionRow } from './agent-lineage.js';
import { lockAndCheckRoomAgentGrant } from './agent-authorization.js';
import { FREE_MODE_MEMBER_ID } from './agent-permissions.js';

export type FreeModeChatType = 'group' | 'room';
export interface FreeModeKey extends WritableConversationKey { chatType: FreeModeChatType }

export interface FreeModeRow extends FreeModeKey {
  enabledBy: string;
  expiresAt: Date;
}

export interface FreeModeJobInput {
  key: FreeModeKey;
  /** The last message of the batch; the job row needs a real message and the unique index keeps one job per message. */
  sourceMessageId: string;
  provider: AgentProvider;
  prompt: string;
  workspacePath: string;
  roomGrant: { grantId: string; version: number };
}

interface FreeModeDbRow { account_id: string; chat_type: FreeModeChatType; chat_id: string; enabled_by: string; expires_at: Date }

const toRow = (row: FreeModeDbRow): FreeModeRow => ({ accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
  enabledBy: row.enabled_by, expiresAt: row.expires_at });

/** Durable group free-mode state and the free-mode job insert (docs/architecture/group-free-mode.md). */
export class RoomFreeModeRepository {
  constructor(private readonly pool: Pool) {}

  /** Turns free mode on (or resets the window) until `expiresAt`. */
  async activate(key: FreeModeKey, enabledBy: string, expiresAt: Date): Promise<FreeModeRow> {
    const result = await this.pool.query<FreeModeDbRow>(
      `INSERT INTO room_free_mode(account_id, chat_type, chat_id, enabled_by, expires_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, chat_type, chat_id)
       DO UPDATE SET enabled_by = EXCLUDED.enabled_by, expires_at = EXCLUDED.expires_at, updated_at = now()
       RETURNING account_id, chat_type, chat_id, enabled_by, expires_at`,
      [key.accountId, key.chatType, key.chatId, enabledBy, expiresAt]);
    return toRow(result.rows[0]!);
  }

  /** Returns true when a row existed. */
  async deactivate(key: FreeModeKey): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM room_free_mode WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3', [key.accountId, key.chatType, key.chatId]);
    return (result.rowCount ?? 0) > 0;
  }

  async get(key: FreeModeKey): Promise<FreeModeRow | null> {
    const result = await this.pool.query<FreeModeDbRow>(
      `SELECT account_id, chat_type, chat_id, enabled_by, expires_at FROM room_free_mode
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3`, [key.accountId, key.chatType, key.chatId]);
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async list(): Promise<FreeModeRow[]> {
    const result = await this.pool.query<FreeModeDbRow>(
      'SELECT account_id, chat_type, chat_id, enabled_by, expires_at FROM room_free_mode ORDER BY expires_at');
    return result.rows.map(toRow);
  }

  /**
   * Deletes the row only if it still ends at `expiresAt` (a reset in between keeps it). Returns true when the row was removed.
   */
  async expire(key: FreeModeKey, expiresAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM room_free_mode WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND expires_at = $4`,
      [key.accountId, key.chatType, key.chatId, expiresAt]);
    return (result.rowCount ?? 0) > 0;
  }

  /** True while the job is queued or running. */
  async isJobActive(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM agent_jobs WHERE job_id = $1 AND status IN ('queued', 'running')", [jobId]);
    return (result.rowCount ?? 0) > 0;
  }

  async isFreeModeJob(jobId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM agent_jobs WHERE job_id = $1 AND free_mode', [jobId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Inserts one queued free-mode LINE job. The stored room grant is rechecked in the same transaction; a stale grant, a
   * non-active account or an already used source message insert nothing (returns null). The job carries no friend grant and a
   * stand-in sender, so it can never resolve to the administrator principal.
   */
  async enqueueJob(input: FreeModeJobInput): Promise<{ jobId: string } | null> {
    const { key } = input;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>(
        `SELECT c.control_epoch FROM account_control c JOIN line_accounts a ON a.account_id = $1 AND a.mode = 'ACTIVE_CONTROL'
         WHERE c.singleton = true FOR SHARE OF c, a`, [key.accountId]);
      if (!control.rows[0]) { await client.query('COMMIT'); return null; }
      if (!await lockAndCheckRoomAgentGrant(client, key.accountId, key.chatType, key.chatId, input.roomGrant)) {
        await client.query('COMMIT');
        return null;
      }
      await ensureLineageSessionRow(client, { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId, provider: input.provider });
      const session = await client.query<{ generation: number }>(
        `SELECT generation FROM agent_sessions WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4
          AND source_type = 'line' FOR UPDATE`, [key.accountId, key.chatType, key.chatId, input.provider]);
      const jobId = randomUUID();
      const inserted = await client.query<{ job_id: string }>(
        `INSERT INTO agent_jobs(job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_sender_id, prompt,
           workspace_path, generation, creation_epoch, status, room_agent_grant_id, room_agent_grant_version, free_mode)
         VALUES($1,$2,$3,$4,$5,'line',$6,$7,$8,$9,$10,$11,'queued',$12,$13,true)
         ON CONFLICT(account_id, source_message_id) WHERE source_type = 'line' AND retry_of_job_id IS NULL DO NOTHING RETURNING job_id`,
        [jobId, key.accountId, key.chatType, key.chatId, input.provider, input.sourceMessageId, FREE_MODE_MEMBER_ID, input.prompt,
          input.workspacePath, session.rows[0]?.generation ?? 0, control.rows[0].control_epoch,
          input.roomGrant.grantId, input.roomGrant.version]);
      await client.query('COMMIT');
      return inserted.rows[0] ? { jobId } : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Display names of chat members for the batch header: contact nickname/name, then the member row name. */
  async memberNames(key: FreeModeKey, mids: readonly string[]): Promise<Map<string, string>> {
    if (mids.length === 0) return new Map();
    const result = await this.pool.query<{ mid: string; name: string | null }>(
      `SELECT r.mid, COALESCE(NULLIF(lc.nickname, ''), NULLIF(lc.display_name, ''), NULLIF(cm.display_name, '')) AS name
       FROM unnest($4::text[]) AS r(mid)
       LEFT JOIN conversation_members cm ON cm.account_id = $1 AND cm.chat_type = $2 AND cm.chat_id = $3 AND cm.member_id = r.mid
       LEFT JOIN line_contacts lc ON lc.account_id = $1 AND lc.mid = r.mid`,
      [key.accountId, key.chatType, key.chatId, [...mids]]);
    return new Map(result.rows.flatMap((row) => row.name ? [[row.mid, row.name] as const] : []));
  }
}
