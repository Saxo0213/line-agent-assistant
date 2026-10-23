export function createWindowLifecycle(options: { hide: () => void; closeServices: () => Promise<void>; exit: () => void; timeoutMs?: number }) {
  let state: 'running' | 'draining' | 'readyToExit' = 'running';
  return {
    onBeforeQuit(): boolean {
      if (state === 'readyToExit') return true;
      void this.quit();
      return false;
    },
    onClose(): boolean {
      if (state === 'readyToExit') return true;
      if (state === 'running') options.hide();
      return false;
    },
    async quit(): Promise<void> {
      if (state !== 'running') return;
      state = 'draining';
      await Promise.race([options.closeServices().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs ?? 8000))]);
      state = 'readyToExit';
      options.exit();
    },
  };
}
