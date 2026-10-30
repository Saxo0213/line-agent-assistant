import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InboundEnvelope, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import type { AccountRepository, AdminRepository, FriendWhitelistRepository } from '@line-agent/database';
import type { OperationalAudit, AuditErrorCode, AuditResultCode } from './operational-audit.js';
import type { Locale } from '../../locale.js';
import { linePrompt } from './line-prompts.js';

type ActiveBinding = WorkerBinding & { mode: 'ACTIVE_CONTROL' };
type SecretCandidate = Readonly<{ code: string; exact: boolean }> | null | undefined;
type EnrollmentWorker = {
  binding(accountId: string): Promise<(WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) | null>;
  isCurrentActiveControlBinding(binding: WorkerBinding): boolean;
  send(command: LineWorkerCommand): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>>;
};
type FlowContext = { flowId: string; accountId: string; originChatType: 'direct' | 'group' | 'room'; originChatId: string;
  adminSenderId: string; primaryChatId: string; binding: ActiveBinding; expiresAt: number;
  adminVersion: number; selectedSourceId: string | null; selectedSourceGeneration: number | null };
type Flow =
  | { phase: 'starting'; flowId: string; accountId: string; originChatType: 'direct' | 'group' | 'room';
      originChatId: string; adminSenderId: string }
  | { phase: 'selection'; context: FlowContext }
  | { phase: 'selecting'; context: FlowContext }
  | { phase: 'challenge'; context: FlowContext; challengeId: string; targetMid: string; digest: Buffer; attempts: number }
  | { phase: 'processing'; context: FlowContext };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^LW-[A-HJ-NP-Z2-9]{8}$/;
const LINE_MID = /^u[0-9a-fA-F]{32}$/;
const MAX_ATTEMPTS = 5;
const MAX_FLOWS = 512;
const TTL_MS = 10 * 60_000;
function keyFor(accountId: string, chatType: string, chatId: string, senderId: string): string {
  return JSON.stringify([accountId, chatType, chatId, senderId]);
}

function complete(binding: (WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) | null): binding is ActiveBinding {
  return !!binding && binding.mode === 'ACTIVE_CONTROL' && typeof binding.transportOwnerId === 'string'
    && typeof binding.transportGeneration === 'number' && typeof binding.writeGrantVersion === 'number';
}

function workerFields(binding: ActiveBinding): WorkerBinding {
  return { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
    controlEpoch: binding.controlEpoch, transportOwnerId: binding.transportOwnerId,
    transportGeneration: binding.transportGeneration, writeGrantVersion: binding.writeGrantVersion };
}

function matchesResult(result: { accountId: string; workerInstanceId: string; controlEpoch: number;
  transportOwnerId?: string | undefined; transportGeneration?: number | undefined; writeGrantVersion?: number | undefined }, binding: ActiveBinding): boolean {
  return result.accountId === binding.accountId && result.workerInstanceId === binding.workerInstanceId
    && result.controlEpoch === binding.controlEpoch && result.transportOwnerId === binding.transportOwnerId
    && result.transportGeneration === binding.transportGeneration && result.writeGrantVersion === binding.writeGrantVersion;
}

function leadingOwnMention(envelope: InboundEnvelope, ownMid: string): { start: number; end: number } | null {
  if (envelope.text === null) return null;
  const matches = envelope.mentionRanges.filter((range) => range.userId === ownMid);
  if (matches.length !== 1 || envelope.mentionIds.filter((id) => id === ownMid).length !== 1) return null;
  const range = matches[0]!;
  return envelope.text.slice(0, range.start).trim().length === 0 ? range : null;
}

function withoutRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  let result = text;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

type EnrollmentCommand = { kind: 'direct' | 'group'; targetMid?: string };

