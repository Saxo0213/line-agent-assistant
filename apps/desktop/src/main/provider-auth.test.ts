import {describe, expect, it, vi} from 'vitest';
import {probeInitialProviderAuth} from './provider-auth.js';

describe('initial Agent provider status probe', () => {
  it('checks both official CLIs without opening a login flow', async () => {
    const getAuthStatus = vi.fn(async (provider: 'codex' | 'claude') => ({
      status: provider === 'codex' ? 'authenticated' as const : 'logged_out' as const,
    }));
    const observed: unknown[] = [];

    await probeInitialProviderAuth({getAuthStatus, report: status => observed.push(status)});

    expect(getAuthStatus).toHaveBeenCalledTimes(2);
    expect(getAuthStatus).toHaveBeenCalledWith('codex');
    expect(getAuthStatus).toHaveBeenCalledWith('claude');
    expect(observed).toEqual([
      {provider:'codex',status:'logged_in',detail:null},
      {provider:'claude',status:'logged_out',detail:null},
    ]);
  });
});
