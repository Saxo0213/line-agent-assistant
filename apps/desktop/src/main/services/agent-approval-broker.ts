import { randomUUID } from 'node:crypto';
import type { AgentPermissionRepository } from '@line-agent/database';
import { BASH_COMMAND_MAX_LENGTH, decideToolUse, type ExecutionAllowlist, type WritePathEvidence } from '@line-agent/contracts';

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export type PermissionPromptResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
export interface PendingApprovalView {
  approvalId: string; jobId: string; tool: string; summary: string; deadline: string; canRemember: boolean;
}
export type AgentApprovalEvent =
  | { type: 'requested'; approval: PendingApprovalView }
  | { type: 'resolved'; approvalId: string; jobId: string; outcome: 'allowed' | 'denied' | 'timeout' | 'cancelled' };
export interface AgentApprovalBrokerDependencies {
  repository: Pick<AgentPermissionRepository, 'getExecutionPolicy' | 'listToolAllowlist' | 'addToolAllowlistEntry' | 'recordExecutionApproval'>;
  resolveWritePathEvidence(target: string, workspaceRoot: string): Promise<WritePathEvidence | null>;
  publish(event: AgentApprovalEvent): void;
  now?(): number;
  randomId?(): string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}
export class AgentApprovalBrokerError extends Error {
  constructor(public readonly code: 'APPROVAL_NOT_PENDING' | 'APPROVAL_REMEMBER_UNAVAILABLE') {
    super(code); this.name = 'AgentApprovalBrokerError';
  }
}

type Outcome = 'auto_allow' | 'auto_deny' | 'capacity' | 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'timeout' | 'timeout_allow' | 'cancelled';
interface PendingEntry {
  view: PendingApprovalView; jobId: string; sessionKey: string; policyVersion: number; timeoutAction: 'ALLOW' | 'DENY'; input: Record<string, unknown>;
  command?: string; path?: string; resolve(result: PermissionPromptResult): void; timer: unknown; signal: AbortSignal;
  abort: () => void; state: 'waiting' | 'settling' | 'done'; settlementAuditOutcome?: Outcome; cancelledDuringTimeoutAudit: boolean; work?: Promise<void>;
}
interface SessionEntry { version: number; values: Array<{ kind: 'tool' | 'bash_command'; value: string }>; touched: number }
export interface ApprovalRequestInput {
  jobId: string; sessionKey: string; workspaceRoot: string; tool: string; input: Record<string, unknown>; signal: AbortSignal;
}
/** Global cap on requests still in their automatic phase (preliminary reads, automatic decision, audit). */
export const MAX_AUTOMATIC_IN_FLIGHT = 64;
const denied = (message = 'LINEJS execution policy denied this tool.'): PermissionPromptResult => ({ behavior: 'deny', message });

