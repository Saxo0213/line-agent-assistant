import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, type AgentEvent, type AgentRunRequest } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentRepository } from '../../../../../packages/database/src/index.js';
import { newAgentService } from './agent-service-test-support.js';
import type { InternalMcpLauncher } from './agent-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const WORKSPACE = 'C:\\trusted';
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await tick(); }
  throw new Error('Timed out waiting for service state');
}
const slot = (n: number) => `schedule:00000000-0000-4000-8000-00000000000${n}:2026-10-01T01:00:00.000Z`;

database('AgentService: isolated scheduled runs', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let requests: AgentRunRequest[];
  let running: Set<string>;
  let overlap: { schedule: number; room: number; maxSchedule: number; maxBoth: number };
  let release: Map<string, () => void>;
  let hold: Set<string>;
  const cancelled: string[] = [];
  const services: Array<ReturnType<typeof newAgentService>> = [];

  const bridge = {
    async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      requests.push(request);
      const kind = request.source.type === 'schedule' ? 'schedule' : 'room';
      overlap[kind] += 1;
      overlap.maxSchedule = Math.max(overlap.maxSchedule, overlap.schedule);
      overlap.maxBoth = Math.max(overlap.maxBoth, overlap.schedule + overlap.room);
      running.add(request.jobId);
      try {
        if (hold.has(request.source.type === 'ui' ? 'room' : request.jobId) || hold.has(request.jobId) || hold.has(kind)) {
          await new Promise<void>((resolve) => { release.set(request.jobId, resolve); });
        } else await tick();
        yield { type: 'started', externalSessionId: `session-${request.jobId.slice(0, 8)}`, workspacePath: request.workspacePath };
        yield { type: 'completed', finalText: `reply ${request.jobId.slice(0, 8)}` };
      } finally { overlap[kind] -= 1; running.delete(request.jobId); }
    },
    async cancel(jobId: string) { cancelled.push(jobId); release.get(jobId)?.(); },
  };
  const service = (...rest: Parameters<typeof newAgentService> extends [unknown, unknown, unknown, ...infer R] ? R : never) => {
    const created = newAgentService(agents, { current: async () => WORKSPACE }, bridge, ...rest);
    services.push(created);
    return created;
  };
  const sessionRows = async () => (await pool.query('SELECT provider, source_type, external_session_id FROM agent_sessions ORDER BY provider, source_type')).rows;
  const status = async (jobId: string) => (await agents.getJob(jobId))?.status;
  const scheduled = (n: number) => agents.enqueueScheduleJob({ provider: 'claude', requestId: slot(n), prompt: `[排程] job ${n}`, workspacePath: WORKSPACE });

  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); agents = new AgentRepository(pool); });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM agent_jobs');
    await pool.query('DELETE FROM agent_sessions');
    requests = []; running = new Set(); release = new Map(); hold = new Set(); cancelled.length = 0;
    overlap = { schedule: 0, room: 0, maxSchedule: 0, maxBoth: 0 };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const resolve of release.values()) resolve();
    await Promise.allSettled(services.splice(0).map((svc) => svc.shutdown()));
  });

  it('runs a scheduled job in a fresh session: no lookup, no resume, no bind, no session row, the room session untouched', async () => {
    const svc = service();
    // The room has a stored session with a provider session id.
    const roomJob = await svc.submitFromUi({ provider: 'claude', requestId: 'room-1', prompt: 'hello' });
    await until(async () => await status(roomJob.jobId) === 'completed');
    const before = await sessionRows();
    expect(before).toEqual([expect.objectContaining({ provider: 'claude', source_type: 'ui', external_session_id: expect.stringMatching(/^session-/) })]);

    const lookup = vi.spyOn(agents, 'lookupSession');
    const bind = vi.spyOn(agents, 'bindSession');
    const reset = vi.spyOn(agents, 'resetGeneration');
    const validate = vi.spyOn(agents, 'validateResumeSession');
    const job = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] 早報' });
    expect(job.disposition).toBe('inserted');
    await until(async () => await status(job.jobId) === 'completed');
    const request = requests.find((item) => item.jobId === job.jobId)!;
    expect(request.source).toEqual({ type: 'schedule', requestId: slot(1) });
    expect(request.resumeSessionId).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(await sessionRows()).toEqual(before);
    // A second run is again a brand-new session (nothing was stored to resume).
    const second = await svc.submitScheduled({ provider: 'claude', requestId: slot(2), prompt: '[排程] 晚報' });
    await until(async () => await status(second.jobId) === 'completed');
    expect(requests.find((item) => item.jobId === second.jobId)!.resumeSessionId).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    // Submitting the same slot again is a duplicate and runs nothing more.
    expect((await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: 'again' })).disposition).toBe('duplicate');
    await svc.idle();
    expect(requests.filter((item) => item.source.type === 'schedule')).toHaveLength(2);
  });

  it('injects the identity block and the hidden schedule context, with the schedule output channel and no room history hint', async () => {
    const context = vi.fn(async () => '【排程規則】hidden machine rules');
    const launcher: InternalMcpLauncher = {
      mint: () => ({ endpoint: 'http://127.0.0.1:1/mcp', token: `li_job_${'a'.repeat(43)}` }),
      release: () => undefined,
      skill: async () => '# skill',
      scheduleContext: context,
    };
    const svc = service(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, launcher);
    const sharesHistory = vi.spyOn(agents, 'sharesAgentRoomHistory');
    const identity = vi.spyOn(agents, 'describeJobIdentity');
    const job = await svc.submitScheduled({ provider: 'claude', requestId: slot(3), prompt: '[排程] 早報\n任務：自訂' });
    await until(async () => await status(job.jobId) === 'completed');
    const request = requests.find((item) => item.jobId === job.jobId)!;
    expect(context).toHaveBeenCalledWith(slot(3));
    expect(request.prompt).toContain('# skill');
    expect(request.prompt).toContain('輸出位置：排程紀錄與 LINE');
    expect(request.prompt).toContain('[排程] 早報\n任務：自訂\n\n【排程規則】hidden machine rules');
    expect(request.prompt).toContain('【身分】');
    expect(request.prompt).not.toContain('query_agent_room_history');
    expect(sharesHistory).not.toHaveBeenCalled();
    expect(identity).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'schedule', accountId: null }));
    // The stored job prompt stays the short card.
    expect((await agents.getJob(job.jobId))!.prompt).toBe('[排程] 早報\n任務：自訂');
    expect(request.mcp).toBeDefined();
  });

  it('has its own slot: a running scheduled run never blocks a room job and the room never blocks it, even with one global slot', async () => {
    hold.add('schedule');
    const svc = service(undefined, undefined, 1);
    const run = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] a' });
    await until(() => running.has(run.jobId));
    const roomJob = await svc.submitFromUi({ provider: 'claude', requestId: 'room-a', prompt: 'room' });
    await until(async () => await status(roomJob.jobId) === 'completed');
    expect(await status(run.jobId)).toBe('running');
    expect(overlap.maxBoth).toBe(2);
    release.get(run.jobId)?.();
    await until(async () => await status(run.jobId) === 'completed');

    // And the other way round: a room job holding the only global slot does not delay a scheduled run.
    hold.clear(); hold.add('room');
    const blocker = await svc.submitFromUi({ provider: 'claude', requestId: 'room-b', prompt: 'long room' });
    await until(() => running.has(blocker.jobId));
    const next = await svc.submitScheduled({ provider: 'claude', requestId: slot(2), prompt: '[排程] b' });
    await until(async () => await status(next.jobId) === 'completed');
    expect(await status(blocker.jobId)).toBe('running');
    release.get(blocker.jobId)?.();
    await until(async () => await status(blocker.jobId) === 'completed');
  });

  it('runs at most one scheduled run at a time and queues the next behind it', async () => {
    hold.add('schedule');
    const svc = service();
    const first = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] a' });
    const second = await svc.submitScheduled({ provider: 'claude', requestId: slot(2), prompt: '[排程] b' });
    await until(() => running.has(first.jobId));
    await tick(); await tick();
    expect(await status(second.jobId)).toBe('queued');
    expect(overlap.maxSchedule).toBe(1);
    hold.clear();
    release.get(first.jobId)?.();
    await until(async () => await status(second.jobId) === 'completed');
    expect(overlap.maxSchedule).toBe(1);
  });

  it('recovers queued scheduled runs, with recoverQueued alone', async () => {
    const queued = await scheduled(1);
    const roomQueued = await agents.enqueueUiJob({ provider: 'claude', requestId: 'room-q', prompt: 'q', workspacePath: WORKSPACE });
    const svc = service();
    await svc.recoverQueued();
    await until(async () => await status(queued.jobId) === 'completed' && await status(roomQueued.jobId) === 'completed');
    expect(requests.filter((item) => item.source.type === 'schedule')).toHaveLength(1);
  });

  it('stops, retries and reads events of a scheduled run through the schedule key only', async () => {
    hold.add('schedule');
    const svc = service();
    const run = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] a' });
    await until(() => running.has(run.jobId));
    expect(await svc.stopJob(AGENT_ROOM_KEY, run.jobId)).toBe(false);
    expect(await status(run.jobId)).toBe('running');
    expect(await svc.stopJob(AGENT_SCHEDULE_QUEUE_KEY, run.jobId)).toBe(true);
    expect(cancelled).toContain(run.jobId);
    expect(await status(run.jobId)).toBe('cancelled');
    expect(await svc.getRoomJobEvents(run.jobId)).toEqual([]);

    hold.clear();
    await pool.query("UPDATE agent_jobs SET status = 'failed' WHERE job_id = $1", [run.jobId]);
    expect(await svc.retryJob(AGENT_ROOM_KEY, run.jobId)).toBe(false);
    expect(await svc.retryJob(AGENT_SCHEDULE_QUEUE_KEY, run.jobId)).toBe(true);
    await until(async () => await status(run.jobId) === 'completed');
    expect(await svc.getScheduleJobEvents(run.jobId)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'completed' })]));
    expect(await svc.getRoomJobEvents(run.jobId)).toEqual([]);
  });

  it('cancels a running scheduled run on shutdown and does not start queued ones afterwards', async () => {
    hold.add('schedule');
    const svc = service();
    const first = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] a' });
    const second = await svc.submitScheduled({ provider: 'claude', requestId: slot(2), prompt: '[排程] b' });
    await until(() => running.has(first.jobId));
    await svc.shutdown();
    expect(cancelled).toContain(first.jobId);
    expect(await status(first.jobId)).toBe('cancelled');
    expect(running.has(second.jobId)).toBe(false);
    expect(await status(second.jobId)).toBe('queued');
  });

  it('stopChat on the schedule key cancels the queued and running scheduled runs only', async () => {
    hold.add('schedule');
    const svc = service();
    const first = await svc.submitScheduled({ provider: 'claude', requestId: slot(1), prompt: '[排程] a' });
    const second = await svc.submitScheduled({ provider: 'claude', requestId: slot(2), prompt: '[排程] b' });
    const roomQueued = await agents.enqueueUiJob({ provider: 'claude', requestId: 'room-keep', prompt: 'keep', workspacePath: WORKSPACE });
    await until(() => running.has(first.jobId));
    await svc.stopChat(AGENT_SCHEDULE_QUEUE_KEY);
    expect(await status(first.jobId)).toBe('cancelled');
    expect(await status(second.jobId)).toBe('cancelled');
    expect(await status(roomQueued.jobId)).not.toBe('cancelled');
  });
});
