// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../preload/api.js';
import type { UpdateCheckState } from '../../update-check-protocol.js';
import { ENGLISH_UPDATE_COPY, JAPANESE_UPDATE_COPY, KOREAN_UPDATE_COPY, TRADITIONAL_CHINESE_UPDATE_COPY } from '../../desktop-update-copy.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { formatCheckedAt, UpdateCheckSettings } from './UpdateCheckSettings.js';

afterEach(cleanup);

const base: UpdateCheckState = { enabled: true, checking: false, lastCheckedAt: null, lastCheckFailed: false, latestVersion: null, releaseUrl: null, available: false, ignoredVersion: null, download: { status: 'idle', percent: 0 }, canAutoInstall: true };
function setup(initial: Partial<UpdateCheckState> = {}, locale: 'zh-TW' | 'en' = 'zh-TW') {
  let state: UpdateCheckState = { ...base, ...initial };
  const api = {
    getUpdateCheckState: vi.fn(async () => state),
    setUpdateCheckEnabled: vi.fn(async (enabled: boolean) => (state = { ...state, enabled, ...(enabled ? {} : { available: false, latestVersion: null }) })),
    checkForUpdateNow: vi.fn(async () => (state = { ...state, lastCheckedAt: '2026-10-28T02:00:00.000Z' })),
    openUpdateReleasePage: vi.fn(async () => state),
    installUpdate: vi.fn(async () => state),
    onUpdateCheckState: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
  const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  renderUi(<LocaleProvider value={value}><UpdateCheckSettings api={api} /></LocaleProvider>);
  return api;
}

describe('UpdateCheckSettings', () => {
  it('shows the switch on and 尚未檢查 before any check', async () => {
    setup();
    const toggle = await screen.findByRole('switch', { name: '自動檢查更新' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('尚未檢查')).toBeTruthy();
    expect(screen.queryByText('前往下載')).toBeNull();
  });

  it('shows the last check time as MM/DD HH:mm', async () => {
    setup({ lastCheckedAt: '2026-10-28T02:05:00.000Z' });
    await screen.findByText(`上次檢查：${formatCheckedAt('2026-10-28T02:05:00.000Z')}`);
    expect(formatCheckedAt('2026-10-28T02:05:00.000Z')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('shows 檢查失敗 when the last check failed', async () => {
    setup({ lastCheckedAt: '2026-10-28T02:05:00.000Z', lastCheckFailed: true });
    await screen.findByText('檢查失敗');
  });

  it('shows the latest version and opens the release page only when an update is available', async () => {
    const api = setup({ available: true, latestVersion: '1.0.280', releaseUrl: 'https://github.com/Saxo0213/line-agent-assistant/releases/tag/v1.0.280' });
    await screen.findByText('最新版本 1.0.280');
    fireEvent.click(screen.getByRole('button', { name: '前往下載' }));
    expect(api.openUpdateReleasePage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('toggles the switch and checks on demand, also while the switch is off', async () => {
    const api = setup({ enabled: false });
    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '立即檢查' }));
    expect(api.checkForUpdateNow).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    expect(api.setUpdateCheckEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('disables 立即檢查 and shows progress while checking', async () => {
    setup({ checking: true });
    const button = await screen.findByRole('button', { name: '立即檢查' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('檢查中…')).toBeTruthy();
  });

  it('renders English copy', async () => {
    setup({}, 'en');
    await screen.findByRole('switch', { name: ENGLISH_UPDATE_COPY.autoCheck });
    expect(screen.getByText(ENGLISH_UPDATE_COPY.neverChecked)).toBeTruthy();
  });
});

describe('update copy catalogs', () => {
  it('keep every key and placeholder in all four locales', () => {
    const slots = (text: string) => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();
    for (const catalog of [TRADITIONAL_CHINESE_UPDATE_COPY, JAPANESE_UPDATE_COPY, KOREAN_UPDATE_COPY]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(ENGLISH_UPDATE_COPY).sort());
      for (const key of Object.keys(ENGLISH_UPDATE_COPY) as Array<keyof typeof ENGLISH_UPDATE_COPY>) {
        expect(catalog[key].trim(), key).not.toBe('');
        expect(slots(catalog[key]), key).toEqual(slots(ENGLISH_UPDATE_COPY[key]));
      }
    }
  });
});
