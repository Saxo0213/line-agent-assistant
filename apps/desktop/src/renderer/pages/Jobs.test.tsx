// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentJobSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { Jobs } from './Jobs.js';

afterEach(cleanup);

function renderAtLocale(ui: React.ReactNode, locale: 'en' | 'zh-TW' = 'zh-TW') {
  const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  return renderUi(<LocaleProvider value={value}>{ui}</LocaleProvider>);
}
const render = (ui: React.ReactNode) => renderAtLocale(ui);

const jobs: AgentJobSummary[] = [
  { jobId: 'job-running', accountId: 'account-A', chatType: 'group', chatId: 'chat-A', provider: 'codex', prompt: '整理今天收到的訊息', status: 'running', createdAt: '2026-10-16T00:00:00.000Z' },
  { jobId: 'job-complete', accountId: 'account-A', chatType: 'direct', chatId: 'chat-B', provider: 'claude', prompt: '摘要客戶問題', status: 'completed', createdAt: '2026-10-16T01:00:00.000Z', replyPreview: '已整理三則待辦事項。' },
];

function api(): DesktopApi {
  return {
    getJobEvents: vi.fn(async () => [{ type: 'started', externalSessionId: 'session-1' }, { type: 'text_delta', text: '串流中的內容' }, { type: 'completed', finalText: '已整理三則待辦事項。' }]),
    stopJob: vi.fn(async () => ({ type: 'accepted', requestId: 'stop', ok: true } as const)),
    retryJob: vi.fn(async () => ({ type: 'accepted', requestId: 'retry', ok: true } as const)),
  } as unknown as DesktopApi;
}

describe('Jobs for the account-less Agent room', () => {
  it('stops, retries and reads events of a room job through the account-less calls', async () => {
    const desktopApi = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'completed', finalText: '房間的回覆' }]),
      stopAgentRoomJob: vi.fn(async () => ({ type: 'accepted', requestId: 's', ok: true } as const)),
      retryAgentRoomJob: vi.fn(async () => ({ type: 'accepted', requestId: 'r', ok: true } as const)),
      getJobEvents: vi.fn(), stopJob: vi.fn(), retryJob: vi.fn(),
    } as unknown as DesktopApi;
    const roomJobs: AgentJobSummary[] = [
      { jobId: 'room-running', accountId: null, chatType: null, chatId: null, provider: 'codex', prompt: '房間工作', status: 'running', createdAt: '2026-10-16T00:00:00.000Z' },
      { jobId: 'room-failed', accountId: null, chatType: null, chatId: null, provider: 'claude', prompt: '失敗的房間工作', status: 'failed', createdAt: '2026-10-16T01:00:00.000Z' },
    ];
    render(<Jobs api={desktopApi} jobs={roomJobs} headingRef={React.createRef()} />);
    const running = screen.getByRole('row', { name: /Codex.*房間工作/ });
    expect(within(running).getByText('執行中')).toBeTruthy();
    expect(desktopApi.getAgentRoomJobEvents).not.toHaveBeenCalled();
    fireEvent.click(within(running).getByRole('button', { name: '查看完整回覆：Codex' }));
    expect(within(await screen.findByRole('dialog', { name: '回覆內容' })).getByText('房間的回覆')).toBeTruthy();
    expect(desktopApi.getAgentRoomJobEvents).toHaveBeenCalledWith('room-running');
    fireEvent.click(within(screen.getByRole('dialog', { name: '回覆內容' })).getByRole('button', { name: '關閉閱覽' }));
    fireEvent.click(within(running).getByRole('button', { name: '停止' }));
    await waitFor(() => expect(desktopApi.stopAgentRoomJob).toHaveBeenCalledWith('room-running'));
    fireEvent.click(within(screen.getByRole('row', { name: /Claude.*失敗的房間工作/ })).getByRole('button', { name: '重試' }));
    await waitFor(() => expect(desktopApi.retryAgentRoomJob).toHaveBeenCalledWith('room-failed'));
    expect(desktopApi.stopJob).not.toHaveBeenCalled();
    expect(desktopApi.retryJob).not.toHaveBeenCalled();
  });
});

