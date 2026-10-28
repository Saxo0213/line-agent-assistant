// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@line-agent/contracts';
import { AgentRoom, describeSubmitFailure, mergeAgentEventStreams } from './AgentRoom.js';
import type { DesktopApi } from '../../preload/api.js';
import { readAgentProvider } from '../agentProviderMemory.js';

const localeMock = vi.hoisted(() => ({ effectiveLocale: 'zh-TW' as 'en' | 'zh-TW' }));
vi.mock('../locale-context.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../locale-context.js')>()), useLocale: () => ({ effectiveLocale: localeMock.effectiveLocale }) }));

afterEach(() => { cleanup(); localStorage.clear(); localeMock.effectiveLocale = 'zh-TW'; });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mergeAgentEventStreams', () => {
  const started: AgentEvent = { type: 'started', externalSessionId: 'session-1' };
  const first: AgentEvent = { type: 'text_delta', text: '第一段' };
  const second: AgentEvent = { type: 'text_delta', text: '第二段' };

  it('uses extended history without duplicating events already received live', () => {
    expect(mergeAgentEventStreams([started, first, second], [started, first])).toEqual([started, first, second]);
  });

  it('keeps newer live events when a repeated history load is shorter', () => {
    expect(mergeAgentEventStreams([started, first], [started, first, second])).toEqual([started, first, second]);
  });

  it('joins history to live events that began partway through the history stream', () => {
    expect(mergeAgentEventStreams([started, first], [first, second])).toEqual([started, first, second]);
  });

  it('does not append a live fragment already contained inside newer history', () => {
    expect(mergeAgentEventStreams([started, first, second], [first])).toEqual([started, first, second]);
  });
});

