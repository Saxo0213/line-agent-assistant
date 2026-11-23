import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_RESET_RETRY_MS, applyResetTimeRecovery, applyUsageObservation, blockSource,
  markUsageProbe, redactSensitiveDetail, routeNext, sourcesDueForUsageRefresh,
  type FailoverProvider, type RouteCandidate, type RouteDecision, type SourceFailoverState, type UsageObservationInput,
} from './provider-failover.js';

const candidate = (provider: FailoverProvider, sourceId: string, isDefault: boolean): RouteCandidate => ({ provider, sourceId, isDefault, available: true });

const blocked = (sourceId: string): SourceFailoverState => ({
  sourceId, blocked: true, blockedAt: 10, recoveryAt: null, failureKind: 'quota_exhausted', failureCount: 1,
  lastUsageFetchedAt: null, lastProbeAt: null, evidence: 'quota',
});

const usage = (fetchedAt: number, usedPercent: number): UsageObservationInput => ({
  fetchedAt: new Date(fetchedAt).toISOString(), stale: false, error: null, availabilityKnown: true,
  windows: [{ usedPercent, resetsAt: null, blocksProvider: true }],
});

const sourcesOf = (...states: SourceFailoverState[]) => new Map(states.map((state) => [state.sourceId, state]));

describe('provider failover rules (CTA port)', () => {
  it('does not report mixed quota and unavailable sources as all exhausted', () => {
    const decision = routeNext({
      preferredProvider: 'claude', currentSourceId: 'claude',
      candidates: [candidate('claude', 'claude', true), { ...candidate('claude', 'claude-b', false), available: false }, { ...candidate('codex', 'codex', true), available: false }],
      normalizedOrder: ['claude', 'claude-b', 'codex'],
      failover: { sources: sourcesOf(blocked('claude')) },
    });
    expect(decision).toEqual({ kind: 'no_available_source' });
  });

  it('creates a block from fresh structured exhaustion but not from stale usage', () => {
    const first = applyUsageObservation(null, 'claude-a', usage(100, 98));
    expect(first.recovered).toBe(false);
    expect(first.state).toMatchObject({ blocked: true, blockedAt: 100, failureKind: 'quota_exhausted', failureCount: 1, lastUsageFetchedAt: 100, lastProbeAt: 100 });
    const stale = { ...usage(101, 100), stale: true };
    expect(applyUsageObservation(null, 'claude-b', stale)).toEqual({ state: null, recovered: false });
  });

  it('redacts credentials from the stored failure reason', () => {
    const redacted = redactSensitiveDetail('Authorization: Bearer secret-token-value');
    expect(redacted).not.toContain('secret-token-value');
    expect(redacted).toContain('redacted');
    for (const detail of ['x-api-key: secret-one', 'auth_token=secret-two', 'ANTHROPIC_AUTH_TOKEN=secret-three', 'client_secret=secret-four']) {
      const result = redactSensitiveDetail(detail);
      expect(result).not.toContain('secret-');
      expect(result).toContain('redacted');
    }
    expect(redactSensitiveDetail(`  ${'x'.repeat(600)}  `)).toHaveLength(500);
  });

  it('walks A, B, then the other provider without cycling', () => {
    const candidates = [candidate('claude', 'claude-a', true), candidate('claude', 'claude-b', false), candidate('codex', 'codex-a', true), candidate('codex', 'codex-b', false)];
    const sources = new Map<string, SourceFailoverState>();
    const route = (): RouteDecision => routeNext({
      preferredProvider: 'claude', currentSourceId: 'claude-a', candidates,
      normalizedOrder: ['claude-a', 'claude-b', 'codex-a', 'codex-b'], failover: { sources },
    });
    expect(route()).toMatchObject({ kind: 'use', sourceId: 'claude-a' });
    sources.set('claude-a', blocked('claude-a'));
    expect(route()).toMatchObject({ kind: 'switch_required', sourceId: 'claude-b' });
    sources.set('claude-b', blocked('claude-b'));
    expect(route()).toMatchObject({ kind: 'switch_required', sourceId: 'codex-a' });
    sources.set('codex-a', blocked('codex-a'));
    expect(route()).toMatchObject({ kind: 'switch_required', sourceId: 'codex-b' });
    sources.set('codex-b', blocked('codex-b'));
    expect(route()).toEqual({ kind: 'all_sources_exhausted' });
    expect(route()).toEqual({ kind: 'all_sources_exhausted' });
  });

  it('fails closed when the failover state cannot be read', () => {
    expect(routeNext({
      preferredProvider: 'claude', currentSourceId: null, candidates: [candidate('claude', 'claude-a', true)], normalizedOrder: ['claude-a'],
      failover: { sources: new Map(), loadError: 'damaged' },
    })).toEqual({ kind: 'no_available_source' });
  });

  it('respects the reset time and the normal interval in the refresh schedule', () => {
    const known: SourceFailoverState = { ...blocked('known'), blockedAt: 100, recoveryAt: 1_000 };
    const unknown: SourceFailoverState = { ...blocked('unknown'), blockedAt: 700 };
    expect(sourcesDueForUsageRefresh([known, unknown], 999, 300)).toEqual([]);
    expect(sourcesDueForUsageRefresh([known, unknown], 1_000, 300)).toEqual(['known', 'unknown']);
    const probed = [{ ...known, lastProbeAt: 1_000 }, { ...unknown, lastProbeAt: 1_000 }];
    expect(sourcesDueForUsageRefresh(probed, 1_299, 300)).toEqual([]);
    expect(sourcesDueForUsageRefresh(probed, 1_300, 300)).toEqual(['known', 'unknown']);
    expect(sourcesDueForUsageRefresh([{ ...known, blocked: false }], 5_000, 300)).toEqual([]);
  });

  it('unblocks only from newer fresh usage below ninety percent', () => {
    for (const percent of [90, 97, 98, 100]) {
      const result = applyUsageObservation(blocked('claude-a'), 'claude-a', usage(200, percent));
      expect(result.recovered).toBe(false);
      expect(result.state?.blocked).toBe(true);
    }
    let state: SourceFailoverState | null = { ...blocked('claude-a'), lastUsageFetchedAt: 200 };
    expect(applyUsageObservation(state, 'claude-a', usage(199, 10)).recovered).toBe(false);
    expect(applyUsageObservation(state, 'claude-a', { ...usage(201, 10), stale: true }).recovered).toBe(false);
    const result = applyUsageObservation(state, 'claude-a', usage(201, 89.9));
    expect(result.recovered).toBe(true);
    state = result.state;
    expect(state).toMatchObject({ blocked: false, recoveryAt: null, evidence: null, lastUsageFetchedAt: 201 });
  });

  it('does not change its input state', () => {
    const state = blocked('claude-a');
    const before = JSON.stringify(state);
    applyUsageObservation(state, 'claude-a', usage(200, 10));
    applyResetTimeRecovery(state, usage(0, 0), 10 + UNKNOWN_RESET_RETRY_MS);
    markUsageProbe(state, 50);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('switches back to the preferred then the default source on recovery', () => {
    const candidates = [candidate('claude', 'claude-a', true), candidate('claude', 'claude-b', false), candidate('codex', 'codex-a', true)];
    const sources = new Map<string, SourceFailoverState>([['claude-a', blocked('claude-a')], ['claude-b', blocked('claude-b')]]);
    const route = () => routeNext({
      preferredProvider: 'claude', currentSourceId: 'codex-a', candidates, normalizedOrder: ['claude-a', 'claude-b', 'codex-a'], failover: { sources },
    });
    expect(route()).toMatchObject({ kind: 'use', sourceId: 'codex-a' });
    const b = applyUsageObservation(sources.get('claude-b')!, 'claude-b', usage(200, 20));
    expect(b.recovered).toBe(true);
    sources.set('claude-b', b.state!);
    expect(route()).toMatchObject({ kind: 'switch_required', sourceId: 'claude-b' });
    const a = applyUsageObservation(sources.get('claude-a')!, 'claude-a', usage(300, 20));
    expect(a.recovered).toBe(true);
    sources.set('claude-a', a.state!);
    expect(route()).toMatchObject({ kind: 'switch_required', sourceId: 'claude-a' });
  });

  it('unblocks by the reset time when only stale usage is available', () => {
    // The 2026-11-04 incident: the token expired after the block, only stale usage is left, the weekly window is 100 %
    // but its reset time has passed long ago. The source must unblock; it must not wait for fresh usage that never comes.
    const resetsAt = '2026-11-02T16:00:00.462757+00:00';
    const reset = Date.parse(resetsAt);
    const stale: UsageObservationInput = { ...usage(100, 100), stale: true, windows: [{ usedPercent: 100, resetsAt, blocksProvider: true }] };
    const early = applyResetTimeRecovery(blocked('claude'), stale, reset - 1);
    expect(early.recovered).toBe(false);
    expect(early.state).toMatchObject({ blocked: true, recoveryAt: reset });
    const due = applyResetTimeRecovery(early.state, stale, reset);
    expect(due.recovered).toBe(true);
    expect(due.state?.blocked).toBe(false);
  });

  it('defers to fresh usage and has a fallback for an unknown reset time', () => {
    const source: SourceFailoverState = { ...blocked('claude'), blockedAt: 1_000, recoveryAt: 2_000 };
    // Fresh usage that says full goes to applyUsageObservation. A passed time does not release the source here.
    const fresh = applyResetTimeRecovery(source, usage(3_000, 100), 5_000);
    expect(fresh.recovered).toBe(false);
    expect(fresh.state?.blocked).toBe(true);
    // The reset time is fully unknown: the source stays blocked for five hours.
    const noReset = { ...source, recoveryAt: null };
    const nothing: UsageObservationInput = { ...usage(0, 0), fetchedAt: null, windows: [] };
    expect(applyResetTimeRecovery(noReset, nothing, 1_000 + UNKNOWN_RESET_RETRY_MS - 1).recovered).toBe(false);
    expect(applyResetTimeRecovery(noReset, nothing, 1_000 + UNKNOWN_RESET_RETRY_MS).recovered).toBe(true);
  });

  it('marks a probe only for a blocked source and only once per time', () => {
    expect(markUsageProbe(null, 5)).toEqual({ state: null, marked: false });
    expect(markUsageProbe({ ...blocked('a'), blocked: false }, 5).marked).toBe(false);
    const first = markUsageProbe(blocked('a'), 5);
    expect(first).toMatchObject({ marked: true, state: { lastProbeAt: 5 } });
    expect(markUsageProbe(first.state, 5).marked).toBe(false);
    expect(markUsageProbe(first.state, 6).marked).toBe(true);
  });

  it('D20: a quota failure sets lastUsageFetchedAt to the failure time, so older usage cannot unblock', () => {
    const state = blockSource(null, { sourceId: 'claude-a', now: 1_000, recoveryAt: null, evidence: 'limit' });
    expect(state).toMatchObject({ blocked: true, blockedAt: 1_000, lastUsageFetchedAt: 1_000, lastProbeAt: null, failureCount: 1, failureKind: 'quota_exhausted' });
    const older = applyUsageObservation(state, 'claude-a', usage(900, 10));
    expect(older.recovered).toBe(false);
    expect(older.state?.blocked).toBe(true);
    expect(applyUsageObservation(state, 'claude-a', usage(1_001, 10)).recovered).toBe(true);
    expect(blockSource(state, { sourceId: 'claude-a', now: 2_000, recoveryAt: 5_000, evidence: 'again' })).toMatchObject({ failureCount: 2, recoveryAt: 5_000 });
  });
});
