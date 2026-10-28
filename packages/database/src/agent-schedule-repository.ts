import type { Pool, PoolClient } from 'pg';
import {
  AGENT_SCHEDULE_JITTER_MAX_MINUTES,
  AGENT_SCHEDULE_MAX_ENABLED,
  AGENT_SCHEDULE_REQUEST_PREFIX,
  nextFireAfter,
  type AgentProvider,
  type AgentSchedule,
  type AgentScheduleCreateInput,
  type AgentScheduleDelivery,
  type AgentScheduleTarget,
  type AgentScheduleTask,
  type AgentScheduleWindow,
  type AgentScheduleRecurrence,
  type AgentScheduleRun,
  type AgentScheduleRunOutcome,
  type AgentScheduleUpdatePatch,
} from '@line-agent/contracts';

export type AgentScheduleErrorCode = 'SCHEDULE_NOT_FOUND' | 'SCHEDULE_LIMIT' | 'SCHEDULE_NO_FUTURE_TIME' | 'SCHEDULE_INVALID' | 'SCHEDULE_INVALID_TARGET';

export class AgentScheduleError extends Error {
  constructor(readonly code: AgentScheduleErrorCode, message: string) {
    super(message);
    this.name = 'AgentScheduleError';
  }
}

export const AGENT_SCHEDULE_CLAIM_GRACE_MS = 60_000;
const CLAIM_BATCH = 100;

/**
 * Next occurrence strictly after `after`: `nominal` is the recurrence time, `fireAt` is when it becomes due (nominal plus a random
 * whole-second delay of 0..jitterMinutes minutes). The delay is clamped to stay strictly below the gap to the following nominal
 * occurrence, so occurrences never skip or reorder. One draw per call.
 */
export function planNextFire(recurrence: AgentScheduleRecurrence, timezone: string, after: Date, jitterMinutes: number, random: () => number = Math.random): { nominal: Date; fireAt: Date } | null {
  const nominal = nextFireAfter(recurrence, timezone, after);
  if (nominal === null) return null;
  const jitter = Number.isFinite(jitterMinutes) ? Math.max(0, Math.min(AGENT_SCHEDULE_JITTER_MAX_MINUTES, Math.floor(jitterMinutes))) : 0;
  let maxSeconds = jitter * 60;
  if (maxSeconds > 0) {
    const following = nextFireAfter(recurrence, timezone, nominal);
    if (following !== null) maxSeconds = Math.min(maxSeconds, Math.floor((following.getTime() - nominal.getTime()) / 1000) - 1);
  }
  maxSeconds = Math.max(0, maxSeconds);
  const draw = maxSeconds > 0 ? Math.min(Math.max(random(), 0), 0.999999999) : 0;
  return { nominal, fireAt: new Date(nominal.getTime() + Math.floor(draw * (maxSeconds + 1)) * 1000) };
}
/** Serializes enabled-count checks so two concurrent creates cannot both pass the limit. */
const SCHEDULE_LIMIT_LOCK = 0x5c4ed01;

export interface AgentScheduleClaim {
  runId: string;
  scheduleId: string;
  scheduledFor: Date;
  title: string;
  prompt: string;
  provider: AgentProvider;
  recurrence: AgentScheduleRecurrence;
  timezone: string;
  targets: AgentScheduleTarget[];
  task: AgentScheduleTask;
  window: AgentScheduleWindow;
  delivery: AgentScheduleDelivery;
  /** scheduled_for of the schedule's latest earlier run that was submitted, for the since_last_run window; null when none. */
  previousSubmittedFor: Date | null;
}

export interface AgentScheduleClaimResult {
  claims: AgentScheduleClaim[];
  /** Runs recorded as missed or skipped_overlap, plus claims; true when any schedule row changed. */
  changed: boolean;
}

interface ScheduleRow {
  schedule_id: string; title: string; prompt: string; provider: AgentProvider; recurrence: AgentScheduleRecurrence; timezone: string;
  targets: AgentScheduleTarget[]; task: AgentScheduleTask; task_window: AgentScheduleWindow; delivery: AgentScheduleDelivery;
  enabled: boolean; jitter_minutes: number; next_fire_at: Date | null; next_nominal_at: Date | null; last_fire_at: Date | null; last_outcome: AgentScheduleRunOutcome | null;
  created_at: Date; updated_at: Date;
}
interface RunRow { run_id: string; schedule_id: string; scheduled_for: Date; outcome: AgentScheduleRunOutcome; job_id: string | null; reply_preview: string | null; created_at: Date }