describe('AgentRoom provider availability', () => {
  const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
    agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };

  it('renders pending approval cards above the composer', async () => {
    const api = { getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => [{ approvalId: 'approval-1', jobId: 'job-1', tool: 'Bash', summary: 'npm test', deadline: new Date(Date.now() + 30_000).toISOString(), canRemember: true }]),
      decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })), onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn() } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [{ provider: 'codex', status: 'logged_in', detail: null }] }));
    expect(await screen.findByText('npm test')).toBeTruthy();
    expect(document.querySelector('.agent-approval-list')?.nextElementSibling?.getAttribute('data-testid')).toBe('agent-composer');
  });

  it('renders the level menu immediately before the attach button', async () => {
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []),
      getAgentExecutionPolicy: vi.fn(async () => ({ level: 'full' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 1, updatedAt: new Date(0).toISOString() })),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'setAgentExecutionPolicy', version: 2 })),
      decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })), onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn() } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [{ provider: 'codex', status: 'logged_in', detail: null }] }));
    const trigger = await screen.findByRole('button', { name: '權限：全部放行' });
    const attach = screen.getByRole('button', { name: '附加檔案' });
    expect(trigger.parentElement?.nextElementSibling).toBe(attach);
  });

  it('keeps the header bare and puts the provider select before the permission menu', async () => {
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []),
      getAgentExecutionPolicy: vi.fn(async () => ({ level: 'full' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 1, updatedAt: new Date(0).toISOString() })),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'setAgentExecutionPolicy', version: 2 })),
      decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })), onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn() } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [{ provider: 'codex', status: 'logged_in', detail: null }] }));
    const header = screen.getByTestId('address-plate');
    expect(header.textContent).toBe('Agent 室');
    expect(header.textContent).not.toContain('直接傳給 Agent');
    expect(screen.queryByText('已連線')).toBeNull();
    expect(header.querySelector('select')).toBeNull();
    const select = screen.getByRole('combobox', { name: 'Agent' });
    const trigger = await screen.findByRole('button', { name: '權限：全部放行' });
    expect(select.parentElement?.classList.contains('composer-actions')).toBe(true);
    expect(select.nextElementSibling).toBe(trigger.parentElement);
    expect(document.querySelector('.agent-provider-warning')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).placeholder).toBe('輸入要交給 Codex 的訊息…');
  });

  it.each([['not_installed', '尚未安裝'], ['logged_out', '尚未登入'], ['error', '目前無法使用']] as const)('warns inline when the provider is %s', (status, label) => {
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined), submitAgentRoomPrompt: vi.fn() } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [{ provider: 'codex', status, detail: null }] }));
    expect(document.querySelector('.agent-provider-warning')?.textContent).toBe(`Codex：${label}`);
    expect(screen.getByRole('combobox', { name: 'Agent' }).getAttribute('title')).toBe(`Codex：${label}`);
    expect((screen.getByRole('button', { name: '傳送' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows an unknown provider to be checked when the prompt runs', async () => {
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn(async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-1' } as const)),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [
      { provider: 'codex', status: 'unknown', detail: null },
    ] }));

    expect(screen.getByRole('combobox', { name: 'Agent' }).getAttribute('title')).toBe('Codex：執行時檢查');
    expect(document.querySelector('.agent-provider-warning')).toBeNull();
    expect(screen.queryByText(/請先到「設定 → Agent」/)).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '檢查並執行' } });
    const send = screen.getByRole('button', { name: '傳送' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledWith({
      provider: 'codex', prompt: '檢查並執行',
    }));
  });

  it('shows the busy label 傳送中… and disables the button while a submit is pending, then restores 傳送', async () => {
    const pending = deferred<{ type: 'submitAgentRoomPrompt'; requestId: string; ok: true; jobId: string }>();
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn(() => pending.promise),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [{ provider: 'codex', status: 'unknown', detail: null }] }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '忙碌測試' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const busy = await screen.findByRole('button', { name: '傳送中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '傳送' })).toBeNull();
    await act(async () => pending.resolve({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-busy' }));
    expect(await screen.findByRole('button', { name: '傳送' })).toBeTruthy();
  });

  it('shows login guidance only after the CLI reports authentication is required', async () => {
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'AUTH_REQUIRED', message: 'login required', retryable: false } as const)),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers: [
      { provider: 'codex', status: 'unknown', detail: null },
    ] }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '需要登入' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    expect(await screen.findByText(/請到「設定 → Agent」完成登入後重試/)).toBeTruthy();
  });

  it.each([
    ['en', ['LINE tools configured', 'LINE tools available', 'LINE tools not loaded']],
    ['zh-TW', ['LINE 工具已設定', 'LINE 工具可用', 'LINE 工具未載入']],
  ] as const)('shows the LINEJS MCP state for a job from history and live events in %s', async (locale, labels) => {
    localeMock.effectiveLocale = locale;
    const job = { jobId: 'job-mcp', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
      prompt: '查詢', status: 'running' as const, createdAt: '2026-10-18T00:00:00.000Z' };
    let emit: (event: unknown) => void = () => undefined;
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'mcp_status', status: 'configured', message: '已設定，等待工具載入' }]),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn((listener: (event: unknown) => void) => { emit = listener; return () => undefined; }),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [job], providers: [
      { provider: 'codex', status: 'logged_in', detail: null },
    ] }));
    expect((await screen.findByTestId('mcp-status')).textContent).toBe(labels[0]);
    emit({ type: 'agentEvent', jobId: 'job-mcp', event: { type: 'mcp_status', status: 'available', message: 'MCP 可用' } });
    await waitFor(() => expect(screen.getByTestId('mcp-status').textContent).toBe(labels[1]));
    emit({ type: 'agentEvent', jobId: 'job-mcp', event: { type: 'mcp_status', status: 'not_loaded', message: 'MCP 未載入' } });
    await waitFor(() => expect(screen.getByTestId('mcp-status').textContent).toBe(labels[2]));
  });

  it('does not show a delayed login error after switching Agent rooms', async () => {
    const result = deferred<{ type: 'error'; requestId: string; ok: false; code: string; message: string; retryable: false }>();
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn(() => result.promise),
    } as unknown as DesktopApi;
    const providers = [{ provider: 'codex' as const, status: 'unknown' as const, detail: null }];
    const view = render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '舊聊天室工作' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));

    const nextConversation = { ...conversation, chatId: 'local-agent-2' };
    view.rerender(React.createElement(AgentRoom, { api, conversation: nextConversation, jobs: [], providers }));
    result.resolve({ type: 'error', requestId: 'x', ok: false, code: 'AUTH_REQUIRED', message: 'login required', retryable: false });
    await result.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/請到「設定 → Agent」完成登入後重試/)).toBeNull();
  });
});

