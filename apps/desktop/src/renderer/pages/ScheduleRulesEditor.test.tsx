// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentScheduleNewMessagesTaskSchema, type AgentSchedule, type AgentSchedulePreviewNewMessagesOutput, type AgentScheduleTarget, type AgentScheduleTargetOption, type IpcEvent,
} from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { Schedules } from './Schedules.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T02:00:00.000Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const target = (chatId: string, title: string, chatType: AgentScheduleTarget['chatType'] = 'group'): AgentScheduleTarget => ({ accountId: 'agent-1', chatType, chatId, title });
const base: AgentSchedule = {
  scheduleId: '11111111-1111-4111-8111-111111111111', title: '晨間提醒', prompt: '整理待辦', provider: 'claude',
  recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [], task: { type: 'custom' }, window: { mode: 'since_last_run' },
  delivery: { mode: 'record_only' }, enabled: true, jitterMinutes: 0, execution: 'agent', mayUseLlm: true, nextFireAt: '2026-10-29T01:00:00.000Z', lastFireAt: '2026-10-28T01:00:00.000Z', lastOutcome: 'submitted',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const leaf = (metric: string, op: string, value: unknown, extra: Record<string, unknown> = {}) => ({ metric, op, value, ...extra });
const program = (id: number, title: string, task: unknown, patch: Partial<AgentSchedule> = {}): AgentSchedule => {
  const parsed = AgentScheduleNewMessagesTaskSchema.parse(task);
  return { ...base, scheduleId: `${id}${id}${id}${id}${id}${id}${id}${id}-1111-4111-8111-111111111111`, title, prompt: '', task: parsed, execution: 'program',
    mayUseLlm: (parsed.rules ?? []).some((rule) => rule.then === 'llm'), delivery: { mode: 'primary_admin' }, ...patch };
};

type Handlers = { schedules?: AgentSchedule[]; targets?: AgentScheduleTargetOption[]; preview?: ReturnType<typeof vi.fn> };
function setup(handlers: Handlers = {}) {
  let listener: ((event: IpcEvent) => void) | null = null;
  const ok = (type: string) => ({ type, requestId: 'r', ok: true, schedule: base });
  const preview = handlers.preview ?? vi.fn(async (): Promise<AgentSchedulePreviewNewMessagesOutput> => ({ from: '2026-10-29T00:00:00.000Z', to: '2026-10-29T01:00:00.000Z', chats: [], messageCount: 0, chatCount: 0, listedChars: 0, incomplete: false }));
  const api = {
    listAgentSchedules: vi.fn(async () => handlers.schedules ?? []),
    listAgentScheduleRuns: vi.fn(async () => []),
    getAgentRoomJobEvents: vi.fn(async () => []),
    listAgentScheduleTargets: vi.fn(async () => handlers.targets ?? []),
    createAgentSchedule: vi.fn(async () => ok('createAgentSchedule')),
    updateAgentSchedule: vi.fn(async () => ok('updateAgentSchedule')),
    deleteAgentSchedule: vi.fn(async () => ({ type: 'deleteAgentSchedule', requestId: 'r', ok: true })),
    previewAgentScheduleNewMessages: preview,
    onEvent: vi.fn((callback: (event: IpcEvent) => void) => { listener = callback; return () => { listener = null; }; }),
  } as unknown as DesktopApi;
  const value: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  renderUi(<LocaleProvider value={value}><Schedules api={api} defaultProvider="claude" headingRef={React.createRef()} onNotice={vi.fn()} /></LocaleProvider>);
  return { api: api as unknown as Record<string, ReturnType<typeof vi.fn>>, emit: (event: IpcEvent) => listener?.(event) };
}
const openNew = async () => { fireEvent.click(await screen.findByRole('button', { name: '新增排程' })); return screen.findByRole('dialog', { name: '新增排程' }); };
const openEditorOf = async (title: string) => { fireEvent.click(await screen.findByRole('button', { name: `編輯「${title}」` })); return screen.findByRole('dialog', { name: '編輯排程' }); };
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
const click = (name: string, scope: HTMLElement | Document = document) => fireEvent.click(within(scope as HTMLElement).getByRole('button', { name }));
const save = () => fireEvent.click(screen.getByRole('button', { name: '儲存' }));
const newMessagesForm = async () => { const dialog = await openNew(); pick('程式排程'); pick('新訊息'); setField('標題', '新訊息彙整'); return dialog; };
const rule = (n: number) => within(screen.getByRole('group', { name: `規則 ${n}` }));
const lastBody = (mock: ReturnType<typeof vi.fn>, argument = 0) => mock.mock.calls.at(-1)![argument] as Record<string, unknown>;

describe('schedule kind', () => {
  it('starts as an Agent schedule with the custom task and filters the task choices by kind', async () => {
    setup();
    await openNew();
    const kind = screen.getByRole('radiogroup', { name: '排程種類' });
    expect(within(kind).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['程式排程', 'Agent 排程']);
    expect(within(kind).getByRole('radio', { name: 'Agent 排程' }).getAttribute('aria-checked')).toBe('true');
    const tasks = () => within(screen.getByRole('radiogroup', { name: '任務類型' })).getAllByRole('radio').map((radio) => radio.textContent);
    expect(tasks()).toEqual(['自訂', '總結', '關鍵字摘要']);
    expect(screen.getByRole('radio', { name: '自訂' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('每次執行都會啟動一個 Agent。')).toBeTruthy();
  });

  it('changes the task to the first task of the kind and hints what the kind does', async () => {
    setup();
    await openNew();
    pick('程式排程');
    const tasks = () => within(screen.getByRole('radiogroup', { name: '任務類型' })).getAllByRole('radio').map((radio) => radio.textContent);
    expect(tasks()).toEqual(['系統訊息', '新訊息']);
    expect(screen.getByRole('radio', { name: '系統訊息' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/由系統直接處理，不使用 LLM/)).toBeTruthy();
    pick('新訊息');
    expect(screen.getByRole('radio', { name: '新訊息' }).getAttribute('aria-checked')).toBe('true');
    pick('Agent 排程');
    expect(tasks()).toEqual(['自訂', '總結', '關鍵字摘要']);
    expect(screen.getByRole('radio', { name: '自訂' }).getAttribute('aria-checked')).toBe('true');
  });

  it('takes the kind of a stored schedule from its task', async () => {
    setup({ schedules: [program(2, '彙整', { type: 'new_messages' })] });
    await openEditorOf('彙整');
    expect(screen.getByRole('radio', { name: '程式排程' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '新訊息' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio', { name: '自訂' })).toBeNull();
  });

  it('moves a record-only delivery to the administrator when a program task is chosen, and offers no record-only for it', async () => {
    setup();
    await openNew();
    pick('只保存在排程紀錄');
    expect(screen.getByRole('radio', { name: '只保存在排程紀錄' }).getAttribute('aria-checked')).toBe('true');
    pick('程式排程');
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' }).getAttribute('aria-checked')).toBe('true');
    pick('新訊息');
    expect(screen.queryByRole('radio', { name: '只保存在排程紀錄' })).toBeNull();
    pick('Agent 排程');
    pick('只保存在排程紀錄');
    pick('程式排程'); pick('新訊息');
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('new_messages form', () => {
  it('shows the targets as optional, the time range, no prompt and no assistant until a rule uses the LLM', async () => {
    setup();
    await newMessagesForm();
    expect(screen.getByRole('group', { name: '要讀取的聊天室' })).toBeTruthy();
    expect(screen.getByText('選填：不選則讀取所有可讀的聊天室')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '讀取的時間範圍' })).toBeTruthy();
    expect(screen.queryByLabelText('補充指示（選填）')).toBeNull();
    expect(screen.queryByLabelText('助理')).toBeNull();
    click('新增規則');
    expect(screen.queryByLabelText('助理')).toBeNull();
    within(screen.getByRole('radiogroup', { name: '則' })).getByRole('radio', { name: '略過' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '則' })).getByRole('radio', { name: '交給 LLM 總結' }));
    expect(screen.getByLabelText('補充指示（選填）')).toBeTruthy();
    expect(screen.getByLabelText('助理')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '則' })).getByRole('radio', { name: '列出' }));
    expect(screen.queryByLabelText('補充指示（選填）')).toBeNull();
    expect(screen.queryByLabelText('助理')).toBeNull();
  });

  it('shows the fixed last line and that the first matching rule decides', async () => {
    setup();
    await newMessagesForm();
    expect(screen.getByText('沒有任何規則符合：列出')).toBeTruthy();
    expect(screen.getByText(/第一條符合聊天室的規則決定處理方式/)).toBeTruthy();
    click('新增規則'); click('新增規則');
    expect(screen.getByText('沒有任何規則符合：列出')).toBeTruthy();
    expect(screen.getAllByRole('group', { name: /^規則 \d$/ })).toHaveLength(2);
  });

  it('adds a rule with a group and saves the payload', async () => {
    const { api } = setup();
    await newMessagesForm();
    click('新增規則');
    rule(1).getByLabelText('值');
    fireEvent.change(rule(1).getByLabelText('值'), { target: { value: '5' } });
    click('新增群組', screen.getByRole('group', { name: '規則 1' }));
    const child = within(rule(1).getByRole('group', { name: '群組' }));
    expect(child.queryByRole('button', { name: '新增群組' })).toBeNull();
    fireEvent.change(child.getByLabelText('指標'), { target: { value: 'chat.senderCount' } });
    fireEvent.change(child.getByLabelText('值'), { target: { value: '2' } });
    fireEvent.click(child.getByRole('radio', { name: '任一符合' }));
    fireEvent.click(rule(1).getByRole('radio', { name: '略過' }));
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    const body = lastBody(api.createAgentSchedule!);
    expect(body.task).toEqual({
      type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false,
      rules: [{ when: { all: [leaf('chat.messageCount', '>=', 5), { any: [leaf('chat.senderCount', '>=', 2)] }] }, then: 'skip' }],
    });
    expect(body).toMatchObject({ prompt: '', targets: [], delivery: { mode: 'primary_admin' }, window: { mode: 'since_last_run' } });
  });

  it('saves a message filter, parameters and a chat.id rule picked with the chat search', async () => {
    const { api } = setup({ targets: [target('c1', '客戶群')] });
    await newMessagesForm();
    click('加入訊息過濾');
    fireEvent.change(within(screen.getByRole('group', { name: '訊息過濾' })).getByLabelText('值'), { target: { value: 'outbound' } });
    click('新增規則');
    fireEvent.change(rule(1).getByLabelText('指標'), { target: { value: 'chat.id' } });
    expect(within(rule(1).getByLabelText('運算')).getAllByRole('option').map((option) => option.textContent)).toEqual(['屬於', '不屬於']);
    const picker = rule(1).getByRole('group', { name: '聊天室' });
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: '客戶' } });
    fireEvent.click(await within(picker).findByRole('option', { name: '加入 客戶群' }));
    expect(within(picker).getByText('客戶群')).toBeTruthy();
    fireEvent.change(rule(1).getByLabelText('運算'), { target: { value: 'not_in' } });
    setField('每個聊天室最多列出的訊息數', '50');
    setField('每則訊息最多字數', '300');
    fireEvent.click(screen.getByRole('switch', { name: '沒有新訊息時也傳送' }));
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastBody(api.createAgentSchedule!).task).toEqual({
      type: 'new_messages', maxMessagesPerChat: 50, maxTextChars: 300, sendWhenEmpty: true,
      messageFilter: leaf('message.direction', '==', 'outbound'),
      rules: [{ when: leaf('chat.id', 'not_in', ['c1']), then: 'list' }],
    });
  });

  it('shows a field error for an empty or out-of-range value and does not save', async () => {
    const { api } = setup();
    await newMessagesForm();
    click('新增規則');
    fireEvent.change(rule(1).getByLabelText('值'), { target: { value: '' } });
    setField('每則訊息最多字數', '5');
    save();
    expect(await screen.findByText('請輸入值。')).toBeTruthy();
    expect(screen.getByText('請輸入 20 到 2,000 之間的整數。')).toBeTruthy();
    expect(screen.getByText('請修正訊息過濾與規則中標示的欄位。')).toBeTruthy();
    expect(rule(1).getByLabelText('值').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(rule(1).getByLabelText('值'), { target: { value: '1000000001' } });
    expect(await screen.findByText('請輸入 0 到 1,000,000,000 之間的整數。')).toBeTruthy();
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });

  it('reorders and removes rules with labelled icon buttons', async () => {
    setup();
    await newMessagesForm();
    click('新增規則'); click('新增規則');
    fireEvent.change(rule(1).getByLabelText('值'), { target: { value: '11' } });
    fireEvent.change(rule(2).getByLabelText('值'), { target: { value: '22' } });
    expect((rule(1).getByRole('button', { name: '將規則 1 上移' }) as HTMLButtonElement).disabled).toBe(true);
    expect((rule(2).getByRole('button', { name: '將規則 2 下移' }) as HTMLButtonElement).disabled).toBe(true);
    click('將規則 1 下移');
    expect((rule(1).getByLabelText('值') as HTMLInputElement).value).toBe('22');
    expect((rule(2).getByLabelText('值') as HTMLInputElement).value).toBe('11');
    click('移除規則 1');
    expect(screen.getAllByRole('group', { name: /^規則 \d$/ })).toHaveLength(1);
    expect((rule(1).getByLabelText('值') as HTMLInputElement).value).toBe('11');
  });

  it('disables the add buttons at the limit of 20 rules and at the limit of 50 conditions', async () => {
    setup();
    await newMessagesForm();
    for (let i = 0; i < 20; i++) click('新增規則');
    expect((screen.getByRole('button', { name: '新增規則' }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 19; i >= 1; i--) click(`移除規則 ${i + 1}`);
    expect((screen.getByRole('button', { name: '新增規則' }) as HTMLButtonElement).disabled).toBe(false);
    for (let i = 0; i < 49; i++) click('新增條件', screen.getByRole('group', { name: '規則 1' }));
    expect((screen.getByRole('button', { name: '新增規則' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByRole('group', { name: '規則 1' })).getByRole('button', { name: '新增條件' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByRole('group', { name: '規則 1' })).getByRole('button', { name: '新增群組' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '加入訊息過濾' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the last row of a group and offers all operators of a number metric', async () => {
    setup();
    await newMessagesForm();
    click('新增規則');
    expect((rule(1).getByRole('button', { name: '移除條件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(rule(1).getByLabelText('運算')).getAllByRole('option').map((option) => option.textContent)).toEqual(['>', '≥', '<', '≤', '=', '≠']);
    fireEvent.change(rule(1).getByLabelText('指標'), { target: { value: 'chat.keywordHits' } });
    expect(rule(1).getByLabelText('關鍵字')).toBeTruthy();
    fireEvent.change(rule(1).getByLabelText('指標'), { target: { value: 'chat.type' } });
    expect(within(rule(1).getByLabelText('運算')).getAllByRole('option').map((option) => option.textContent)).toEqual(['是', '不是', '屬於', '不屬於']);
  });
});

describe('editing keeps the stored task', () => {
  const stored = {
    type: 'new_messages',
    messageFilter: { all: [leaf('message.direction', '==', 'inbound'), { any: [leaf('message.kind', 'in', ['text', 'sticker']), leaf('message.textContains', 'any_of', ['請款'])] }] },
    rules: [
      { when: { all: [leaf('chat.messageCount', '>=', 10), { any: [leaf('chat.keywordHits', '>=', 2, { keywords: ['急', '請款'] }), leaf('chat.type', 'in', ['group', 'room'])] }] }, then: 'llm' },
      { when: leaf('chat.id', '==', 'c9'), then: 'skip' },
      { when: leaf('run.chatCount', '>', 30), then: 'list' },
    ],
    maxMessagesPerChat: 50, maxTextChars: 300, sendWhenEmpty: true,
  };

  it('saves a stored new_messages schedule with no change as the same task, never as keyword_digest', async () => {
    const schedule = program(2, '新訊息彙整', stored, { prompt: '請簡短', window: { mode: 'lookback', minutes: 60 }, targets: [target('c9', '九號群')] });
    const { api } = setup({ schedules: [schedule] });
    await openEditorOf('新訊息彙整');
    expect(screen.getByRole('radio', { name: '新訊息' }).getAttribute('aria-checked')).toBe('true');
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule!.mock.calls[0]![0]).toBe(schedule.scheduleId);
    const body = lastBody(api.updateAgentSchedule!, 1);
    expect(body.task).toEqual(schedule.task);
    expect((body.task as { type: string }).type).toBe('new_messages');
    expect(body).toMatchObject({ prompt: '請簡短', provider: 'claude', window: { mode: 'lookback', minutes: 60 }, delivery: { mode: 'primary_admin' }, targets: [target('c9', '九號群')] });
  });

  it('shows the stored rules in the editor: the == chat.id leaf keeps its operator and shows the chat title', async () => {
    const schedule = program(2, '新訊息彙整', stored, { prompt: '請簡短', targets: [target('c9', '九號群')] });
    setup({ schedules: [schedule] });
    await openEditorOf('新訊息彙整');
    expect(rule(2).getByRole('radio', { name: '略過' }).getAttribute('aria-checked')).toBe('true');
    expect((rule(2).getByLabelText('運算') as HTMLSelectElement).value).toBe('==');
    expect(within(rule(2).getByRole('group', { name: '聊天室' })).getByText('九號群')).toBeTruthy();
    expect((screen.getByLabelText('每個聊天室最多列出的訊息數') as HTMLInputElement).value).toBe('50');
    expect(screen.getByRole('switch', { name: '沒有新訊息時也傳送' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('補充指示（選填）') as HTMLTextAreaElement).value).toBe('請簡短');
  });

  it('shows the id of a stored chat with no known title', async () => {
    setup({ schedules: [program(2, '彙整', { type: 'new_messages', rules: [{ when: leaf('chat.id', 'in', ['u123']), then: 'skip' }] })] });
    await openEditorOf('彙整');
    expect(within(rule(1).getByRole('group', { name: '聊天室' })).getByText('u123')).toBeTruthy();
  });

  it('changes one value and saves only that change', async () => {
    const schedule = program(2, '新訊息彙整', stored, { prompt: '請簡短' });
    const { api } = setup({ schedules: [schedule] });
    await openEditorOf('新訊息彙整');
    fireEvent.change(rule(3).getByLabelText('值'), { target: { value: '31' } });
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    const task = lastBody(api.updateAgentSchedule!, 1).task as { rules: Array<{ when: unknown }> };
    expect(task.rules[2]!.when).toEqual(leaf('run.chatCount', '>', 31));
    expect(task.rules.slice(0, 2)).toEqual((schedule.task as { rules: unknown[] }).rules.slice(0, 2));
  });
});

describe('preview', () => {
  const output = (patch: Partial<AgentSchedulePreviewNewMessagesOutput> = {}): AgentSchedulePreviewNewMessagesOutput => ({
    from: '2026-10-29T00:00:00.000Z', to: '2026-10-29T01:00:00.000Z', messageCount: 7, chatCount: 2, listedChars: 1234, incomplete: false,
    chats: [
      { accountId: 'a', chatType: 'group', chatId: 'c1', title: '客戶群', messageCount: 5, senderCount: 2, action: 'list', text: '【客戶群】5 則\n• 09:00 [小明]：你好' },
      { accountId: 'a', chatType: 'direct', chatId: 'c2', title: '小華', messageCount: 2, senderCount: 1, action: 'skip', text: '【小華】2 則' },
    ], ...patch,
  });

  it('is offered for new_messages only', async () => {
    setup();
    await openNew();
    expect(screen.queryByRole('button', { name: '試算' })).toBeNull();
    pick('程式排程');
    expect(screen.queryByRole('button', { name: '試算' })).toBeNull();
    pick('新訊息');
    expect(screen.getByRole('button', { name: '試算' })).toBeTruthy();
    expect(screen.getByText('試算只讀取訊息，不會傳送任何內容，也不會啟動 LLM。')).toBeTruthy();
  });

  it('sends the task, targets, window, recurrence and delivery of the form and shows the result, and never saves', async () => {
    const preview = vi.fn(async (_input: unknown) => output({ incomplete: true }));
    const { api } = setup({ preview, targets: [target('c1', '客戶群')] });
    await newMessagesForm();
    click('新增規則');
    fireEvent.change(rule(1).getByLabelText('值'), { target: { value: '3' } });
    fireEvent.click(rule(1).getByRole('radio', { name: '略過' }));
    pick('回看一段時間'); setField('回看（分鐘）', '90');
    click('試算');
    await screen.findByText('試算結果');
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![0]).toEqual({
      task: { type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false, rules: [{ when: leaf('chat.messageCount', '>=', 3), then: 'skip' }] },
      targets: [], window: { mode: 'lookback', minutes: 90 }, recurrence: { kind: 'daily', time: '09:00' }, delivery: { mode: 'primary_admin' },
    });
    expect(screen.getByText('時間範圍：10/29 08:00 到 10/29 09:00')).toBeTruthy();
    expect(screen.getByText('訊息 7 則 · 聊天室 2 個 · 列出字數 1,234')).toBeTruthy();
    expect(screen.getByText('讀取在單次執行的訊息上限停止，此結果不完整。')).toBeTruthy();
    expect(screen.getByText('客戶群')).toBeTruthy();
    expect(screen.getByText('5 則 · 列出')).toBeTruthy();
    expect(screen.getByText('2 則 · 略過')).toBeTruthy();
    const details = document.querySelectorAll('.schedule-preview-list details');
    expect(details).toHaveLength(2);
    expect(details[0]!.querySelector('pre')!.textContent).toBe('【客戶群】5 則\n• 09:00 [小明]：你好');
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
    expect(api.updateAgentSchedule).not.toHaveBeenCalled();
  });

  it('leaves out an invalid recurrence and a LINE delivery with no chat', async () => {
    const preview = vi.fn(async (_input: unknown) => output());
    setup({ preview });
    await newMessagesForm();
    pick('Cron');
    setField('Cron 運算式（分 時 日 月 週）', '61 * * * *');
    pick('傳到 LINE 聊天室');
    click('試算');
    await screen.findByText('試算結果');
    const sent = preview.mock.calls[0]![0] as Record<string, unknown>;
    expect('recurrence' in sent).toBe(false);
    expect('delivery' in sent).toBe(false);
    expect(sent.window).toEqual({ mode: 'since_last_run' });
  });

  it('shows the real error message of a failed call', async () => {
    const preview = vi.fn(async (_input: unknown) => { throw new Error('LINE_READ_FAILED: 讀取逾時'); });
    setup({ preview });
    await newMessagesForm();
    click('試算');
    expect(await screen.findByText('試算失敗：LINE_READ_FAILED: 讀取逾時')).toBeTruthy();
    expect((screen.getByRole('button', { name: '試算' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not call the API for an invalid form and shows the errors of the rules', async () => {
    const preview = vi.fn(async (_input: unknown) => output());
    setup({ preview });
    await newMessagesForm();
    setField('每個聊天室最多列出的訊息數', '0');
    click('試算');
    expect(await screen.findByText('請輸入 1 到 200 之間的整數。')).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByText('請輸入標題。')).toBeNull();
  });

  it('disables the button while it runs, drops the result when the form changes and ignores an older response', async () => {
    const pending: Array<(value: AgentSchedulePreviewNewMessagesOutput) => void> = [];
    const preview = vi.fn((_input: unknown) => new Promise<AgentSchedulePreviewNewMessagesOutput>((resolve) => { pending.push(resolve); }));
    setup({ preview });
    await newMessagesForm();
    click('試算');
    const running = screen.getByRole('button', { name: '試算中…' }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    // The form changes while the first request runs: the button is free again and the first answer is stale.
    fireEvent.click(screen.getByRole('switch', { name: '沒有新訊息時也傳送' }));
    expect((screen.getByRole('button', { name: '試算' }) as HTMLButtonElement).disabled).toBe(false);
    click('試算');
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => { pending[0]!(output({ messageCount: 111, chats: [] })); });
    expect(screen.queryByText('試算結果')).toBeNull();
    expect((screen.getByRole('button', { name: '試算中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending[1]!(output({ messageCount: 222 })); });
    expect(await screen.findByText('訊息 222 則 · 聊天室 2 個 · 列出字數 1,234')).toBeTruthy();
    // A change of the form removes the old result.
    fireEvent.click(screen.getByRole('switch', { name: '沒有新訊息時也傳送' }));
    expect(screen.queryByText('試算結果')).toBeNull();
    expect(screen.queryByText('客戶群')).toBeNull();
  });

  it('ignores a response that arrives after the dialog closed', async () => {
    let resolve: (value: AgentSchedulePreviewNewMessagesOutput) => void = () => {};
    const preview = vi.fn((_input: unknown) => new Promise<AgentSchedulePreviewNewMessagesOutput>((r) => { resolve = r; }));
    setup({ preview });
    await newMessagesForm();
    click('試算');
    click('取消');
    await act(async () => { resolve(output()); });
    expect(screen.queryByText('試算結果')).toBeNull();
  });
});

describe('list badges', () => {
  it('badges a program schedule, a program schedule that may use the LLM (with the rule conditions) and an Agent schedule', async () => {
    setup({ schedules: [
      program(2, '只列出', { type: 'new_messages', rules: [{ when: leaf('chat.messageCount', '>', 1), then: 'skip' }] }),
      program(3, '有 LLM', { type: 'new_messages', rules: [
        { when: { all: [leaf('chat.messageCount', '>=', 50), leaf('chat.id', 'in', ['c1'])] }, then: 'llm' }, { when: leaf('chat.senderCount', '>', 3), then: 'skip' },
      ] }, { targets: [target('c1', '客戶群')] }),
      { ...base, scheduleId: '44444444-1111-4111-8111-111111111111', title: '代理' },
      { ...base, scheduleId: '55555555-1111-4111-8111-111111111111', title: '提醒', task: { type: 'message', text: 'hi' }, execution: 'program', mayUseLlm: false, delivery: { mode: 'primary_admin' } },
    ] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    const rows = within(table).getAllByRole('row').slice(1);
    const badges = (row: HTMLElement) => Array.from(row.querySelectorAll('.badge'), (badge) => badge.textContent);
    expect(badges(rows[0]!)).toEqual(['新訊息', '程式排程']);
    expect(badges(rows[1]!)).toEqual(['新訊息', '程式排程', '條件成立時使用 LLM']);
    expect(within(rows[1]!).getByText('符合時交給 LLM：聊天室訊息數 ≥ 50 且 聊天室 屬於 客戶群')).toBeTruthy();
    expect(within(rows[0]!).queryByText(/符合時交給 LLM/)).toBeNull();
    expect(badges(rows[2]!)).toEqual(['自訂', 'Agent 排程']);
    expect(badges(rows[3]!)).toEqual(['系統訊息', '程式排程']);
    expect(rows[1]!.textContent).not.toMatch(/[{}]|metric/);
  });

  it('labels the no_messages outcome', async () => {
    setup({ schedules: [program(2, '空', { type: 'new_messages' }, { lastOutcome: 'no_messages' })] });
    expect(await screen.findByText('沒有新訊息')).toBeTruthy();
  });
});
