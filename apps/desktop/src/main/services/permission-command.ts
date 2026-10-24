import { randomUUID } from 'node:crypto';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import type { AgentExecutionLevel, LineWorkerCommand, LineWorkerEvent } from '@line-agent/contracts';
import { AgentPermissionError, type AgentPermissionRepository } from '@line-agent/database';
import type { RoomAutomationTransport } from './room-automation.js';
import type { Locale } from '../../locale.js';
import { linePrompt } from './line-prompts.js';

type Envelope = Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number];
type SendTextCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
/** The same transport object the facade gives RoomAutomationService. */
export type PermissionCommandTransport = RoomAutomationTransport;
/**
 * One pending question per (accountId, chatId). An entry is armed only after its prompt reply was confirmed
 * sent, so a message classified before the user could have seen the question is never claimed.
 * A choose entry's policyVersion stays null until its list read succeeded; it is armed only after that.
 */
type ChoosePending = { id: number; stage: 'choose'; armed: boolean; expiresAt: number; policyVersion: number | null };
type ConfirmPending = { id: number; stage: 'confirm'; armed: boolean; expiresAt: number; policyVersion: number; level: AgentExecutionLevel };
type Pending = ChoosePending | ConfirmPending;
type Queued = { envelope: Envelope; ticket: PermissionTicket };
export type PermissionTicket =
  | { kind: 'list' }
  | { kind: 'reply'; pendingId: number }
  | { kind: 'clear'; pendingId: number };
export type PermissionCommandOptions = {
  onDiagnostic?: (diagnostic: SafeDiagnostic) => void;
  now?: () => number;
  onPolicyChanged?: () => void;
  locale?: Locale | string;
};

const PENDING_TTL_MS = 120_000;
const PENDING_LIMIT = 64;
const CHAT_QUEUE_LIMIT = 4;
const GLOBAL_QUEUE_LIMIT = 64;
const levels: readonly AgentExecutionLevel[] = ['read_only', 'workspace_write', 'trust', 'full'];
const promptKeys: Record<AgentExecutionLevel, 'permissionReadOnly' | 'permissionWorkspaceWrite' | 'permissionTrust' | 'permissionFull'> = {
  read_only: 'permissionReadOnly', workspace_write: 'permissionWorkspaceWrite', trust: 'permissionTrust', full: 'permissionFull',
};
const choices = new Map<string, AgentExecutionLevel>([
  ['1', 'read_only'], ['2', 'workspace_write'], ['3', 'trust'], ['4', 'full'],
  ['１', 'read_only'], ['２', 'workspace_write'], ['３', 'trust'], ['４', 'full'],
]);
const keyOf = (envelope: Envelope) => `${envelope.accountId}\0${envelope.chatId}`;
const isCommand = (text: string) => /^(\/權限|\/permissions)$/i.test(text);
const isConfirmation = (text: string) => text === '確認' || text === '是' || /^yes$/i.test(text);

/** True when the message belongs to the permission dialogue and must not reach an Agent. */
export const claimed = (ticket: PermissionTicket | null): boolean => ticket?.kind === 'list' || ticket?.kind === 'reply';

/**
 * In-memory `/權限` dialogue for the primary administrator's direct chat.
 * classify() is pure and only reads committed state while a batch is routed. enqueue() is called for admitted
 * messages only, in order; a bounded per-chat runner then owns every pending transition, so duplicates and
 * failed ingestion never move the dialogue.
 *
 * A runner keeps its queue slot until every underlying repository or transport promise has really settled, so
 * the 4-per-chat and 64-overall caps count in-flight operations. The bounds come from the layers below: the
 * repository runs each policy read/write under a PostgreSQL statement_timeout (commit or rollback, never
 * both), and the gateway send has its own response timeout and is cancelled through this service's signal.
 */
export class PermissionCommandService {
  private readonly pending = new Map<string, Pending>();
  private readonly queues = new Map<string, Queued[]>();
  private readonly runners = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly onPolicyChanged: (() => void) | undefined;
  private readonly locale: Locale | string;
  private readonly onDiagnostic: PermissionCommandOptions['onDiagnostic'];
  private queued = 0;
  private nextId = 1;

  constructor(private readonly repository: Pick<AgentPermissionRepository, 'getExecutionPolicy' | 'setExecutionPolicy'>,
    private readonly transport: PermissionCommandTransport, options: PermissionCommandOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onPolicyChanged = options.onPolicyChanged;
    this.locale = options.locale ?? 'en';
    this.onDiagnostic = options.onDiagnostic;
  }

