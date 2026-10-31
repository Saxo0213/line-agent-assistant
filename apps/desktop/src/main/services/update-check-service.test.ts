import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateCheckService, DEFAULT_PERSISTED, isNewerVersion, parseReleaseVersion, UPDATE_CHECK_API_URL, UPDATE_CHECK_ENABLE_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_MAX_BYTES, UPDATE_CHECK_STARTUP_DELAY_MS, type UpdateCheckPersisted, type UpdateCheckStore,
} from './update-check-service.js';

const RELEASE_URL = 'https://github.com/Saxo0213/line-agent-assistant/releases/tag/v1.0.280';
const release = (patch: Record<string, unknown> = {}) => JSON.stringify({
  tag_name: 'v1.0.280', html_url: RELEASE_URL, assets: [{ name: 'LINE-Agent-Assistant-1.0.280-Setup-x64.exe' }, { name: 'SHA256SUMS' }], ...patch,
});
const jsonResponse = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

function memoryStore(initial: Partial<UpdateCheckPersisted> | null = null) {
  let saved: Partial<UpdateCheckPersisted> | null = initial;
  const store: UpdateCheckStore = { load: async () => saved, save: async (value) => { saved = value; } };
  return { store, get saved() { return saved; } };
}

function build(options: { body?: () => Response | Promise<Response>; initial?: Partial<UpdateCheckPersisted> | null; version?: string; openExternal?: (url: string) => void } = {}) {
  const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string>; signal: AbortSignal }) => (options.body ?? (() => jsonResponse(release())))());
  const memory = memoryStore(options.initial ?? null);
  const states: unknown[] = [];
  const openExternal = vi.fn(options.openExternal ?? (() => undefined));
  const service = createUpdateCheckService({ currentVersion: options.version ?? '1.0.275', fetch, store: memory.store, openExternal, onChange: (state) => states.push(state) });
  return { service, fetch, memory, states, openExternal };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T02:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('version comparison', () => {
  it('parses tags with or without the v prefix and rejects anything else', () => {
    expect(parseReleaseVersion('v1.0.280')).toEqual([1, 0, 280]);
    expect(parseReleaseVersion('1.0.280')).toEqual([1, 0, 280]);
    for (const bad of ['1.0', 'v1.0.x', '1.0.280-beta', 'latest', '', null, 12]) expect(parseReleaseVersion(bad)).toBeNull();
  });
  it('is newer only when the numeric x.y.z is strictly greater', () => {
    const current = parseReleaseVersion('1.0.275')!;
    expect(isNewerVersion(parseReleaseVersion('v1.0.280')!, current)).toBe(true);
    expect(isNewerVersion(parseReleaseVersion('1.0.275')!, current)).toBe(false);
    expect(isNewerVersion(parseReleaseVersion('1.0.9')!, current)).toBe(false);
    expect(isNewerVersion(parseReleaseVersion('1.1.0')!, current)).toBe(true);
    expect(isNewerVersion(parseReleaseVersion('2.0.0')!, current)).toBe(true);
  });
});

