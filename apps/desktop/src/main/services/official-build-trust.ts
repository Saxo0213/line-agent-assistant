/**
 * Official LINE build trust (docs/architecture/official-line-build-trust-update-2026-10-20.md).
 *
 * The native bridge decides `accepted` / `candidate` / `rotation` / `untrusted`
 * from the executable identity and its Authenticode signature before any
 * process memory is touched. This module only owns the persisted lists, the
 * promotion of a candidate after its first successful read session, and the
 * user approval of a changed signer. There is no timer, watcher or ledger file:
 * everything runs when a reader session reports.
 */

export const OFFICIAL_BUILD_MAX_ACCEPTED = 64;
export const OFFICIAL_BUILD_MAX_PINNED = 8;
/** Seeds shipped in code. They are always merged in and can never be removed. */
export const OFFICIAL_BUILD_SEED_BUILD: OfficialBuildIdentity = Object.freeze({
  version: '26.4.2.3957', bytes: 30_634_432,
  sha256: '893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',
});
export const OFFICIAL_BUILD_SEED_THUMBPRINT = '3E85990B906DD895BB28206319546E2EEBA81336';
const SEED_ACCEPTED_AT = '1970-01-01T00:00:00.000Z';
const MAX_CLIENT_BYTES = 128 * 1024 * 1024;
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const THUMBPRINT_PATTERN = /^[0-9A-F]{40}$/;
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

export type OfficialBuildIdentity = Readonly<{ version: string; bytes: number; sha256: string }>;
export type OfficialBuildAccepted = OfficialBuildIdentity & Readonly<{ acceptedAt: string }>;
export type OfficialBuildStatus = 'accepted' | 'candidate' | 'key_scan_failed' | 'schema_changed' | 'rotation' | 'untrusted';
export type OfficialBuildObservation = Readonly<{
  version: string | null;
  verdict: OfficialBuildStatus;
  reason: string | null;
  at: string;
  /** Present only for `rotation`: the signer awaiting the user's approval. */
  thumbprint?: string;
}>;
export type OfficialBuildTrustState = Readonly<{
  acceptedBuilds: readonly OfficialBuildAccepted[];
  pinnedThumbprints: readonly string[];
  lastObserved: OfficialBuildObservation | null;
}>;
/** Trust lists exactly as sent in the bridge `init` frame. */
export type OfficialBuildBridgeTrust = Readonly<{
  accepted: readonly OfficialBuildIdentity[];
  pinned: readonly string[];
}>;

export type OfficialBuildEvent =
  | Readonly<{ kind: 'observed'; verdict: 'accepted' | 'candidate'; build: OfficialBuildIdentity }>
  | Readonly<{ kind: 'validated'; build: OfficialBuildIdentity }>
  | Readonly<{ kind: 'failed'; verdict: 'key_scan_failed' | 'schema_changed'; build: OfficialBuildIdentity; reason: string }>
  | Readonly<{ kind: 'blocked'; verdict: 'rotation' | 'untrusted'; version: string | null; reason: string; thumbprint?: string }>;

/** What a reader session needs: the lists to send and a sink for its findings. */
export interface OfficialBuildTrustPort {
  bridgeTrust(): Promise<OfficialBuildBridgeTrust> | OfficialBuildBridgeTrust;
  record(event: OfficialBuildEvent): Promise<void> | void;
}

export interface OfficialBuildTrustStore {
  read(): Promise<unknown | null>;
  write(value: OfficialBuildTrustState): Promise<void>;
}

export function isOfficialBuildIdentity(value: unknown): value is OfficialBuildIdentity {
  if (value === null || typeof value !== 'object') return false;
  const build = value as Record<string, unknown>;
  return typeof build.version === 'string' && VERSION_PATTERN.test(build.version)
    && Number.isSafeInteger(build.bytes) && (build.bytes as number) >= 1 && (build.bytes as number) <= MAX_CLIENT_BYTES
    && typeof build.sha256 === 'string' && SHA256_PATTERN.test(build.sha256);
}

export function isOfficialSignerThumbprint(value: unknown): value is string {
  return typeof value === 'string' && THUMBPRINT_PATTERN.test(value);
}

