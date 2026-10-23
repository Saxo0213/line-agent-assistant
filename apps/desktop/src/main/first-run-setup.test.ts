import { describe, expect, it, vi } from 'vitest';
import { createFirstRunSetupSession, decideFirstRunSetup, FIRST_RUN_SETUP_FLAG, isFirstRunSetupMode } from './first-run-setup.js';

describe('first-run setup-only mode', () => {
  it('is selected only by the --first-run-setup flag', () => {
    expect(isFirstRunSetupMode(['app.exe', FIRST_RUN_SETUP_FLAG])).toBe(true);
    expect(isFirstRunSetupMode(['app.exe'])).toBe(false);
  });

  it('exits at once when a bootstrap exists and starts no services', async () => {
    const bootstrapExists = vi.fn(async () => true);
    expect(await decideFirstRunSetup({ hasLock: true, bootstrapExists })).toBe('exit');
  });

  it('exits when the single-instance lock is held without reading the bootstrap', async () => {
    const bootstrapExists = vi.fn(async () => false);
    expect(await decideFirstRunSetup({ hasLock: false, bootstrapExists })).toBe('exit');
    expect(bootstrapExists).not.toHaveBeenCalled();
  });

  it('runs the setup window when there is no bootstrap and the lock is free', async () => {
    expect(await decideFirstRunSetup({ hasLock: true, bootstrapExists: async () => false })).toBe('run');
  });

  it('stops services then exits 0 after a successful save, ignoring a later window close', async () => {
    const order: string[] = [];
    const session = createFirstRunSetupSession({ cancelProvision: () => order.push('cancel'),
      stopServices: async () => { order.push('stop'); }, exit: (code) => order.push(`exit:${code}`) });
    await session.succeeded();
    await session.windowClosed();
    expect(order).toEqual(['stop', 'exit:0']);
  });

  it('cancels the provision, stops services and exits 1 when the window closes', async () => {
    const order: string[] = [];
    const session = createFirstRunSetupSession({ cancelProvision: () => order.push('cancel'),
      stopServices: async () => { order.push('stop'); }, exit: (code) => order.push(`exit:${code}`) });
    await session.windowClosed();
    await session.windowClosed();
    await session.succeeded();
    expect(order).toEqual(['cancel', 'stop', 'exit:1']);
  });

  it('still exits when stopping services fails', async () => {
    const exit = vi.fn();
    const session = createFirstRunSetupSession({ cancelProvision: () => undefined,
      stopServices: async () => { throw new Error('stop failed'); }, exit });
    await expect(session.succeeded()).rejects.toThrow('stop failed');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
