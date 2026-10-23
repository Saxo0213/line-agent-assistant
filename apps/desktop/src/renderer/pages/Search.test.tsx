// @vitest-environment jsdom
import React, { createRef, useState } from 'react';
import { act, cleanup, render as renderPage, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider } from '../locale-context.js';
import type { Locale } from '../../locale.js';
import { Search } from './Search.js';

afterEach(cleanup);

function render(ui: React.ReactElement, locale: Locale = 'zh-TW') {
  return renderPage(<LocaleProvider value={{ status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>{ui}</LocaleProvider>);
}

const accounts = [
  { accountId: 'account-A', displayName: 'A', status: 'connected' as const, lastSyncedAt: null, mode: 'MONITOR_ONLY' as const },
  { accountId: 'account-B', displayName: 'B', status: 'connected' as const, lastSyncedAt: null, mode: 'MONITOR_ONLY' as const },
];
const message = (accountId: string, title: string, messageId = title) => ({
  accountId, chatType: 'direct' as const, chatId: `chat-${messageId}`, messageId, senderId: 's', senderName: 'S', text: 'hit',
  occurredAt: '2026-10-16T05:39:00.000Z', conversationTitle: title,
});

function Controlled({ api, initial = null }: { api: DesktopApi; initial?: string | null }) {
  const [scope, setScope] = useState<string | null>(initial);
  return <Search api={api} accounts={accounts} conversations={[]} accountScopeId={scope} onAccountScopeChange={setScope}
    onOpen={vi.fn()} headingRef={createRef<HTMLHeadingElement>()} />;
}
const searchButton = (locale: Locale = 'zh-TW') => screen.getByRole('button', { name: locale === 'zh-TW' ? /^搜尋/ : locale === 'ja' ? /^検索/ : locale === 'ko' ? /^검색/ : /^Search/ });

describe('Search page', () => {
  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('preserves names and uses explicit ownership for unnamed senders in %s', async (locale) => {
    const rows = ['direct', 'group', 'community'].flatMap((chatType) => [
      { ...message('account-A', `Peer ${chatType}`, `${chatType}-own`), chatType, senderName: null, isOwn: true },
      { ...message('account-A', `Peer ${chatType}`, `${chatType}-named-own`), chatType, senderName: '原始自己', isOwn: true },
      { ...message('account-A', `Peer ${chatType}`, `${chatType}-named-peer`), chatType, senderName: '原始對方', isOwn: false },
      { ...message('account-A', `Peer ${chatType}`, `${chatType}-peer`), chatType, senderName: null, isOwn: false },
      { ...message('account-A', `Peer ${chatType}`, `${chatType}-legacy`), chatType, senderName: null },
    ]);
    const api = { searchMessages: vi.fn(async () => rows) } as unknown as DesktopApi;
    render(<Controlled api={api} />, locale);
    fireEvent.click(searchButton(locale));
    await waitFor(() => expect(document.querySelectorAll('.search-group-heading')).toHaveLength(15));
    document.querySelectorAll('.search-group-heading').forEach((button) => fireEvent.click(button));
    await waitFor(() => expect(document.querySelectorAll('.search-nickname')).toHaveLength(15));
    expect(Array.from(document.querySelectorAll('.search-nickname'), (node) => node.textContent)).toEqual(
      Array.from({ length: 3 }, () => locale === 'zh-TW' ? ['我', '原始自己', '原始對方', '對方', '未知']
        : locale === 'ja' ? ['自分', '原始自己', '原始對方', '相手', '不明']
          : locale === 'ko' ? ['나', '原始自己', '原始對方', '상대방', '알 수 없음']
            : ['Me', '原始自己', '原始對方', 'Other person', 'Unknown']).flat());
  });

  it('renders the search card above account tabs styled like the Settings tabs, with no account dropdown', async () => {
    const api = { searchMessages: vi.fn(async () => []) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    const tablist = screen.getByRole('tablist', { name: '帳號篩選' });
    expect(tablist.className).toContain('settings-tabs');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['全部帳號', 'A', 'B']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('combobox', { name: '帳號' })).toBeNull();
    const form = screen.getByLabelText('訊息或檔名').closest('form')!;
    expect(form.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(tabs[2]!);
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[2]!.className).toContain('active');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(tabs[1]!);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(api.searchMessages).not.toHaveBeenCalled();
  });

  it('lays out the search card in two rows: text field and 搜尋 button, then filters with 只看附件 after 結束日期', () => {
    const api = { searchMessages: vi.fn(async () => []) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    const form = screen.getByLabelText('訊息或檔名').closest('form')!;
    const rows = Array.from(form.children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    const [main, filters] = rows as [HTMLElement, HTMLElement];
    expect(main.contains(screen.getByLabelText('訊息或檔名'))).toBe(true);
    expect(main.contains(searchButton())).toBe(true);
    expect(searchButton().compareDocumentPosition(screen.getByLabelText('訊息或檔名')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const labels = Array.from(filters.querySelectorAll('label')).map((label) => label.textContent);
    expect(labels).toEqual(['類型全部個人群組聊天室社群討論串', '起始日期', '結束日期', '只看附件']);
    expect(filters.contains(screen.getByLabelText('只看附件'))).toBe(true);
    expect(filters.contains(searchButton())).toBe(false);
  });

  it('does not search while typing or changing filters, and shows only the neutral hint before the first search', async () => {
    const api = { searchMessages: vi.fn(async () => []) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    fireEvent.change(screen.getByLabelText('訊息或檔名'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('類型'), { target: { value: 'group' } });
    fireEvent.change(screen.getByLabelText('起始日期'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('結束日期'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByLabelText('只看附件'));
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'A' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(api.searchMessages).not.toHaveBeenCalled();
    expect(screen.queryByText(/找不到符合條件/)).toBeNull();
    expect(screen.getByText('輸入條件後按「搜尋」。')).toBeTruthy();
  });

  it('searches on the 搜尋 button and on Enter, then shows the empty state only after a search', async () => {
    const api = { searchMessages: vi.fn(async () => []) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    const input = screen.getByLabelText('訊息或檔名');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(searchButton());
    expect(await screen.findByText(/找不到符合條件/)).toBeTruthy();
    expect(screen.queryByText('輸入條件後按「搜尋」。')).toBeNull();
    expect(api.searchMessages).toHaveBeenLastCalledWith({ text: 'abc', limit: 100 });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(api.searchMessages).toHaveBeenCalledTimes(2));
  });

  it('shows 搜尋中… and disables the button while a search is running', async () => {
    let resolve!: (value: never[]) => void;
    const api = { searchMessages: vi.fn(() => new Promise<never[]>((r) => { resolve = r; })) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    fireEvent.click(searchButton());
    const busy = screen.getByRole('button', { name: '搜尋中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => { resolve([]); });
    expect((screen.getByRole('button', { name: '搜尋' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('results reflect the conditions at search time; later edits do not change them', async () => {
    const api = { searchMessages: vi.fn(async () => [message('account-A', 'Chat one')]) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    fireEvent.click(searchButton());
    expect(await screen.findByRole('heading', { name: 'Chat one' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('訊息或檔名'), { target: { value: 'changed' } });
    fireEvent.change(screen.getByLabelText('類型'), { target: { value: 'group' } });
    expect(screen.getByRole('heading', { name: 'Chat one' })).toBeTruthy();
    expect(api.searchMessages).toHaveBeenCalledTimes(1);
  });

  it('a tab click re-runs the search only after a search has been run, with the new account', async () => {
    const api = { searchMessages: vi.fn(async (query: { accountId?: string }) => query.accountId === 'account-B'
      ? [message('account-B', 'B chat')] : [message('account-A', 'A chat')]) } as unknown as DesktopApi;
    render(<Controlled api={api} initial="account-A" />);
    const tabB = within(screen.getByRole('tablist')).getByRole('tab', { name: 'B' });
    fireEvent.click(tabB);
    expect(api.searchMessages).not.toHaveBeenCalled();
    fireEvent.click(searchButton());
    expect(await screen.findByRole('heading', { name: 'B chat' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'A' }));
    expect(await screen.findByRole('heading', { name: 'A chat' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'B chat' })).toBeNull();
    expect(api.searchMessages).toHaveBeenLastCalledWith({ accountId: 'account-A', text: '', limit: 100 });
  });

  it('ignores a stale response that resolves after a newer search', async () => {
    const resolvers: Array<(items: ReturnType<typeof message>[]) => void> = [];
    const api = { searchMessages: vi.fn(() => new Promise<ReturnType<typeof message>[]>((r) => { resolvers.push(r); })) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    fireEvent.click(searchButton());
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'B' }));
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]!([message('account-B', 'Fresh B')]); });
    await act(async () => { resolvers[0]!([message('account-A', 'Stale A')]); });
    expect(screen.getByRole('heading', { name: 'Fresh B' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Stale A' })).toBeNull();
  });

  it('reports a failed search and clears busy state', async () => {
    const api = { searchMessages: vi.fn(async () => { throw new Error('offline'); }) } as unknown as DesktopApi;
    render(<Controlled api={api} />);
    fireEvent.click(searchButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: '搜尋' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('groups messages by chat collapsed by default, then opens a compact row without exposing IDs', async () => {
    const api = {
      searchMessages: vi.fn(async () => [{
        accountId: 'account-secret', chatType: 'direct' as const, chatId: 'chat-secret',
        messageId: 'message-secret', senderId: 'sender-secret', senderName: '陳工程師', text: '測試內容', occurredAt: '2026-10-16T05:39:00.000Z', conversationTitle: '即時名稱',
      }]),
    } as unknown as DesktopApi;
    const onOpen = vi.fn();
    render(<Search api={api} accountScopeId="account-secret" onAccountScopeChange={vi.fn()}
      accounts={[{ accountId: 'account-secret', displayName: '建築人', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL' }]}
      conversations={[{ accountId: 'account-secret', chatType: 'direct', chatId: 'chat-secret', title: '王小明', unreadCount: 0, agentEnabled: false, defaultProvider: 'claude' }]}
      onOpen={onOpen} headingRef={createRef<HTMLHeadingElement>()} />);
    fireEvent.click(searchButton());

    expect(await screen.findByRole('heading', { name: '即時名稱' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '王小明' })).toBeNull();
    const group = screen.getByRole('button', { name: /即時名稱.*1 則/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('columnheader', { name: '暱稱' })).toBeNull();
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('columnheader', { name: '暱稱' })).toBeTruthy();
    const row = screen.getByRole('button', { name: /陳工程師.*測試內容/ });
    expect(row.textContent).not.toContain('account-secret');
    expect(row.textContent).not.toContain('chat-secret');
    expect(row.textContent).not.toContain('sender-secret');
    fireEvent.click(row);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ accountId: 'account-secret', chatType: 'direct', chatId: 'chat-secret' }));
  });

  it('groups all-account results by account and disambiguates duplicate account names', async () => {
    const dup = [
      { accountId: 'account-A', displayName: '共用帳號', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const },
      { accountId: 'account-B', displayName: '共用帳號', status: 'connected' as const, lastSyncedAt: null, mode: 'MONITOR_ONLY' as const },
    ];
    const api = {
      searchMessages: vi.fn(async (query: { accountId?: string }) => [message('account-A', 'Same name', 'a'), message('account-B', 'Same name', 'b')]
        .filter((item) => !query.accountId || item.accountId === query.accountId)),
    } as unknown as DesktopApi;
    function Dup() {
      const [scope, setScope] = useState<string | null>(null);
      return <Search api={api} accounts={dup} conversations={[]} accountScopeId={scope} onAccountScopeChange={setScope}
        onOpen={vi.fn()} headingRef={createRef<HTMLHeadingElement>()} />;
    }
    render(<Dup />);
    fireEvent.click(searchButton());
    expect(await screen.findAllByRole('heading', { name: 'Same name' })).toHaveLength(2);
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: '共用帳號 · 帳號 1' }));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Same name' })).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: '全部帳號' }));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Same name' })).toHaveLength(2));
  });
});

describe('Search page header', () => {
  it('shows the description on the same row as the title', () => {
    render(<Controlled api={{ searchMessages: vi.fn(async () => []) } as unknown as DesktopApi} />);
    const row = screen.getByRole('heading', { name: '搜尋對話紀錄' }).parentElement!;
    expect(row.className).toBe('page-title-row');
    expect(within(row).getByText('依帳號、類型、日期與訊息內容搜尋。')).toBeTruthy();
    expect(row.closest('header')!.className).toContain('compact');
  });
});
