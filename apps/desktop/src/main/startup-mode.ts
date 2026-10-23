export function isPackagedHeadlessSmoke(isPackaged: boolean, environment: Readonly<Record<string, string | undefined>>): boolean {
  return isPackaged && environment.LINE_AGENT_PACKAGED_SMOKE_HEADLESS === '1';
}

export function agentBridgeEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.LINE_AGENT_ENABLE_AGENTS !== '0';
}

export interface MainWindowReadyDisplayPort {
  once(event: 'ready-to-show', listener: () => void): unknown;
  maximize(): void;
  show(): void;
}

export function registerMainWindowReadyDisplay(window: MainWindowReadyDisplayPort, options: {
  headless: boolean;
  runtimeInventory: boolean;
  maximized: boolean;
}): void {
  if (options.headless || options.runtimeInventory) return;
  window.once('ready-to-show', () => {
    if (options.maximized) window.maximize();
    window.show();
  });
}
