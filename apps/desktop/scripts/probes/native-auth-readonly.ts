import { BaseClient } from '@evex/linejs/base';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseEncryptedAccessToken } from '../../../../packages/line-worker/src/attachment-download.js';

export type NativeAuthCandidate = Readonly<{ token: string; application: string }>;
export type ProviderProbeResult = Readonly<{
  status: 'success' | 'failed';
  candidatesTried: number;
  matchedAccount: boolean;
  obsAuthorizationReceived: boolean;
  failure?: 'no_usable_candidate' | 'account_mismatch' | 'provider_failure' | 'timeout' | 'cancelled' | 'helper_shutdown_failed';
  requestsAttempted: number;
  maxConcurrentRequests: number;
}>;
export type BoundedNativeProbeResult = ProviderProbeResult & Readonly<{ nativeAcquisitionDurationMs: number }>;

type ProbeClient = {
  authToken?: string;
  request: { systemType: string };
  config?: { timeout: number; longTimeout: number };
  disabled?: boolean;
  talk: {
    getProfile(): Promise<{ mid?: unknown }>;
    acquireEncryptedAccessToken(args: { featureType: 2 }): Promise<unknown>;
  };
  close?(): void | Promise<void>;
};

type RequestBudget = { requestsAttempted: number; activeRequests: number; maxConcurrentRequests: number };

const MAX_CANDIDATES = 16;
const MAX_TOKEN_CHARS = 1024;
const MAX_APPLICATION_CHARS = 512;
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RUN_MS = 90_000;

export async function runNativeCandidateHelper(options: {
  executablePath: string;
  signal: AbortSignal;
  spawnImpl?: typeof spawn;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stopGraceMs?: number;
  onDuration?: (durationMs: number) => void;
}): Promise<NativeAuthCandidate[]> {
  const startedAt = performance.now();
  if (!options.executablePath || options.executablePath.length > 4096 || options.signal.aborted) {
    try { options.onDuration?.(Math.max(0, Math.ceil(performance.now() - startedAt))); } catch { /* measurement is best effort */ }
    throw new Error(options.signal.aborted ? 'native_candidate_cancelled' : 'native_candidate_unavailable');
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const allowedEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ['LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = options.environment?.[key] ?? process.env[key];
    if (value && value.length <= 4096 && !value.includes('\0')) allowedEnvironment[key] = value;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImpl(options.executablePath, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: allowedEnvironment, shell: false });
  } catch {
    try { options.onDuration?.(Math.max(0, Math.ceil(performance.now() - startedAt))); } catch { /* measurement is best effort */ }
    throw new Error('native_candidate_unavailable');
  }
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: Error | undefined;
  let timedOut = false;
  let exited = false;
  let timeout: NodeJS.Timeout | undefined;
  let hardStop: NodeJS.Timeout | undefined;
  let shutdownTimeout: NodeJS.Timeout | undefined;
  let rejectClose: ((error: Error) => void) | undefined;
  let shutdownFailed = false;
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    rejectClose = reject;
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  const requestStop = (error: Error, isTimeout = false) => {
    if (failure) return;
    failure = error;
    timedOut = isTimeout;
    try { child.kill(); } catch { /* only the owned helper is targeted */ }
    const grace = options.stopGraceMs ?? 750;
    hardStop = setTimeout(() => {
      if (exited) return;
      try { child.kill('SIGKILL'); } catch { /* child may already be closed */ }
      shutdownTimeout = setTimeout(() => {
        if (exited) return;
        shutdownFailed = true;
        rejectClose?.(new Error('native_candidate_shutdown_failed'));
      }, grace);
    }, grace);
  };
  const onAbort = () => requestStop(new Error('native_candidate_cancelled'));
  options.signal.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_FRAME_BYTES) requestStop(new Error('native_candidate_frame_too_large'));
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 4096) requestStop(new Error('native_candidate_stderr_rejected'));
  });
  child.once('error', () => requestStop(new Error('native_candidate_unavailable')));
  timeout = setTimeout(() => requestStop(new Error('native_candidate_timeout'), true), options.timeoutMs ?? 22_000);
  try {
    const exit = await closePromise;
    if (failure) throw failure;
    if (exit.code !== 0 || stderrBytes !== 0) throw new Error('native_candidate_unavailable');
    const frameBytes = Buffer.concat(stdout);
    try {
      const frame = new TextDecoder('utf-8', { fatal: true }).decode(frameBytes);
      return parseNativeCandidateFrame(frame);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native_candidate_frame_')) throw error;
      throw new Error('native_candidate_frame_invalid');
    } finally { frameBytes.fill(0); }
  } catch (error) {
    if (shutdownFailed) throw new Error('native_candidate_shutdown_failed');
    if (failure) throw failure;
    if (timedOut) throw new Error('native_candidate_timeout');
    throw error instanceof Error && error.message.startsWith('native_candidate_') ? error : new Error('native_candidate_unavailable');
  } finally {
    if (timeout) clearTimeout(timeout);
    if (hardStop) clearTimeout(hardStop);
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
    options.signal.removeEventListener('abort', onAbort);
    for (const chunk of stdout) chunk.fill(0);
    stdout.length = 0;
    try { options.onDuration?.(Math.max(0, Math.ceil(performance.now() - startedAt))); } catch { /* measurement is best effort */ }
  }
}

