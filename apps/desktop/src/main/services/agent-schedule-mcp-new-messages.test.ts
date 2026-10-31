import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AgentScheduleCreateInputSchema, CreateScheduleToolInputSchema, scheduleExecutionKind, scheduleMayUseLlm, type AgentSchedule } from '@line-agent/contracts';
import { AgentScheduleRepository, allPermissions, type MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentScheduleService } from './agent-schedule-service.js';
import {
  CREATE_SCHEDULE_TOOL_DEFINITION, LIST_SCHEDULES_TOOL_DEFINITION, McpService, UPDATE_SCHEDULE_TOOL_DEFINITION, type AgentScheduleToolHandler,
} from './mcp-service.js';
import { MCP_SKILL_MAX_BYTES } from './mcp-skill.js';

type Rpc = (method: string, params?: unknown) => Promise<{ httpStatus: number; body: Record<string, unknown> | null }>;
const resultOf = (response: Awaited<ReturnType<Rpc>>) =>
  (response.body as { result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } }).result;
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const recurrence = { kind: 'daily', time: '09:00' } as const;
const rule = { when: { metric: 'chat.messageCount', op: '>', value: 20 }, then: 'llm' } as const;

function schedule(task: AgentSchedule['task'], extra: Partial<AgentSchedule> = {}): AgentSchedule {
  return { scheduleId: SCHEDULE_ID, title: 't', prompt: '', provider: 'codex', recurrence, timezone: 'Asia/Taipei', targets: [], task, window: { mode: 'since_last_run' },
    delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 0, execution: scheduleExecutionKind(task), mayUseLlm: scheduleMayUseLlm(task),
    nextFireAt: '2026-10-02T01:00:00.000Z', lastFireAt: null, lastOutcome: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra };
}

function harness(handlerOverride?: Partial<AgentScheduleToolHandler>) {
  const handler = {
    list: vi.fn(async () => [schedule({ type: 'custom' }, { prompt: 'p' }), schedule({ type: 'message', text: 'x' }, { scheduleId: '33333333-3333-4333-8333-333333333333' }),
      schedule({ type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false, rules: [rule] }, { scheduleId: '44444444-4444-4444-8444-444444444444' })]),
    create: vi.fn(async (input: { task: AgentSchedule['task'] }) => schedule(input.task)),
    update: vi.fn(async (_id: string, patch: { task?: AgentSchedule['task'] }) => schedule(patch.task ?? { type: 'custom' })),
    delete: vi.fn(async () => true),
    primaryAdminChat: vi.fn(async () => ({ accountId: 'acc', chatId: 'uadmin', title: '徐佳誠' })),
    ...handlerOverride,
  } satisfies AgentScheduleToolHandler;
  const tokens = {
    verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend: true }),
    executeForInternalAgent: async (input: { execute: (context: unknown) => Promise<{ data: unknown }> }) => {
      const client = { query: async () => ({ rows: [{ source_type: 'ui', source_request_id: null, provider: 'codex' }] }) };
      return (await input.execute({ client, principalId: 'internal:ui' })).data;
    },
    recordAudit: async () => undefined,
  } as never;
  const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, now: () => new Date('2026-10-28T00:00:00.000Z'), schedules: handler });
  const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: null, endpointInstance: 'instance' });
  const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
  return { service, handler, call: (name: string, args: unknown) => rpc('tools/call', { name, arguments: args }) };
}

