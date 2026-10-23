// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { localeFromState, LocaleProvider, useLocale } from './locale-context.js';

function LocaleProbe() {
  const locale = useLocale();
  return <span>{`${locale.status}:${localeFromState(locale)}:${locale.preference ?? 'unset'}`}</span>;
}

describe('locale context', () => {
  it('exposes the startup snapshot to its consumers', () => {
    render(<LocaleProvider value={{ status: 'loaded', effectiveLocale: 'ja', preference: 'automatic', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}><LocaleProbe /></LocaleProvider>);
    expect(screen.getByText('loaded:ja:automatic')).toBeTruthy();
  });

  it('uses English while the startup locale is unavailable', () => {
    render(<LocaleProbe />);
    expect(screen.getByText('loading:en:unset')).toBeTruthy();
  });
});
