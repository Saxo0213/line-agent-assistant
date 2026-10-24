import { describe, expect, it, vi } from 'vitest';
import { createDesktopLifecycle } from './desktop-lifecycle.js';

describe('window lifecycle', () => {
  it('hides on close and bounds shutdown on Quit', async () => {
    const hide = vi.fn();
    let released = false;
    const lifecycle = createDesktopLifecycle({ hide, closeServices: async () => { await new Promise<void>(() => undefined); }, exit: () => { released = true; }, timeoutMs: 5 });
    expect(lifecycle.onClose()).toBe(false);
    expect(hide).toHaveBeenCalledOnce();
    await lifecycle.quit();
    expect(released).toBe(true);
  });

  it('drains services once before allowing a native application quit to close windows', async () => {
    const hide = vi.fn();
    let release!: () => void;
    const closeServices = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide, closeServices, exit });
    expect(lifecycle.onBeforeQuit()).toBe(false);
    expect(lifecycle.onBeforeQuit()).toBe(false);
    expect(lifecycle.onClose()).toBe(false);
    expect(hide).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(lifecycle.onBeforeQuit()).toBe(true);
    expect(lifecycle.onClose()).toBe(true);
    expect(closeServices).toHaveBeenCalledOnce();
  });

  it('schedules one relaunch and exits only after the shared drain despite repeated commands', async () => {
    let release!: () => void;
    const closeServices = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const relaunch = vi.fn();
    const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices, relaunch, exit });

    lifecycle.request('restart');
    lifecycle.request('restart');
    lifecycle.request('quit');
    expect(closeServices).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(relaunch).toHaveBeenCalledOnce();
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    lifecycle.request('restart');
    expect(closeServices).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('does not relaunch or exit when restart drain fails', async () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    const reportFailure = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => { throw new Error('close_failed'); }, relaunch, exit, reportFailure });

    lifecycle.request('restart');
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
