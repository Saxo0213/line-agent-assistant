import { lstat, opendir, readFile, rmdir, unlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { isOwnerReadyMarker, sameOwnerReadyMarker, type OwnerReadyMarker } from './owner-ready-session.js';

export type ProcessLiveness = Readonly<{ kind: 'absent' } | { kind: 'present'; startedAt: string } | { kind: 'unknown' }>;

type DirectoryIdentity = Readonly<{ path: string; identity: string }>;
type DirectoryHandle = Readonly<{ read(): Promise<Dirent | null>; close(): Promise<void> }>;
export type ReconciliationFilesystem = Readonly<{
  lstat: typeof lstat;
  opendir(directory: string, options?: { bufferSize?: number }): Promise<DirectoryHandle>;
  readFile: typeof readFile;
  rmdir: typeof rmdir;
  unlink: typeof unlink;
}>;

export async function reconcileStaleOwnerMarkers(input: Readonly<{
  requestRoot: string;
  deadlineUnixMs: number;
  signal: AbortSignal;
  ensurePrivateRoot(): Promise<void>;
  queryProcess(pid: number): Promise<ProcessLiveness>;
  trackSettlement(settlement: Promise<unknown>): void;
  filesystem?: ReconciliationFilesystem;
  now?: () => number;
}>): Promise<void> {
  if (!path.isAbsolute(input.requestRoot) || !Number.isSafeInteger(input.deadlineUnixMs)) throw new Error('reader_request_root_invalid');
  const now = input.now ?? Date.now;
  const fs = input.filesystem ?? { lstat, opendir, readFile, rmdir, unlink };
  const run = async <T>(start: () => Promise<T>, lateCleanup?: (value: T) => Promise<void>): Promise<T> => {
    input.signal.throwIfAborted();
    const remaining = Math.min(input.deadlineUnixMs - now(), 2_147_483_647);
    if (remaining <= 0) throw new Error('reader_deadline_exceeded');
    let abandoned = false;
    const work = Promise.resolve().then(() => {
      input.signal.throwIfAborted();
      if (now() >= input.deadlineUnixMs) throw new Error('reader_deadline_exceeded');
      return start();
    });
    input.trackSettlement(work);
    if (lateCleanup) {
      const settlement = work.then(async (value) => { if (abandoned) await lateCleanup(value); }, () => undefined);
      input.trackSettlement(settlement);
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abandoned = true; reject(new Error('reader_deadline_exceeded')); }, remaining);
      onAbort = () => { abandoned = true; reject(new Error('reader_cancelled')); };
      input.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([work, stopped]); }
    finally {
      if (timer) clearTimeout(timer);
      if (onAbort) input.signal.removeEventListener('abort', onAbort);
      void work.catch(() => undefined);
    }
  };
  const runCleanup = async <T>(start: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(start);
    input.trackSettlement(work);
    const remaining = Math.min(input.deadlineUnixMs - now(), 2_147_483_647);
    if (remaining <= 0) throw new Error('reader_deadline_exceeded');
    let timer: NodeJS.Timeout | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('reader_deadline_exceeded')), remaining);
    });
    try { return await Promise.race([work, stopped]); }
    finally { if (timer) clearTimeout(timer); void work.catch(() => undefined); }
  };
  input.signal.throwIfAborted();
  await run(() => input.ensurePrivateRoot());
  const root = path.resolve(input.requestRoot);
  const rootIdentity = await directoryChain(root, run, fs);
  const entries = await directEntries(root, run, runCleanup, fs);
  if (entries.length > 8) throw new Error('reader_stale_inventory_limit');
  for (const name of entries) {
    input.signal.throwIfAborted();
    if (!/^probe-[a-f0-9]{32}$/.test(name)) throw new Error('reader_stale_entry_unknown');
    const requestId = name.slice('probe-'.length);
    const directoryPath = path.join(root, name);
    const directoryInfo = await run(() => fs.lstat(directoryPath, { bigint: true }));
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('reader_stale_entry_unknown');
    const directoryIdentity = statIdentity(directoryInfo);
    const children = await directEntries(directoryPath, run, runCleanup, fs);
    if (children.length === 0) {
      await verifyRoot(rootIdentity, root, run, fs);
      await verifyDirectory(directoryPath, directoryIdentity, run, fs);
      await run(() => fs.rmdir(directoryPath));
      continue;
    }
    if (children.length !== 1 || children[0] !== 'owner.json') throw new Error('reader_stale_entry_unknown');
    const markerPath = path.join(directoryPath, 'owner.json');
    const markerInfo = await run(() => fs.lstat(markerPath, { bigint: true }));
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size < 2n || markerInfo.size > 2048n) {
      throw new Error('reader_stale_marker_invalid');
    }
    const markerIdentity = statIdentity(markerInfo);
    const bytes = await run(() => fs.readFile(markerPath));
    const markerInfoAfterRead = await run(() => fs.lstat(markerPath, { bigint: true }));
    if (statIdentity(markerInfoAfterRead) !== markerIdentity || markerInfoAfterRead.size !== markerInfo.size) {
      throw new Error('reader_stale_marker_changed');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('reader_stale_marker_invalid'); }
    if (!isOwnerReadyMarker(parsed, requestId)) throw new Error('reader_stale_marker_invalid');
    await requireDead(parsed, input.queryProcess, run, now);
    await verifyRoot(rootIdentity, root, run, fs);
    await verifyDirectory(directoryPath, directoryIdentity, run, fs);
    const currentMarkerInfo = await run(() => fs.lstat(markerPath, { bigint: true }));
    if (!currentMarkerInfo.isFile() || currentMarkerInfo.isSymbolicLink() || currentMarkerInfo.size < 2n || currentMarkerInfo.size > 2048n ||
        statIdentity(currentMarkerInfo) !== markerIdentity) {
      throw new Error('reader_stale_marker_changed');
    }
    const currentBytes = await run(() => fs.readFile(markerPath));
    let current: unknown;
    try { current = JSON.parse(currentBytes.toString('utf8')); }
    catch { throw new Error('reader_stale_marker_changed'); }
    if (!isOwnerReadyMarker(current, requestId) || !sameOwnerReadyMarker(parsed, current)) throw new Error('reader_stale_marker_changed');
    await run(() => fs.unlink(markerPath));
    await verifyRoot(rootIdentity, root, run, fs);
    await verifyDirectory(directoryPath, directoryIdentity, run, fs);
    if ((await directEntries(directoryPath, run, runCleanup, fs)).length !== 0) throw new Error('reader_stale_entry_unknown');
    await run(() => fs.rmdir(directoryPath));
  }
}