const COLUMNS = `schedule_id, title, prompt, provider, recurrence, timezone, targets, task, task_window, delivery, enabled, jitter_minutes, next_fire_at, next_nominal_at, last_fire_at, last_outcome, created_at, updated_at`;

const iso = (value: Date): string => value.toISOString();
const toSchedule = (row: ScheduleRow): AgentSchedule => ({
  scheduleId: row.schedule_id, title: row.title, prompt: row.prompt, provider: row.provider, recurrence: row.recurrence,
  timezone: row.timezone, targets: row.targets, task: row.task, window: row.task_window, delivery: row.delivery, enabled: row.enabled, jitterMinutes: row.jitter_minutes, nextFireAt: row.next_fire_at ? iso(row.next_fire_at) : null,
  lastFireAt: row.last_fire_at ? iso(row.last_fire_at) : null, lastOutcome: row.last_outcome,
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const toRun = (row: RunRow): AgentScheduleRun => ({
  runId: row.run_id, scheduleId: row.schedule_id, scheduledFor: iso(row.scheduled_for), outcome: row.outcome,
  jobId: row.job_id, replyPreview: row.reply_preview, createdAt: iso(row.created_at),
});

export class AgentScheduleRepository {
  constructor(private readonly pool: Pool, private readonly options: { random?: () => number } = {}) {}

  private random(): number { return (this.options.random ?? Math.random)(); }

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

  async list(): Promise<AgentSchedule[]> {
    const result = await this.pool.query<ScheduleRow>(`SELECT ${COLUMNS} FROM agent_schedules ORDER BY created_at ASC, schedule_id ASC`);
    return result.rows.map(toSchedule);
  }

  async get(scheduleId: string): Promise<AgentSchedule | null> {
    const result = await this.pool.query<ScheduleRow>(`SELECT ${COLUMNS} FROM agent_schedules WHERE schedule_id = $1`, [scheduleId]);
    return result.rows[0] ? toSchedule(result.rows[0]) : null;
  }

  private async assertEnabledRoom(client: PoolClient, excludeScheduleId: string | null): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEDULE_LIMIT_LOCK]);
    const count = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM agent_schedules WHERE enabled AND ($1::uuid IS NULL OR schedule_id <> $1)', [excludeScheduleId]);
    if (Number(count.rows[0]!.count) >= AGENT_SCHEDULE_MAX_ENABLED) {
      throw new AgentScheduleError('SCHEDULE_LIMIT', `At most ${AGENT_SCHEDULE_MAX_ENABLED} schedules can be enabled at once.`);
    }
  }

  async create(input: AgentScheduleCreateInput, now: Date = new Date()): Promise<AgentSchedule> {
    const next = input.enabled ? planNextFire(input.recurrence, input.timezone, now, input.jitterMinutes, () => this.random()) : null;
    if (input.enabled && next === null) throw new AgentScheduleError('SCHEDULE_NO_FUTURE_TIME', 'The schedule has no future fire time.');
    return this.transaction(async (client) => {
      if (input.enabled) await this.assertEnabledRoom(client, null);
      const result = await client.query<ScheduleRow>(
        `INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, timezone, targets, task, task_window, delivery, enabled, next_fire_at, next_nominal_at, jitter_minutes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14) RETURNING ${COLUMNS}`,
        [input.title, input.prompt, input.provider, input.recurrence.kind, JSON.stringify(input.recurrence), input.timezone,
          JSON.stringify(input.targets), JSON.stringify(input.task), JSON.stringify(input.window), JSON.stringify(input.delivery), input.enabled, next?.fireAt ?? null, next?.nominal ?? null, input.jitterMinutes]);
      return toSchedule(result.rows[0]!);
    });
  }

  async update(scheduleId: string, patch: AgentScheduleUpdatePatch, now: Date = new Date()): Promise<AgentSchedule> {
    return this.transaction(async (client) => {
      const current = (await client.query<ScheduleRow>(`SELECT ${COLUMNS} FROM agent_schedules WHERE schedule_id = $1 FOR UPDATE`, [scheduleId])).rows[0];
      if (!current) throw new AgentScheduleError('SCHEDULE_NOT_FOUND', 'Schedule not found.');
      const recurrence = patch.recurrence ?? current.recurrence;
      const timezone = patch.timezone ?? current.timezone;
      const enabled = patch.enabled ?? current.enabled;
      const jitterMinutes = patch.jitterMinutes ?? current.jitter_minutes;
      if (enabled && !current.enabled) await this.assertEnabledRoom(client, scheduleId);
      const retime = patch.recurrence !== undefined || patch.timezone !== undefined || jitterMinutes !== current.jitter_minutes || (enabled && !current.enabled) || (enabled && current.next_fire_at === null);
      let next: { nominal: Date | null; fireAt: Date | null } | null = enabled ? { nominal: current.next_nominal_at ?? current.next_fire_at, fireAt: current.next_fire_at } : null;
      if (enabled && retime) {
        next = planNextFire(recurrence, timezone, now, jitterMinutes, () => this.random());
        if (next === null) throw new AgentScheduleError('SCHEDULE_NO_FUTURE_TIME', 'The schedule has no future fire time.');
      }
      const result = await client.query<ScheduleRow>(
        `UPDATE agent_schedules SET title = $2, prompt = $3, provider = $4, recurrence_kind = $5, recurrence = $6::jsonb, timezone = $7,
           targets = $8::jsonb, task = $9::jsonb, task_window = $10::jsonb, delivery = $11::jsonb,
           enabled = $12, next_fire_at = $13, next_nominal_at = $14, jitter_minutes = $15, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE schedule_id = $1 RETURNING ${COLUMNS}`,
        [scheduleId, patch.title ?? current.title, patch.prompt ?? current.prompt, patch.provider ?? current.provider, recurrence.kind,
          JSON.stringify(recurrence), timezone, JSON.stringify(patch.targets ?? current.targets), JSON.stringify(patch.task ?? current.task),
          JSON.stringify(patch.window ?? current.task_window), JSON.stringify(patch.delivery ?? current.delivery), enabled, next?.fireAt ?? null, next?.nominal ?? null, jitterMinutes]);
      return toSchedule(result.rows[0]!);
    });
  }

  async delete(scheduleId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM agent_schedules WHERE schedule_id = $1', [scheduleId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Claims every due schedule in ONE transaction (FOR UPDATE SKIP LOCKED). Per due row it records exactly one run:
   * missed (older than the grace window), skipped_overlap (the previous job has not finished) or submitting. The next fire
   * time always moves past max(scheduled_for, now): missed slots are never caught up. Only the `submitting` claims are returned;
   * the caller submits them after this transaction commits.
   */
  async claimDue(now: Date, graceMs: number = AGENT_SCHEDULE_CLAIM_GRACE_MS): Promise<AgentScheduleClaimResult> {
    return this.transaction(async (client) => {
      const due = await client.query<ScheduleRow>(
        `SELECT ${COLUMNS} FROM agent_schedules WHERE enabled AND next_fire_at IS NOT NULL AND next_fire_at <= $1
         ORDER BY next_fire_at ASC, schedule_id ASC LIMIT ${CLAIM_BATCH} FOR UPDATE SKIP LOCKED`, [now]);
      const claims: AgentScheduleClaim[] = [];
      let changed = false;
      for (const row of due.rows) {
        const dueAt = row.next_fire_at!;
        const scheduledFor = row.next_nominal_at ?? dueAt;
        let outcome: AgentScheduleRunOutcome;
        if (dueAt.getTime() < now.getTime() - graceMs) outcome = 'missed';
        else {
          const busy = await client.query(
            `SELECT 1 FROM agent_jobs WHERE source_type IN ('schedule', 'ui') AND status IN ('queued', 'running') AND starts_with(source_request_id, $1)
             UNION ALL SELECT 1 FROM agent_schedule_runs WHERE schedule_id = $2 AND outcome = 'submitting' LIMIT 1`,
            [`${AGENT_SCHEDULE_REQUEST_PREFIX}${row.schedule_id}:`, row.schedule_id]);
          outcome = (busy.rowCount ?? 0) > 0 ? 'skipped_overlap' : 'submitting';
        }
        const inserted = await client.query<{ run_id: string }>(
          `INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, $2, $3)
           ON CONFLICT (schedule_id, scheduled_for) DO NOTHING RETURNING run_id`, [row.schedule_id, scheduledFor, outcome]);
        // Plan from max(scheduled_for, now - grace): a following occurrence that has only just passed (a delayed claim) is kept, while stale ones after long downtime are still skipped.
        const next = planNextFire(row.recurrence, row.timezone, new Date(Math.max(scheduledFor.getTime(), now.getTime() - graceMs)), row.jitter_minutes, () => this.random());
        await client.query(
          `UPDATE agent_schedules SET next_fire_at = $2, next_nominal_at = $6, enabled = $3, last_fire_at = $4, last_outcome = $5,
             updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond') WHERE schedule_id = $1`,
          [row.schedule_id, next?.fireAt ?? null, next !== null, scheduledFor, outcome, next?.nominal ?? null]);
        changed = true;
        const runId = inserted.rows[0]?.run_id;
        if (runId && outcome === 'submitting') {
          const previous = await client.query<{ previous: Date | null }>(
            `SELECT max(scheduled_for) AS previous FROM agent_schedule_runs WHERE schedule_id = $1 AND outcome = 'submitted' AND scheduled_for < $2`,
            [row.schedule_id, scheduledFor]);
          claims.push({ runId, scheduleId: row.schedule_id, scheduledFor, title: row.title, prompt: row.prompt, provider: row.provider,
            recurrence: row.recurrence, timezone: row.timezone, targets: row.targets, task: row.task, window: row.task_window, delivery: row.delivery,
            previousSubmittedFor: previous.rows[0]?.previous ?? null });
        }
      }
      return { claims, changed };
    });
  }

  private async settle(runId: string, outcome: 'submitted' | 'failed' | 'sent' | 'send_failed' | 'send_unknown', jobId: string | null): Promise<boolean> {
    return this.transaction(async (client) => {
      const run = await client.query<{ schedule_id: string; scheduled_for: Date }>(
        `UPDATE agent_schedule_runs SET outcome = $2, job_id = $3 WHERE run_id = $1 AND outcome = 'submitting' RETURNING schedule_id, scheduled_for`,
        [runId, outcome, jobId]);
      const row = run.rows[0];
      if (!row) return false;
      await client.query('UPDATE agent_schedules SET last_outcome = $3 WHERE schedule_id = $1 AND last_fire_at = $2', [row.schedule_id, row.scheduled_for, outcome]);
      return true;
    });
  }

  markSubmitted(runId: string, jobId: string): Promise<boolean> { return this.settle(runId, 'submitted', jobId); }
  markFailed(runId: string): Promise<boolean> { return this.settle(runId, 'failed', null); }
  /** System message runs (no Agent job). `send_unknown` is final: the message may have reached LINE and is never retried. */
  markSent(runId: string): Promise<boolean> { return this.settle(runId, 'sent', null); }
  markSendFailed(runId: string): Promise<boolean> { return this.settle(runId, 'send_failed', null); }
  markSendUnknown(runId: string): Promise<boolean> { return this.settle(runId, 'send_unknown', null); }

  /**
   * Startup recovery: a run left in `submitting` is never retried. An Agent run becomes `missed`; a system message run may already
   * have reached LINE, so it becomes `send_unknown`. Returns how many runs changed.
   */
  async recoverStale(): Promise<number> {
    return this.transaction(async (client) => {
      const stale = await client.query<{ schedule_id: string; scheduled_for: Date; outcome: AgentScheduleRunOutcome }>(
        `UPDATE agent_schedule_runs r SET outcome = CASE WHEN COALESCE((SELECT s.task->>'type' FROM agent_schedules s WHERE s.schedule_id = r.schedule_id), '') = 'message'
             THEN 'send_unknown' ELSE 'missed' END
         WHERE r.outcome = 'submitting' RETURNING r.schedule_id, r.scheduled_for, r.outcome`);
      for (const row of stale.rows) {
        await client.query(`UPDATE agent_schedules SET last_outcome = $3 WHERE schedule_id = $1 AND last_fire_at = $2 AND last_outcome = 'submitting'`,
          [row.schedule_id, row.scheduled_for, row.outcome]);
      }
      return stale.rowCount ?? 0;
    });
  }

  /** scheduled_for of the schedule's latest submitted run before `scheduledFor`, for the since_last_run window; null when none. */
  async previousSubmittedFor(scheduleId: string, scheduledFor: Date): Promise<Date | null> {
    const result = await this.pool.query<{ previous: Date | null }>(
      "SELECT max(scheduled_for) AS previous FROM agent_schedule_runs WHERE schedule_id = $1 AND outcome = 'submitted' AND scheduled_for < $2", [scheduleId, scheduledFor]);
    return result.rows[0]?.previous ?? null;
  }

  async listRuns(scheduleId: string, limit = 20): Promise<AgentScheduleRun[]> {
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    const result = await this.pool.query<RunRow>(
      `SELECT r.run_id, r.schedule_id, r.scheduled_for, r.outcome, r.job_id, r.created_at,
         CASE WHEN char_length(o.final_text) > 200 THEN left(o.final_text, 199) || '…' ELSE o.final_text END AS reply_preview
       FROM agent_schedule_runs r LEFT JOIN agent_outputs o ON o.job_id = r.job_id
       WHERE r.schedule_id = $1 ORDER BY r.scheduled_for DESC LIMIT $2`, [scheduleId, bounded]);
    return result.rows.map(toRun);
  }
}
