// Main service of the Primary Admin download bridge (phase 2: login, identity check and status; no download yet).
// It starts only when the user asks, or at app start when `login.json` holds the MID of the Primary Admin.
// It never sends a logout and it never starts the QR refresh by a timer.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { toDataURL } from 'qrcode';
import { BRIDGE_VERIFY_POLL_MS, BRIDGE_VERIFY_WAIT_MS } from './bridge-verification.js';
import { BridgeError } from './errors.js';
import { startOfficialDownloadBridge, type OfficialDownloadBridge, type OfficialDownloadBridgeOptions } from './index.js';
import { readLoginReading, requestQrRefresh, type LoginReading } from './login-state.js';
import type { CdpPipe } from './cdp-pipe.js';
import type { ExtensionHandles } from './extension-handles.js';

export type DownloadBridgeState = 'not_configured' | 'starting' | 'waiting_qr' | 'waiting_pin' | 'logged_in' | 'error';

/** `pending` until a message that the Primary Admin sent is also in the extension store with the same sender. */
export type DownloadBridgeIdentity = 'pending' | 'verified';
export type DownloadBridgeIdentityProof = 'verified' | 'mismatch' | 'not_in_store' | 'unproven' | 'skipped';

export interface DownloadBridgeStatus {
  readonly accountId: string | null;
  readonly state: DownloadBridgeState;
  /** Identity proof of the logged-in Chrome account. Only in the state logged_in. */
  readonly identity?: DownloadBridgeIdentity;
  /** Real error code when the state is error. */
  readonly code?: string;
  /** Diagnostic text of the state `starting` (max 200 characters of `[A-Za-z0-9_.:/|=,-]`). Names, counts and HTTP status numbers only. */
  readonly detail?: string;
  readonly qrImageDataUrl?: string;
  readonly pin?: string;
  /** Epoch ms when the current QR code ends (states waiting_qr and waiting_pin). Absent when unknown. */
  readonly qrExpiresAt?: number;
}

export interface OfficialDownloadBridgeServiceOptions {
  /** `<userData>/official-download-bridge`. It holds `ext/`, `profile/` and `login.json`. */
  readonly root: string;
  /** Called when the status changes (state, code, QR image or PIN). */
  readonly onStatus: (status: DownloadBridgeStatus & { accountId: string }) => void;
  /** Called with the real error of a failed start or poll. The caller must not log the QR link or the PIN. */
  readonly onError?: (error: unknown) => void;
  /** Test seam. The default is `startOfficialDownloadBridge`. */
  readonly startBridge?: (options: OfficialDownloadBridgeOptions) => Promise<OfficialDownloadBridge>;
  readonly pollIntervalMs?: number;
  /** Time limit to reach logged_in after an app-start resume. */
  readonly resumeTimeoutMs?: number;
  /** Time limit for a user-requested login (scan and confirm). */
  readonly interactiveTimeoutMs?: number;
}

const POLL_INTERVAL_MS = 1000;
const RESUME_TIMEOUT_MS = 60_000;
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;
const MAX_POLL_FAILURES = 5;
/** Delay before each next restart of an ended Chrome. The last value repeats. */
const RESTART_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
/** Time in logged_in after which the restart delay starts again from the first value. */
const BACKOFF_RESET_MS = 10 * 60_000;
const MID_PATTERN = /^u[0-9a-f]{32}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Largest number of identity proofs that run or wait at one time. */
const MAX_PROOF_QUEUE = 5;
const PROOF_CALL_TIMEOUT_MS = 10_000;

/**
 * Runs on the extension store (`this`, the object IA). Arguments: the server message ID and the Primary Admin MID (by value).
 * It reads only. It returns four booleans and never an ID.
 */
const PROOF_FUNCTION = `function(id,adminMid){
  const s=this.getState();
  const m=s&&s.message&&s.message.entities&&s.message.entities.messages;
  const e=m&&Object.prototype.hasOwnProperty.call(m,id)?m[id]:null;
  if(!e)return {found:false,fromEqualsProfile:false,fromIsPlainMid:false,fromEqualsAdmin:false};
  const p=s.auth&&s.auth.profile&&s.auth.profile.mid;
  const f=e.from;
  const ok=typeof f==='string'&&f.length>0;
  return {found:true,
    fromEqualsProfile:ok&&typeof p==='string'&&p.length>0&&f===p,
    fromIsPlainMid:ok&&/^[ucr][0-9a-f]{32}$/.test(f),
    fromEqualsAdmin:ok&&f===adminMid}
}`;

interface ProofReading {
  readonly found: boolean;
  readonly fromEqualsProfile: boolean;
  readonly fromIsPlainMid: boolean;
  readonly fromEqualsAdmin: boolean;
}

