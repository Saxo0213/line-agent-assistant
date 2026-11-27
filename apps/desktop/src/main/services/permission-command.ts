import { randomUUID } from 'node:crypto';
import { AGENT_PERMISSIONS, diagnosticFailure, type AgentPermissionId, type SafeDiagnostic } from '@line-agent/contracts';
import type { AgentExecutionLevel, LineWorkerCommand, LineWorkerEvent } from '@line-agent/contracts';
import { AgentPermissionError, type AgentPermissionRepository } from '@line-agent/database';
import type { RoomAutomationTransport } from './room-automation.js';
import type { Locale } from '../../locale.js';
import { linePrompt, type LinePromptKey } from './line-prompts.js';
import { PERMISSION_COMMAND_PATTERN } from './trigger-router.js';

type Envelope = Extract<LineWorkerEvent, { type: 'batch' }>['envelopes'][number];
type SendTextCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
type PermissionState = Awaited<ReturnType<AgentPermissionRepository['getState']>>;
/** The same transport object the facade gives RoomAutomationService. */
export type PermissionCommandTransport = RoomAutomationTransport;
/**
 * One pending question per (accountId, chatId). An entry is armed only after its prompt reply was confirmed
 * sent, so a message classified before the user could have seen the question is never claimed.
 * A choose entry's policyVersion stays null until its list read succeeded; it is armed only after that.
 */
type Base = { id: number; armed: boolean; expiresAt: number };
type ChoosePending = Base & { stage: 'choose'; policyVersion: number | null };
type ConfirmPending = Base & { stage: 'confirm'; policyVersion: number; level: AgentExecutionLevel };
type GroupRef = { chatType: 'group' | 'room'; chatId: string; title: string };
type PersonRef = { mid: string; name: string };
type TargetEntry = ({ kind: 'group' } & GroupRef) | ({ kind: 'person' } & PersonRef);
/** Step 1: the numbered target list. `targets` holds only the rows that were really sent (item 1 is the level dialogue). */
type TargetPending = Base & { stage: 'target'; targets: TargetEntry[] };
/** Step 2: the whitelisted persons of one group. */
type PersonPending = Base & { stage: 'person'; group: GroupRef; people: PersonRef[] };
type CapSubject = PersonRef & { chatType: 'group' | 'room' | 'direct'; chatId: string; scope: string };
/** Step 3: the capability list. `values` and `versions` are the snapshot that the user saw (versions guard each write). */
type CapsPending = Base & { stage: 'caps'; subject: CapSubject; values: boolean[]; versions: number[]; changed: number };
type Toggle = { permission: AgentPermissionId; effect: 'ALLOW' | 'DENY'; expectedVersion: number; label: string };
type CapConfirmPending = Base & { stage: 'capConfirm'; subject: CapSubject; toggles: Toggle[]; riskyLabels: string[]; changed: number };
type Pending = ChoosePending | ConfirmPending | TargetPending | PersonPending | CapsPending | CapConfirmPending;
type Queued = { envelope: Envelope; ticket: PermissionTicket };
export type PermissionTicket =
  | { kind: 'list' }
  | { kind: 'reply'; pendingId: number }
  | { kind: 'clear'; pendingId: number };
export type PermissionCommandOptions = {
  onDiagnostic?: (diagnostic: SafeDiagnostic) => void;
  now?: () => number;
  onPolicyChanged?: () => void;
  /** Called after at least one allowlist capability rule was written, so an open Settings page can reload. */
  onPermissionsChanged?: () => void;
  locale?: Locale | string;
};

