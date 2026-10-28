// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AGENT_PERMISSIONS, type AgentPermissionsView, type LineAccountSummary } from '@line-agent/contracts';
import { AgentPermissions } from './AgentPermissions.js';
import type { DesktopApi } from '../../preload/api.js';
import { desktopTextFor, extraTextFor } from '../desktop-i18n.js';
import { renderWithAgentLocale } from './agentTestLocale.js';

afterEach(() => cleanup());

const account = { accountId: 'agent-1', displayName: 'Agent', status: 'connected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'AGENT' } as LineAccountSummary;
const levelCopy = {
  read_only: 'Claude：只能讀取工作區檔案與查詢 LINE 對話，不能執行命令列。Codex：唯讀沙箱。',
  workspace_write: 'Claude：可讀寫工作區內的檔案；執行命令列時會在 Agent 室跳出核可卡片（已允許的相同命令除外）。Codex：工作區可寫沙箱，可在工作區內執行命令。',
  trust: 'Claude：同工作區可寫，另外直接允許網頁工具（WebFetch／WebSearch）；命令列一樣跳卡片核可（已允許的相同命令除外）。Codex：與工作區可寫相同的沙箱。',
  full: 'Claude：不詢問，直接執行所有工具與命令列，包含工作區外的檔案。Codex：不受沙箱限制，可讀寫並執行整台電腦上的命令。請只在信任 Agent 時使用。',
};

function makeView(overrides: Partial<AgentPermissionsView> = {}): AgentPermissionsView {
  return {
    catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry })),
    defaults: [],
    subjects: [{ kind: 'USER', mid: 'u1', displayName: '小明', grantScope: 'ACCOUNT', chatScopes: [{ chatType: 'group', chatId: 'g1' }] }],
    rules: [
      { subject: { kind: 'USER', mid: 'u1' }, chatType: null, chatId: null, permission: 'records.query_current_chat', effect: 'DENY', version: 4 },
      { subject: { kind: 'USER', mid: 'u1' }, chatType: 'group', chatId: 'g1', permission: 'chat_folder.write', effect: 'ALLOW', version: 2 },
    ],
    links: [],
    folders: [],
    eligibleChats: [
      { chatType: 'group', chatId: 'g1', title: '專案群' },
      { chatType: 'group', chatId: 'g2', title: '新群組' },
      { chatType: 'direct', chatId: 'f1', title: '小明' },
    ],
    workspaceRoot: 'D:\\ws',
    ...overrides,
  };
}

function makeApi(view = makeView(), extra: Record<string, unknown> = {}) {
  return {
    getAgentExecutionPolicy: vi.fn(async () => ({ level: 'workspace_write' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 7, updatedAt: new Date(0).toISOString() })),
    setAgentExecutionPolicy: vi.fn(async () => ({ type: 'setAgentExecutionPolicy', version: 8 })),
    listAgentToolAllowlist: vi.fn(async () => []),
    removeAgentToolAllowlistEntry: vi.fn(async () => ({ type: 'removeAgentToolAllowlistEntry' })),
    clearAgentToolAllowlist: vi.fn(async () => ({ type: 'clearAgentToolAllowlist' })),
    listPendingAgentApprovals: vi.fn(async () => []),
    decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval' })),
    onEvent: vi.fn(() => () => undefined),
    getAgentPermissions: vi.fn(async () => view),
    getAgentPermissionDefaults: vi.fn(async () => ({ rules: [] })),
    setAgentPermissionDefault: vi.fn(async () => ({ type: 'setAgentPermissionDefault', version: 1 })),
    setAgentPermission: vi.fn(async () => ({ type: 'setAgentPermission', version: 1 })),
    revokeAgentWhitelistUser: vi.fn(async () => ({ type: 'revokeAgentWhitelistUser', revoked: 1 })),
    setAgentFolderLink: vi.fn(async () => ({ type: 'setAgentFolderLink', version: 1 })),
    createChatFolder: vi.fn(async () => ({ type: 'createChatFolder' })),
    openChatFolder: vi.fn(async () => ({ type: 'openChatFolder', opened: true })),
    ...extra,
  } as unknown as DesktopApi & Record<'getAgentPermissions' | 'setAgentPermission' | 'revokeAgentWhitelistUser', ReturnType<typeof vi.fn>>;
}

async function renderTab(api: DesktopApi) {
  renderWithAgentLocale(<AgentPermissions api={api} accounts={[account]} />);
  await screen.findByRole('combobox', { name: '帳號' });
}

const group = (name: string) => screen.getByRole('radiogroup', { name });

