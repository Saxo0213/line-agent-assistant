// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { WorkRecords } from './WorkRecords.js';

function renderAtLocale(ui: React.ReactNode, locale: 'en' | 'zh-TW' | 'ja' | 'ko' = 'zh-TW') {
  const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  return renderUi(<LocaleProvider value={value}>{ui}</LocaleProvider>);
}
const render = (ui: React.ReactNode) => renderAtLocale(ui);

afterEach(() => {
  cleanup();
  try { window.localStorage.removeItem('line-agent:work-records-tab'); } catch { /* ignore */ }
  document.querySelectorAll('[data-work-records-tab-style]').forEach((style) => style.remove());
});

it.each([
  ['en', 'The LINE primary device encryption key needs updating.', 'LINE requires age verification before adding this friend.'],
  ['zh-TW', 'LINE 主要裝置的加密金鑰需要更新。', 'LINE 要求完成年齡驗證後才能新增好友。'],
] as const)('shows fixed %s server error descriptions in work records', async (locale, talkText, relationText) => {
  const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })), listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
    { createdAt: '2026-10-24T10:00:00.000Z', action: 'LINE 操作失敗', code: 'LINE_TALK_E2EE_UPDATE_PRIMARY_DEVICE' },
    { createdAt: '2026-10-24T10:01:00.000Z', action: '新增使用者：加入 LINE 好友', code: 'LINE_RELATION_ADD_AGE_VALIDATION' },
  ] })) } as unknown as DesktopApi;
  renderAtLocale(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />, locale);
  fireEvent.click(screen.getByRole('tab', { name: locale === 'en' ? 'System errors' : '系統錯誤' }));
  expect(await screen.findByText(talkText)).toBeTruthy();
  expect(screen.getByText(relationText)).toBeTruthy();
});

it.each([
  ['en', 'The LINE recipient encryption key needs updating.', 'LINE has temporarily limited this request.', 'System errors'],
  ['zh-TW', 'LINE 接收端加密金鑰需要更新。', 'LINE 暫時限制此請求。', '系統錯誤'],
  ['ja', 'LINE の受信者側暗号鍵を更新する必要があります。', 'LINE によりこのリクエストが一時的に制限されています。', 'システムエラー'],
  ['ko', 'LINE 수신자 암호화 키를 업데이트해야 합니다.', 'LINE에서 이 요청을 일시적으로 제한했습니다.', '시스템 오류'],
] as const)('renders attachment and poll Talk errors in %s without server prose', async (locale, attachmentText, pollText, tab) => {
  const secret = 'token=private MID=u12345678901234567890123456789012';
  const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
    listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
      { createdAt: '2026-10-24T10:00:00.000Z', action: 'LINE 操作失敗', code: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY',
        diagnostic: { operation: 'downloadAttachment', stage: 'response', category: 'denied', recovery: 'none', upstreamCode: 84 } },
      { createdAt: '2026-10-24T10:01:00.000Z', action: 'LINE 操作失敗', code: 'LINE_TALK_EXCESSIVE_ACCESS',
        diagnostic: { operation: 'poll', stage: 'response', category: 'denied', recovery: 'none', upstreamCode: 4 } },
    ] })) } as unknown as DesktopApi;
  renderAtLocale(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />, locale);
  fireEvent.click(screen.getByRole('tab', { name: tab }));
  expect(await screen.findByText(attachmentText)).toBeTruthy();
  expect(screen.getByText(pollText)).toBeTruthy();
  expect(screen.getByText('84')).toBeTruthy();
  expect(screen.getByText('4')).toBeTruthy();
  expect(document.body.textContent).not.toContain(secret);
});