export class AgentApprovalBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly inFlight = new Set<Promise<void>>();
  private automaticInFlight = 0;
  private closed = false;
  private tick = 0;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: AgentApprovalBrokerDependencies) {
    this.now = deps.now ?? Date.now;
    this.makeId = deps.randomId ?? randomUUID;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Every request is tracked in `inFlight` from admission to completion (preliminary reads, automatic decisions, audits
   * and card waits) so close() can await it. Requests not yet waiting on a card count toward MAX_AUTOMATIC_IN_FLIGHT;
   * beyond it, and after close() begins, a request is denied without any repository work.
   */
  async request(input: ApprovalRequestInput): Promise<PermissionPromptResult> {
    if (this.closed || input.signal.aborted) return denied();
    if (this.automaticInFlight >= MAX_AUTOMATIC_IN_FLIGHT) return denied('Too many concurrent approval requests.');
    this.automaticInFlight += 1;
    let automatic = true;
    const leaveAutomatic = () => { if (automatic) { automatic = false; this.automaticInFlight -= 1; } };
    const work = this.evaluate(input, leaveAutomatic);
    const tracked = work.then(() => undefined, () => undefined);
    this.inFlight.add(tracked);
    try {
      const result = await work;
      // An allow never escapes once close() has begun.
      return result.behavior === 'allow' && this.closed ? denied() : result;
    } finally {
      leaveAutomatic();
      this.inFlight.delete(tracked);
    }
  }

  private async evaluate(input: ApprovalRequestInput, leaveAutomatic: () => void): Promise<PermissionPromptResult> {
    const stopped = () => this.closed || input.signal.aborted;
    const policy = await this.deps.repository.getExecutionPolicy();
    if (stopped()) return denied();
    const session = this.sessions.get(input.sessionKey);
    if (session && session.version !== policy.version) this.sessions.delete(input.sessionKey);
    const permanent = await this.deps.repository.listToolAllowlist();
    if (stopped()) return denied();
    const sessionValues = this.sessions.get(input.sessionKey);
    if (sessionValues) sessionValues.touched = ++this.tick;
    const merged: ExecutionAllowlist = [...permanent.map(({ kind, value }) => ({ kind, value })), ...(sessionValues?.values ?? [])];
    const pathField = input.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const pathValue = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool) ? input.input[pathField] : undefined;
    const evidence = typeof pathValue === 'string' ? await this.deps.resolveWritePathEvidence(pathValue, input.workspaceRoot) : null;
    if (stopped()) return denied();
    const command = input.tool === 'Bash' && typeof input.input.command === 'string' ? input.input.command : undefined;
    const decision = decideToolUse(policy.level, merged, 'operator', input.tool, input.input, evidence);
    const path = typeof pathValue === 'string' ? pathValue : undefined;
    const detail = (outcome: Outcome, extra: Record<string, unknown> = {}) => ({ jobId: input.jobId, tool: input.tool, outcome,
      ...(command === undefined ? {} : { command }), ...(path === undefined ? {} : { path }), ...extra });
    if (decision === 'allow') {
      try { await this.deps.repository.recordExecutionApproval(detail('auto_allow'), 'system'); }
      catch { return denied(); }
      return this.closed ? denied() : { behavior: 'allow', updatedInput: input.input };
    }
    if (decision === 'deny') {
      await this.audit(detail('auto_deny'), 'system');
      return denied();
    }
    if (this.pending.size >= 32 || [...this.pending.values()].some((entry) => entry.jobId === input.jobId)) {
      await this.audit(detail('capacity'), 'system');
      return denied('Too many pending approvals.');
    }
    // From here the request waits on a card, bounded by the card caps instead of the automatic cap.
    leaveAutomatic();
    const approvalId = this.makeId();
    const deadlineMs = this.now() + policy.approvalTimeoutSeconds * 1000;
    const summary = input.tool === 'Bash' ? (command ?? '') : path !== undefined && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool)
      ? path : `${input.tool} ${JSON.stringify(input.input)}`.slice(0, 500);
    const view: PendingApprovalView = { approvalId, jobId: input.jobId, tool: input.tool, summary, deadline: new Date(deadlineMs).toISOString(),
      canRemember: !(input.tool === 'Bash' && (command?.length ?? 0) > BASH_COMMAND_MAX_LENGTH) };
    return new Promise<PermissionPromptResult>((resolve) => {
      const entry: PendingEntry = { view, jobId: input.jobId, sessionKey: input.sessionKey, policyVersion: policy.version, input: input.input,
        ...(command === undefined ? {} : { command }), ...(path === undefined ? {} : { path }), resolve, timer: undefined, signal: input.signal,
        abort: () => { void this.settle(entry, 'cancelled', 'system'); }, state: 'waiting', timeoutAction: policy.timeoutAction, cancelledDuringTimeoutAudit: false };
      this.pending.set(approvalId, entry);
      entry.timer = this.setTimer(() => { void this.settle(entry, 'timeout', 'system', entry.timeoutAction === 'ALLOW' ? 'timeout_allow' : undefined); }, Math.max(0, deadlineMs - this.now()));
      input.signal.addEventListener('abort', entry.abort, { once: true });
      this.deps.publish({ type: 'requested', approval: view });
    });
  }

  async decide(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.state !== 'waiting') throw new AgentApprovalBrokerError('APPROVAL_NOT_PENDING');
    if ((decision === 'session' || decision === 'always') && !entry.view.canRemember) throw new AgentApprovalBrokerError('APPROVAL_REMEMBER_UNAVAILABLE');
    const outcome = decision === 'session' ? 'allow_session' : decision === 'always' ? 'allow_always' : 'allow_once';
    await this.settle(entry, decision === 'deny' ? 'denied' : 'allowed', 'operator', decision === 'deny' ? 'deny' : outcome);
  }

  listPending(): PendingApprovalView[] { return [...this.pending.values()].filter((entry) => entry.state === 'waiting').map((entry) => ({ ...entry.view })); }
  cancelJob(jobId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.jobId !== jobId) continue;
      if (entry.state === 'waiting') void this.settle(entry, 'cancelled', 'system');
      else if (entry.state === 'settling' && entry.settlementAuditOutcome === 'timeout_allow') entry.cancelledDuringTimeoutAudit = true;
    }
  }
  /** Cancels waiting cards and resolves only after every in-flight request and settlement has finished. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const entry of [...this.pending.values()]) if (entry.state === 'waiting') void this.settle(entry, 'cancelled', 'system');
      this.sessions.clear();
    }
    await Promise.all([...[...this.pending.values()].map((entry) => entry.work).filter((work): work is Promise<void> => !!work), ...this.inFlight]);
  }

  /** Deny audits are best effort; once close() has begun no new audit is started. */
  private async audit(detail: Record<string, unknown>, actor: string): Promise<void> {
    if (this.closed) return;
    try { await this.deps.repository.recordExecutionApproval(detail, actor); } catch { /* best effort */ }
  }
  private async settle(entry: PendingEntry, outcome: 'allowed' | 'denied' | 'timeout' | 'cancelled', actor: string,
    auditOutcome?: Outcome): Promise<void> {
    if (entry.state !== 'waiting') return entry.work;
    entry.state = 'settling';
    this.clearTimer(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
    const effectiveAuditOutcome = auditOutcome ?? (outcome === 'allowed' ? 'allow_once' : outcome === 'denied' ? 'deny' : outcome);
    entry.settlementAuditOutcome = effectiveAuditOutcome;
    entry.work = (async () => {
      let allow = outcome === 'allowed' || effectiveAuditOutcome === 'timeout_allow';
      let finalExtra: Record<string, unknown> = {};
      try {
        if (allow && effectiveAuditOutcome === 'allow_always') {
          try { await this.deps.repository.addToolAllowlistEntry(entry.command !== undefined ? 'bash_command' : 'tool', entry.command ?? entry.view.tool, 'operator'); }
          catch { finalExtra = { rememberFailed: true }; }
        }
        await this.deps.repository.recordExecutionApproval({ jobId: entry.jobId, tool: entry.view.tool, outcome: effectiveAuditOutcome,
          ...(entry.command === undefined ? {} : { command: entry.command }), ...(entry.path === undefined ? {} : { path: entry.path }),
          ...(effectiveAuditOutcome === 'timeout' || effectiveAuditOutcome === 'timeout_allow' ? { timeoutAction: entry.timeoutAction, policyVersion: entry.policyVersion } : {}), ...finalExtra }, actor);
      } catch { if (allow) allow = false; }
      if (allow && effectiveAuditOutcome === 'allow_session') {
        const kind = entry.command !== undefined ? 'bash_command' : 'tool'; const value = entry.command ?? entry.view.tool;
        let session = this.sessions.get(entry.sessionKey);
        if (!session || session.version !== entry.policyVersion) session = { version: entry.policyVersion, values: [], touched: ++this.tick };
        session.values = session.values.filter((v) => !(v.kind === kind && v.value === value));
        session.values.push({ kind, value });
        if (session.values.length > 64) session.values.shift();
        session.touched = ++this.tick; this.sessions.delete(entry.sessionKey); this.sessions.set(entry.sessionKey, session);
        if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value!);
      }
      if (this.closed || (effectiveAuditOutcome === 'timeout_allow' && (entry.signal.aborted || entry.cancelledDuringTimeoutAudit))) allow = false;
      const resolvedOutcome = allow ? 'allowed' : outcome === 'timeout' ? 'timeout' : outcome === 'cancelled' ? 'cancelled' : 'denied';
      this.deps.publish({ type: 'resolved', approvalId: entry.view.approvalId, jobId: entry.jobId, outcome: resolvedOutcome });
      entry.resolve(allow ? { behavior: 'allow', updatedInput: entry.input } : denied(outcome === 'denied' && actor === 'operator' ? 'The user denied this tool use.' : undefined));
      entry.state = 'done'; this.pending.delete(entry.view.approvalId);
    })();
    return entry.work;
  }
}
