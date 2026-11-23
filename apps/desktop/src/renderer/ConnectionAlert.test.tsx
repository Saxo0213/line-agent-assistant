// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '@line-agent/contracts';
import { ConnectionAlert } from './ConnectionAlert.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';

afterEach(cleanup);

const value: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
const account = (patch: Record<string, unknown>) => ({ accountId: 'a1', displayName: 'AgentDemo', status: 'degraded', productRole: 'AGENT', mode: 'MONITOR_ONLY', lastSyncedAt: null, ...patch }) as unknown as AppSnapshot['accounts'][number];
const show = (accounts: AppSnapshot['accounts'], onView = vi.fn()) => { render(<LocaleProvider value={value}><ConnectionAlert accounts={accounts} onView={onView} /></LocaleProvider>); return onView; };

describe('ConnectionAlert', () => {
  it('shows one line for a degraded Agent and opens Settings through 查看', () => {
    const onView = show([account({})]);
    const card = screen.getByText('AgentDemo帳號連線異常').closest('.connection-alert')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for connected accounts or an externally monitored Primary Admin', () => {
    show([account({ status: 'connected' }), account({ accountId: 'p1', productRole: 'PRIMARY_ADMIN', status: 'degraded', externalImportProgress: { stage: 'monitoring' } })]);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