describe('WorkRecords system tabs', () => {
  it('shows fixed diagnostic detail, recovery and local reference without inventing legacy detail', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })), listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
      { createdAt: '2026-10-24T10:00:00.000Z', action: 'LINE 操作失敗', code: 'HISTORY_READ_FAILED', correlationId: 'local-reference',
        diagnostic: { operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry' } },
      { createdAt: '2026-10-24T10:01:00.000Z', action: '相簿照片下載', code: 'UNKNOWN_ERROR',
        diagnostic: { operation: 'album_list', stage: 'response', category: 'invalid_response', reason: 'response_code_invalid',
          failureKind: 'linejs_internal', upstreamCode: 102001, recovery: 'retry' } },
      { createdAt: '2026-10-24T09:00:00.000Z', action: 'LINE 操作失敗', code: 'WORKER_OPERATION_FAILED' },
    ] })) } as unknown as DesktopApi;
    renderAtLocale(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />, 'en');
    fireEvent.click(screen.getByRole('tab', { name: 'System errors' }));
    expect(await screen.findByText('history')).toBeTruthy();
    expect(screen.getAllByText('Retry this action.')).toHaveLength(2);
    expect(screen.getByText('local-reference')).toBeTruthy();
    expect(screen.getByText('LINE response code')).toBeTruthy();
    expect(screen.getByText('Native error kind')).toBeTruthy();
    expect(screen.getByText('linejs_internal')).toBeTruthy();
    expect(screen.getByText('102001')).toBeTruthy();
    expect(screen.getByText('Diagnostic detail was not recorded.')).toBeTruthy();
  });

  it('shows recorded IPC actions and a truthful legacy label without guessing an old action', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })), listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
      ...(['lineLoginQr', 'lineLogout', 'getManualUnsendWindow', undefined] as const).map((ipcAction, index) => ({
        createdAt: '2026-10-25T10:00:00.000Z', action: '系統錯誤', code: 'UNKNOWN_ERROR', correlationId: `reference-${index}`,
        diagnostic: { operation: ipcAction === 'lineLogout' ? 'revokeControl' : 'ipc', stage: 'execute', category: 'unknown', recovery: 'retry', ...(ipcAction ? { ipcAction } : {}) },
      })),
    ] })) } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);
    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    expect(await screen.findByText('lineLoginQr')).toBeTruthy();
    expect(screen.getByText('lineLogout')).toBeTruthy();
    expect(screen.getByText('getManualUnsendWindow')).toBeTruthy();
    expect(screen.getByText('未記錄操作')).toBeTruthy();
    expect(screen.getByText('reference-3')).toBeTruthy();
  });

  it('opens the stored tab and stores the tab the user selects', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })), listSystemErrors: vi.fn(async () => ({ partial: false, errors: [] })) } as unknown as DesktopApi;
    window.localStorage.setItem('line-agent:work-records-tab', 'errors');
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '系統錯誤' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('tab', { name: '系統紀錄' }));
    expect(window.localStorage.getItem('line-agent:work-records-tab')).toBe('activity');
    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    expect(window.localStorage.getItem('line-agent:work-records-tab')).toBe('errors');
    cleanup();
    window.localStorage.setItem('line-agent:work-records-tab', 'bogus');
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);
    expect(screen.getByRole('tab', { name: '系統紀錄' }).getAttribute('aria-selected')).toBe('true');
  });

  it('splits an error row into date/time, record (with reference) and operation (with recovery) columns', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })), listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
      { createdAt: '2026-10-24T10:00:00.000Z', action: 'LINE 操作失敗', code: 'HISTORY_READ_FAILED', correlationId: 'local-reference',
        diagnostic: { operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry' } },
    ] })) } as unknown as DesktopApi;
    renderAtLocale(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />, 'en');
    fireEvent.click(screen.getByRole('tab', { name: 'System errors' }));
    await screen.findByText('local-reference');
    const row = document.querySelector('#work-panel-errors .work-record-row')!;
    expect(row.classList.contains('work-record-error-row')).toBe(true);
    const time = row.querySelector('.work-record-row-meta time')!;
    expect(time.getAttribute('datetime')).toBe('2026-10-24T10:00:00.000Z');
    expect(time.querySelector('.work-record-date')?.textContent).toBeTruthy();
    expect(time.querySelector('.work-record-clock')?.textContent).toBeTruthy();
    const content = row.querySelector('.work-record-row-content')!;
    expect(content.textContent).toContain('local-reference');
    expect(content.textContent).toContain('HISTORY_READ_FAILED');
    expect(content.querySelector('dl')).toBeNull();
    const action = row.querySelector('.work-record-row-action')!;
    expect(action.querySelector('dl')).toBeTruthy();
    expect(action.textContent).toContain('history');
    expect(action.textContent).toContain('Retry this action.');
    expect(action.textContent).not.toContain('local-reference');
  });

  it('uses bottom-underline tabs and keeps keyboard selection behavior', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })) } as unknown as DesktopApi;
    const style = document.createElement('style');
    style.dataset.workRecordsTabStyle = 'true';
    style.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    document.head.append(style);
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);

    expect(screen.queryByText('WORK RECORDS')).toBeNull();
    expect(screen.queryByRole('heading', { name: '工作紀錄' })).toBeNull();
    expect(screen.queryByText('追蹤系統作業與訊息、附件的處理進度。')).toBeNull();
    const tablist = screen.getByRole('tablist', { name: '工作紀錄分類' });
    expect(document.querySelector('.work-records-page')?.firstElementChild?.classList.contains('panel')).toBe(true);
    expect(document.querySelector('.work-records-card')?.firstElementChild).toBe(tablist);
    expect(document.querySelectorAll('.work-record-column-header')).toHaveLength(1);
    expect(Array.from(document.querySelectorAll('.work-record-column-header span')).map((item) => item.textContent))
      .toEqual(['時間', '紀錄', '操作', '狀態']);
    expect(tablist.classList.contains('settings-tabs')).toBe(true);
    expect(tablist.classList.contains('segmented')).toBe(false);
    const activityTab = screen.getByRole('tab', { name: '系統紀錄' });
    expect(getComputedStyle(tablist).display).toBe('flex');
    const gridRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => rule.cssText.startsWith('.work-record-grid'));
    expect(gridRule?.cssText).toContain('180px minmax(0,1fr) 140px 96px');
    expect(activityTab.classList.contains('active')).toBe(true);
    const activeRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => rule.cssText.startsWith('.settings-tabs button.active'));
    expect(activeRule?.cssText).toContain('border-bottom: 3px solid var(--primary)');
    fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
    const errorTab = screen.getByRole('tab', { name: '系統錯誤' });
    await waitFor(() => expect(errorTab.getAttribute('aria-selected')).toBe('true'));
    expect(errorTab.classList.contains('active')).toBe(true);
    expect(api.listSystemErrors).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(errorTab, { key: 'Home' });
    await waitFor(() => expect(activityTab.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(activityTab, { key: 'End' });
    await waitFor(() => expect(errorTab.getAttribute('aria-selected')).toBe('true'));
  });

  it('shows the localized action, explanation, and raw code for system errors', async () => {
    const api = {
      listSystemActivity: vi.fn(async () => ({ partial: false, activity: [] })),
      listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
        { createdAt: '2026-10-17T10:02:00.000Z', action: 'LINE 操作失敗', code: 'INVALID_COMMAND' },
        { createdAt: '2026-10-17T10:01:00.000Z', action: 'LINE 操作失敗', code: 'HISTORY_READ_FAILED' },
      ] })),
    } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);

    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    await waitFor(() => expect(screen.getByText('INVALID_COMMAND')).toBeTruthy());
    const errorRow = document.querySelector('#work-panel-errors .work-record-row');
    expect(errorRow?.querySelector('h2')?.textContent).toBe('LINE 操作失敗');
    expect(errorRow?.querySelector('p')?.textContent).toBe('LINE 工作程序執行指令時發生錯誤');
    expect(errorRow?.querySelector('code')?.textContent).toBe('INVALID_COMMAND');
    expect(errorRow?.querySelector('.work-record-row-action')).toBeTruthy();
    expect(screen.getByText('HISTORY_READ_FAILED')).toBeTruthy();
    expect(screen.getByText('無法讀取 LINE 聊天記錄。')).toBeTruthy();
  });

  it('shows attachment activity and terminal errors only in their selected tabs', async () => {
    const api = {
      listSystemActivity: vi.fn(async () => ({ partial: false, activity: [
        { kind: 'attachment' as const, createdAt: '2026-10-17T10:01:00.000Z', action: '圖片下載', status: '等待下載', retryCount: 0,
          key: { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' } },
      ] })),
      listSystemErrors: vi.fn(async () => ({ partial: false, errors: [
        { createdAt: '2026-10-17T10:02:00.000Z', action: '附件下載', code: 'ATTACHMENT_DOWNLOAD_FAILED' },
      ] })),
    } as unknown as DesktopApi;
    const onOpen = vi.fn();
    render(<WorkRecords api={api} onOpen={onOpen} headingRef={React.createRef()} />);

    expect(screen.getByRole('tab', { name: '系統紀錄' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText('等待下載')).toBeTruthy());
    const activityRow = document.querySelector('#work-panel-activity .work-record-row');
    expect(activityRow).toBeTruthy();
    expect(activityRow?.classList.contains('work-record-grid')).toBe(true);
    expect(Array.from(activityRow?.children ?? []).map((item) => item.className.split(' ')[0]))
      .toEqual(['work-record-row-meta', 'work-record-row-content', 'work-record-row-action', 'badge']);
    expect(activityRow?.querySelector('time')).toBeTruthy();
    expect(activityRow?.querySelector('.badge')?.textContent).toBe('等待下載');
    fireEvent.click(screen.getByRole('button', { name: '查看來源訊息' }));
    expect(onOpen).toHaveBeenCalledWith({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    expect(screen.queryByText('ATTACHMENT_DOWNLOAD_FAILED')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    await waitFor(() => expect(screen.getByText('ATTACHMENT_DOWNLOAD_FAILED')).toBeTruthy());
    const errorRow = document.querySelector('#work-panel-errors .work-record-row');
    expect(errorRow).toBeTruthy();
    expect(errorRow?.querySelector('time')).toBeTruthy();
    expect(errorRow?.querySelector('.work-record-row-content')?.textContent).toContain('ATTACHMENT_DOWNLOAD_FAILED');
    expect(screen.queryByText('等待下載')).toBeNull();
    expect(api.listSystemErrors).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    await waitFor(() => expect(api.listSystemErrors).toHaveBeenCalledTimes(2));
  });

  it('does not render or fetch legacy manual work records', async () => {
    const listWorkRecords = vi.fn(async () => []);
    const api = { listWorkRecords, listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })) } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);
    await waitFor(() => expect(api.listSystemActivity).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('tab', { name: '手動工作紀錄' })).toBeNull();
    expect(screen.queryByText('手動工作紀錄')).toBeNull();
    expect(listWorkRecords).not.toHaveBeenCalled();
  });

  it('keeps header-only system lists when activity or errors are empty', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })) } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);

    await waitFor(() => expect(api.listSystemActivity).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(document.querySelector('#work-panel-activity .work-record-column-header')).toBeTruthy();
    expect(screen.queryByText('近期沒有系統紀錄。')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '系統錯誤' }));
    await waitFor(() => expect(api.listSystemErrors).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(document.querySelector('#work-panel-errors .work-record-column-header')).toBeTruthy();
    expect(screen.queryByText('近期沒有系統錯誤。')).toBeNull();
  });

  it('supports keyboard tab navigation', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })) } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: '系統紀錄' }), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '系統錯誤' }).getAttribute('aria-selected')).toBe('true'));
    expect(api.listSystemErrors).toHaveBeenCalledTimes(1);
  });

  it('uses the startup locale from LocaleProvider', () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })) } as unknown as DesktopApi;
    renderAtLocale(<WorkRecords api={api} onOpen={vi.fn()} headingRef={React.createRef()} />, 'en');
    expect(screen.getByRole('tablist', { name: 'Work record categories' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'System records' })).toBeTruthy();
  });
});