describe('AgentRoom errors and provider selection', () => {
  const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
    agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };
  const providers = [
    { provider: 'codex' as const, status: 'logged_in' as const, detail: null },
    { provider: 'claude' as const, status: 'logged_in' as const, detail: null },
  ];

  it('maps EXTERNAL_MONITOR_READ_ONLY to fixed text, and clears the app error after a later success', async () => {
    const submitPrompt = vi.fn()
      .mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'raw', retryable: false })
      .mockResolvedValueOnce({ type: 'submitAgentRoomPrompt', requestId: 'y', ok: true, jobId: 'job-1' });
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })), onEvent: vi.fn(() => () => undefined), submitAgentRoomPrompt: submitPrompt } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [], providers }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '工作' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const slot = screen.getByTestId('composer-status');
    expect(slot.textContent).toBe('');
    expect((await screen.findByRole('alert')).textContent).toBe('外部監控模式不能建立 Agent 工作。');
    expect(slot.contains(screen.getByRole('alert'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByTestId('composer-status').textContent).toContain('已傳送給 Codex。');
  });

  it('maps all unrecognized backend prose to safe copy', () => {
    expect(describeSubmitFailure('X', '帳號尚未啟用', 'zh-TW')).toBe('Agent 無法接受這次工作，請稍後再試。');
    expect(describeSubmitFailure('X', 'raw backend secret', 'zh-TW')).toBe('Agent 無法接受這次工作，請稍後再試。');
    expect(describeSubmitFailure('X', '失敗\n    at run (C:\\app\\x.js:1:1)', 'zh-TW')).toBe('Agent 無法接受這次工作，請稍後再試。');
    expect(describeSubmitFailure('X', '失敗 at C:/app/x.js:1:1', 'zh-TW')).toBe('Agent 無法接受這次工作，請稍後再試。');
    expect(describeSubmitFailure('X', '錯'.repeat(500), 'zh-TW').length).toBeLessThan(230);
  });

  it('renders a failed event message in the job reply bubble', async () => {
    const job = { jobId: 'job-f', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
      prompt: '壞掉的工作', status: 'failed' as const, createdAt: '2026-10-20T00:00:00.000Z' };
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'failed', code: 'INVALID_JSONL', message: 'The CLI returned invalid or incomplete output.', retryable: false }]),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [job], providers }));
    const bubble = await screen.findByText('Agent 無法完成這次工作。');
    expect(bubble.className).toContain('agent-failure');
  });

  it('does not double the provider name when the failed message already starts with it', async () => {
    const job = { jobId: 'job-n', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
      prompt: '用量', status: 'failed' as const, createdAt: '2026-10-20T00:00:00.000Z' };
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'failed', code: 'PROVIDER_LIMIT', message: 'Codex 已達用量上限：稍後再試', retryable: false }]),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [job], providers }));
    expect(await screen.findByText('Agent 無法完成這次工作。')).toBeTruthy();
    expect(screen.queryByText(/失敗：Codex/)).toBeNull();
  });

  it('keeps the selected Claude provider across snapshot updates and submits with it', async () => {
    const submitPrompt = vi.fn(async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-c' } as const));
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })), onEvent: vi.fn(() => () => undefined), submitAgentRoomPrompt: submitPrompt } as unknown as DesktopApi;
    const props = { api, jobs: [], providers };
    const view = render(React.createElement(AgentRoom, { ...props, conversation }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
    expect(readAgentProvider({ accountId: conversation.accountId, chatType: conversation.chatType, chatId: conversation.chatId })).toBe('claude');
    expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).placeholder).toBe('輸入要交給 Claude 的訊息…');
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '給 Claude' } });
    // Same route, default provider flips to claude and back: neither may reset the room.
    view.rerender(React.createElement(AgentRoom, { ...props, conversation: { ...conversation, defaultProvider: 'claude' as const } }));
    expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).value).toBe('給 Claude');
    view.rerender(React.createElement(AgentRoom, { ...props, conversation: { ...conversation, defaultProvider: 'codex' as const, title: 'Agent 室 2' } }));
    expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).value).toBe('給 Claude');
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', prompt: '給 Claude' })));
  });
});