describe('new_messages through the schedule tools', () => {
  it('creates a new_messages schedule with defaults applied, no prompt and no targets', async () => {
    const h = harness();
    const task = { type: 'new_messages', messageFilter: { metric: 'message.direction', op: '==', value: 'inbound' }, rules: [{ when: { metric: 'chat.id', op: 'in', value: ['a', 'b'] }, then: 'skip' }, rule] };
    const response = resultOf(await h.call('create_schedule', { title: '新訊息', recurrence, task }));
    expect(response.isError).toBe(false);
    expect(h.handler.create).toHaveBeenCalledWith({ title: '新訊息', prompt: '', recurrence, provider: 'codex', timezone: 'Asia/Taipei', targets: [],
      task: { ...task, maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 0 });
    expect(response.structuredContent).toMatchObject({ toolName: 'create_schedule', schedule: { execution: 'program', mayUseLlm: true }, deliveryLabel: '管理員（徐佳誠）' });
    await h.service.shutdown();
  });

  it('accepts targets and a line_target delivery, and rejects record_only', async () => {
    const h = harness();
    const group = { accountId: 'acc', chatType: 'group', chatId: 'g1', title: 'Team' };
    expect(resultOf(await h.call('create_schedule', { title: 't', recurrence, task: { type: 'new_messages' }, targets: [group], delivery: { mode: 'line_target', target: group } })).isError).toBe(false);
    expect(h.handler.create).toHaveBeenLastCalledWith(expect.objectContaining({ targets: [group], delivery: { mode: 'line_target', target: group } }));
    (h.handler.create as unknown as { mockClear(): void }).mockClear();
    const bad = resultOf(await h.call('create_schedule', { title: 't', recurrence, task: { type: 'new_messages' }, delivery: { mode: 'record_only' } }));
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('INVALID_INPUT');
    expect(h.handler.create).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('answers an invalid rule with the existing invalid-input error and creates nothing', async () => {
    const h = harness();
    const invalid = async (task: unknown) => {
      const result = resultOf(await h.call('create_schedule', { title: 't', recurrence, task }));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.any(String) } });
    };
    await invalid({ type: 'new_messages', rules: [{ when: { metric: 'message.kind', op: '==', value: 'text' }, then: 'llm' }] });
    await invalid({ type: 'new_messages', messageFilter: { metric: 'chat.messageCount', op: '>', value: 1 } });
    await invalid({ type: 'new_messages', rules: [{ when: { metric: 'chat.messageCount', op: 'contains', value: 1 }, then: 'llm' }] });
    await invalid({ type: 'new_messages', rules: [{ when: { metric: 'chat.messageCount', op: '>', value: 1 }, then: 'delete' }] });
    await invalid({ type: 'new_messages', rules: Array.from({ length: 21 }, () => rule) });
    await invalid({ type: 'new_messages', rules: [{ when: { metric: 'chat.messageCount', op: '>', value: -1 }, then: 'llm' }] });
    await invalid({ type: 'new_messages', rules: [{ when: { any: [{ all: [{ any: [rule.when] }] }] }, then: 'llm' }] });
    await invalid({ type: 'new_messages', maxMessagesPerChat: 500 });
    await invalid({ type: 'new_messages', sql: 'DROP TABLE messages' });
    expect(h.handler.create).not.toHaveBeenCalled();
    const update = resultOf(await h.call('update_schedule', { scheduleId: SCHEDULE_ID, task: { type: 'new_messages', rules: [{ when: { metric: 'bogus', op: '>', value: 1 }, then: 'llm' }] } }));
    expect(update.isError).toBe(true);
    expect(h.handler.update).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('updates the task of a schedule to new_messages', async () => {
    const h = harness();
    const response = resultOf(await h.call('update_schedule', { scheduleId: SCHEDULE_ID, task: { type: 'new_messages', rules: [rule] } }));
    expect(response.isError).toBe(false);
    expect(h.handler.update).toHaveBeenCalledWith(SCHEDULE_ID, { task: { type: 'new_messages', rules: [rule], maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false } });
    expect(response.structuredContent).toMatchObject({ schedule: { execution: 'program', mayUseLlm: true } });
    await h.service.shutdown();
  });

  it('lists execution and mayUseLlm of every schedule', async () => {
    const h = harness();
    const listed = (resultOf(await h.call('list_schedules', { status: 'all' })).structuredContent as { schedules: Array<{ task: { type: string }; execution: string; mayUseLlm: boolean }> }).schedules;
    expect(listed.map((s) => [s.task.type, s.execution, s.mayUseLlm])).toEqual([['custom', 'agent', true], ['message', 'program', false], ['new_messages', 'program', true]]);
    await h.service.shutdown();
  });

  it('describes the two kinds, the new_messages rules and the llm rule in the tool definitions', () => {
    const description = CREATE_SCHEDULE_TOOL_DEFINITION.description;
    for (const needle of ['two kinds', 'Program: message', 'new_messages', 'uses no LLM', 'then="llm"', 'Agent: custom, summary, keyword_digest', 'must use new_messages, not custom', 'too many messages means summarize']) {
      expect(description).toContain(needle);
    }
    expect(LIST_SCHEDULES_TOOL_DEFINITION.description).toContain('execution');
    expect(LIST_SCHEDULES_TOOL_DEFINITION.description).toContain('mayUseLlm');
    for (const definition of [CREATE_SCHEDULE_TOOL_DEFINITION, UPDATE_SCHEDULE_TOOL_DEFINITION]) {
      const task = (definition.inputSchema.properties as unknown as { task: { description: string; oneOf: Array<{ properties: Record<string, unknown> }> } }).task;
      for (const needle of ['new_messages', 'chat.messageCount', 'run.listedChars', 'chat.keywordHits', 'message.textContains', 'chat.id', 'chat.type', 'at most 20', 'at most 50 leaves', 'then is list', 'Example:']) {
        expect(task.description).toContain(needle);
      }
      const variant = task.oneOf.find((option) => 'type' in option.properties && JSON.stringify(option.properties.type) === '{"const":"new_messages"}')!;
      expect(Object.keys(variant.properties).sort()).toEqual(['maxMessagesPerChat', 'maxTextChars', 'messageFilter', 'rules', 'sendWhenEmpty', 'type']);
    }
  });

  it('keeps the example of the tool description valid for the schema', () => {
    const example = { type: 'new_messages', messageFilter: { metric: 'message.direction', op: '==', value: 'inbound' }, rules: [
      { when: { metric: 'chat.id', op: '==', value: 'c1' }, then: 'skip' },
      { when: { any: [{ metric: 'chat.messageCount', op: '>', value: 20 }, { metric: 'run.listedChars', op: '>', value: 2000 }] }, then: 'llm' }] };
    expect(CreateScheduleToolInputSchema.safeParse({ title: 't', recurrence, task: example }).success).toBe(true);
    expect(AgentScheduleCreateInputSchema.safeParse({ title: 't', provider: 'claude', recurrence, task: example }).success).toBe(true);
  });

  it('puts the same guidance in Traditional Chinese into the MCP skill and keeps it under the size limit', async () => {
    const skill = await readFile(fileURLToPath(new URL('../../../../../skills/linejs-mcp/SKILL.md', import.meta.url)), 'utf8');
    expect(Buffer.byteLength(skill, 'utf8')).toBeLessThan(MCP_SKILL_MAX_BYTES);
    for (const needle of ['程式排程與 Agent 排程', '`execution`', '`mayUseLlm`', '`new_messages`', '不要用 `custom`', '`then: "llm"`', '`messageFilter`', '`chat.keywordHits`', '`run.listedChars`']) {
      expect(skill).toContain(needle);
    }
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('new_messages through the schedule tools with the real service and repository', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close(); });

  it('creates, lists and updates a new_messages schedule and returns execution and mayUseLlm from the database row', async () => {
    const service = new AgentScheduleService({ store: new AgentScheduleRepository(pool), submit: vi.fn(async () => ({ jobId: 'j' })) as never, now: () => new Date('2026-10-28T00:00:00.000Z') });
    const h = harness({
      list: () => service.list(), create: (input) => service.create(input), update: (id, patch) => service.update(id, patch), delete: (id) => service.delete(id),
    });
    const created = resultOf(await h.call('create_schedule', { title: '新訊息', recurrence, task: { type: 'new_messages' } }));
    expect(created.isError).toBe(false);
    expect(created.structuredContent).toMatchObject({ schedule: { execution: 'program', mayUseLlm: false, task: { type: 'new_messages', maxMessagesPerChat: 20 } } });
    const id = (created.structuredContent as { schedule: { scheduleId: string } }).schedule.scheduleId;
    const updated = resultOf(await h.call('update_schedule', { scheduleId: id, task: { type: 'new_messages', rules: [rule] } }));
    expect(updated.structuredContent).toMatchObject({ schedule: { execution: 'program', mayUseLlm: true } });
    const listed = (resultOf(await h.call('list_schedules', {})).structuredContent as { schedules: Array<{ scheduleId: string; execution: string; mayUseLlm: boolean }> }).schedules;
    expect(listed.find((s) => s.scheduleId === id)).toMatchObject({ execution: 'program', mayUseLlm: true });
    await service.stop();
    await h.service.shutdown();
  });
});
