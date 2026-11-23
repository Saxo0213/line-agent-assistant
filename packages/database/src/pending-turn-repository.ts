import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { redactSensitiveDetail } from './provider-failover.js';

/**
 * SQL port of CliTalkAgent `PendingFailoverStore` (src/pending_failover.rs). One row per origin job.
 * The file persistence of CTA is replaced by the table agent_pending_turns (migration 102).
 */

export type PendingTurnStatus = 'pending' | 'replaying' | 'needs_confirmation' | 'completed' | 'exhausted' | 'superseded';

/** CTA MAX_PENDING_TEXT_CHARS (pending_failover.rs:6). */
export const MAX_PENDING_TEXT_CHARS = 100_000;
/** CTA hard attempt cap (pending_failover.rs:284 and 322). */
export const MAX_PENDING_ATTEMPTS = 8;
const MAX_ERROR_CHARS = 500;
/** CTA load path message (pending_failover.rs:128). */
export const RESTART_CONFIRMATION_ERROR = '後端於執行途中重啟，請確認後重新送出訊息。';

export interface PendingTurn {
  pendingId: string;
  originJobId: string;
  activeJobId: string | null;
  lineageKey: string;
  userText: string;
  originProvider: string;
  originSourceId: string | null;
  lastProvider: string;
  lastSourceId: string | null;
  status: PendingTurnStatus;
  hadToolActivity: boolean;
  hadEffectiveOutput: boolean;
  attemptedSourceIds: string[];
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingFailureInput {
  /**
   * The id of the failing job. It creates a new row when no row has this job as its origin or its active job.
   * Otherwise the failure belongs to the existing row (a second failure of the same lineage turn).
   */
  originJobId: string;
  lineageKey: string;
  userText: string;
  provider: string;
  sourceId: string | null;
  hadToolActivity: boolean;
  hadEffectiveOutput: boolean;
  error: string;
}

/**
 * The route key text of a session or queue key: JSON `["ui"]` or `["line",accountId,chatType,chatId]`.
 * The Agent room key gives `["ui"]`. The scheduled-run queue key has no route and is refused.
 */
export function routeKeyFor(key: { accountId: string | null; chatType?: string | null; chatId?: string | null }): string {
  if (key.accountId === null) {
    if (key.chatType === 'schedule') throw new Error('A scheduled-run queue key has no route key');
    return JSON.stringify(['ui']);
  }
  return JSON.stringify(['line', key.accountId, key.chatType ?? null, key.chatId ?? null]);
}

/** CTA normalized (pending_failover.rs:103): split on whitespace and join with one space. */
function normalized(text: string): string {
  return text.split(/\s+/u).filter((part) => part.length > 0).join(' ');
}

const characterCount = (text: string): number => [...text].length;
const limitError = (text: string): string => [...text].slice(0, MAX_ERROR_CHARS).join('');

interface PendingRow {
  pending_id: string; origin_job_id: string; active_job_id: string | null; lineage_key: string; user_text: string;
  origin_provider: string; origin_source_id: string | null; last_provider: string; last_source_id: string | null;
  status: PendingTurnStatus; had_tool_activity: boolean; had_effective_output: boolean; attempted_source_ids: string[];
  attempt_count: number; last_error: string | null; created_at: Date; updated_at: Date;
}

const pendingColumns = `pending_id, origin_job_id, active_job_id, lineage_key, user_text, origin_provider, origin_source_id,
  last_provider, last_source_id, status, had_tool_activity, had_effective_output, attempted_source_ids, attempt_count,
  last_error, created_at, updated_at`;

function toPendingTurn(row: PendingRow): PendingTurn {
  return { pendingId: row.pending_id, originJobId: row.origin_job_id, activeJobId: row.active_job_id, lineageKey: row.lineage_key,
    userText: row.user_text, originProvider: row.origin_provider, originSourceId: row.origin_source_id, lastProvider: row.last_provider,
    lastSourceId: row.last_source_id, status: row.status, hadToolActivity: row.had_tool_activity, hadEffectiveOutput: row.had_effective_output,
    attemptedSourceIds: row.attempted_source_ids, attemptCount: row.attempt_count, lastError: row.last_error,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export class PendingTurnRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** CTA snapshot (pending_failover.rs:170). All rows, oldest first. */
  async snapshot(): Promise<PendingTurn[]> {
    return (await this.pool.query<PendingRow>(`SELECT ${pendingColumns} FROM agent_pending_turns ORDER BY created_at, pending_id`)).rows.map(toPendingTurn);
  }

  async get(pendingId: string): Promise<PendingTurn | null> {
    const row = (await this.pool.query<PendingRow>(`SELECT ${pendingColumns} FROM agent_pending_turns WHERE pending_id = $1`, [pendingId])).rows[0];
    return row ? toPendingTurn(row) : null;
  }

  /** The row that has this job as its origin or its active job. */
  async findByJob(jobId: string): Promise<PendingTurn | null> {
    const row = (await this.pool.query<PendingRow>(
      `SELECT ${pendingColumns} FROM agent_pending_turns WHERE origin_job_id = $1 OR active_job_id = $1
       ORDER BY (origin_job_id = $1) DESC, created_at LIMIT 1`, [jobId])).rows[0];
    return row ? toPendingTurn(row) : null;
  }

  /**
   * CTA record_failure (pending_failover.rs:178-244). Blank text, or text over 100000 characters, gives null.
   * A new failure makes a row; a second failure of the same turn updates it. The status is 'needs_confirmation' when the
   * turn had tool activity or effective output, otherwise 'pending'. A lineage mismatch on an existing row throws
   * (CTA returns the error "pending turn lineage mismatch").
   */
  async recordFailure(input: PendingFailureInput): Promise<PendingTurn | null> {
    if (input.userText.trim().length === 0 || characterCount(input.userText) > MAX_PENDING_TEXT_CHARS) return null;
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`pending-turn:${input.originJobId}`]);
      const existing = (await client.query<PendingRow>(
        `SELECT ${pendingColumns} FROM agent_pending_turns WHERE origin_job_id = $1 OR active_job_id = $1
         ORDER BY (origin_job_id = $1) DESC, created_at LIMIT 1 FOR UPDATE`, [input.originJobId])).rows[0];
      if (existing && existing.lineage_key !== input.lineageKey) throw new Error('pending turn lineage mismatch');
      const attempted = existing ? [...existing.attempted_source_ids] : [];
      if (input.sourceId !== null && !attempted.includes(input.sourceId)) attempted.push(input.sourceId);
      const toolActivity = (existing?.had_tool_activity ?? false) || input.hadToolActivity;
      const effectiveOutput = (existing?.had_effective_output ?? false) || input.hadEffectiveOutput;
      const status: PendingTurnStatus = toolActivity || effectiveOutput ? 'needs_confirmation' : 'pending';
      const error = limitError(redactSensitiveDetail(input.error));
      if (existing) {
        const updated = await client.query<PendingRow>(
          `UPDATE agent_pending_turns SET last_provider = $2, last_source_id = $3, had_tool_activity = $4, had_effective_output = $5,
             attempted_source_ids = $6::text[], status = $7, last_error = $8, updated_at = now()
           WHERE pending_id = $1 RETURNING ${pendingColumns}`,
          [existing.pending_id, input.provider, input.sourceId, toolActivity, effectiveOutput, attempted, status, error]);
        return toPendingTurn(updated.rows[0]!);
      }
      const inserted = await client.query<PendingRow>(
        `INSERT INTO agent_pending_turns (pending_id, origin_job_id, active_job_id, lineage_key, user_text, origin_provider, origin_source_id,
           last_provider, last_source_id, status, had_tool_activity, had_effective_output, attempted_source_ids, attempt_count, last_error)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $5, $6, $7, $8, $9, $10::text[], 0, $11) RETURNING ${pendingColumns}`,
        [randomUUID(), input.originJobId, input.lineageKey, input.userText, input.provider, input.sourceId, status, toolActivity,
          effectiveOutput, attempted, error]);
      return toPendingTurn(inserted.rows[0]!);
    });
  }

  /** CTA bind_session (pending_failover.rs:246). Sets the active job. Returns false when the row is missing. */
  async bindActiveJob(pendingId: string, jobId: string): Promise<boolean> {
    const result = await this.pool.query('UPDATE agent_pending_turns SET active_job_id = $2, updated_at = now() WHERE pending_id = $1', [pendingId, jobId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * CTA claim_safe (pending_failover.rs:267-297). One conditional UPDATE from 'pending' or 'exhausted' to 'replaying'.
   * It needs no tool activity, no effective output, fewer than 8 attempts, and a target source that is not in the
   * attempted list. Only one concurrent caller wins. At the attempt cap a 'pending' row becomes 'exhausted' and the
   * result is null.
   */
  async claimSafe(pendingId: string, targetSourceId: string): Promise<PendingTurn | null> {
    const claimed = await this.pool.query<PendingRow>(
      `UPDATE agent_pending_turns SET status = 'replaying', attempt_count = attempt_count + 1, updated_at = now()
       WHERE pending_id = $1 AND status IN ('pending', 'exhausted') AND NOT had_tool_activity AND NOT had_effective_output
         AND attempt_count < ${MAX_PENDING_ATTEMPTS} AND NOT ($2::text = ANY(attempted_source_ids))
       RETURNING ${pendingColumns}`, [pendingId, targetSourceId]);
    if (claimed.rows[0]) return toPendingTurn(claimed.rows[0]);
    await this.pool.query(
      `UPDATE agent_pending_turns SET status = 'exhausted', updated_at = now()
       WHERE pending_id = $1 AND status = 'pending' AND NOT had_tool_activity AND NOT had_effective_output
         AND attempt_count >= ${MAX_PENDING_ATTEMPTS}`, [pendingId]);
    return null;
  }

  /** CTA mark_completed (pending_failover.rs:299). */
  async markCompleted(pendingId: string): Promise<boolean> {
    const result = await this.pool.query("UPDATE agent_pending_turns SET status = 'completed', updated_at = now() WHERE pending_id = $1", [pendingId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** CTA mark_exhausted (pending_failover.rs:302-308). A turn with tool activity or effective output keeps its status. */
  async markExhausted(pendingId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_pending_turns SET status = 'exhausted', updated_at = now()
       WHERE pending_id = $1 AND NOT had_tool_activity AND NOT had_effective_output`, [pendingId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** CTA require_confirmation (pending_failover.rs:309-314). */
  async requireConfirmation(pendingId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE agent_pending_turns SET status = 'needs_confirmation', last_error = $2, updated_at = now() WHERE pending_id = $1",
      [pendingId, limitError(reason)]);
    return (result.rowCount ?? 0) > 0;
  }

  /** CTA recoverable_snapshot (pending_failover.rs:315-325). Safe 'exhausted' rows under the attempt cap, oldest first. */
  async recoverableSnapshot(limit: number): Promise<PendingTurn[]> {
    const result = await this.pool.query<PendingRow>(
      `SELECT ${pendingColumns} FROM agent_pending_turns
       WHERE status = 'exhausted' AND NOT had_tool_activity AND NOT had_effective_output AND attempt_count < ${MAX_PENDING_ATTEMPTS}
       ORDER BY created_at, pending_id LIMIT $1`, [Math.max(0, Math.floor(limit))]);
    return result.rows.map(toPendingTurn);
  }

  /**
   * CTA supersede_matching (pending_failover.rs:327-348). Rows of the lineage with the same normalized text and the status
   * 'needs_confirmation', 'exhausted' or 'pending' become 'superseded'. Returns true when a row changed.
   */
  async supersedeMatching(lineageKey: string, text: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const candidates = await client.query<{ pending_id: string; user_text: string }>(
        `SELECT pending_id, user_text FROM agent_pending_turns
         WHERE lineage_key = $1 AND status IN ('needs_confirmation', 'exhausted', 'pending') FOR UPDATE`, [lineageKey]);
      const wanted = normalized(text);
      const ids = candidates.rows.filter((row) => normalized(row.user_text) === wanted).map((row) => row.pending_id);
      if (ids.length === 0) return false;
      await client.query("UPDATE agent_pending_turns SET status = 'superseded', updated_at = now() WHERE pending_id = ANY($1::uuid[])", [ids]);
      return true;
    });
  }

  /**
   * CTA note_source_recovery (pending_failover.rs:350-364). A fresh usage recovery removes the source from the attempted list
   * of the open safe rows. Returns the number of rows that changed.
   */
  async noteSourceRecovery(sourceId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_pending_turns SET attempted_source_ids = array_remove(attempted_source_ids, $1::text)
       WHERE status IN ('exhausted', 'pending') AND NOT had_tool_activity AND NOT had_effective_output
         AND $1::text = ANY(attempted_source_ids)`, [sourceId]);
    return result.rowCount ?? 0;
  }

  /**
   * CTA load path (pending_failover.rs:125-134). After a restart a 'replaying' row needs confirmation, and a 'pending' row
   * is 'exhausted'. Returns the number of rows of each change.
   */
  async recoverAfterRestart(): Promise<{ needsConfirmation: number; exhausted: number }> {
    return this.transaction(async (client) => {
      const replaying = await client.query(
        "UPDATE agent_pending_turns SET status = 'needs_confirmation', last_error = $1, updated_at = now() WHERE status = 'replaying'",
        [RESTART_CONFIRMATION_ERROR]);
      const pending = await client.query("UPDATE agent_pending_turns SET status = 'exhausted', updated_at = now() WHERE status = 'pending'");
      return { needsConfirmation: replaying.rowCount ?? 0, exhausted: pending.rowCount ?? 0 };
    });
  }
}