function exactCommand(envelope: InboundEnvelope, ownMid: string | null): EnrollmentCommand | null {
  if (envelope.kind !== 'text' || envelope.text === null || envelope.ingestion.source !== 'live'
    || envelope.senderId === ownMid) return null;
  const accepted = (text: string) => text === '/新增使用者' || text.toLowerCase() === '/adduser';
  if (envelope.chatType === 'direct') return accepted(envelope.text.normalize('NFC').trim()) ? { kind: 'direct' } : null;
  if ((envelope.chatType !== 'group' && envelope.chatType !== 'room') || !ownMid) return null;
  const mention = leadingOwnMention(envelope, ownMid);
  if (!mention) return null;
  const targets = envelope.mentionRanges.filter((range) => range.userId !== ownMid);
  if (targets.length === 0) {
    return envelope.mentionRanges.length === 1 && envelope.mentionIds.length === 1
      && accepted(withoutRanges(envelope.text, [mention])) ? { kind: 'group' } : null;
  }
  if (targets.length !== 1 || envelope.mentionRanges.length !== 2 || envelope.mentionIds.length !== 2) return null;
  const target = targets[0]!;
  if (target.start <= mention.end || !LINE_MID.test(target.userId) || target.userId === ownMid
    || envelope.mentionIds.filter((id) => id === target.userId).length !== 1
    || !accepted(withoutRanges(envelope.text, [mention, target]))) return null;
  return { kind: 'group', targetMid: target.userId };
}

function targetMention(envelope: InboundEnvelope, ownMid: string): string | null {
  if (envelope.text === null || envelope.mentionRanges.length !== 2 || envelope.mentionIds.length !== 2) return null;
  const own = leadingOwnMention(envelope, ownMid);
  const target = envelope.mentionRanges.find((range) => range.userId !== ownMid);
  if (!own || !target || target.start <= own.start || !envelope.mentionIds.includes(target.userId)
    || !LINE_MID.test(target.userId) || target.userId === ownMid
    || withoutRanges(envelope.text, [own, target]) !== '') return null;
  return target.userId;
}

export class FriendEnrollmentService {
  private readonly flows = new Map<string, Flow>();
  private readonly digestKey: Buffer;

  constructor(private readonly deps: {
    admins: Pick<AdminRepository, 'isPrimaryAdministrator' | 'isPrimaryUser' | 'getPrimaryAdministrator' | 'getPrimaryAdministratorVersion'>;
    whitelist: Pick<FriendWhitelistRepository, 'activateForEnrollment' | 'getActiveAuthorization'>;
    accounts: Pick<AccountRepository, 'getAccount' | 'getControlState' | 'resolveCapabilities'>;
    workers: EnrollmentWorker;
    audit?: OperationalAudit | undefined;
    now?: () => number;
    digestKey?: Buffer;
    makeCode?: () => string;
    locale?: Locale | string;
  }) {
    this.now = deps.now ?? Date.now;
    this.digestKey = deps.digestKey ?? randomBytes(32);
    this.makeCode = deps.makeCode ?? (() => `LW-${Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')}`);
  }

  private readonly now: () => number;
  private readonly makeCode: () => string;

  private async canWriteLine(accountId: string): Promise<boolean> {
    return (await this.deps.accounts.resolveCapabilities(accountId))?.canWriteLine === true;
  }

  async classify(envelope: InboundEnvelope, candidate: SecretCandidate, ownMid: string | null = null): Promise<boolean> {
    if (envelope.ingestion.source !== 'live' || envelope.senderId === ownMid) return false;
    if (candidate && CODE_PATTERN.test(candidate.code)) return true;
    const primary = envelope.chatType === 'direct'
      ? await this.deps.admins.isPrimaryAdministrator(envelope.accountId, envelope.chatId, envelope.senderId)
      : await this.deps.admins.isPrimaryUser(envelope.accountId, envelope.senderId);
    if (!primary) return false;
    if (exactCommand(envelope, ownMid) || (envelope.kind === 'contact' && envelope.chatType === 'direct')) return true;
    if (ownMid && targetMention(envelope, ownMid)) return true;
    const flow = this.liveFlow(keyFor(envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId));
    return flow?.phase === 'selection' && envelope.chatType !== 'direct' && !!ownMid && !!leadingOwnMention(envelope, ownMid);
  }