describe('AgentRoom scrolling', () => {
  const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
    agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };
  const providers = [{ provider: 'codex' as const, status: 'logged_in' as const, detail: null }];
  const job = { jobId: 'job-s', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
    prompt: '捲動', status: 'running' as const, createdAt: '2026-10-20T00:00:00.000Z' };
  const tops = new WeakMap<object, number>();
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true,
      get() { return tops.get(this) ?? 0; }, set(value: number) { tops.set(this, value); } });
  });
  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  function setup(extra: Record<string, unknown> = {}) {
    const listeners: Array<(event: unknown) => void> = [];
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => []),
      listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
      onEvent: vi.fn((next: (event: unknown) => void) => { listeners.push(next); return () => undefined; }),
      submitAgentRoomPrompt: vi.fn(async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-new' } as const)),
      ...extra,
    } as unknown as DesktopApi;
    const view = render(React.createElement(AgentRoom, { api, conversation, jobs: [job], providers }));
    const list = () => document.getElementById('timeline') as HTMLElement;
    const emit = (text: string) => act(() => listeners.forEach((listener) => listener({ type: 'agentEvent', jobId: 'job-s', event: { type: 'text_delta', text } })));
    return { api, view, list, emit };
  }

  it('starts at the bottom when entering and when switching to another Agent room', async () => {
    const { api, view, list } = setup();
    expect(list().scrollTop).toBe(1000);
    list().scrollTop = 100;
    fireEvent.scroll(list());
    const other = { ...conversation, chatId: 'local-agent-2' };
    const otherJob = { ...job, jobId: 'job-other' };
    view.rerender(React.createElement(AgentRoom, { api, conversation: other, jobs: [otherJob], providers }));
    expect(list().scrollTop).toBe(1000);
  });

  it('shows only the account-less room history, never a LINE account\'s jobs, and loads events without an account', async () => {
    const lineJob = { ...job, jobId: 'job-line', accountId: 'account-A', chatType: 'group' as const, chatId: 'g1', prompt: 'LINE 聊天室的工作' };
    const api = { getAgentRoomJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })), onEvent: vi.fn(() => () => undefined),
      submitAgentRoomPrompt: vi.fn() } as unknown as DesktopApi;
    render(React.createElement(AgentRoom, { api, conversation, jobs: [job, lineJob], providers }));
    expect(screen.getByText('捲動')).toBeTruthy();
    expect(screen.queryByText('LINE 聊天室的工作')).toBeNull();
    await waitFor(() => expect(api.getAgentRoomJobEvents).toHaveBeenCalledWith('job-s'));
    expect(api.getAgentRoomJobEvents).not.toHaveBeenCalledWith('job-line');
  });

  it('scrolls to the bottom after a successful submit even when scrolled up', async () => {
    const { api, list } = setup();
    list().scrollTop = 100;
    fireEvent.scroll(list());
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '新工作' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalled());
    await waitFor(() => expect(list().scrollTop).toBe(1000));
  });

  it('follows new live events only while the reader is near the bottom', () => {
    const { list, emit } = setup();
    list().scrollTop = 780;
    fireEvent.scroll(list());
    list().scrollTop = 780;
    emit('近底部');
    expect(list().scrollTop).toBe(1000);

    list().scrollTop = 100;
    fireEvent.scroll(list());
    emit('往上看');
    expect(list().scrollTop).toBe(100);
  });
});

