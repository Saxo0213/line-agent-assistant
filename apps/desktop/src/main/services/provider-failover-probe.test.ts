import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderFailoverProbe, type ProviderFailoverProbeDependencies } from './provider-failover-probe.js';

type Source = { id: string; provider: 'claude' | 'codex'; kind: 'system' | 'managed'; status: 'logged_in' | 'logged_out' | 'not_installed' | 'error' | 'unknown' };
const snapshot = { fetchedAt: '2026-11-19T00:00:00.000Z', stale: false, requestedAt: '2026-11-19T00:00:00.000Z', windows: [] };

function fixture(input: { enabled?: boolean; blocked?: string[]; won?: string[]; unblocked?: string[]; sources?: Source[]; failUsageFor?: string } = {}) {
  const log: string[] = [];
  const reported: unknown[] = [];
  let closing = false;
  let active = 0;
  let maxActive = 0;
  const sources: Source[] = input.sources ?? [{ id: 'claude', provider: 'claude', kind: 'system', status: 'logged_in' }, { id: 'codex', provider: 'codex', kind: 'system', status: 'logged_in' }];
  const deps: ProviderFailoverProbeDependencies = {
    enabled: async () => input.enabled ?? true,
    isClosing: () => closing,
    quota: {
      list: async () => sources.map((source) => ({ sourceId: source.id, blocked: (input.blocked ?? []).includes(source.id) })),
      claimProbe: async (id) => { log.push(`claim:${id}`); return (input.won ?? []).includes(id); },
      observe: async ({ sourceId }) => { log.push(`observe:${sourceId}`); return { blocked: false, unblocked: (input.unblocked ?? []).includes(sourceId) }; },
    },
    sources: { list: async () => sources },
    refreshLoginStatus: async () => { log.push('login'); },
    usage: { refreshNow: async (_provider, account) => {
      log.push(`usage:${account.id}`);
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (input.failUsageFor === account.id) throw new Error('usage failed');
      return snapshot;
    } },
    pendingTurns: { noteSourceRecovery: async (id) => { log.push(`recovery:${id}`); return 1; } },
    failoverTurns: { recoverExhausted: async (limit) => { log.push(`recover:${limit}`); return 0; } },
    report: (error) => { reported.push(error); },
  };
  const probe = new ProviderFailoverProbe(deps);
  return { probe, log, reported, close: () => { closing = true; }, maxActive: () => maxActive };
}

afterEach(() => { vi.useRealTimers(); });

describe('ProviderFailoverProbe', () => {
  it('probes only a won claim, notes the recovery, then replays', async () => {
    const f = fixture({ blocked: ['claude', 'codex'], won: ['claude'], unblocked: ['claude'] });
    await f.probe.tick();
    expect(f.log).toEqual(['claim:claude', 'usage:claude', 'observe:claude', 'recovery:claude', 'claim:codex', 'recover:8']);
  });

  it('replays on every tick even with no blocked source', async () => {
    const f = fixture();
    await f.probe.tick();
    expect(f.log).toEqual(['recover:8']);
  });

  it('does not note a recovery when the source stays blocked, and one failure does not stop the others', async () => {
    const f = fixture({ blocked: ['claude', 'codex'], won: ['claude', 'codex'], unblocked: ['codex'], failUsageFor: 'claude' });
    await f.probe.tick();
    expect(f.log).toEqual(['claim:claude', 'usage:claude', 'claim:codex', 'usage:codex', 'observe:codex', 'recovery:codex', 'recover:8']);
    expect(f.reported).toHaveLength(1);
  });

  it('does nothing with the switch off or while closing', async () => {
    const off = fixture({ enabled: false, blocked: ['claude'], won: ['claude'] });
    await off.probe.tick();
    expect(off.log).toEqual([]);
    const closing = fixture();
    closing.close();
    await closing.probe.tick();
    expect(closing.log).toEqual([]);
  });

  it('runs the 30 s tick and the 300 s refresh one source at a time', async () => {
    vi.useFakeTimers();
    const f = fixture({ blocked: ['codex'], sources: [
      { id: 'claude', provider: 'claude', kind: 'system', status: 'logged_in' }, { id: 'codex', provider: 'codex', kind: 'system', status: 'logged_in' },
      { id: 'out', provider: 'claude', kind: 'managed', status: 'logged_out' }, { id: 'two', provider: 'codex', kind: 'managed', status: 'unknown' }] });
    f.probe.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.log).toEqual(['claim:codex', 'recover:8']);
    await vi.advanceTimersByTimeAsync(30_000 * 8);
    expect(f.log).not.toContain('login');
    f.log.length = 0;
    await vi.advanceTimersByTimeAsync(30_050);
    expect(f.log).toEqual(['claim:codex', 'login', 'usage:claude', 'observe:claude', 'usage:two', 'observe:two', 'recover:8']);
    expect(f.maxActive()).toBe(1);
    f.probe.stop();
    f.log.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.log).toEqual([]);
  });

  it('skips a tick while the earlier tick still runs', async () => {
    const f = fixture({ blocked: ['claude'], won: ['claude'] });
    const first = f.probe.tick();
    await f.probe.tick();
    await first;
    expect(f.log.filter((entry) => entry === 'claim:claude')).toHaveLength(1);
  });
});
