import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isTrustedReleaseUrl, UPDATE_RELEASES_FALLBACK_URL, UPDATE_REPO_NAME, UPDATE_REPO_OWNER, type UpdateCheckState } from '../../update-check-protocol.js';

export const UPDATE_CHECK_API_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_STARTUP_DELAY_MS = 60 * 1000;
export const UPDATE_CHECK_ENABLE_DELAY_MS = 3 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 15 * 1000;
export const UPDATE_CHECK_MAX_BYTES = 1024 * 1024;
const INSTALLER_ASSET = /Setup-x64\.exe$/;

type Triple = readonly [number, number, number];

/** Strict `x.y.z` with an optional leading `v`; anything else is not a version. */
export function parseReleaseVersion(value: unknown): Triple | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewerVersion(candidate: Triple, current: Triple): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index]! !== current[index]!) return candidate[index]! > current[index]!;
  }
  return false;
}

export type UpdateCheckPersisted = {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastCheckFailed: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  available: boolean;
  ignoredVersion: string | null;
};
export const DEFAULT_PERSISTED: UpdateCheckPersisted = { enabled: true, lastCheckedAt: null, lastCheckFailed: false, latestVersion: null, releaseUrl: null, available: false, ignoredVersion: null };

/** The slice of electron-updater's AppUpdater that the service drives; injected so tests never touch the real updater. */
export type AppUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type UpdateCheckStore = { load(): Promise<Partial<UpdateCheckPersisted> | null>; save(value: UpdateCheckPersisted): Promise<void> };

export function createFileUpdateCheckStore(filePath: string): UpdateCheckStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Partial<UpdateCheckPersisted> : null;
      } catch { return null; }
    },
    async save(value) {
      const temp = `${filePath}.tmp`;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(temp, JSON.stringify(value), 'utf8');
      await rename(temp, filePath);
    },
  };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
type Options = {
  currentVersion: string;
  fetch: FetchLike;
  store: UpdateCheckStore;
  openExternal: (url: string) => Promise<void> | void;
  onChange?: (state: UpdateCheckState) => void;
  now?: () => number;
  userAgent?: string;
  /** False when not packaged: 「更新」 opens the release page instead of installing. */
  canAutoInstall?: boolean;
  /** Lazily creates the updater (electron-updater is only loaded when an install starts). */
  getUpdater?: () => AppUpdaterLike;
  /** Runs the normal service shutdown (PostgreSQL, workers, agents) and resolves true when it is safe to hand over to the installer. */
  prepareInstall?: () => Promise<boolean>;
};

