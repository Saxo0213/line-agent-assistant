import { describe, expect, it, vi } from 'vitest';
import { createWindowLifecycle } from './tray.js';

describe('window lifecycle', () => {
  it('hides on close and bounds shutdown on Quit', async () => {
    const hide = vi.fn();
    let released = false;
    const lifecycle = createWindowLifecycle({ hide, closeServices: async () => { await new Promise<void>(() => undefined); }, exit: () => { released = true; }, timeoutMs: 5 });
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
    const lifecycle = createWindowLifecycle({ hide, closeServices, exit });
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
});
