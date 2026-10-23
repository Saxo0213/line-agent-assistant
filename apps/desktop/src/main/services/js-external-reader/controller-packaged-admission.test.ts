import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FRAME_LIMITS, FrameDecoder, encodeFrame } from './protocol.js';
import { JsExternalReaderController } from './controller.js';
import { mainExternalSourceProbeAdmission } from '../external-source-probe-admission.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const bundlePath = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'controller.mjs');
type CandidateModule = { JsExternalReaderController: typeof JsExternalReaderController };
let PackagedController: CandidateModule['JsExternalReaderController'];

function frame(requestId: string, sequence: number, type: string, fields: Record<string, unknown> = {}): Buffer {
  return encodeFrame({ version: 1, requestId, sequence, type, ...fields } as never, FRAME_LIMITS.pageBytes);
}

function fakeBridge(requestId: string, source: boolean, holdInventory = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: null; pid: number; exitCode: number | null;
    signalCode: NodeJS.Signals | null; kill: () => boolean;
  };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = null;
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  const decoder = new FrameDecoder(FRAME_LIMITS.pageBytes);
  let releaseInventory!: () => void;
  const inventoryReady = new Promise<void>((resolve) => { releaseInventory = resolve; });
  const finish = (code: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    child.emit('close', code, null);
  };
  child.kill = () => { finish(1); return true; };
  child.stdin.on('finish', () => finish(0));
  child.stdin.on('data', (chunk: Buffer) => {
    const requests = decoder.push(chunk) as Array<{ type: string }>;
    for (const request of requests) {
      if (request.type === 'init') {
        void (async () => {
          if (holdInventory) await inventoryReady;
          child.stdout.write(frame(requestId, 2, 'inventory', source
            ? { candidateCount: 1, processCount: 1, edbMiB: [1], walMiB: [1] }
            : { candidateCount: 0, processCount: 0, edbMiB: [], walMiB: [] }));
        })();
      } else if (request.type === 'verify') {
        child.stdout.write(frame(requestId, 3, 'ready', { keyValidated: true, identityMatched: true, mappingVersion: 'line-profile-mid-v1' }));
      } else if (request.type === 'next') {
        const digest = createHash('sha256').update(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])).digest('hex');
        child.stdout.write(frame(requestId, 4, 'page', { pageNumber: 1, batchDigest: digest, hasMore: false, rows: [],
          diagnostic: 'step|0|0|sqlite=3.45.2|cipher=SQLite3 Multiple Ciphers 2.5.1|readonly=1|open_flags=1|key_order=open,cipher,wal_settings,key' }));
      } else if (request.type === 'close') {
        child.stdout.write(frame(requestId, source ? 5 : 3, 'closed', { sourceAccessed: source }));
        child.stdin.end();
      }
    }
  });
  queueMicrotask(() => child.stdout.write(frame(requestId, 1, 'hello', { bridgeVersion: 'candidate-reader-0.2.0', capability: 'fixed_readonly_verify' })));
  return { child: child as never, releaseInventory };
}

describe('packaged JS controller shares Main source admission', () => {
  beforeAll(async () => {
    buildDesktopScript(desktopRoot, 'build-js-external-reader.mjs');
    const loaded = await import(`${pathToFileURL(bundlePath).href}?test=${randomUUID()}`) as CandidateModule;
    PackagedController = loaded.JsExternalReaderController;
  });

  it('blocks both directions and releases admission after cooperative cancellation', async () => {
    const requestId = randomUUID().replaceAll('-', '');
    const { child, releaseInventory } = fakeBridge(requestId, false, true);
    const spawnMock = vi.fn(() => child as never) as unknown as typeof spawn;
    const controller = new PackagedController(mainExternalSourceProbeAdmission, spawnMock);
    const mainRelease = await mainExternalSourceProbeAdmission.acquire();
    const firstWait = new AbortController();
    const firstWaiting = expect(controller.openNoEdbFixture({ bridgePath: 'unused', requestId, expectedMid: 'fixture-own-mid',
      deadlineUnixMs: Date.now() + 10_000, signal: firstWait.signal })).rejects.toThrow('wait_cancelled');
    firstWait.abort(new Error('wait_cancelled'));
    await firstWaiting;
    expect(spawnMock).not.toHaveBeenCalled();
    mainRelease();
    const abort = new AbortController();
    const pending = controller.openNoEdbFixture({ bridgePath: path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'ExternalReaderBridge.exe'),
      requestId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 10_000, signal: abort.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(mainExternalSourceProbeAdmission.isBusy()).toBe(true);
    const secondController = new PackagedController(mainExternalSourceProbeAdmission, spawnMock);
    const secondWait = new AbortController();
    const secondWaiting = expect(secondController.openNoEdbFixture({ bridgePath: 'unused', requestId: randomUUID().replaceAll('-', ''),
      expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 10_000, signal: secondWait.signal })).rejects.toThrow('wait_cancelled');
    secondWait.abort(new Error('wait_cancelled'));
    await secondWaiting;
    abort.abort();
    releaseInventory();
    await expect(pending).rejects.toThrow('reader_cancelled');
    expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
  });

  it('keeps Main admission fenced while a cancelled page consumer remains unsettled', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-admission-'));
    let settleConsumer!: () => void;
    let pendingOutcome: Promise<{ kind: 'resolved' } | { kind: 'rejected'; error: unknown }> | undefined;
    const abort = new AbortController();
    try {
      const requestId = randomUUID().replaceAll('-', '');
      const bridgePath = path.join(fixtureRoot, 'ExternalReaderBridgeSourceTest.exe');
      await writeFile(bridgePath, 'synthetic test placeholder');
      const { child } = fakeBridge(requestId, true);
      const spawnMock = vi.fn(() => child as never) as unknown as typeof spawn;
      const controller = new PackagedController(mainExternalSourceProbeAdmission, spawnMock);
      let onPageStarted!: () => void;
      const pageStarted = new Promise<void>((resolve) => { onPageStarted = resolve; });
      const consumer = new Promise<void>((resolve) => { settleConsumer = resolve; });
      const pending = controller.readFixtureSourcePages({ bridgePath, fixtureRoot, fixtureProcessId: 12345,
        requestId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 10_000, signal: abort.signal,
        onPage: () => { onPageStarted(); return consumer; } });
      pendingOutcome = pending.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      const started = await Promise.race([
        pageStarted.then(() => true),
        pendingOutcome.then(() => false),
      ]);
      expect(started).toBe(true);
      abort.abort();
      const outcome = await pendingOutcome;
      expect(outcome?.kind).toBe('rejected');
      if (outcome?.kind === 'rejected') expect(String(outcome.error)).toContain('reader_cleanup_uncertain');
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(true);
      const waitAbort = new AbortController();
      const waiting = mainExternalSourceProbeAdmission.acquire(waitAbort.signal);
      waitAbort.abort(new Error('wait_cancelled'));
      await expect(waiting).rejects.toThrow('wait_cancelled');
    } finally {
      abort.abort();
      settleConsumer?.();
      if (pendingOutcome) await pendingOutcome;
      try {
        if (mainExternalSourceProbeAdmission.isBusy()) {
          await vi.waitFor(() => expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false));
        }
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  });
});