describe('update check service', () => {
  it('requests the latest release anonymously with the documented headers', async () => {
    const { service, fetch } = build();
    await service.start();
    await service.checkNow();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(UPDATE_CHECK_API_URL);
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
    service.stop();
  });

  it('reports an update when the tag is newer and an installer asset exists', async () => {
    const { service, memory } = build();
    await service.start();
    const state = await service.checkNow();
    expect(state).toMatchObject({ available: true, latestVersion: '1.0.280', releaseUrl: RELEASE_URL, lastCheckFailed: false, checking: false });
    expect(memory.saved).toMatchObject({ available: true, latestVersion: '1.0.280', lastCheckedAt: '2026-10-28T02:00:00.000Z' });
    service.stop();
  });

  it.each([
    ['same version', { tag_name: '1.0.275' }],
    ['older version', { tag_name: 'v1.0.9' }],
    ['no installer asset', { assets: [{ name: 'SHA256SUMS' }, { name: 'LINE-Agent-Assistant-1.0.280-win.zip' }] }],
    ['no assets', { assets: undefined }],
  ])('does not report an update for %s', async (_label, patch) => {
    const { service } = build({ body: () => jsonResponse(release(patch)) });
    await service.start();
    const state = await service.checkNow();
    expect(state.available).toBe(false);
    expect(state.lastCheckFailed).toBe(false);
    service.stop();
  });

  it('marks the check failed for malformed tags, bad status, invalid JSON and network errors', async () => {
    const bodies: Array<() => Response | Promise<Response>> = [
      () => jsonResponse(release({ tag_name: 'nightly' })),
      () => jsonResponse('{}', { status: 403 }),
      () => jsonResponse('not json'),
      () => { throw new Error('offline'); },
    ];
    for (const body of bodies) {
      const { service } = build({ body });
      await service.start();
      const state = await service.checkNow();
      expect(state).toMatchObject({ lastCheckFailed: true, available: false, checking: false });
      service.stop();
    }
  });

  it('rejects responses over the size cap', async () => {
    const { service } = build({ body: () => jsonResponse(release({ pad: 'x'.repeat(UPDATE_CHECK_MAX_BYTES) })) });
    await service.start();
    expect((await service.checkNow()).lastCheckFailed).toBe(true);
    service.stop();
  });

  it('aborts a request that exceeds the 15 second timeout and records a failure', async () => {
    const fetch = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const service = createUpdateCheckService({ currentVersion: '1.0.275', fetch: fetch as never, store: memoryStore().store, openExternal: () => undefined });
    await service.start();
    const pending = service.checkNow();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(service.state().checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ checking: false, lastCheckFailed: true });
    service.stop();
  });

  it('keeps the previous result when a later check fails', async () => {
    let fail = false;
    const { service } = build({ body: () => { if (fail) throw new Error('offline'); return jsonResponse(release()); } });
    await service.start();
    await service.checkNow();
    fail = true;
    const state = await service.checkNow();
    expect(state).toMatchObject({ lastCheckFailed: true, available: true, latestVersion: '1.0.280' });
    service.stop();
  });

  it('checks 60 seconds after start when there is no recent check, then every 6 hours', async () => {
    const { service, fetch } = build();
    await service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_STARTUP_DELAY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('does not refetch after a restart within 6 hours and keeps the badge', async () => {
    const first = build();
    await first.service.start();
    await first.service.checkNow();
    first.service.stop();

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const second = build({ initial: first.memory.saved });
    const state = await second.service.start();
    expect(state).toMatchObject({ available: true, latestVersion: '1.0.280' });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_STARTUP_DELAY_MS * 10);
    expect(second.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(second.fetch).toHaveBeenCalledTimes(1);
    second.service.stop();
  });

  it.each(['1.0.275', '1.0.274'])('reconciles stale persisted availability at current version %s before publishing', async (version) => {
    const initial = { ...DEFAULT_PERSISTED, latestVersion: version, releaseUrl: RELEASE_URL, available: true,
      lastCheckedAt: new Date().toISOString() };
    const { service, memory, states } = build({ initial, version: '1.0.275' });
    const state = await service.start();
    expect(state.available).toBe(false);
    expect(memory.saved).toMatchObject({ available: false });
    expect(states.at(-1)).toMatchObject({ available: false });
    service.stop();
  });

  it('turns a legacy equal-version available cache into a persisted installed notice', async () => {
    const initial = { ...DEFAULT_PERSISTED, latestVersion: '1.0.275', releaseUrl: RELEASE_URL, available: true,
      lastCheckedAt: new Date().toISOString() };
    const { service, memory } = build({ initial, version: '1.0.275' });
    const state = await service.start();
    expect(state).toMatchObject({ available: false, installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } });
    expect(memory.saved).toMatchObject({ available: false, installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } });
    service.stop();
  });

  it('acknowledges an installed notice only after the trusted details page opens', async () => {
    const initial = { ...DEFAULT_PERSISTED, latestVersion: '1.0.275', releaseUrl: RELEASE_URL, available: false,
      installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } };
    const { service, memory, openExternal } = build({ initial, version: '1.0.275' });
    await service.start();
    expect(await service.openInstalledDetails()).toMatchObject({ installedNotice: null });
    expect(openExternal).toHaveBeenCalledWith(RELEASE_URL);
    expect(memory.saved).toMatchObject({ installedNotice: null });
    service.stop();
    const restarted = build({ initial: memory.saved, version: '1.0.275' });
    expect((await restarted.service.start()).installedNotice).toBeNull();
    restarted.service.stop();
  });

  it('keeps an installed notice when opening its details page fails', async () => {
    const initial = { ...DEFAULT_PERSISTED, installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } };
    const { service, memory } = build({ initial, version: '1.0.275', openExternal: () => { throw new Error('browser failed'); } });
    await service.start();
    expect(await service.openInstalledDetails()).toMatchObject({ installedNotice: { version: '1.0.275' } });
    expect(memory.saved).toMatchObject({ installedNotice: { version: '1.0.275' } });
    service.stop();
  });

  it('keeps the installed notice when its successful details opening cannot be durably acknowledged', async () => {
    const initial = { ...DEFAULT_PERSISTED, installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } };
    const store: UpdateCheckStore = { load: async () => initial, save: async () => { throw new Error('disk full'); } };
    const service = createUpdateCheckService({ currentVersion: '1.0.275', fetch: async () => jsonResponse(release()), store, openExternal: () => undefined });
    await service.start();
    expect(await service.openInstalledDetails()).toMatchObject({ installedNotice: { version: '1.0.275', releaseUrl: RELEASE_URL } });
    service.stop();
  });

  it('checks 60 seconds after start when the last check is older than 6 hours', async () => {
    const initial = { ...DEFAULT_PERSISTED, lastCheckedAt: new Date(Date.now() - UPDATE_CHECK_INTERVAL_MS - 1000).toISOString() };
    const { service, fetch } = build({ initial });
    await service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_STARTUP_DELAY_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('never fetches on a schedule while disabled, but checkNow still works', async () => {
    const { service, fetch } = build({ initial: { ...DEFAULT_PERSISTED, enabled: false } });
    await service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
    const state = await service.checkNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.available).toBe(false);
    expect(state.enabled).toBe(false);
    service.stop();
  });

  it('turning the switch off stops the timer and clears the badge; turning it on schedules a check', async () => {
    const { service, fetch, memory } = build();
    await service.start();
    await service.checkNow();
    expect(service.state().available).toBe(true);
    const off = await service.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, available: false, latestVersion: null });
    expect(memory.saved).toMatchObject({ enabled: false, available: false });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    await service.setEnabled(true);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_ENABLE_DELAY_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.state().available).toBe(true);
    service.stop();
  });

  it('ignores a second checkNow while one is running and publishes state changes', async () => {
    let release!: (response: Response) => void;
    const { service, fetch, states } = build({ body: () => new Promise<Response>((resolve) => { release = resolve; }) });
    await service.start();
    const first = service.checkNow();
    expect(service.state().checking).toBe(true);
    await service.checkNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(jsonResponse(release_body()));
    await first;
    expect(states.some((state) => (state as { checking: boolean }).checking)).toBe(true);
    expect(states.at(-1)).toMatchObject({ checking: false, available: true });
    service.stop();
  });

  it('opens only trusted release URLs and only when an update is available', async () => {
    const trusted = build();
    await trusted.service.start();
    expect(await trusted.service.openReleasePage()).toBe(false);
    await trusted.service.checkNow();
    expect(await trusted.service.openReleasePage()).toBe(true);
    expect(trusted.openExternal).toHaveBeenCalledWith(RELEASE_URL);
    trusted.service.stop();

    const hostile = build({ body: () => jsonResponse(release({ html_url: 'https://evil.example/releases/x' })) });
    await hostile.service.start();
    await hostile.service.checkNow();
    expect(hostile.service.state().releaseUrl).toBe('https://github.com/Saxo0213/line-agent-assistant/releases/latest');
    await hostile.service.openReleasePage();
    expect(hostile.openExternal).toHaveBeenCalledWith('https://github.com/Saxo0213/line-agent-assistant/releases/latest');
    hostile.service.stop();

    const tampered = build({ initial: { ...DEFAULT_PERSISTED, available: true, latestVersion: '1.0.280', releaseUrl: 'https://evil.example/x', lastCheckedAt: new Date().toISOString() } });
    await tampered.service.start();
    expect(await tampered.service.openReleasePage()).toBe(false);
    expect(tampered.openExternal).not.toHaveBeenCalled();
    tampered.service.stop();
  });

  it('never throws into the app when the store or the browser launcher fails', async () => {
    const failingStore: UpdateCheckStore = { load: async () => { throw new Error('disk'); }, save: async () => { throw new Error('disk'); } };
    const service = createUpdateCheckService({ currentVersion: '1.0.275', fetch: async () => jsonResponse(release()), store: failingStore,
      openExternal: () => { throw new Error('no browser'); } });
    await expect(service.start()).resolves.toMatchObject({ enabled: true });
    await expect(service.checkNow()).resolves.toMatchObject({ available: true });
    await expect(service.openReleasePage()).resolves.toBe(false);
    service.stop();
  });
});

function release_body(): string { return release(); }
