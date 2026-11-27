// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AGENT_PERMISSIONS, type ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider } from '../locale-context.js';
import { ChatDownloadLocation } from './ChatDownloadLocation.js';

afterEach(() => cleanup());

const group: ConversationKey = { accountId: 'acct-1', chatType: 'group', chatId: 'group-1' };
const wrap = (api: unknown, route: ConversationKey) => render(
  <LocaleProvider value={{ status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
    <ChatDownloadLocation api={api as DesktopApi} route={route} />
  </LocaleProvider>);

const FOLDER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOLDER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const none = { queued: 0, claimed: 0, completed: 0, failed: 0 };

describe('ChatDownloadLocation', () => {
  it('shows the fixed location and the empty lists, and maps an error code to text', async () => {
    const api = {
      listChatExtraFolders: vi.fn(async () => ({ defaultFolder: null, folders: [], waitingClassification: 0, decisions: [] })),
      setDefaultChatExtraFolder: vi.fn(async () => ({ ok: false as const, code: 'PROTECTED_FOLDER' as const })),
      openStoredAttachmentsFolder: vi.fn(async () => true),
    };
    wrap(api, group);
    fireEvent.click(screen.getByRole('button', { name: '聊天室設定' }));
    expect(await screen.findByText('沒有分類資料夾。')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '開啟' })[0]!);
    await waitFor(() => expect(api.openStoredAttachmentsFolder).toHaveBeenCalledWith(group));
    fireEvent.click(screen.getByRole('button', { name: '選擇' }));
    expect(await screen.findByText('不能使用系統資料夾或附件主資料夾')).toBeTruthy();
  });

  it('lists the default folder and the classification folders with progress, hint, waiting count and decisions', async () => {
    const status = {
      defaultFolder: { folderId: FOLDER_A, root: 'D:\\Default', ...none, completed: 4 },
      folders: [{ folderId: FOLDER_B, root: 'D:\\Invoices', description: '發票', ...none, completed: 2, queued: 1, failed: 3 }],
      waitingClassification: 2,
      decisions: [{ attachmentName: 'a.png', folderName: 'Invoices', decidedBy: 'agent' as const, reason: '收據', decidedAt: '2026-11-27T01:00:00.000Z' },
        { attachmentName: 'b.pdf', folderName: null, decidedBy: 'default_failed' as const, reason: '', decidedAt: '2026-11-27T00:59:00.000Z' }],
    };
    const api = { listChatExtraFolders: vi.fn(async () => status), retryChatExtraFolders: vi.fn(async () => 3),
      setChatExtraFolderDescription: vi.fn(async () => ({ ok: true as const })), removeChatExtraFolder: vi.fn(async () => ({ ok: true as const })) };
    wrap(api, group);
    fireEvent.click(screen.getByRole('button', { name: '聊天室設定' }));
    expect(await screen.findByText('D:\\Default')).toBeTruthy();
    expect(screen.getByText('D:\\Invoices')).toBeTruthy();
    expect(screen.getByText('已複製 2・等待 1・失敗 3')).toBeTruthy();
    expect(screen.getByText(/^Agent 會依說明/)).toBeTruthy();
    expect(screen.getByText('等待分類 2')).toBeTruthy();
    expect(screen.getByText(/a\.png → Invoices/)).toBeTruthy();
    expect(screen.getByText(/b\.pdf → 只留在固定位置/)).toBeTruthy();
    const input = screen.getByDisplayValue('發票');
    fireEvent.change(input, { target: { value: '施工照片' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.setChatExtraFolderDescription).toHaveBeenCalledWith(group, FOLDER_B, '施工照片'));
    fireEvent.click(screen.getByRole('button', { name: '重試失敗' }));
    await waitFor(() => expect(api.retryChatExtraFolders).toHaveBeenCalledWith(group));
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[1]!);
    expect(screen.getByText('移除後不再複製到這個資料夾，已複製的檔案會保留。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await waitFor(() => expect(api.removeChatExtraFolder).toHaveBeenCalledWith(group, FOLDER_B));
  });

  it('disables 新增資料夾 at 10 classification folders', async () => {
    const folders = Array.from({ length: 10 }, (_, index) => ({ folderId: `cccccccc-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`, root: `D:\\F${index}`, description: '', ...none }));
    wrap({ listChatExtraFolders: vi.fn(async () => ({ defaultFolder: null, folders, waitingClassification: 0, decisions: [] })) }, group);
    fireEvent.click(screen.getByRole('button', { name: '聊天室設定' }));
    await screen.findByText('D:\\F9');
    expect((screen.getByRole('button', { name: '新增資料夾' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the gear for a chat type that cannot receive attachments', () => {
    wrap({}, { accountId: 'acct-1', chatType: 'community', chatId: 'c' });
    expect(screen.queryByRole('button', { name: '聊天室設定' })).toBeNull();
  });

  it('switches between the download folders tab and the Agent access folders tab', async () => {
    const api = {
      listChatExtraFolders: vi.fn(async () => ({ defaultFolder: null, folders: [], waitingClassification: 0, decisions: [] })),
      listProjectFolders: vi.fn(async () => ({ type: 'listProjectFolders' as const, requestId: 'r', ok: true as const, folders: [{ path: 'D:\\Project', mode: 'READ' as const }] })),
    };
    render(
      <LocaleProvider value={{ status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
        <ChatDownloadLocation api={api as unknown as DesktopApi} route={group} accessFolders />
      </LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '聊天室設定' }));
    expect(screen.getByRole('tab', { name: '下載資料夾' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('沒有分類資料夾。')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Agent 權限資料夾' }));
    expect(screen.getByRole('tab', { name: 'Agent 權限資料夾' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('D:\\Project')).toBeTruthy();
    expect(screen.queryByText('沒有分類資料夾。')).toBeNull();
    expect(api.listProjectFolders).toHaveBeenCalledWith({ accountId: 'acct-1', chatType: 'group', chatId: 'group-1' });
    fireEvent.click(screen.getByRole('tab', { name: '下載資料夾' }));
    expect(await screen.findByText('沒有分類資料夾。')).toBeTruthy();
  });

  it('shows the capability rows of a group member in the permissions tab', async () => {
    const api = {
      listChatExtraFolders: vi.fn(async () => ({ defaultFolder: null, folders: [], waitingClassification: 0, decisions: [] })),
      getAgentPermissions: vi.fn(async () => ({
        catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry })), defaults: [], rules: [], links: [], folders: [], workspaceRoot: null,
        subjects: [{ kind: 'USER' as const, mid: 'u1', displayName: '小明', grantScope: 'CHAT' as const, chatScopes: [{ chatType: 'group' as const, chatId: 'group-1' }] }],
        eligibleChats: [{ chatType: 'group' as const, chatId: 'group-1', title: '專案群' }],
      })),
    };
    render(
      <LocaleProvider value={{ status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
        <ChatDownloadLocation api={api as unknown as DesktopApi} route={group} accessFolders />
      </LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '聊天室設定' }));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['下載資料夾', 'Agent 權限資料夾', '權限設定']);
    fireEvent.click(screen.getByRole('tab', { name: '權限設定' }));
    expect(screen.getByText('Agent 在此聊天室為白名單使用者工作時的權限。')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(AGENT_PERMISSIONS.length));
    expect(api.getAgentPermissions).toHaveBeenCalledWith('acct-1');
    expect(screen.queryByRole('combobox', { name: '群組' })).toBeNull();
    expect((screen.getByRole('combobox', { name: '帳號' }) as HTMLSelectElement).value).toBe('u1');
  });
});
