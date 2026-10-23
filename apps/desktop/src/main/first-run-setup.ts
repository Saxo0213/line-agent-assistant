/** Installer-time setup-only mode: `LINE Agent Assistant.exe --first-run-setup`. No LINE worker, MCP server, tray or other service runs. */
export const FIRST_RUN_SETUP_FLAG = '--first-run-setup';

export const isFirstRunSetupMode = (argv: readonly string[]): boolean => argv.includes(FIRST_RUN_SETUP_FLAG);

/** An existing bootstrap (upgrade or reinstall) or a held single-instance lock ends the mode at once with exit code 0. */
export async function decideFirstRunSetup(options: { hasLock: boolean; bootstrapExists(): Promise<boolean> }): Promise<'exit' | 'run'> {
  if (!options.hasLock) return 'exit';
  return await options.bootstrapExists() ? 'exit' : 'run';
}

/**
 * Lifecycle of the single setup-only window. Success: services stop cleanly, exit 0.
 * Window closed first: cancel the provision, stop anything started, exit 1. Only the first outcome counts.
 */
export function createFirstRunSetupSession(options: { cancelProvision(): void; stopServices(): Promise<void>; exit(code: number): void }) {
  let outcome: 'success' | 'closed' | null = null;
  const finish = async (code: number) => {
    try { await options.stopServices(); } finally { options.exit(code); }
  };
  return {
    async succeeded(): Promise<void> {
      if (outcome) return;
      outcome = 'success';
      await finish(0);
    },
    async windowClosed(): Promise<void> {
      if (outcome) return;
      outcome = 'closed';
      options.cancelProvision();
      await finish(1);
    },
  };
}