describe('Jobs retry action', () => {
  const make = (status: AgentJobSummary['status']): AgentJobSummary => ({ jobId: `job-${status}`, accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
    provider: 'codex', prompt: `任務-${status}`, status, createdAt: '2026-10-16T00:00:00.000Z' });

  it('offers 重試 only for failed and interrupted jobs', () => {
    const all = (['queued', 'running', 'completed', 'cancelled', 'failed', 'interrupted'] as const).map(make);
    render(<Jobs api={api()} jobs={all} headingRef={React.createRef()} />);
    const has = (status: string) => within(screen.getByRole('row', { name: new RegExp(`任務-${status}`) })).queryByRole('button', { name: '重試' }) !== null;
    expect(['failed', 'interrupted'].map(has)).toEqual([true, true]);
    expect(['queued', 'running', 'completed', 'cancelled'].map(has)).toEqual([false, false, false, false]);
  });

  it('shows the refusal message instead of the success notice when the retry is refused', async () => {
    const desktopApi = { ...api(), retryJob: vi.fn(async () => ({ type: 'error', requestId: 'retry', ok: false, code: 'AGENT_JOB_NOT_RETRYABLE',
      message: '此任務目前無法重試。', retryable: false } as const)) } as unknown as DesktopApi;
    const onNotice = vi.fn();
    render(<Jobs api={desktopApi} jobs={[make('failed')]} headingRef={React.createRef()} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('此任務目前無法重試（可能已取消、已產生輸出，或所屬 Agent 會話已變更）。'));
    expect(onNotice).not.toHaveBeenCalledWith('已要求重試任務。');
  });
});

