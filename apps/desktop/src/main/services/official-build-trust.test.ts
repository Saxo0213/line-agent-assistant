import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_BUILD_MAX_ACCEPTED, OFFICIAL_BUILD_MAX_PINNED, OFFICIAL_BUILD_SEED_BUILD, OFFICIAL_BUILD_SEED_THUMBPRINT,
  OfficialBuildTrustService, applyOfficialBuildEvent, approveOfficialSigner, compareOfficialVersions,
  initialOfficialBuildTrustState, normalizeOfficialBuildTrustState, officialBuildBridgeTrust,
  type OfficialBuildIdentity, type OfficialBuildTrustState, type OfficialBuildTrustStore,
} from './official-build-trust.js';

const NOW = new Date('2026-10-20T00:00:00.000Z');
const build = (n: number): OfficialBuildIdentity => ({ version: `26.5.0.${n}`, bytes: 30_000_000 + n, sha256: n.toString(16).padStart(64, '0') });
const thumb = (n: number) => n.toString(16).toUpperCase().padStart(40, '0');

function memoryStore(initial: unknown = null, options: { failWrites?: () => boolean } = {}): OfficialBuildTrustStore & { value: unknown; writes: number } {
  const store = {
    value: initial, writes: 0,
    async read() { return store.value; },
    async write(value: OfficialBuildTrustState) {
      if (options.failWrites?.()) throw new Error('db_down');
      store.writes++;
      store.value = JSON.parse(JSON.stringify(value));
    },
  };
  return store;
}