  private label(level: AgentExecutionLevel): string { return linePrompt(this.locale, promptKeys[level]); }

  private get closed(): boolean { return this.abort.signal.aborted; }

  /** Test-visible retained work. `queued` includes the ticket each runner is processing. */
  sizes(): { queued: number; runners: number; pending: number } {
    return { queued: this.queued, runners: this.runners.size, pending: this.pending.size };
  }

  classify(envelope: Envelope, isPrimaryAdmin: boolean): PermissionTicket | null {
    if (this.closed || !isPrimaryAdmin || envelope.chatType !== 'direct' || envelope.ingestion.source !== 'live'
      || envelope.kind !== 'text' || envelope.text === null) return null;
    const text = envelope.text.trim();
    if (isCommand(text)) return { kind: 'list' };
    const pending = this.pending.get(keyOf(envelope));
    if (!pending || !pending.armed || pending.expiresAt <= this.now()) return null;
    if (pending.stage === 'confirm' || choices.has(text)) return { kind: 'reply', pendingId: pending.id };
    return { kind: 'clear', pendingId: pending.id };
  }

  /**
   * Queues the dialogue effect of an admitted message. Synchronous; never sends or waits.
   * Beyond 4 tickets per chat or 64 overall (in-flight included) the new ticket is dropped without a reply or write.
   */
  enqueue(envelope: Envelope, ticket: PermissionTicket): void {
    if (this.closed) return;
    const key = keyOf(envelope);
    const queue = this.queues.get(key) ?? [];
    if (queue.length >= CHAT_QUEUE_LIMIT || this.queued >= GLOBAL_QUEUE_LIMIT) return;
    queue.push({ envelope, ticket });
    this.queued += 1;
    this.queues.set(key, queue);
    if (!this.runners.has(key)) this.runners.set(key, this.drain(key, queue));
  }

  /**
   * Stops admission, drops tickets that have not started, aborts in-flight sends and waits for in-flight
   * operations to settle. No reply is sent once close() began; a write already in flight may still commit.
   * After the returned promise resolves no repository or transport call happens again.
   */
  async close(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    for (const queue of this.queues.values()) this.queued -= queue.splice(1).length;
    await Promise.allSettled([...this.runners.values()]);
  }

  private async drain(key: string, queue: Queued[]): Promise<void> {
    await Promise.resolve(); // Let enqueue() register this runner before it can finish.
    try {
      while (!this.closed && queue.length) {
        const { envelope, ticket } = queue[0]!;
        try { await this.run(key, envelope, ticket); } catch { /* run() answers its own failures. */ }
        queue.shift();
        this.queued -= 1;
      }
    } finally {
      // Tickets left behind by close() never started. The empty check above and this removal run in one turn,
      // so a concurrent enqueue() starts a new runner instead of joining a finished one.
      this.queued -= queue.length;
      queue.length = 0;
      if (this.queues.get(key) === queue) this.queues.delete(key);
      this.runners.delete(key);
    }
  }

  private create<T extends Pending>(key: string, entry: Omit<T, 'id' | 'armed' | 'expiresAt'>): T {
    const pending = { ...entry, id: this.nextId++, armed: false, expiresAt: this.now() + PENDING_TTL_MS } as T;
    this.pending.delete(key);
    this.pending.set(key, pending);
    if (this.pending.size > PENDING_LIMIT) {
      const now = this.now();
      for (const [other, entry] of this.pending) if (other !== key && entry.expiresAt <= now) this.pending.delete(other);
    }
    while (this.pending.size > PENDING_LIMIT) this.pending.delete(this.pending.keys().next().value!);
    return pending;
  }

  private current(key: string, pending: Pending): boolean {
    return !this.closed && this.pending.get(key) === pending;
  }

  /**
   * Sends one reply through the shared transport, validated like RoomAutomationService.sendOnce.
   * Returns true only for a confirmed `sent` result of this request on the current binding; anything else,
   * including failed, unknown, cancelled, a throw, a binding mismatch or close, counts as not sent.
   */
  private async reply(envelope: Envelope, text: string): Promise<boolean> {
    if (this.closed) return false;
    try {
      const binding = await this.transport.activeBinding(envelope.accountId);
      if (this.closed || !binding || binding.accountId !== envelope.accountId) return false;
      if (!await this.transport.isCurrentControl(binding) || this.closed) return false;
      const requestId = randomUUID();
      const command: SendTextCommand = { type: 'sendText', ...binding, accountId: envelope.accountId, chatType: 'direct',
        chatId: envelope.chatId, requestId, text, replyToMessageId: envelope.messageId };
      const result = await this.transport.send(command, this.abort.signal);
      return !this.closed && result.type === 'sendResult' && result.requestId === requestId && result.accountId === binding.accountId
        && result.workerInstanceId === binding.workerInstanceId && result.controlEpoch === binding.controlEpoch
        && result.status === 'sent' && !!result.messageId;
    } catch { return false; }
  }

