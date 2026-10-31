// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSchedule, AgentScheduleRun, AgentScheduleTarget, AgentScheduleTargetOption, IpcEvent, ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { ENGLISH_SCHEDULE_COPY, JAPANESE_SCHEDULE_COPY, KOREAN_SCHEDULE_COPY, TRADITIONAL_CHINESE_SCHEDULE_COPY } from '../../desktop-schedule-copy.js';
import { ENGLISH_DESKTOP_COPY, TRADITIONAL_CHINESE_DESKTOP_COPY } from '../../desktop-copy.js';
import { JAPANESE_DESKTOP_COPY, KOREAN_DESKTOP_COPY } from '../desktop-i18n.js';
import { Schedules } from './Schedules.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T02:00:00.000Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function render(ui: React.ReactNode, locale: 'en' | 'zh-TW' = 'zh-TW') {
  const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  return renderUi(<LocaleProvider value={value}>{ui}</LocaleProvider>);
}

const target = (chatId: string, title: string, chatType: AgentScheduleTarget['chatType'] = 'group'): AgentScheduleTarget => ({ accountId: 'agent-1', chatType, chatId, title });
const base: AgentSchedule = {
  scheduleId: '11111111-1111-4111-8111-111111111111', title: '晨間提醒', prompt: '整理待辦', provider: 'claude',
  recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [], task: { type: 'custom' }, window: { mode: 'since_last_run' },
  delivery: { mode: 'record_only' }, enabled: true, jitterMinutes: 0, execution: 'agent', mayUseLlm: true, nextFireAt: '2026-10-29T01:00:00.000Z', lastFireAt: '2026-10-28T01:00:00.000Z', lastOutcome: 'submitted',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const withId = (n: number, patch: Partial<AgentSchedule>): AgentSchedule => ({ ...base, scheduleId: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`, ...patch });

type Handlers = { events?: unknown[]; schedules?: AgentSchedule[]; runs?: AgentScheduleRun[]; targets?: AgentScheduleTargetOption[]; defaultProvider?: 'codex' | 'claude'; providers?: ProviderStatus[]; create?: unknown; update?: unknown; remove?: unknown };
function setup(handlers: Handlers = {}) {
  let listener: ((event: IpcEvent) => void) | null = null;
  const ok = (type: string) => ({ type, requestId: 'r', ok: true, schedule: base });
  const api = {
    listAgentSchedules: vi.fn(async () => handlers.schedules ?? []),
    listAgentScheduleRuns: vi.fn(async () => handlers.runs ?? []),
    getAgentRoomJobEvents: vi.fn(async () => handlers.events ?? []),
    listAgentScheduleTargets: vi.fn(async () => handlers.targets ?? []),
    createAgentSchedule: vi.fn(async () => handlers.create ?? ok('createAgentSchedule')),
    updateAgentSchedule: vi.fn(async () => handlers.update ?? ok('updateAgentSchedule')),
    deleteAgentSchedule: vi.fn(async () => handlers.remove ?? { type: 'deleteAgentSchedule', requestId: 'r', ok: true }),
    onEvent: vi.fn((callback: (event: IpcEvent) => void) => { listener = callback; return () => { listener = null; }; }),
  } as unknown as DesktopApi;
  const onNotice = vi.fn();
  render(<Schedules api={api} defaultProvider={handlers.defaultProvider ?? 'claude'} {...(handlers.providers ? { providers: handlers.providers } : {})} headingRef={React.createRef()} onNotice={onNotice} />);
  return { api: api as unknown as Record<string, ReturnType<typeof vi.fn>>, onNotice, emit: (event: IpcEvent) => listener?.(event) };
}
const openNew = async () => { fireEvent.click(await screen.findByRole('button', { name: '新增排程' })); return screen.findByRole('dialog', { name: '新增排程' }); };
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
const save = () => fireEvent.click(screen.getByRole('button', { name: '儲存' }));
const openEditorOf = async (title: string) => { fireEvent.click(await screen.findByRole('button', { name: `編輯「${title}」` })); return screen.findByRole('dialog', { name: '編輯排程' }); };
const addChat = async (group: string, query: string, name: string) => {
  const picker = screen.getByRole('group', { name: group });
  fireEvent.change(within(picker).getByRole('combobox'), { target: { value: query } });
  fireEvent.click(await within(picker).findByRole('option', { name: `加入 ${name}` }));
};
const lastCreate = (api: Record<string, ReturnType<typeof vi.fn>>) => api.createAgentSchedule!.mock.calls.at(-1)![0] as Record<string, unknown>;

describe('Schedules list', () => {
  it('shows the empty state', async () => {
    setup();
    expect(await screen.findByText('尚無排程')).toBeTruthy();
    expect(screen.getByText(/排程會在設定的時間自動執行/)).toBeTruthy();
  });

  it('lists name, run time, target and status in four columns', async () => {
    setup({ schedules: [
      base,
      withId(2, { title: '週報', task: { type: 'summary' }, targets: [target('c1', '客戶群'), target('c2', '專案群')], delivery: { mode: 'line_target', target: { ...target('c3', '主管群'), chatType: 'group' } } }),
      withId(3, { title: '排程表', recurrence: { kind: 'cron', expression: '0 9 * * 1-5' }, enabled: false, nextFireAt: null }),
      withId(4, { title: '空白', nextFireAt: null, lastFireAt: null, lastOutcome: null }),
      withId(5, { title: '明年', nextFireAt: '2027-01-05T01:30:00.000Z', timezone: 'Asia/Tokyo' }),
    ] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['名稱', '執行時間', '目標', '狀態']);
    const items = within(table).getAllByRole('row').slice(1);
    expect(items).toHaveLength(5);
    expect(within(items[0]!).getByText('晨間提醒')).toBeTruthy();
    expect(within(items[0]!).getByText('自訂')).toBeTruthy();
    const next = within(items[0]!).getByText('10/29 09:00');
    expect(next.className).not.toContain('past');
    expect(next.getAttribute('title')).toContain('每天 09:00');
    expect(within(items[0]!).getByText('僅保存紀錄')).toBeTruthy();
    expect(within(items[0]!).queryByText('未指定聊天室')).toBeNull();
    expect(within(items[0]!).queryByRole('switch')).toBeNull();
    expect(within(items[1]!).getByText('總結')).toBeTruthy();
    expect(within(items[1]!).getByText('主管群')).toBeTruthy();
    const past = within(items[2]!).getByText('10/28 09:00');
    expect(past.className).toContain('schedule-time-past');
    const disabledStatus = within(items[2]!).getByText('已停用');
    expect(disabledStatus.closest('td')?.className).toContain('schedule-status');
    expect(items[2]!.querySelector('.schedule-title-line')?.textContent).not.toContain('已停用');
    expect(items[2]!.className).toContain('disabled');
    expect(within(items[0]!).getByText('已執行').closest('td')?.getAttribute('title')).toBe('已執行 · 2026-10-28 09:00');
    expect(within(items[3]!).getByText('等待執行')).toBeTruthy();
    expect(within(items[3]!).getByText('—')).toBeTruthy();
    expect(within(items[4]!).getByText('2027/01/05 10:30 (Asia/Tokyo)')).toBeTruthy();
  });

  it('colours the status dot by outcome and shows every outcome label', async () => {
    setup({ schedules: [
      withId(2, { title: 'A', lastOutcome: 'sent' }), withId(3, { title: 'B', lastOutcome: 'failed' }), withId(4, { title: 'C', lastOutcome: 'send_unknown' }),
      withId(5, { title: 'D', lastOutcome: 'skipped_overlap' }), withId(6, { title: 'E', lastOutcome: 'send_failed' }),
    ] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    const cells = within(table).getAllByRole('row').slice(1).map((row) => row.querySelector('.schedule-status')!);
    expect(cells.map((cell) => cell.querySelector('.status-dot')?.className.replace('status-dot', '').trim())).toEqual(['ready', 'stopped', '', '', 'stopped']);
    expect(cells.map((cell) => cell.textContent)).toEqual(['已傳送', '失敗', '結果不明', '上一次未結束，已略過', '傳送失敗']);
  });

  it('sets the column widths on a colgroup', async () => {
    setup({ schedules: [base] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    const cols = Array.from(table.querySelectorAll('colgroup > col'), (col) => (col as HTMLElement).style.width);
    expect(cols).toEqual(['', '96px', '120px', '96px']);
  });

  it('shows the administrator as the target of a community schedule', async () => {
    setup({ schedules: [withId(2, { title: '社群', delivery: { mode: 'primary_admin' }, task: { type: 'summary' }, targets: [target('cm1', '開放社群', 'community')] })] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText('管理員')).toBeTruthy();
    expect(within(row).getByText('社群')).toBeTruthy();
  });

  it('opens the editor from the row and from the title button', async () => {
    setup({ schedules: [base] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    fireEvent.click(within(table).getByText('10/29 09:00'));
    const dialog = await screen.findByRole('dialog', { name: '編輯排程' });
    expect((within(dialog).getByLabelText('標題') as HTMLInputElement).value).toBe('晨間提醒');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '編輯「晨間提醒」' }));
    expect(await screen.findByRole('dialog', { name: '編輯排程' })).toBeTruthy();
  });

  it('shows the recent runs inside the editor, and 尚未執行 when there are none', async () => {
    const { api } = setup({ schedules: [base] });
    const dialog = await openEditorOf('晨間提醒');
    expect(await within(dialog).findByText('尚未執行')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: '最近執行' })).toBeTruthy();
    expect(api.listAgentScheduleRuns).toHaveBeenCalledWith(base.scheduleId, 5);
    expect(within(dialog).queryByRole('button', { name: /執行紀錄/ })).toBeNull();
  });

  it('turns a schedule off from the editor through the switch', async () => {
    const { api } = setup({ schedules: [base] });
    const dialog = await openEditorOf('晨間提醒');
    const enabled = within(dialog).getByRole('switch', { name: '啟用' });
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(enabled);
    expect(enabled.getAttribute('aria-checked')).toBe('false');
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule).toHaveBeenCalledWith(base.scheduleId, expect.objectContaining({ enabled: false }));
  });

  it('confirms before deleting from the editor', async () => {
    const { api } = setup({ schedules: [base] });
    const editor = await openEditorOf('晨間提醒');
    fireEvent.click(within(editor).getByRole('button', { name: '刪除「晨間提醒」' }));
    const dialog = await screen.findByRole('alertdialog', { name: '刪除這個排程？' });
    expect(api.deleteAgentSchedule).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.deleteAgentSchedule).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog', { name: '編輯排程' })).getByRole('button', { name: '刪除「晨間提醒」' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '刪除' }));
    await waitFor(() => expect(api.deleteAgentSchedule).toHaveBeenCalledWith(base.scheduleId));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('dialog', { name: '編輯排程' })).toBeNull();
  });

  it('reloads the list when agentSchedulesChanged arrives', async () => {
    const { api, emit } = setup({ schedules: [base] });
    await screen.findByText('晨間提醒');
    expect(api.listAgentSchedules).toHaveBeenCalledTimes(1);
    emit({ type: 'agentSchedulesChanged' } as IpcEvent);
    emit({ type: 'agentSchedulesChanged' } as IpcEvent);
    await waitFor(() => expect(api.listAgentSchedules).toHaveBeenCalledTimes(2));
  });

  it('shows the last runs of an expanded schedule and refreshes them on change', async () => {
    const runs: AgentScheduleRun[] = [
      { runId: '22222222-2222-4222-8222-222222222222', scheduleId: base.scheduleId, scheduledFor: '2026-10-28T01:00:00.000Z', outcome: 'submitted', jobId: 'abcdef1234567890', replyPreview: null, createdAt: '2026-10-28T01:00:01.000Z' },
      { runId: '33333333-3333-4333-8333-333333333333', scheduleId: base.scheduleId, scheduledFor: '2026-10-27T01:00:00.000Z', outcome: 'missed', jobId: null, replyPreview: null, createdAt: '2026-10-27T01:00:01.000Z' },
    ];
    const { api, emit } = setup({ schedules: [base], runs });
    const dialog = await openEditorOf('晨間提醒');
    expect(await within(dialog).findByText('10/28 09:00')).toBeTruthy();
    expect(api.listAgentScheduleRuns).toHaveBeenCalledWith(base.scheduleId, 5);
    expect(within(dialog).getByText('已執行')).toBeTruthy();
    expect(within(dialog).getByText('10/27 09:00')).toBeTruthy();
    expect(within(dialog).getByText('錯過')).toBeTruthy();
    emit({ type: 'agentSchedulesChanged' } as IpcEvent);
    await waitFor(() => expect(api.listAgentScheduleRuns).toHaveBeenCalledTimes(2));
  });
});

describe('Schedules form', () => {
  it('creates a daily custom schedule', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '  每日提醒 ');
    setField('指令', '請整理今天待辦');
    setField('時間', '08:30');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toEqual({
      title: '每日提醒', prompt: '請整理今天待辦', provider: 'claude', recurrence: { kind: 'daily', time: '08:30' }, timezone: 'Asia/Taipei', targets: [],
      task: { type: 'custom' }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 5,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('blocks a custom task without an instruction', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '空白');
    save();
    expect((await screen.findAllByText('自訂任務必須填寫指令。')).length).toBeGreaterThan(0);
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });

  it('separates prompt tasks from targeted tasks in the hints and keeps the chat picker optional for custom', async () => {
    setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    expect(screen.getByText('不指定聊天室，由 Agent 依指令自行查詢')).toBeTruthy();
    expect(screen.getByText('選填：不選則由 Agent 自行決定')).toBeTruthy();
    pick('總結');
    expect(screen.getByText(/^針對指定的聊天室/)).toBeTruthy();
    expect(screen.queryByText('選填：不選則由 Agent 自行決定')).toBeNull();
    pick('關鍵字摘要');
    expect(screen.getByText(/^針對指定的聊天室/)).toBeTruthy();
  });

  it('blocks a summary task without chats and then saves it with a chat and focus', async () => {
    const { api } = setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    setField('標題', '客戶總結');
    pick('總結');
    save();
    expect(await screen.findByText('請至少選擇一個聊天室。')).toBeTruthy();
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
    await addChat('要讀取的聊天室', '客戶', '客戶群');
    expect(screen.getByText('已選 1 / 20 個聊天室')).toBeTruthy();
    setField('總結重點（選填）', '報價');
    pick('每週');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toMatchObject({
      task: { type: 'summary', focus: '報價' }, targets: [target('c1', '客戶群')], prompt: '',
      recurrence: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, window: { mode: 'since_last_run' },
    });
  });

  it('builds keyword digest, lookback window and LINE delivery', async () => {
    const { api } = setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    setField('標題', '關鍵字');
    pick('關鍵字摘要');
    await addChat('要讀取的聊天室', '客戶', '客戶群');
    const keyword = screen.getByLabelText('關鍵字');
    fireEvent.change(keyword, { target: { value: '急件' } });
    fireEvent.keyDown(keyword, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '移除關鍵字 急件' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('關鍵字'), { target: { value: '退款' } });
    pick('回看一段時間');
    setField('回看（分鐘）', '120');
    pick('傳到 LINE 聊天室');
    await addChat('要傳送的 LINE 聊天室', '客戶', '客戶群');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toMatchObject({
      task: { type: 'keyword_digest', keywords: ['急件', '退款'] }, window: { mode: 'lookback', minutes: 120 },
      delivery: { mode: 'line_target', target: target('c1', '客戶群') },
    });
  });

  it('builds once, interval and cron recurrences in the schedule time zone', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '排程');
    setField('指令', '做事');
    pick('單次');
    setField('日期', '2026-12-01');
    setField('時間', '10:30');
    expect(screen.getByText(/^下次執行：12\/01 10:30/)).toBeTruthy();
    expect(screen.queryByLabelText('時區')).toBeNull();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api).recurrence).toEqual({ kind: 'once', at: '2026-12-01T02:30:00.000Z' });
    fireEvent.click(await screen.findByRole('button', { name: '新增排程' }));
    await screen.findByRole('dialog');
    setField('標題', '輪詢'); setField('指令', '做事');
    pick('每 N 分鐘');
    setField('間隔（分鐘）', '15');
    expect(screen.queryByLabelText('起算時間')).toBeNull();
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(2));
    expect(lastCreate(api).recurrence).toEqual({ kind: 'interval', everyMinutes: 15, anchorAt: '2026-10-28T02:00:00.000Z' });
    fireEvent.click(await screen.findByRole('button', { name: '新增排程' }));
    await screen.findByRole('dialog');
    setField('標題', '工作日'); setField('指令', '做事');
    pick('Cron');
    setField('Cron 運算式（分 時 日 月 週）', ' 0 9 * * 1-5 ');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(3));
    expect(lastCreate(api).recurrence).toEqual({ kind: 'cron', expression: '0 9 * * 1-5' });
  });

  it('rejects an interval below five minutes', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '輪詢'); setField('指令', '做事');
    pick('每 N 分鐘');
    setField('間隔（分鐘）', '4');
    save();
    expect(await screen.findByText('請輸入 5 到 10,080 之間的整數。')).toBeTruthy();
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });

  it('shows an inline error for an invalid cron expression', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '壞的'); setField('指令', '做事');
    pick('Cron');
    setField('Cron 運算式（分 時 日 月 週）', '61 * * * *');
    expect(await screen.findByText(/Cron 運算式無效：minute: value out of range 0-59/)).toBeTruthy();
    save();
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });

  it('shows the localized SCHEDULE_LIMIT error and keeps the dialog open', async () => {
    const { api } = setup({ create: { type: 'error', requestId: 'r', ok: false, code: 'SCHEDULE_LIMIT', message: 'raw backend text', retryable: false } });
    await openNew();
    setField('標題', '太多'); setField('指令', '做事');
    save();
    expect(await screen.findByText('啟用中的排程最多 50 個。')).toBeTruthy();
    expect(screen.queryByText('raw backend text')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(api.createAgentSchedule).toHaveBeenCalledTimes(1);
  });

  it('prefills an existing schedule and sends the full edit through updateAgentSchedule', async () => {
    const weekly = withId(2, { title: '週報', recurrence: { kind: 'weekly', days: [1, 3], time: '20:00' }, task: { type: 'summary', focus: '重點' }, targets: [target('c1', '客戶群')], prompt: '補充' });
    const { api } = setup({ schedules: [weekly] });
    fireEvent.click(await screen.findByRole('button', { name: '編輯「週報」' }));
    const dialog = await screen.findByRole('dialog', { name: '編輯排程' });
    expect((within(dialog).getByLabelText('標題') as HTMLInputElement).value).toBe('週報');
    expect((within(dialog).getByLabelText('時間') as HTMLInputElement).value).toBe('20:00');
    expect(within(dialog).getByRole('button', { name: '二' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(dialog).getByRole('button', { name: '三' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(within(dialog).getByLabelText('標題'), { target: { value: '週報二' } });
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule!.mock.calls[0]![0]).toBe(weekly.scheduleId);
    expect(api.updateAgentSchedule!.mock.calls[0]![1]).toMatchObject({
      title: '週報二', prompt: '補充', task: { type: 'summary', focus: '重點' }, recurrence: { kind: 'weekly', days: [1, 3], time: '20:00' }, targets: [target('c1', '客戶群')],
    });
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });
});

describe('Schedules form defaults and pickers', () => {
  const admin: AgentScheduleTargetOption = { accountId: 'agent-1', chatType: 'direct', chatId: 'uadmin-d6da', title: '徐佳誠', role: 'primary_admin' };

  it('defaults the delivery to the administrator and requests nothing until something is typed', async () => {
    const { api } = setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('group', { name: '要傳送的 LINE 聊天室' })).toBeNull();
    const picker = screen.getByRole('group', { name: '要讀取的聊天室' });
    const input = within(picker).getByRole('combobox');
    expect(input.getAttribute('placeholder')).toBe('搜尋聊天室名稱');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '   ' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.listAgentScheduleTargets).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '客' } });
    await waitFor(() => expect(api.listAgentScheduleTargets).toHaveBeenCalledWith('客', 20, 'read'));
    pick('傳到 LINE 聊天室');
    expect(api.listAgentScheduleTargets).not.toHaveBeenCalledWith(expect.anything(), 20, 'delivery');
    fireEvent.change(within(screen.getByRole('group', { name: '要傳送的 LINE 聊天室' })).getByRole('combobox'), { target: { value: '客' } });
    await waitFor(() => expect(api.listAgentScheduleTargets).toHaveBeenCalledWith('客', 20, 'delivery'));
  });

  it('adds a chat from the dropdown with the keyboard', async () => {
    setup({ targets: [target('c1', '客戶群'), target('c2', '客服群')] });
    await openNew();
    const picker = screen.getByRole('group', { name: '要讀取的聊天室' });
    const input = within(picker).getByRole('combobox');
    fireEvent.change(input, { target: { value: '客' } });
    await within(picker).findAllByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(within(picker).getAllByRole('option')[1]!.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(picker).queryByRole('listbox')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('');
    expect(within(picker).getByText('客服群')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes the dropdown with Escape without closing the dialog', async () => {
    setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    const picker = screen.getByRole('group', { name: '要讀取的聊天室' });
    const input = within(picker).getByRole('combobox');
    fireEvent.change(input, { target: { value: '客' } });
    await within(picker).findByRole('option');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(picker).queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows a community target and badges the administrator, with no id hints', async () => {
    setup({ targets: [target('c-other-53dd', '徐佳誠', 'direct'), admin, target('cm1', '開放社群', 'community'), target('c-last-9999', '徐佳誠', 'group')] });
    await openNew();
    const picker = screen.getByRole('group', { name: '要讀取的聊天室' });
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: '徐' } });
    const rows = await within(picker).findAllByRole('option');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['加入 徐佳誠', '加入 徐佳誠', '加入 開放社群', '加入 徐佳誠']);
    expect(within(rows[0]!).getByText('管理員')).toBeTruthy();
    expect(picker.textContent).not.toMatch(/…[0-9a-z]{4}/);
    expect(rows[2]!.querySelector('[data-chat-icon="house"]')).toBeTruthy();
    fireEvent.click(rows[2]!);
    expect(within(picker).getAllByText('開放社群').length).toBeGreaterThan(0);
  });

  it('shows the time zone only in the next-run line of a non-default schedule and keeps it on save', async () => {
    const tokyo = withId(2, { title: '東京', timezone: 'Asia/Tokyo', recurrence: { kind: 'daily', time: '09:00' }, prompt: '做事' });
    const { api } = setup({ schedules: [tokyo] });
    const dialog = await openEditorOf('東京');
    expect(within(dialog).queryByLabelText('時區')).toBeNull();
    expect(within(dialog).getByText(/下次執行：\d\d\/\d\d 09:00（Asia\/Tokyo）/)).toBeTruthy();
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule!.mock.calls[0]![1]).toMatchObject({ timezone: 'Asia/Tokyo' });
  });

  it('puts the assistant select and the enabled switch in one settings row, hiding the select for a system message', async () => {
    setup();
    const dialog = await openNew();
    expect(within(dialog).getByLabelText('助理')).toBeTruthy();
    expect(within(dialog).getByRole('switch', { name: '啟用' })).toBeTruthy();
    pick('程式排程');
    expect(within(dialog).queryByLabelText('助理')).toBeNull();
    expect(within(dialog).getByRole('switch', { name: '啟用' })).toBeTruthy();
  });

  it('offers 隨機延後 with 不延後 and 最多 1..5 分鐘, defaults new schedules to 5, hints it in the next-run line and submits it', async () => {
    const { api } = setup();
    const dialog = await openNew();
    const select = within(dialog).getByLabelText('隨機延後') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['不延後', '最多 1 分鐘', '最多 2 分鐘', '最多 3 分鐘', '最多 4 分鐘', '最多 5 分鐘']);
    expect(select.value).toBe('5');
    expect(within(dialog).getByText(/^下次執行：.*（隨機延後 0–5 分鐘）$/)).toBeTruthy();
    fireEvent.change(select, { target: { value: '2' } });
    expect(within(dialog).getByText(/（隨機延後 0–2 分鐘）$/)).toBeTruthy();
    setField('標題', '延後');
    setField('指令', '做事');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toMatchObject({ jitterMinutes: 2 });
  });

  it('drops the hint at 不延後 and loads the stored value of an existing schedule', async () => {
    const stored = withId(3, { title: '已存', jitterMinutes: 3 });
    const { api } = setup({ schedules: [stored] });
    const dialog = await openEditorOf('已存');
    const select = within(dialog).getByLabelText('隨機延後') as HTMLSelectElement;
    expect(select.value).toBe('3');
    fireEvent.change(select, { target: { value: '0' } });
    expect(within(dialog).queryByText(/隨機延後 0–/)).toBeNull();
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule!.mock.calls[0]![1]).toMatchObject({ jitterMinutes: 0 });
  });

});

describe('Schedules dialog interface guidelines', () => {
  const css = readFileSync(join(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
  const ruleOf = (selector: string) => { const start = css.indexOf(`${selector}{`); return start < 0 ? '' : css.slice(start, css.indexOf('}', start)); };

  it('lays the recurrence out as segmented row, inputs row, then the next-run line', async () => {
    setup();
    const dialog = await openNew();
    pick('單次');
    const line = dialog.querySelector('.schedule-line')!;
    expect(Array.from(line.children, (child) => child.getAttribute('role') ?? child.className)).toEqual(['radiogroup', 'schedule-inputs']);
    expect(line.querySelectorAll('.schedule-inputs input[type="date"], .schedule-inputs input[type="time"]')).toHaveLength(2);
    expect(line.nextElementSibling?.textContent).toMatch(/^下次執行/);
    expect(ruleOf('.schedule-line')).toContain('flex-direction:column');
    expect(css).toContain('.job-table.schedule-table th:nth-child(n){width:auto}');
  });

  it('renders the chat dropdown in flow under the input, not as a clipped overlay', async () => {
    setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    const picker = screen.getByRole('group', { name: '要讀取的聊天室' });
    const input = within(picker).getByRole('combobox');
    expect(input.getAttribute('aria-controls')).toBeNull();
    fireEvent.change(input, { target: { value: '客' } });
    await within(picker).findByRole('option');
    expect(input.nextElementSibling?.className).toBe('schedule-dropdown');
    expect(input.getAttribute('aria-controls')).toBe(within(picker).getByRole('listbox').id);
    const rule = ruleOf('.schedule-dropdown');
    expect(rule).not.toContain('position:absolute');
    expect(rule).toContain('max-height:240px');
  });

  it('keeps typed input when the scrim is clicked, but closes a clean dialog', async () => {
    setup();
    const dialog = await openNew();
    const scrim = dialog.parentElement!;
    setField('標題', '寫到一半');
    fireEvent.mouseDown(scrim);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText('標題') as HTMLInputElement).value).toBe('寫到一半');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const second = await openNew();
    fireEvent.mouseDown(second.parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cycles Tab and Shift+Tab inside the dialog', async () => {
    setup();
    const dialog = await openNew();
    const save = within(dialog).getByRole('button', { name: '儲存' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    const first = screen.getByRole('radio', { name: '程式排程' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('focuses the first invalid field after a failed submit', async () => {
    setup();
    const dialog = await openNew();
    setField('標題', '有標題');
    within(dialog).getByRole('button', { name: '儲存' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('指令')));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
  });

  it('names the inputs and keeps counters silent until over the limit', async () => {
    setup();
    const dialog = await openNew();
    expect(screen.getByLabelText('標題').getAttribute('name')).toBe('title');
    expect(screen.getByLabelText('指令').getAttribute('name')).toBe('prompt');
    const counter = Array.from(dialog.querySelectorAll('.schedule-hint')).find((node) => (node.textContent ?? '').includes(' / '));
    expect(counter?.getAttribute('aria-live') ?? null).toBeNull();
  });
});

describe('Schedules copy', () => {
  it('has the same keys and interpolation slots in every locale', () => {
    const slots = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map((match) => match[0]).sort();
    for (const catalog of [TRADITIONAL_CHINESE_SCHEDULE_COPY, JAPANESE_SCHEDULE_COPY, KOREAN_SCHEDULE_COPY]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(ENGLISH_SCHEDULE_COPY).sort());
      for (const [key, english] of Object.entries(ENGLISH_SCHEDULE_COPY)) {
        expect(slots((catalog as Record<string, string>)[key]!), key).toEqual(slots(english));
        expect((catalog as Record<string, string>)[key]!.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('defines the sidebar label in all four locales', () => {
    expect(ENGLISH_DESKTOP_COPY.schedules).toBe('Schedules');
    expect(TRADITIONAL_CHINESE_DESKTOP_COPY.schedules).toBe('排程');
    expect(JAPANESE_DESKTOP_COPY.schedules).toBeTruthy();
    expect(KOREAN_DESKTOP_COPY.schedules).toBeTruthy();
  });

  it('renders in English', async () => {
    const api = { listAgentSchedules: vi.fn(async () => [base]), listAgentScheduleRuns: vi.fn(async () => []), listAgentScheduleTargets: vi.fn(async () => []), onEvent: vi.fn(() => () => undefined) } as unknown as DesktopApi;
    render(<Schedules api={api} defaultProvider="claude" headingRef={React.createRef()} />, 'en');
    expect(await screen.findByText('10/29 09:00')).toBeTruthy();
    expect(screen.getByText('History only')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Name', 'Runs at', 'Target', 'Status']);
    expect(screen.getByRole('heading', { name: 'Schedules' })).toBeTruthy();
  });
});

describe('Schedules: system messages, record-only delivery and run replies', () => {
  const alarm = withId(7, { title: '吃藥鬧鐘', prompt: '', task: { type: 'message', text: '現在 {{time}}，記得吃藥' }, delivery: { mode: 'primary_admin' }, lastOutcome: 'sent' });
  const run = (patch: Partial<AgentScheduleRun>): AgentScheduleRun => ({ runId: '44444444-4444-4444-8444-444444444444', scheduleId: base.scheduleId,
    scheduledFor: '2026-10-28T01:00:00.000Z', outcome: 'submitted', jobId: 'abcdef1234567890', replyPreview: null, createdAt: '2026-10-28T01:00:01.000Z', ...patch });

  it('offers the 系統訊息 task with only the text, recurrence, delivery and enabled fields', async () => {
    const { api } = setup({ targets: [target('c1', '客戶群')] });
    await openNew();
    pick('程式排程');
    expect(screen.getByText(/由系統直接傳送這段文字/)).toBeTruthy();
    expect(screen.getByLabelText('訊息內容')).toBeTruthy();
    expect(screen.getByText(/\{\{date\}\}（YYYY-MM-DD）、\{\{time\}\}（HH:mm）、\{\{weekday\}\}/)).toBeTruthy();
    expect(screen.getByText('0 / 5,000')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('訊息內容'), { target: { value: '起床 {{time}}' } });
    expect(screen.getByText('11 / 5,000')).toBeTruthy();
    // Not used by a system message.
    expect(screen.queryByRole('group', { name: '要讀取的聊天室' })).toBeNull();
    expect(screen.queryByLabelText('指令')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '要讀取的時間範圍' })).toBeNull();
    expect(screen.queryByLabelText('助理')).toBeNull();
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '傳到 LINE 聊天室' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '只保存在排程紀錄' })).toBeNull();
    expect(screen.getByLabelText('啟用')).toBeTruthy();
    setField('標題', '鬧鐘');
    setField('時間', '07:30');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toEqual({
      title: '鬧鐘', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '07:30' }, timezone: 'Asia/Taipei', targets: [],
      task: { type: 'message', text: '起床 {{time}}' }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, enabled: true, jitterMinutes: 5,
    });
  });

  it('requires the message text and bounds it at 5000 characters', async () => {
    const { api } = setup();
    await openNew();
    pick('程式排程');
    setField('標題', '空');
    save();
    expect((await screen.findAllByText('請輸入訊息內容。')).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('訊息內容'), { target: { value: 'x'.repeat(5001) } });
    expect((await screen.findAllByText('訊息內容太長。')).length).toBeGreaterThan(0);
    expect(api.createAgentSchedule).not.toHaveBeenCalled();
  });

  it('offers 只保存在排程紀錄 for an Agent task, saves record_only, and switches a message back to the administrator', async () => {
    const { api } = setup();
    await openNew();
    setField('標題', '只存'); setField('指令', '整理');
    pick('只保存在排程紀錄');
    expect(screen.getByRole('radio', { name: '只保存在排程紀錄' }).getAttribute('aria-checked')).toBe('true');
    pick('程式排程');
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' }).getAttribute('aria-checked')).toBe('true');
    pick('Agent 排程');
    expect(screen.getByRole('radio', { name: '傳給我（主要管理者）' }).getAttribute('aria-checked')).toBe('true');
    pick('只保存在排程紀錄');
    save();
    await waitFor(() => expect(api.createAgentSchedule).toHaveBeenCalledTimes(1));
    expect(lastCreate(api)).toMatchObject({ task: { type: 'custom' }, delivery: { mode: 'record_only' } });
  });

  it('edits a system message schedule with its text prefilled and updates it', async () => {
    const { api } = setup({ schedules: [alarm] });
    fireEvent.click(await screen.findByRole('button', { name: '編輯「吃藥鬧鐘」' }));
    const dialog = await screen.findByRole('dialog', { name: '編輯排程' });
    expect((within(dialog).getByLabelText('訊息內容') as HTMLTextAreaElement).value).toBe('現在 {{time}}，記得吃藥');
    fireEvent.change(within(dialog).getByLabelText('訊息內容'), { target: { value: '改過的提醒' } });
    save();
    await waitFor(() => expect(api.updateAgentSchedule).toHaveBeenCalledTimes(1));
    expect(api.updateAgentSchedule!.mock.calls[0]![1]).toMatchObject({ task: { type: 'message', text: '改過的提醒' }, targets: [], prompt: '', delivery: { mode: 'primary_admin' } });
  });

  it('badges a system message in the list and shows its text instead of chats', async () => {
    setup({ schedules: [alarm] });
    const table = await screen.findByRole('table', { name: '排程列表' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText('系統訊息')).toBeTruthy();
    expect(within(row).getByText('管理員')).toBeTruthy();
  });

  it('labels the message run outcomes 已傳送, 傳送失敗 and 結果不明 and has no reply column for them', async () => {
    setup({ schedules: [alarm], runs: [
      run({ runId: '55555555-5555-4555-8555-555555555555', outcome: 'sent', jobId: null, scheduledFor: '2026-10-28T01:00:00.000Z' }),
      run({ runId: '66666666-6666-4666-8666-666666666666', outcome: 'send_failed', jobId: null, scheduledFor: '2026-10-27T01:00:00.000Z' }),
      run({ runId: '77777777-7777-4777-8777-777777777777', outcome: 'send_unknown', jobId: null, scheduledFor: '2026-10-26T01:00:00.000Z' }),
    ] });
    const dialog = await openEditorOf('吃藥鬧鐘');
    expect(await within(dialog).findByText('已傳送')).toBeTruthy();
    expect(within(dialog).getByText('傳送失敗')).toBeTruthy();
    expect(within(dialog).getByText('結果不明')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '查看回覆' })).toBeNull();
  });


  it('shows the reply preview of an Agent run and opens the full reply through the job events', async () => {
    const { api } = setup({ schedules: [base], runs: [run({ replyPreview: '今天的重點：一、二、三…' }), run({ runId: '88888888-8888-4888-8888-888888888888', jobId: null, outcome: 'missed', scheduledFor: '2026-10-27T01:00:00.000Z' })],
      events: [{ type: 'text_delta', text: 'partial' }, { type: 'completed', finalText: '完整回覆：一、二、三，以及更多細節。' }] });
    const editor = await openEditorOf('晨間提醒');
    await within(editor).findByText('10/28 09:00');
    fireEvent.click(within(editor).getByRole('button', { name: '查看回覆' }));
    const dialog = await screen.findByRole('dialog', { name: '回覆內容' });
    expect(api.getAgentRoomJobEvents).toHaveBeenCalledWith('abcdef1234567890');
    expect(within(dialog).getByText('完整回覆：一、二、三，以及更多細節。')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '關閉' }));
    expect(screen.queryByRole('dialog', { name: '回覆內容' })).toBeNull();
  });

  it('keeps the new keys in all four locales', () => {
    for (const copy of [ENGLISH_SCHEDULE_COPY, TRADITIONAL_CHINESE_SCHEDULE_COPY, JAPANESE_SCHEDULE_COPY, KOREAN_SCHEDULE_COPY]) {
      for (const key of ['taskMessage', 'taskHintMessage', 'fieldMessageText', 'messageHelp', 'outcomeSent', 'outcomeSendFailed', 'outcomeSendUnknown', 'deliveryRecordOnly',
        'deliveryOptionRecordOnly', 'runReply', 'runReplyView', 'jobScheduleBadge'] as const) {
        expect(copy[key].length).toBeGreaterThan(0);
      }
      expect(copy.messageHelp).toContain('{{date}}');
      expect('deliveryAgentRoom' in copy).toBe(false);
    }
    expect(TRADITIONAL_CHINESE_SCHEDULE_COPY.deliveryRecordOnly).toBe('只保存在排程紀錄（不傳送）');
    expect(TRADITIONAL_CHINESE_SCHEDULE_COPY.deliveryOptionRecordOnly).toBe('只保存在排程紀錄');
  });
});
