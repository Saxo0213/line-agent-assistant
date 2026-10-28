export type DesktopCommand = 'quit' | 'restart';
export type SecondInstanceClassification = 'command' | 'ambiguous' | 'ordinary';
type State = 'starting' | 'running' | 'draining' | 'readyToExit' | 'failed';
export type DesktopLifecycleFailure = 'shutdown_failed' | 'shutdown_timeout' | 'relaunch_failed';

export function parseDesktopCommand(args: readonly string[]): DesktopCommand | null {
  const quit = args.includes('--quit');
  const restart = args.includes('--restart');
  return quit === restart ? null : quit ? 'quit' : 'restart';
}

export function routeSecondInstance(args: readonly string[], request: (command: DesktopCommand) => void,
  showWindow: () => void, observe?: (classification: SecondInstanceClassification, command?: DesktopCommand) => void): void {
  const command = parseDesktopCommand(args);
  if (command) { observe?.('command', command); request(command); }
  else if (args.includes('--quit') && args.includes('--restart')) observe?.('ambiguous');
  else { observe?.('ordinary'); showWindow(); }
}

export async function shutdownServices(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) try { await step(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures,
    `Desktop shutdown failed: ${failures.map((error) => error instanceof Error ? error.message : String(error)).join('; ')}`);
}

export function createDesktopLifecycle(options: {
  starting?: boolean; hide: () => void; closeServices: () => Promise<void>; exit: () => void;
  relaunch?: () => void; reportFailure?: (failure: DesktopLifecycleFailure) => void | Promise<void>;
  reportEvent?: (event: 'received' | 'drain-completed' | 'relaunch-scheduled' | 'exit-initiated' | 'failed', command: DesktopCommand) => void;
  timeoutMs?: number; reportTimeoutMs?: number;
}) {
  let state: State = options.starting ? 'starting' : 'running';
  let pendingCommand: DesktopCommand | undefined;
  let active: Promise<void> | undefined;

  function request(command: DesktopCommand): Promise<void> {
    options.reportEvent?.('received', command);
    if (state === 'starting') {
      if (command === 'quit' || pendingCommand === undefined) pendingCommand = command;
      return Promise.resolve();
    }
    if (state === 'failed') {
      if (command === 'quit') { state = 'readyToExit'; options.reportEvent?.('exit-initiated', command); options.exit(); }
      return active ?? Promise.resolve();
    }
    if (state === 'readyToExit' || state === 'draining') return active ?? Promise.resolve();
    active = drain(command);
    return active;
  }

  async function drain(command: DesktopCommand): Promise<void> {
    state = 'draining';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: DesktopLifecycleFailure = 'shutdown_failed';
    try {
      const completed = await Promise.race([options.closeServices().then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), options.timeoutMs ?? 45_000); })]);
      if (!completed) { failure = 'shutdown_timeout'; throw new Error('lifecycle_failure'); }
      options.reportEvent?.('drain-completed', command);
      state = 'readyToExit';
      if (command === 'restart') {
        if (!options.relaunch) throw new Error('relaunch_unavailable');
        try { options.relaunch(); } catch { failure = 'relaunch_failed'; throw new Error('lifecycle_failure'); }
        options.reportEvent?.('relaunch-scheduled', command);
      }
      options.reportEvent?.('exit-initiated', command);
      options.exit();
    } catch {
      state = 'failed';
      // Detect a missing relaunch adapter without reading any exception-derived text.
      if (command === 'restart' && state === 'failed' && failure === 'shutdown_failed' && !options.relaunch) failure = 'relaunch_failed';
      options.reportEvent?.('failed', command);
      let reportTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(() => options.reportFailure?.(failure)),
          new Promise<void>((resolve) => { reportTimer = setTimeout(resolve, options.reportTimeoutMs ?? 2_500); })]);
      } catch { /* Audit reporting cannot reopen shutdown or restart authority. */ }
      finally { if (reportTimer) clearTimeout(reportTimer); }
      if (command === 'quit') { state = 'readyToExit'; options.reportEvent?.('exit-initiated', command); options.exit(); }
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    request,
    markRunning(): void { if (state !== 'starting') return; state = 'running'; if (pendingCommand) { const command = pendingCommand; pendingCommand = undefined; void request(command); } },
    onBeforeQuit(): boolean { if (state === 'readyToExit') return true; void request('quit'); return false; },
    onClose(): boolean { if (state === 'readyToExit') return true; if (state === 'running') options.hide(); return false; },
    quit(): Promise<void> { return request('quit'); },
    /** Drains services like `quit` but leaves the exit to the caller (the updater's quit-and-install); true when it is safe to quit. */
    async prepareExit(): Promise<boolean> {
      if (state === 'readyToExit') return true;
      if (state !== 'running') return false;
      state = 'draining';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const completed = await Promise.race([options.closeServices().then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), options.timeoutMs ?? 45_000); })]);
        if (!completed) throw new Error('lifecycle_failure');
        options.reportEvent?.('drain-completed', 'quit');
        state = 'readyToExit';
        return true;
      } catch {
        state = 'failed';
        options.reportEvent?.('failed', 'quit');
        try { await options.reportFailure?.('shutdown_failed'); } catch { /* reporting must not change the outcome */ }
        return false;
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