export function isOfficialBuildReason(value: unknown): value is string {
  return typeof value === 'string' && REASON_PATTERN.test(value);
}

export function compareOfficialVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

const seedAccepted = (): OfficialBuildAccepted => ({ ...OFFICIAL_BUILD_SEED_BUILD, acceptedAt: SEED_ACCEPTED_AT });
const isSeedBuild = (build: OfficialBuildIdentity): boolean =>
  build.bytes === OFFICIAL_BUILD_SEED_BUILD.bytes && build.sha256 === OFFICIAL_BUILD_SEED_BUILD.sha256;

/** State with nothing persisted: seeds only. */
export function initialOfficialBuildTrustState(): OfficialBuildTrustState {
  return { acceptedBuilds: [seedAccepted()], pinnedThumbprints: [OFFICIAL_BUILD_SEED_THUMBPRINT], lastObserved: null };
}

/**
 * Parse persisted JSON defensively. Invalid entries are dropped, seeds are
 * always merged in, and lists are clamped to their bounds (oldest non-seed
 * entries are dropped first). Anything unusable degrades to the seeds, which
 * can only ever make trust narrower than the user last had it.
 */
export function normalizeOfficialBuildTrustState(raw: unknown): OfficialBuildTrustState {
  const seeds = initialOfficialBuildTrustState();
  if (raw === null || typeof raw !== 'object') return seeds;
  const source = raw as Record<string, unknown>;
  const accepted: OfficialBuildAccepted[] = [seedAccepted()];
  if (Array.isArray(source.acceptedBuilds)) {
    for (const item of source.acceptedBuilds) {
      if (!isOfficialBuildIdentity(item) || isSeedBuild(item)) continue;
      const acceptedAt = (item as Record<string, unknown>).acceptedAt;
      if (accepted.some((existing) => existing.bytes === item.bytes && existing.sha256 === item.sha256)) continue;
      accepted.push({ version: item.version, bytes: item.bytes, sha256: item.sha256,
        acceptedAt: typeof acceptedAt === 'string' && !Number.isNaN(Date.parse(acceptedAt)) ? acceptedAt : SEED_ACCEPTED_AT });
    }
  }
  const pinned: string[] = [OFFICIAL_BUILD_SEED_THUMBPRINT];
  if (Array.isArray(source.pinnedThumbprints)) {
    for (const item of source.pinnedThumbprints) {
      if (isOfficialSignerThumbprint(item) && !pinned.includes(item)) pinned.push(item);
    }
  }
  return {
    acceptedBuilds: clampAccepted(accepted),
    pinnedThumbprints: pinned.slice(0, OFFICIAL_BUILD_MAX_PINNED),
    lastObserved: normalizeObservation(source.lastObserved),
  };
}

function clampAccepted(builds: OfficialBuildAccepted[]): OfficialBuildAccepted[] {
  const result = [...builds];
  while (result.length > OFFICIAL_BUILD_MAX_ACCEPTED) {
    const index = result.findIndex((build) => !isSeedBuild(build));
    if (index < 0) break;
    result.splice(index, 1);
  }
  return result;
}

const STATUSES: readonly OfficialBuildStatus[] = ['accepted', 'candidate', 'key_scan_failed', 'schema_changed', 'rotation', 'untrusted'];
function normalizeObservation(value: unknown): OfficialBuildObservation | null {
  if (value === null || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!STATUSES.includes(item.verdict as OfficialBuildStatus) || typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) return null;
  const version = typeof item.version === 'string' && VERSION_PATTERN.test(item.version) ? item.version : null;
  const reason = isOfficialBuildReason(item.reason) ? item.reason : null;
  return {
    version, verdict: item.verdict as OfficialBuildStatus, reason, at: item.at,
    ...(item.verdict === 'rotation' && isOfficialSignerThumbprint(item.thumbprint) ? { thumbprint: item.thumbprint } : {}),
  };
}

export function officialBuildBridgeTrust(state: OfficialBuildTrustState): OfficialBuildBridgeTrust {
  return {
    accepted: state.acceptedBuilds.map(({ version, bytes, sha256 }) => ({ version, bytes, sha256 })),
    pinned: [...state.pinnedThumbprints],
  };
}