describe('official LINE build trust state', () => {
  it('always contains the code seeds and the pinned LY thumbprint', () => {
    const state = initialOfficialBuildTrustState();
    expect(state.acceptedBuilds).toEqual([expect.objectContaining({ version: '26.4.2.3957', bytes: 30_634_432,
      sha256: '893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1' })]);
    expect(state.pinnedThumbprints).toEqual(['3E85990B906DD895BB28206319546E2EEBA81336']);
    expect(officialBuildBridgeTrust(state)).toEqual({ accepted: [OFFICIAL_BUILD_SEED_BUILD], pinned: [OFFICIAL_BUILD_SEED_THUMBPRINT] });
    expect(normalizeOfficialBuildTrustState(null)).toEqual(state);
    expect(normalizeOfficialBuildTrustState('garbage')).toEqual(state);
  });

  it('re-merges seeds when persisted state omits them and drops invalid entries', () => {
    const state = normalizeOfficialBuildTrustState({
      acceptedBuilds: [{ ...build(1), acceptedAt: NOW.toISOString() }, { version: 'x', bytes: 1, sha256: 'bad', acceptedAt: 'x' },
        { ...build(1), acceptedAt: NOW.toISOString() }, { ...OFFICIAL_BUILD_SEED_BUILD, version: '1.1.1.1', acceptedAt: NOW.toISOString() }],
      pinnedThumbprints: [thumb(1), 'nope', thumb(1), 'a'.repeat(40)],
      lastObserved: { version: '26.5.0.1', verdict: 'candidate', reason: null, at: NOW.toISOString() },
    });
    expect(state.acceptedBuilds.map((item) => item.version)).toEqual(['26.4.2.3957', '26.5.0.1']);
    expect(state.pinnedThumbprints).toEqual([OFFICIAL_BUILD_SEED_THUMBPRINT, thumb(1)]);
    expect(state.lastObserved).toMatchObject({ version: '26.5.0.1', verdict: 'candidate' });
  });

  it('bounds both lists and never evicts a seed', () => {
    const many = normalizeOfficialBuildTrustState({
      acceptedBuilds: Array.from({ length: 100 }, (_, i) => ({ ...build(i + 1), acceptedAt: NOW.toISOString() })),
      pinnedThumbprints: Array.from({ length: 20 }, (_, i) => thumb(i + 1)),
    });
    expect(many.acceptedBuilds).toHaveLength(OFFICIAL_BUILD_MAX_ACCEPTED);
    expect(many.acceptedBuilds[0]).toMatchObject({ sha256: OFFICIAL_BUILD_SEED_BUILD.sha256 });
    expect(many.pinnedThumbprints).toHaveLength(OFFICIAL_BUILD_MAX_PINNED);
    expect(many.pinnedThumbprints[0]).toBe(OFFICIAL_BUILD_SEED_THUMBPRINT);
    let state: OfficialBuildTrustState = many;
    for (let i = 200; i < 230; i++) state = applyOfficialBuildEvent(state, { kind: 'validated', build: build(i) }, NOW);
    expect(state.acceptedBuilds).toHaveLength(OFFICIAL_BUILD_MAX_ACCEPTED);
    expect(state.acceptedBuilds[0]).toMatchObject({ sha256: OFFICIAL_BUILD_SEED_BUILD.sha256 });
    expect(state.acceptedBuilds.at(-1)).toMatchObject({ version: '26.5.0.229' });
  });

  it('promotes a candidate only on a validated event and is idempotent', () => {
    let state = initialOfficialBuildTrustState();
    state = applyOfficialBuildEvent(state, { kind: 'observed', verdict: 'candidate', build: build(3975) }, NOW);
    expect(state.acceptedBuilds).toHaveLength(1);
    expect(state.lastObserved).toMatchObject({ version: '26.5.0.3975', verdict: 'candidate' });
    state = applyOfficialBuildEvent(state, { kind: 'validated', build: build(3975) }, NOW);
    expect(state.acceptedBuilds.map((item) => item.version)).toEqual(['26.4.2.3957', '26.5.0.3975']);
    expect(state.lastObserved).toMatchObject({ version: '26.5.0.3975', verdict: 'accepted', reason: null });
    const again = applyOfficialBuildEvent(state, { kind: 'validated', build: build(3975) }, NOW);
    expect(again.acceptedBuilds).toHaveLength(2);
  });

  it('records key and schema failures without promoting', () => {
    for (const verdict of ['key_scan_failed', 'schema_changed'] as const) {
      const state = applyOfficialBuildEvent(initialOfficialBuildTrustState(),
        { kind: 'failed', verdict, build: build(3975), reason: 'key_unavailable' }, NOW);
      expect(state.acceptedBuilds).toHaveLength(1);
      expect(state.lastObserved).toMatchObject({ version: '26.5.0.3975', verdict, reason: 'key_unavailable' });
    }
  });

  it('pins a rotated signer only through explicit approval of the recorded thumbprint', () => {
    let state = applyOfficialBuildEvent(initialOfficialBuildTrustState(),
      { kind: 'blocked', verdict: 'rotation', version: '26.5.0.3975', reason: 'not_pinned', thumbprint: thumb(7) }, NOW);
    expect(state.pinnedThumbprints).toEqual([OFFICIAL_BUILD_SEED_THUMBPRINT]);
    expect(state.lastObserved).toMatchObject({ verdict: 'rotation', thumbprint: thumb(7) });
    state = approveOfficialSigner(state, NOW);
    expect(state.pinnedThumbprints).toEqual([OFFICIAL_BUILD_SEED_THUMBPRINT, thumb(7)]);
    expect(state.lastObserved).toMatchObject({ verdict: 'candidate', version: '26.5.0.3975' });
    expect(() => approveOfficialSigner(state, NOW)).toThrow('official_signer_not_pending');
  });

  it('refuses approval without a pending rotation or when the pin list is full', () => {
    expect(() => approveOfficialSigner(initialOfficialBuildTrustState(), NOW)).toThrow('official_signer_not_pending');
    const untrusted = applyOfficialBuildEvent(initialOfficialBuildTrustState(),
      { kind: 'blocked', verdict: 'untrusted', version: null, reason: 'unsigned' }, NOW);
    expect(() => approveOfficialSigner(untrusted, NOW)).toThrow('official_signer_not_pending');
    const full = normalizeOfficialBuildTrustState({ pinnedThumbprints: Array.from({ length: 7 }, (_, i) => thumb(i + 1)) });
    const pending = applyOfficialBuildEvent(full,
      { kind: 'blocked', verdict: 'rotation', version: '26.5.0.1', reason: 'not_pinned', thumbprint: thumb(99) }, NOW);
    expect(() => approveOfficialSigner(pending, NOW)).toThrow('official_signer_limit');
  });

  it('compares four-part versions numerically', () => {
    expect(compareOfficialVersions('26.5.0.3975', '26.4.2.3957')).toBe(1);
    expect(compareOfficialVersions('26.4.2.3957', '26.4.2.3957')).toBe(0);
    expect(compareOfficialVersions('26.4.2.99', '26.4.2.100')).toBe(-1);
  });
});

