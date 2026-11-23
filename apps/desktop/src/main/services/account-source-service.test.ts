import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSource } from '@line-agent/database';
import { AccountSourceService, AccountSourceServiceError, type AccountSourceBridge, type AccountSourceStore } from './account-source-service.js';
import { residentKey, residentIdentity } from './agent-resident.js';

const MANAGED = 'acct-0123456789';
const OTHER = 'acct-abcdefabcd';

const row = (sourceId: string, provider: 'claude' | 'codex', kind: 'system' | 'managed', extra: Partial<AccountSource> = {}): AccountSource => ({
  sourceId, provider, kind, label: sourceId, isDefault: false, fallbackEnabled: true, fallbackPosition: null,
  createdAt: kind === 'system' ? new Date(0).toISOString() : new Date(1000 + sourceId.length).toISOString(), updatedAt: new Date(0).toISOString(), ...extra,
});

function fixture(initial: AccountSource[] = [row('claude', 'claude', 'system'), row('codex', 'codex', 'system')]) {
  const rows = [...initial];
  const calls: string[] = [];
  let removeResult: 'removed' | 'system' | 'in_use' | 'not_found' = 'removed';
  const store: AccountSourceStore = {
    async list() { return rows.map((item) => ({ ...item })); },
    async get(id) { return rows.find((item) => item.sourceId === id) ?? null; },
    async effectiveDefault(provider) {
      return rows.find((item) => item.provider === provider && item.isDefault) ?? rows.find((item) => item.sourceId === provider)!;
    },
    async add(input) { const added = row(MANAGED, input.provider, 'managed', { label: input.label }); rows.push(added); calls.push('add'); return added; },
    async rename() { throw new Error('unused'); },
    async setDefault() { throw new Error('unused'); },
    async move() { throw new Error('unused'); },
    async setFallbackEnabled() { throw new Error('unused'); },
    async remove(id) {
      calls.push(`remove:${id}`);
      if (removeResult === 'removed') rows.splice(rows.findIndex((item) => item.sourceId === id), 1);
      return removeResult;
    },
  };
  const bridge = {
    getAuthStatus: vi.fn(async () => ({ status: 'authenticated' as const })),
    openLogin: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => ({ ok: true })),
    resetResidents: vi.fn((predicate: (key: string) => boolean) => ['a', 'b'].filter(predicate).length),
  } satisfies AccountSourceBridge;
  const quota = { get: vi.fn(), refreshNow: vi.fn() };
  return { rows, calls, store, bridge, quota, setRemoveResult(value: typeof removeResult) { removeResult = value; } };
}

