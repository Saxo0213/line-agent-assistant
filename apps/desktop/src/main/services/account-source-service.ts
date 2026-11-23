import { createAccountDirectory, removeAccountDirectory } from '@line-agent/agent-bridge';
import type { AccountSourceErrorCode, AgentAccountSource, AgentAccountSourceUsage, AgentProvider } from '@line-agent/contracts';
import { AccountSourceError, effectiveDefaultId, normalizedFallbackOrder, type AccountSource, type RemoveAccountSourceResult } from '@line-agent/database';
import { parseResidentKey } from './agent-resident.js';

/** A typed failure of an account source action. `code` is the IPC error code. */
export class AccountSourceServiceError extends Error {
  constructor(readonly code: AccountSourceErrorCode, message: string) {
    super(message);
    this.name = 'AccountSourceServiceError';
  }
}

/** The calls of AccountSourceRepository that the service uses. */
export interface AccountSourceStore {
  list(): Promise<AccountSource[]>;
  get(sourceId: string): Promise<AccountSource | null>;
  effectiveDefault(provider: AgentProvider): Promise<AccountSource>;
  add(input: { provider: AgentProvider; label: string }): Promise<AccountSource>;
  rename(sourceId: string, label: string): Promise<AccountSource>;
  setDefault(provider: AgentProvider, sourceId: string): Promise<void>;
  move(sourceId: string, direction: 'up' | 'down'): Promise<void>;
  setFallbackEnabled(sourceId: string, enabled: boolean): Promise<AccountSource>;
  remove(sourceId: string): Promise<RemoveAccountSourceResult>;
}

export type AccountSourceAuthStatus = { status: 'authenticated' | 'logged_out' | 'not_installed' | 'error'; detail?: string };

/** The calls of the CLI bridge that the service uses. The account argument is `{ id, kind }`. */
export interface AccountSourceBridge {
  getAuthStatus(provider: AgentProvider, account?: { id: string; kind: 'system' | 'managed' }): Promise<AccountSourceAuthStatus>;
  openLogin(provider: AgentProvider, account?: { id: string; kind: 'system' | 'managed' }): Promise<{ ok: boolean; detail?: string }>;
  logout(provider: AgentProvider, account?: { id: string; kind: 'system' | 'managed' }): Promise<{ ok: boolean; detail?: string }>;
  resetResidents?(predicate: (key: string) => boolean): number;
}

export interface AccountSourceQuota {
  get(provider: AgentProvider, account?: { id: string; kind: 'system' | 'managed' }): Promise<QuotaView>;
  refreshNow(provider: AgentProvider, account?: { id: string; kind: 'system' | 'managed' }): Promise<QuotaView>;
}
type QuotaView = {
  fetchedAt: string | null; stale: boolean; error: string | null;
  windows: Array<{ label: string; durationMins: number | null; usedPercent: number; resetsAt: string | null; blocksProvider: boolean }>;
};

export interface AccountSourceServiceOptions {
  repository: AccountSourceStore;
  bridge: AccountSourceBridge;
  /** `userData/llm-accounts`. */
  accountsDirectory: string;
  quota: AccountSourceQuota;
  /** The stored block state of a source (provider_quota_state). */
  quotaState?: (sourceId: string) => Promise<{ blocked: boolean; recoveryAt: string | null } | null>;
  /** The ids of the sources that have queued or running jobs. */
  busySourceIds?: () => Promise<ReadonlySet<string>>;
  /** Called after each change of the list or of a cached status. */
  onChange?: () => void;
  /** Called with a short slug when a side step fails without a failed action (for example a kept account directory). */
  onDiagnostic?: (code: 'account_directory_kept' | 'account_directory_remove_failed', sourceId: string) => void;
}

const HEALTH_STATUS: Record<AccountSourceAuthStatus['status'], AgentAccountSource['status']> = {
  authenticated: 'logged_in', logged_out: 'logged_out', not_installed: 'not_installed', error: 'error',
};

const ref = (source: Pick<AccountSource, 'sourceId' | 'kind'>) => ({ id: source.sourceId, kind: source.kind });

/**
 * CLI account sources of the providers: list, add, rename, default, order, login, logout, status and usage.
 * Port of the source actions of CliTalkAgent llm_sources.rs. The cache holds the last login status of each source in memory.
 */