/** LINE accepts 5000 characters per text; the lists stay below this and say how many rows were left out. */
const LIST_TEXT_LIMIT = 4500;
const NAME_LIMIT = 80;
const NOTE_RESERVE = 120;
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
/** The local workspace permission (files and commands on this computer) is a major permission: Settings only, never this dialogue. */
const SETTINGS_ONLY_CAPABILITY: AgentPermissionId = 'agent.local_tools';
type DialogueCapability = Exclude<AgentPermissionId, typeof SETTINGS_ONLY_CAPABILITY>;
const capabilityKeys: Record<DialogueCapability, LinePromptKey> = {
  'records.query_current_chat': 'permissionCapCurrentChat',
  'records.query_all_chats': 'permissionCapAllChats',
  'chat_folder.read': 'permissionCapFolderRead',
  'chat_folder.write': 'permissionCapFolderWrite',
  'project_folder.read': 'permissionCapProjectFolderRead',
  'project_folder.write': 'permissionCapProjectFolderWrite',
};
/** The catalog entries that the dialogue lists, in catalog order. */
const dialogueCapabilities = AGENT_PERMISSIONS.filter((entry) => entry.id !== SETTINGS_ONLY_CAPABILITY);
/** Turning this ON widens what the Agent can write, so it needs a confirmation. */
const riskyCapabilities: ReadonlySet<AgentPermissionId> = new Set<AgentPermissionId>(['project_folder.write']);
const doneWords: ReadonlySet<string> = new Set(['0', '完成', 'done', '結束', '完了', '완료']);
const keyOf = (envelope: Envelope) => `${envelope.accountId}\0${envelope.chatId}`;
const isCommand = (text: string) => PERMISSION_COMMAND_PATTERN.test(text);
const isConfirmation = (text: string) => text === '確認' || text === '是' || /^(?:yes|[yｙＹ])$/i.test(text);
const asciiDigits = (text: string) => text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
/** One whole number reply, or null. */
const parseIndex = (text: string): number | null => {
  const value = asciiDigits(text.trim());
  return /^\d{1,4}$/.test(value) ? Number(value) : null;
};
const isDone = (text: string) => doneWords.has(asciiDigits(text.trim()).toLowerCase());
/** Capability numbers separated by space, comma or 、; null when any token is not a valid number. Zero-based, ascending, unique. */
const parseToggles = (text: string, count: number): number[] | null => {
  const tokens = asciiDigits(text.trim()).split(/[\s,，、]+/).filter(Boolean);
  if (!tokens.length) return null;
  const picked = new Set<number>();
  for (const token of tokens) {
    if (!/^\d{1,2}$/.test(token)) return null;
    const value = Number(token);
    if (value < 1 || value > count) return null;
    picked.add(value - 1);
  }
  return [...picked].sort((a, b) => a - b);
};
const cleanName = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);

/** The whitelisted persons of one group, as the Settings account selector shows them for that group. */
const peopleOfGroup = (state: PermissionState, group: Pick<GroupRef, 'chatType' | 'chatId'>): PersonRef[] => state.subjects
  .filter((user) => user.grantScope === 'ACCOUNT' || user.chatScopes.some((scope) => scope.chatType === group.chatType && scope.chatId === group.chatId))
  .map((user) => ({ mid: user.mid, name: cleanName(user.displayName || user.mid) || user.mid }));
/** The groups of the Settings group selector that have at least one eligible whitelisted person. */
const groupsOf = (state: PermissionState): GroupRef[] => {
  const groups: GroupRef[] = [];
  for (const chat of state.eligibleChats) {
    if (chat.chatType !== 'group' && chat.chatType !== 'room') continue;
    const group = { chatType: chat.chatType, chatId: chat.chatId, title: cleanName(chat.title || chat.chatId) || chat.chatId };
    if (peopleOfGroup(state, group).length) groups.push(group);
  }
  return groups;
};
/** The same list as the Settings personal view: whitelisted persons whose grant covers the whole account. */
const personalOf = (state: PermissionState): PersonRef[] => state.subjects.filter((user) => user.grantScope === 'ACCOUNT')
  .map((user) => ({ mid: user.mid, name: cleanName(user.displayName || user.mid) || user.mid }));

/**
 * Effective value of every capability for one subject, in catalog order. Same order of precedence as
 * resolveUserPermissions and the Settings page: this chat's rule, the person's account-wide rule, the everyone rule,
 * the global default, then the catalog default. `version` is the version of this chat's own rule (0 when none).
 */
