import { lstat as fsLstat, mkdir, mkdtemp, opendir as fsOpendir, readFile, readFile as fsReadFile, readdir, rmdir as fsRmdir, rename, rm,
  symlink, unlink as fsUnlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { ExternalMonitorDiagnosticFailure } from '../external-monitor-diagnostics.js';
import { reconcileStaleOwnerMarkers, type ReconciliationFilesystem } from './stale-owner-marker-reconciliation.js';
import {
  runOwnerReadySession,
  FileOwnerReadyMarkerStore,
  type OwnerReadyMarkerStore,
  type OwnerReadyChild,
  type OwnerProcessIdentity,
  type OwnerReadyMarker,
} from './owner-ready-session.js';

const mainIdentity: OwnerProcessIdentity = {
  pid: 111,
  startedAt: '134000000000000001',
  imagePath: 'C:\\synthetic\\line-agent.exe',
  imageSha256: 'a'.repeat(64),
};
const childIdentity: OwnerProcessIdentity = {
  pid: 222,
  startedAt: '134000000000000002',
  imagePath: 'C:\\synthetic\\ExternalReaderBridge.exe',
  imageSha256: 'b'.repeat(64),
};
let roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

describe('owner-ready request lifecycle', () => {
  it.each(['spawn', 'inspection', 'marker-read', 'marker-promotion', 'late-identity', 'handshake'] as const)(
    'reports the active phase and preserves the primary %s failure through cleanup', async (failure) => {
      const root = await makeRoot();
      const requestId = '7'.repeat(32);
      const baseStore = markerStore(root, requestId);
      const child = fakeChild();
      const admission = new ExternalSourceProbeAdmissionGate();
      let currentPhase: string | undefined;
      let inspectionCount = 0;
      const phases = {
        spawn: 'child_identity', inspection: 'child_identity', 'marker-read': 'owner_admission_marker',
        'marker-promotion': 'owner_admission_marker', 'late-identity': 'child_identity', handshake: 'protocol_source_ready',
      } as const;
      const store: OwnerReadyMarkerStore = failure === 'marker-read'
        ? { ...baseStore, async read() { throw new Error('primary_marker_read_failure'); } }
        : failure === 'marker-promotion'
          ? { ...baseStore, async promote() { throw new Error('primary_marker_promotion_failure'); } }
          : baseStore;
      if (failure === 'handshake') child.sendOwnerReady = async () => { throw new Error('primary_handshake_failure'); };
      const expectedError = {
        spawn: 'primary_spawn_failure', inspection: 'primary_inspection_failure', 'marker-read': 'primary_marker_read_failure',
        'marker-promotion': 'primary_marker_promotion_failure', 'late-identity': 'reader_child_identity_changed',
        handshake: 'primary_handshake_failure',
      }[failure];
      const spawnChild = () => {
        if (failure === 'spawn') throw new Error(expectedError);
        return child;
      };
      const inspectProcess = async () => {
        inspectionCount += 1;
        if (failure === 'inspection' && inspectionCount === 1) throw new Error(expectedError);
        if (failure === 'late-identity' && inspectionCount === 3) return { ...childIdentity, startedAt: '134000000000000099' };
        return childIdentity;
      };
      await expect(runOwnerReadySession({
        requestRoot: root, requestId, deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, bridgeImagePath: childIdentity.imagePath, bridgeImageSha256: childIdentity.imageSha256,
        admission, markerStore: store, spawnChild, inspectProcess,
        runAfterReady: async () => undefined,
        onPhase(phase) { currentPhase = phase; },
      })).rejects.toThrow(expectedError);
      expect(currentPhase).toBe(phases[failure]);
      if (failure === 'marker-read') {
        expect(await baseStore.exists()).toBe(true);
        expect(admission.isBusy()).toBe(true);
      } else {
        expect(await baseStore.exists()).toBe(false);
        expect(admission.isBusy()).toBe(false);
      }
    });

  it('provisions an absent private request root before owner marker creation and removes the current request after close', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'linejs-owner-ready-fresh-'));
    roots.push(parent);
    const root = path.join(parent, 'new-request-root');
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = '1'.repeat(32);
    const store = markerStore(root, requestId);
    await expect(fsLstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const order: string[] = [];
    const child = fakeChild();
    await runOwnerReadySession({
      requestRoot: root, requestId, deadlineUnixMs: Date.now() + 5_000,
      mainIdentity, bridgeImagePath: childIdentity.imagePath, bridgeImageSha256: childIdentity.imageSha256,
      admission, markerStore: store,
      beforeCreate: async ({ signal, deadlineUnixMs, trackSettlement }) => {
        order.push('prepare');
        expect(admission.isBusy()).toBe(true);
        expect(signal.aborted).toBe(false);
        expect(deadlineUnixMs).toBeGreaterThan(Date.now());
        expect(trackSettlement).toBeTypeOf('function');
        expect(await store.exists()).toBe(false);
        await mkdir(root, { recursive: true });
        await ensurePrivateDirectory(root);
        expect(await readdir(root)).toEqual([]);
      },
      spawnChild: () => { order.push('spawn'); return child; },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => { order.push('work'); },
    });
    expect(order).toEqual(['prepare', 'spawn', 'work']);
    expect(admission.isBusy()).toBe(false);
    expect(await store.exists()).toBe(false);
  });

  it('admits a fresh request beside an untouched stale directory without startup reconciliation', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'linejs-owner-ready-stale-'));
    roots.push(parent);
    const root = path.join(parent, 'request-root');
    const staleDirectory = path.join(root, `probe-${'a'.repeat(32)}`);
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, 'owner.json'), 'stale marker');
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = 'b'.repeat(32);
    const store = markerStore(root, requestId);
    await runOwnerReadySession({
      requestRoot: root, requestId, deadlineUnixMs: Date.now() + 5_000,
      mainIdentity, bridgeImagePath: childIdentity.imagePath, bridgeImageSha256: childIdentity.imageSha256,
      admission, markerStore: store,
      beforeCreate: async ({ signal }) => {
        expect(admission.isBusy()).toBe(true);
        expect(signal.aborted).toBe(false);
        await ensurePrivateDirectory(root);
      },
      spawnChild: fakeChild,
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
    });
    expect(admission.isBusy()).toBe(false);
    expect(await store.exists()).toBe(false);
    expect(await readFile(path.join(staleDirectory, 'owner.json'), 'utf8')).toBe('stale marker');
  });

  it('keeps admission closed after preparation times out until the late operation actually settles', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = '2'.repeat(32);
    const store = markerStore(root, requestId);
    let settlePreparation!: () => void;
    let spawnCount = 0;
    const pending = runOwnerReadySession({
      requestRoot: root, requestId, deadlineUnixMs: Date.now() + 25, closeTimeoutMs: 20,
      mainIdentity, bridgeImagePath: childIdentity.imagePath, bridgeImageSha256: childIdentity.imageSha256,
      admission, markerStore: store,
      beforeCreate: ({ trackSettlement }) => {
        const operation = new Promise<void>((resolve) => { settlePreparation = resolve; });
        trackSettlement(operation);
        return operation;
      },
      spawnChild: () => { spawnCount += 1; return fakeChild(); },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
    });
    await expect(pending).rejects.toThrow('reader_deadline_exceeded');
    expect(admission.isBusy()).toBe(true);
    expect(spawnCount).toBe(0);
    expect(await store.exists()).toBe(false);
    const waitAbort = new AbortController();
    const waiting = admission.acquire(waitAbort.signal);
    waitAbort.abort(new Error('wait_cancelled'));
    await expect(waiting).rejects.toThrow('wait_cancelled');
    settlePreparation();
    await vi.waitFor(() => expect(admission.isBusy()).toBe(false));
  });

  it('closes a directory handle returned after deadline and holds admission through the delayed close', async () => {
    const root = await makeRoot();
    const requestId = '3'.repeat(32);
    const abort = new AbortController();
    const openStarted = deferred<void>();
    const releaseOpen = deferred<void>();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    let spawnCount = 0;
    const filesystem: ReconciliationFilesystem = {
      lstat: fsLstat, readFile: fsReadFile, rmdir: fsRmdir, unlink: fsUnlink,
      async opendir(directory, options) {
        openStarted.resolve();
        await releaseOpen.promise;
        const opened = await fsOpendir(directory, options);
        return {
          read: () => opened.read(),
          async close() { closeStarted.resolve(); await releaseClose.promise; await opened.close(); },
        };
      },
    };
    const session = startReconciliationSession(root, requestId, abort, filesystem, () => { spawnCount += 1; return fakeChild(); }, undefined, 100);
    await openStarted.promise;
    await expect(session.promise).rejects.toThrow('reader_deadline_exceeded');
    expect(session.admission.isBusy()).toBe(true);
    expect(spawnCount).toBe(0);
    releaseOpen.resolve();
    await closeStarted.promise;
    expect(session.admission.isBusy()).toBe(true);
    releaseClose.resolve();
    await vi.waitFor(() => expect(session.admission.isBusy()).toBe(false));
  });

  it('holds admission until a delayed directory read and its close both settle', async () => {
    const root = await makeRoot();
    const requestId = '4'.repeat(32);
    const abort = new AbortController();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    let spawnCount = 0;
    const filesystem: ReconciliationFilesystem = {
      lstat: fsLstat, readFile: fsReadFile, rmdir: fsRmdir, unlink: fsUnlink,
      async opendir(directory, options) {
        const opened = await fsOpendir(directory, options);
        return {
          async read() { readStarted.resolve(); await releaseRead.promise; return opened.read(); },
          async close() { closeStarted.resolve(); await releaseClose.promise; await opened.close(); },
        };
      },
    };
    const session = startReconciliationSession(root, requestId, abort, filesystem, () => { spawnCount += 1; return fakeChild(); });
    await readStarted.promise;
    abort.abort();
    await expect(session.promise).rejects.toThrow(/abort|cancel/i);
    expect(session.admission.isBusy()).toBe(true);
    expect(spawnCount).toBe(0);
    releaseRead.resolve();
    await closeStarted.promise;
    expect(session.admission.isBusy()).toBe(true);
    releaseClose.resolve();
    await vi.waitFor(() => expect(session.admission.isBusy()).toBe(false));
  });

  it.each(['unlink', 'rmdir'] as const)('does not start a following mutation after cancellation during delayed %s and retains admission until settlement', async (operation) => {
    const root = await makeRoot();
    const requestId = operation === 'unlink' ? '5'.repeat(32) : '6'.repeat(32);
    const requestDirectory = path.join(root, `probe-${requestId}`);
    await mkdir(requestDirectory);
    if (operation === 'unlink') {
      await writeFile(path.join(requestDirectory, 'owner.json'), JSON.stringify({ version: 1, phase: 'owned', requestId,
        mainPid: mainIdentity.pid, mainStartedAt: mainIdentity.startedAt, mainImageSha256: mainIdentity.imageSha256,
        bridgeImageSha256: childIdentity.imageSha256, deadlineUnixMs: Date.now() - 100, childPid: childIdentity.pid,
        childStartedAt: childIdentity.startedAt, childImagePath: childIdentity.imagePath }));
    }
    const abort = new AbortController();
    const mutationStarted = deferred<void>();
    const releaseMutation = deferred<void>();
    let nextMutationCalls = 0;
    let spawnCount = 0;
    const filesystem: ReconciliationFilesystem = {
      lstat: fsLstat, opendir: fsOpendir, readFile: fsReadFile,
      async unlink(filename) {
        if (operation !== 'unlink') return fsUnlink(filename);
        mutationStarted.resolve();
        await releaseMutation.promise;
        if (abort.signal.aborted) throw new Error('cancelled_before_unlink');
        return fsUnlink(filename);
      },
      async rmdir(directory) {
        if (operation === 'unlink' && directory === requestDirectory) nextMutationCalls += 1;
        if (operation !== 'rmdir' || directory !== requestDirectory) return fsRmdir(directory);
        mutationStarted.resolve();
        await releaseMutation.promise;
        if (abort.signal.aborted) throw new Error('cancelled_before_rmdir');
        return fsRmdir(directory);
      },
    };
    const session = startReconciliationSession(root, requestId, abort, filesystem, () => { spawnCount += 1; return fakeChild(); },
      async () => ({ kind: 'absent' }));
    await mutationStarted.promise;
    abort.abort();
    await expect(session.promise).rejects.toThrow(/abort|cancel/i);
    expect(session.admission.isBusy()).toBe(true);
    expect(spawnCount).toBe(0);
    releaseMutation.resolve();
    await vi.waitFor(() => expect(session.admission.isBusy()).toBe(false));
    expect(nextMutationCalls).toBe(0);
    if (operation === 'unlink') expect(await readdir(requestDirectory)).toEqual(['owner.json']);
    else expect(await readdir(root)).toContain(path.basename(requestDirectory));
  });

  it('keeps the immutable work deadline after the preparation budget', async () => {
    const root = await makeRoot();
    const requestId = '9'.repeat(32);
    const store = markerStore(root, requestId);
    const absoluteDeadline = Date.now() + 120_000;
    let observedDeadline = 0;
    await runOwnerReadySession({
      requestRoot: root, requestId, deadlineUnixMs: absoluteDeadline,
      mainIdentity, bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission: new ExternalSourceProbeAdmissionGate(), markerStore: store,
      spawnChild: () => fakeChild(), inspectProcess: async () => childIdentity,
      runAfterReady: async ({ marker }) => { observedDeadline = marker.deadlineUnixMs; },
    });
    expect(observedDeadline).toBe(absoluteDeadline);
  });
  it('promotes the provisional marker after child identity checks and before owner-ready/source work', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = 'a'.repeat(32);
    const store = markerStore(root, requestId);
    const order: string[] = [];
    const child = fakeChild(() => {
      expect(order.at(-1)).toBe(`inspect:${childIdentity.pid}`);
      order.push('owner-ready');
    });
    const outcome = await runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => { order.push('spawn'); return child; },
      inspectProcess: async (pid) => { order.push(`inspect:${pid}`); return pid === childIdentity.pid ? childIdentity : mainIdentity; },
      runAfterReady: async ({ marker }) => {
        order.push('source-work');
        expect(marker.phase).toBe('owned');
        expect(admission.isBusy()).toBe(true);
        return 'done';
      },
    });
    expect(outcome).toBe('done');
    expect(order.indexOf('source-work')).toBeGreaterThan(order.indexOf('owner-ready'));
    expect(order.filter((event) => event === `inspect:${childIdentity.pid}`).length).toBeGreaterThanOrEqual(2);
    expect(admission.isBusy()).toBe(false);
    expect(child.ownerReadyCount).toBe(1);
    expect(await store.exists()).toBe(false);
  });

  it.each(['missing', 'corrupt', 'pid', 'start', 'image'] as const)('fails closed for %s ownership', async (failure) => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = 'c'.repeat(32);
    const store = markerStore(root, requestId);
    const child = fakeChild();
    let sourceWork = 0;
    if (failure === 'missing') store.dropOnPromote = true;
    if (failure === 'corrupt') store.corruptOnPromote = true;
    const inspected = failure === 'pid' ? { ...childIdentity, pid: 223 }
      : failure === 'start' ? childIdentity
        : failure === 'image' ? { ...childIdentity, imagePath: 'C:\\synthetic\\other.exe' }
          : childIdentity;
    let inspectionCount = 0;
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => child,
      inspectProcess: async () => {
        inspectionCount += 1;
        return failure === 'start' && inspectionCount > 1
          ? { ...childIdentity, startedAt: '134000000000000099' }
          : inspected;
      },
      runAfterReady: async () => { sourceWork += 1; },
    })).rejects.toThrow();
    expect(sourceWork).toBe(0);
    expect(child.ownerReadyCount).toBe(0);
    expect(admission.isBusy()).toBe(failure === 'missing' || failure === 'corrupt');
  });

  it('closes on parent cancellation or child EOF before readiness without entering source work', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const child = fakeChild();
    const abort = new AbortController();
    let sourceWork = 0;
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId: 'd'.repeat(32),
      deadlineUnixMs: Date.now() + 5_000,
      signal: abort.signal,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, 'd'.repeat(32)),
      spawnChild: () => { abort.abort(); return child; },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => { sourceWork += 1; },
    })).rejects.toThrow(/cancel|abort/i);
    expect(sourceWork).toBe(0);
    expect(child.closed).toBe(true);
    expect(admission.isBusy()).toBe(false);

    const eofChild = fakeChild();
    eofChild.alive = false;
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId: 'e'.repeat(32),
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, 'e'.repeat(32)),
      spawnChild: () => eofChild,
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => { sourceWork += 1; },
    })).rejects.toThrow(/closed|eof/i);
    expect(sourceWork).toBe(0);
    expect(admission.isBusy()).toBe(false);
  });

  it('closes and fences work at the absolute deadline', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const child = fakeChild();
    let sourceWork = 0;
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId: 'f'.repeat(32),
      // The session rejects an already expired deadline before spawning, so leave room for a stalled event loop
      // between computing it and starting; the inspection still outlasts the deadline by 4x.
      deadlineUnixMs: Date.now() + 250,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, 'f'.repeat(32)),
      spawnChild: () => child,
      inspectProcess: async () => new Promise((resolve) => setTimeout(() => resolve(childIdentity), 1000)),
      runAfterReady: async () => { sourceWork += 1; },
    })).rejects.toThrow(/deadline/i);
    expect(sourceWork).toBe(0);
    expect(child.closed).toBe(true);
    expect(admission.isBusy()).toBe(false);
  });

  it('retains the admission fence when child identity changes and shutdown is uncertain', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const child = fakeChild();
    let inspectionCount = 0;
    child.closeInput = async () => undefined;
    child.waitClosed = async () => false;
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId: '9'.repeat(32),
      deadlineUnixMs: Date.now() + 5_000,
      closeTimeoutMs: 20,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, '9'.repeat(32)),
      spawnChild: () => child,
      inspectProcess: async () => {
        inspectionCount += 1;
        return inspectionCount === 1 ? childIdentity : { ...childIdentity, startedAt: '134000000000000099' };
      },
      runAfterReady: async () => { throw new Error('source_work_must_not_run'); },
    })).rejects.toThrow('reader_child_identity_changed');
    expect(child.ownerReadyCount).toBe(0);
    expect(admission.isBusy()).toBe(true);
    expect(await markerStore(root, '9'.repeat(32)).exists()).toBe(true);
  });

  it('retains admission when provisional marker creation outlives the deadline', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const store = markerStore(root, '8'.repeat(32));
    const create = store.create.bind(store);
    store.create = async () => new Promise<void>(() => undefined);
    const spawnChild = () => { throw new Error('child_must_not_spawn'); };
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId: '8'.repeat(32),
      deadlineUnixMs: Date.now() + 20,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild,
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
    })).rejects.toThrow(/deadline/i);
    expect(admission.isBusy()).toBe(true);
    store.create = create;
  });

  it.each(['close', 'kill', 'marker'] as const)('does not report successful work when %s cleanup is uncertain', async (failure) => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = '7'.repeat(32);
    const store = markerStore(root, requestId);
    const child = fakeChild();
    let inspectionCount = 0;
    if (failure === 'close') {
      child.closeInput = async () => { throw new Error('close_failed'); };
      child.waitClosed = async () => false;
      child.kill = async () => { throw new Error('pid_reused'); };
      inspectionCount = 0;
    } else if (failure === 'kill') {
      child.closeInput = async () => undefined;
      child.waitClosed = async () => false;
      child.kill = async () => { throw new Error('kill_failed'); };
    } else {
      store.remove = async () => { throw new Error('marker_remove_failed'); };
    }
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      closeTimeoutMs: 30,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => child,
      inspectProcess: async () => {
        inspectionCount += 1;
        return failure === 'close' && inspectionCount > 4
          ? { ...childIdentity, startedAt: '134000000000000099' }
          : childIdentity;
      },
      runAfterReady: async () => 'work-succeeded',
    })).rejects.toThrow('reader_owner_cleanup_uncertain');
    expect(admission.isBusy()).toBe(true);
  });

  it('preserves the primary operation error when marker cleanup also fails', async () => {
    const root = path.join(os.tmpdir(), 'linejs-owner-ready-cleanup-test');
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = '8'.repeat(32);
    let currentMarker: OwnerReadyMarker | undefined;
    const store: OwnerReadyMarkerStore = {
      requestDirectory: path.join(root, `probe-${requestId}`),
      async create(marker) { currentMarker = marker; },
      async read() { if (!currentMarker) throw new Error('reader_owner_marker_invalid'); return currentMarker; },
      async promote(_expected, next) { currentMarker = next; },
      async remove() { throw new Error('private_cleanup_detail'); },
    };
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => fakeChild(),
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => { throw new Error('reader_page_invalid'); },
    })).rejects.toThrow('reader_page_invalid');
    expect(admission.isBusy()).toBe(true);
  });

  it('does not report success when shared admission release cannot be verified', async () => {
    const root = await makeRoot();
    const stuckRelease = Object.assign(() => undefined, { isCurrentOwner: () => true });
    const admission = { acquire: async () => stuckRelease, isBusy: () => true };
    const requestId = '4'.repeat(32);
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, requestId),
      spawnChild: () => fakeChild(),
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => 'work-succeeded',
    })).rejects.toThrow('reader_owner_cleanup_uncertain');
  });

  it('keeps admission fenced when source work does not settle before cancellation cleanup', async () => {
    const root = await makeRoot();
    const admission = new ExternalSourceProbeAdmissionGate();
    const requestId = '3'.repeat(32);
    const cancellation = new AbortController();
    let beganWork!: () => void;
    const workStarted = new Promise<void>((resolve) => { beganWork = resolve; });
    let settleWork!: () => void;
    const pending = runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      closeTimeoutMs: 20,
      signal: cancellation.signal,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: markerStore(root, requestId),
      spawnChild: () => fakeChild(),
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => { beganWork(); return new Promise<never>((_resolve, reject) => { settleWork = () => reject(new Error('cancelled')); }); },
    });
    const outcome = pending.then(() => null, (error: unknown) => error);
    await workStarted;
    cancellation.abort();
    expect((await outcome as Error).message).toMatch(/abort|cancel/i);
    expect(admission.isBusy()).toBe(true);
    settleWork();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(admission.isBusy()).toBe(false);
  });

  it('rejects a reparse request root before invoking its ACL callback or spawning', async () => {
    const base = await makeRoot();
    const target = path.join(base, 'target');
    const link = path.join(base, 'request-root-link');
    await mkdir(target);
    await symlink(target, link, 'junction');
    const requestId = '6'.repeat(32);
    let aclCalls = 0;
    let spawnCalls = 0;
    const admission = new ExternalSourceProbeAdmissionGate();
    const store = new FileOwnerReadyMarkerStore(link, requestId, async () => { aclCalls += 1; });
    await expect(runOwnerReadySession({
      requestRoot: link,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => { spawnCalls += 1; return fakeChild(); },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
    })).rejects.toThrow('reader_owner_directory_invalid');
    expect(aclCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(admission.isBusy()).toBe(true);
  });

  it('preserves private directory failure from the marker create second ACL pass', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linejs-owner-ready-phase-'));
    roots.push(root);
    const requestId = '4'.repeat(32);
    const admission = new ExternalSourceProbeAdmissionGate();
    const typedFailure = new ExternalMonitorDiagnosticFailure('external_monitor_reader_startup_failed', 'startup',
      'private_directory_acl_command_timeout', 'private_directory_preparation');
    let aclCalls = 0;
    const ensurePrivateDirectory = async () => {
      aclCalls += 1;
      if (aclCalls === 2) throw typedFailure;
    };
    const store = new FileOwnerReadyMarkerStore(root, requestId, ensurePrivateDirectory);
    const phases: string[] = [];
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => { throw new Error('child_must_not_spawn'); },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
      beforeCreate: async () => ensurePrivateDirectory(),
      onPhase: (phase) => phases.push(phase),
    })).rejects.toBe(typedFailure);
    expect(aclCalls).toBe(2);
    expect(phases).toContain('owner_admission_marker');
    expect(typedFailure.phase).toBe('private_directory_preparation');
  });

  it('revalidates request-root identity after ACL callback before spawning', async () => {
    const root = await makeRoot();
    const moved = `${root}-moved`;
    roots.push(moved);
    const requestId = '5'.repeat(32);
    let aclCalls = 0;
    let spawnCalls = 0;
    const admission = new ExternalSourceProbeAdmissionGate();
    const store = new FileOwnerReadyMarkerStore(root, requestId, async () => {
      aclCalls += 1;
      await rename(root, moved);
      await mkdir(root);
    });
    await expect(runOwnerReadySession({
      requestRoot: root,
      requestId,
      deadlineUnixMs: Date.now() + 5_000,
      mainIdentity,
      bridgeImagePath: childIdentity.imagePath,
      bridgeImageSha256: childIdentity.imageSha256,
      admission,
      markerStore: store,
      spawnChild: () => { spawnCalls += 1; return fakeChild(); },
      inspectProcess: async () => childIdentity,
      runAfterReady: async () => undefined,
    })).rejects.toThrow('reader_owner_directory_changed');
    expect(aclCalls).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(admission.isBusy()).toBe(true);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linejs-owner-ready-'));
  roots.push(root);
  await ensurePrivateDirectory(root);
  return root;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function startReconciliationSession(root: string, requestId: string, abort: AbortController,
  filesystem: ReconciliationFilesystem, spawnChild: () => OwnerReadyChild,
  queryProcess: (pid: number) => Promise<{ kind: 'absent' | 'unknown' } | { kind: 'present'; startedAt: string }> = async () => ({ kind: 'absent' }),
  deadlineMs = 5_000) {
  const admission = new ExternalSourceProbeAdmissionGate();
  const promise = runOwnerReadySession({
    requestRoot: root, requestId, deadlineUnixMs: Date.now() + deadlineMs, signal: abort.signal, closeTimeoutMs: 50,
    mainIdentity, bridgeImagePath: childIdentity.imagePath, bridgeImageSha256: childIdentity.imageSha256,
    admission, markerStore: markerStore(root, requestId), spawnChild, inspectProcess: async () => childIdentity,
    beforeCreate: ({ signal, deadlineUnixMs, trackSettlement }) => reconcileStaleOwnerMarkers({
      requestRoot: root, deadlineUnixMs, signal, ensurePrivateRoot: async () => undefined, queryProcess, trackSettlement, filesystem,
    }),
    runAfterReady: async () => undefined,
  });
  return { admission, promise };
}

function markerStore(root: string, requestId: string): OwnerReadyMarkerStore & { dropOnPromote?: boolean; corruptOnPromote?: boolean; exists(): Promise<boolean> } {
  // The request directory inherits the owner and SYSTEM-only ACL installed on
  // this synthetic temp root; the store checks its exact child path and reparse status.
  const store = new FileOwnerReadyMarkerStore(root, requestId, async () => undefined);
  const markerPath = path.join(store.requestDirectory, 'owner.json');
  return {
    requestDirectory: store.requestDirectory,
    create: (marker) => store.create(marker),
    read: () => store.read(),
    async promote(expected, next) {
      await store.promote(expected, next);
      if (this.dropOnPromote) { await rm(markerPath, { force: true }); return; }
      if (this.corruptOnPromote) await writeFile(markerPath, '{');
    },
    remove: (expected) => store.remove(expected),
    async exists() { return await readFile(markerPath).then(() => true, () => false); },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const quoted = `'${directory.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $path=${quoted}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); ` +
    `$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ` +
    `$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'))); ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$inherit,'None','Allow'))); ` +
    `Set-Acl -LiteralPath $path -AclObject $acl; $actual=Get-Acl -LiteralPath $path; ` +
    `if (!$actual.AreAccessRulesProtected -or $actual.Access.Count -ne 2) { throw 'private_directory_acl_invalid' }; 'private'`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
  }).trim();
  if (result !== 'private') throw new Error('owner_directory_not_private');
}

function fakeChild(afterOwnerReady?: () => void): OwnerReadyChild & { ownerReadyCount: number; closed: boolean; alive: boolean } {
  return {
    pid: childIdentity.pid,
    ownerReadyCount: 0,
    closed: false,
    alive: true,
    async sendOwnerReady(requestId: string) { expect(requestId).toMatch(/^[a-f0-9]{32}$/); this.ownerReadyCount += 1; afterOwnerReady?.(); },
    async closeInput() { this.closed = true; this.alive = false; },
    async waitClosed() { return this.closed || !this.alive; },
    async kill() { this.closed = true; this.alive = false; },
    isAlive() { return this.alive; },
  };
}