export class AccountSourceService {
  private readonly cache = new Map<string, AccountSourceAuthStatus>();

  constructor(private readonly options: AccountSourceServiceOptions) {}

  /** Tells the owner about a change that no caller will publish. The action methods do not call it: the IPC handler publishes after each action. */
  private changed(): void {
    try { this.options.onChange?.(); } catch { /* A publish failure must not fail the action. */ }
  }

  private async require(sourceId: string): Promise<AccountSource> {
    const row = await this.options.repository.get(sourceId);
    if (!row) throw new AccountSourceServiceError('ACCOUNT_SOURCE_NOT_FOUND', 'The account source does not exist.');
    return row;
  }

  private rethrow(error: unknown): never {
    if (error instanceof AccountSourceServiceError) throw error;
    if (error instanceof AccountSourceError) {
      const code: AccountSourceErrorCode = error.code === 'not_found' ? 'ACCOUNT_SOURCE_NOT_FOUND'
        : error.code === 'system_source' ? 'ACCOUNT_SOURCE_SYSTEM'
          : error.code === 'provider_mismatch' ? 'ACCOUNT_SOURCE_PROVIDER_MISMATCH' : 'ACCOUNT_SOURCE_INVALID';
      throw new AccountSourceServiceError(code, error.message);
    }
    throw error;
  }

  /** Rows in rotation order, then the rows outside the rotation. */
  async list(): Promise<AgentAccountSource[]> {
    const rows = await this.options.repository.list();
    const order = normalizedFallbackOrder(rows);
    const busy = await this.options.busySourceIds?.().catch(() => new Set<string>()) ?? new Set<string>();
    const byId = new Map(rows.map((row) => [row.sourceId, row]));
    const outside = rows.filter((row) => !order.includes(row.sourceId));
    const ordered = [...order.map((id) => byId.get(id)!), ...outside];
    return ordered.map((row) => {
      const cached = this.cache.get(row.sourceId);
      const position = order.indexOf(row.sourceId);
      return { id: row.sourceId, provider: row.provider, kind: row.kind, label: row.label,
        isDefault: effectiveDefaultId(rows, row.provider) === row.sourceId, fallbackEnabled: row.fallbackEnabled,
        order: position >= 0 ? position : null,
        status: cached ? HEALTH_STATUS[cached.status] : 'unknown', detail: cached?.detail ?? null, inUse: busy.has(row.sourceId) };
    });
  }

  /** The effective default source of a provider, as `{ id, kind }` for the bridge. */
  async defaultAccount(provider: AgentProvider): Promise<{ id: string; kind: 'system' | 'managed' }> {
    return ref(await this.options.repository.effectiveDefault(provider));
  }

  async add(input: { provider: AgentProvider; label: string }): Promise<AgentAccountSource[]> {
    let row: AccountSource;
    try { row = await this.options.repository.add(input); } catch (error) { this.rethrow(error); }
    try {
      await createAccountDirectory(this.options.accountsDirectory, row.sourceId);
    } catch (error) {
      await this.options.repository.remove(row.sourceId).catch(() => undefined);
      throw error;
    }
    this.cache.set(row.sourceId, { status: 'logged_out' });
    return this.list();
  }

  async rename(id: string, label: string): Promise<AgentAccountSource[]> {
    try { await this.options.repository.rename(id, label); } catch (error) { this.rethrow(error); }
    return this.list();
  }

  async setDefault(provider: AgentProvider, id: string): Promise<AgentAccountSource[]> {
    try { await this.options.repository.setDefault(provider, id); } catch (error) { this.rethrow(error); }
    return this.list();
  }

  async move(id: string, direction: 'up' | 'down'): Promise<AgentAccountSource[]> {
    try { await this.options.repository.move(id, direction); } catch (error) { this.rethrow(error); }
    return this.list();
  }

  async setFallbackEnabled(id: string, enabled: boolean): Promise<AgentAccountSource[]> {
    try { await this.options.repository.setFallbackEnabled(id, enabled); } catch (error) { this.rethrow(error); }
    return this.list();
  }

