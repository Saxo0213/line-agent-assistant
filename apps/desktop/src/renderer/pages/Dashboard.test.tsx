// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderPage, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentHealth } from '@line-agent/contracts';
import { LocaleProvider } from '../locale-context.js';
import type { Locale } from '../../locale.js';
import { Dashboard } from './Dashboard.js';

afterEach(cleanup);

function render(ui: React.ReactElement, locale: Locale = 'zh-TW') {
  return renderPage(<LocaleProvider value={{ status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>{ui}</LocaleProvider>);
}

function health(name: ComponentHealth['name'], status: ComponentHealth['status'], message: string | null = null): ComponentHealth {
  return { name, status, message, lastSuccessAt: null, restartCount: 0 };
}

describe('Dashboard health alerts', () => {
  it('uses the startup locale for its visible copy', () => {
    const props = { components: [health('database', 'degraded', 'PostgreSQL unavailable'), health('lineWorker', 'ready')], accounts: [], onSettings: vi.fn(), headingRef: React.createRef<HTMLHeadingElement>() };
    render(<Dashboard {...props} />, 'en');
    expect(screen.getByRole('alert').textContent).toContain('Database disconnected');
    cleanup();
    render(<Dashboard {...props} />, 'zh-TW');
    expect(screen.getByRole('alert').textContent).toContain('資料庫未連線');
  });
  it('shows worker recovery status without claiming the database is disconnected', () => {
    const onSettings = vi.fn();
    render(<Dashboard components={[health('database', 'ready'), health('lineWorker', 'stopped', 'LINE workers temporarily unavailable')]} accounts={[{ accountId: 'account-1', displayName: 'Agent', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' }]} onSettings={onSettings} headingRef={React.createRef()} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/個 LINE 帳號已連線/)).toBeNull();
    expect(screen.getByText('暫時無法使用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '檢查設定' })).toBeNull();
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('shows a neutral LINE login prompt when no account is connected and the worker is stopped', () => {
    const onSettings = vi.fn();
    render(<Dashboard components={[health('database', 'ready'), health('lineWorker', 'stopped', 'LINE workers temporarily unavailable')]} accounts={[]} onSettings={onSettings} headingRef={React.createRef()} />);

    expect(screen.getByText('尚未登入 LINE 帳號')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '檢查設定' })).toBeNull();
    expect(document.querySelector('.status-dot.neutral')).toBeTruthy();
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('keeps degraded worker health actionable when no account is connected', () => {
    const onSettings = vi.fn();
    render(<Dashboard components={[health('database', 'ready'), health('lineWorker', 'degraded', 'LINE worker restarting')]} accounts={[]} onSettings={onSettings} headingRef={React.createRef()} />);

    expect(screen.getByText('暫時無法使用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '檢查設定' })).toBeNull();
  });

  it('shows the database alert when database health is not ready', () => {
    const onSettings = vi.fn();
    render(<Dashboard components={[health('database', 'degraded', 'PostgreSQL unavailable'), health('lineWorker', 'ready')]} accounts={[]} onSettings={onSettings} headingRef={React.createRef()} />);

    expect(screen.getByRole('alert').textContent).toContain('資料庫未連線');
    fireEvent.click(screen.getAllByRole('button', { name: '檢查設定' })[0]!);
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
