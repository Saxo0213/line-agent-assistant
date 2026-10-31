import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_SCHEDULE_MAX_ENABLED, type AgentScheduleCreateInput } from '@line-agent/contracts';
import { AgentRepository } from './agent-repository.js';
import { AccountRepository } from './account-repository.js';
import { AgentScheduleError, AgentScheduleRepository, planNextFire } from './agent-schedule-repository.js';
import { migrate } from './migrate.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const daily = (title = 'daily', time = '09:00'): AgentScheduleCreateInput => ({
  title, prompt: 'do the thing', provider: 'claude', recurrence: { kind: 'daily', time }, timezone: 'Asia/Taipei', targets: [],
  task: { type: 'custom' }, window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' }, jitterMinutes: 0, enabled: true,
});

database('Agent schedule repository (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: AgentScheduleRepository;
  let agents: AgentRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new AgentScheduleRepository(pool);
    agents = new AgentRepository(pool);
  });
  afterAll(async () => { await close(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM agent_schedules');
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('account-A');
    await accounts.ensureAccount('account-B');
    await pool.query("UPDATE line_accounts SET product_role = CASE account_id WHEN 'account-A' THEN 'AGENT' ELSE 'PRIMARY_ADMIN' END, mode = 'MONITOR_ONLY' WHERE account_id = ANY($1::text[])", [['account-A', 'account-B']]);
  });

  // 2026-10-01T01:00:00Z is 09:00 in Asia/Taipei.
  const NINE = new Date('2026-10-01T01:00:00Z');

  it('creates with a computed next fire time and round-trips the recurrence', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    expect(created.nextFireAt).toBe(NINE.toISOString());
    expect(created.recurrence).toEqual({ kind: 'daily', time: '09:00' });
    expect(await repo.get(created.scheduleId)).toEqual(created);
    expect((await repo.list()).map((s) => s.scheduleId)).toEqual([created.scheduleId]);
  });

  it('isolates external schedule list, update and delete by the persisted caller account scope', async () => {
    const accountA = await repo.create({ ...daily('external A'), targets: [{ accountId: 'account-A', chatType: 'group', chatId: 'g-a', title: 'A' }] }, NINE, ['account-A']);
    const accountB = await repo.create({ ...daily('external B'), targets: [{ accountId: 'account-B', chatType: 'group', chatId: 'g-b', title: 'B' }] }, NINE, ['account-B']);
    const internal = await repo.create(daily('internal'), NINE);

    expect((await repo.listExternalScoped(['account-A'])).map((schedule) => schedule.scheduleId)).toEqual([accountA.scheduleId]);
    expect((await repo.listExternalScoped(['account-A', 'account-B'])).map((schedule) => schedule.scheduleId)).toEqual([accountA.scheduleId, accountB.scheduleId]);
    await expect(repo.updateExternalScoped(internal.scheduleId, { enabled: false }, ['account-A'], [], NINE)).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND' });
    await expect(repo.updateExternalScoped(accountA.scheduleId, { targets: [{ accountId: 'account-B', chatType: 'group', chatId: 'g-b', title: 'B' }] },
      ['account-A', 'account-B'], ['account-B'], NINE)).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    expect(await repo.deleteExternalScoped(accountB.scheduleId, ['account-A'])).toBe(false);
    expect(await repo.deleteExternalScoped(internal.scheduleId, ['account-A', 'account-B'])).toBe(false);
    expect(await repo.deleteExternalScoped(accountA.scheduleId, ['account-A'])).toBe(true);
  });

  it('rechecks account roles and pause state inside external schedule operations', async () => {
    await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id='account-A'");
    await expect(repo.create(daily('paused external'), NINE, ['account-A'])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(repo.listExternalScoped(['account-A'])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
  });

  it('validates external update shapes using the locked merged schedule row', async () => {
    const summary = await repo.create({ ...daily('summary'), task: { type: 'summary' },
      targets: [{ accountId: 'account-A', chatType: 'group', chatId: 'g-a', title: 'A' }] }, NINE, ['account-A']);
    await expect(repo.updateExternalScoped(summary.scheduleId, { targets: [] }, ['account-A'], [], NINE))
      .rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    const message = await repo.create({ ...daily('message'), task: { type: 'message', text: 'x' }, delivery: { mode: 'primary_admin' } }, NINE, ['account-A']);
    await expect(repo.updateExternalScoped(message.scheduleId, { delivery: { mode: 'record_only' } }, ['account-A'], [], NINE))
      .rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
  });

  it('claims a due schedule once and moves next_fire_at forward', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    const now = new Date(NINE.getTime() + 5_000);
    const first = await repo.claimDue(now);
    expect(first.claims).toHaveLength(1);
    expect(first.claims[0]).toMatchObject({ scheduleId: created.scheduleId, title: 'daily', provider: 'claude' });
    expect(first.claims[0]!.scheduledFor.toISOString()).toBe(NINE.toISOString());
    expect((await repo.claimDue(now)).claims).toHaveLength(0);
    const after = (await repo.get(created.scheduleId))!;
    expect(after.nextFireAt).toBe('2026-10-02T01:00:00.000Z');
    expect(after.lastFireAt).toBe(NINE.toISOString());
    expect(after.lastOutcome).toBe('submitting');
    expect(await repo.markSubmitted(first.claims[0]!.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
    expect(await repo.markSubmitted(first.claims[0]!.runId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('submitted');
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'submitted', jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);
  });

  it('runs two concurrent claims without double-firing', async () => {
    await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    const now = new Date(NINE.getTime() + 1_000);
    const [a, b] = await Promise.all([repo.claimDue(now), repo.claimDue(now)]);
    expect(a.claims.length + b.claims.length).toBe(1);
  });

  it('skips missed slots without catching up', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    // App was closed for three days: only one missed run is recorded and the next slot is in the future.
    const now = new Date('2026-10-04T05:00:00Z');
    const result = await repo.claimDue(now);
    expect(result.claims).toHaveLength(0);
    expect(result.changed).toBe(true);
    const after = (await repo.get(created.scheduleId))!;
    expect(after.nextFireAt).toBe('2026-10-05T01:00:00.000Z');
    expect(after.lastOutcome).toBe('missed');
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'missed', scheduledFor: NINE.toISOString() }]);
    expect((await repo.claimDue(now)).changed).toBe(false);
  });

  it('records skipped_overlap while the previous job is queued or running', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    const first = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    const { jobId } = await agents.enqueueScheduleJob({
      requestId: `schedule:${created.scheduleId}:${NINE.toISOString()}`, provider: 'claude', prompt: 'x', workspacePath: 'C:\\work' });
    await repo.markSubmitted(first.claims[0]!.runId, jobId);
    const nextSlot = new Date('2026-10-02T01:00:05Z');
    const overlapped = await repo.claimDue(nextSlot);
    expect(overlapped.claims).toHaveLength(0);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('skipped_overlap');
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [jobId]);
    await pool.query("UPDATE agent_schedules SET next_fire_at = $2 WHERE schedule_id = $1", [created.scheduleId, '2026-10-03T01:00:00Z']);
    const third = await repo.claimDue(new Date('2026-10-03T01:00:05Z'));
    expect(third.claims).toHaveLength(1);
    expect((await repo.listRuns(created.scheduleId)).map((r) => r.outcome)).toEqual(['submitting', 'skipped_overlap', 'submitted']);
  });

  it('disables a once schedule after it fires', async () => {
    const created = await repo.create({ ...daily(), recurrence: { kind: 'once', at: '2026-10-01T03:00:00.000Z' } }, new Date('2026-10-01T00:00:00Z'));
    expect(created.nextFireAt).toBe('2026-10-01T03:00:00.000Z');
    const result = await repo.claimDue(new Date('2026-10-01T03:00:10Z'));
    expect(result.claims).toHaveLength(1);
    const after = (await repo.get(created.scheduleId))!;
    expect(after).toMatchObject({ enabled: false, nextFireAt: null });
  });

  it('rejects a once schedule in the past and enforces the enabled limit', async () => {
    await expect(repo.create({ ...daily(), recurrence: { kind: 'once', at: '2026-09-01T00:00:00.000Z' } }, new Date('2026-10-01T00:00:00Z')))
      .rejects.toMatchObject({ code: 'SCHEDULE_NO_FUTURE_TIME' });
    const now = new Date('2026-10-01T00:00:00Z');
    for (let i = 0; i < AGENT_SCHEDULE_MAX_ENABLED; i++) await repo.create(daily(`s${i}`), now);
    await expect(repo.create(daily('overflow'), now)).rejects.toBeInstanceOf(AgentScheduleError);
    await expect(repo.create(daily('overflow'), now)).rejects.toMatchObject({ code: 'SCHEDULE_LIMIT' });
    // A disabled schedule does not count, but enabling it past the limit does.
    const parked = await repo.create({ ...daily('parked'), enabled: false }, now);
    expect(parked.nextFireAt).toBeNull();
    await expect(repo.update(parked.scheduleId, { enabled: true }, now)).rejects.toMatchObject({ code: 'SCHEDULE_LIMIT' });
  });

  it('retimes on update and clears next_fire_at when disabled', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const created = await repo.create(daily(), now);
    const moved = await repo.update(created.scheduleId, { recurrence: { kind: 'daily', time: '10:30' } }, now);
    expect(moved.nextFireAt).toBe('2026-10-01T02:30:00.000Z');
    const renamed = await repo.update(created.scheduleId, { title: 'renamed' }, new Date('2026-10-01T00:30:00Z'));
    expect(renamed.nextFireAt).toBe(moved.nextFireAt);
    const off = await repo.update(created.scheduleId, { enabled: false }, now);
    expect(off).toMatchObject({ enabled: false, nextFireAt: null });
    expect((await repo.update(created.scheduleId, { enabled: true }, now)).nextFireAt).toBe('2026-10-01T02:30:00.000Z');
    await expect(repo.update('00000000-0000-4000-8000-000000000000', { title: 'x' })).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND' });
  });

  it('recovers runs stuck in submitting as missed', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(await repo.recoverStale()).toBe(1);
    expect(await repo.recoverStale()).toBe(0);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('missed');
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'missed' }]);
  });

  it('recovers a system message run stuck in submitting as send_unknown, never missed', async () => {
    const created = await repo.create({ ...daily('alarm'), prompt: '', task: { type: 'message', text: '起床 {{time}}' }, delivery: { mode: 'primary_admin' } }, new Date('2026-10-01T00:00:00Z'));
    await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(await repo.recoverStale()).toBe(1);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('send_unknown');
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'send_unknown', jobId: null, replyPreview: null }]);
  });

  it('settles system message runs as sent, send_failed and send_unknown exactly once', async () => {
    const created = await repo.create({ ...daily('alarm'), prompt: '', task: { type: 'message', text: 'x' }, delivery: { mode: 'primary_admin' } }, new Date('2026-10-01T00:00:00Z'));
    const first = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(first.claims[0]).toMatchObject({ task: { type: 'message', text: 'x' } });
    expect(await repo.markSent(first.claims[0]!.runId)).toBe(true);
    expect(await repo.markSendUnknown(first.claims[0]!.runId)).toBe(false);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('sent');
    const second = await repo.claimDue(new Date('2026-10-02T01:00:05Z'));
    expect(await repo.markSendFailed(second.claims[0]!.runId)).toBe(true);
    const third = await repo.claimDue(new Date('2026-10-03T01:00:05Z'));
    expect(await repo.markSendUnknown(third.claims[0]!.runId)).toBe(true);
    expect((await repo.listRuns(created.scheduleId)).map((run) => run.outcome)).toEqual(['send_unknown', 'send_failed', 'sent']);
  });

  it('keeps the message task rules in the database', async () => {
    const insert = (task: string, delivery: string, targets = '[]') => pool.query(
      `INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, task, delivery, targets) VALUES ('t','','claude','daily','{"kind":"daily","time":"09:00"}',$1,$2,$3)`, [task, delivery, targets]);
    await expect(insert('{"type":"message"}', '{"mode":"primary_admin"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":""}', '{"mode":"primary_admin"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(JSON.stringify({ type: 'message', text: 'x'.repeat(5001) }), '{"mode":"primary_admin"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '{"mode":"record_only"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '{"mode":"agent_room"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '{"mode":"primary_admin"}', '[{"accountId":"a","chatType":"group","chatId":"g","title":""}]')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '{"mode":"primary_admin"}')).resolves.toBeDefined();
    await expect(insert(JSON.stringify({ type: 'message', text: 'x'.repeat(5000) }), '{"mode":"primary_admin"}')).resolves.toBeDefined();
  });

  it('lists the reply preview of a run job (200 characters at most) and null when there is no reply', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    const first = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    const { jobId } = await agents.enqueueScheduleJob({ requestId: `schedule:${created.scheduleId}:${NINE.toISOString()}`, provider: 'claude', prompt: 'x', workspacePath: 'C:\\work' });
    await repo.markSubmitted(first.claims[0]!.runId, jobId);
    expect((await repo.listRuns(created.scheduleId))[0]!.replyPreview).toBeNull();
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [jobId]);
    await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [jobId, 'r'.repeat(500)]);
    const preview = (await repo.listRuns(created.scheduleId))[0]!.replyPreview!;
    expect(Array.from(preview).length).toBe(200);
    expect(preview.endsWith('…')).toBe(true);
    await pool.query('UPDATE agent_outputs SET final_text = $2 WHERE job_id = $1', [jobId, '短回覆']);
    expect((await repo.listRuns(created.scheduleId))[0]!.replyPreview).toBe('短回覆');
  });

  it('marks a failed submission', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    const { claims } = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(await repo.markFailed(claims[0]!.runId)).toBe(true);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('failed');
  });

  it('cascades runs on delete and keeps (schedule_id, scheduled_for) unique', async () => {
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    await repo.claimDue(new Date(NINE.getTime() + 1_000));
    await expect(pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, $2, 'missed')", [created.scheduleId, NINE]))
      .rejects.toMatchObject({ code: '23505' });
    expect(await repo.delete(created.scheduleId)).toBe(true);
    expect(await repo.delete(created.scheduleId)).toBe(false);
    expect((await pool.query('SELECT 1 FROM agent_schedule_runs WHERE schedule_id = $1', [created.scheduleId])).rowCount).toBe(0);
  });

  it('round-trips targets, task, window and delivery and hands the claim the previous submitted slot', async () => {
    const group = { accountId: 'acc', chatType: 'group' as const, chatId: 'g1', title: 'Team' };
    const created = await repo.create({ ...daily(), prompt: '', task: { type: 'keyword_digest', keywords: ['a', 'b'] }, targets: [group],
      window: { mode: 'lookback', minutes: 60 }, delivery: { mode: 'line_target', target: group } }, new Date('2026-10-01T00:00:00Z'));
    expect(created).toMatchObject({ targets: [group], task: { type: 'keyword_digest', keywords: ['a', 'b'] }, window: { mode: 'lookback', minutes: 60 },
      delivery: { mode: 'line_target', target: group } });
    const first = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(first.claims[0]).toMatchObject({ previousSubmittedFor: null, targets: [group], task: { type: 'keyword_digest' }, window: { mode: 'lookback', minutes: 60 } });
    await repo.markSubmitted(first.claims[0]!.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const second = await repo.claimDue(new Date('2026-10-02T01:00:05Z'));
    expect(second.claims[0]!.previousSubmittedFor?.toISOString()).toBe(NINE.toISOString());
    const patched = await repo.update(created.scheduleId, { window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' } });
    expect(patched).toMatchObject({ window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' }, targets: [group] });
  });

  it('enforces the task rules in the database', async () => {
    await expect(pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence) VALUES ('t','','claude','daily','{\"kind\":\"daily\"}')"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, task) VALUES ('t','','claude','daily','{\"kind\":\"daily\"}','{\"type\":\"summary\"}')"))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an invalid outcome and a kind that disagrees with the recurrence', async () => {
    await expect(pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence) VALUES ('t','p','claude','daily','{\"kind\":\"cron\"}')"))
      .rejects.toMatchObject({ code: '23514' });
    const created = await repo.create(daily(), new Date('2026-10-01T00:00:00Z'));
    await expect(pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, now(), 'bogus')", [created.scheduleId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('round-trips a community read target with the primary_admin delivery', async () => {
    const created = await repo.create({
      ...daily('community'), task: { type: 'summary' }, delivery: { mode: 'primary_admin' },
      targets: [{ accountId: 'acc-1', chatType: 'community', chatId: 'c-open', title: '社群' }],
    }, new Date('2026-10-01T00:00:00Z'));
    expect(await repo.get(created.scheduleId)).toMatchObject({ delivery: { mode: 'primary_admin' }, targets: [{ chatType: 'community', chatId: 'c-open' }] });
    const defaulted = await pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence) VALUES ('d','p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}') RETURNING delivery");
    expect(defaulted.rows[0].delivery).toEqual({ mode: 'primary_admin' });
    await expect(pool.query("UPDATE agent_schedules SET delivery = '{\"mode\":\"bogus\"}' WHERE schedule_id = $1", [created.scheduleId]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

database('migrations 070 and 072 on a database where 069 already ran', () => {
  it('accepts primary_admin after 069 and converts agent_room to record_only', async () => {
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    const scratch = await mkdtemp(path.join(tmpdir(), 'linejs-mig-070-'));
    const upTo069 = path.join(scratch, 'm');
    await mkdir(upTo069);
    for (const name of (await readdir(source)).filter((file) => /^\d+_.*\.sql$/.test(file) && file < '070')) await copyFile(path.join(source, name), path.join(upTo069, name));
    const { pool, close } = await createTestDatabase(upTo069);
    try {
      await pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, delivery) VALUES ('old','p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}','{\"mode\":\"agent_room\"}')");
      await expect(pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, delivery) VALUES ('x','p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}','{\"mode\":\"primary_admin\"}')"))
        .rejects.toMatchObject({ code: '23514' });
      await migrate(pool);
      await migrate(pool);
      await pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, delivery) VALUES ('new','p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}','{\"mode\":\"primary_admin\"}')");
      const rows = (await pool.query('SELECT title, delivery FROM agent_schedules ORDER BY title')).rows;
      expect(rows).toEqual([{ title: 'new', delivery: { mode: 'primary_admin' } }, { title: 'old', delivery: { mode: 'record_only' } }]);
      await expect(pool.query("INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, delivery) VALUES ('x','p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}','{\"mode\":\"agent_room\"}')"))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

database('migration 072 on a database that already holds schedules and jobs', () => {
  it('converts agent_room, keeps every existing row valid and then accepts schedule jobs and message tasks', async () => {
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    const scratch = await mkdtemp(path.join(tmpdir(), 'linejs-mig-072-'));
    const before = path.join(scratch, 'm');
    await mkdir(before);
    for (const name of (await readdir(source)).filter((file) => /^\d+_.*\.sql$/.test(file) && file < '072')) await copyFile(path.join(source, name), path.join(before, name));
    const { pool, close } = await createTestDatabase(before);
    try {
      const insertSchedule = (title: string, delivery: string, task = '{"type":"custom"}', targets = '[]') => pool.query(
        "INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, delivery, task, targets, last_outcome) VALUES ($1,'p','claude','daily','{\"kind\":\"daily\",\"time\":\"09:00\"}',$2,$3,$4,'submitted')",
        [title, delivery, task, targets]);
      await insertSchedule('room', '{"mode":"agent_room"}');
      await insertSchedule('admin', '{"mode":"primary_admin"}');
      await insertSchedule('line', '{"mode":"line_target","target":{"accountId":"a","chatType":"group","chatId":"g","title":"G"}}');
      await insertSchedule('summary', '{"mode":"agent_room"}', '{"type":"summary"}', '[{"accountId":"a","chatType":"group","chatId":"g","title":"G"}]');
      const schedule = (await pool.query<{ schedule_id: string }>("SELECT schedule_id FROM agent_schedules WHERE title = 'room'")).rows[0]!.schedule_id;
      await pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, now(), 'submitted')", [schedule]);
      // A room job created by an old schedule run and an ordinary room job stay as they are.
      await pool.query("INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation) VALUES (gen_random_uuid(), 'claude', 'ui', $1, 'old card', 'C:\\w', 0), (gen_random_uuid(), 'claude', 'ui', 'plain', 'room', 'C:\\w', 0)",
        [`schedule:${schedule}:2026-10-01T01:00:00.000Z`]);
      await migrate(pool);
      await migrate(pool);
      const rows = (await pool.query('SELECT title, delivery, last_outcome FROM agent_schedules ORDER BY title')).rows;
      expect(rows.map((row) => [row.title, row.delivery.mode, row.last_outcome])).toEqual([
        ['admin', 'primary_admin', 'submitted'], ['line', 'line_target', 'submitted'], ['room', 'record_only', 'submitted'], ['summary', 'record_only', 'submitted']]);
      expect((await pool.query('SELECT count(*)::int AS n FROM agent_schedule_runs')).rows[0].n).toBe(1);
      expect((await pool.query("SELECT source_type, count(*)::int AS n FROM agent_jobs GROUP BY source_type")).rows).toEqual([{ source_type: 'ui', n: 2 }]);
      // New: a schedule job (same request id namespace as the old room job is a different source type) and a message task.
      await pool.query("INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation) VALUES (gen_random_uuid(), 'claude', 'schedule', $1, 'card', 'C:\\w', 0)",
        [`schedule:${schedule}:2026-10-01T01:00:00.000Z`]);
      await expect(insertSchedule('message', '{"mode":"primary_admin"}', '{"type":"message","text":"hi"}')).resolves.toBeDefined();
      await expect(insertSchedule('bad', '{"mode":"record_only"}', '{"type":"message","text":"hi"}')).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, now() + interval '1 day', 'send_unknown')", [schedule])).resolves.toBeDefined();
      // The old LINE / UI job rules still hold.
      await expect(pool.query("INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation) VALUES (gen_random_uuid(), 'claude', 'bogus', 'x', 'p', 'C:\\w', 0)")).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query("INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_request_id, prompt, workspace_path, generation) VALUES (gen_random_uuid(), 'a', 'direct', 'c', 'claude', 'ui', 'y', 'p', 'C:\\w', 0)")).rejects.toThrow();
    } finally {
      await close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('planNextFire', () => {
  const daily9 = { kind: 'daily', time: '09:00' } as const;
  const after = new Date('2026-10-01T00:00:00Z');
  const NINE = new Date('2026-10-01T01:00:00Z');

  it('without jitter equals the nominal time and never draws randomness', () => {
    const random = () => { throw new Error('unused'); };
    expect(planNextFire(daily9, 'Asia/Taipei', after, 0, random)).toEqual({ nominal: NINE, fireAt: NINE });
  });

  it('delays by a whole number of seconds within 0..jitter minutes, never earlier', () => {
    const at = (r: number) => planNextFire(daily9, 'Asia/Taipei', after, 5, () => r)!;
    expect(at(0).fireAt).toEqual(NINE);
    expect(at(0.5).fireAt.getTime() - NINE.getTime()).toBe(150_000);
    expect(at(0.999999).fireAt.getTime() - NINE.getTime()).toBe(300_000);
    expect(at(1).fireAt.getTime() - NINE.getTime()).toBe(300_000);
    expect(at(0.5).nominal).toEqual(NINE);
    expect(planNextFire(daily9, 'Asia/Taipei', after, 2, () => 0.999)!.fireAt.getTime() - NINE.getTime()).toBe(120_000);
  });

  it('clamps the delay strictly below the gap to the following occurrence', () => {
    const everyFive = { kind: 'interval', everyMinutes: 5, anchorAt: '2026-10-01T00:00:00Z' } as const;
    const plan = planNextFire(everyFive, 'Asia/Taipei', new Date('2026-10-01T00:01:00Z'), 5, () => 0.999999)!;
    expect(plan.nominal.toISOString()).toBe('2026-10-01T00:05:00.000Z');
    expect(plan.fireAt.getTime() - plan.nominal.getTime()).toBe(299_000);
    const everyTen = { kind: 'interval', everyMinutes: 10, anchorAt: '2026-10-01T00:00:00Z' } as const;
    expect(planNextFire(everyTen, 'Asia/Taipei', new Date('2026-10-01T00:01:00Z'), 5, () => 0.999999)!.fireAt.getTime() - new Date('2026-10-01T00:10:00Z').getTime()).toBe(300_000);
  });

  it('does not clamp a once schedule and returns null when there is no future time', () => {
    const once = { kind: 'once', at: '2026-10-01T01:00:00Z' } as const;
    expect(planNextFire(once, 'Asia/Taipei', after, 5, () => 0.999999)!.fireAt.getTime() - NINE.getTime()).toBe(300_000);
    expect(planNextFire(once, 'Asia/Taipei', NINE, 5)).toBeNull();
  });
});

database('Agent schedule jitter (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let draws: number[];
  let repo: AgentScheduleRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new AgentScheduleRepository(pool, { random: () => draws.shift() ?? 0 });
  });
  afterAll(async () => { await close(); });
  beforeEach(async () => { draws = []; await pool.query('DELETE FROM agent_schedules'); });

  const NINE = new Date('2026-10-01T01:00:00Z');
  const START = new Date('2026-10-01T00:00:00Z');
  const jittered = (jitterMinutes: number, extra: Partial<AgentScheduleCreateInput> = {}): AgentScheduleCreateInput => ({ ...daily(), jitterMinutes, ...extra });

  it('stores the delayed time in next_fire_at and keeps the nominal time for the run', async () => {
    draws = [0.5];
    const created = await repo.create(jittered(5), START);
    expect(created.jitterMinutes).toBe(5);
    expect(created.nextFireAt).toBe(new Date(NINE.getTime() + 150_000).toISOString());
    expect(await repo.get(created.scheduleId)).toEqual(created);
    // Not due at the nominal time: the run waits for the delay.
    expect((await repo.claimDue(new Date(NINE.getTime() + 60_000))).claims).toHaveLength(0);
    draws = [0.2];
    const result = await repo.claimDue(new Date(NINE.getTime() + 151_000));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.scheduledFor.toISOString()).toBe(NINE.toISOString());
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'submitting', scheduledFor: NINE.toISOString() }]);
    const after = (await repo.get(created.scheduleId))!;
    expect(after.lastFireAt).toBe(NINE.toISOString());
    // The following occurrence is the next nominal time plus a fresh draw (0.2 of 301 seconds, floored to 60).
    expect(after.nextFireAt).toBe(new Date(NINE.getTime() + 86_400_000 + 60_000).toISOString());
    expect(await repo.markSubmitted(result.claims[0]!.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('submitted');
  });

  it('does not mark a delayed run as missed and leaves the following nominal time unaffected', async () => {
    draws = [0.999999];
    const created = await repo.create(jittered(5), START);
    expect(created.nextFireAt).toBe(new Date(NINE.getTime() + 300_000).toISOString());
    draws = [0];
    // 5 minutes past the nominal time, just due: inside the grace window of the due time.
    const result = await repo.claimDue(new Date(NINE.getTime() + 300_000 + 5_000));
    expect(result.claims).toHaveLength(1);
    expect((await repo.get(created.scheduleId))!.nextFireAt).toBe('2026-10-02T01:00:00.000Z');
  });

  it('still records a genuinely late run as missed and schedules the next one after now', async () => {
    const created = await repo.create(jittered(5), START);
    const result = await repo.claimDue(new Date('2026-10-04T05:00:00Z'));
    expect(result.claims).toHaveLength(0);
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'missed', scheduledFor: NINE.toISOString() }]);
    expect((await repo.get(created.scheduleId))!.nextFireAt).toBe('2026-10-05T01:00:00.000Z');
  });

  it('clamps an every-5-minutes schedule so no occurrence is skipped', async () => {
    const recurrence = { kind: 'interval', everyMinutes: 5, anchorAt: '2026-10-01T00:00:00Z' } as const;
    draws = [0.999999];
    const created = await repo.create(jittered(5, { recurrence }), new Date('2026-10-01T00:01:00Z'));
    expect(created.nextFireAt).toBe('2026-10-01T00:09:59.000Z');
    draws = [0.999999];
    const first = await repo.claimDue(new Date('2026-10-01T00:09:59Z'));
    expect(first.claims[0]!.scheduledFor.toISOString()).toBe('2026-10-01T00:05:00.000Z');
    // The 00:10 slot is still the very next occurrence, delayed by at most 299 seconds.
    expect((await repo.get(created.scheduleId))!.nextFireAt).toBe('2026-10-01T00:14:59.000Z');
    draws = [0];
    await repo.markSubmitted(first.claims[0]!.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const second = await repo.claimDue(new Date('2026-10-01T00:15:00Z'));
    expect(second.claims[0]!.scheduledFor.toISOString()).toBe('2026-10-01T00:10:00.000Z');
  });

  it('does not skip the following occurrence when a delayed claim happens after it', async () => {
    const recurrence = { kind: 'interval', everyMinutes: 5, anchorAt: '2026-10-01T00:00:00Z' } as const;
    draws = [0.999999];
    const created = await repo.create(jittered(5, { recurrence }), new Date('2026-10-01T00:01:00Z'));
    expect(created.nextFireAt).toBe('2026-10-01T00:09:59.000Z');
    // Claim 30 seconds after fireAt (00:10:29), already past the following nominal time 00:10:00.
    draws = [0.999999];
    const first = await repo.claimDue(new Date('2026-10-01T00:10:29Z'));
    expect(first.claims[0]!.scheduledFor.toISOString()).toBe('2026-10-01T00:05:00.000Z');
    const afterFirst = (await repo.get(created.scheduleId))!;
    expect(afterFirst.nextFireAt).toBe('2026-10-01T00:14:59.000Z');
    await repo.markSubmitted(first.claims[0]!.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    draws = [0];
    const second = await repo.claimDue(new Date('2026-10-01T00:15:00Z'));
    expect(second.claims).toHaveLength(1);
    expect(second.claims[0]!.scheduledFor.toISOString()).toBe('2026-10-01T00:10:00.000Z');
    expect((await repo.listRuns(created.scheduleId)).map((run) => run.outcome)).not.toContain('missed');
  });

  it('jitter 0 behaves exactly like before', async () => {
    const created = await repo.create(jittered(0), START);
    expect(created.nextFireAt).toBe(NINE.toISOString());
    const result = await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(result.claims[0]!.scheduledFor.toISOString()).toBe(NINE.toISOString());
    expect((await repo.get(created.scheduleId))!.nextFireAt).toBe('2026-10-02T01:00:00.000Z');
  });

  it('recomputes next_fire_at when jitterMinutes or the recurrence changes, and keeps it otherwise', async () => {
    const created = await repo.create(jittered(0), START);
    draws = [0.5];
    const moved = await repo.update(created.scheduleId, { jitterMinutes: 5 }, START);
    expect(moved.jitterMinutes).toBe(5);
    expect(moved.nextFireAt).toBe(new Date(NINE.getTime() + 150_000).toISOString());
    draws = [0.9];
    const renamed = await repo.update(created.scheduleId, { title: 'renamed' }, START);
    expect(renamed.nextFireAt).toBe(moved.nextFireAt);
    expect(draws).toEqual([0.9]);
    draws = [0];
    expect((await repo.update(created.scheduleId, { recurrence: { kind: 'daily', time: '10:30' } }, START)).nextFireAt).toBe('2026-10-01T02:30:00.000Z');
    expect((await repo.update(created.scheduleId, { jitterMinutes: 0 }, START)).nextFireAt).toBe('2026-10-01T02:30:00.000Z');
  });

  it('rejects an out-of-range jitter in the database', async () => {
    const created = await repo.create(jittered(0), START);
    await expect(pool.query('UPDATE agent_schedules SET jitter_minutes = 6 WHERE schedule_id = $1', [created.scheduleId])).rejects.toThrow();
    await expect(pool.query('UPDATE agent_schedules SET jitter_minutes = -1 WHERE schedule_id = $1', [created.scheduleId])).rejects.toThrow();
  });
});
