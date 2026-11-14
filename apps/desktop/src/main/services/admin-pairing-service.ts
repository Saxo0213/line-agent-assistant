import { randomInt, timingSafeEqual } from 'node:crypto';
import type { InboundEnvelope } from '@line-agent/contracts';

interface AdminStore {
  hasPrimary(accountId: string): Promise<boolean>;
  bindPrimary(accountId: string, chatId: string, userId: string): Promise<boolean>;
}

export type AdminChangeFailureCode = 'ADMIN_NOT_SET' | 'ADMIN_CHANGE_STALE' | 'ADMIN_VERSION_CHANGED' | 'ADMIN_IDENTITY_INVALID';

/** Stable error for a change flow that cannot start or continue. `code` is the machine code that Main reports. */
export class AdminChangeError extends Error {
  constructor(readonly code: AdminChangeFailureCode) { super(code); this.name = 'AdminChangeError'; }
}

/** Database access of the change flow. */
export interface AdminChangeStore {
  getPrimary(accountId: string): Promise<{ chatId: string; userId: string } | null>;
  getVersion(accountId: string): Promise<number | null>;
  isPrimaryAdministrator(accountId: string, chatId: string, userId: string): Promise<boolean>;
  ownMid(accountId: string): Promise<string | null>;
  change(input: { agentAccountId: string; expectedAdminVersion: number; expectedOldUserId: string; newUserId: string; correlationId: string }):
    Promise<{ ok: true; oldAdminAccountId: string | null; newAdminAccountId: string; displayName: string }
      | { ok: false; code: 'ADMIN_CHANGE_STALE' | 'ADMIN_VERSION_CHANGED' | 'ADMIN_IDENTITY_INVALID' }>;
}

export type AdminChangeProgress =
  | { type: 'await_new'; accountId: string; token: string; expiresAt: string }
  | { type: 'expired'; accountId: string }
  | { type: 'failed'; accountId: string; code: AdminChangeFailureCode };

export interface AdminChangeDeps {
  store: AdminChangeStore;
  /** Stage changes that Main publishes to the renderer. The Agent sends no LINE message for them. */
  onProgress?: (event: AdminChangeProgress) => void;
  /** Runs before the database change, for example to stop external monitoring of the old administrator. */
  prepare?: (agentAccountId: string) => Promise<void>;
}

export type AdminChangeOutcome =
  | { ok: true; agentAccountId: string; newUserId: string; oldAdminAccountId: string | null; newAdminAccountId: string; displayName: string }
  | { ok: false; agentAccountId: string; code: AdminChangeFailureCode };

export type AdminChangeConsume =
  | { kind: 'ignored' }
  /** Code 1 was accepted. Code 2 is now published through `onProgress`. */
  | { kind: 'advanced' }
  /** Code 2 was accepted. The caller runs `apply` once, outside the ingest path. */
  | { kind: 'apply'; apply: () => Promise<AdminChangeOutcome> };

