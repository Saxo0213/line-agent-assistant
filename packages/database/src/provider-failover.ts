/**
 * Pure provider-failover rules. This is a port of CliTalkAgent `src/provider_failover.rs`
 * and `provider_usage.rs::quota_decision`. The module does no I/O and never reads the clock:
 * every function that needs a time takes it as an argument (epoch ms).
 * State transitions return a new object. They never change their input.
 */

export type FailoverProvider = 'claude' | 'codex';
export type FailureKind = 'quota_exhausted' | 'transient_rate_limit' | 'non_quota' | 'unknown';
export type FailureClass = 'quota_exhausted' | 'transient_rate_limit' | 'non_quota';

/**
 * How long to wait before the next try when the reset time is unknown (the turn error text has none and
 * the usage cache shows none). It is the shortest Claude quota window (5 hours).
 * CTA UNKNOWN_RESET_RETRY_MS (provider_failover.rs:17).
 */
export const UNKNOWN_RESET_RETRY_MS = 5 * 60 * 60 * 1000;
/** The normal usage refresh interval for a blocked source (300 s). */
export const NORMAL_USAGE_REFRESH_MS = 300 * 1000;

/** Structural usage input. It is compatible with ProviderQuotaSnapshot. */
export interface UsageObservationInput {
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  availabilityKnown: boolean;
  windows: { usedPercent: number; resetsAt: string | null; blocksProvider: boolean }[];
}

export type QuotaDecision =
  | { kind: 'available' }
  | { kind: 'limited' }
  | { kind: 'exhausted'; resetsAtMs: number | null }
  | { kind: 'unknown' };