  async handle(envelope: InboundEnvelope, candidate: SecretCandidate, ownMid: string | null = null,
    capturedBinding?: WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }): Promise<boolean> {
    if (envelope.ingestion.source === 'live' && !await this.canWriteLine(envelope.accountId)) return false;
    if (envelope.kind === 'contact') {
      if (envelope.ingestion.source === 'live' && envelope.chatType === 'direct' && envelope.contact
        && LINE_MID.test(envelope.contact.mid)) await this.selectContact(envelope, envelope.contact.mid, ownMid);
      return true;
    }
    if (envelope.kind !== 'text' || envelope.ingestion.source !== 'live' || envelope.senderId === ownMid) return false;

    const commandKind = exactCommand(envelope, ownMid);
    if (commandKind) {
      await this.start(envelope, commandKind, ownMid, capturedBinding);
      return true;
    }

    const key = keyFor(envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId);
    const flow = this.liveFlow(key);
    if (flow?.phase === 'selection' && flow.context.originChatType !== 'direct'
      && envelope.chatType === flow.context.originChatType && ownMid && leadingOwnMention(envelope, ownMid)) {
      await this.selectGroupTarget(key, flow, envelope, ownMid);
      return true;
    }

    if (candidate && CODE_PATTERN.test(candidate.code)) {
      if (candidate.exact) await this.consume(envelope, candidate, ownMid);
      return true;
    }
    return false;
  }

  private liveFlow(key: string): Flow | null {
    return this.flows.get(key) ?? null;
  }

  private flowId(flow: Flow): string { return flow.phase === 'starting' ? flow.flowId : flow.context.flowId; }

  private current(key: string, flowId: string, phase?: Flow['phase']): Flow | null {
    const current = this.flows.get(key);
    if (!current || this.flowId(current) !== flowId || (phase && current.phase !== phase)) return null;
    return current;
  }

  private putFlow(key: string, flow: Flow): void {
    if (!this.flows.has(key) && this.flows.size >= MAX_FLOWS) {
      const oldest = this.flows.keys().next().value;
      if (oldest !== undefined) this.flows.delete(oldest);
    }
    this.flows.delete(key);
    this.flows.set(key, flow);
  }

  private deleteIfCurrent(key: string, id: string): void {
    const current = this.flows.get(key);
    if (current && (this.flowId(current) === id || (current.phase === 'challenge' && current.challengeId === id))) {
      this.flows.delete(key);
    }
  }

  private selectionIsCurrent(key: string, context: FlowContext): boolean {
    const current = this.current(key, context.flowId, 'selecting');
    if (!current || current.phase !== 'selecting') return false;
    if (this.now() < current.context.expiresAt) return true;
    this.putFlow(key, { phase: 'processing', context });
    void this.sendText(context, context.originChatType, context.originChatId,
      linePrompt(this.deps.locale ?? 'en', 'enrollmentExpired'),
      () => this.current(key, context.flowId, 'processing') !== null)
      .catch(() => false).finally(() => this.deleteIfCurrent(key, context.flowId));
    return false;
  }

  private async start(envelope: InboundEnvelope, command: EnrollmentCommand, ownMid: string | null,
    capturedBinding?: WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }): Promise<void> {
    const originChatType = envelope.chatType as 'direct' | 'group' | 'room';
    const key = keyFor(envelope.accountId, originChatType, envelope.chatId, envelope.senderId);
    const flowId = randomUUID();
    this.putFlow(key, { phase: 'starting', flowId, accountId: envelope.accountId, originChatType,
      originChatId: envelope.chatId, adminSenderId: envelope.senderId });
    const isStarting = () => this.current(key, flowId, 'starting') !== null;

    const directPrimary = command.kind === 'direct'
      ? await this.deps.admins.isPrimaryAdministrator(envelope.accountId, envelope.chatId, envelope.senderId) : false;
    if (!isStarting()) return;
    if (command.kind === 'direct' && !directPrimary) { this.deleteIfCurrent(key, flowId); return; }
    let primaryChatId = envelope.chatId;
    if (command.kind === 'group') {
      if (!ownMid || !await this.deps.admins.isPrimaryUser(envelope.accountId, envelope.senderId) || !isStarting()) {
        if (isStarting()) this.deleteIfCurrent(key, flowId);
        return;
      }
      const primary = await this.deps.admins.getPrimaryAdministrator(envelope.accountId);
      if (!isStarting()) return;
      if (!primary || primary.userId !== envelope.senderId) { this.deleteIfCurrent(key, flowId); return; }
      primaryChatId = primary.chatId;
    }
    const account = await this.deps.accounts.getAccount(envelope.accountId);
    if (!isStarting()) return;
    if (!account?.ownMid || account.ownMid !== ownMid || account.ownMid === command.targetMid) {
      this.deleteIfCurrent(key, flowId); return;
    }
    const binding = capturedBinding === undefined ? await this.currentControlBinding(envelope.accountId)
      : complete(capturedBinding) && await this.bindingCurrent(capturedBinding) ? capturedBinding : null;
    if (!isStarting()) return;
    if (!binding) { this.deleteIfCurrent(key, flowId); return; }
    const adminVersion = await this.deps.admins.getPrimaryAdministratorVersion(envelope.accountId);
    const capabilities = await this.deps.accounts.resolveCapabilities(envelope.accountId);
    if (!isStarting() || adminVersion === null || !capabilities?.canWriteLine) { this.deleteIfCurrent(key, flowId); return; }
    const context: FlowContext = { flowId, accountId: envelope.accountId, originChatType,
      originChatId: envelope.chatId, adminSenderId: envelope.senderId, primaryChatId, binding, expiresAt: this.now() + TTL_MS,
      adminVersion, selectedSourceId: capabilities.selectedSourceId, selectedSourceGeneration: capabilities.selectedSourceGeneration };
    if (command.targetMid) {
      this.putFlow(key, { phase: 'selecting', context });
      if (!this.selectionIsCurrent(key, context)) return;
      await this.createChallenge(key, context, command.targetMid);
      return;
    }
    this.putFlow(key, { phase: 'selection', context });
    const text = linePrompt(this.deps.locale ?? 'en', command.kind === 'direct' ? 'enrollmentDirectRequest' : 'enrollmentGroupRequest');
    if (await this.sendText(context, originChatType, envelope.chatId, text,
      () => this.current(key, flowId, 'selection') !== null) !== 'sent') this.deleteIfCurrent(key, flowId);
  }

  private async isPrimary(context: FlowContext): Promise<boolean> {
    const capabilities = await this.deps.accounts.resolveCapabilities(context.accountId);
    if (!capabilities?.canWriteLine || capabilities.selectedSourceId !== context.selectedSourceId
      || capabilities.selectedSourceGeneration !== context.selectedSourceGeneration) return false;
    if (await this.deps.admins.getPrimaryAdministratorVersion(context.accountId) !== context.adminVersion) return false;
    if (context.originChatType === 'direct') {
      return await this.deps.admins.isPrimaryAdministrator(context.accountId, context.primaryChatId, context.adminSenderId);
    }
    if (!await this.deps.admins.isPrimaryUser(context.accountId, context.adminSenderId)) return false;
    const primary = await this.deps.admins.getPrimaryAdministrator(context.accountId);
    return primary?.chatId === context.primaryChatId && primary.userId === context.adminSenderId;
  }

  private async currentControlBinding(accountId: string): Promise<ActiveBinding | null> {
    const [control, binding] = await Promise.all([this.deps.accounts.getControlState(), this.deps.workers.binding(accountId)]);
    if (!complete(binding) || control.activeAccountId !== accountId || control.controlEpoch !== binding.controlEpoch
      || !this.deps.workers.isCurrentActiveControlBinding(binding)) return null;
    return binding;
  }

  private async bindingCurrent(binding: ActiveBinding): Promise<boolean> {
    const control = await this.deps.accounts.getControlState();
    return control.activeAccountId === binding.accountId && control.controlEpoch === binding.controlEpoch
      && this.deps.workers.isCurrentActiveControlBinding(binding);
  }

  private digest(code: string): Buffer { return createHmac('sha256', this.digestKey).update(code, 'utf8').digest(); }

  private matchesCode(code: string, digest: Buffer): boolean {
    const supplied = this.digest(code);
    return supplied.length === digest.length && timingSafeEqual(supplied, digest);
  }

  private async selectContact(envelope: InboundEnvelope, targetMid: string, ownMid: string | null): Promise<void> {
    const key = keyFor(envelope.accountId, 'direct', envelope.chatId, envelope.senderId);
    const flow = this.liveFlow(key);
    if (flow?.phase !== 'selection' || flow.context.originChatType !== 'direct') return;
    const { context } = flow;
    this.putFlow(key, { phase: 'selecting', context });
    if (!this.selectionIsCurrent(key, context)) return;
    const primary = await this.deps.admins.isPrimaryAdministrator(context.accountId, context.primaryChatId, context.adminSenderId);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!primary) { this.deleteIfCurrent(key, context.flowId); return; }
    const account = await this.deps.accounts.getAccount(envelope.accountId);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!account?.ownMid || account.ownMid === targetMid || account.ownMid !== ownMid) {
      this.putFlow(key, { phase: 'selection', context });
      return;
    }
    const bindingCurrent = await this.bindingCurrent(context.binding);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!bindingCurrent) {
      this.deleteIfCurrent(key, context.flowId);
      return;
    }
    if (!this.selectionIsCurrent(key, context)) return;
    await this.createChallenge(key, context, targetMid);
  }

  private async selectGroupTarget(key: string, flow: Extract<Flow, { phase: 'selection' }>, envelope: InboundEnvelope,
    ownMid: string): Promise<void> {
    const { context } = flow;
    this.putFlow(key, { phase: 'selecting', context });
    if (!this.selectionIsCurrent(key, context)) return;
    const targetMid = targetMention(envelope, ownMid);
    if (!targetMid) {
      this.putFlow(key, { phase: 'selection', context });
      await this.sendText(context, context.originChatType, context.originChatId,
        linePrompt(this.deps.locale ?? 'en', 'enrollmentBadMention'),
        () => this.current(key, context.flowId, 'selection') !== null);
      return;
    }
    const primaryUser = await this.deps.admins.isPrimaryUser(context.accountId, context.adminSenderId);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!primaryUser) { this.deleteIfCurrent(key, context.flowId); return; }
    const primary = await this.deps.admins.getPrimaryAdministrator(context.accountId);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!primary || primary.chatId !== context.primaryChatId || primary.userId !== context.adminSenderId) {
      this.deleteIfCurrent(key, context.flowId);
      return;
    }
    const account = await this.deps.accounts.getAccount(context.accountId);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!account?.ownMid || account.ownMid !== ownMid || account.ownMid === targetMid) {
      this.putFlow(key, { phase: 'selection', context });
      return;
    }
    const bindingCurrent = await this.bindingCurrent(context.binding);
    if (!this.selectionIsCurrent(key, context)) return;
    if (!bindingCurrent) {
      this.deleteIfCurrent(key, context.flowId);
      return;
    }
    if (!this.selectionIsCurrent(key, context)) return;
    await this.createChallenge(key, context, targetMid);
  }

  private async createChallenge(key: string, context: FlowContext, targetMid: string): Promise<void> {
    const code = this.makeCode();
    if (!CODE_PATTERN.test(code)) { this.deleteIfCurrent(key, context.flowId); return; }
    const challengeId = randomUUID();
    const challengeContext = { ...context, expiresAt: this.now() + TTL_MS };
    this.putFlow(key, { phase: 'challenge', context: challengeContext, challengeId, targetMid,
      digest: this.digest(code), attempts: 0 });
    const instruction = linePrompt(this.deps.locale ?? 'en', context.originChatType === 'direct'
      ? 'enrollmentDirectChallenge' : 'enrollmentGroupChallenge', { code });
    if (await this.sendText(challengeContext, 'direct', challengeContext.primaryChatId,
      instruction,
      () => {
        const latest = this.flows.get(key);
        return latest?.phase === 'challenge' && latest.challengeId === challengeId;
      }) !== 'sent') this.deleteIfCurrent(key, challengeId);
  }

  private exactConfirmation(envelope: InboundEnvelope, candidate: Exclude<SecretCandidate, null | undefined>,
    context: FlowContext, targetMid: string, ownMid: string | null): boolean {
    if (!candidate.exact || !CODE_PATTERN.test(candidate.code) || envelope.kind !== 'text'
      || envelope.ingestion.source !== 'live') return false;
    if (context.originChatType === 'direct') {
      // Direct challenges are initiated in the administrator's chat, but proof
      // must arrive from the selected target in that target's own 1:1 chat.
      return envelope.chatType === 'direct' && envelope.senderId === targetMid && envelope.chatId === targetMid;
    }
    if (envelope.chatType !== context.originChatType || envelope.chatId !== context.originChatId
      || envelope.senderId !== context.adminSenderId) return false;
    if (!ownMid) return false;
    return envelope.mentionIds.filter((id) => id === ownMid).length === 1
      && envelope.mentionRanges.filter((range) => range.userId === ownMid).length === 1;
  }

  private async consume(envelope: InboundEnvelope, candidate: Exclude<SecretCandidate, null | undefined>, ownMid: string | null): Promise<void> {
    let key = keyFor(envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId);
    let captured = this.liveFlow(key);
    if (envelope.chatType === 'direct') {
      const targetFlow = [...this.flows.entries()].find(([, flow]) => flow.phase === 'challenge'
        && flow.context.accountId === envelope.accountId && flow.context.originChatType === 'direct'
        && flow.targetMid === envelope.senderId);
      if (!targetFlow) return;
      [key, captured] = targetFlow;
    }
    if (captured?.phase !== 'challenge') return;
    const challengeId = captured.challengeId;
    const flowId = captured.context.flowId;
    if (!this.exactConfirmation(envelope, candidate, captured.context, captured.targetMid, ownMid)) return;
    if (!await this.isPrimary(captured.context)) {
      this.deleteIfCurrent(key, challengeId);
      return;
    }
    if (this.current(key, flowId, 'challenge')?.phase !== 'challenge'
      || (this.flows.get(key) as Extract<Flow, { phase: 'challenge' }> | undefined)?.challengeId !== challengeId) return;
    if (!await this.bindingCurrent(captured.context.binding)) {
      this.deleteIfCurrent(key, challengeId);
      return;
    }
    const current = this.flows.get(key);
    if (!current || current.phase !== 'challenge' || current.challengeId !== challengeId) return;
    if (this.now() >= current.context.expiresAt || current.attempts >= MAX_ATTEMPTS) {
      this.putFlow(key, { phase: 'processing', context: captured.context });
      await this.sendText(captured.context, captured.context.originChatType, captured.context.originChatId,
        linePrompt(this.deps.locale ?? 'en', 'enrollmentTokenExpired'), () => this.current(key, flowId, 'processing') !== null);
      this.deleteIfCurrent(key, flowId);
      return;
    }
    if (!this.matchesCode(candidate.code, current.digest)) {
      const attempts = current.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) this.deleteIfCurrent(key, challengeId);
      else this.flows.set(key, { ...current, attempts });
      if (attempts >= MAX_ATTEMPTS) this.putFlow(key, { phase: 'processing', context: captured.context });
      await this.sendText(captured.context, captured.context.originChatType, captured.context.originChatId,
        linePrompt(this.deps.locale ?? 'en', 'enrollmentTokenExpired'), () => this.current(key, flowId) !== null);
      if (attempts >= MAX_ATTEMPTS) this.deleteIfCurrent(key, flowId);
      return;
    }
    this.flows.set(key, { phase: 'processing', context: captured.context });
    try { await this.verifyAndActivate(key, captured.context, current.targetMid); }
    finally { this.deleteIfCurrent(key, flowId); }
  }

  private async verifyAndActivate(key: string, context: FlowContext, targetMid: string): Promise<void> {
    const active = () => this.current(key, context.flowId, 'processing') !== null;
    const admitted = async () => active() && await this.canWriteLine(context.accountId)
      && await this.isPrimary(context) && await this.bindingCurrent(context.binding);
    let auditCorrelation: string | undefined;
    let failureCode: AuditErrorCode | undefined = 'UNKNOWN';
    const auditFields = { initiator: 'user' as const, accountId: context.accountId, reasonCode: 'operator_action' as const };
    const observed = (action: 'friend_authorization_precheck' | 'friend_grant_commit', resultCode?: AuditResultCode, errorCode?: AuditErrorCode) => {
      try { if (auditCorrelation) this.deps.audit?.observed(action, { ...auditFields, correlationId: auditCorrelation,
        ...(resultCode ? { resultCode } : {}), ...(errorCode ? { errorCode } : {}) }); } catch { /* Audit is diagnostic only. */ }
    };
    const finishAudit = (phase: 'succeeded' | 'failed', resultCode: AuditResultCode, errorCode?: AuditErrorCode) => {
      try { if (auditCorrelation) this.deps.audit?.complete(auditCorrelation, phase,
        { resultCode, ...(errorCode ? { errorCode } : {}) }); } catch { /* Audit is diagnostic only. */ }
    };
    const reportFailure = async () => {
      if (active()) await this.sendText(context, context.originChatType, context.originChatId,
        linePrompt(this.deps.locale ?? 'en', context.originChatType === 'direct' ? 'enrollmentDirectFailed' : 'enrollmentGroupFailed'), active);
      finishAudit('failed', 'authorization_denied', failureCode);
    };
    try {
      if (!await admitted()) return;
      try { auditCorrelation = this.deps.audit?.request('friend_enrollment', auditFields) ?? randomUUID(); }
      catch { auditCorrelation = randomUUID(); }
    } catch { failureCode = 'ENROLLMENT_PRECHECK_FAILED'; await reportFailure(); return; }
    let authorizationStage: 'precheck' | 'grant' = 'precheck';
    let committed = false;
    let existingAuthorization: Awaited<ReturnType<typeof this.deps.whitelist.getActiveAuthorization>> = null;
    try {
      if (!await admitted() || !await this.isPrimary(context) || !await admitted()
        || !await this.bindingCurrent(context.binding) || !active()) {
        observed('friend_authorization_precheck', undefined, 'ENROLLMENT_BINDING_CHANGED');
        finishAudit('failed', 'authorization_denied', 'ENROLLMENT_BINDING_CHANGED'); return;
      }
      const scope = context.originChatType === 'direct'
        ? { kind: 'ACCOUNT' as const }
        : { kind: 'CHAT' as const, chatType: context.originChatType, chatId: context.originChatId };
      const activeAuthorization = await this.deps.whitelist.getActiveAuthorization(context.accountId, targetMid, scope);
      existingAuthorization = scope.kind === 'ACCOUNT'
        ? activeAuthorization?.scopeKind === 'ACCOUNT' ? activeAuthorization : null
        : activeAuthorization?.scopeKind === 'CHAT' && activeAuthorization.chatType === scope.chatType
          && activeAuthorization.chatId === scope.chatId ? activeAuthorization : null;
      observed('friend_authorization_precheck', existingAuthorization ? 'authorization_active' : 'precheck_ready');
      if (!await admitted() || !await this.isPrimary(context) || !await admitted()) {
        observed('friend_authorization_precheck', undefined, 'ENROLLMENT_BINDING_CHANGED');
        finishAudit('failed', 'authorization_denied', 'ENROLLMENT_BINDING_CHANGED'); return;
      }
      const control = await this.deps.accounts.getControlState();
      if (!await admitted() || control.activeAccountId !== context.binding.accountId || control.controlEpoch !== context.binding.controlEpoch
        || !this.deps.workers.isCurrentActiveControlBinding(context.binding)) {
        observed('friend_authorization_precheck', undefined, 'ENROLLMENT_BINDING_CHANGED');
        finishAudit('failed', 'authorization_denied', 'ENROLLMENT_BINDING_CHANGED'); return;
      }
      authorizationStage = 'grant';
      await this.deps.whitelist.activateForEnrollment({ ...workerFields(context.binding), targetMid, scope,
        adminUserId: context.adminSenderId, adminChatId: context.primaryChatId, adminVersion: context.adminVersion,
        selectedSourceId: context.selectedSourceId, selectedSourceGeneration: context.selectedSourceGeneration });
      committed = true;
      observed('friend_grant_commit', 'grant_committed');
    } catch {
      failureCode = authorizationStage === 'grant' ? 'ENROLLMENT_GRANT_FAILED' : 'ENROLLMENT_PRECHECK_FAILED';
      if (authorizationStage === 'grant') observed('friend_grant_commit', undefined, failureCode);
      else observed('friend_authorization_precheck', undefined, failureCode);
      await reportFailure();
    }
    if (!committed) return;
    const replyText = linePrompt(this.deps.locale ?? 'en', existingAuthorization
      ? context.originChatType === 'direct' ? 'enrollmentAlreadyDirect' : 'enrollmentAlreadyGroup'
      : context.originChatType === 'direct' ? 'enrollmentGrantedDirect' : 'enrollmentGrantedGroup');
    const reply = await this.sendText(context, context.originChatType, context.originChatId, replyText, active);
    const replyResultCode: AuditResultCode = reply === 'sent' ? 'authorization_active_reply_sent'
      : reply === 'unknown' ? 'authorization_active_reply_unknown' : 'authorization_active_reply_failed';
    const replyErrorCode: AuditErrorCode | undefined = reply === 'sent' ? undefined
      : reply === 'unknown' ? 'ENROLLMENT_REPLY_UNKNOWN' : 'ENROLLMENT_REPLY_FAILED';
    finishAudit('succeeded', replyResultCode, replyErrorCode);
  }

  private async sendText(context: FlowContext, chatType: 'direct' | 'group' | 'room', chatId: string, text: string,
    stillCurrent: () => boolean = () => true): Promise<'sent' | 'failed' | 'unknown'> {
    try {
      if (!await this.canWriteLine(context.accountId) || !await this.isPrimary(context)
        || !await this.bindingCurrent(context.binding) || !stillCurrent()) return 'failed';
      const requestId = randomUUID();
      const result = await this.deps.workers.send({ type: 'sendText', ...workerFields(context.binding), chatType, chatId,
        requestId, text, replyToMessageId: null });
      if (!matchesResult(result, context.binding) || result.requestId !== requestId) return 'unknown';
      return result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'unknown';
    } catch { return 'unknown'; }
  }
}
