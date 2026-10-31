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