function validPrintableHeader(value: string, allowTab: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && !(allowTab && code === 0x09)) || code > 0x7e) return false;
  }
  return true;
}

function isCandidate(value: unknown): value is NativeAuthCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2 && typeof candidate.token === 'string' && candidate.token.length > 0 &&
    candidate.token.length <= MAX_TOKEN_CHARS && validPrintableHeader(candidate.token, false) &&
    typeof candidate.application === 'string' && candidate.application.length > 0 &&
    candidate.application.length <= MAX_APPLICATION_CHARS && candidate.application.startsWith('DESKTOPWIN\t') &&
    validPrintableHeader(candidate.application, true);
}

/** Parse the native helper's single captured-stdio frame without logging any fields. */
export function parseNativeCandidateFrame(frame: string): NativeAuthCandidate[] {
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('native_candidate_frame_too_large');
  let value: unknown;
  try { value = JSON.parse(frame); } catch { throw new Error('native_candidate_frame_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native_candidate_frame_invalid');
  const record = value as Record<string, unknown>;
  if (record.status !== 'ok' || !Array.isArray(record.candidates) || record.candidates.length > MAX_CANDIDATES ||
      Object.keys(record).some((key) => key !== 'status' && key !== 'candidates') ||
      !record.candidates.every(isCandidate)) throw new Error('native_candidate_frame_invalid');
  const seen = new Set<string>();
  const result: NativeAuthCandidate[] = [];
  for (const candidate of record.candidates) {
    const key = `${candidate.application}\u0000${candidate.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ token: candidate.token, application: candidate.application });
  }
  return result;
}

function newBudget(): RequestBudget {
  return { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 };
}

function allowedLineRequest(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'gf.line.naver.jp' && url.pathname === '/enc') return true;
  return (url.hostname === 'gf.line.naver.jp' || url.hostname === 'legy.line-apps.com') && url.pathname === '/S4';
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Response> {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      byteLength += item.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('provider_response_too_large');
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    try { reader.releaseLock(); } catch { /* cancelled reader */ }
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Only the existing LINEJS Talk and LEGY wrapper routes are admitted. */
export function createRestrictedProviderFetch(options: {
  budget: RequestBudget;
  signal: AbortSignal;
  fetchImpl?: (request: Request) => Promise<Response>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? ((request) => globalThis.fetch(request));
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return async (request) => {
    if (!allowedLineRequest(request)) throw new Error('provider_route_denied');
    if (options.signal.aborted) throw new Error('provider_cancelled');
    if (options.budget.activeRequests >= 1) throw new Error('provider_concurrency_limit');
    if (options.budget.requestsAttempted >= MAX_REQUESTS) throw new Error('provider_request_limit');
    options.budget.requestsAttempted += 1;
    options.budget.activeRequests += 1;
    options.budget.maxConcurrentRequests = Math.max(options.budget.maxConcurrentRequests, options.budget.activeRequests);
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = AbortSignal.any([request.signal, options.signal, timeoutSignal]);
    try {
      const boundedRequest = new Request(request, { redirect: 'manual', signal });
      const response = await fetchImpl(boundedRequest);
      if (response.status >= 300 && response.status < 400 || response.headers.has('location')) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('provider_redirect_denied');
      }
      return await readBoundedResponse(response, maxResponseBytes);
    } finally {
      options.budget.activeRequests -= 1;
    }
  };
}

export function createLinejsProviderClient(options: {
  application: string;
  budget: RequestBudget;
  signal: AbortSignal;
  fetchImpl?: (request: Request) => Promise<Response>;
}): ProbeClient {
  const version = options.application.split('\t')[1];
  if (!options.application.startsWith('DESKTOPWIN\t') || !version || !/^\d+(?:\.\d+){1,4}$/.test(version)) {
    throw new Error('native_application_version_invalid');
  }
  const client = new BaseClient({ device: 'DESKTOPWIN', version, legy: { encrypted: 'auto' },
    fetch: createRestrictedProviderFetch(options) });
  client.config.timeout = REQUEST_TIMEOUT_MS;
  client.config.longTimeout = REQUEST_TIMEOUT_MS;
  return client as unknown as ProbeClient;
}

/**
 * Runs only getProfile and feature-2 OBS authorization. It never invokes login,
 * QR, poll, push, refresh or media-download methods.
 */
export async function runProviderValidation(input: {
  candidates: readonly NativeAuthCandidate[];
  expectedMid: string;
  deadlineUnixMs: number;
  signal?: AbortSignal;
  createClient(candidate: NativeAuthCandidate, context: { budget: RequestBudget; signal: AbortSignal }):
    ProbeClient | Promise<ProbeClient>;
}): Promise<ProviderProbeResult> {
  const budget = newBudget();
  const finish = (result: Omit<ProviderProbeResult, 'requestsAttempted' | 'maxConcurrentRequests'>): ProviderProbeResult => ({
    ...result, requestsAttempted: budget.requestsAttempted, maxConcurrentRequests: budget.maxConcurrentRequests,
  });
  if (typeof input.expectedMid !== 'string' || !/^u[0-9a-fA-F]{32}$/.test(input.expectedMid)) {
    return finish({ status: 'failed', candidatesTried: 0, matchedAccount: false, obsAuthorizationReceived: false, failure: 'no_usable_candidate' });
  }
  const maximumDeadline = Date.now() + MAX_RUN_MS;
  const deadline = Math.min(input.deadlineUnixMs, maximumDeadline);
  const deadlineMs = Math.max(1, deadline - Date.now());
  const overallSignal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs);
  const seen = new Set<string>();
  let candidatesTried = 0;
  let hadMismatch = false;
  let accountMatched = false;
  let hadProviderFailure = false;
  for (const raw of input.candidates.slice(0, MAX_CANDIDATES)) {
    if (overallSignal.aborted) break;
    if (!isCandidate(raw)) continue;
    const dedupeKey = `${raw.application}\u0000${raw.token}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidatesTried += 1;
    let client: ProbeClient | undefined;
    try {
      client = await input.createClient({ token: raw.token, application: raw.application }, { budget, signal: overallSignal });
      client.authToken = raw.token;
      client.request.systemType = raw.application;
      if (client.config) {
        client.config.timeout = REQUEST_TIMEOUT_MS;
        client.config.longTimeout = REQUEST_TIMEOUT_MS;
      }
      const profile = await client.talk.getProfile();
      if (profile?.mid !== input.expectedMid) { hadMismatch = true; continue; }
      accountMatched = true;
      const authorization = await client.talk.acquireEncryptedAccessToken({ featureType: 2 });
      parseEncryptedAccessToken(authorization);
      return finish({ status: 'success', candidatesTried, matchedAccount: true, obsAuthorizationReceived: true });
    } catch {
      hadProviderFailure = true;
    } finally {
      if (client) {
        client.authToken = undefined;
        client.disabled = true;
        try { await client.close?.(); } catch { /* output remains summary-only */ }
      }
    }
  }
  if (input.signal?.aborted) return finish({ status: 'failed', candidatesTried, matchedAccount: accountMatched,
    obsAuthorizationReceived: false, failure: 'cancelled' });
  if (overallSignal.aborted) return finish({ status: 'failed', candidatesTried, matchedAccount: accountMatched,
    obsAuthorizationReceived: false, failure: 'timeout' });
  return finish({ status: 'failed', candidatesTried, matchedAccount: accountMatched, obsAuthorizationReceived: false,
    failure: candidatesTried === 0 ? 'no_usable_candidate' : hadProviderFailure ? 'provider_failure' : 'account_mismatch' });
}

export async function runBoundedNativeAuthProbe(input: {
  deadlineUnixMs: number;
  signal?: AbortSignal;
  readExpectedMid(signal: AbortSignal, deadlineUnixMs: number): Promise<string>;
  acquireCandidates(signal: AbortSignal, deadlineUnixMs: number, onDuration: (durationMs: number) => void): Promise<readonly NativeAuthCandidate[]>;
  validate(args: { expectedMid: string; candidates: readonly NativeAuthCandidate[]; signal: AbortSignal; deadlineUnixMs: number }):
    Promise<ProviderProbeResult>;
}): Promise<BoundedNativeProbeResult> {
  const deadlineUnixMs = Math.min(input.deadlineUnixMs, Date.now() + MAX_RUN_MS);
  if (!Number.isFinite(deadlineUnixMs) || Date.now() >= deadlineUnixMs) {
    return { status: 'failed', candidatesTried: 0, matchedAccount: false, obsAuthorizationReceived: false,
      failure: 'timeout', requestsAttempted: 0, maxConcurrentRequests: 0, nativeAcquisitionDurationMs: 0 };
  }
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineUnixMs - Date.now()));
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  let nativeAcquisitionDurationMs = 0;
  let helperShutdownFailed = false;
  const failed = (failure: ProviderProbeResult['failure']): BoundedNativeProbeResult => ({
    status: 'failed', candidatesTried: 0, matchedAccount: false, obsAuthorizationReceived: false,
    failure, requestsAttempted: 0, maxConcurrentRequests: 0, nativeAcquisitionDurationMs,
  });
  const abortable = <T>(operation: Promise<T>, ownedHelper = false): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('probe_aborted')); return; }
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanupOperation = operation.then((value) => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('probe_aborted'));
      else resolve(value);
    }, (error: unknown) => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    void cleanupOperation.catch(() => undefined);
    const onAbort = () => {
      cleanupTimer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        if (ownedHelper) helperShutdownFailed = true;
        reject(new Error(ownedHelper ? 'native_candidate_shutdown_failed' : 'probe_cleanup_timeout'));
      }, 2_000);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    if (input.signal?.aborted) return failed('cancelled');
    const expectedMid = await abortable(input.readExpectedMid(signal, deadlineUnixMs));
    if (signal.aborted) return failed(input.signal?.aborted ? 'cancelled' : 'timeout');
    const candidates = await abortable(input.acquireCandidates(signal, deadlineUnixMs,
      (durationMs) => { nativeAcquisitionDurationMs = Math.max(0, Math.min(MAX_RUN_MS, Math.floor(durationMs))); }), true);
    if (signal.aborted) return failed(input.signal?.aborted ? 'cancelled' : 'timeout');
    const result = await abortable(input.validate({ expectedMid, candidates, signal, deadlineUnixMs }));
    return { ...result, nativeAcquisitionDurationMs };
  } catch (error) {
    if (helperShutdownFailed || (error instanceof Error && error.message === 'native_candidate_shutdown_failed')) {
      return failed('helper_shutdown_failed');
    }
    if (input.signal?.aborted) return failed('cancelled');
    if (signal.aborted || (error instanceof Error && error.message === 'native_candidate_timeout')) return failed('timeout');
    return failed('provider_failure');
  }
}