async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > UPDATE_CHECK_MAX_BYTES) throw new Error('response too large');
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > UPDATE_CHECK_MAX_BYTES) throw new Error('response too large');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPDATE_CHECK_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createUpdateCheckService(options: Options) {
  const now = options.now ?? Date.now;
  const current = parseReleaseVersion(options.currentVersion);
  let persisted: UpdateCheckPersisted = { ...DEFAULT_PERSISTED };
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let saves: Promise<void> = Promise.resolve();
  let download: UpdateCheckState['download'] = { status: 'idle', percent: 0 };
  let installing = false;
  let updater: AppUpdaterLike | undefined;
  const canAutoInstall = options.canAutoInstall === true && options.getUpdater !== undefined;

  const state = (): UpdateCheckState => ({
    enabled: persisted.enabled,
    checking,
    lastCheckedAt: persisted.lastCheckedAt,
    lastCheckFailed: persisted.lastCheckFailed,
    latestVersion: persisted.enabled ? persisted.latestVersion : null,
    releaseUrl: persisted.enabled ? persisted.releaseUrl : null,
    available: persisted.enabled && persisted.available,
    ignoredVersion: persisted.ignoredVersion,
    download: { ...download },
    canAutoInstall,
  });
  const publish = () => { try { options.onChange?.(state()); } catch { /* A broken listener must not break checks. */ } };
  const save = (): Promise<void> => {
    const snapshot = { ...persisted };
    saves = saves.then(() => options.store.save(snapshot)).catch(() => undefined);
    return saves;
  };
  const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const schedule = (delay: number) => {
    clearTimer();
    if (!persisted.enabled) return;
    timer = setTimeout(() => { timer = undefined; void check(); }, Math.max(0, delay));
    (timer as { unref?: () => void }).unref?.();
  };
  const scheduleFromLastCheck = () => {
    const last = persisted.lastCheckedAt ? Date.parse(persisted.lastCheckedAt) : Number.NaN;
    const elapsed = now() - last;
    schedule(Number.isFinite(last) && elapsed >= 0 && elapsed < UPDATE_CHECK_INTERVAL_MS ? UPDATE_CHECK_INTERVAL_MS - elapsed : UPDATE_CHECK_STARTUP_DELAY_MS);
  };

  async function openReleasePage(): Promise<boolean> {
    const url = state().available ? persisted.releaseUrl : null;
    if (!isTrustedReleaseUrl(url)) return false;
    try { await options.openExternal(url); return true; } catch { return false; }
  }

  function ensureUpdater(): AppUpdaterLike {
    if (updater) return updater;
    const created = options.getUpdater!();
    created.autoDownload = false;
    created.autoInstallOnAppQuit = false;
    // electron-updater emits 'error' besides rejecting; an emitter without a listener would throw.
    created.on('error', () => undefined);
    created.on('download-progress', (progress: { percent?: number }) => {
      const percent = Math.min(100, Math.max(0, Math.floor(Number(progress?.percent) || 0)));
      if (download.status !== 'downloading' || percent === download.percent) return;
      download = { status: 'downloading', percent };
      publish();
    });
    updater = created;
    return created;
  }

  async function fetchLatest(): Promise<{ version: string; url: string; available: boolean }> {
    if (!current) throw new Error('invalid current version');
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const response = await options.fetch(UPDATE_CHECK_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': options.userAgent ?? 'LINE-Agent-Assistant-UpdateCheck' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body: unknown = JSON.parse(await readCappedText(response));
      if (typeof body !== 'object' || body === null) throw new Error('invalid release');
      const release = body as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
      const latest = parseReleaseVersion(release.tag_name);
      if (!latest) throw new Error('invalid tag');
      const hasInstaller = Array.isArray(release.assets)
        && release.assets.some((asset) => typeof asset === 'object' && asset !== null && typeof (asset as { name?: unknown }).name === 'string' && INSTALLER_ASSET.test((asset as { name: string }).name));
      return {
        version: latest.join('.'),
        url: isTrustedReleaseUrl(release.html_url) ? release.html_url : UPDATE_RELEASES_FALLBACK_URL,
        available: hasInstaller && isNewerVersion(latest, current),
      };
    } finally { clearTimeout(abort); }
  }

  async function check(): Promise<UpdateCheckState> {
    if (checking) return state();
    checking = true;
    publish();
    try {
      const result = await fetchLatest();
      persisted = { ...persisted, lastCheckedAt: new Date(now()).toISOString(), lastCheckFailed: false,
        latestVersion: result.version, releaseUrl: result.url, available: result.available };
      if (download.status === 'error' && !installing) download = { status: 'idle', percent: 0 };
    } catch {
      persisted = { ...persisted, lastCheckedAt: new Date(now()).toISOString(), lastCheckFailed: true };
    }
    checking = false;
    await save();
    schedule(UPDATE_CHECK_INTERVAL_MS);
    publish();
    return state();
  }

  return {
    state,
    async start(): Promise<UpdateCheckState> {
      if (started) return state();
      started = true;
      const saved = await options.store.load().catch(() => null);
      if (saved) {
        persisted = {
          enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
          lastCheckedAt: typeof saved.lastCheckedAt === 'string' && Number.isFinite(Date.parse(saved.lastCheckedAt)) ? saved.lastCheckedAt : null,
          lastCheckFailed: saved.lastCheckFailed === true,
          latestVersion: typeof saved.latestVersion === 'string' && parseReleaseVersion(saved.latestVersion) ? saved.latestVersion : null,
          releaseUrl: isTrustedReleaseUrl(saved.releaseUrl) ? saved.releaseUrl : null,
          available: saved.available === true,
          ignoredVersion: typeof saved.ignoredVersion === 'string' && parseReleaseVersion(saved.ignoredVersion) ? saved.ignoredVersion : null,
        };
        if (!persisted.latestVersion) persisted.available = false;
      }
      scheduleFromLastCheck();
      publish();
      return state();
    },
    async setEnabled(enabled: boolean): Promise<UpdateCheckState> {
      if (persisted.enabled === enabled) return state();
      persisted = { ...persisted, enabled };
      if (enabled) schedule(UPDATE_CHECK_ENABLE_DELAY_MS);
      else { clearTimer(); persisted = { ...persisted, available: false, latestVersion: null, releaseUrl: null }; }
      await save();
      publish();
      return state();
    },
    checkNow: check,
    openReleasePage,
    async ignore(version: string): Promise<UpdateCheckState> {
      const parsed = parseReleaseVersion(version);
      if (!parsed) return state();
      persisted = { ...persisted, ignoredVersion: parsed.join('.') };
      await save();
      publish();
      return state();
    },
    /** 「更新」: download with electron-updater, run the normal shutdown, then hand over to the silent installer. Falls back to the release page. */
    async install(): Promise<UpdateCheckState> {
      if (installing || !state().available) return state();
      if (!canAutoInstall) { await openReleasePage(); return state(); }
      installing = true;
      download = { status: 'downloading', percent: 0 };
      publish();
      let target: AppUpdaterLike;
      try {
        target = ensureUpdater();
        const result = await target.checkForUpdates();
        // Releases without latest.yml reject here (404); an updater that sees no newer build resolves without an update.
        if (!result || result.isUpdateAvailable === false) throw new Error('no updater metadata');
      } catch {
        installing = false;
        download = { status: 'idle', percent: 0 };
        publish();
        await openReleasePage();
        return state();
      }
      try {
        await target.downloadUpdate();
        download = { status: 'ready', percent: 100 };
        publish();
        if (!options.prepareInstall || !(await options.prepareInstall())) throw new Error('shutdown failed');
        target.quitAndInstall(true, true);
      } catch {
        installing = false;
        download = { status: 'error', percent: 0 };
        publish();
      }
      return state();
    },
    stop() { clearTimer(); },
  };
}
export type UpdateCheckService = ReturnType<typeof createUpdateCheckService>;
