// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAccountSource } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { AgentAccountSources, AgentAutoFailoverSwitch } from './AgentAccountSources.js';
import { Settings } from './Settings.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const source = (patch: Partial<AgentAccountSource>): AgentAccountSource => ({
  id: 'claude', provider: 'claude', kind: 'system', label: 'Claude', isDefault: false, fallbackEnabled: true,
  order: 0, status: 'logged_in', detail: null, inUse: false, ...patch,
});
const listing = [
  source({ id: 'acct-0000000002', kind: 'managed', label: 'Work', order: 1, status: 'logged_out' }),
  source({ id: 'claude', label: 'Claude', order: 0, isDefault: true, inUse: true }),
  source({ id: 'acct-0000000003', kind: 'managed', label: 'Spare', order: null, status: 'unknown' }),
  source({ id: 'codex', provider: 'codex', label: 'Codex' }),
];
const ok = (sources: AgentAccountSource[] = listing, extra: object = {}) => ({ type: 'x', requestId: 'r', ok: true, sources, ...extra });
const err = (code: string) => ({ type: 'error', requestId: 'r', ok: false, code, message: 'x', retryable: false });
const value: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };

function setup(patch: Record<string, unknown> = {}) {
  const api = {
    agentSourceAdd: vi.fn(async () => ok()), agentSourceRename: vi.fn(async () => ok()), agentSourceRemove: vi.fn(async () => ok()),
    agentSourceSetDefault: vi.fn(async () => ok()), agentSourceMove: vi.fn(async () => ok()), agentSourceSetFallback: vi.fn(async () => ok()),
    agentSourceLogin: vi.fn(async () => ok()), agentSourceLogout: vi.fn(async () => ok()), agentSourceRefresh: vi.fn(async () => ok()),
    agentSourceUsage: vi.fn(async () => ok(listing, { usage: { fetchedAt: null, stale: false, blocked: false, recoveryAt: null, error: null,
      windows: [{ label: '5h', durationMins: 300, usedPercent: 42, resetsAt: null, blocksProvider: false }] } })),
    ...patch,
  } as unknown as DesktopApi;
  render(<LocaleProvider value={value}><AgentAccountSources api={api} provider="claude" sources={listing} /></LocaleProvider>);
  return api;
}
const rowOf = (name: string) => screen.getByText(name).closest('[data-source-row]') as HTMLElement;

describe('AgentAccountSources', () => {
  it('shows the rows of one provider in order with badges', () => {
    setup();
    const labels = [...document.querySelectorAll('.account-source-label')].map((node) => node.textContent);
    expect(labels).toEqual(['Claude', 'Work', 'Spare']);
    const first = within(rowOf('Claude'));
    expect(first.getByText('系統')).toBeTruthy();
    expect(first.getByText('預設')).toBeTruthy();
    expect(first.getByText('使用中')).toBeTruthy();
    expect(first.queryByRole('button', { name: '設為預設' })).toBeNull();
    expect(first.getByRole('button', { name: '登出' })).toBeTruthy();
    expect((first.getByRole('button', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true);
    expect(first.queryByRole('button', { name: '刪除' })).toBeNull();
    const spare = within(rowOf('Spare'));
    expect((spare.getByRole('button', { name: '下移' }) as HTMLButtonElement).disabled).toBe(true);
    expect(spare.getByRole('button', { name: '刪除' })).toBeTruthy();
  });

  it('sets the default source', async () => {
    const api = setup();
    fireEvent.click(within(rowOf('Work')).getByRole('button', { name: '設為預設' }));
    await waitFor(() => expect(api.agentSourceSetDefault).toHaveBeenCalledWith('claude', 'acct-0000000002'));
  });

  it('deletes only after the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const api = setup();
    fireEvent.click(within(rowOf('Work')).getByRole('button', { name: '刪除' }));
    expect(confirm).toHaveBeenCalledWith('刪除帳號「Work」？這會刪除它的登入資料，使用它的聊天室下一則訊息改用預設帳號開新對話。');
    expect(api.agentSourceRemove).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf('Work')).getByRole('button', { name: '刪除' }));
    await waitFor(() => expect(api.agentSourceRemove).toHaveBeenCalledWith('acct-0000000002'));
  });

  it('adds an account with the trimmed label and shows the login hint', async () => {
    const api = setup();
    fireEvent.change(screen.getByLabelText('帳號名稱'), { target: { value: '  Home  ' } });
    fireEvent.click(screen.getByRole('button', { name: '新增帳號' }));
    await waitFor(() => expect(api.agentSourceAdd).toHaveBeenCalledWith('claude', 'Home'));
    expect(await screen.findByText('新增後請按「登入」完成這個帳號的登入。')).toBeTruthy();
  });

  it('shows the catalog text of an error code', async () => {
    setup({ agentSourceRemove: vi.fn(async () => err('ACCOUNT_SOURCE_IN_USE')) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('Work')).getByRole('button', { name: '刪除' }));
    expect((await screen.findByRole('alert')).textContent).toBe('這個帳號還有執行中或排隊中的工作，暫時不能刪除。');
  });

  it('shows the usage windows under the row', async () => {
    setup();
    fireEvent.click(within(rowOf('Claude')).getByRole('button', { name: '用量' }));
    expect(await screen.findByText('5h · 已用 42%')).toBeTruthy();
  });

  it('toggles the per-source fallback checkbox', async () => {
    const api = setup();
    const box = within(rowOf('Work')).getByRole('checkbox', { name: '加入自動輪替' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(api.agentSourceSetFallback).toHaveBeenCalledWith('acct-0000000002', false));
  });

  it('shows the automatic failover switch on by default and sends the change', async () => {
    const api = { agentSourceSetAutoFailover: vi.fn(async () => ({ type: 'agentSourceSetAutoFailover', requestId: 'r', ok: true, enabled: false })) } as unknown as DesktopApi;
    render(<LocaleProvider value={value}><AgentAutoFailoverSwitch api={api} enabled /></LocaleProvider>);
    const toggle = screen.getByRole('switch', { name: '自動切換來源' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/使用量已滿或來源已登出/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.agentSourceSetAutoFailover).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it('keeps the single login button when the snapshot has no account sources', () => {
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    render(<LocaleProvider value={value}><Settings api={api} headingRef={React.createRef()} initialTab="agent"
      providers={[{ provider: 'claude', status: 'logged_out', detail: null } as never]} /></LocaleProvider>);
    expect(screen.getByRole('button', { name: '登入 Claude' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新增帳號' })).toBeNull();
  });
});