async function requireDead(marker: OwnerReadyMarker,
  query: (pid: number) => Promise<ProcessLiveness>, run: <T>(start: () => Promise<T>) => Promise<T>, now: () => number): Promise<void> {
  if (marker.phase === 'provisional' && marker.deadlineUnixMs > now()) throw new Error('reader_stale_provisional_not_expired');
  const identities = marker.phase === 'owned'
    ? [{ pid: marker.mainPid, startedAt: marker.mainStartedAt }, { pid: marker.childPid, startedAt: marker.childStartedAt }]
    : [{ pid: marker.mainPid, startedAt: marker.mainStartedAt }];
  for (const owner of identities) {
    const status = await run(() => query(owner.pid));
    if (status.kind === 'unknown') throw new Error('reader_stale_owner_unknown');
    if (status.kind === 'present' && status.startedAt === owner.startedAt) throw new Error('reader_stale_owner_live');
    if (status.kind === 'present' && !/^\d{15,20}$/.test(status.startedAt)) throw new Error('reader_stale_owner_unknown');
  }
}

async function directEntries(directory: string, run: <T>(start: () => Promise<T>, lateCleanup?: (value: T) => Promise<void>) => Promise<T>,
  runCleanup: <T>(start: () => Promise<T>) => Promise<T>, fs: ReconciliationFilesystem): Promise<string[]> {
  const opened = await run(() => fs.opendir(directory, { bufferSize: 4 }), (late) => runCleanup(() => late.close()));
  try {
    const names: string[] = [];
    for (;;) {
      const entry = await run(() => opened.read());
      if (!entry) return names;
      names.push(entry.name);
      if (names.length > 8) return names;
    }
  } finally { await runCleanup(() => opened.close()); }
}

async function directoryChain(directory: string, run: <T>(start: () => Promise<T>) => Promise<T>,
  fs: ReconciliationFilesystem): Promise<readonly DirectoryIdentity[]> {
  const chain: DirectoryIdentity[] = [];
  let current = path.resolve(directory);
  for (;;) {
    const info = await run(() => fs.lstat(current, { bigint: true }));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('reader_request_root_invalid');
    chain.push({ path: current, identity: statIdentity(info) });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

async function verifyRoot(expected: readonly DirectoryIdentity[], root: string,
  run: <T>(start: () => Promise<T>) => Promise<T>, fs: ReconciliationFilesystem): Promise<void> {
  const actual = await directoryChain(root, run, fs);
  if (actual.length !== expected.length || actual.some((item, index) =>
    !samePath(item.path, expected[index]!.path) || item.identity !== expected[index]!.identity)) {
    throw new Error('reader_request_root_changed');
  }
}

async function verifyDirectory(directory: string, identity: string,
  run: <T>(start: () => Promise<T>) => Promise<T>, fs: ReconciliationFilesystem): Promise<void> {
  const info = await run(() => fs.lstat(directory, { bigint: true }));
  if (!info.isDirectory() || info.isSymbolicLink() || statIdentity(info) !== identity) throw new Error('reader_stale_entry_changed');
}

function statIdentity(info: { dev: bigint; ino: bigint }): string {
  if (info.dev <= 0n || info.ino <= 0n) throw new Error('reader_owner_identity_unavailable');
  return `${info.dev}:${info.ino}`;
}

function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