type ChangeStage = 'confirm_current' | 'await_new';
interface ChangeState {
  stage: ChangeStage;
  token: string;
  expiresAt: number;
  adminVersion: number;
  currentAdminUserId: string;
  agentOwnMid: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const CODE_LIFETIME_MS = 180_000;
const MID_PATTERN = /^u[0-9a-f]{32}$/;

function sameCode(text: string, token: string): boolean {
  const supplied = Buffer.from(text, 'utf8'); const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class AdminPairingService {
  private readonly challenges = new Map<string, { token: string; expiresAt: number }>();
  private readonly changes = new Map<string, ChangeState>();
  constructor(private readonly admins: AdminStore, private readonly now = () => Date.now(),
    private readonly makeToken = () => randomInt(100000, 1000000).toString(), private readonly changeDeps?: AdminChangeDeps) {}

  async begin(accountId: string): Promise<{ token: string; expiresAt: string }> {
    if (await this.admins.hasPrimary(accountId)) throw new Error('此帳號已設定主要管理者。');
    const token = this.makeToken();
    if (!/^\d{6}$/.test(token)) throw new Error('Invalid administrator pairing token');
    const expiresAt = this.now() + 180_000;
    this.challenges.set(accountId, { token, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consume(envelope: InboundEnvelope): Promise<boolean> {
    if (envelope.ingestion.source !== 'live' || envelope.chatType !== 'direct' || envelope.kind !== 'text' || !envelope.text) return false;
    const challenge = this.challenges.get(envelope.accountId);
    if (!challenge) return false;
    if (this.now() >= challenge.expiresAt) { this.challenges.delete(envelope.accountId); return false; }
    const supplied = Buffer.from(envelope.text, 'utf8'); const expected = Buffer.from(challenge.token, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const bound = await this.admins.bindPrimary(envelope.accountId, envelope.chatId, envelope.senderId);
    if (bound || await this.admins.hasPrimary(envelope.accountId)) this.challenges.delete(envelope.accountId);
    return bound;
  }

  classify(envelope: InboundEnvelope): boolean {
    if (this.classifyChange(envelope)) return true;
    if (envelope.ingestion.source !== 'live' || envelope.chatType !== 'direct' || envelope.kind !== 'text' || !envelope.text) return false;
    const challenge = this.challenges.get(envelope.accountId);
    if (!challenge || this.now() >= challenge.expiresAt) return false;
    const supplied = Buffer.from(envelope.text, 'utf8');
    const expected = Buffer.from(challenge.token, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  /** Starts the change flow: code 1 for the current administrator. A new call replaces an earlier flow of the same Agent. */
  async beginChange(agentAccountId: string): Promise<{ token: string; expiresAt: string; stage: 'confirm_current' }> {
    const store = this.changeDeps?.store;
    if (!store) throw new Error('Administrator change is not available');
    const [primary, version, ownMid] = await Promise.all([store.getPrimary(agentAccountId), store.getVersion(agentAccountId), store.ownMid(agentAccountId)]);
    if (!primary || primary.chatId !== primary.userId || version === null) throw new AdminChangeError('ADMIN_NOT_SET');
    const token = this.newToken();
    const expiresAt = this.now() + CODE_LIFETIME_MS;
    this.setChange(agentAccountId, { stage: 'confirm_current', token, expiresAt, adminVersion: version,
      currentAdminUserId: primary.userId, agentOwnMid: ownMid, timer: undefined });
    return { token, expiresAt: new Date(expiresAt).toISOString(), stage: 'confirm_current' };
  }

  /** Cancels the change flow of one Agent. Nothing changes in the database. Returns whether a flow was active. */
  cancelChange(agentAccountId: string): boolean {
    const state = this.changes.get(agentAccountId);
    if (!state) return false;
    this.dropChange(agentAccountId, state);
    return true;
  }

  /** Clears every timer. Pending flows stay in memory only and are lost on exit. */
  dispose(): void {
    for (const [accountId, state] of [...this.changes]) this.dropChange(accountId, state);
  }

  async consumeChange(envelope: InboundEnvelope): Promise<AdminChangeConsume> {
    const state = this.matchChange(envelope);
    if (!state) return { kind: 'ignored' };
    const accountId = envelope.accountId;
    const store = this.changeDeps!.store;
    if (state.stage === 'confirm_current') {
      // Only the current administrator is accepted, and the stored version must still be the current one.
      const confirmed = await store.isPrimaryAdministrator(accountId, envelope.chatId, envelope.senderId)
        && await store.getVersion(accountId) === state.adminVersion;
      if (this.changes.get(accountId) !== state) return { kind: 'ignored' };
      if (!confirmed) {
        this.dropChange(accountId, state);
        this.changeDeps?.onProgress?.({ type: 'failed', accountId, code: 'ADMIN_VERSION_CHANGED' });
        return { kind: 'ignored' };
      }
      const token = this.newToken(state.token);
      const expiresAt = this.now() + CODE_LIFETIME_MS;
      this.setChange(accountId, { ...state, stage: 'await_new', token, expiresAt, timer: undefined });
      this.changeDeps?.onProgress?.({ type: 'await_new', accountId, token, expiresAt: new Date(expiresAt).toISOString() });
      return { kind: 'advanced' };
    }
    // Stage 2: claim the flow now, so that a second copy of the code cannot start a second change.
    this.dropChange(accountId, state);
    const newUserId = envelope.senderId;
    return { kind: 'apply', apply: async () => {
      await this.changeDeps?.prepare?.(accountId);
      const result = await store.change({ agentAccountId: accountId, expectedAdminVersion: state.adminVersion,
        expectedOldUserId: state.currentAdminUserId, newUserId, correlationId: `admin-change-${accountId}-${this.now()}` });
      return result.ok
        ? { ok: true as const, agentAccountId: accountId, newUserId, oldAdminAccountId: result.oldAdminAccountId,
          newAdminAccountId: result.newAdminAccountId, displayName: result.displayName }
        : { ok: false as const, agentAccountId: accountId, code: result.code };
    } };
  }

  private classifyChange(envelope: InboundEnvelope): boolean {
    return this.matchChange(envelope) !== null;
  }

  /** The flow state when the envelope is a live direct text with the expected code from an accepted sender; else null. */
  private matchChange(envelope: InboundEnvelope): ChangeState | null {
    if (!this.changeDeps || envelope.ingestion.source !== 'live' || envelope.chatType !== 'direct' || envelope.kind !== 'text' || !envelope.text) return null;
    const state = this.changes.get(envelope.accountId);
    if (!state) return null;
    if (this.now() >= state.expiresAt) { this.expireChange(envelope.accountId, state); return null; }
    if (!sameCode(envelope.text, state.token)) return null;
    if (envelope.chatId !== envelope.senderId) return null;
    if (state.stage === 'confirm_current') return envelope.senderId === state.currentAdminUserId ? state : null;
    return MID_PATTERN.test(envelope.senderId) && envelope.senderId !== state.agentOwnMid && envelope.senderId !== state.currentAdminUserId
      ? state : null;
  }

  private newToken(different?: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.makeToken();
      if (!/^\d{6}$/.test(token)) throw new Error('Invalid administrator pairing token');
      if (token !== different) return token;
    }
    throw new Error('Administrator change token repeats');
  }

  private setChange(accountId: string, state: ChangeState): void {
    const previous = this.changes.get(accountId);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.expireChange(accountId, state), Math.max(0, state.expiresAt - this.now()));
    timer.unref?.();
    state.timer = timer;
    this.changes.set(accountId, state);
  }

  private dropChange(accountId: string, state: ChangeState): void {
    if (state.timer) clearTimeout(state.timer);
    if (this.changes.get(accountId) === state) this.changes.delete(accountId);
  }

  private expireChange(accountId: string, state: ChangeState): void {
    if (this.changes.get(accountId) !== state) return;
    this.dropChange(accountId, state);
    this.changeDeps?.onProgress?.({ type: 'expired', accountId });
  }
}
