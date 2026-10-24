import { describe, expect, it, vi } from 'vitest';
import { createDesktopLifecycle, parseDesktopCommand, routeSecondInstance, shutdownServices } from './desktop-lifecycle.js';
import { createOperationalAudit } from './services/operational-audit.js';
import type { DesktopLifecycleFailure } from './desktop-lifecycle.js';

const privateSentinel = 'injected-private-token-path-sentinel';

function auditedReporter(events: unknown[]) {
  const audit = createOperationalAudit({ append: async (event) => { events.push(event); }, appendFallback: async (event) => { events.push(event); },
    logSinkState: () => undefined });
  const report = async (failure: DesktopLifecycleFailure) => {
    audit.failure(failure === 'shutdown_timeout'
      ? { operation: 'shutdown', stage: 'shutdown', category: 'timeout', recovery: 'retry' }
      : { operation: 'shutdown', stage: 'shutdown', category: 'unknown', recovery: 'retry' });
    await audit.flush();
  };
  return report;
}

describe('desktop command parsing', () => {
  it('accepts exactly one quit or restart switch alongside the executable arguments', () => {
    expect(parseDesktopCommand(['LINE Agent Assistant.exe', '--quit'])).toBe('quit');
    expect(parseDesktopCommand(['electron.exe', '.', '--restart'])).toBe('restart');
    expect(parseDesktopCommand(['electron.exe', '.', '--no-sandbox', '--quit', '--remote-debugging-port=0'])).toBe('quit');
    expect(parseDesktopCommand(['electron.exe', '.', '--no-sandbox', '--restart', '--disable-gpu'])).toBe('restart');
    expect(parseDesktopCommand(['electron.exe', '.', '--quit', '--restart'])).toBeNull();
    expect(parseDesktopCommand(['electron.exe', '.', '--quit', '--restart', '--no-sandbox'])).toBeNull();
  });

  it('routes command invocations to lifecycle and ordinary invocations to the existing window path', () => {
    const request = vi.fn();
    const showWindow = vi.fn();
    const observe = vi.fn();
    routeSecondInstance(['desktop.exe', '.', '--no-sandbox', '--restart'], request, showWindow, observe);
    routeSecondInstance(['desktop.exe'], request, showWindow, observe);
    routeSecondInstance(['desktop.exe', '.', '--quit', '--restart'], request, showWindow, observe);
    expect(request).toHaveBeenCalledExactlyOnceWith('restart');
    expect(showWindow).toHaveBeenCalledOnce();
    expect(observe.mock.calls.map(([classification]) => classification)).toEqual(['command', 'ordinary', 'ambiguous']);
  });
});

