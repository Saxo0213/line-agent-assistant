// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider } from '../locale-context.js';
import { ChatDownloadLocation } from './ChatDownloadLocation.js';

afterEach(() => cleanup());

const group: ConversationKey = { accountId: 'acct-1', chatType: 'group', chatId: 'group-1' };
const wrap = (api: unknown, route: ConversationKey) => render(
  <LocaleProvider value={{ status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
    <ChatDownloadLocation api={api as DesktopApi} route={route} />
  </LocaleProvider>);

describe('ChatDownloadLocation', () => {
  it('shows the fixed location and the extra folder, and maps an error code to text', async () => {
    const api = {
      getChatExtraFolder: vi.fn(async () => ({ root: null, queued: 0, claimed: 0, completed: 0, failed: 0 })),
      chooseChatExtraFolder: vi.fn(async () => ({ ok: false as const, code: 'PROTECTED_FOLDER' as const })),
      openStoredAttachmentsFolder: vi.fn(async () => true),
    };
    wrap(api, group);
    fireEvent.click(screen.getByRole('button', { name: '下載位置' }));
    expect(await screen.findByText('未設定。附件只存在固定位置。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '開啟' }));
    await waitFor(() => expect(api.openStoredAttachmentsFolder).toHaveBeenCalledWith(group));
    fireEvent.click(screen.getByRole('button', { name: '選擇資料夾' }));
    expect(await screen.findByText('不能使用系統資料夾或附件主資料夾')).toBeTruthy();
  });

  it('hides the gear for a chat type that cannot receive attachments', () => {
    wrap({}, { accountId: 'acct-1', chatType: 'community', chatId: 'c' });
    expect(screen.queryByRole('button', { name: '下載位置' })).toBeNull();
  });
});