describe('Jobs', () => {
  it('places keyword scope checkboxes after status and date filters without changing their defaults', () => {
    render(<Jobs api={api()} jobs={jobs} headingRef={React.createRef()} />);

    const filters = document.querySelector('.jobs-search-card .search-row-filters')!;
    const labels = Array.from(filters.querySelectorAll('label'));
    expect(labels.map((label) => label.querySelector('input, select')?.getAttribute('aria-label'))).toEqual(['任務狀態', '開始日期', '結束日期', '搜尋任務訊息', '搜尋完成回覆']);
    expect(filters.querySelector('.jobs-search-scope')).toBe(labels[3]);
    expect((screen.getByLabelText('搜尋任務訊息') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('搜尋完成回覆') as HTMLInputElement).checked).toBe(true);
  });

  it('places the compact assistant filter before the keyword field and submits its selected provider', async () => {
    const desktopApi = { ...api(), searchAgentJobs: vi.fn().mockResolvedValue({ jobs: [], nextCursor: null }) } as unknown as DesktopApi;
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);

    const card = document.querySelector('.jobs-search-card')!;
    const topRow = card.querySelector('.jobs-search-row-main')!;
    const topRowLabels = Array.from(topRow.querySelectorAll('label'));
    expect(topRowLabels[0]?.classList.contains('jobs-search-provider')).toBe(true);
    expect(topRowLabels[1]?.classList.contains('jobs-search-keyword')).toBe(true);
    expect(screen.queryByLabelText('Provider')).toBeNull();
    expect(screen.getByLabelText('助理')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('助理'), { target: { value: 'claude' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));

    await waitFor(() => expect(desktopApi.searchAgentJobs).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' })));
  });

  it('keeps the snapshot until submitted, searches then appends a bounded page and clears back to recent tasks', async () => {
    const older: AgentJobSummary = { ...jobs[0]!, jobId: 'job-older', prompt: '歷史搜尋結果' };
    const desktopApi = { ...api(), searchAgentJobs: vi.fn()
      .mockResolvedValueOnce({ jobs: [older], nextCursor: { createdAt: older.createdAt, jobId: older.jobId } })
      .mockResolvedValueOnce({ jobs: [jobs[1]!], nextCursor: null }) } as unknown as DesktopApi;
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);
    expect(screen.getByRole('row', { name: /整理今天收到的訊息/ })).toBeTruthy();
    expect((screen.getByLabelText('搜尋訊息') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('搜尋任務訊息') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('搜尋完成回覆') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('搜尋訊息'), { target: { value: '歷史' } });
    expect(screen.getByRole('row', { name: /整理今天收到的訊息/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    expect(await screen.findByRole('row', { name: /歷史搜尋結果/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /整理今天收到的訊息/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('搜尋訊息'), { target: { value: 'draft only' } });
    fireEvent.click(screen.getByRole('button', { name: '載入更多' }));
    expect(await screen.findByRole('row', { name: /摘要客戶問題/ })).toBeTruthy();
    expect(desktopApi.searchAgentJobs).toHaveBeenNthCalledWith(1, expect.objectContaining({ keyword: '歷史', searchPrompt: true, searchReply: true, limit: expect.any(Number) }));
    expect(desktopApi.searchAgentJobs).toHaveBeenNthCalledWith(2, expect.objectContaining({ keyword: '歷史', cursor: expect.any(Object) }));
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(screen.getByRole('row', { name: /整理今天收到的訊息/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /歷史搜尋結果/ })).toBeNull();
  });

  it('ignores an older search response after newer criteria have been submitted', async () => {
    let resolveFirst!: (value: { jobs: AgentJobSummary[]; nextCursor: null }) => void;
    const searchAgentJobs = vi.fn()
      .mockImplementationOnce(() => new Promise<{ jobs: AgentJobSummary[]; nextCursor: null }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ jobs: [{ ...jobs[1]!, jobId: 'latest-result', prompt: '新條件結果' }], nextCursor: null });
    const desktopApi = { ...api(), searchAgentJobs } as unknown as DesktopApi;
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);
    const input = screen.getByLabelText('搜尋訊息');
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    fireEvent.change(input, { target: { value: 'latest' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    expect(await screen.findByRole('row', { name: /新條件結果/ })).toBeTruthy();
    resolveFirst({ jobs: [{ ...jobs[0]!, jobId: 'stale-result', prompt: '舊條件結果' }], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole('row', { name: /舊條件結果/ })).toBeNull());
    expect(screen.getByRole('row', { name: /新條件結果/ })).toBeTruthy();
  });

  it('rejects a keyword without a selected text source and retains the recent list', async () => {
    const desktopApi = { ...api(), searchAgentJobs: vi.fn() } as unknown as DesktopApi;
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);
    fireEvent.change(screen.getByLabelText('搜尋訊息'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByLabelText('搜尋任務訊息'));
    fireEvent.click(screen.getByLabelText('搜尋完成回覆'));
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    expect((await screen.findByRole('alert')).textContent).toContain('至少選擇');
    expect(desktopApi.searchAgentJobs).not.toHaveBeenCalled();
    expect(screen.getByRole('row', { name: /整理今天收到的訊息/ })).toBeTruthy();
  });

  it('renders status beside the provider and date/time below in the first of three columns', () => {
    render(<Jobs api={api()} jobs={jobs} headingRef={React.createRef()} />);

    const table = screen.getByRole('table', { name: 'Agent 任務列表' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['誰', '訊息', '回覆摘要']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('Codex');
    expect(rows[1]?.textContent).toContain('執行中');
    const whoCell = within(rows[1]!).getAllByRole('cell')[0]!;
    const createdAt = new Date(jobs[0]!.createdAt);
    const who = whoCell.querySelector('.job-who')!;
    expect(Array.from(who.children).map((element) => element.textContent)).toEqual([
      'Codex (執行中)',
      createdAt.toLocaleDateString('zh-TW-u-ca-gregory', { year: 'numeric', month: '2-digit', day: '2-digit' }),
      createdAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    ]);
    expect(who.querySelector('.job-provider-line')?.textContent).toBe('Codex (執行中)');
    expect(rows[1]?.textContent).toContain('整理今天收到的訊息');
    expect(rows[1]?.textContent).toContain('執行中');
    expect(within(rows[2]!).getByText('已整理三則待辦事項。')).toBeTruthy();
    expect(document.querySelector('.cards')).toBeNull();
    expect(document.querySelector('.panel.filter-grid')).toBeTruthy();
  });

  it('shows snapshot reply previews without event fanout and keeps row actions', async () => {
    const desktopApi = api();
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);

    const runningRow = screen.getByRole('row', { name: /Codex.*整理今天收到的訊息/ });
    const completedRow = screen.getByRole('row', { name: /Claude.*摘要客戶問題/ });
    expect(within(completedRow).getByText('已整理三則待辦事項。')).toBeTruthy();
    expect(desktopApi.getJobEvents).not.toHaveBeenCalled();
    expect(runningRow.textContent).not.toContain('started');
    expect(runningRow.textContent).not.toContain('串流中的內容');
    expect(within(runningRow).getByRole('button', { name: '停止' })).toBeTruthy();
    expect(within(completedRow).queryByRole('button', { name: '停止' })).toBeNull();
    fireEvent.click(within(completedRow).getByRole('button', { name: '查看完整回覆：Claude' }));
    expect(within(await screen.findByRole('dialog', { name: '回覆內容' })).getByText('已整理三則待辦事項。')).toBeTruthy();
    expect(desktopApi.getJobEvents).toHaveBeenCalledTimes(1);
  });

  it('shows a truthful status when a job has no stored reply', () => {
    const missingReplyJobs: AgentJobSummary[] = [
      { ...jobs[0]!, replyPreview: undefined },
      { ...jobs[1]!, jobId: 'job-complete-empty', prompt: '沒有輸出的任務', replyPreview: undefined },
      { ...jobs[1]!, jobId: 'job-failed-empty', prompt: '失敗的任務', status: 'failed', replyPreview: undefined },
    ];
    render(<Jobs api={api()} jobs={missingReplyJobs} headingRef={React.createRef()} />);

    expect(within(screen.getByRole('row', { name: /整理今天收到的訊息/ })).getByText('執行中')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /沒有輸出的任務/ })).getByText('尚無回覆')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /失敗的任務/ })).getByText('任務失敗，沒有可顯示的回覆')).toBeTruthy();
  });

  it('opens message and reply summaries in a floating full-text viewer', async () => {
    const desktopApi = api();
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} />);
    const runningRow = screen.getByRole('row', { name: /Codex.*整理今天收到的訊息/ });

    fireEvent.click(within(runningRow).getByRole('button', { name: '閱覽訊息：整理今天收到的訊息' }));
    let dialog = screen.getByRole('dialog', { name: '訊息內容' });
    expect(within(dialog).getByText('整理今天收到的訊息')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '關閉閱覽' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(runningRow).getByRole('button', { name: '查看完整回覆：Codex' }));
    dialog = await screen.findByRole('dialog', { name: '回覆內容' });
    expect(within(dialog).getByText('已整理三則待辦事項。')).toBeTruthy();
  });

  it('deduplicates full reply reads while a click is pending', async () => {
    let resolveReply!: (items: Awaited<ReturnType<DesktopApi['getJobEvents']>>) => void;
    const getJobEvents = vi.fn(() => new Promise<Awaited<ReturnType<DesktopApi['getJobEvents']>>>((resolve) => { resolveReply = resolve; }));
    const desktopApi = { ...api(), getJobEvents } as unknown as DesktopApi;
    render(<Jobs api={desktopApi} jobs={[jobs[0]!]} headingRef={React.createRef()} />);
    const button = screen.getByRole('button', { name: '查看完整回覆：Codex' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(getJobEvents).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolveReply([{ type: 'completed', finalText: '完整回覆' }]);
    expect(within(await screen.findByRole('dialog', { name: '回覆內容' })).getByText('完整回覆')).toBeTruthy();
  });

  it('routes short task action feedback through the shared toast callback', async () => {
    const desktopApi = api();
    const onNotice = vi.fn();
    render(<Jobs api={desktopApi} jobs={jobs} headingRef={React.createRef()} onNotice={onNotice} />);

    fireEvent.click(within(screen.getByRole('row', { name: /Codex.*整理今天收到的訊息/ })).getByRole('button', { name: '停止' }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('已要求停止任務。'));
    expect(document.querySelector('.inline-notice')).toBeNull();
  });
});

describe('Jobs header', () => {
  it('shows the description on the same row as the title', () => {
    render(<Jobs api={api()} jobs={jobs} headingRef={React.createRef()} />);
    const row = screen.getByRole('heading', { name: '任務' }).parentElement!;
    expect(row.className).toBe('page-title-row');
    expect(within(row).getByText('查看執行、停止或重試本機 Agent 任務。')).toBeTruthy();
    expect(row.closest('header')!.className).toContain('compact');
  });

  it('uses the startup locale from LocaleProvider', () => {
    renderAtLocale(<Jobs api={api()} jobs={[]} headingRef={React.createRef()} />, 'en');
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByText('View, stop, or retry local Agent jobs.')).toBeTruthy();
  });
});
