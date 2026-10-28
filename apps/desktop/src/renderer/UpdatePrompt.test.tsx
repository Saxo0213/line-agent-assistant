// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render as renderUi, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../preload/api.js';
import type { UpdateCheckState } from '../update-check-protocol.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';
import { UpdatePrompt } from './UpdatePrompt.js';

afterEach(cleanup);

const base: UpdateCheckState = { enabled: true, checking: false, lastCheckedAt: null, lastCheckFailed: false, latestVersion: '1.0.280',
  releaseUrl: 'https://github.com/Saxo0213/line-agent-assistant/releases/tag/v1.0.280', available: true, ignoredVersion: null,
  download: { status: 'idle', percent: 0 }, canAutoInstall: true };

function setup(initial: Partial<UpdateCheckState> = {}) {
  let state: UpdateCheckState = { ...base, ...initial };
  let push: ((next: UpdateCheckState) => void) | undefined;
  const api = {
    getUpdateCheckState: vi.fn(async () => state),
    onUpdateCheckState: vi.fn((callback: (next: UpdateCheckState) => void) => { push = callback; return () => undefined; }),
    ignoreUpdateVersion: vi.fn(async (version: string) => (state = { ...state, ignoredVersion: version })),
    installUpdate: vi.fn(() => new Promise<UpdateCheckState>(() => undefined)),
    openUpdateReleasePage: vi.fn(async () => state),
  } as unknown as DesktopApi;
  const value: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  renderUi(<LocaleProvider value={value}><UpdatePrompt api={api} /></LocaleProvider>);
  return { api, push: (next: Partial<UpdateCheckState>) => act(() => { state = { ...state, ...next }; push?.(state); }) };
}

describe('UpdatePrompt', () => {
  it('shows the new version with 更新 and 忽略 as a polite status', async () => {
    setup();
    const card = (await screen.findByText('有新版本 v1.0.280')).closest('.update-prompt')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy();
  });

  it('stays hidden when nothing is available', async () => {
    const { api } = setup({ available: false });
    await vi.waitFor(() => expect(api.getUpdateCheckState).toHaveBeenCalled());
    expect(screen.queryByText(/有新版本/)).toBeNull();
  });

  it('hides after 忽略 for that version and prompts again for a newer one', async () => {
    const { api, push } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '忽略' }));
    expect(api.ignoreUpdateVersion).toHaveBeenCalledWith('1.0.280');
    await vi.waitFor(() => expect(screen.queryByText(/有新版本/)).toBeNull());
    push({ latestVersion: '1.0.281' });
    await screen.findByText('有新版本 v1.0.281');
  });

  it('is hidden at startup for an already ignored version', async () => {
    const { api } = setup({ ignoredVersion: '1.0.280' });
    await vi.waitFor(() => expect(api.getUpdateCheckState).toHaveBeenCalled());
    expect(screen.queryByText(/有新版本/)).toBeNull();
  });

  it('calls install on 更新 and shows progress, then the restarting message', async () => {
    const { api, push } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '更新' }));
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
    push({ download: { status: 'downloading', percent: 37 } });
    await screen.findByText('下載中… 37%');
    expect((document.querySelector('progress') as HTMLProgressElement).value).toBe(37);
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
    push({ download: { status: 'ready', percent: 100 } });
    await screen.findByText('正在重新啟動以完成更新…');
  });

  it('shows a short error with 開啟下載頁', async () => {
    const { api, push } = setup();
    await screen.findByText(/有新版本/);
    push({ download: { status: 'error', percent: 0 } });
    await screen.findByText('更新失敗');
    fireEvent.click(screen.getByRole('button', { name: '開啟下載頁' }));
    expect(api.openUpdateReleasePage).toHaveBeenCalledTimes(1);
  });

  it('says auto install is unavailable when not packaged', async () => {
    setup({ canAutoInstall: false });
    await screen.findByText('開發模式無法自動安裝，將改為開啟下載頁。');
  });
});
