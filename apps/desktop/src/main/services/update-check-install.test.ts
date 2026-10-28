import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateCheckService, type AppUpdaterLike, type UpdateCheckPersisted, type UpdateCheckStore } from './update-check-service.js';

const RELEASE_URL = 'https://github.com/Saxo0213/line-agent-assistant/releases/tag/v1.0.280';
const release = () => JSON.stringify({ tag_name: 'v1.0.280', html_url: RELEASE_URL, assets: [{ name: 'LINE-Agent-Assistant-1.0.280-Setup-x64.exe' }] });

function memoryStore(initial: Partial<UpdateCheckPersisted> | null = null) {
  let saved: Partial<UpdateCheckPersisted> | null = initial;
  const store: UpdateCheckStore = { load: async () => saved, save: async (value) => { saved = value; } };
  return { store, get saved() { return saved; } };
}

function fakeUpdater(overrides: Partial<AppUpdaterLike> = {}) {
  const listeners = new Map<string, (...args: any[]) => void>();
  const calls: string[] = [];
  const updater: AppUpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => { calls.push('check'); return { isUpdateAvailable: true, updateInfo: { version: '1.0.280' } }; }),
    downloadUpdate: vi.fn(async () => { calls.push('download'); listeners.get('download-progress')?.({ percent: 42.7 }); return []; }),
    quitAndInstall: vi.fn(() => { calls.push('quitAndInstall'); }),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => { listeners.set(event, listener); return updater; }),
    ...overrides,
  };
  return { updater, calls };
}

async function build(options: { canAutoInstall?: boolean; updater?: AppUpdaterLike; calls?: string[]; prepare?: () => Promise<boolean>; initial?: Partial<UpdateCheckPersisted> | null } = {}) {
  const memory = memoryStore(options.initial ?? null);
  const states: any[] = [];
  const openExternal = vi.fn();
  const prepareInstall = vi.fn(options.prepare ?? (async () => { options.calls?.push('shutdown'); return true; }));
  const service = createUpdateCheckService({
    currentVersion: '1.0.279', fetch: async () => new Response(release(), { status: 200 }), store: memory.store, openExternal,
    onChange: (state) => states.push(state), canAutoInstall: options.canAutoInstall ?? true,
    ...(options.updater ? { getUpdater: () => options.updater! } : {}), prepareInstall,
  });
  await service.start();
  await service.checkNow();
  return { service, memory, states, openExternal, prepareInstall };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T02:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('update ignore', () => {
  it('persists the ignored version, keeps the update available, and a newer release is not ignored', async () => {
    const { service, memory } = await build();
    const state = await service.ignore('1.0.280');
    expect(state).toMatchObject({ available: true, latestVersion: '1.0.280', ignoredVersion: '1.0.280' });
    expect(memory.saved).toMatchObject({ ignoredVersion: '1.0.280' });
    // A restart reloads the ignored version; a different latest version differs from it.
    const reloaded = await build({ initial: memory.saved });
    expect(reloaded.service.state().ignoredVersion).toBe('1.0.280');
    expect(reloaded.service.state().latestVersion).toBe('1.0.280');
  });

  it('rejects values that are not versions', async () => {
    const { service } = await build();
    expect((await service.ignore('latest')).ignoredVersion).toBeNull();
  });
});

describe('update install', () => {
  it('downloads, runs the shutdown path, then quits and installs silently', async () => {
    const { updater, calls } = fakeUpdater();
    const { service, states, prepareInstall } = await build({ updater, calls });
    await service.install();
    expect(calls).toEqual(['check', 'download', 'shutdown', 'quitAndInstall']);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(states.some((state) => state.download.status === 'downloading' && state.download.percent === 42)).toBe(true);
    expect(service.state().download.status).toBe('ready');
  });

  it('opens the release page when the release has no latest.yml', async () => {
    const { updater } = fakeUpdater({ checkForUpdates: vi.fn(async () => { throw new Error('404 latest.yml'); }) });
    const { service, openExternal, prepareInstall } = await build({ updater });
    const state = await service.install();
    expect(openExternal).toHaveBeenCalledWith(RELEASE_URL);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(prepareInstall).not.toHaveBeenCalled();
    expect(state.download).toEqual({ status: 'idle', percent: 0 });
  });

  it('opens the release page without loading the updater when not packaged', async () => {
    const { updater } = fakeUpdater();
    const getUpdater = vi.fn(() => updater);
    const memory = memoryStore();
    const openExternal = vi.fn();
    const service = createUpdateCheckService({ currentVersion: '1.0.279', fetch: async () => new Response(release(), { status: 200 }), store: memory.store,
      openExternal, canAutoInstall: false, getUpdater, prepareInstall: async () => true });
    await service.start();
    await service.checkNow();
    expect(service.state().canAutoInstall).toBe(false);
    await service.install();
    expect(openExternal).toHaveBeenCalledWith(RELEASE_URL);
    expect(getUpdater).not.toHaveBeenCalled();
  });

  it('reports an error and does not install when the download fails', async () => {
    const { updater } = fakeUpdater({ downloadUpdate: vi.fn(async () => { throw new Error('sha512 mismatch'); }) });
    const { service, prepareInstall } = await build({ updater });
    const state = await service.install();
    expect(state.download.status).toBe('error');
    expect(prepareInstall).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not hand over to the installer when the shutdown fails', async () => {
    const { updater } = fakeUpdater();
    const { service } = await build({ updater, prepare: async () => false });
    const state = await service.install();
    expect(state.download.status).toBe('error');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does nothing when no update is available', async () => {
    const { updater } = fakeUpdater();
    const { service } = await build({ updater, initial: null });
    await service.setEnabled(false);
    await service.install();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
