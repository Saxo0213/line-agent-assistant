import { createContext, useContext } from 'react';
import type { Locale, LocalePreference } from '../locale.js';

export type LocaleState = {
  status: 'loading' | 'loaded' | 'error';
  effectiveLocale: Locale | null;
  preference: LocalePreference | null;
  busy: boolean;
  error: 'load' | 'save' | 'restart' | null;
  restartChoice?: boolean;
  restartPending?: boolean;
  retry(): void;
  retryRestart(): void;
  restartNow?(): void;
  restartLater?(): void;
  setPreference(preference: LocalePreference): void;
};

const LocaleContext = createContext<LocaleState>({
  status: 'loading', effectiveLocale: null, preference: null, busy: false, error: null,
  retry() {}, retryRestart() {}, setPreference() {},
});

export const LocaleProvider = LocaleContext.Provider;
export function useLocale(): LocaleState { return useContext(LocaleContext); }
export function localeFromState(state: LocaleState): Locale { return state.effectiveLocale ?? 'en'; }