describe('AgentRoom LINE-style bubbles and admin LINE direct turns', () => {
  const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
    agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };
  const roomJob = { jobId: 'job-room', accountId: null, chatType: null, chatId: null, origin: 'agent_room' as const, provider: 'claude' as const,
    prompt: '室內提問', status: 'completed' as const, createdAt: '2026-10-21T08:00:00.000Z' };
  const lineJob = { jobId: 'job-line', accountId: 'agent-acct', chatType: 'direct' as const, chatId: 'mid-admin', origin: 'line_admin_direct' as const, provider: 'codex' as const,
    prompt: 'LINE 私訊提問', status: 'completed' as const, createdAt: '2026-10-21T07:00:00.000Z' };
  const foreignLineJob = { ...lineJob, jobId: 'job-foreign', origin: undefined, prompt: '別人的私訊' };
  const apiFor = (events: Record<string, unknown[]>) => ({
    getAgentRoomJobEvents: vi.fn(async (jobId: string) => events[jobId] ?? []),
    listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
    onEvent: vi.fn(() => () => undefined),
    submitAgentRoomPrompt: vi.fn(async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-new' })),
  }) as unknown as DesktopApi & { getAgentRoomJobEvents: ReturnType<typeof vi.fn>; submitAgentRoomPrompt: ReturnType<typeof vi.fn> };
  const providers = [{ provider: 'codex' as const, status: 'logged_in' as const, detail: null }];

  it('tags the admin LINE direct turn, shows its reply, orders both origins by time and leaves room jobs untagged', async () => {
    const api = apiFor({ 'job-line': [{ type: 'completed', finalText: 'LINE 回覆' }], 'job-room': [{ type: 'completed', finalText: '室內回覆' }] });
    render(React.createElement(AgentRoom, { api, conversation, jobs: [roomJob, foreignLineJob, lineJob], providers }));
    expect(await screen.findByText('LINE 回覆')).toBeTruthy();
    expect(await screen.findByText('室內回覆')).toBeTruthy();
    expect(screen.queryByText('別人的私訊')).toBeNull();
    const tags = screen.getAllByTestId('line-direct-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toBe('LINE 私訊');
    expect(tags[0]!.closest('.message-row')?.textContent).toContain('LINE 私訊提問');
    const prompts = [...document.querySelectorAll('.message-row.outbound .message-text')].map((node) => node.textContent);
    expect(prompts).toEqual(['LINE 私訊提問', '室內提問']);
    expect(document.querySelectorAll('.message-row.outbound.line-admin-direct')).toHaveLength(1);
    expect(api.getAgentRoomJobEvents).not.toHaveBeenCalledWith('job-foreign');
  });

  it('never shows a scheduled run in the Agent room, even though it is account-less', async () => {
    const scheduleJob = { jobId: 'job-schedule', accountId: null, chatType: null, chatId: null, origin: 'schedule' as const, provider: 'claude' as const,
      prompt: '[排程] 早報\n任務：自訂', status: 'completed' as const, createdAt: '2026-10-21T09:00:00.000Z' };
    const api = apiFor({ 'job-room': [{ type: 'completed', finalText: '室內回覆' }], 'job-schedule': [{ type: 'completed', finalText: '排程回覆' }] });
    render(React.createElement(AgentRoom, { api, conversation, jobs: [roomJob, scheduleJob], providers }));
    expect(await screen.findByText('室內回覆')).toBeTruthy();
    expect(screen.queryByText('排程回覆')).toBeNull();
    expect(screen.queryByText(/\[排程\]/)).toBeNull();
    expect(api.getAgentRoomJobEvents).not.toHaveBeenCalledWith('job-schedule');
  });

  it('uses the LINE own/incoming bubble classes, provider name row, time and a day separator', async () => {
    const api = apiFor({ 'job-room': [{ type: 'completed', finalText: '**粗體** 回覆' }] });
    render(React.createElement(AgentRoom, { api, conversation, jobs: [lineJob, roomJob], providers }));
    await screen.findByTestId('agent-markdown');
    const own = [...document.querySelectorAll('.message-row.outbound article.message.outbound.bubble-tail')].at(-1);
    expect(own?.textContent).toContain('室內提問');
    const incoming = [...document.querySelectorAll('.message-row.inbound.has-sender-name article.message.inbound.bubble-tail')].at(-1);
    expect(incoming?.querySelector('[data-testid="agent-markdown"] strong')?.textContent).toBe('粗體');
    const row = incoming!.closest('.message-row')!;
    expect(row.querySelector('.message-identity .sender-avatar')).toBeTruthy();
    expect(row.querySelector('.message-sender-name')?.textContent).toBe('Claude');
    expect(row.querySelector('time.message-time')?.textContent).toMatch(/\d/);
    expect(document.querySelectorAll('.date-separator')).toHaveLength(1);
    expect(document.querySelector('.timeline-content')).toBeTruthy();
  });

  it('keeps failure text and MCP status inside the LINE-style rows', async () => {
    const api = apiFor({ 'job-room': [{ type: 'mcp_status', status: 'available', message: 'MCP 可用' }, { type: 'failed', code: 'X', message: '壞了' }] });
    render(React.createElement(AgentRoom, { api, conversation, jobs: [roomJob], providers }));
    expect((await screen.findByTestId('mcp-status')).closest('.message-sender-name')).toBeTruthy();
    expect(document.querySelector('.message-row.inbound .message-text.agent-failure')?.textContent).toContain('Agent 無法完成這次工作。');
  });

  it('still creates a room job when sending from the room, never a LINE job', async () => {
    const api = apiFor({});
    render(React.createElement(AgentRoom, { api, conversation, jobs: [lineJob], providers }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '從室內送出' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledWith({ provider: 'codex', prompt: '從室內送出' }));
    const prompts = await waitFor(() => {
      const found = [...document.querySelectorAll('.message-row.outbound')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(prompts[1]!.classList.contains('line-admin-direct')).toBe(false);
    expect(screen.getAllByTestId('line-direct-tag')).toHaveLength(1);
  });
});
