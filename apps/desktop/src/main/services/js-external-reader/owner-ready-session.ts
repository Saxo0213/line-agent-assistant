import path from 'node:path';
import { lstat, mkdir, open, opendir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import type { ExternalSourceProbeAdmission, ExternalSourceProbeRelease } from '../external-source-probe-admission.js';

const OWNER_READY_MAX_MS = 45_000;

export type OwnerProcessIdentity = Readonly<{
  pid: number;
  startedAt: string;
  imagePath: string;
  imageSha256: string;
}>;

export type ProvisionalOwnerReadyMarker = Readonly<{
  version: 1;
  phase: 'provisional';
  requestId: string;
  mainPid: number;
  mainStartedAt: string;
  mainImageSha256: string;
  bridgeImageSha256: string;
  deadlineUnixMs: number;
}>;

export type OwnedOwnerReadyMarker = Omit<ProvisionalOwnerReadyMarker, 'phase'> & Readonly<{
  phase: 'owned';
  childPid: number;
  childStartedAt: string;
  childImagePath: string;
}>;

export type OwnerReadyMarker = ProvisionalOwnerReadyMarker | OwnedOwnerReadyMarker;

export function isOwnerReadyMarker(value: unknown, requestId: string): value is OwnerReadyMarker {
  return isOwnerMarker(value, requestId);
}

export function sameOwnerReadyMarker(left: OwnerReadyMarker, right: OwnerReadyMarker): boolean {
  return sameMarker(left, right);
}

/** Storage owns one private request directory; promote must atomically replace its marker. */
export interface OwnerReadyMarkerStore {
  readonly requestDirectory: string;
  create(marker: ProvisionalOwnerReadyMarker): Promise<void>;
  read(): Promise<OwnerReadyMarker>;
  promote(expected: ProvisionalOwnerReadyMarker, next: OwnedOwnerReadyMarker): Promise<void>;
  remove(expected: OwnerReadyMarker): Promise<void>;
}

/** File-backed owner marker storage for a single private request directory. */
export class FileOwnerReadyMarkerStore implements OwnerReadyMarkerStore {
  readonly requestDirectory: string;
  readonly #requestRoot: string;
  readonly #requestId: string;
  readonly #ensurePrivateDirectory: (directory: string) => Promise<void>;
  #createdDirectory = false;
  #rootChainIdentity: readonly string[] | undefined;
  #directoryIdentity: string | undefined;
  #markerIdentity: string | undefined;

  constructor(requestRoot: string, requestId: string, ensurePrivateDirectory: (directory: string) => Promise<void>) {
    this.#requestRoot = path.resolve(requestRoot);
    this.#requestId = requestId;
    this.requestDirectory = path.join(this.#requestRoot, `probe-${requestId}`);
    this.#ensurePrivateDirectory = ensurePrivateDirectory;
  }

  async create(marker: ProvisionalOwnerReadyMarker): Promise<void> {
    if (marker.phase !== 'provisional' || marker.requestId !== this.#requestId) throw new Error('reader_owner_marker_invalid');
    await this.#assertDirectory(this.#requestRoot, true, true);
    await mkdir(this.requestDirectory, { mode: 0o700 });
    this.#createdDirectory = true;
    await this.#assertDirectory(this.requestDirectory, false);
    await writeMarker(path.join(this.requestDirectory, 'owner.json'), marker);
    this.#markerIdentity = await fileIdentity(path.join(this.requestDirectory, 'owner.json'));
  }

  async read(): Promise<OwnerReadyMarker> {
    await this.#assertDirectory(this.requestDirectory, false);
    const markerPath = path.join(this.requestDirectory, 'owner.json');
    const info = await lstat(markerPath, { bigint: true }).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 2n || info.size > 2048n) throw new Error('reader_owner_marker_invalid');
    if (this.#markerIdentity && statIdentity(info) !== this.#markerIdentity) throw new Error('reader_owner_marker_changed');
    let value: unknown;
    try { value = JSON.parse(await readFile(markerPath, 'utf8')); }
    catch { throw new Error('reader_owner_marker_invalid'); }
    if (!isOwnerMarker(value, this.#requestId)) throw new Error('reader_owner_marker_invalid');
    return value;
  }

  async promote(expected: ProvisionalOwnerReadyMarker, next: OwnedOwnerReadyMarker): Promise<void> {
    if (!this.#createdDirectory || expected.requestId !== this.#requestId || next.requestId !== this.#requestId ||
        !sameMarker(await this.read(), expected) || !(await this.#onlyNames(['owner.json']))) throw new Error('reader_owner_marker_invalid');
    const temporary = path.join(this.requestDirectory, 'owner.next');
    await writeMarker(temporary, next);
    const nextIdentity = await fileIdentity(temporary);
    if (!sameMarker(await this.read(), expected) || !(await this.#onlyNames(['owner.json', 'owner.next']))) {
      throw new Error('reader_owner_marker_changed');
    }
    await rename(temporary, path.join(this.requestDirectory, 'owner.json'));
    if (await fileIdentity(path.join(this.requestDirectory, 'owner.json')) !== nextIdentity) throw new Error('reader_owner_marker_changed');
    this.#markerIdentity = nextIdentity;
    if (!sameMarker(await this.read(), next)) throw new Error('reader_owner_marker_invalid');
  }

  async remove(expected: OwnerReadyMarker): Promise<void> {
    if (!this.#createdDirectory || !sameMarker(await this.read(), expected) || !(await this.#onlyNames(['owner.json']))) {
      throw new Error('reader_owner_marker_changed');
    }
    await unlink(path.join(this.requestDirectory, 'owner.json'));
    await rmdir(this.requestDirectory);
  }

  async #assertDirectory(directory: string, parent: boolean, applyAcl = false): Promise<void> {
    const before = await directoryChainIdentity(directory);
    if (samePath(directory, this.#requestRoot)) {
      if (this.#rootChainIdentity && !sameIdentityChain(this.#rootChainIdentity, before)) {
        throw new Error('reader_owner_directory_changed');
      }
      if (!this.#rootChainIdentity) this.#rootChainIdentity = before;
    } else if (samePath(directory, this.requestDirectory)) {
      if (!this.#rootChainIdentity || before.length <= this.#rootChainIdentity.length ||
          !sameIdentityChain(this.#rootChainIdentity, before.slice(0, this.#rootChainIdentity.length))) {
        throw new Error('reader_owner_directory_changed');
      }
    }
    if (applyAcl) {
      await this.#ensurePrivateDirectory(directory);
      const afterAcl = await directoryChainIdentity(directory);
      if (!sameIdentityChain(before, afterAcl)) throw new Error('reader_owner_directory_changed');
    }
    const info = await lstat(directory, { bigint: true }).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('reader_owner_directory_invalid');
    if (samePath(directory, this.requestDirectory) && this.#directoryIdentity && statIdentity(info) !== this.#directoryIdentity) {
      throw new Error('reader_owner_directory_changed');
    }
    if (samePath(directory, this.requestDirectory) && !this.#directoryIdentity) this.#directoryIdentity = statIdentity(info);
    if (parent && !samePath(path.dirname(this.requestDirectory), directory)) throw new Error('reader_owner_directory_invalid');
    if (parent && !samePath(directory, this.#requestRoot)) throw new Error('reader_owner_directory_invalid');
  }

  async #onlyNames(allowed: readonly string[]): Promise<boolean> {
    const names: string[] = [];
    const directory = await opendir(this.requestDirectory, { bufferSize: 4 });
    for await (const entry of directory) {
      if (names.length >= 2) return false;
      names.push(entry.name);
    }
    return names.length === allowed.length && names.sort().join(',') === [...allowed].sort().join(',');
  }
}

export interface OwnerReadyChild {
  readonly pid: number | undefined;
  readonly closedEvent?: Promise<unknown>;
  isAlive(): boolean;
  prepareOwnerReady?(requestId: string): Promise<void>;
  sendOwnerReady(requestId: string): Promise<void>;
  closeInput(): Promise<void>;
  waitClosed(deadlineUnixMs: number): Promise<boolean>;
  kill(): Promise<void>;
}

export async function runOwnerReadySession<T>(input: {
  requestRoot: string;
  requestId: string;
  deadlineUnixMs: number;
  mainIdentity: OwnerProcessIdentity;
  bridgeImagePath: string;
  bridgeImageSha256: string;
  admission: ExternalSourceProbeAdmission;
  markerStore: OwnerReadyMarkerStore;
  spawnChild(): OwnerReadyChild;
  inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
  runAfterReady(context: {
    marker: OwnedOwnerReadyMarker;
    signal: AbortSignal;
    trackSettlement(settlement: Promise<unknown>): void;
  }): Promise<T> | T;
  beforeCreate?(context: { signal: AbortSignal; deadlineUnixMs: number; trackSettlement(settlement: Promise<unknown>): void }): Promise<void> | void;
  signal?: AbortSignal;
  closeTimeoutMs?: number;
}): Promise<T> {
  const requestId = input.requestId;
  const closeTimeoutMs = input.closeTimeoutMs ?? 2_000;
  const requestRoot = path.resolve(input.requestRoot);
  const expectedRequestDirectory = path.join(requestRoot, `probe-${requestId}`);
  if (!/^[a-f0-9]{32}$/.test(requestId) || !path.isAbsolute(input.requestRoot) ||
      !input.markerStore || !samePath(input.markerStore.requestDirectory, expectedRequestDirectory) ||
      !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now() ||
      !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 15_000 ||
      !input.admission || typeof input.admission.acquire !== 'function' ||
      typeof input.spawnChild !== 'function' || typeof input.inspectProcess !== 'function' ||
      typeof input.runAfterReady !== 'function' || !validIdentity(input.mainIdentity) ||
      !validImagePath(input.bridgeImagePath) || !isSha256(input.bridgeImageSha256)) {
    throw new Error('reader_owner_request_invalid');
  }

  const deadlineUnixMs = Math.min(input.deadlineUnixMs, Date.now() + OWNER_READY_MAX_MS);
  let activeDeadlineUnixMs = deadlineUnixMs;
  let ownerReady = false;
  const sessionAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, sessionAbort.signal]) : sessionAbort.signal;
  let timeout = setTimeout(() => sessionAbort.abort(new Error('reader_deadline_exceeded')),
    Math.max(1, deadlineUnixMs - Date.now()));
  // The session deadline and caller signal also bound the wait for the shared slot.
  let releaseAdmission: ExternalSourceProbeRelease;
  try {
    releaseAdmission = await input.admission.acquire(signal);
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  let markerCreated = false;
  let child: OwnerReadyChild | undefined;
  let childIdentity: OwnerProcessIdentity | undefined;
  let currentMarker: OwnerReadyMarker | undefined;
  let operation: Promise<T> | undefined;
  let operationSettlement: Promise<void> | undefined;
  let operationSettled = true;
  const callbackSettlements = new Set<Promise<unknown>>();
  const trackCallbackSettlement = (settlement: Promise<unknown>) => {
    let tracked: Promise<unknown>;
    tracked = settlement.then(() => undefined, () => undefined).finally(() => { callbackSettlements.delete(tracked); });
    callbackSettlements.add(tracked);
  };
  let preparationSettled = true;
  let preparationSettlement: Promise<void> = Promise.resolve();
  let markerMutationSettlement: Promise<void> = Promise.resolve();
  let released = false;
  let markerMutationPending = false;
  let releaseSafe = false;
  let cleanupUncertain = false;
  let requestFailed = false;
  let childCloseError: unknown;

  const assertActive = () => {
    if (signal.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : 'reader_cancelled');
    if (!ownerReady && Date.now() >= activeDeadlineUnixMs) throw new Error('reader_deadline_exceeded');
  };
  const sameIdentity = async (expected: OwnerProcessIdentity) => {
    const actual = await bounded(input.inspectProcess(expected.pid), ownerReady ? Date.now() + 120_000 : activeDeadlineUnixMs, signal);
    return !!actual && identityMatches(expected, actual);
  };

  try {
    assertActive();
    if (input.beforeCreate) {
      preparationSettled = false;
      const preparation = Promise.resolve().then(() => input.beforeCreate!({ signal, deadlineUnixMs, trackSettlement: trackCallbackSettlement }));
      preparationSettlement = preparation.then(() => { preparationSettled = true; }, () => { preparationSettled = true; });
      await bounded(preparation, deadlineUnixMs, signal);
      assertActive();
    }
    const provisional: ProvisionalOwnerReadyMarker = {
      version: 1,
      phase: 'provisional',
      requestId,
      mainPid: input.mainIdentity.pid,
      mainStartedAt: input.mainIdentity.startedAt,
      mainImageSha256: input.mainIdentity.imageSha256.toLowerCase(),
      bridgeImageSha256: input.bridgeImageSha256.toLowerCase(),
      deadlineUnixMs: input.deadlineUnixMs,
    };
    markerCreated = true;
    currentMarker = provisional;
    const createMarker = input.markerStore.create(provisional);
    const createSettlement = createMarker.then(() => { markerCreated = true; }, () => undefined);
    markerMutationSettlement = createSettlement.then(() => { markerMutationPending = false; });
    markerMutationPending = true;
    await bounded(createMarker, deadlineUnixMs, signal);
    markerCreated = true;
    currentMarker = provisional;
    assertActive();

    // Spawn is not cancellable until it returns its owned child handle. Do not
    // race it against the parent signal and lose a late-returned process.
    child = input.spawnChild();
    if (!child || !Number.isSafeInteger(child.pid) || Number(child.pid) < 1 || !child.isAlive()) {
      throw new Error('reader_child_closed_before_ready');
    }
    assertActive();
    const firstIdentity = await bounded(input.inspectProcess(child.pid!), deadlineUnixMs, signal);
    if (!firstIdentity || firstIdentity.pid !== child.pid || !identityMatchesExpectedBridge(firstIdentity, {
      pid: child.pid!, imagePath: input.bridgeImagePath, imageSha256: input.bridgeImageSha256,
    })) throw new Error('reader_child_identity_invalid');
    childIdentity = firstIdentity;

    const owned: OwnedOwnerReadyMarker = {
      ...provisional,
      phase: 'owned',
      childPid: firstIdentity.pid,
      childStartedAt: firstIdentity.startedAt,
      childImagePath: normalizeImagePath(firstIdentity.imagePath),
    };
    const beforePromotion = await bounded(input.markerStore.read(), deadlineUnixMs, signal);
    if (!sameMarker(beforePromotion, provisional)) throw new Error('reader_owner_marker_invalid');
    assertActive();
    const promoteMarker = input.markerStore.promote(provisional, owned);
    const promoteSettlement = promoteMarker.then(() => { currentMarker = owned; }, () => undefined);
    markerMutationSettlement = promoteSettlement.then(() => { markerMutationPending = false; });
    markerMutationPending = true;
    await bounded(promoteMarker, deadlineUnixMs, signal);
    currentMarker = owned;

    const promoted = await bounded(input.markerStore.read(), deadlineUnixMs, signal);
    if (!sameMarker(promoted, owned)) throw new Error('reader_owner_marker_invalid');
    assertActive();
    if (!child.isAlive() || !(await sameIdentity(firstIdentity))) throw new Error('reader_child_identity_changed');
    assertActive();
    if (child.prepareOwnerReady) await bounded(child.prepareOwnerReady(requestId), deadlineUnixMs, signal);
    assertActive();
    if (!child.isAlive() || !(await sameIdentity(firstIdentity))) throw new Error('reader_child_identity_changed');
    assertActive();
    await bounded(child.sendOwnerReady(requestId), deadlineUnixMs, signal);
    if (!child.isAlive()) throw new Error('reader_child_closed_before_ready');
    assertActive();
    clearTimeout(timeout);
    ownerReady = true;
    // Import liveness is enforced by bounded frame/callback waits and the
    // native idle watchdog. A total import deadline rejects healthy large scans.

    operationSettled = false;
    operation = Promise.resolve().then(() => input.runAfterReady({ marker: owned, signal, trackSettlement: trackCallbackSettlement }));
    operationSettlement = operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    const result = await awaitWithAbort(operation, signal);
    assertActive();
    // Some operations (the official snapshot reader) validate a clean EOF
    // and exit code before resolving, so their child is expected to have
    // exited by this point. Recheck identity only while it remains alive.
    if (child.isAlive() && !(await sameIdentity(firstIdentity))) throw new Error('reader_child_identity_changed');
    return result;
  } catch (error) {
    requestFailed = true;
    throw error;
  } finally {
    clearTimeout(timeout);
    sessionAbort.abort();
    let childClosed = !child;
    if (child) {
      const closeInput = Promise.resolve().then(() => child!.closeInput()).catch((error: unknown) => { childCloseError = error; });
      try { await bounded(closeInput, Date.now() + closeTimeoutMs); }
      catch (error) { childCloseError = error; }
      try { childClosed = await bounded(child.waitClosed(Date.now() + closeTimeoutMs), Date.now() + closeTimeoutMs); }
      catch { childClosed = false; }
      if (!childClosed && childIdentity && child.pid === childIdentity.pid && await bounded(sameIdentityWithoutSignal(input, childIdentity), Date.now() + closeTimeoutMs).catch(() => false)) {
        try {
          await bounded(child.kill(), Date.now() + closeTimeoutMs);
          childClosed = await bounded(child.waitClosed(Date.now() + closeTimeoutMs), Date.now() + closeTimeoutMs);
        } catch { childClosed = false; cleanupUncertain = true; }
      }
      if (!childClosed) cleanupUncertain = true;
    }
    const callbackWork = [preparationSettlement, operationSettlement ?? Promise.resolve(), ...callbackSettlements, markerMutationSettlement];
    const workSettled = preparationSettled && operationSettled && callbackSettlements.size === 0 && !markerMutationPending;
    if (childClosed && workSettled) {
      releaseSafe = await removeOwnedMarker(input.markerStore, currentMarker, markerCreated, closeTimeoutMs);
      if (!releaseSafe) cleanupUncertain = true;
    } else {
      cleanupUncertain = true;
    }
    if (releaseSafe && !cleanupUncertain) {
      releaseAdmissionOnce();
      if (releaseAdmission.isCurrentOwner()) cleanupUncertain = true;
    }

    // The public request is bounded by close/kill and marker IO. One late
    // continuation retains the existing admission until callbacks settle and
    // the child close event is confirmed; it creates no timers or extra child.
    if (!released && (!childClosed || !workSettled)) {
      const childSettled = childClosed || !child ? Promise.resolve() : child.closedEvent?.then(() => undefined);
      if (childSettled) {
        void Promise.all([...callbackWork, childSettled]).then(async () => {
          const confirmedClosed = !child || childClosed || await bounded(child.waitClosed(Date.now() + closeTimeoutMs), Date.now() + closeTimeoutMs).catch(() => false);
          if (!confirmedClosed) return;
          if (await removeOwnedMarker(input.markerStore, currentMarker, markerCreated, closeTimeoutMs)) releaseAdmissionOnce();
        }).catch(() => undefined);
      }
    }
    if (ownerReady && (cleanupUncertain || !releaseSafe || markerMutationPending)) throw new Error('reader_owner_cleanup_uncertain');
    if (!requestFailed && !cleanupUncertain && childCloseError !== undefined) throw childCloseError;

    function releaseAdmissionOnce() {
      if (released) return;
      releaseAdmission();
      released = true;
    }
  }
}

async function removeOwnedMarker(store: OwnerReadyMarkerStore, marker: OwnerReadyMarker | undefined,
  markerCreated: boolean, timeoutMs: number): Promise<boolean> {
  if (!markerCreated) return true;
  if (!marker) return false;
  const deadline = Date.now() + timeoutMs;
  const observed = await readMarkerBounded(store, deadline).catch(() => undefined);
  if (!observed || !sameMarker(observed, marker)) return false;
  try { await bounded(store.remove(marker), deadline); return true; }
  catch { return false; }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : 'reader_cancelled');
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'reader_cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function validIdentity(identity: OwnerProcessIdentity): boolean {
  return !!identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    typeof identity.startedAt === 'string' && /^\d{15,20}$/.test(identity.startedAt) &&
    validImagePath(identity.imagePath) && isSha256(identity.imageSha256);
}

function identityMatches(expected: OwnerProcessIdentity, actual: OwnerProcessIdentity): boolean {
  return validIdentity(actual) && expected.pid === actual.pid && expected.startedAt === actual.startedAt &&
    normalizeImagePath(expected.imagePath) === normalizeImagePath(actual.imagePath) &&
    expected.imageSha256.toLowerCase() === actual.imageSha256.toLowerCase();
}

function identityMatchesExpectedBridge(actual: OwnerProcessIdentity, expected: { pid: number; imagePath: string; imageSha256: string }): boolean {
  return validIdentity(actual) && actual.pid === expected.pid &&
    normalizeImagePath(actual.imagePath) === normalizeImagePath(expected.imagePath) &&
    actual.imageSha256.toLowerCase() === expected.imageSha256.toLowerCase();
}

function validImagePath(value: string): boolean { return typeof value === 'string' && path.isAbsolute(value) && value.length > 0 && !value.includes('\0'); }
function normalizeImagePath(value: string): string { return path.normalize(path.resolve(value)).toLowerCase(); }
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isSha256(value: string): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }

function sameMarker(left: OwnerReadyMarker, right: OwnerReadyMarker): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const fields = Object.keys(right).sort();
  if (Object.keys(left).sort().join(',') !== fields.join(',')) return false;
  return fields.every((key) => (left as unknown as Record<string, unknown>)[key] === (right as unknown as Record<string, unknown>)[key]);
}

async function sameIdentityWithoutSignal(input: { inspectProcess(pid: number): Promise<OwnerProcessIdentity | null> }, expected: OwnerProcessIdentity): Promise<boolean> {
  try {
    const actual = await bounded(input.inspectProcess(expected.pid), Date.now() + 2_000);
    return !!actual && identityMatches(expected, actual);
  }
  catch { return false; }
}

async function readMarkerBounded(store: OwnerReadyMarkerStore, deadline: number): Promise<OwnerReadyMarker> {
  return bounded(store.read(), deadline);
}

async function writeMarker(filename: string, marker: OwnerReadyMarker): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(marker), 'utf8');
  if (bytes.byteLength > 2048) throw new Error('reader_owner_marker_invalid');
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function fileIdentity(filename: string): Promise<string> {
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('reader_owner_marker_invalid');
  return statIdentity(info);
}

function statIdentity(info: { dev: bigint; ino: bigint }): string {
  if (info.dev <= 0n || info.ino <= 0n) throw new Error('reader_owner_identity_unavailable');
  return `${info.dev}:${info.ino}`;
}

async function directoryChainIdentity(directory: string): Promise<readonly string[]> {
  const absolute = path.resolve(directory);
  const chain: string[] = [];
  let current = absolute;
  for (;;) {
    const info = await lstat(current, { bigint: true }).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('reader_owner_directory_invalid');
    chain.push(`${current.toLowerCase()}=${statIdentity(info)}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

function sameIdentityChain(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function isOwnerMarker(value: unknown, requestId: string): value is OwnerReadyMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const provisionalKeys = ['bridgeImageSha256', 'deadlineUnixMs', 'mainImageSha256', 'mainPid', 'mainStartedAt', 'phase', 'requestId', 'version'];
  const ownedKeys = [...provisionalKeys, 'childImagePath', 'childPid', 'childStartedAt'].sort();
  const actual = Object.keys(marker).sort();
  if (marker.version !== 1 || marker.requestId !== requestId || !Number.isSafeInteger(marker.mainPid) || Number(marker.mainPid) < 1 ||
      typeof marker.mainStartedAt !== 'string' || !/^\d{15,20}$/.test(marker.mainStartedAt) ||
      !isSha256(String(marker.mainImageSha256)) || !isSha256(String(marker.bridgeImageSha256)) ||
      !Number.isSafeInteger(marker.deadlineUnixMs) || Number(marker.deadlineUnixMs) <= 0) return false;
  if (marker.phase === 'provisional') return actual.join(',') === [...provisionalKeys].sort().join(',');
  return marker.phase === 'owned' && actual.join(',') === ownedKeys.join(',') &&
    Number.isSafeInteger(marker.childPid) && Number(marker.childPid) > 0 &&
    typeof marker.childStartedAt === 'string' && /^\d{15,20}$/.test(marker.childStartedAt) && validImagePath(String(marker.childImagePath));
}

async function bounded<T>(promise: Promise<T>, deadlineUnixMs: number, signal?: AbortSignal): Promise<T> {
  const remaining = Math.min(deadlineUnixMs - Date.now(), 2_147_483_647);
  if (remaining <= 0) throw new Error('reader_deadline_exceeded');
  if (signal?.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : 'reader_cancelled');
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('reader_deadline_exceeded')), remaining);
    if (signal) {
      abort = () => reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'reader_cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    }
  });
  try { return await Promise.race([promise, stopped]); }
  finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abort) signal.removeEventListener('abort', abort);
    void promise.catch(() => undefined);
  }
}