describe('desktop command lifecycle', () => {
  it('retains a startup restart and runs it once services are ready', async () => {
    const closeServices = vi.fn(async () => undefined);
    const relaunch = vi.fn();
    const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ starting: true, hide: vi.fn(), closeServices, exit, relaunch });

    lifecycle.request('restart');
    lifecycle.markRunning();
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(closeServices).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('reports one started and completed shutdown for a routed command', async () => {
    const report = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: vi.fn(async () => undefined), exit: vi.fn(), relaunch: vi.fn(), reportEvent: report });
    lifecycle.markRunning();
    lifecycle.request('restart');
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(4));
    expect(report.mock.calls).toEqual([['received', 'restart'], ['drain-completed', 'restart'], ['relaunch-scheduled', 'restart'], ['exit-initiated', 'restart']]);
  });

  it('lets quit replace a pending startup restart', async () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ starting: true, hide: vi.fn(), closeServices: async () => undefined, exit, relaunch });

    lifecycle.request('restart');
    lifecycle.request('quit');
    lifecycle.markRunning();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('reports safe lifecycle diagnostics for shutdown rejection, timeout, and relaunch failure', async () => {
    const scenarios: Array<{ name: string; closeServices: () => Promise<void>; relaunch?: () => void; expected: DesktopLifecycleFailure }> = [
      { name: 'shutdown rejection', closeServices: async () => { throw new Error(privateSentinel); }, relaunch: vi.fn(), expected: 'shutdown_failed' },
      { name: 'shutdown timeout', closeServices: () => new Promise<void>(() => undefined), relaunch: vi.fn(), expected: 'shutdown_timeout' },
      { name: 'relaunch failure', closeServices: async () => undefined, relaunch: () => { throw new Error(privateSentinel); }, expected: 'relaunch_failed' },
    ];
    for (const scenario of scenarios) {
      const events: unknown[] = [];
      const reportFailure = vi.fn(auditedReporter(events));
      const relaunch = vi.fn(scenario.relaunch);
      const exit = vi.fn();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: scenario.closeServices, exit, relaunch,
        reportFailure, timeoutMs: 5, reportTimeoutMs: 50 });
      const startedAt = Date.now();
      await lifecycle.request('restart');
      expect(Date.now() - startedAt, scenario.name).toBeLessThan(250);
      expect(reportFailure, scenario.name).toHaveBeenCalledExactlyOnceWith(scenario.expected);
      expect(events, scenario.name).toHaveLength(1);
      expect(JSON.stringify(events), scenario.name).not.toContain(privateSentinel);
      expect(consoleError, scenario.name).not.toHaveBeenCalledWith(expect.stringContaining(privateSentinel));
      expect(exit, scenario.name).not.toHaveBeenCalled();
      if (scenario.expected !== 'relaunch_failed') expect(relaunch, scenario.name).not.toHaveBeenCalled();
      consoleError.mockRestore();
    }
  });

  it('bounds lifecycle audit waiting before final quit exit', async () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    const reportFailure = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => { throw new Error(privateSentinel); }, exit, relaunch,
      reportFailure: () => new Promise<void>(() => undefined), reportTimeoutMs: 5 });
    lifecycle.markRunning();
    const startedAt = Date.now();
    await lifecycle.request('quit');
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('stops the embedded server when facade shutdown rejects and never relaunches', async () => {
    const facadeShutdown = vi.fn(async () => { throw new Error('facade shutdown failed'); });
    const stopEmbeddedServer = vi.fn(async () => { throw new Error('embedded stop failed'); });
    const relaunch = vi.fn();
    const reportFailure = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: () => shutdownServices([
      () => facadeShutdown(), stopEmbeddedServer,
    ]), exit: vi.fn(), relaunch, reportFailure });

    lifecycle.markRunning();
    lifecycle.request('restart');
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());

    expect(facadeShutdown).toHaveBeenCalledOnce();
    expect(stopEmbeddedServer).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    expect(reportFailure.mock.calls[0]?.[0]).toBe('shutdown_failed');
  });

  it('reports a shutdown timeout without exiting or relaunching', async () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    const reportFailure = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => new Promise<void>(() => undefined),
      exit, relaunch, reportFailure, timeoutMs: 5 });
    lifecycle.request('restart');
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    expect(reportFailure).toHaveBeenCalledWith('shutdown_timeout');
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not start another shutdown or relaunch for repeated commands while draining', async () => {
    let release!: () => void;
    const closeServices = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const relaunch = vi.fn();
    const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices, exit, relaunch });
    lifecycle.markRunning();
    lifecycle.request('restart');
    lifecycle.request('restart');
    lifecycle.request('quit');
    release();
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(closeServices).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('runs drain, relaunch, and exit in order once when commands are duplicated', async () => {
    const order: string[] = [];
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => { order.push('drain'); },
      relaunch: () => { order.push('relaunch'); }, exit: () => { order.push('exit'); } });
    lifecycle.request('restart'); lifecycle.request('restart'); lifecycle.request('quit');
    await vi.waitFor(() => expect(order).toEqual(['drain', 'relaunch', 'exit']));
  });

  it('reports exit initiation before calling the terminating adapter', async () => {
    const order: string[] = [];
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => undefined,
      reportEvent: (event) => { if (event === 'exit-initiated') order.push(event); }, exit: () => { order.push('exit'); } });
    await lifecycle.request('quit');
    expect(order).toEqual(['exit-initiated', 'exit']);
  });

  it('does not relaunch and reports drain failure', async () => {
    const relaunch = vi.fn(); const failed = vi.fn(); const exit = vi.fn();
    const lifecycle = createDesktopLifecycle({ hide: vi.fn(), closeServices: async () => { throw new Error('reader_close_failed'); }, relaunch, exit, reportEvent: failed });
    await lifecycle.request('restart');
    expect(relaunch).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    expect(failed.mock.calls).toContainEqual(['failed', 'restart']);
  });
});
