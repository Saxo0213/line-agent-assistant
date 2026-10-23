import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OfficialLineSessionVerdict = 'not_running' | 'other_account' | 'same_account' | 'unknown';

export type OfficialSourceVerification =
  | Readonly<{ status: 'supported' }>
  | Readonly<{ status: 'unsupported'; errorCode: string }>;

export interface OfficialLineSessionGuard {
  /** `ownMid` null means the account is not yet known (add-account QR). */
  check(input: { accountId: string; ownMid: string | null }): Promise<OfficialLineSessionVerdict>;
  shutdown(): void;
}

export interface LineProcessListing {
  /** Number of LINE.exe processes, including those whose path could not be read. */
  processCount: number;
  paths: readonly string[];
}

export interface OfficialLineSessionGuardOptions {
  /** Running LINE.exe processes: total count and readable image paths. Throwing means the listing failed. */
  listLineProcessImagePaths(signal: AbortSignal): Promise<LineProcessListing>;
  /** Local-only profile MID check. Absent when the native reader is unavailable. */
  verifyOfficialSource?(input: { expectedMid: string; signal: AbortSignal }): Promise<OfficialSourceVerification>;
  /** `%LOCALAPPDATA%`; the official app lives under `<localAppData>\LINE\bin\`. */
  localAppData: string | undefined;
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 20_000;
const PROCESS_LIST_TIMEOUT_MS = 15_000;

export function isOfficialLineImagePath(imagePath: string, localAppData: string): boolean {
  if (!path.win32.isAbsolute(localAppData) || !path.win32.isAbsolute(imagePath)) return false;
  const root = path.win32.resolve(localAppData, 'LINE', 'bin').toLowerCase();
  const image = path.win32.resolve(imagePath).toLowerCase();
  return image.startsWith(`${root}\\`) && path.win32.basename(image) === 'line.exe';
}

export function createOfficialLineSessionGuard(options: OfficialLineSessionGuardOptions): OfficialLineSessionGuard {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const inFlight = new Map<string, Promise<OfficialLineSessionVerdict>>();
  const shutdownAbort = new AbortController();

  async function run(ownMid: string | null): Promise<OfficialLineSessionVerdict> {
    const abort = new AbortController();
    const onShutdown = () => abort.abort();
    shutdownAbort.signal.addEventListener('abort', onShutdown, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'unknown'>((resolve) => {
      timer = setTimeout(() => { abort.abort(); resolve('unknown'); }, deadlineMs);
    });
    const work = (async (): Promise<OfficialLineSessionVerdict> => {
      const localAppData = options.localAppData;
      if (!localAppData) return 'unknown';
      const listing = await options.listLineProcessImagePaths(abort.signal);
      if (!listing.paths.some((image) => isOfficialLineImagePath(image, localAppData))) {
        // A LINE.exe whose path is unreadable (e.g. elevated) might be the official app: fail safe.
        return listing.processCount > listing.paths.length ? 'unknown' : 'not_running';
      }
      if (ownMid === null || !options.verifyOfficialSource) return 'unknown';
      const verdict = await options.verifyOfficialSource({ expectedMid: ownMid, signal: abort.signal });
      if (verdict.status === 'supported') return 'same_account';
      if (verdict.errorCode === 'mid_or_schema_mismatch' || verdict.errorCode === 'official_account_not_active') return 'other_account';
      if (verdict.errorCode === 'process_missing') return 'not_running';
      return 'unknown';
    })().catch((): OfficialLineSessionVerdict => 'unknown');
    try { return await Promise.race([work, deadline]); }
    finally {
      if (timer) clearTimeout(timer);
      shutdownAbort.signal.removeEventListener('abort', onShutdown);
      abort.abort();
    }
  }

  return {
    check({ accountId, ownMid }) {
      if (shutdownAbort.signal.aborted) return Promise.resolve('unknown');
      const key = `${accountId}\u0000${ownMid ?? ''}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = run(ownMid).finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
      inFlight.set(key, promise);
      return promise;
    },
    shutdown() { shutdownAbort.abort(); },
  };
}

const MAX_LISTED_PATHS = 256;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes `P:<base64 utf8 path>` lines. An empty or invalid payload counts as an unreadable path, and paths past the
 * cap are counted but not kept, so processCount > paths.length makes the guard fail safe to unknown.
 */
export function parseLineProcessListing(stdout: string): LineProcessListing {
  let processCount = 0;
  const paths: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('P:')) continue;
    processCount += 1;
    const payload = line.slice(2);
    if (!BASE64_PAYLOAD.test(payload) || paths.length >= MAX_LISTED_PATHS) continue;
    const decoded = Buffer.from(payload, 'base64').toString('utf8').trim();
    if (decoded) paths.push(decoded);
  }
  return { processCount, paths };
}

/** One short-lived hidden PowerShell listing per check. */
export async function listLineProcessImagePaths(signal: AbortSignal): Promise<LineProcessListing> {
  if (process.platform !== 'win32') return { processCount: 0, paths: [] };
  const script = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name='LINE.exe'" | ` +
    `ForEach-Object { [Console]::Out.WriteLine('P:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.ExecutablePath))) }`;
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024, signal,
  });
  return parseLineProcessListing(result.stdout);
}