describe('AccountSourceService', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'account-source-service-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const service = (f: ReturnType<typeof fixture>, extra: Partial<ConstructorParameters<typeof AccountSourceService>[0]> = {}) =>
    new AccountSourceService({ repository: f.store, bridge: f.bridge, accountsDirectory: directory, quota: f.quota, ...extra });

  it('adds a managed source with its directory marker, and rolls the row back when the directory step fails', async () => {
    const f = fixture();
    const sources = await service(f).add({ provider: 'claude', label: 'Work' });
    expect(sources.find((item) => item.id === MANAGED)).toMatchObject({ kind: 'managed', provider: 'claude', status: 'logged_out' });
    expect(await readFile(join(directory, MANAGED, '.linejs-managed-account'), 'utf8')).toBe(MANAGED);

    const failing = fixture();
    const blocked = join(directory, 'file-not-directory');
    await (await import('node:fs/promises')).writeFile(blocked, 'x');
    await expect(new AccountSourceService({ repository: failing.store, bridge: failing.bridge, accountsDirectory: blocked, quota: failing.quota })
      .add({ provider: 'codex', label: 'Broken' })).rejects.toThrow();
    expect(failing.calls).toEqual(['add', `remove:${MANAGED}`]);
    expect(failing.rows.map((item) => item.sourceId)).toEqual(['claude', 'codex']);
  });

  it('removes a source: resets only its residents, deletes the directory, and drops the cache', async () => {
    const f = fixture([row('claude', 'claude', 'system'), row('codex', 'codex', 'system'), row(MANAGED, 'claude', 'managed')]);
    const subject = service(f);
    await subject.login(MANAGED);
    expect(subject.cachedStatus(MANAGED)).not.toBeNull();
    const identity = residentIdentity({ accountId: null, chatType: null, chatId: null });
    const keys = { mine: residentKey(identity, 1, MANAGED), other: residentKey(identity, 1, OTHER), system: residentKey(identity, 1, 'claude') };
    f.bridge.resetResidents.mockImplementation((predicate) => Object.values(keys).filter(predicate).length);
    await subject.remove(MANAGED);
    const predicate = f.bridge.resetResidents.mock.calls[0]![0];
    expect([keys.mine, keys.other, keys.system].map(predicate)).toEqual([true, false, false]);
    await expect(stat(join(directory, MANAGED))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(subject.cachedStatus(MANAGED)).toBeNull();
  });

  it('keeps a directory whose marker differs, as a diagnostic, and still removes the row', async () => {
    const f = fixture([row('claude', 'claude', 'system'), row('codex', 'codex', 'system'), row(MANAGED, 'claude', 'managed')]);
    const diagnostic = vi.fn();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(directory, MANAGED), { recursive: true });
    await writeFile(join(directory, MANAGED, '.linejs-managed-account'), OTHER);
    await service(f, { onDiagnostic: diagnostic }).remove(MANAGED);
    expect(diagnostic).toHaveBeenCalledWith('account_directory_kept', MANAGED);
    expect(await stat(join(directory, MANAGED))).toBeTruthy();
  });

  it('refuses to remove a system or busy source with a typed error', async () => {
    const f = fixture();
    const subject = service(f);
    f.setRemoveResult('system');
    await expect(subject.remove('claude')).rejects.toMatchObject({ code: 'ACCOUNT_SOURCE_SYSTEM' });
    f.setRemoveResult('in_use');
    await expect(subject.remove(MANAGED)).rejects.toMatchObject({ code: 'ACCOUNT_SOURCE_IN_USE' });
    f.setRemoveResult('not_found');
    const error = await subject.remove(MANAGED).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountSourceServiceError);
    expect(error).toMatchObject({ code: 'ACCOUNT_SOURCE_NOT_FOUND' });
    expect(f.bridge.resetResidents).not.toHaveBeenCalled();
  });

  it('logs in through the bridge with the directory created, then checks the status again', async () => {
    const f = fixture([row('claude', 'claude', 'system'), row('codex', 'codex', 'system'), row(MANAGED, 'codex', 'managed')]);
    const { sources, result } = await service(f).login(MANAGED);
    expect(result.ok).toBe(true);
    expect(f.bridge.openLogin).toHaveBeenCalledWith('codex', { id: MANAGED, kind: 'managed' });
    expect(f.bridge.getAuthStatus).toHaveBeenCalledWith('codex', { id: MANAGED, kind: 'managed' });
    expect(await readFile(join(directory, MANAGED, '.linejs-managed-account'), 'utf8')).toBe(MANAGED);
    expect(sources.find((item) => item.id === MANAGED)?.status).toBe('logged_in');
    // A system source gets no directory.
    await service(f).login('claude');
    await expect(stat(join(directory, 'claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks the effective default, orders the rotation, and reports sources in use', async () => {
    const f = fixture([row('claude', 'claude', 'system'), row('codex', 'codex', 'system'), row(MANAGED, 'claude', 'managed'),
      row(OTHER, 'claude', 'managed', { fallbackEnabled: false })]);
    const subject = service(f, { busySourceIds: async () => new Set([MANAGED]) });
    let list = await subject.list();
    // No managed default: the system rows are the defaults.
    expect(list.filter((item) => item.isDefault).map((item) => item.id).sort()).toEqual(['claude', 'codex']);
    expect(list.find((item) => item.id === OTHER)).toMatchObject({ order: null, fallbackEnabled: false });
    expect(list.at(-1)?.id).toBe(OTHER);
    expect(list.find((item) => item.id === MANAGED)).toMatchObject({ inUse: true, status: 'unknown', detail: null });
    f.rows.find((item) => item.sourceId === MANAGED)!.isDefault = true;
    list = await subject.list();
    expect(list.filter((item) => item.provider === 'claude' && item.isDefault).map((item) => item.id)).toEqual([MANAGED]);
    expect(list.map((item) => item.order).filter((order) => order !== null)).toEqual([0, 1, 2]);
    expect(JSON.stringify(list)).not.toMatch(/llm-accounts|@/);
  });
});