describe('OfficialBuildTrustService', () => {
  it('persists a promotion under one document and reloads it', async () => {
    const store = memoryStore();
    const service = new OfficialBuildTrustService(store, () => NOW);
    await service.record({ kind: 'observed', verdict: 'candidate', build: build(3975) });
    await service.record({ kind: 'validated', build: build(3975) });
    expect(store.writes).toBe(2);
    expect((await service.bridgeTrust()).accepted.map((item) => item.version)).toEqual(['26.4.2.3957', '26.5.0.3975']);
    const reloaded = new OfficialBuildTrustService(store, () => NOW);
    expect((await reloaded.state()).acceptedBuilds.map((item) => item.version)).toEqual(['26.4.2.3957', '26.5.0.3975']);
    expect((await reloaded.state()).lastObserved).toMatchObject({ verdict: 'accepted', version: '26.5.0.3975' });
  });

  it('keeps a candidate unpromoted when persistence fails, then retries cleanly', async () => {
    let failing = true;
    const store = memoryStore(null, { failWrites: () => failing });
    const service = new OfficialBuildTrustService(store, () => NOW);
    await expect(service.record({ kind: 'validated', build: build(3975) })).rejects.toThrow('db_down');
    expect((await service.state()).acceptedBuilds).toHaveLength(1);
    failing = false;
    await service.record({ kind: 'validated', build: build(3975) });
    expect((await service.state()).acceptedBuilds).toHaveLength(2);
  });

  it('serialises concurrent events without losing either', async () => {
    const service = new OfficialBuildTrustService(memoryStore(), () => NOW);
    await Promise.all([1, 2, 3, 4, 5].map((n) => service.record({ kind: 'validated', build: build(n) })));
    expect((await service.state()).acceptedBuilds).toHaveLength(6);
  });

  it('reports seeds while the stored document cannot be read and skips persisting', async () => {
    const broken: OfficialBuildTrustStore = { async read() { throw new Error('read_failed'); }, async write() { /* ignore */ } };
    const service = new OfficialBuildTrustService(broken, () => NOW);
    expect((await service.state()).acceptedBuilds).toHaveLength(1);
    let changes = 0;
    const off = service.onChange(() => { changes++; });
    await service.record({ kind: 'observed', verdict: 'accepted', build: OFFICIAL_BUILD_SEED_BUILD });
    expect(changes).toBe(0);
    off();
  });

  it('does not cache a failed read and never overwrites persisted trust with seeds', async () => {
    const persisted = { acceptedBuilds: [{ ...build(7), acceptedAt: NOW.toISOString() }], pinnedThumbprints: [thumb(7)] };
    const store = memoryStore(persisted);
    let failing = true;
    const read = store.read.bind(store);
    store.read = async () => { if (failing) throw new Error('db_down'); return read(); };
    const service = new OfficialBuildTrustService(store, () => NOW);
    await service.record({ kind: 'observed', verdict: 'accepted', build: OFFICIAL_BUILD_SEED_BUILD });
    await expect(service.approveRotation()).rejects.toThrow('official_build_trust_unavailable');
    expect(store.writes).toBe(0);
    failing = false;
    const state = await service.state();
    expect(state.acceptedBuilds.map((item) => item.version)).toContain('26.5.0.7');
    expect(state.pinnedThumbprints).toContain(thumb(7));
    expect(store.writes).toBe(0);
  });

  it('approves the pending signer through the service and rejects a second approval', async () => {
    const store = memoryStore();
    const service = new OfficialBuildTrustService(store, () => NOW);
    await service.record({ kind: 'blocked', verdict: 'rotation', version: '26.5.0.3975', reason: 'not_pinned', thumbprint: thumb(9) });
    const state = await service.approveRotation();
    expect(state.pinnedThumbprints).toContain(thumb(9));
    expect((await service.bridgeTrust()).pinned).toEqual([OFFICIAL_BUILD_SEED_THUMBPRINT, thumb(9)]);
    await expect(service.approveRotation()).rejects.toThrow('official_signer_not_pending');
  });
});
