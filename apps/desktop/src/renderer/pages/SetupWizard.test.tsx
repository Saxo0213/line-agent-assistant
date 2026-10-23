// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderWithoutLocale, screen, waitFor } from '@testing-library/react';
import { SetupWizard } from './SetupWizard.js';
import type { SetupProgressEvent } from '../../setup-protocol.js';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';

afterEach(cleanup);

function render(ui: React.ReactElement, locale: LocaleState['effectiveLocale'] = 'zh-TW') {
  const state: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null,
    retry() {}, retryRestart() {}, setPreference() {} };
  return renderWithoutLocale(ui, { wrapper: ({ children }) => <LocaleProvider value={state}>{children}</LocaleProvider> });
}

describe('first-run setup wizard (auto mode)', () => {
  const roots = { defaultAttachmentRoot: 'D:\\data\\attachments', defaultAgentWorkspace: 'D:\\data\\workspace' };

  it.each([
    ['en', 'Install database', 'Checking runtime…'],
    ['zh-TW', '安裝資料庫', '正在檢查執行環境…'],
  ] as const)('uses the startup locale %s for visible setup copy', async (locale, heading, phase) => {
    const api = { onSetupProgress: vi.fn(() => () => undefined), startEmbeddedProvision: vi.fn(() => new Promise<void>(() => undefined)) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />, locale);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(phase)).toBeTruthy();
  });

  it('starts the install on mount without a click, once even under StrictMode, with no step indicator or storage step', async () => {
    const api = { onSetupProgress: vi.fn(() => () => undefined), startEmbeddedProvision: vi.fn(() => new Promise<void>(() => undefined)) } as unknown as DesktopApi;
    render(<React.StrictMode><SetupWizard api={api} {...roots} /></React.StrictMode>);
    await waitFor(() => expect(api.startEmbeddedProvision).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: '安裝資料庫' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '安裝資料庫' })).toBeNull();
    expect(document.querySelector('.setup-steps')).toBeNull();
    expect(document.body.textContent).not.toMatch(/STEP|儲存位置|1 資料庫/);
    expect(screen.queryByDisplayValue('D:\\data\\attachments')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByLabelText('主機')).toBeNull();
  });

  it('shows phase text, a progress bar and a cancel button while installing', async () => {
    let listener: ((event: SetupProgressEvent) => void) | undefined;
    const api = { onSetupProgress: vi.fn((callback: (event: SetupProgressEvent) => void) => { listener = callback; return () => undefined; }),
      startEmbeddedProvision: vi.fn(() => new Promise<void>(() => undefined)), cancelEmbeddedProvision: vi.fn(async () => undefined) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    await waitFor(() => expect(api.startEmbeddedProvision).toHaveBeenCalledOnce());
    expect(screen.getByText('正在檢查執行環境…')).toBeTruthy();
    act(() => listener!({ phase: 'download', receivedBytes: 104857600, totalBytes: 384620317 }));
    expect(screen.getByText('正在下載資料庫檔案… 100 / 367 MB')).toBeTruthy();
    expect((screen.getByLabelText('下載進度') as HTMLProgressElement).value).toBe(104857600);
    act(() => listener!({ phase: 'database' }));
    expect(screen.getByText('正在建立資料表…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(api.cancelEmbeddedProvision).toHaveBeenCalledOnce();
  });

  it('shows the error and its code, offers 重試 and finishes after the retry succeeds', async () => {
    const api = { onSetupProgress: vi.fn(() => () => undefined), startEmbeddedProvision: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('下載的檔案驗證失敗，已刪除，請重試。'), { errorCode: 'pg_hash_mismatch' })).mockResolvedValueOnce(undefined),
    saveEmbeddedSetup: vi.fn(async () => ({ saved: true, restartRequired: true })), restartApplication: vi.fn(async () => undefined) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    expect(await screen.findByText('下載的檔案驗證失敗，已刪除，請重試。')).toBeTruthy();
    expect(screen.getByText(/^錯誤代碼：/).textContent).toBe('錯誤代碼：pg_hash_mismatch');
    expect(api.saveEmbeddedSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await waitFor(() => expect(api.restartApplication).toHaveBeenCalledOnce());
    expect(api.startEmbeddedProvision).toHaveBeenCalledTimes(2);
  });

  it('after a cancel shows 重試', async () => {
    const api = { onSetupProgress: vi.fn(() => () => undefined),
      startEmbeddedProvision: vi.fn(async () => { throw Object.assign(new Error('已取消下載。'), { errorCode: 'pg_download_cancelled' }); }) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    expect(await screen.findByRole('button', { name: '重試' })).toBeTruthy();
  });

  it('on success saves the default folders and then asks main to restart or exit, with no click', async () => {
    const order: string[] = [];
    const api = { onSetupProgress: vi.fn(() => () => undefined), startEmbeddedProvision: vi.fn(async () => { order.push('provision'); }),
      saveEmbeddedSetup: vi.fn(async () => { order.push('save'); return { saved: true, restartRequired: true }; }),
      restartApplication: vi.fn(async () => { order.push('restart'); }) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    await waitFor(() => expect(api.restartApplication).toHaveBeenCalledOnce());
    expect(api.saveEmbeddedSetup).toHaveBeenCalledWith('D:\\data\\attachments', 'D:\\data\\workspace');
    expect(order).toEqual(['provision', 'save', 'restart']);
  });

  it('retries only the save when provisioning already succeeded', async () => {
    const api = { onSetupProgress: vi.fn(() => () => undefined), startEmbeddedProvision: vi.fn(async () => undefined),
      saveEmbeddedSetup: vi.fn().mockRejectedValueOnce(new Error('設定失敗。')).mockResolvedValueOnce({ saved: true, restartRequired: true }),
      restartApplication: vi.fn(async () => undefined) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    fireEvent.click(await screen.findByRole('button', { name: '重試' }));
    await waitFor(() => expect(api.restartApplication).toHaveBeenCalledOnce());
    expect(api.startEmbeddedProvision).toHaveBeenCalledOnce();
    expect(api.saveEmbeddedSetup).toHaveBeenCalledTimes(2);
  });

  it('links to the official Visual C++ installer and offers a re-check', async () => {
    const api = { onSetupProgress: vi.fn(() => () => undefined), openExternalUrl: vi.fn(async () => ({ type: 'openExternalUrl', ok: true })),
      startEmbeddedProvision: vi.fn(async () => { throw Object.assign(new Error('x'), { errorCode: 'vc_runtime_missing' }); }) } as unknown as DesktopApi;
    render(<SetupWizard api={api} {...roots} />);
    expect(await screen.findByText('需要 Microsoft Visual C++ 執行環境')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '開啟 Microsoft 下載頁面' }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://aka.ms/vs/17/release/vc_redist.x64.exe');
    expect(screen.getByRole('button', { name: '重新檢查' })).toBeTruthy();
    expect(screen.getByText(/^錯誤代碼：/).textContent).toBe('錯誤代碼：vc_runtime_missing');
  });
});
