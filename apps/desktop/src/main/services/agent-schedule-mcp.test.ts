import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, McpInternalToolNameSchema, McpToolNameSchema, SCHEDULE_TOOL_NAMES } from '@line-agent/contracts';
import { AgentRepository, AgentScheduleRepository, McpDomainError, McpTokenRepository, allPermissions, type MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentScheduleService } from './agent-schedule-service.js';
import { McpService, type AgentScheduleToolHandler } from './mcp-service.js';

type Rpc = (method: string, params?: unknown) => Promise<{ httpStatus: number; body: Record<string, unknown> | null }>;
const toolNames = async (rpc: Rpc) =>
  ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
const resultOf = (response: Awaited<ReturnType<Rpc>>) =>
  (response.body as { result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } }).result;
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const DISABLED_ID = '33333333-3333-4333-8333-333333333333';
const recurrence = { kind: 'daily', time: '09:00' } as const;

function fakeHandler() {
  const schedule = { scheduleId: SCHEDULE_ID, title: 't', prompt: 'p', provider: 'codex' as const, recurrence, timezone: 'Asia/Taipei', targets: [], task: { type: 'custom' as const }, window: { mode: 'since_last_run' as const },
    delivery: { mode: 'primary_admin' as const } as { mode: 'primary_admin' } | { mode: 'record_only' } | { mode: 'line_target'; target: { accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string; title: string } }, enabled: true,
    jitterMinutes: 0, nextFireAt: '2026-10-02T01:00:00.000Z', lastFireAt: null, lastOutcome: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
  return {
    list: vi.fn(async () => [schedule, { ...schedule, scheduleId: DISABLED_ID, enabled: false, nextFireAt: null }]), create: vi.fn(async (input: { delivery?: unknown } = {}) => ({ ...schedule, ...(input.delivery ? { delivery: input.delivery } : {}) }) as typeof schedule),
    update: vi.fn(async () => schedule), delete: vi.fn(async () => true),
    primaryAdminChat: vi.fn(async () => ({ accountId: 'acc', chatId: 'uadmin', title: '徐佳誠' })),
  } satisfies AgentScheduleToolHandler;
}

describe('schedule tools (mocked repository)', () => {
  function harness(options: { lineSend?: boolean; sourceRequestId?: string | null; sourceType?: string; provider?: 'codex' | 'claude'; deny?: boolean; withHandler?: boolean } = {}) {
    const handler = fakeHandler();
    const tokens = {
      verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend: options.lineSend ?? true }),
      executeForInternalAgent: async (input: { execute: (context: unknown) => Promise<{ data: unknown }> }) => {
        if (options.deny) throw new McpDomainError('PERMISSION_DENIED', 'no');
        const client = { query: async () => ({ rows: [{ source_type: options.sourceType ?? 'ui', source_request_id: options.sourceRequestId ?? null, provider: options.provider ?? 'codex' }] }) };
        return (await input.execute({ client, principalId: 'internal:ui' })).data;
      },
      recordAudit: async () => undefined,
    } as never;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, now: () => new Date('2026-10-28T00:00:00.000Z'), ...(options.withHandler === false ? {} : { schedules: handler }) });
    const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: null, endpointInstance: 'instance' });
    const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    return { rpc, service, handler, call: (name: string, args: unknown) => rpc('tools/call', { name, arguments: args }) };
  }

  it('lists the schedule tools only for a principal that may use them, and only when the service exists', async () => {
    const allowed = harness();
    expect(await toolNames(allowed.rpc)).toEqual(expect.arrayContaining([...SCHEDULE_TOOL_NAMES]));
    await allowed.service.shutdown();
    const denied = harness({ lineSend: false });
    for (const name of SCHEDULE_TOOL_NAMES) expect(await toolNames(denied.rpc)).not.toContain(name);
    await denied.service.shutdown();
    const absent = harness({ withHandler: false });
    for (const name of SCHEDULE_TOOL_NAMES) expect(await toolNames(absent.rpc)).not.toContain(name);
    await absent.service.shutdown();
  });

  it('passes jitterMinutes through create and update and rejects values outside 0..5', async () => {
    const h = harness();
    expect(resultOf(await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, jitterMinutes: 4 })).isError).toBe(false);
    expect(h.handler.create).toHaveBeenLastCalledWith(expect.objectContaining({ jitterMinutes: 4 }));
    expect(resultOf(await h.call('update_schedule', { scheduleId: SCHEDULE_ID, jitterMinutes: 0 })).isError).toBe(false);
    expect(h.handler.update).toHaveBeenLastCalledWith(SCHEDULE_ID, { jitterMinutes: 0 });
    expect(resultOf(await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, jitterMinutes: 6 })).isError).toBe(true);
    await h.service.shutdown();
  });

  it('lists only active schedules by default and filters by status', async () => {
    const h = harness();
    const ids = async (args: unknown) => (resultOf(await h.call('list_schedules', args)).structuredContent as { schedules: Array<{ scheduleId: string }> }).schedules.map((s) => s.scheduleId);
    expect(await ids({})).toEqual([SCHEDULE_ID]);
    expect(await ids({ status: 'active' })).toEqual([SCHEDULE_ID]);
    expect(await ids({ status: 'disabled' })).toEqual([DISABLED_ID]);
    expect(await ids({ status: 'all' })).toEqual([SCHEDULE_ID, DISABLED_ID]);
    await h.service.shutdown();
  });

  it('creates with the calling job provider as default and returns nextFireAt', async () => {
    const h = harness({ provider: 'codex' });
    const response = await h.call('create_schedule', { title: 't', prompt: 'p', recurrence });
    expect(resultOf(response).isError).toBe(false);
    expect(h.handler.create).toHaveBeenCalledWith({ title: 't', prompt: 'p', recurrence, provider: 'codex', timezone: 'Asia/Taipei', targets: [], task: { type: 'custom' },
      window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 0 });
    expect(resultOf(response).structuredContent).toMatchObject({ toolName: 'create_schedule', schedule: { nextFireAt: '2026-10-02T01:00:00.000Z' } });
    await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, provider: 'claude', timezone: 'UTC', enabled: false });
    expect(h.handler.create).toHaveBeenLastCalledWith({ title: 't', prompt: 'p', recurrence, provider: 'claude', timezone: 'UTC', targets: [], task: { type: 'custom' },
      window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: false, jitterMinutes: 0 });
    await h.service.shutdown();
  });

  it('creates a system message schedule (no targets, no prompt) with the default administrator delivery', async () => {
    const h = harness();
    const response = await h.call('create_schedule', { title: '鬧鐘', recurrence, task: { type: 'message', text: '現在 {{time}}，起床了' } });
    expect(resultOf(response).isError).toBe(false);
    expect(h.handler.create).toHaveBeenCalledWith({ title: '鬧鐘', prompt: '', recurrence, provider: 'codex', timezone: 'Asia/Taipei', targets: [],
      task: { type: 'message', text: '現在 {{time}}，起床了' }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 0 });
    expect(resultOf(response).structuredContent).toMatchObject({ toolName: 'create_schedule', deliveryLabel: '管理員（徐佳誠）' });
    await h.service.shutdown();
  });

  it('rejects record_only for a message, agent_room everywhere and a message that reads chats', async () => {
    const h = harness();
    const text = { type: 'message', text: 'x' };
    const rejected = async (args: unknown) => { const result = resultOf(await h.call('create_schedule', args)); expect(result.isError).toBe(true); return result.content[0]!.text; };
    expect(await rejected({ title: 't', recurrence, task: text, delivery: { mode: 'record_only' } })).toContain('INVALID_INPUT');
    expect(await rejected({ title: 't', prompt: 'p', recurrence, delivery: { mode: 'agent_room' } })).toContain('INVALID_INPUT');
    expect(await rejected({ title: 't', recurrence, task: text, delivery: { mode: 'agent_room' } })).toContain('INVALID_INPUT');
    expect(await rejected({ title: 't', recurrence, task: text, targets: [{ accountId: 'a', chatType: 'group', chatId: 'g', title: 'G' }] })).toContain('INVALID_INPUT');
    const update = resultOf(await h.call('update_schedule', { scheduleId: SCHEDULE_ID, delivery: { mode: 'agent_room' } }));
    expect(update.isError).toBe(true);
    expect(h.handler.create).not.toHaveBeenCalled();
    expect(h.handler.update).not.toHaveBeenCalled();
    // An Agent task may keep its result in the run history only.
    expect(resultOf(await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, delivery: { mode: 'record_only' } })).isError).toBe(false);
    await h.service.shutdown();
  });

  it('lets a schedule-sourced job list schedules but never create, update or delete them', async () => {
    const h = harness({ sourceType: 'schedule', sourceRequestId: `schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z` });
    expect(resultOf(await h.call('list_schedules', {})).isError).toBe(false);
    for (const [name, args] of [['create_schedule', { title: 't', prompt: 'p', recurrence }], ['update_schedule', { scheduleId: SCHEDULE_ID, enabled: false }], ['delete_schedule', { scheduleId: SCHEDULE_ID }]] as const) {
      const result = resultOf(await h.call(name, args));
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('SCHEDULE_RUN_FORBIDDEN');
    }
    expect(h.handler.create).not.toHaveBeenCalled();
    expect(h.handler.update).not.toHaveBeenCalled();
    expect(h.handler.delete).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('passes targets, task, window and delivery through and requires targets for a summary', async () => {
    const h = harness();
    const group = { accountId: 'acc', chatType: 'group', chatId: 'g1', title: 'Team' };
    const response = await h.call('create_schedule', { title: 'Sum', recurrence, task: { type: 'summary', focus: 'bugs' }, targets: [group],
      window: { mode: 'lookback', minutes: 120 }, delivery: { mode: 'line_target', target: group } });
    expect(resultOf(response).isError).toBe(false);
    expect(h.handler.create).toHaveBeenCalledWith({ title: 'Sum', prompt: '', recurrence, provider: 'codex', timezone: 'Asia/Taipei', targets: [group],
      task: { type: 'summary', focus: 'bugs' }, window: { mode: 'lookback', minutes: 120 }, delivery: { mode: 'line_target', target: group }, enabled: true, jitterMinutes: 0 });
    const bad = resultOf(await h.call('create_schedule', { title: 'Sum', recurrence, task: { type: 'summary' } }));
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('INVALID_INPUT');
    await h.service.shutdown();
  });

  it('applies the defaults: summary when chats are given, primary_admin delivery, since last run, Asia/Taipei', async () => {
    const h = harness();
    const community = { accountId: 'acc-2', chatType: 'community', chatId: 'cm-1', title: '開放社群' };
    const response = await h.call('create_schedule', { title: '社群摘要', recurrence, targets: [community] });
    expect(resultOf(response).isError).toBe(false);
    expect(h.handler.create).toHaveBeenCalledWith({ title: '社群摘要', prompt: '', recurrence, provider: 'codex', timezone: 'Asia/Taipei', targets: [community],
      task: { type: 'summary' }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 0 });
    expect(resultOf(response).structuredContent).toMatchObject({ toolName: 'create_schedule', nextFireAtTaipei: '2026-10-02 09:00', deliveryLabel: '管理員（徐佳誠）' });
    await h.service.shutdown();
  });

  it('converts once.inMinutes to once.at from now and keeps once.at as given', async () => {
    const h = harness();
    await h.call('create_schedule', { title: 't', prompt: 'p', recurrence: { kind: 'once', inMinutes: 5 } });
    expect(h.handler.create).toHaveBeenLastCalledWith(expect.objectContaining({ recurrence: { kind: 'once', at: '2026-10-28T00:05:00.000Z' } }));
    await h.call('create_schedule', { title: 't', prompt: 'p', recurrence: { kind: 'once', at: '2026-11-01T00:00:00.000Z' } });
    expect(h.handler.create).toHaveBeenLastCalledWith(expect.objectContaining({ recurrence: { kind: 'once', at: '2026-11-01T00:00:00.000Z' } }));
    await h.call('update_schedule', { scheduleId: SCHEDULE_ID, recurrence: { kind: 'once', inMinutes: 60 } });
    expect(h.handler.update).toHaveBeenLastCalledWith(SCHEDULE_ID, { recurrence: { kind: 'once', at: '2026-10-28T01:00:00.000Z' } });
    const bad = resultOf(await h.call('create_schedule', { title: 't', prompt: 'p', recurrence: { kind: 'once', inMinutes: 10_081 } }));
    expect(bad.isError).toBe(true);
    await h.service.shutdown();
  });

  it('labels an explicit chat delivery with the chat title', async () => {
    const h = harness();
    const target = { accountId: 'acc', chatType: 'group', chatId: 'g1', title: '專案群' };
    const response = await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, delivery: { mode: 'line_target', target } });
    expect(resultOf(response).structuredContent).toMatchObject({ deliveryLabel: '專案群' });
    const community = resultOf(await h.call('create_schedule', { title: 't', prompt: 'p', recurrence, delivery: { mode: 'line_target', target: { ...target, chatType: 'community' } } }));
    expect(community.isError).toBe(true);
    await h.service.shutdown();
  });

  it('rejects invalid input without touching the handler', async () => {
    const h = harness();
    for (const [name, args] of [
      ['create_schedule', { title: 't', prompt: 'p', recurrence: { kind: 'interval', everyMinutes: 1, anchorAt: '2026-10-01T00:00:00Z' } }],
      ['update_schedule', { scheduleId: SCHEDULE_ID }], ['delete_schedule', { scheduleId: 'nope' }], ['list_schedules', { extra: 1 }], ['list_schedules', { status: 'bogus' }],
    ] as const) {
      const result = resultOf(await h.call(name, args));
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toContain('INVALID_INPUT');
    }
    expect(h.handler.create).not.toHaveBeenCalled();
    expect(h.handler.update).not.toHaveBeenCalled();
    expect(h.handler.delete).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('forbids a job started by a schedule from creating, updating or deleting, but lets it list', async () => {
    const h = harness({ sourceRequestId: `schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z` });
    for (const [name, args] of [
      ['create_schedule', { title: 't', prompt: 'p', recurrence }], ['update_schedule', { scheduleId: SCHEDULE_ID, enabled: false }],
      ['delete_schedule', { scheduleId: SCHEDULE_ID }],
    ] as const) {
      const result = resultOf(await h.call(name, args));
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toContain('SCHEDULE_RUN_FORBIDDEN');
    }
    expect(h.handler.create).not.toHaveBeenCalled();
    expect(h.handler.update).not.toHaveBeenCalled();
    expect(h.handler.delete).not.toHaveBeenCalled();
    expect(resultOf(await h.call('list_schedules', {})).isError).toBe(false);
    await h.service.shutdown();
  });

  it('answers schedule_not_permitted when the repository denies the principal', async () => {
    const h = harness({ deny: true });
    for (const name of SCHEDULE_TOOL_NAMES) {
      const result = resultOf(await h.call(name, { scheduleId: SCHEDULE_ID }));
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('schedule_not_permitted');
    }
    expect(h.handler.list).not.toHaveBeenCalled();
    expect(h.handler.create).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('keeps the schedule tools off the external endpoint', async () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(McpToolNameSchema.safeParse(name).success).toBe(false);
      expect(McpInternalToolNameSchema.safeParse(name).success).toBe(true);
    }
    const handler = fakeHandler();
    const tokens = {
      executeWithVerifiedToken: async (input: { execute: (context: unknown) => Promise<{ data: unknown }> }) =>
        (await input.execute({ toolScopes: ['list_targets', 'query_target_messages'] })).data,
    } as never;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, schedules: handler });
    const listed = await service.handleExternalJsonRpc('la_mcp_x', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.stringify(listed.body)).not.toContain('_schedule');
    for (const name of SCHEDULE_TOOL_NAMES) {
      const called = await service.handleExternalJsonRpc('la_mcp_x', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
      expect(called.httpStatus).toBe(400);
      expect(JSON.stringify(called.body)).toContain('Unsupported MCP tool');
    }
    expect(handler.list).not.toHaveBeenCalled();
    await service.shutdown();
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('schedule tools end to end (real database)', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let root: string;
  let workspace: string;
  let agents: AgentRepository;
  let schedules: AgentScheduleService;
  let service: McpService;

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'line-schedule-e2e-')));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    agents = new AgentRepository(pool);
    schedules = new AgentScheduleService({ store: new AgentScheduleRepository(pool), submit: async () => ({ jobId: randomUUID() }) });
    service = new McpService({ pool, tokens: new McpTokenRepository(pool), messages: {} as MessageRepository, schedules });
  });
  afterAll(async () => {
    await service.shutdown();
    await schedules.stop();
    await closeDatabase?.();
    await rm(root, { recursive: true, force: true });
  });

  async function uiJob(requestId: string) {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
    const { jobId } = await agents.enqueueUiJob({ provider: 'claude', requestId, prompt: 'p', workspacePath: workspace });
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBe(jobId);
    return claimed!;
  }
  const open = (job: { jobId: string; generation: number; accountId: string | null }) => {
    const { token } = service.internalCapabilities.mint({ jobId: job.jobId, generation: job.generation, accountId: job.accountId, endpointInstance: 'instance' });
    const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    return { rpc, call: (name: string, args: unknown) => rpc('tools/call', { name, arguments: args }) };
  };

  it('lets the Agent room manage schedules and audits each call', async () => {
    const { rpc, call } = open(await uiJob(randomUUID()));
    expect(await toolNames(rpc)).toEqual(expect.arrayContaining([...SCHEDULE_TOOL_NAMES]));
    const created = resultOf(await call('create_schedule', { title: 'Morning', prompt: 'Summarize', recurrence }));
    expect(created.isError).toBe(false);
    const schedule = (created.structuredContent as { schedule: { scheduleId: string; provider: string; nextFireAt: string } }).schedule;
    expect(schedule.provider).toBe('claude');
    expect(schedule.nextFireAt).toMatch(/Z$/);
    const updated = resultOf(await call('update_schedule', { scheduleId: schedule.scheduleId, enabled: false }));
    expect(updated.structuredContent).toMatchObject({ schedule: { enabled: false, nextFireAt: null } });
    const listed = async (args: unknown) => (resultOf(await call('list_schedules', args)).structuredContent as { schedules: unknown[] }).schedules;
    expect(await listed({})).toHaveLength(0);
    expect(await listed({ status: 'disabled' })).toHaveLength(1);
    expect(await listed({ status: 'all' })).toHaveLength(1);
    expect(resultOf(await call('delete_schedule', { scheduleId: schedule.scheduleId })).structuredContent).toMatchObject({ deleted: true });
    expect(resultOf(await call('delete_schedule', { scheduleId: schedule.scheduleId })).content[0]!.text).toContain('SCHEDULE_NOT_FOUND');
    const audited = await pool.query("SELECT tool_name, action FROM mcp_agent_audit WHERE tool_name LIKE '%_schedule%' ORDER BY audit_id");
    expect(audited.rows.length).toBeGreaterThanOrEqual(5);
    expect(audited.rows.every((row: { action: string }) => row.action === 'TOOL_CALLED')).toBe(true);
  });

  async function scheduleJob(requestId: string) {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'schedule' AND status IN ('queued', 'running')");
    const { jobId } = await agents.enqueueScheduleJob({ provider: 'claude', requestId, prompt: '[排程] t', workspacePath: workspace });
    const claimed = await agents.claimNext(AGENT_SCHEDULE_QUEUE_KEY);
    expect(claimed?.jobId).toBe(jobId);
    return claimed!;
  }

  it('gives a scheduled run the internal:schedule principal: read and send tools, schedule listing, no room history, no mutation', async () => {
    const job = await scheduleJob(`schedule:${SCHEDULE_ID}:2026-10-02T01:00:00.000Z`);
    const { rpc, call } = open(job);
    const names = await toolNames(rpc);
    expect(names).toEqual(expect.arrayContaining(['list_targets', 'query_target_messages_by_time', 'list_schedules']));
    expect(names).not.toContain('query_agent_room_history');
    // The send tools are gated by the same principal check as the schedule tools: the schedule principal passes it, with no room history.
    expect(await new McpTokenRepository(pool).verifyInternalAgentAccess({ context: { sourceType: 'job', jobId: job.jobId, generation: job.generation, accountId: null } }))
      .toMatchObject({ lineSend: true, roomHistory: false });
    expect(resultOf(await call('list_schedules', {})).isError).toBe(false);
    const forbidden = resultOf(await call('create_schedule', { title: 'Loop', prompt: 'again', recurrence }));
    expect(forbidden.content[0]!.text).toContain('SCHEDULE_RUN_FORBIDDEN');
    const history = (await call('query_agent_room_history', {})).body as { error?: unknown; result?: { isError: boolean } };
    expect(history.error !== undefined || history.result?.isError === true).toBe(true);
    const principals = await pool.query("SELECT DISTINCT principal_id FROM mcp_agent_audit WHERE tool_name IN ('list_schedules', 'create_schedule') AND action = 'TOOL_CALLED' ORDER BY principal_id");
    expect(principals.rows.map((row: { principal_id: string }) => row.principal_id)).toContain('internal:schedule');
    // The room operator keeps its own principal and the history tool.
    const roomRpc = open(await uiJob(randomUUID())).rpc;
    expect(await toolNames(roomRpc)).toContain('query_agent_room_history');
  });

  it('rejects mutation from a job whose source_request_id was created by a schedule', async () => {
    const job = await uiJob(`schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z`);
    const { call } = open(job);
    const result = resultOf(await call('create_schedule', { title: 'Loop', prompt: 'again', recurrence }));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('SCHEDULE_RUN_FORBIDDEN');
    expect(await schedules.list()).toEqual([]);
    expect(resultOf(await call('list_schedules', {})).isError).toBe(false);
  });

  it('denies a released or unknown job', async () => {
    const job = await uiJob(randomUUID());
    const { call } = open(job);
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE job_id = $1", [job.jobId]);
    const result = resultOf(await call('create_schedule', { title: 'x', prompt: 'y', recurrence }));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('schedule_not_permitted');
    expect(await schedules.list()).toEqual([]);
  });
});