  /** Sends a prompt for a new pending entry and arms it only after the user can have seen it. */
  private async prompt(key: string, pending: Pending, envelope: Envelope, text: string): Promise<void> {
    if (!await this.reply(envelope, text) || !this.current(key, pending)) return;
    pending.armed = true;
    pending.expiresAt = this.now() + PENDING_TTL_MS;
  }

  private async read() {
    if (this.closed) throw new Error('Permission command service closed.');
    return this.repository.getExecutionPolicy();
  }

  private async run(key: string, envelope: Envelope, ticket: PermissionTicket): Promise<void> {
    if (this.closed) return;
    if (ticket.kind === 'clear') {
      if (this.pending.get(key)?.id === ticket.pendingId) this.pending.delete(key);
      return;
    }
    try {
      if (ticket.kind === 'list') {
        const pending = this.create<ChoosePending>(key, { stage: 'choose', policyVersion: null });
        let policy;
        try { policy = await this.read(); } catch (error) {
          if (this.pending.get(key) === pending) this.pending.delete(key);
          throw error;
        }
        if (!this.current(key, pending)) return;
        pending.policyVersion = policy.version;
        await this.prompt(key, pending, envelope, `${linePrompt(this.locale, 'permissionList', { level: this.label(policy.level) })}`
          + `${linePrompt(this.locale, 'permissionReplyInstruction')}\n${levels.map((level, index) =>
            `${index + 1}. ${this.label(level)}${level === policy.level ? linePrompt(this.locale, 'permissionCurrentMarker') : ''}`).join('\n')}`);
        return;
      }
      const pending = this.pending.get(key);
      if (!pending || pending.id !== ticket.pendingId) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
      this.pending.delete(key);
      const text = (envelope.text ?? '').trim();
      if (pending.stage === 'confirm') {
        if (!isConfirmation(text)) { await this.reply(envelope, linePrompt(this.locale, 'permissionCancelled')); return; }
        const policy = await this.read();
        await this.write(pending.level, policy.approvalTimeoutSeconds, policy.timeoutAction, pending.policyVersion);
        await this.reply(envelope, linePrompt(this.locale, 'permissionLoosened', { level: this.label(pending.level) }));
        return;
      }
      const level = choices.get(text), policyVersion = pending.policyVersion;
      if (!level || policyVersion === null) { await this.reply(envelope, linePrompt(this.locale, 'permissionFailure')); return; }
      const policy = await this.read();
      if (level === policy.level) {
        await this.reply(envelope, linePrompt(this.locale, 'permissionAlready', { level: this.label(level) }));
      } else if (levels.indexOf(level) < levels.indexOf(policy.level)) {
        await this.write(level, policy.approvalTimeoutSeconds, policy.timeoutAction, policyVersion);
        await this.reply(envelope, linePrompt(this.locale, 'permissionChanged', { level: this.label(level) }));
      } else {
        if (this.closed) return;
        const confirm = this.create<ConfirmPending>(key, { stage: 'confirm', level, policyVersion });
        await this.prompt(key, confirm, envelope, linePrompt(this.locale, 'permissionLoosenConfirm', { level: this.label(level) }));
      }
    } catch (error) {
      if (this.closed) return;
      try { this.onDiagnostic?.(diagnosticFailure('database', 'persist', error)); } catch { /* Reply behavior remains authoritative. */ }
      await this.reply(envelope, linePrompt(this.locale, error instanceof AgentPermissionError && error.code === 'PERMISSION_VERSION_CONFLICT'
        ? 'permissionConflict' : 'permissionFailure'));
    }
  }

  /** Awaits the repository until it commits or rolls back; a write that commits during close() stays committed. */
  private async write(level: AgentExecutionLevel, approvalTimeoutSeconds: number, timeoutAction: 'ALLOW' | 'DENY', expectedVersion: number): Promise<void> {
    if (this.closed) throw new Error('Permission command service closed.');
    await this.repository.setExecutionPolicy({ level, approvalTimeoutSeconds, timeoutAction, expectedVersion }, 'line_primary_admin');
    try { this.onPolicyChanged?.(); } catch { /* A listener failure does not undo the committed write. */ }
  }
}
