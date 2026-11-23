import { describe, expect, it } from 'vitest';
import { classifyProviderFailure, providerFailureResetAt } from './failure.js';

describe('provider quota reset evidence', () => {
  it('converts an explicit Taipei reset time to UTC using the observed year', () => {
    const observed = Date.parse('2026-10-31T04:00:00.000Z');
    expect(providerFailureResetAt("You've hit your weekly limit · resets Nov 3, 12am (Asia/Taipei)", observed))
      .toBe('2026-11-02T16:00:00.000Z');
  });

  it('does not invent recovery when reset wording has no timezone', () => {
    expect(providerFailureResetAt("You've hit your weekly limit · resets Nov 3, 12am", Date.parse('2026-10-31T04:00:00Z'))).toBeUndefined();
    const failure = classifyProviderFailure('Claude', "You've hit your weekly limit · resets Nov 3, 12am", Date.parse('2026-10-31T04:00:00Z'));
    expect(failure.type === 'failed' ? failure.quotaRecoveryAt : undefined).toBeUndefined();
  });
});

describe('failure classification (same words as CliTalkAgent provider_failover.rs)', () => {
  const code = (text: string) => { const event = classifyProviderFailure('Claude', text); return event.type === 'failed' ? event.code : undefined; };
  it('checks the transient rate limit words before the quota words', () => {
    expect(code('HTTP 429 too many requests')).toBe('PROVIDER_RATE_LIMITED');
    expect(code('API overloaded, usage limit soon')).toBe('PROVIDER_RATE_LIMITED');
    expect(code('You have hit your weekly limit')).toBe('PROVIDER_LIMIT');
    expect(code('insufficient_quota')).toBe('PROVIDER_LIMIT');
  });
  it('maps only the definite logout wording to AUTH_REQUIRED', () => {
    expect(code('OAuth session expired')).toBe('AUTH_REQUIRED');
    expect(code('Invalid API key · Please run /login')).toBe('AUTH_REQUIRED');
    expect(code('authentication failed')).toBe('PROVIDER_FAILED');
    expect(code('model exploded')).toBe('PROVIDER_FAILED');
  });
});
