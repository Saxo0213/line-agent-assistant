import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY } from '@line-agent/contracts';
import { AgentRepository, findSharedAdminChat } from './agent-repository.js';
import { queryAgentRoomHistory } from './agent-room-history.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const WORKSPACE = 'C:\\work';
const request = (n: number) => `schedule:00000000-0000-4000-8000-00000000000${n}:2026-10-01T01:00:00.000Z`;

database('isolated scheduled runs (migration 072, real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
  });
  afterAll(async () => { await close(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM agent_jobs');
    await pool.query('DELETE FROM agent_sessions');
  });

  const schedule = (n: number, prompt = '[排程] 早報') => agents.enqueueScheduleJob({ provider: 'claude', requestId: request(n), prompt, workspacePath: WORKSPACE });
  const room = (id: string) => agents.enqueueUiJob({ provider: 'claude', requestId: id, prompt: `room ${id}`, workspacePath: WORKSPACE });
  const status = async (jobId: string) => (await pool.query<{ status: string }>('SELECT status FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0]?.status;

  it('enqueues idempotently per schedule slot and never writes a session row', async () => {
    const first = await schedule(1);
    expect(first.disposition).toBe('inserted');
    const again = await schedule(1, 'different text');
    expect(again).toEqual({ disposition: 'duplicate', jobId: first.jobId });
    expect((await pool.query('SELECT count(*)::int AS n FROM agent_jobs WHERE source_type = \'schedule\'')).rows[0].n).toBe(1);
    const row = (await pool.query('SELECT account_id, chat_type, chat_id, generation, creation_epoch, source_message_id, source_request_id FROM agent_jobs WHERE job_id = $1', [first.jobId])).rows[0];
    expect(row).toEqual({ account_id: null, chat_type: null, chat_id: null, generation: 0, creation_epoch: null, source_message_id: null, source_request_id: request(1) });
    expect((await pool.query('SELECT count(*)::int AS n FROM agent_sessions')).rows[0].n).toBe(0);
    // The room's own request ids are a different namespace.
    expect((await room(request(1))).disposition).toBe('inserted');
  });

  it('copies an external schedule account scope onto the isolated schedule job', async () => {
    const result = await agents.enqueueScheduleJob({ provider: 'claude', requestId: request(8), prompt: 'scoped', workspacePath: WORKSPACE,
      mcpAccountScope: ['account-B', 'account-A', 'account-A'] });
    const row = (await pool.query<{ mcp_account_scope: string[] | null }>('SELECT mcp_account_scope FROM agent_jobs WHERE job_id=$1', [result.jobId])).rows[0];
    expect(row?.mcp_account_scope).toEqual(['account-B', 'account-A']);
  });

  it('claims on its own queue, one run at a time, with no session and no room lookups', async () => {
    const a = await schedule(1);
    const b = await schedule(2);
    const claimed = await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    expect(claimed).toMatchObject({ jobId: a.jobId, status: 'running', sourceType: 'schedule', accountId: null, chatType: 'schedule', chatId: null, generation: 0 });
    expect(claimed?.sessionKey).toBeUndefined();
    expect(claimed?.sessionGeneration).toBeUndefined();
    expect(await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY)).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM agent_sessions')).rows[0].n).toBe(0);
    await agents.completeJob(a.jobId, 'done', ['done'], 0);
    expect((await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY))?.jobId).toBe(b.jobId);
    // A second running schedule job is impossible at the database level too.
    await expect(pool.query("UPDATE agent_jobs SET status = 'running' WHERE source_type = 'schedule' AND status = 'completed'")).rejects.toMatchObject({ code: '23505' });
  });

  it('never makes the room wait for a running scheduled run, nor the run wait for the room', async () => {
    const scheduled = await schedule(1);
    const queuedRoom = await room('r1');
    expect((await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY))?.jobId).toBe(scheduled.jobId);
    // The room job is claimable while the scheduled run is running.
    const roomClaim = await agents.claimNext(AGENT_ROOM_KEY);
    expect(roomClaim?.jobId).toBe(queuedRoom.jobId);
    expect(roomClaim?.sessionKey).toMatchObject({ sourceType: 'ui' });
    // And the reverse: a new scheduled run is claimable while a room job runs.
    await agents.completeJob(scheduled.jobId, 'ok', ['ok'], 0);
    const next = await schedule(2);
    expect(await status(queuedRoom.jobId)).toBe('running');
    expect((await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY))?.jobId).toBe(next.jobId);
    // Each key claims only its own source type.
    await agents.completeJob(next.jobId, 'ok', ['ok'], 0);
    await schedule(3);
    await room('r2');
    await agents.completeJob(queuedRoom.jobId, 'ok', ['ok'], 0);
    expect(await agents.claimNext(AGENT_ROOM_KEY)).toMatchObject({ sourceType: 'ui', prompt: 'room r2' });
  });

  it('discovers the schedule head separately from the room head', async () => {
    const scheduled = await schedule(1);
    const queuedRoom = await room('r1');
    const keys = await agents.listQueuedConversations();
    expect(keys).toEqual([AGENT_SCHEDULE_QUEUE_KEY, AGENT_ROOM_KEY]);
    await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    await schedule(2);
    expect(await agents.listQueuedConversations()).toEqual([AGENT_ROOM_KEY]);
    await agents.claimNext(AGENT_ROOM_KEY);
    expect(await agents.listQueuedConversations()).toEqual([]);
    await agents.completeJob(scheduled.jobId, 'x', ['x'], 0);
    expect(await agents.listQueuedConversations()).toEqual([AGENT_SCHEDULE_QUEUE_KEY]);
    expect(queuedRoom.jobId).toBeDefined();
  });

  it('keeps scheduled runs out of every room query', async () => {
    const scheduled = await schedule(1);
    const roomJob = await room('r1');
    await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    await agents.appendEvent(scheduled.jobId, { type: 'completed', finalText: 'secret scheduled reply' });
    await agents.appendEvent(roomJob.jobId, { type: 'text_delta', text: 'room text' });
    await agents.completeJob(scheduled.jobId, 'secret scheduled reply', ['secret scheduled reply'], 0);
    // Events: the room key and the room lookup never see the schedule job; the schedule key does.
    expect(await agents.listJobEvents(AGENT_ROOM_KEY, scheduled.jobId)).toEqual([]);
    expect(await agents.listRoomJobEvents(scheduled.jobId)).toEqual([]);
    expect(await agents.listJobEvents(AGENT_SCHEDULE_QUEUE_KEY, scheduled.jobId)).toEqual([{ type: 'completed', finalText: 'secret scheduled reply' }]);
    expect(await agents.listJobEvents(AGENT_SCHEDULE_QUEUE_KEY, roomJob.jobId)).toEqual([]);
    expect(await agents.getJobForKey(AGENT_ROOM_KEY, scheduled.jobId)).toBeNull();
    expect(await agents.getJobForKey(AGENT_SCHEDULE_QUEUE_KEY, scheduled.jobId)).toMatchObject({ jobId: scheduled.jobId });
    // query_agent_room_history lists the room's job and not the scheduled run.
    const history = await queryAgentRoomHistory(pool, {}, await findSharedAdminChat(pool));
    expect(history.items.map((item) => item.jobId)).toEqual([roomJob.jobId]);
    expect(JSON.stringify(history)).not.toContain('secret scheduled reply');
    // The room's stop, retry and bulk-cancel cannot touch a scheduled run.
    const queuedSchedule = await schedule(2);
    expect(await agents.cancelJobForKey(AGENT_ROOM_KEY, queuedSchedule.jobId)).toBeNull();
    expect(await agents.cancelConversationJobs(AGENT_ROOM_KEY)).toHaveLength(1);
    expect(await status(queuedSchedule.jobId)).toBe('queued');
    expect(await status(roomJob.jobId)).toBe('cancelled');
    expect((await agents.cancelJobForKey(AGENT_SCHEDULE_QUEUE_KEY, queuedSchedule.jobId))?.status).toBe('cancelled');
  });

  it('retries a failed or interrupted scheduled run on the schedule key only', async () => {
    const scheduled = await schedule(1);
    await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    expect(await agents.recoverInterruptedState()).toMatchObject({ interruptedJobs: 1 });
    expect(await status(scheduled.jobId)).toBe('interrupted');
    expect(await agents.retryJobForKey(AGENT_ROOM_KEY, scheduled.jobId, WORKSPACE)).toBeNull();
    expect((await agents.retryJobForKey(AGENT_SCHEDULE_QUEUE_KEY, scheduled.jobId, WORKSPACE))?.status).toBe('queued');
    expect((await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY))?.jobId).toBe(scheduled.jobId);
    await agents.failJob(scheduled.jobId);
    expect((await agents.retryJobForKey(AGENT_SCHEDULE_QUEUE_KEY, scheduled.jobId, WORKSPACE))?.status).toBe('queued');
  });

  it('never resumes a scheduled run and ignores a bound session of the room', async () => {
    const scheduled = await schedule(1);
    const claimed = await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    expect(claimed?.sourceType).toBe('schedule');
    await expect(agents.validateResumeSession({ jobId: scheduled.jobId, provider: 'claude', source: { type: 'schedule', requestId: request(1) }, prompt: 'p',
      workspacePath: WORKSPACE, tools: { builtIn: 'none' } as never, resumeSessionId: 'sess' })).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects malformed schedule jobs in the database', async () => {
    const insert = (columns: string, values: string) => pool.query(`INSERT INTO agent_jobs (job_id, provider, source_type, prompt, workspace_path, ${columns}) VALUES (gen_random_uuid(), 'claude', 'schedule', 'p', 'C:\\w', ${values})`);
    await expect(insert('source_request_id, generation', "'ui-looking', 0")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('source_request_id, generation', "'schedule:x', 3")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('source_request_id, generation, source_message_id', "'schedule:x', 0, 'm'")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('source_request_id, generation, account_id', "'schedule:x', 0, 'acc'")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('source_request_id, generation, creation_epoch', "'schedule:x', 0, 1")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('source_request_id, generation', "'schedule:x', 0")).resolves.toBeDefined();
  });
});