/** Failover state of one source. Times are epoch ms or null. */
export interface SourceFailoverState {
  sourceId: string;
  blocked: boolean;
  blockedAt: number | null;
  recoveryAt: number | null;
  failureKind: FailureKind;
  failureCount: number;
  lastUsageFetchedAt: number | null;
  lastProbeAt: number | null;
  evidence: string | null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

function fetchedAtMs(usage: UsageObservationInput): number | null {
  const ms = parseIsoMs(usage.fetchedAt);
  return ms !== null && ms !== 0 ? ms : null;
}

function blockingWindows(usage: UsageObservationInput) {
  return usage.windows.filter((window) => window.blocksProvider);
}

function minResetMs(windows: UsageObservationInput['windows']): number | null {
  const resets = windows.map((window) => parseIsoMs(window.resetsAt)).filter((ms): ms is number => ms !== null);
  return resets.length ? Math.min(...resets) : null;
}

/** CTA quota_decision (provider_usage.rs:1001-1024). Only windows that block the source count. */
export function quotaDecision(usage: UsageObservationInput): QuotaDecision {
  const windows = blockingWindows(usage);
  if (usage.stale || !usage.availabilityKnown || windows.length === 0) return { kind: 'unknown' };
  const maxUsed = windows.reduce((max, window) => Math.max(max, window.usedPercent), 0);
  if (maxUsed >= 98) {
    return { kind: 'exhausted', resetsAtMs: minResetMs(windows.filter((window) => window.usedPercent >= 98)) };
  }
  return { kind: maxUsed >= 90 ? 'limited' : 'available' };
}

/**
 * CTA block_source (provider_failover.rs:137-172).
 * Deliberate difference (D20): CTA sets lastUsageFetchedAt to None here. With None, usage data that
 * was fetched before the failure counts as newer and it unblocks the source at once. We set it to the
 * failure time, so only data fetched after the failure can unblock the source.
 */
export function blockSource(
  previous: SourceFailoverState | null,
  input: { sourceId: string; now: number; recoveryAt: number | null; evidence: string },
): SourceFailoverState {
  return {
    sourceId: input.sourceId,
    blocked: true,
    blockedAt: input.now,
    recoveryAt: input.recoveryAt,
    failureKind: 'quota_exhausted',
    failureCount: (previous?.failureCount ?? 0) + 1,
    lastUsageFetchedAt: input.now,
    lastProbeAt: null,
    evidence: redactSensitiveDetail(input.evidence),
  };
}

/** CTA mark_usage_probe (provider_failover.rs:195-210). */
export function markUsageProbe(
  state: SourceFailoverState | null,
  probedAt: number,
): { state: SourceFailoverState | null; marked: boolean } {
  if (!state || !state.blocked || (state.lastProbeAt !== null && state.lastProbeAt >= probedAt)) return { state, marked: false };
  return { state: { ...state, lastProbeAt: probedAt }, marked: true };
}

/** CTA sources_due_for_usage_refresh (provider_failover.rs:261-284). Result is sorted by source id. */
export function sourcesDueForUsageRefresh(
  states: Iterable<SourceFailoverState>,
  now: number,
  normalRefreshMs: number = NORMAL_USAGE_REFRESH_MS,
): string[] {
  const interval = Math.max(normalRefreshMs, 1);
  return [...states]
    .filter((source) => source.blocked)
    .filter((source) => {
      if (source.lastProbeAt !== null) return Math.max(now - source.lastProbeAt, 0) >= interval;
      if (source.recoveryAt !== null) return now >= source.recoveryAt;
      return source.blockedAt !== null && Math.max(now - source.blockedAt, 0) >= interval;
    })
    .map((source) => source.sourceId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * CTA apply_usage_observation (provider_failover.rs:286-351).
 * `state` null means the source has no failover record yet.
 * Fresh exhausted usage creates a block for a source that has no record. A source that has a record
 * but is not blocked stays unblocked (only a turn failure blocks it again).
 */
export function applyUsageObservation(
  state: SourceFailoverState | null,
  sourceId: string,
  usage: UsageObservationInput,
): { state: SourceFailoverState | null; recovered: boolean } {
  const fetchedAt = fetchedAtMs(usage);
  if (usage.stale || fetchedAt === null) return { state, recovered: false };
  const decision = quotaDecision(usage);
  if (!state) {
    if (decision.kind === 'exhausted') {
      return {
        state: {
          sourceId, blocked: true, blockedAt: fetchedAt, recoveryAt: decision.resetsAtMs, failureKind: 'quota_exhausted',
          failureCount: 1, lastUsageFetchedAt: fetchedAt, lastProbeAt: fetchedAt, evidence: 'structured usage reached quota threshold',
        },
        recovered: false,
      };
    }
    return { state, recovered: false };
  }
  if (!state.blocked || (state.lastUsageFetchedAt !== null && fetchedAt <= state.lastUsageFetchedAt)) return { state, recovered: false };
  switch (decision.kind) {
    case 'available':
      return { state: { ...state, blocked: false, recoveryAt: null, evidence: null, lastUsageFetchedAt: fetchedAt }, recovered: true };
    case 'limited':
      return { state: { ...state, lastUsageFetchedAt: fetchedAt }, recovered: false };
    case 'exhausted':
      return {
        state: { ...state, lastUsageFetchedAt: fetchedAt, recoveryAt: decision.resetsAtMs !== null ? decision.resetsAtMs : state.recoveryAt },
        recovered: false,
      };
    default:
      return { state, recovered: false };
  }
}

/**
 * CTA apply_reset_time_recovery (provider_failover.rs:367-405). It unblocks a source when the quota
 * reset time has passed and no fresh usage data can decide. See the CTA comment for the 2026-11-04 incident:
 * the usage API needs an OAuth token that only a running CLI renews, so a blocked source may never get fresh usage.
 * Fresh usage that can be decided always goes to applyUsageObservation; this function does not act then.
 * The reset time comes from recoveryAt, else from the exhausted windows of the usage (stale data too),
 * else the source stays blocked for UNKNOWN_RESET_RETRY_MS.
 */
export function applyResetTimeRecovery(
  state: SourceFailoverState | null,
  usage: UsageObservationInput,
  now: number,
): { state: SourceFailoverState | null; recovered: boolean } {
  const freshEvidence = !usage.stale && fetchedAtMs(usage) !== null && quotaDecision(usage).kind !== 'unknown';
  if (freshEvidence || !state || !state.blocked || state.failureKind !== 'quota_exhausted') return { state, recovered: false };
  const recoveryAt = state.recoveryAt ?? exhaustedWindowResetMs(usage);
  const retryAt = recoveryAt ?? (state.blockedAt !== null ? state.blockedAt + UNKNOWN_RESET_RETRY_MS : null);
  if (retryAt === null || now < retryAt) return { state: { ...state, recoveryAt }, recovered: false };
  return { state: { ...state, blocked: false, recoveryAt: null, evidence: null }, recovered: true };
}

/** The earliest reset time of the full windows (>= 98 %). Stale data is read too: a reset time does not age. */
function exhaustedWindowResetMs(usage: UsageObservationInput): number | null {
  return minResetMs(blockingWindows(usage).filter((window) => window.usedPercent >= 98));
}

export interface RouteCandidate {
  provider: FailoverProvider;
  sourceId: string;
  isDefault: boolean;
  available: boolean;
}

export interface RouteInput {
  preferredProvider: FailoverProvider;
  currentSourceId: string | null;
  candidates: RouteCandidate[];
  normalizedOrder: string[];
  failover: { sources: ReadonlyMap<string, { blocked: boolean }>; loadError?: string | null };
}

export type RouteDecision =
  | { kind: 'use'; provider: FailoverProvider; sourceId: string }
  | { kind: 'switch_required'; provider: FailoverProvider; sourceId: string }
  | { kind: 'all_sources_exhausted' }
  | { kind: 'no_available_source' };

/** CTA route_next (provider_failover.rs:536-615). */
export function routeNext(input: RouteInput): RouteDecision {
  if (input.failover.loadError) return { kind: 'no_available_source' };
  const ordered: RouteCandidate[] = [];
  const seen = new Set<string>();
  const other: FailoverProvider = input.preferredProvider === 'claude' ? 'codex' : 'claude';
  for (const provider of [input.preferredProvider, other]) {
    const preferredDefault = input.candidates.find((candidate) => candidate.provider === provider && candidate.isDefault);
    if (preferredDefault) {
      seen.add(preferredDefault.sourceId);
      ordered.push(preferredDefault);
    }
    for (const id of input.normalizedOrder) {
      if (seen.has(id)) continue;
      const candidate = input.candidates.find((item) => item.provider === provider && item.sourceId === id);
      if (candidate) {
        seen.add(candidate.sourceId);
        ordered.push(candidate);
      }
    }
    for (const candidate of input.candidates.filter((item) => item.provider === provider)) {
      if (!seen.has(candidate.sourceId)) {
        seen.add(candidate.sourceId);
        ordered.push(candidate);
      }
    }
  }
  const isBlocked = (candidate: RouteCandidate) => input.failover.sources.get(candidate.sourceId)?.blocked === true;
  const selected = ordered.filter((candidate) => candidate.available).find((candidate) => !isBlocked(candidate));
  if (selected) {
    return { kind: selected.sourceId === input.currentSourceId ? 'use' : 'switch_required', provider: selected.provider, sourceId: selected.sourceId };
  }
  return ordered.length > 0 && ordered.every(isBlocked) ? { kind: 'all_sources_exhausted' } : { kind: 'no_available_source' };
}

/** CTA redact_sensitive_detail (provider_failover.rs:628-651). The compact limit is 500 characters. */
export function redactSensitiveDetail(value: string): string {
  const lower = value.toLowerCase();
  const needles = [
    'authorization', 'bearer ', 'api_key', 'api key', 'x-api-key', 'auth_token', 'anthropic_auth_token', 'access_token',
    'refresh_token', 'oauth_token', 'client_secret', 'sk-',
  ];
  if (needles.some((needle) => lower.includes(needle))) return 'provider failure (sensitive details redacted)';
  return [...value.trim()].slice(0, 500).join('');
}