describe('AgentPermissions tab', () => {
  it.each(['en', 'ja', 'ko'] as const)('localizes all IPC and fallback permission copy and accessible names in %s', async (locale) => {
    const keys = ['permissionCurrentChat', 'permissionAllChats', 'permissionFolderRead', 'permissionFolderWrite', 'permissionLocalTools'] as const;
    for (const source of ['ipc', 'fallback'] as const) {
      const api = makeApi(makeView({ catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry, label: 'IPC label', description: 'IPC description' })) }));
      // No account uses the registry fallback, including editable future-account defaults.
      renderWithAgentLocale(<AgentPermissions api={api} accounts={source === 'ipc' ? [account] : []} />, locale);
      if (source === 'ipc') {
        await waitFor(() => expect(api.getAgentPermissions).toHaveBeenCalled());
        await screen.findByText('小明');
        const selects = screen.getAllByRole('combobox', { name: desktopTextFor(locale, 'account') });
        fireEvent.change(selects[selects.length - 1]!, { target: { value: 'u1' } });
      } else {
        await waitFor(() => expect(api.getAgentPermissionDefaults).toHaveBeenCalled());
      }
      for (const [index, key] of keys.entries()) {
        const label = desktopTextFor(locale, key);
        expect(screen.getByText(label)).toBeTruthy();
        expect(screen.getByText(desktopTextFor(locale, `${key}Description`))).toBeTruthy();
        const choices = screen.getByRole('radiogroup', { name: label });
        const deny = within(choices).getByRole('radio', { name: new RegExp(`${desktopTextFor(locale, 'deny129')}$`) });
        await waitFor(() => expect(deny).toHaveProperty('disabled', false));
        fireEvent.click(deny);
        if (source === 'ipc') await waitFor(() => expect(api.setAgentPermission).toHaveBeenCalledWith({ accountId: 'agent-1', subject: { kind: 'USER', mid: 'u1' }, chatType: 'group', chatId: 'g1', permission: AGENT_PERMISSIONS[index]!.id, effect: 'DENY', expectedVersion: index === 3 ? 2 : 0 }));
        else await waitFor(() => expect(api.setAgentPermissionDefault).toHaveBeenCalledWith({ permission: AGENT_PERMISSIONS[index]!.id, effect: 'DENY', expectedVersion: 0 }));
      }
      expect(screen.queryByText('IPC label')).toBeNull();
      cleanup();
    }
  });

  it('loads and shows the current execution level and allowlist empty state', async () => {
    await renderTab(makeApi());
    const executionCard = screen.getByRole('region', { name: 'Agent 執行權限' });
    const whitelistCard = screen.getByRole('region', { name: '白名單權限設定' });
    expect(executionCard.parentElement).toBe(whitelistCard.parentElement);
    expect(within(executionCard).getByRole('radiogroup', { name: 'Agent 執行權限選項' }).querySelector('input[value="workspace_write"]')).toHaveProperty('checked', true);
    expect(within(executionCard).queryByText('執行等級')).toBeNull();
    expect(within(executionCard).getByRole('radio', { name: '工作區可寫' })).toBeTruthy();
    expect(within(executionCard).getByRole('radio', { name: '全部放行（預設）' })).toBeTruthy();
    const allowlistButton = within(executionCard).getByRole('button', { name: '永久允許' });
    expect(allowlistButton).toBeTruthy();
    expect(within(executionCard).queryByText('尚未有永久允許的項目。')).toBeNull();
    fireEvent.click(allowlistButton);
    expect(screen.getByRole('dialog', { name: '永久允許' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('尚未有永久允許的項目。')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(allowlistButton);
    expect(within(whitelistCard).getByRole('radio', { name: '群組' })).toBeTruthy();
    expect(within(whitelistCard).getByRole('radio', { name: '個人' })).toBeTruthy();
    expect(within(whitelistCard).getByRole('combobox', { name: '群組' })).toBeTruthy();
    expect(within(whitelistCard).getByRole('combobox', { name: '帳號' })).toBeTruthy();
    expect(within(whitelistCard).queryByText('🔒 管理者：全部權限')).toBeNull();
    expect(within(whitelistCard).queryByText('資料夾')).toBeNull();
    expect(within(whitelistCard).queryByText('連結資料夾')).toBeNull();
    for (const copy of Object.values(levelCopy)) expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByText(/核可卡片可選擇允許一次/)).toBeNull();
    expect(screen.queryByText('超過時間沒有回應的核可卡片會自動拒絕。')).toBeNull();
  });

  it('saves a valid approval timeout and validates values inline', async () => {
    const api = makeApi();
    await renderTab(api);
    const field = screen.getByLabelText('核可等待時間（秒）');
    const saveButton = screen.getByRole('button', { name: '儲存' });
    expect(saveButton).toHaveProperty('disabled', true);
    fireEvent.change(field, { target: { value: '300' } });
    expect(saveButton).toHaveProperty('disabled', false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'workspace_write', approvalTimeoutSeconds: 300, timeoutAction: 'DENY', expectedVersion: 7 }));
    fireEvent.change(field, { target: { value: '9.5' } });
    expect(saveButton).toHaveProperty('disabled', true);
    expect(screen.queryByText('請輸入 10 到 900 之間的整數')).toBeNull();
  });

  it('enables timeout save only for a valid changed value or action and settles silently after save', async () => {
    let readCount = 0;
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn(async () => {
        readCount += 1;
        return { level: 'workspace_write' as const, approvalTimeoutSeconds: readCount > 1 ? 300 : 180, timeoutAction: readCount > 1 ? 'ALLOW' as const : 'DENY' as const, version: readCount > 1 ? 8 : 7, updatedAt: new Date(0).toISOString() };
      }),
    });
    await renderTab(api);
    const saveButton = screen.getByRole('button', { name: '儲存' });
    const action = screen.getByRole('combobox', { name: '超過時間動作' });
    const seconds = screen.getByLabelText('核可等待時間（秒）');
    expect(saveButton).toHaveProperty('disabled', true);
    fireEvent.change(action, { target: { value: 'ALLOW' } });
    expect(saveButton).toHaveProperty('disabled', false);
    fireEvent.change(seconds, { target: { value: 'bad' } });
    expect(saveButton).toHaveProperty('disabled', true);
    fireEvent.change(seconds, { target: { value: '300' } });
    expect(saveButton).toHaveProperty('disabled', false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'workspace_write', approvalTimeoutSeconds: 300, timeoutAction: 'ALLOW', expectedVersion: 7 }));
    await waitFor(() => expect(saveButton).toHaveProperty('disabled', true));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('loads, edits, and saves the approval timeout action with the same versioned policy', async () => {
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn(async () => ({ level: 'workspace_write' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 7, updatedAt: new Date(0).toISOString() })),
    });
    await renderTab(api);
    const action = screen.getByRole('combobox', { name: '超過時間動作' }) as HTMLSelectElement;
    expect(action.value).toBe('DENY');
    fireEvent.change(action, { target: { value: 'ALLOW' } });
    fireEvent.change(screen.getByLabelText('核可等待時間（秒）'), { target: { value: '300' } });
    const timeoutRow = document.querySelector('.perm-timeout') as HTMLElement;
    fireEvent.click(within(timeoutRow).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'workspace_write', approvalTimeoutSeconds: 300, timeoutAction: 'ALLOW', expectedVersion: 7 }));
  });

  it('reloads after a timeout policy version conflict', async () => {
    let reads = 0;
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn(async () => ({ level: reads++ > 0 ? 'trust' as const : 'workspace_write' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: reads > 1 ? 8 : 7, updatedAt: new Date(0).toISOString() })),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'error', ok: false, code: 'PERMISSION_VERSION_CONFLICT', message: 'conflict', retryable: false })),
    });
    await renderTab(api);
    fireEvent.change(screen.getByLabelText('核可等待時間（秒）'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    expect(await screen.findByText('設定已被其他變更更新，已重新載入')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '信任' })).toHaveProperty('checked', true);
  });

  it('renders tool and exact-command allowlist entries with matching delete labels', async () => {
    const api = makeApi(undefined, { listAgentToolAllowlist: vi.fn(async () => [
      { id: '33333333-3333-4333-8333-333333333333', kind: 'tool', value: 'WebFetch', createdAt: new Date(0).toISOString() },
      { id: '44444444-4444-4444-8444-444444444444', kind: 'bash_command', value: 'echo  one\n two', createdAt: new Date(0).toISOString() },
    ]) });
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('命令')).toBeTruthy();
    expect(document.querySelector('code.perm-command')?.textContent).toBe('echo  one\n two');
    expect(screen.getByRole('button', { name: '刪除永久允許的工具 WebFetch' })).toBeTruthy();
    expect(document.querySelector('[aria-label^="刪除永久允許的命令"]')?.getAttribute('aria-label')).toBe('刪除永久允許的命令 echo  one\n two');
  });

  it('reloads policy when another surface changes it', async () => {
    let callback: ((event: unknown) => void) | undefined;
    let reads = 0;
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn(async () => ({ level: reads++ > 0 ? 'trust' as const : 'workspace_write' as const, approvalTimeoutSeconds: reads > 1 ? 240 : 180, timeoutAction: reads > 1 ? 'ALLOW' as const : 'DENY' as const, version: reads > 1 ? 8 : 7, updatedAt: new Date(0).toISOString() })),
      onEvent: vi.fn((listener: (event: unknown) => void) => { callback = listener; return () => undefined; }),
    });
    await renderTab(api);
    const saveButton = screen.getByRole('button', { name: '儲存' });
    fireEvent.change(screen.getByRole('combobox', { name: '超過時間動作' }), { target: { value: 'ALLOW' } });
    fireEvent.change(screen.getByLabelText('核可等待時間（秒）'), { target: { value: '300' } });
    expect(saveButton).toHaveProperty('disabled', false);
    callback?.({ type: 'agentExecutionPolicyChanged' });
    await waitFor(() => expect(screen.getByLabelText('核可等待時間（秒）')).toHaveProperty('value', '240'));
    expect(screen.getByRole('combobox', { name: '超過時間動作' })).toHaveProperty('value', 'ALLOW');
    expect(saveButton).toHaveProperty('disabled', true);
  });

  it.each(['timeout', 'level'] as const)('defers external policy reload until an in-flight %s save finishes', async (saveKind) => {
    let changed: ((event: unknown) => void) | undefined;
    let release: (result: unknown) => void = () => undefined;
    const api = makeApi(undefined, {
      setAgentExecutionPolicy: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      onEvent: vi.fn((listener: (event: unknown) => void) => { changed = listener; return () => undefined; }),
    });
    await renderTab(api);
    if (saveKind === 'timeout') {
      fireEvent.change(screen.getByLabelText('核可等待時間（秒）'), { target: { value: '250' } });
      fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    } else {
      fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    }
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledTimes(1));
    act(() => changed?.({ type: 'agentExecutionPolicyChanged' }));
    expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(1);
    await act(async () => { release({ type: 'setAgentExecutionPolicy', version: 8 }); });
    await waitFor(() => expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(3));
  });

  it('saves a narrower level without confirmation and sends the loaded version and timeout', async () => {
    const api = makeApi();
    const confirm = vi.spyOn(window, 'confirm');
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'read_only', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', expectedVersion: 7 }));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Agent 執行權限' }).getAttribute('aria-busy')).toBe('false'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not report save success when refreshing the policy fails', async () => {
    const api = makeApi(undefined, { getAgentExecutionPolicy: vi.fn().mockResolvedValueOnce({ level: 'workspace_write', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 7, updatedAt: new Date(0).toISOString() }).mockRejectedValueOnce(new Error('reload failed')) });
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    expect((await screen.findByRole('alert')).textContent).toContain('無法載入 Agent 執行權限。');
    expect(screen.queryByText('已更新執行等級')).toBeNull();
  });

  it('confirms a wider level and cancels without saving', async () => {
    const api = makeApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '信任' }));
    expect(confirm).toHaveBeenCalledWith(`確定放寬 Agent 權限？\n\n${levelCopy.trust}`);
    expect(api.setAgentExecutionPolicy).not.toHaveBeenCalled();
  });

  it('confirms and saves a wider level', async () => {
    const api = makeApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '信任' }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'trust', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', expectedVersion: 7 }));
  });

  it('reloads policy and reports a version conflict', async () => {
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn().mockResolvedValueOnce({ level: 'workspace_write', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 7, updatedAt: new Date(0).toISOString() }).mockResolvedValueOnce({ level: 'trust', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 8, updatedAt: new Date(0).toISOString() }),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'error', ok: false, code: 'PERMISSION_VERSION_CONFLICT', message: 'conflict', retryable: false })),
    });
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    expect(await screen.findByText('設定已在其他地方變更，已重新載入')).toBeTruthy();
    expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('radio', { name: '信任' })).toHaveProperty('checked', true);
  });

  it('does not report a version conflict as reloaded when refreshing fails', async () => {
    const api = makeApi(undefined, {
      getAgentExecutionPolicy: vi.fn().mockResolvedValueOnce({ level: 'workspace_write', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 7, updatedAt: new Date(0).toISOString() }).mockRejectedValueOnce(new Error('reload failed')),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'error', ok: false, code: 'PERMISSION_VERSION_CONFLICT', message: 'conflict', retryable: false })),
    });
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    expect((await screen.findByRole('alert')).textContent).toContain('無法載入 Agent 執行權限。');
    expect(screen.queryByText('設定已在其他地方變更，已重新載入')).toBeNull();
  });

  it('shows allowlist load errors inside its dialog rather than behind the scrim', async () => {
    const api = makeApi(undefined, { listAgentToolAllowlist: vi.fn().mockRejectedValue(new Error('allowlist failed')) });
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    const dialog = screen.getByRole('dialog', { name: '永久允許' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('無法載入永久允許的工具。');
    expect(document.querySelector('.perm-execution-card .perm-message-slot [role="alert"]')).toBeNull();
  });

  it('ignores stale policy responses that resolve after a newer request', async () => {
    let releases: Array<(value: unknown) => void> = [];
    const api = makeApi(undefined, { getAgentExecutionPolicy: vi.fn(() => new Promise((resolve) => { releases.push(resolve); })) });
    const { rerender } = renderWithAgentLocale(<AgentPermissions api={api} accounts={[account]} />);
    await waitFor(() => expect(releases).toHaveLength(1));
    rerender(<AgentPermissions api={{ ...api }} accounts={[account]} />);
    await waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.({ level: 'trust', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 9, updatedAt: new Date(2).toISOString() });
    await waitFor(() => expect(screen.getByRole('radio', { name: '信任' })).toHaveProperty('checked', true));
    releases[0]?.({ level: 'read_only', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 8, updatedAt: new Date(1).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByRole('radio', { name: '信任' })).toHaveProperty('checked', true);
  });

  it('lists allowlist entries, deletes an entry, and confirms clear all', async () => {
    const firstEntry = { id: '33333333-3333-4333-8333-333333333333', kind: 'tool' as const, value: 'WebFetch', createdAt: '2026-01-02T03:04:00.000Z' };
    const lastEntry = { id: '44444444-4444-4444-8444-444444444444', kind: 'tool' as const, value: 'Read', createdAt: '2026-01-03T03:04:00.000Z' };
    let entries = [firstEntry, lastEntry];
    const api = makeApi(undefined, { listAgentToolAllowlist: vi.fn(async () => entries), removeAgentToolAllowlistEntry: vi.fn(async (id: string) => { entries = entries.filter((entry) => entry.id !== id); return { type: 'removeAgentToolAllowlistEntry' }; }) });
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    const dialog = screen.getByRole('dialog', { name: '永久允許' });
    expect(within(dialog).getByText('WebFetch')).toBeTruthy();
    expect(dialog.querySelector('time')?.getAttribute('dateTime')).toBe(firstEntry.createdAt);
    const close = within(dialog).getByRole('button', { name: '關閉永久允許' });
    const clear = within(dialog).getByRole('button', { name: '全部清除' });
    screen.getByRole('button', { name: '永久允許' }).focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    clear.focus(); fireEvent.keyDown(clear, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(clear);
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除永久允許的工具 WebFetch' }));
    await waitFor(() => expect(api.removeAgentToolAllowlistEntry).toHaveBeenCalledWith(firstEntry.id));
    await waitFor(() => expect(api.listAgentToolAllowlist).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByText('WebFetch')).toBeNull());
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '刪除永久允許的工具 Read' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除永久允許的工具 Read' }));
    await waitFor(() => expect(api.removeAgentToolAllowlistEntry).toHaveBeenCalledWith(lastEntry.id));
    await waitFor(() => expect(within(dialog).queryByText('Read')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(within(dialog).getByRole('button', { name: '全部清除' })).toHaveProperty('disabled', true);
  });

  it('moves focus to the dialog close control after clearing the only entry', async () => {
    const entry = { id: '55555555-5555-4555-8555-555555555555', kind: 'tool' as const, value: 'Read', createdAt: '2026-01-04T03:04:00.000Z' };
    const api = makeApi(undefined, {
      listAgentToolAllowlist: vi.fn(async () => entries),
      clearAgentToolAllowlist: vi.fn(async () => { entries = []; return { type: 'clearAgentToolAllowlist' }; }),
    });
    let entries = [entry];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab(api);
    const opener = screen.getByRole('button', { name: '永久允許' });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '永久允許' });
    fireEvent.click(within(dialog).getByRole('button', { name: '全部清除' }));
    await waitFor(() => expect(api.clearAgentToolAllowlist).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog).queryByText('Read')).toBeNull());
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '關閉永久允許' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('keeps remove, clear, and refresh failures visible inside the allowlist dialog', async () => {
    const entry = { id: '33333333-3333-4333-8333-333333333333', kind: 'tool' as const, value: 'WebFetch', createdAt: '2026-01-02T03:04:00.000Z' };
    const removeApi = makeApi(undefined, { listAgentToolAllowlist: vi.fn(async () => [entry]), removeAgentToolAllowlistEntry: vi.fn(async () => ({ type: 'error', code: 'REMOVE_FAILED', message: 'remove failed' })) });
    await renderTab(removeApi);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    let dialog = screen.getByRole('dialog', { name: '永久允許' });
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除永久允許的工具 WebFetch' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(extraTextFor('zh-TW', 'operationFailed'));
    expect(document.querySelector('.perm-execution-card .perm-message-slot [role="alert"]')).toBeNull();

    cleanup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const clearApi = makeApi(undefined, { listAgentToolAllowlist: vi.fn(async () => [entry]), clearAgentToolAllowlist: vi.fn(async () => ({ type: 'error', code: 'CLEAR_FAILED', message: 'clear failed' })) });
    await renderTab(clearApi);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    dialog = screen.getByRole('dialog', { name: '永久允許' });
    fireEvent.click(within(dialog).getByRole('button', { name: '全部清除' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(extraTextFor('zh-TW', 'operationFailed'));

    cleanup();
    const refreshApi = makeApi(undefined, { listAgentToolAllowlist: vi.fn().mockResolvedValueOnce([entry]).mockRejectedValueOnce(new Error('refresh failed')) });
    await renderTab(refreshApi);
    fireEvent.click(screen.getByRole('button', { name: '永久允許' }));
    dialog = screen.getByRole('dialog', { name: '永久允許' });
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除永久允許的工具 WebFetch' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('無法載入永久允許的工具。');
  });

  it('disables execution level controls while saving', async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = makeApi(undefined, { setAgentExecutionPolicy: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    await renderTab(api);
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '信任' }).matches(':disabled')).toBe(true));
    release({ type: 'setAgentExecutionPolicy', version: 8 });
    await waitFor(() => expect(screen.getByRole('radio', { name: '信任' }).matches(':disabled')).toBe(false));
  });

  it('shows scoped user rules and inherited legacy choices, without duplicate folder UI', async () => {
    await renderTab(makeApi());
    expect(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '沿用（拒絕）' })).toBeTruthy();
    expect(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' }).getAttribute('aria-checked')).toBe('false');
    expect(within(group('寫入本聊天室資料夾')).getByRole('radio', { name: '✓ 允許' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('資料夾')).toBeNull();
    expect(screen.queryByText('連結資料夾')).toBeNull();
  });

  it('shows the empty whitelist state', async () => {
    await renderTab(makeApi(makeView({ subjects: [], eligibleChats: [] })));
    expect(screen.getByRole('option', { name: '沒有群組' })).toBeTruthy();
    expect(screen.getByRole('list', { name: '白名單權限' }).querySelectorAll('.perm-row')).toHaveLength(7);
    expect(screen.queryByText('此範圍沒有可設定的白名單使用者。')).toBeNull();
    expect(screen.queryByText('尚無已啟用的 Agent 群組。')).toBeNull();
  });

  it('saves with expectedVersion and maps 沿用 to INHERIT', async () => {
    const initial = makeView();
    let releaseRefresh!: (value: AgentPermissionsView) => void;
    const refreshPending = new Promise<AgentPermissionsView>((resolve) => { releaseRefresh = resolve; });
    const api = makeApi(initial, {
      getAgentPermissions: vi.fn().mockResolvedValueOnce(initial).mockImplementationOnce(() => refreshPending),
    });
    await renderTab(api);
    fireEvent.click(within(group('查詢所有聊天室紀錄')).getByRole('radio', { name: '✓ 允許' }));
    await waitFor(() => expect(api.setAgentPermission).toHaveBeenCalledWith({ accountId: 'agent-1', subject: { kind: 'USER', mid: 'u1' }, chatType: 'group', chatId: 'g1', permission: 'records.query_all_chats', effect: 'ALLOW', expectedVersion: 0 }));
    await waitFor(() => expect(api.getAgentPermissions).toHaveBeenCalledTimes(2));
    const whitelistCard = screen.getByRole('region', { name: '白名單權限設定' });
    await waitFor(() => expect(whitelistCard.getAttribute('aria-busy')).toBe('true'));
    await act(async () => { releaseRefresh(initial); await refreshPending; });
    await waitFor(() => expect(whitelistCard.getAttribute('aria-busy')).toBe('false'));
    expect(within(group('寫入本聊天室資料夾')).getByRole('radio', { name: '沿用（允許）' })).toBeTruthy();
    fireEvent.click(within(group('寫入本聊天室資料夾')).getByRole('radio', { name: '沿用（允許）' }));
    await waitFor(() => expect(api.setAgentPermission).toHaveBeenLastCalledWith({ accountId: 'agent-1', subject: { kind: 'USER', mid: 'u1' }, chatType: 'group', chatId: 'g1', permission: 'chat_folder.write', effect: 'INHERIT', expectedVersion: 2 }));
  });

  it('changes chat/user selection and maps the chosen direct chat to the selected LINE user', async () => {
    const api = makeApi(makeView({ subjects: [
      { kind: 'USER', mid: 'u1', displayName: '小明', grantScope: 'ACCOUNT', chatScopes: [] },
      { kind: 'USER', mid: 'u2', displayName: '小華', grantScope: 'CHAT', chatScopes: [{ chatType: 'group', chatId: 'g2' }] },
    ] }));
    await renderTab(api);
    await waitFor(() => expect((screen.getByRole('combobox', { name: '群組' }) as HTMLSelectElement).value).toBe('group:g1'));
    fireEvent.change(screen.getByRole('combobox', { name: '群組' }), { target: { value: 'group:g2' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: '群組' }) as HTMLSelectElement).value).toBe('group:g2'));
    fireEvent.change(screen.getByRole('combobox', { name: '帳號' }), { target: { value: 'u2' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: '帳號' }) as HTMLSelectElement).value).toBe('u2'));
    fireEvent.click(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' }));
    await waitFor(() => expect(api.setAgentPermission).toHaveBeenCalledWith({ accountId: 'agent-1', subject: { kind: 'USER', mid: 'u2' }, chatType: 'group', chatId: 'g2', permission: 'records.query_current_chat', effect: 'DENY', expectedVersion: 0 }));

    cleanup();
    const directApi = makeApi(makeView({ subjects: [
      { kind: 'USER', mid: 'u1', displayName: '小明', grantScope: 'ACCOUNT', chatScopes: [] },
    ] }));
    await renderTab(directApi);
    fireEvent.click(screen.getByRole('radio', { name: '個人' }));
    fireEvent.click(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' }));
    await waitFor(() => expect(directApi.setAgentPermission).toHaveBeenCalledWith({ accountId: 'agent-1', subject: { kind: 'USER', mid: 'u1' }, chatType: 'direct', chatId: 'u1', permission: 'records.query_current_chat', effect: 'DENY', expectedVersion: 0 }));
  });

  it('cancels revoke without changing grants', async () => {
    const api = makeApi(makeView({ subjects: [
      { kind: 'USER', mid: 'u1', displayName: '小明', grantScope: 'ACCOUNT', chatScopes: [{ chatType: 'group', chatId: 'g1' }] },
    ] }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '撤銷' }));
    expect(window.confirm).toHaveBeenCalledWith('確定撤銷「小明」的所有 Agent 使用資格？\n\n影響範圍：全帳號（包含個人聊天）、專案群');
    expect(api.revokeAgentWhitelistUser).not.toHaveBeenCalled();
  });

  it('revokes all grants and reports success only after refreshed eligibility disappears', async () => {
    let reads = 0;
    const view = makeView();
    const api = makeApi(view, {
      getAgentPermissions: vi.fn(async () => reads++ === 0 ? view : makeView({ subjects: [] })),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '撤銷' }));
    await waitFor(() => expect(api.revokeAgentWhitelistUser).toHaveBeenCalledWith('agent-1', 'u1'));
    expect(await screen.findByText('已撤銷使用者資格（全帳號（包含個人聊天）、專案群）')).toBeTruthy();
    expect(screen.queryByRole('option', { name: '小明' })).toBeNull();
  });

  it('serializes duplicate revoke clicks and ignores its delayed refresh after a newer permission load', async () => {
    const initial = makeView({ subjects: [
      { kind: 'USER', mid: 'u1', displayName: '小明', grantScope: 'ACCOUNT', chatScopes: [] },
      { kind: 'USER', mid: 'u2', displayName: '小華', grantScope: 'ACCOUNT', chatScopes: [] },
    ] });
    let releaseRevoke: (value: unknown) => void = () => undefined;
    let releaseRevokeRefresh: (value: AgentPermissionsView) => void = () => undefined;
    const revokePending = new Promise((resolve) => { releaseRevoke = resolve; });
    const staleRefresh = new Promise<AgentPermissionsView>((resolve) => { releaseRevokeRefresh = resolve; });
    const latest = makeView({ subjects: [
      { kind: 'USER', mid: 'u2', displayName: '小華', grantScope: 'ACCOUNT', chatScopes: [] },
    ], rules: [{ subject: { kind: 'USER', mid: 'u2' }, chatType: 'group', chatId: 'g1', permission: 'records.query_current_chat', effect: 'DENY', version: 1 }] });
    let reads = 0;
    const api = makeApi(initial, {
      getAgentPermissions: vi.fn(async () => ++reads === 1 ? initial : reads === 2 ? staleRefresh : latest),
      revokeAgentWhitelistUser: vi.fn(() => revokePending),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '撤銷' }));
    fireEvent.click(screen.getByRole('button', { name: '撤銷' }));
    await waitFor(() => expect(api.revokeAgentWhitelistUser).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '撤銷' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('combobox', { name: '帳號' }), { target: { value: 'u2' } });
    releaseRevoke({ type: 'revokeAgentWhitelistUser', revoked: 1 });
    await waitFor(() => expect(api.getAgentPermissions).toHaveBeenCalledTimes(2));
    fireEvent.click(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' }));
    await waitFor(() => expect(api.setAgentPermission).toHaveBeenCalledWith(expect.objectContaining({ subject: { kind: 'USER', mid: 'u2' } })));
    await waitFor(() => expect(api.getAgentPermissions).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '帳號' })).toHaveProperty('value', 'u2'));
    expect(screen.queryByRole('option', { name: '小明' })).toBeNull();

    releaseRevokeRefresh(initial);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '帳號' })).toHaveProperty('value', 'u2'));
    expect(screen.queryByRole('option', { name: '小明' })).toBeNull();
    expect(within(group('查詢本聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows failure without claiming a revoke succeeded', async () => {
    const api = makeApi(makeView(), {
      revokeAgentWhitelistUser: vi.fn(async () => ({ type: 'error', ok: false, code: 'INVALID_CHAT', message: 'still active', retryable: false })),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab(api);
    fireEvent.click(screen.getByRole('button', { name: '撤銷' }));
    expect((await screen.findByRole('alert')).textContent).toBe('此聊天或白名單使用者已不符合權限設定資格，請重新選擇。');
    expect(screen.queryByText(/已撤銷使用者資格/)).toBeNull();
  });

  it('uses only the Agent LINE account even when a manager account is also present', async () => {
    const admin = { ...account, accountId: 'admin-1', productRole: 'PRIMARY_ADMIN' } as LineAccountSummary;
    const api = makeApi();
    renderWithAgentLocale(<AgentPermissions api={api} accounts={[admin, account]} />);
    await screen.findByRole('combobox', { name: '帳號' });
    expect(api.getAgentPermissions).toHaveBeenCalledWith('agent-1');
    expect(screen.queryByRole('combobox', { name: '管理者帳號' })).toBeNull();
  });

  it('keeps the selectors and permission rows editable as future-account defaults without an Agent account', async () => {
    const api = makeApi(undefined);
    renderWithAgentLocale(<AgentPermissions api={api} accounts={[]} />);
    await screen.findByRole('combobox', { name: '帳號' });
    expect(api.getAgentPermissionDefaults).toHaveBeenCalled();
    const header = screen.getByRole('heading', { name: '白名單權限設定' }).parentElement!;
    expect(within(header).getByRole('radio', { name: '群組' })).toBeTruthy();
    expect(within(header).getByRole('radio', { name: '個人' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '沒有群組' })).toBeTruthy();
    expect(screen.queryByText('目前沒有可選的 Agent 群組。')).toBeNull();
    fireEvent.click(within(group('寫入本聊天室資料夾')).getByRole('radio', { name: '✕ 拒絕' }));
    await waitFor(() => expect(api.setAgentPermissionDefault).toHaveBeenCalledWith({ permission: 'chat_folder.write', effect: 'DENY', expectedVersion: 0 }));
    expect(api.setAgentPermission).not.toHaveBeenCalled();
  });

  it('does not save global defaults when an existing Agent account has no eligible user', async () => {
    const api = makeApi(makeView({ subjects: [], eligibleChats: [] }));
    await renderTab(api);
    expect(within(group('寫入本聊天室資料夾')).getByRole('radio', { name: '✓ 允許' })).toHaveProperty('disabled', true);
    expect(api.setAgentPermissionDefault).not.toHaveBeenCalled();
  });

  it('disables the row while saving', async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = makeApi(makeView(), { setAgentPermission: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    await renderTab(api);
    fireEvent.click(within(group('查詢所有聊天室紀錄')).getByRole('radio', { name: '✓ 允許' }));
    await waitFor(() => expect(within(group('查詢所有聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' })).toHaveProperty('disabled', true));
    release({ type: 'setAgentPermission', version: 1 });
    await waitFor(() => expect(within(group('查詢所有聊天室紀錄')).getByRole('radio', { name: '✕ 拒絕' })).toHaveProperty('disabled', false));
  });

  it('reloads and notifies on a version conflict', async () => {
    const api = makeApi(makeView(), { setAgentPermission: vi.fn(async () => ({ type: 'error', ok: false, code: 'PERMISSION_VERSION_CONFLICT', message: 'x', retryable: false })) });
    await renderTab(api);
    expect(api.getAgentPermissions).toHaveBeenCalledTimes(1);
    fireEvent.click(within(group('查詢所有聊天室紀錄')).getByRole('radio', { name: '✓ 允許' }));
    expect(await screen.findByText('設定已被其他變更更新，已重新載入')).toBeTruthy();
    expect(api.getAgentPermissions).toHaveBeenCalledTimes(2);
  });

});
