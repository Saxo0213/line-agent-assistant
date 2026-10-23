export type StartupCleanupAction = () => void | Promise<void>;

export async function runCleanupInOrder(actions: readonly StartupCleanupAction[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { await action(); }
    catch (error) { errors.push(error); }
  }
  return errors;
}

/** Owns resources during startup and releases them in reverse activation order. */
export class StartupCleanup {
  private actions: StartupCleanupAction[] = [];
  private beforeUnwindActions: StartupCleanupAction[] = [];
  private unwindPromise: Promise<void> | undefined;
  private committed = false;

  add(action: StartupCleanupAction): void {
    if (this.committed) throw new Error('Startup cleanup ownership has already transferred');
    this.actions.push(action);
  }

  beforeUnwind(action: StartupCleanupAction): void {
    if (this.committed) throw new Error('Startup cleanup ownership has already transferred');
    this.beforeUnwindActions.push(action);
  }

  commit(): void {
    this.committed = true;
    this.actions = [];
    this.beforeUnwindActions = [];
  }

  unwind(startupError?: unknown): Promise<void> {
    if (this.committed) return Promise.resolve();
    return this.unwindPromise ??= (async () => {
      const errors: unknown[] = startupError === undefined ? [] : [startupError];
      errors.push(...await runCleanupInOrder(this.beforeUnwindActions));
      this.beforeUnwindActions = [];
      const actions = this.actions.splice(0).reverse();
      errors.push(...await runCleanupInOrder(actions));
      if (errors.length > (startupError === undefined ? 0 : 1)) {
        throw new AggregateError(errors, startupError === undefined
          ? 'Startup cleanup encountered errors'
          : 'Startup failed and cleanup encountered errors');
      }
      if (startupError !== undefined) throw startupError;
    })();
  }
}
