import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import type { Locale } from '../../locale.js';

export function renderWithAgentLocale(ui: React.ReactElement, locale: Locale = 'zh-TW', options?: Omit<RenderOptions, 'wrapper'>) {
  const localeState: LocaleState = {
    status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null,
    retry() {}, retryRestart() {}, setPreference() {},
  };
  return render(ui, { ...options, wrapper: ({ children }) => <LocaleProvider value={localeState}>{children}</LocaleProvider> });
}
