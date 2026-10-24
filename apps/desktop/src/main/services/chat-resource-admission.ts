import type { WorkerBinding } from '@line-agent/contracts';
import type { ChatResourceArchiveService } from './chat-resources.js';

export type ChatResourceAccountBinding = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' };

/** Keeps an account closed after invalidation until a fresh authenticated binding is ready. */
export class ChatResourceAccountAdmission {
  private readonly loginCandidates = new Map<string, Pick<WorkerBinding, 'workerInstanceId' | 'controlEpoch'>>();
  private readonly observedBindings = new Map<string, Pick<WorkerBinding, 'workerInstanceId' | 'controlEpoch'>>();
  private readonly authenticatedBindings = new Map<string, Pick<WorkerBinding, 'workerInstanceId' | 'controlEpoch'>>();
  private readonly modeReopenCandidates = new Set<string>();
  private readonly requiresFreshBinding = new Set<string>();

  constructor(private readonly archive: ChatResourceArchiveService,
    private readonly isCurrentAuthenticatedReady: (binding: ChatResourceAccountBinding) => boolean) {}

  close(accountId: string, reason: string, allowAuthenticatedModeReopen = false): void {
    if (allowAuthenticatedModeReopen) {
      if (!this.requiresFreshBinding.has(accountId)) this.modeReopenCandidates.add(accountId);
    } else {
      this.loginCandidates.delete(accountId);
      this.observedBindings.delete(accountId);
      this.authenticatedBindings.delete(accountId);
      this.modeReopenCandidates.delete(accountId);
      this.requiresFreshBinding.add(accountId);
    }
    this.archive.invalidateAccount(accountId, reason);
  }

  /** Records a newly admitted worker binding; only its subsequent successful login can reopen a hard fence. */
  observeBinding(binding: ChatResourceAccountBinding): void {
    this.observedBindings.set(binding.accountId, { workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
  }

  authenticated(binding: ChatResourceAccountBinding): void {
    const observed = this.observedBindings.get(binding.accountId);
    if (!observed || observed.workerInstanceId !== binding.workerInstanceId || observed.controlEpoch !== binding.controlEpoch) return;
    this.loginCandidates.set(binding.accountId, { workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
    this.openIfReady(binding);
  }

  ready(binding: ChatResourceAccountBinding): void { this.openIfReady(binding); }

  /** Mode acknowledgements may reuse the same authenticated worker after the new mode is applied. */
  modeReady(binding: ChatResourceAccountBinding): void {
    if (this.modeReopenCandidates.has(binding.accountId) && !this.requiresFreshBinding.has(binding.accountId)) {
      const candidate = this.loginCandidates.get(binding.accountId) ?? this.authenticatedBindings.get(binding.accountId);
      if (candidate?.workerInstanceId === binding.workerInstanceId && candidate.controlEpoch === binding.controlEpoch) this.openIfReady(binding, true);
    }
  }

  private openIfReady(binding: ChatResourceAccountBinding, allowExistingLogin = false): void {
    if (binding.mode !== 'ACTIVE_CONTROL' || !this.isCurrentAuthenticatedReady(binding)) return;
    const candidate = this.loginCandidates.get(binding.accountId);
    if (!allowExistingLogin && (!candidate || candidate.workerInstanceId !== binding.workerInstanceId
      || candidate.controlEpoch !== binding.controlEpoch)) return;
    this.loginCandidates.delete(binding.accountId);
    this.authenticatedBindings.set(binding.accountId, { workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
    this.modeReopenCandidates.delete(binding.accountId);
    this.requiresFreshBinding.delete(binding.accountId);
    this.archive.reopenAccount(binding.accountId);
  }
}