  /**
   * Deletes a managed source. CliTalkAgent deletes the row first and the directory after it, so does this method.
   * The resident processes of the source stop before the directory goes, so no process holds the files.
   */
  async remove(id: string): Promise<AgentAccountSource[]> {
    const result = await this.options.repository.remove(id);
    if (result === 'system') throw new AccountSourceServiceError('ACCOUNT_SOURCE_SYSTEM', 'A system account source cannot be deleted.');
    if (result === 'in_use') throw new AccountSourceServiceError('ACCOUNT_SOURCE_IN_USE', 'The account source has queued or running jobs.');
    if (result === 'not_found') throw new AccountSourceServiceError('ACCOUNT_SOURCE_NOT_FOUND', 'The account source does not exist.');
    try { this.options.bridge.resetResidents?.((key) => parseResidentKey(key)?.sourceId === id); } catch { /* The row is gone. Go on. */ }
    try {
      const outcome = await removeAccountDirectory(this.options.accountsDirectory, id);
      if (outcome === 'marker_mismatch') this.options.onDiagnostic?.('account_directory_kept', id);
    } catch {
      this.options.onDiagnostic?.('account_directory_remove_failed', id);
    }
    this.cache.delete(id);
    return this.list();
  }

  /** Opens the login console. It resolves after the console closes, then the status is checked again. */
  async login(id: string): Promise<{ sources: AgentAccountSource[]; result: { ok: boolean; detail?: string } }> {
    const source = await this.require(id);
    if (source.kind === 'managed') await createAccountDirectory(this.options.accountsDirectory, id);
    let result: { ok: boolean; detail?: string };
    try { result = await this.options.bridge.openLogin(source.provider, ref(source)); }
    finally { await this.refresh(id).catch(() => undefined); }
    return { sources: await this.list(), result };
  }

  async logout(id: string): Promise<{ sources: AgentAccountSource[]; result: { ok: boolean; detail?: string } }> {
    const source = await this.require(id);
    let result: { ok: boolean; detail?: string };
    try { result = await this.options.bridge.logout(source.provider, ref(source)); }
    finally { await this.refresh(id).catch(() => undefined); }
    return { sources: await this.list(), result };
  }

  /** Checks the login status of one source and stores it. */
  async refresh(id: string): Promise<AccountSourceAuthStatus> {
    const source = await this.require(id);
    let status: AccountSourceAuthStatus;
    try { status = await this.options.bridge.getAuthStatus(source.provider, ref(source)); }
    catch { status = { status: 'error', detail: 'Unable to inspect the official CLI login status.' }; }
    this.store(id, status);
    return status;
  }

  /** The last stored status of a source, or null. */
  cachedStatus(id: string): AccountSourceAuthStatus | null { return this.cache.get(id) ?? null; }

  /** Stores a status that the bridge reported by itself (for example a run that found the login gone). */
  record(id: string, status: AccountSourceAuthStatus): void {
    this.store(id, status);
    this.changed();
  }

  private store(id: string, status: AccountSourceAuthStatus): void {
    this.cache.set(id, { status: status.status, ...(status.detail === undefined ? {} : { detail: status.detail }) });
  }

  /** The quota of one source. The result holds no token. */
  async usage(id: string, force: boolean): Promise<AgentAccountSourceUsage> {
    const source = await this.require(id);
    const snapshot = force ? await this.options.quota.refreshNow(source.provider, ref(source)) : await this.options.quota.get(source.provider, ref(source));
    const state = await this.options.quotaState?.(id).catch(() => null) ?? null;
    return { fetchedAt: snapshot.fetchedAt, stale: snapshot.stale, blocked: state?.blocked === true, recoveryAt: state?.blocked ? state.recoveryAt : null,
      error: snapshot.error === null ? null : snapshot.error.slice(0, 200), windows: snapshot.windows.map((window) => ({ label: window.label, durationMins: window.durationMins,
        usedPercent: window.usedPercent, resetsAt: window.resetsAt, blocksProvider: window.blocksProvider })) };
  }

  /** Checks every source, one at a time (startup). */
  async refreshAll(): Promise<void> {
    for (const row of await this.options.repository.list()) await this.refresh(row.sourceId).catch(() => undefined);
    this.changed();
  }
}