function proofReadingOf(value: unknown): ProofReading | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const names = ['found', 'fromEqualsProfile', 'fromIsPlainMid', 'fromEqualsAdmin'] as const;
  if (names.some((name) => typeof input[name] !== 'boolean')) return null;
  return { found: input.found as boolean, fromEqualsProfile: input.fromEqualsProfile as boolean,
    fromIsPlainMid: input.fromIsPlainMid as boolean, fromEqualsAdmin: input.fromEqualsAdmin as boolean };
}

function profileIdHashOf(profileId: string): string {
  return createHash('sha256').update(profileId).digest('hex');
}

export type LctKind = 'session' | 'persistent' | 'absent';
const LCT_KINDS: readonly string[] = ['session', 'persistent', 'absent'];
const LCT_READ_LIMIT_MS = 2_000;
/** Cookie name of the LINE login that the extension restores at start. */
const LCT_COOKIE = 'lct';

function lctKindOf(cookies: unknown, nowMs: number): LctKind {
  if (!Array.isArray(cookies)) return 'absent';
  let kind: LctKind = 'absent';
  for (const cookie of cookies as unknown[]) {
    if (typeof cookie !== 'object' || cookie === null || (cookie as { name?: unknown }).name !== LCT_COOKIE) continue;
    const { session, expires } = cookie as { session?: unknown; expires?: unknown };
    if (session === true) return 'session';
    if (typeof expires === 'number' && expires * 1000 > nowMs) kind = 'persistent';
  }
  return kind;
}

interface LoginMarker {
  readonly mid: string;
  readonly profileIdHash?: string;
  readonly identity?: DownloadBridgeIdentity;
  /** Kind of the `lct` cookie of the last app shutdown. One word only, never the cookie value. */
  readonly lctKind?: LctKind;
}

