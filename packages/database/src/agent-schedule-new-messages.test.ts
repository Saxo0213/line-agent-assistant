import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AgentScheduleCreateInput, AgentScheduleTask } from '@line-agent/contracts';
import { AgentScheduleRepository } from './agent-schedule-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const NEW_MESSAGES: AgentScheduleTask = { type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false,
  rules: [{ when: { metric: 'chat.messageCount', op: '>', value: 20 }, then: 'llm' }] };
const daily = (task: AgentScheduleTask, overrides: Partial<AgentScheduleCreateInput> = {}): AgentScheduleCreateInput => ({
  title: 't', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [],
  task, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, jitterMinutes: 0, enabled: true, ...overrides,
});
// 2026-10-01T01:00:00Z is 09:00 in Asia/Taipei.
const NINE = new Date('2026-10-01T01:00:00Z');
const DAY = 86_400_000;
const START = new Date('2026-10-01T00:00:00Z');

database('migration 082 and the new_messages task (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: AgentScheduleRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new AgentScheduleRepository(pool);
  });
  afterAll(async () => { await close(); });
  beforeEach(async () => { await pool.query('DELETE FROM agent_schedules'); });

  const insert = (task: string, targets = '[]', delivery = '{"mode":"primary_admin"}', lastOutcome: string | null = null) => pool.query(
    `INSERT INTO agent_schedules (title, prompt, provider, recurrence_kind, recurrence, task, delivery, targets, last_outcome)
     VALUES ('t','','claude','daily','{"kind":"daily","time":"09:00"}',$1,$2,$3,$4)`, [task, delivery, targets, lastOutcome]);

  it('accepts a new_messages row with no targets and no prompt, and keeps the other task rules', async () => {
    await expect(insert('{"type":"new_messages"}')).resolves.toBeDefined();
    await expect(insert(JSON.stringify(NEW_MESSAGES))).resolves.toBeDefined();
    await expect(insert('{"type":"new_messages"}', '[{"accountId":"a","chatType":"group","chatId":"g","title":""}]')).resolves.toBeDefined();
    // The other tasks keep their rules.
    await expect(insert('{"type":"summary"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"keyword_digest","keywords":["a"]}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"bogus"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '[]', '{"mode":"record_only"}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{"type":"message","text":"x"}', '[{"accountId":"a","chatType":"group","chatId":"g","title":""}]')).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts no_messages as a schedule and run outcome and rejects any other value', async () => {
    await expect(insert('{"type":"new_messages"}', '[]', '{"mode":"primary_admin"}', 'no_messages')).resolves.toBeDefined();
    await expect(insert('{"type":"new_messages"}', '[]', '{"mode":"primary_admin"}', 'nothing')).rejects.toMatchObject({ code: '23514' });
    const created = await repo.create(daily({ type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false }), START);
    await pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, now(), 'no_messages')", [created.scheduleId]);
    await expect(pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, now() + interval '1 day', 'nothing')", [created.scheduleId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('derives execution and mayUseLlm from the task and never stores them', async () => {
    const agent = await repo.create(daily({ type: 'custom' }, { prompt: 'p' }), START);
    const message = await repo.create(daily({ type: 'message', text: 'x' }), START);
    const plain = await repo.create(daily({ type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false }), START);
    const withLlm = await repo.create(daily(NEW_MESSAGES), START);
    expect([agent, message, plain, withLlm].map((s) => [s.execution, s.mayUseLlm])).toEqual([['agent', true], ['program', false], ['program', false], ['program', true]]);
    expect((await repo.list()).map((s) => [s.execution, s.mayUseLlm])).toEqual([['agent', true], ['program', false], ['program', false], ['program', true]]);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_schedules' AND table_schema = current_schema()")).rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).not.toContain('execution');
    expect(columns).not.toContain('may_use_llm');
    const patched = await repo.update(plain.scheduleId, { task: NEW_MESSAGES });
    expect(patched).toMatchObject({ execution: 'program', mayUseLlm: true, task: NEW_MESSAGES });
  });

  it('settles a run as no_messages exactly once', async () => {
    const created = await repo.create(daily(NEW_MESSAGES), START);
    const claim = (await repo.claimDue(new Date(NINE.getTime() + 1_000))).claims[0]!;
    expect(claim.task).toMatchObject({ type: 'new_messages' });
    expect(await repo.markNoMessages(claim.runId)).toBe(true);
    expect(await repo.markNoMessages(claim.runId)).toBe(false);
    expect(await repo.markSent(claim.runId)).toBe(false);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('no_messages');
    expect(await repo.listRuns(created.scheduleId)).toMatchObject([{ outcome: 'no_messages', jobId: null, replyPreview: null }]);
  });

  it('recovers a new_messages run stuck in submitting as send_unknown, never missed', async () => {
    const created = await repo.create(daily(NEW_MESSAGES), START);
    await repo.claimDue(new Date(NINE.getTime() + 1_000));
    expect(await repo.recoverStale()).toBe(1);
    expect((await repo.get(created.scheduleId))!.lastOutcome).toBe('send_unknown');
  });

  it('counts sent, no_messages and send_unknown (not send_failed or failed) for the since_last_run window of a new_messages schedule', async () => {
    const created = await repo.create(daily(NEW_MESSAGES), START);
    const outcomes = ['sent', 'no_messages', 'send_unknown', 'send_failed', 'failed'] as const;
    const marks = { sent: 'markSent', no_messages: 'markNoMessages', send_unknown: 'markSendUnknown', send_failed: 'markSendFailed', failed: 'markFailed' } as const;
    let previous: Date | null = null;
    for (let i = 0; i < outcomes.length; i++) {
      const claims = (await repo.claimDue(new Date(NINE.getTime() + i * DAY + 1_000))).claims;
      expect(claims).toHaveLength(1);
      // The claim carries the latest earlier run that counts.
      expect(claims[0]!.previousSubmittedFor?.toISOString() ?? null).toBe(previous?.toISOString() ?? null);
      expect((await repo.previousSubmittedFor(created.scheduleId, claims[0]!.scheduledFor))?.toISOString() ?? null).toBe(previous?.toISOString() ?? null);
      await repo[marks[outcomes[i]!]](claims[0]!.runId);
      if (i < 3) previous = claims[0]!.scheduledFor;
    }
    expect(previous?.toISOString()).toBe(new Date(NINE.getTime() + 2 * DAY).toISOString());
  });

  it('keeps counting only submitted runs for the other task types', async () => {
    const custom = await repo.create(daily({ type: 'custom' }, { prompt: 'p', delivery: { mode: 'record_only' } }), START);
    const message = await repo.create(daily({ type: 'message', text: 'x' }), START);
    const slot = (days: number) => new Date(NINE.getTime() + days * DAY);
    for (const id of [custom.scheduleId, message.scheduleId]) {
      for (const [i, outcome] of ['sent', 'no_messages', 'send_unknown', 'send_failed', 'failed', 'missed', 'skipped_overlap'].entries()) {
        await pool.query('INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, $2, $3)', [id, slot(i), outcome]);
      }
      expect(await repo.previousSubmittedFor(id, slot(30))).toBeNull();
      await pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome, job_id) VALUES ($1, $2, 'submitted', NULL)", [id, slot(10)]);
      expect((await repo.previousSubmittedFor(id, slot(30)))?.toISOString()).toBe(slot(10).toISOString());
    }
  });

  it('uses the current task type for the window after a task change', async () => {
    const created = await repo.create(daily({ type: 'custom' }, { prompt: 'p', delivery: { mode: 'record_only' } }), START);
    await pool.query("INSERT INTO agent_schedule_runs (schedule_id, scheduled_for, outcome) VALUES ($1, $2, 'sent')", [created.scheduleId, NINE]);
    expect(await repo.previousSubmittedFor(created.scheduleId, new Date(NINE.getTime() + DAY))).toBeNull();
    await repo.update(created.scheduleId, { task: { type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false }, delivery: { mode: 'primary_admin' } });
    expect((await repo.previousSubmittedFor(created.scheduleId, new Date(NINE.getTime() + DAY)))?.toISOString()).toBe(NINE.toISOString());
  });
});