const capabilityStates = (state: PermissionState, subject: CapSubject) => dialogueCapabilities.map((entry) => {
  const scoped = state.rules.find((rule) => rule.permission === entry.id && rule.subject.kind === 'USER' && rule.subject.mid === subject.mid
    && rule.chatType === subject.chatType && rule.chatId === subject.chatId);
  const user = state.rules.find((rule) => rule.permission === entry.id && rule.subject.kind === 'USER' && rule.subject.mid === subject.mid && rule.chatType === null);
  const everyone = state.rules.find((rule) => rule.permission === entry.id && rule.subject.kind === 'EVERYONE' && rule.chatType === null);
  const effect = scoped?.effect ?? user?.effect ?? everyone?.effect ?? state.defaults.find((item) => item.permission === entry.id)?.effect ?? entry.defaultEffect;
  return { id: entry.id as DialogueCapability, allowed: effect === 'ALLOW', version: scoped?.version ?? 0 };
});

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
  private readonly onPermissionsChanged: (() => void) | undefined;
  private readonly locale: Locale | string;
  private readonly onDiagnostic: PermissionCommandOptions['onDiagnostic'];
  private queued = 0;
  private nextId = 1;

  constructor(private readonly repository: Pick<AgentPermissionRepository, 'getExecutionPolicy' | 'setExecutionPolicy' | 'getState' | 'setPermission'>,
    private readonly transport: PermissionCommandTransport, options: PermissionCommandOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onPolicyChanged = options.onPolicyChanged;
    this.onPermissionsChanged = options.onPermissionsChanged;
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
    // Confirmation and capability replies are always claimed: any other text cancels the dialogue with a reply.
    if (pending.stage === 'confirm' || pending.stage === 'capConfirm' || pending.stage === 'caps') return { kind: 'reply', pendingId: pending.id };
    const index = parseIndex(text);
    const valid = pending.stage === 'choose' ? choices.has(text)
      : pending.stage === 'target' ? index !== null && index >= 1 && index <= pending.targets.length + 1
        : index !== null && index >= 1 && index <= pending.people.length;
    return valid ? { kind: 'reply', pendingId: pending.id } : { kind: 'clear', pendingId: pending.id };
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
        const pending = this.create<TargetPending>(key, { stage: 'target', targets: [] });
        let state;
        try { state = await this.readState(envelope.accountId); } catch (error) {
          if (this.pending.get(key) === pending) this.pending.delete(key);
          throw error;
        }
        if (!this.current(key, pending)) return;
        const groups = groupsOf(state).map((group): TargetEntry => ({ kind: 'group', ...group }));
        const persons = personalOf(state).map((person): TargetEntry => ({ kind: 'person', ...person }));
        const rows = [...groups, ...persons];
        const list = this.numberedList(linePrompt(this.locale, 'permissionTargetHeader'), [`1. ${linePrompt(this.locale, 'permissionTargetLevel')}`],
          rows.map((row) => row.kind === 'group' ? `${linePrompt(this.locale, 'permissionTargetGroup')} ${row.title}`
            : `${linePrompt(this.locale, 'permissionTargetPerson')} ${row.name}`), 2);
        pending.targets = rows.slice(0, list.shown);
        await this.prompt(key, pending, envelope, list.text);
        return;
      }
      const pending = this.pending.get(key);
      if (!pending || pending.id !== ticket.pendingId) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
      this.pending.delete(key);
      const text = (envelope.text ?? '').trim();
      if (pending.stage === 'target') { await this.pickTarget(key, envelope, pending, text); return; }
      if (pending.stage === 'person') { await this.pickPerson(key, envelope, pending, text); return; }
      if (pending.stage === 'caps') { await this.pickCapabilities(key, envelope, pending, text); return; }
      if (pending.stage === 'capConfirm') {
        if (!isConfirmation(text)) { await this.reply(envelope, linePrompt(this.locale, 'permissionCancelled')); return; }
        await this.applyToggles(key, envelope, pending.subject, pending.toggles, pending.changed);
        return;
      }
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

  private async readState(accountId: string): Promise<PermissionState> {
    if (this.closed) throw new Error('Permission command service closed.');
    return this.repository.getState(accountId);
  }

  /**
   * One message with a header, fixed leading lines and numbered rows. Rows that would pass the safe text length
   * are left out with a note; `shown` is how many rows were really listed, so only listed numbers can be chosen.
   */
  private numberedList(header: string, leading: string[], rows: string[], firstNumber: number): { text: string; shown: number } {
    const lines = [...leading];
    let length = header.length + leading.reduce((sum, line) => sum + line.length + 1, 0) + 1;
    let shown = 0;
    for (const row of rows) {
      const line = `${firstNumber + shown}. ${row}`;
      if (length + line.length + 1 > LIST_TEXT_LIMIT - NOTE_RESERVE) break;
      lines.push(line);
      length += line.length + 1;
      shown += 1;
    }
    const hidden = rows.length - shown;
    const note = hidden > 0 ? `\n${linePrompt(this.locale, 'permissionTargetTruncated', { name: String(hidden) })}` : '';
    return { text: `${header}\n${lines.join('\n')}${note}`, shown };
  }

  /** The Agent execution level dialogue (target item 1), unchanged. */
  private async startLevels(key: string, envelope: Envelope): Promise<void> {
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
  }

  private async pickTarget(key: string, envelope: Envelope, pending: TargetPending, text: string): Promise<void> {
    const index = parseIndex(text);
    if (index === 1) { await this.startLevels(key, envelope); return; }
    const entry = index === null ? undefined : pending.targets[index - 2];
    if (!entry) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
    const state = await this.readState(envelope.accountId);
    if (entry.kind === 'group') {
      const group = groupsOf(state).find((item) => item.chatType === entry.chatType && item.chatId === entry.chatId);
      const people = group ? peopleOfGroup(state, group) : [];
      if (!group || !people.length) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
      if (this.closed) return;
      const next = this.create<PersonPending>(key, { stage: 'person', group, people });
      const list = this.numberedList(linePrompt(this.locale, 'permissionPersonHeader', { name: group.title }), [], people.map((person) => person.name), 1);
      next.people = people.slice(0, list.shown);
      await this.prompt(key, next, envelope, list.text);
      return;
    }
    const person = personalOf(state).find((item) => item.mid === entry.mid);
    if (!person) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
    await this.showCapabilities(key, envelope, state, { ...person, chatType: 'direct', chatId: person.mid,
      scope: linePrompt(this.locale, 'permissionCapScopeDirect') }, 0, '');
  }

  private async pickPerson(key: string, envelope: Envelope, pending: PersonPending, text: string): Promise<void> {
    const index = parseIndex(text);
    const chosen = index === null ? undefined : pending.people[index - 1];
    if (!chosen) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
    const state = await this.readState(envelope.accountId);
    const group = groupsOf(state).find((item) => item.chatType === pending.group.chatType && item.chatId === pending.group.chatId);
    const person = group ? peopleOfGroup(state, group).find((item) => item.mid === chosen.mid) : undefined;
    if (!group || !person) { await this.reply(envelope, linePrompt(this.locale, 'permissionStale')); return; }
    await this.showCapabilities(key, envelope, state, { ...person, chatType: group.chatType, chatId: group.chatId, scope: group.title }, 0, '');
  }

  /** Sends the capability list of one subject and waits for the next number reply. */
  private async showCapabilities(key: string, envelope: Envelope, state: PermissionState, subject: CapSubject, changed: number, prefix: string): Promise<void> {
    if (this.closed) return;
    const states = capabilityStates(state, subject);
    const pending = this.create<CapsPending>(key, { stage: 'caps', subject, values: states.map((item) => item.allowed),
      versions: states.map((item) => item.version), changed });
    const items = states.map((item, index) =>
      `${index + 1}. ${linePrompt(this.locale, capabilityKeys[item.id])} [${this.yesNo(item.allowed)}]`);
    await this.prompt(key, pending, envelope, `${prefix}${linePrompt(this.locale, 'permissionCapHeader', { name: subject.name, scope: subject.scope })}\n`
      + `${items.join('\n')}\n${linePrompt(this.locale, 'permissionCapReply')}\n${linePrompt(this.locale, 'permissionCapLocalOnly')}`);
  }

  private yesNo(value: boolean): string { return linePrompt(this.locale, value ? 'permissionCapYes' : 'permissionCapNo'); }

  private async pickCapabilities(key: string, envelope: Envelope, pending: CapsPending, text: string): Promise<void> {
    if (isDone(text)) { await this.reply(envelope, linePrompt(this.locale, 'permissionCapDone', { name: String(pending.changed) })); return; }
    const picked = parseToggles(text, pending.values.length);
    if (!picked) { await this.reply(envelope, linePrompt(this.locale, 'permissionCancelled')); return; }
    const toggles = picked.map((index): Toggle => {
      const permission = dialogueCapabilities[index]!.id as DialogueCapability;
      return { permission, effect: pending.values[index] ? 'DENY' : 'ALLOW', expectedVersion: pending.versions[index]!,
        label: linePrompt(this.locale, capabilityKeys[permission]) };
    });
    const risky = toggles.filter((toggle) => toggle.effect === 'ALLOW' && riskyCapabilities.has(toggle.permission));
    if (!risky.length) { await this.applyToggles(key, envelope, pending.subject, toggles, pending.changed); return; }
    // Turning on a risky item needs a confirmation; the whole selection is applied together or not at all.
    if (this.closed) return;
    const riskyLabels = risky.map((toggle) => toggle.label);
    const confirm = this.create<CapConfirmPending>(key, { stage: 'capConfirm', subject: pending.subject, toggles, riskyLabels, changed: pending.changed });
    await this.prompt(key, confirm, envelope, linePrompt(this.locale, 'permissionCapConfirm', { text: riskyLabels.join(' / ') }));
  }

  /** Writes each toggle through the same repository method as the Settings page, then sends the updated list. */
  private async applyToggles(key: string, envelope: Envelope, subject: CapSubject, toggles: Toggle[], changedBefore: number): Promise<void> {
    let written = 0;
    try {
      for (const toggle of toggles) {
        if (this.closed) throw new Error('Permission command service closed.');
        // Defense in depth: no reply can reach the Settings-only capability.
        if (toggle.permission === SETTINGS_ONLY_CAPABILITY) throw new AgentPermissionError('UNKNOWN_PERMISSION', 'This permission can be changed only in Settings.');
        await this.repository.setPermission({ accountId: envelope.accountId, subject: { kind: 'USER', mid: subject.mid },
          chatType: subject.chatType, chatId: subject.chatId, permission: toggle.permission, effect: toggle.effect,
          expectedVersion: toggle.expectedVersion }, 'line_primary_admin');
        written += 1;
      }
    } finally {
      if (written) try { this.onPermissionsChanged?.(); } catch { /* A listener failure does not undo the committed write. */ }
    }
    const summary = linePrompt(this.locale, 'permissionCapChanged',
      { text: toggles.map((toggle) => `${toggle.label} → ${this.yesNo(toggle.effect === 'ALLOW')}`).join(' / ') });
    let state;
    try { state = await this.readState(envelope.accountId); } catch (error) {
      // The writes are committed; report them even though the new list cannot be read.
      if (this.closed) return;
      try { this.onDiagnostic?.(diagnosticFailure('database', 'persist', error)); } catch { /* Reply behavior remains authoritative. */ }
      await this.reply(envelope, summary);
      return;
    }
    await this.showCapabilities(key, envelope, state, subject, changedBefore + toggles.length, `${summary}\n\n`);
  }

  /** Awaits the repository until it commits or rolls back; a write that commits during close() stays committed. */
  private async write(level: AgentExecutionLevel, approvalTimeoutSeconds: number, timeoutAction: 'ALLOW' | 'DENY', expectedVersion: number): Promise<void> {
    if (this.closed) throw new Error('Permission command service closed.');
    await this.repository.setExecutionPolicy({ level, approvalTimeoutSeconds, timeoutAction, expectedVersion }, 'line_primary_admin');
    try { this.onPolicyChanged?.(); } catch { /* A listener failure does not undo the committed write. */ }
  }
}
