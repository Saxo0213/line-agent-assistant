import { describe, expect, it, vi } from 'vitest';
import { agentBridgeEnabled, isPackagedHeadlessSmoke, registerMainWindowReadyDisplay } from './startup-mode.js';

describe('packaged startup mode', () => {
  it('enables hidden startup only for the exact packaged smoke gate', () => {
    expect(isPackagedHeadlessSmoke(true, { LINE_AGENT_PACKAGED_SMOKE_HEADLESS: '1' })).toBe(true);
    expect(isPackagedHeadlessSmoke(false, { LINE_AGENT_PACKAGED_SMOKE_HEADLESS: '1' })).toBe(false);
    expect(isPackagedHeadlessSmoke(true, { LINE_AGENT_PACKAGED_SMOKE_HEADLESS: 'true' })).toBe(false);
    expect(isPackagedHeadlessSmoke(true, {})).toBe(false);
  });
});

describe('Agent bridge startup mode', () => {
  it('defaults to enabled and only disables for an explicit zero', () => {
    expect(agentBridgeEnabled({})).toBe(true);
    expect(agentBridgeEnabled({ LINE_AGENT_ENABLE_AGENTS: '1' })).toBe(true);
    expect(agentBridgeEnabled({ LINE_AGENT_ENABLE_AGENTS: '0' })).toBe(false);
  });
});

describe('main window ready display', () => {
  function createWindow() {
    let ready: (() => void) | undefined;
    const calls: string[] = [];
    return {
      calls,
      port: {
        once: vi.fn((_event: 'ready-to-show', listener: () => void) => { ready = listener; }),
        maximize: vi.fn(() => calls.push('maximize')),
        show: vi.fn(() => calls.push('show')),
      },
      fireReady: () => ready?.(),
    };
  }

  it('restores maximized normal startup only after ready-to-show', () => {
    const window = createWindow();
    registerMainWindowReadyDisplay(window.port, { headless: false, runtimeInventory: false, maximized: true });
    expect(window.calls).toEqual([]);
    window.fireReady();
    expect(window.calls).toEqual(['maximize', 'show']);
  });

  it.each([
    ['headless packaged smoke', true, false],
    ['runtime inventory', false, true],
  ])('keeps %s windows hidden', (_name, headless, runtimeInventory) => {
    const window = createWindow();
    registerMainWindowReadyDisplay(window.port, { headless, runtimeInventory, maximized: true });
    window.fireReady();
    expect(window.port.once).not.toHaveBeenCalled();
    expect(window.calls).toEqual([]);
  });
});