/** Same options and same limits as the `lineQr` image of the worker QR login. */
export async function renderQrImage(link: string): Promise<string> {
  if (link.length > 2048) throw new Error('QR payload exceeds the local rendering limit');
  const imageDataUrl = await toDataURL(link, { type: 'image/png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
  if (imageDataUrl.length > 256_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)) {
    throw new Error('QR payload could not be encoded safely');
  }
  return imageDataUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_STATUS_CODE = 64;
const MAX_PAGE_ERROR = 80;
const CHROME_STARTING_CODE = 'CHROME_STARTING';

/** Upper case word of `[A-Z0-9_]`, at most 64 characters. */
function safeWord(prefix: string, value: string): string {
  return `${prefix}_${value.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, MAX_STATUS_CODE);
}

const MAX_QR_VALIDITY_MS = 30 * 60_000;
const MAX_QR_BODY_LENGTH = 200_000;

/** Finds the first number of the key at any depth of a parsed JSON value. */
function findNumber(value: unknown, key: string, depth: number): number | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  const own = (value as Record<string, unknown>)[key];
  if (typeof own === 'number') return own;
  for (const child of Object.values(value)) {
    const found = findNumber(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Masks a MID for diagnostics: first 4 characters, `..`, last 4 characters, `-len`, length. Only A-Za-z0-9 are kept. */
export function maskMid(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9]/g, '');
  if (clean.length <= 8) return `-len${clean.length}`;
  return `${clean.slice(0, 4)}..${clean.slice(-4)}-len${clean.length}`;
}

/**
 * Reads only `longPollingIntervalSec` and `longPollingMaxCount` from the body of a createQrCode answer.
 * Returns the end time of the QR code, or undefined when a number is missing or not a positive integer or the total is over 30 minutes.
 * No other field is kept.
 */
export function qrExpiryOf(body: string, receivedAt: number): number | undefined {
  if (body.length > MAX_QR_BODY_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const interval = findNumber(parsed, 'longPollingIntervalSec', 0);
  const count = findNumber(parsed, 'longPollingMaxCount', 0);
  if (interval === undefined || count === undefined || !Number.isInteger(interval) || !Number.isInteger(count) || interval <= 0 || count <= 0) return undefined;
  const total = interval * count * 1000;
  return total <= MAX_QR_VALIDITY_MS ? receivedAt + total : undefined;
}

/** Reduces one `Runtime.exceptionThrown` event to names only: class name and `<file>:<line>:<column>` of the first frame. */
export function pageErrorOf(params: Record<string, unknown>): string | undefined {
  const details = params.exceptionDetails as { text?: unknown; url?: unknown; lineNumber?: unknown; columnNumber?: unknown;
    exception?: { className?: unknown }; stackTrace?: { callFrames?: Array<{ url?: unknown; lineNumber?: unknown; columnNumber?: unknown }> } } | undefined;
  if (!details || typeof details !== 'object') return undefined;
  const className = typeof details.exception?.className === 'string' && details.exception.className
    ? details.exception.className : typeof details.text === 'string' ? (details.text.trim().split(/\s+/)[0] ?? '') : '';
  const frame = details.stackTrace?.callFrames?.[0] ?? details;
  const url = typeof frame.url === 'string' ? frame.url : '';
  const file = (url.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const place = file ? `${file}:${typeof frame.lineNumber === 'number' ? frame.lineNumber : 0}:${typeof frame.columnNumber === 'number' ? frame.columnNumber : 0}` : '';
  const value = [className, place].filter(Boolean).join('_').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, MAX_PAGE_ERROR);
  return value || undefined;
}

function errorCodeOf(error: unknown, fallback: string): string {
  if (error instanceof BridgeError) return error.code;
  return fallback;
}

interface Session {
  readonly id: number;
  readonly accountId: string;
  readonly adminMid: string;
  readonly mode: 'interactive' | 'resume';
  bridge?: OfficialDownloadBridge | undefined;
  /** The background run of this session. `clear()` waits for it before it deletes the profile. */
  run?: Promise<void>;
  deadline: number;
  /** The Chrome profile ID of this session. It is set at the first logged-in reading and stays in memory only. */
  profileId?: string | undefined;
  /** Identity proof state. */
  identity: DownloadBridgeIdentity;
  /** Detail text of the status logged_in (for example `proof=unproven`). */
  identityNote?: string | undefined;
  /** True after the first verified login. The login time limit then no longer applies. */
  everLoggedIn: boolean;
  /** Time of the current logged_in period. */
  loggedInSince?: number | undefined;
  /** Number of restarts since the last reset of the delay. */
  restarts: number;
  lastLink?: string | undefined;
  /** Last uncaught exception of the extension page (names only). */
  pageError?: string | undefined;
  /** Network events of the extension page, oldest first. Path and outcome only. */
  netEvents: NetEvent[];
  /** Detail text of the state `starting`. */
  detail?: string | undefined;
  /** End time of the current QR code. */
  qrExpiresAt?: number | undefined;
  /** createQrCode requests of the extension page: request ID and time of the response (0 before the response). */
  qrRequests: Map<string, number>;
}

interface NetEvent {
  readonly requestId: string;
  readonly path: string;
  /** `wait`, an HTTP status number or `fail`. */
  outcome: string;
}

const MAX_NET_EVENTS = 20;
const SHOWN_NET_EVENTS = 4;
const MAX_NET_PATH = 30;
const MAX_DETAIL = 200;
const SANDBOX_COUNT_EXPRESSION = `Array.from(document.querySelectorAll('iframe')).filter((f) => (f.src || '').split(/[?#]/)[0].endsWith('ltsmSandbox.html')).length`;

const QR_CREATE_PATH_SUFFIX = 'createQrCode';

/** Last 2 path segments of a URL, without host and query. Returns undefined for `chrome-extension:` and `data:` URLs or an invalid URL. */
export function netPathOf(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.startsWith('data:') || rawUrl.startsWith('chrome-extension:')) return undefined;
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return undefined;
  }
  const segments = pathname.split('/').filter(Boolean).slice(-2).map((segment) => segment.replace(/[^A-Za-z0-9_.-]/g, '_'));
  const value = segments.join('/').slice(-MAX_NET_PATH);
  return value || '/';
}

export class OfficialDownloadBridgeService {
  readonly #options: OfficialDownloadBridgeServiceOptions;
  readonly #profileDir: string;
  readonly #markerFile: string;
  #status: DownloadBridgeStatus = { accountId: null, state: 'not_configured' };
  #session: Session | undefined;
  #nextSessionId = 1;
  #closed = false;
  /** Serializes start, clear and close. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Serializes identity proofs. It is separate from `#queue`, so a proof never blocks a start or a download. */
  #proofQueue: Promise<unknown> = Promise.resolve();
  #proofCount = 0;

  constructor(options: OfficialDownloadBridgeServiceOptions) {
    this.#options = options;
    this.#profileDir = nodePath.join(options.root, 'profile');
    this.#markerFile = nodePath.join(options.root, 'login.json');
  }

  status(): DownloadBridgeStatus {
    return this.#status;
  }

  /** Live handles for phase 3. Only when the state is logged_in and Chrome is alive. */
  getLive(): { readonly cdp: CdpPipe; readonly handles: ExtensionHandles } | null {
    const bridge = this.#session?.bridge;
    if (this.#status.state !== 'logged_in' || !bridge || bridge.cdp.isClosed) return null;
    return { cdp: bridge.cdp, handles: bridge.handles };
  }

  /** User request. Returns at once; the work goes on in the background. */
  start(input: { accountId: string; adminMid: string }): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || this.#session) return;
      this.#begin(input, 'interactive');
    });
  }

  /** App start. Starts only when `login.json` has the MID of the Primary Admin. Returns at once. */
  startAtAppStart(input: { accountId: string; adminMid: string }): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || this.#session) return;
      const marker = await this.#readMarker();
      if (!marker || marker.mid !== input.adminMid) return;
      this.#begin(input, 'resume');
    });
  }

  /** User request. Calls the refresh function of the extension QR page. Returns false when there is no QR page. */
  async refreshQr(): Promise<boolean> {
    const session = this.#session;
    const bridge = session?.bridge;
    if (!session || !bridge || bridge.cdp.isClosed) return false;
    // A refresh is valid only for a QR error state. In any other state it would start a second QR flow.
    const current = this.#status;
    if (current.state !== 'error' || !(current.code === 'QR_EXPIRED' || current.code === 'QR_FLOW_ERROR' || current.code === 'PIN_CODE_TIMEOUT')) return false;
    try {
      const requested = await requestQrRefresh(bridge.cdp, bridge.handles);
      // A new QR flow needs time. Extend the time limit of the session.
      if (requested) session.deadline = Math.max(session.deadline, Date.now() + (this.#options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS));
      return requested;
    } catch (error) {
      this.#options.onError?.(error);
      return false;
    }
  }

  /** Closes Chrome, deletes the profile folder and `login.json`. */
  clear(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#endSession(60_000);
      await this.#deleteLoginData();
      this.#setStatus({ accountId: this.#status.accountId, state: 'not_configured' });
    });
  }

  /** App shutdown. Closes Chrome. The profile and `login.json` stay. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#enqueue(async () => {
      await this.#recordLctKind();
      await this.#endSession(5_000);
    });
  }

  /**
   * Evidence for the next start: keeps the kind of the `lct` cookie (one word) in `login.json` before Chrome closes.
   * It runs only in the state logged_in, takes at most 2 s and writes nothing on an error. No cookie value is kept.
   */
  async #recordLctKind(): Promise<void> {
    const bridge = this.#session?.bridge;
    if (this.#status.state !== 'logged_in' || !bridge || bridge.cdp.isClosed) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const read = bridge.cdp.send('Storage.getCookies', {}, undefined, LCT_READ_LIMIT_MS).then((answer) => lctKindOf(answer.cookies, Date.now()));
      const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LCT_READ_LIMIT_MS); });
      const kind = await Promise.race([read, limit]);
      read.catch(() => undefined);
      if (kind === undefined) return;
      const marker = await this.#readMarker();
      if (marker) await this.#writeMarker({ ...marker, lctKind: kind });
    } catch {
      // Evidence only. Nothing is written.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the marker. The old shape `{ mid }` and the new shape `{ mid, profileIdHash, identity }` are both valid. */
  async #readMarker(): Promise<LoginMarker | null> {
    try {
      const parsed = JSON.parse(await readFile(this.#markerFile, 'utf8')) as { mid?: unknown; profileIdHash?: unknown; identity?: unknown; lctKind?: unknown };
      if (typeof parsed.mid !== 'string' || !MID_PATTERN.test(parsed.mid)) return null;
      return {
        mid: parsed.mid,
        ...(typeof parsed.profileIdHash === 'string' && HASH_PATTERN.test(parsed.profileIdHash) ? { profileIdHash: parsed.profileIdHash } : {}),
        ...(parsed.identity === 'verified' || parsed.identity === 'pending' ? { identity: parsed.identity } : {}),
        ...(typeof parsed.lctKind === 'string' && LCT_KINDS.includes(parsed.lctKind) ? { lctKind: parsed.lctKind as LctKind } : {}),
      };
    } catch {
      return null;
    }
  }

  async #writeMarker(marker: LoginMarker): Promise<void> {
    await mkdir(this.#options.root, { recursive: true });
    await writeFile(this.#markerFile, JSON.stringify(marker), 'utf8');
  }

  /**
   * Proves that the logged-in Chrome account is the Primary Admin account.
   * It reads one message that the Primary Admin sent from the extension store. The sender of the store message must equal the Chrome profile ID.
   * It reads only. It returns `skipped` when there is no logged-in session or the identity is already verified.
   * At most one proof runs at one time. The other calls wait in a queue of a bounded size.
   */
  proveIdentity(messageId: string): Promise<DownloadBridgeIdentityProof> {
    const session = this.#session;
    if (!session || this.#status.state !== 'logged_in' || session.identity === 'verified' || session.profileId === undefined
      || this.#proofCount >= MAX_PROOF_QUEUE) return Promise.resolve('skipped');
    this.#proofCount += 1;
    const work = (): Promise<DownloadBridgeIdentityProof> => this.#proveOnce(session, messageId).then((result) => this.#noteProof(session, result)).finally(() => { this.#proofCount -= 1; });
    const run = this.#proofQueue.then(work, work);
    this.#proofQueue = run.catch(() => undefined);
    return run;
  }

  /** Shows the last proof result in the status detail (`proof=<result>`). A mismatch ends the session, so it needs no note. */
  #noteProof(session: Session, result: DownloadBridgeIdentityProof): DownloadBridgeIdentityProof {
    if (result === 'verified' || result === 'not_in_store' || result === 'unproven') {
      session.identityNote = `proof=${result}`;
      if (this.#isCurrent(session) && this.#status.state === 'logged_in') this.#setStatus(this.#loggedInStatus(session));
    }
    return result;
  }

  async #proveOnce(session: Session, messageId: string): Promise<DownloadBridgeIdentityProof> {
    const end = Date.now() + BRIDGE_VERIFY_WAIT_MS;
    for (;;) {
      if (!this.#isCurrent(session) || session.identity === 'verified' || session.profileId === undefined) return 'skipped';
      const live = this.getLive();
      if (!live) return 'skipped';
      let reading: ProofReading | null = null;
      try {
        const response = (await live.cdp.send('Runtime.callFunctionOn', {
          objectId: live.handles.ids.IA, functionDeclaration: PROOF_FUNCTION,
          arguments: [{ value: messageId }, { value: session.adminMid }], awaitPromise: false, returnByValue: true,
        }, live.handles.sessionId, PROOF_CALL_TIMEOUT_MS)) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (!response.exceptionDetails) reading = proofReadingOf(response.result?.value);
      } catch (error) {
        if (error instanceof BridgeError && error.code === 'CDP_CLOSED') return 'skipped';
        // Any other read error counts as "not read yet". The loop tries again until the time limit.
      }
      if (reading?.found) return this.#applyProof(session, reading);
      if (Date.now() >= end) return 'not_in_store';
      await sleep(BRIDGE_VERIFY_POLL_MS);
    }
  }

  async #applyProof(session: Session, reading: ProofReading): Promise<DownloadBridgeIdentityProof> {
    if (!this.#isCurrent(session) || session.identity === 'verified' || session.profileId === undefined) return 'skipped';
    if (reading.fromEqualsProfile) {
      session.identity = 'verified';
      session.identityNote = 'proof=verified';
      await this.#writeMarker({ mid: session.adminMid, profileIdHash: profileIdHashOf(session.profileId), identity: 'verified' }).catch((error: unknown) => this.#options.onError?.(error));
      if (this.#isCurrent(session) && this.#status.state === 'logged_in') this.#setStatus(this.#loggedInStatus(session));
      return 'verified';
    }
    // The sender is a plain MID that differs from the Primary Admin MID: the logged-in account did not send this message.
    // Any other form of the sender cannot prove a difference. The identity then stays pending.
    if (reading.fromIsPlainMid && !reading.fromEqualsAdmin) {
      await this.#fail(session, 'ADMIN_IDENTITY_MISMATCH', true, 'identity=sender_diff');
      return 'mismatch';
    }
    session.identityNote = 'proof=unproven';
    if (this.#isCurrent(session) && this.#status.state === 'logged_in') this.#setStatus(this.#loggedInStatus(session));
    return 'unproven';
  }

  #loggedInStatus(session: Session): DownloadBridgeStatus {
    return { accountId: session.accountId, state: 'logged_in', identity: session.identity, ...(session.identityNote ? { detail: session.identityNote } : {}) };
  }

  async #deleteLoginData(): Promise<void> {
    await rm(this.#profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(this.#markerFile, { force: true });
  }

  /** Stops the poll loop and closes Chrome of the current session. Waits at most `waitMs` for a start that is still running. */
  async #endSession(waitMs: number): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    if (session.bridge) await session.bridge.close().catch(() => undefined);
    if (session.run) await Promise.race([session.run.catch(() => undefined), sleep(waitMs)]);
  }

  #setStatus(next: DownloadBridgeStatus): void {
    const previous = this.#status;
    this.#status = next;
    if (!next.accountId) return;
    if (previous.accountId === next.accountId && previous.state === next.state && previous.code === next.code
      && previous.detail === next.detail && previous.qrImageDataUrl === next.qrImageDataUrl && previous.pin === next.pin && previous.qrExpiresAt === next.qrExpiresAt
      && previous.identity === next.identity) return;
    this.#options.onStatus({ ...next, accountId: next.accountId });
  }

  #begin(input: { accountId: string; adminMid: string }, mode: 'interactive' | 'resume'): void {
    const timeout = mode === 'resume' ? (this.#options.resumeTimeoutMs ?? RESUME_TIMEOUT_MS) : (this.#options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS);
    const session: Session = { id: this.#nextSessionId++, accountId: input.accountId, adminMid: input.adminMid, mode, deadline: Date.now() + timeout, identity: 'pending', everLoggedIn: false, restarts: 0, netEvents: [], qrRequests: new Map() };
    this.#session = session;
    this.#setStatus({ accountId: input.accountId, state: 'starting', code: CHROME_STARTING_CODE });
    session.run = this.#run(session);
  }

  /** Status `starting` with the sub-state code and the last known detail. */
  #setStarting(session: Session, code: string): void {
    this.#setStatus({ accountId: session.accountId, state: 'starting', code, ...(session.detail ? { detail: session.detail } : {}) });
  }

  /** Builds the detail text of the state `starting`: page error, sandbox iframe count and last network events. */
  async #refreshDetail(session: Session): Promise<void> {
    const bridge = session.bridge;
    if (!bridge || this.#status.state !== 'starting') return;
    const parts: string[] = [];
    if (session.pageError) parts.push(`page=${session.pageError}`);
    try {
      const response = (await bridge.cdp.send('Runtime.evaluate', { expression: SANDBOX_COUNT_EXPRESSION, returnByValue: true }, bridge.handles.sessionId)) as { result?: { value?: unknown } };
      const count = response.result?.value;
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) parts.push(`sandbox=${count}`);
    } catch {
      // Diagnostics only.
    }
    const shown = session.netEvents.slice(-SHOWN_NET_EVENTS).map((event) => `${event.path}:${event.outcome}`);
    if (shown.length > 0) parts.push(`net=${shown.join(',')}`);
    const detail = parts.join('|').replace(/[^A-Za-z0-9_.:/|=,-]/g, '').slice(0, MAX_DETAIL);
    session.detail = detail || undefined;
    if (!this.#isCurrent(session) || this.#status.state !== 'starting' || session.bridge !== bridge) return;
    this.#setStatus({ accountId: session.accountId, state: 'starting', ...(this.#status.code ? { code: this.#status.code } : {}), ...(session.detail ? { detail: session.detail } : {}) });
  }

  /** Records the last uncaught exception and the network events of the extension page. Observation only: local CDP event domains; they send and change nothing. */
  #watchPageErrors(session: Session, bridge: OfficialDownloadBridge): void {
    const mine = (sessionId: string | undefined): boolean => sessionId === bridge.handles.sessionId && session.bridge === bridge;
    try {
      bridge.cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
        if (!mine(sessionId)) return;
        const value = pageErrorOf(params);
        if (value) session.pageError = value;
      });
      bridge.cdp.on('Network.requestWillBeSent', (params, sessionId) => {
        if (!mine(sessionId) || typeof params.requestId !== 'string') return;
        const path = netPathOf((params.request as { url?: unknown } | undefined)?.url);
        if (path === undefined) return;
        if (path.endsWith(QR_CREATE_PATH_SUFFIX)) {
          // A new QR code is requested. The old end time no longer applies.
          if (session.qrRequests.size >= MAX_NET_EVENTS) session.qrRequests.clear();
          session.qrRequests.set(params.requestId, 0);
          this.#updateQrExpiry(session, undefined);
        }
        const existing = session.netEvents.find((event) => event.requestId === params.requestId);
        if (existing) {
          // A redirect reuses the request ID.
          existing.outcome = 'wait';
          return;
        }
        session.netEvents.push({ requestId: params.requestId, path, outcome: 'wait' });
        if (session.netEvents.length > MAX_NET_EVENTS) session.netEvents.shift();
      });
      bridge.cdp.on('Network.responseReceived', (params, sessionId) => {
        if (!mine(sessionId)) return;
        const event = session.netEvents.find((item) => item.requestId === params.requestId);
        const status = (params.response as { status?: unknown } | undefined)?.status;
        if (event && typeof status === 'number' && Number.isInteger(status)) event.outcome = String(status);
        if (typeof params.requestId === 'string' && session.qrRequests.has(params.requestId)) session.qrRequests.set(params.requestId, Date.now());
      });
      bridge.cdp.on('Network.loadingFinished', (params, sessionId) => {
        if (!mine(sessionId) || typeof params.requestId !== 'string') return;
        const receivedAt = session.qrRequests.get(params.requestId);
        if (receivedAt === undefined) return;
        session.qrRequests.delete(params.requestId);
        void this.#readQrExpiry(session, bridge, params.requestId, receivedAt || Date.now());
      });
      bridge.cdp.on('Network.loadingFailed', (params, sessionId) => {
        if (!mine(sessionId)) return;
        if (typeof params.requestId === 'string') session.qrRequests.delete(params.requestId);
        const event = session.netEvents.find((item) => item.requestId === params.requestId);
        if (event) event.outcome = 'fail';
      });
      void bridge.cdp.send('Runtime.enable', {}, bridge.handles.sessionId).catch(() => undefined);
      void bridge.cdp.send('Network.enable', {}, bridge.handles.sessionId).catch(() => undefined);
    } catch {
      // Diagnostics only. A missing event API must not stop the bridge.
    }
  }

  /** Local CDP read of the createQrCode answer. Keeps only the end time of the QR code. The body is never stored or logged. */
  async #readQrExpiry(session: Session, bridge: OfficialDownloadBridge, requestId: string, receivedAt: number): Promise<void> {
    try {
      const response = (await bridge.cdp.send('Network.getResponseBody', { requestId }, bridge.handles.sessionId)) as { body?: unknown; base64Encoded?: unknown };
      if (typeof response.body !== 'string') return;
      const text = response.base64Encoded === true ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      const expiresAt = qrExpiryOf(text, receivedAt);
      if (!this.#isCurrent(session) || session.bridge !== bridge) return;
      this.#updateQrExpiry(session, expiresAt);
    } catch {
      // The QR countdown is optional.
    }
  }

  /** Sets the QR end time of the session and publishes it only when the QR code is on screen. */
  #updateQrExpiry(session: Session, expiresAt: number | undefined): void {
    session.qrExpiresAt = expiresAt;
    if (this.#session !== session) return;
    const current = this.#status;
    if (current.state !== 'waiting_qr') return;
    const { qrExpiresAt: _previous, ...rest } = current;
    this.#setStatus({ ...rest, ...(expiresAt !== undefined ? { qrExpiresAt: expiresAt } : {}) });
  }

  #isCurrent(session: Session): boolean {
    return this.#session === session && !this.#closed;
  }

  /** Ends the session with an error state. Closes Chrome; deletes the login data when `deleteData` is true. */
  async #fail(session: Session, code: string, deleteData = false, detail?: string): Promise<void> {
    if (this.#session !== session) return;
    this.#session = undefined;
    this.#setStatus({ accountId: session.accountId, state: 'error', code, ...(detail ? { detail } : {}) });
    if (session.bridge) await session.bridge.close().catch(() => undefined);
    if (deleteData) await this.#deleteLoginData().catch((error: unknown) => this.#options.onError?.(error));
  }

  /** Runs the session. Chrome is resident: after an unexpected end it restarts with the same profile and a growing delay. */
  async #run(session: Session): Promise<void> {
    while (this.#isCurrent(session)) {
      const outcome = await this.#startAndPoll(session);
      if (outcome === 'ended' || !this.#isCurrent(session)) return;
      // Chrome ended without a request. Close the old process first: two bridge Chrome processes never run together.
      const old = session.bridge;
      session.bridge = undefined;
      if (old) await old.close().catch(() => undefined);
      if (!this.#isCurrent(session)) return;
      if (this.#status.state === 'error') {
        await this.#fail(session, this.#status.code ?? 'CDP_CLOSED');
        return;
      }
      if (session.loggedInSince !== undefined && Date.now() - session.loggedInSince >= BACKOFF_RESET_MS) session.restarts = 0;
      session.loggedInSince = undefined;
      const delay = RESTART_DELAYS_MS[Math.min(session.restarts, RESTART_DELAYS_MS.length - 1)] as number;
      session.restarts += 1;
      session.pageError = undefined;
      session.netEvents = [];
      session.qrRequests.clear();
      session.qrExpiresAt = undefined;
      session.detail = undefined;
      this.#setStatus({ accountId: session.accountId, state: 'starting', code: CHROME_STARTING_CODE });
      await this.#sleepWhileCurrent(session, delay);
    }
  }

  async #sleepWhileCurrent(session: Session, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.#isCurrent(session) && Date.now() < end) await sleep(Math.min(1000, Math.max(0, end - Date.now())));
  }

  /** Starts Chrome and polls. Returns 'crashed' when the Chrome process ended without a request. */
  async #startAndPoll(session: Session): Promise<'ended' | 'crashed'> {
    try {
      const start = this.#options.startBridge ?? startOfficialDownloadBridge;
      const bridge = await start({ root: this.#options.root, profileDir: this.#profileDir, ...(this.#options.onError ? { onError: this.#options.onError } : {}) });
      if (!this.#isCurrent(session)) {
        await bridge.close().catch(() => undefined);
        return 'ended';
      }
      session.bridge = bridge;
      this.#watchPageErrors(session, bridge);
    } catch (error) {
      this.#options.onError?.(error);
      if (error instanceof BridgeError && error.code === 'CDP_CLOSED' && this.#isCurrent(session)) return 'crashed';
      await this.#fail(session, errorCodeOf(error, 'BRIDGE_START_FAILED'));
      return 'ended';
    }
    return this.#poll(session);
  }

  async #poll(session: Session): Promise<'ended' | 'crashed'> {
    const interval = this.#options.pollIntervalMs ?? POLL_INTERVAL_MS;
    let failures = 0;
    while (this.#isCurrent(session)) {
      const bridge = session.bridge;
      if (!bridge) return 'ended';
      try {
        const reading = await readLoginReading(bridge.cdp, bridge.handles);
        failures = 0;
        if (!this.#isCurrent(session)) return 'ended';
        const done = await this.#apply(session, reading);
        if (done) return 'ended';
        if (this.#status.state === 'starting') await this.#refreshDetail(session);
        else session.detail = undefined;
      } catch (error) {
        if (!this.#isCurrent(session)) return 'ended';
        failures += 1;
        if ((error instanceof BridgeError && error.code === 'CDP_CLOSED') || failures >= MAX_POLL_FAILURES) {
          // The error text of CDP_CLOSED carries the real exit code of Chrome.
          this.#options.onError?.(error);
          return 'crashed';
        }
      }
      if (!session.everLoggedIn && session.deadline < Date.now() && this.#status.state !== 'logged_in') {
        await this.#fail(session, 'LOGIN_TIMEOUT');
        return 'ended';
      }
      await sleep(interval);
    }
    return 'ended';
  }

  /** Applies one reading. Returns true when the session ended. */
  async #apply(session: Session, reading: LoginReading): Promise<boolean> {
    if (reading.loginState === 'logged_in') {
      if (!reading.mid) return false;
      // The Chrome profile ID is a different ID form than the MID of the Primary Admin. It is never compared with that MID.
      // The first profile ID of a session is compared only with the hash in the marker. The proof of the account is `proveIdentity`.
      if (session.profileId === undefined) {
        const hash = profileIdHashOf(reading.mid);
        const stored = await this.#readMarker();
        const marker = stored && stored.mid === session.adminMid ? stored : null;
        if (marker?.profileIdHash && marker.profileIdHash !== hash) {
          // A different LINE account must not stay logged in. No logout is sent: Chrome closes and the profile goes.
          await this.#fail(session, 'ADMIN_IDENTITY_MISMATCH', true, `seen=${maskMid(reading.mid)}`);
          return true;
        }
        const identity: DownloadBridgeIdentity = marker?.profileIdHash === hash && marker.identity === 'verified' ? 'verified' : 'pending';
        await this.#writeMarker({ mid: session.adminMid, profileIdHash: hash, identity });
        session.profileId = reading.mid;
        session.identity = identity;
      } else if (reading.mid !== session.profileId) {
        await this.#fail(session, 'ADMIN_IDENTITY_MISMATCH', true, `seen=${maskMid(reading.mid)}`);
        return true;
      }
      session.everLoggedIn = true;
      session.loggedInSince ??= Date.now();
      this.#setStatus(this.#loggedInStatus(session));
      return false;
    }
    // Not logged in (again). The Chrome profile ID of this session stays: a later login must give the same ID.
    session.loggedInSince = undefined;
    const qr = reading.qr;
    if (reading.loginState !== 'logged_out') {
      this.#setStarting(session, safeWord('AUTH', reading.loginState));
      return false;
    }
    if (session.mode === 'resume' || session.everLoggedIn) {
      // The saved login was lost. The user did not ask for a new login: no QR code. Close Chrome and delete the login data (profile and login.json).
      const lct = session.mode === 'resume' ? (await this.#readMarker())?.lctKind : undefined;
      await this.#fail(session, 'BRIDGE_SESSION_EXPIRED', true, lct ? `lct=${lct}` : undefined);
      return true;
    }
    if (!qr) {
      this.#setStarting(session, 'QR_MISSING');
      return false;
    }
    if (qr.state === 'wait_for_qr_code_verified' && qr.qrCodeLink) {
      let image = this.#status.qrImageDataUrl;
      if (session.lastLink !== qr.qrCodeLink || !image || this.#status.state !== 'waiting_qr') {
        try {
          image = await renderQrImage(qr.qrCodeLink);
        } catch (error) {
          this.#options.onError?.(error);
          await this.#fail(session, 'QR_RENDER_FAILED');
          return true;
        }
        session.lastLink = qr.qrCodeLink;
      }
      if (!this.#isCurrent(session)) return true;
      this.#setStatus({ accountId: session.accountId, state: 'waiting_qr', qrImageDataUrl: image,
        ...(session.qrExpiresAt !== undefined ? { qrExpiresAt: session.qrExpiresAt } : {}) });
      return false;
    }
    if (qr.state === 'wait_for_pin_code_verified' && qr.pinCode) {
      session.lastLink = undefined;
      this.#setStatus({ accountId: session.accountId, state: 'waiting_pin', pin: qr.pinCode });
      return false;
    }
    if (qr.state === 'error') {
      session.lastLink = undefined;
      const errorCode = qr.errorCode ?? '';
      if (!errorCode) {
        // The extension sets no error code for HTTP errors. HTTP 410 on checkQrCodeVerified means that the QR code expired.
        const lastCheck = [...session.netEvents].reverse().find((event) => event.path.endsWith('checkQrCodeVerified'));
        if (lastCheck?.outcome === '410') {
          this.#setStatus({ accountId: session.accountId, state: 'error', code: 'QR_EXPIRED' });
        } else {
          const shown = session.netEvents.slice(-3).map((event) => `${event.path}:${event.outcome}`);
          const detail = shown.length > 0 ? `net=${shown.join(',')}`.replace(/[^A-Za-z0-9_.:/|=,-]/g, '').slice(0, MAX_DETAIL) : '';
          this.#setStatus({ accountId: session.accountId, state: 'error', code: 'QR_FLOW_ERROR', ...(detail ? { detail } : {}) });
        }
        return false;
      }
      if (errorCode === 'pin_code_timeout') {
        this.#setStatus({ accountId: session.accountId, state: 'error', code: 'PIN_CODE_TIMEOUT' });
        return false;
      }
      if (errorCode === 'pin_code_canceled') {
        // The extension starts a new QR flow by itself.
        this.#setStarting(session, 'PIN_CODE_CANCELED');
        return false;
      }
      await this.#fail(session, safeWord('QR', errorCode));
      return true;
    }
    this.#setStarting(session, safeWord('QR', qr.state));
    return false;
  }
}