/** Pure transition. A candidate is promoted only by a `validated` event. */
export function applyOfficialBuildEvent(state: OfficialBuildTrustState, event: OfficialBuildEvent, now: Date): OfficialBuildTrustState {
  const at = now.toISOString();
  switch (event.kind) {
    case 'observed':
      return { ...state, lastObserved: { version: event.build.version, verdict: event.verdict, reason: null, at } };
    case 'validated': {
      const known = state.acceptedBuilds.some((build) => build.bytes === event.build.bytes && build.sha256 === event.build.sha256);
      const acceptedBuilds = known ? state.acceptedBuilds
        : clampAccepted([...state.acceptedBuilds, { ...event.build, acceptedAt: at }]);
      return { ...state, acceptedBuilds, lastObserved: { version: event.build.version, verdict: 'accepted', reason: null, at } };
    }
    case 'failed':
      return { ...state, lastObserved: { version: event.build.version, verdict: event.verdict, reason: event.reason, at } };
    case 'blocked':
      return { ...state, lastObserved: { version: event.version, verdict: event.verdict, reason: event.reason, at,
        ...(event.verdict === 'rotation' && event.thumbprint ? { thumbprint: event.thumbprint } : {}) } };
  }
}

/** Approve the signer recorded by the last `rotation` observation. Never automatic. */
export function approveOfficialSigner(state: OfficialBuildTrustState, now: Date): OfficialBuildTrustState {
  const observed = state.lastObserved;
  if (observed?.verdict !== 'rotation' || !observed.thumbprint) throw new Error('official_signer_not_pending');
  if (state.pinnedThumbprints.includes(observed.thumbprint)) throw new Error('official_signer_not_pending');
  if (state.pinnedThumbprints.length >= OFFICIAL_BUILD_MAX_PINNED) throw new Error('official_signer_limit');
  return {
    ...state,
    pinnedThumbprints: [...state.pinnedThumbprints, observed.thumbprint],
    // The new signer is trusted for the next read, which verifies the build.
    lastObserved: { version: observed.version, verdict: 'candidate', reason: null, at: now.toISOString() },
  };
}

/**
 * Serialises reads and writes of the one persisted state. A failed write
 * leaves the in-memory state untouched, so a candidate that could not be
 * persisted stays a candidate and is retried by the next reader session.
 */
export class OfficialBuildTrustService implements OfficialBuildTrustPort {
  readonly #store: OfficialBuildTrustStore;
  readonly #clock: () => Date;
  #state: OfficialBuildTrustState | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(store: OfficialBuildTrustStore, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#clock = clock;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** A failed read is never cached: it would let a later write replace persisted trust with seeds. */
  #readFailed = false;

  async #load(): Promise<OfficialBuildTrustState> {
    if (this.#state) return this.#state;
    let raw: unknown = null;
    try {
      raw = await this.#store.read();
    } catch {
      this.#readFailed = true;
      return normalizeOfficialBuildTrustState(null);
    }
    this.#readFailed = false;
    this.#state = normalizeOfficialBuildTrustState(raw);
    return this.#state;
  }

  state(): Promise<OfficialBuildTrustState> { return this.#exclusive(() => this.#load()); }

  async bridgeTrust(): Promise<OfficialBuildBridgeTrust> { return officialBuildBridgeTrust(await this.state()); }

  record(event: OfficialBuildEvent): Promise<void> {
    return this.#exclusive(async () => {
      const current = await this.#load();
      if (this.#readFailed) return;
      await this.#commit(applyOfficialBuildEvent(current, event, this.#clock()));
    });
  }

  approveRotation(): Promise<OfficialBuildTrustState> {
    return this.#exclusive(async () => {
      const current = await this.#load();
      if (this.#readFailed) throw new Error('official_build_trust_unavailable');
      const next = approveOfficialSigner(current, this.#clock());
      await this.#commit(next);
      return next;
    });
  }

  async #commit(next: OfficialBuildTrustState): Promise<void> {
    await this.#store.write(next);
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* a projection listener must never break a read session */ }
    }
  }
}
