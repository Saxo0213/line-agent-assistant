// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatTypeIcon } from './ChatTypeIcon.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';

afterEach(cleanup);

describe('ChatTypeIcon', () => {
  it.each([
    ['direct', 'Direct', 'person'],
    ['group', 'Group', 'people'],
    ['room', 'Room', 'people'],
    ['community', 'Community', 'house'],
    ['thread', 'Thread', 'bubble'],
  ])('renders the %s icon announced as %s', (chatType, label, kind) => {
    const locale: LocaleState = { status: 'loaded', effectiveLocale: 'en', preference: 'en', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
    render(<LocaleProvider value={locale}><ChatTypeIcon chatType={chatType} /></LocaleProvider>);
    const icon = screen.getByRole('img', { name: label });
    expect(icon.getAttribute('data-chat-icon')).toBe(kind);
    expect(icon.getAttribute('stroke')).toBe('currentColor');
  });

  it('uses the startup Traditional Chinese locale for its accessible label', () => {
    const locale: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
    render(<LocaleProvider value={locale}><ChatTypeIcon chatType="group" /></LocaleProvider>);
    expect(screen.getByRole('img', { name: '群組' }).getAttribute('data-chat-icon')).toBe('people');
  });
});
