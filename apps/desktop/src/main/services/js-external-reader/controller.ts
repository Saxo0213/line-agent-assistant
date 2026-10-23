import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { NativeAttachmentDescriptorSchema, NativeAttachmentMetadataSchema, NativeCatalogRecordSchema, NativeConversationMetadataSchema, NativeDirectoryRowSchema,
  NativeSourceEnvelopeSchema, NativeStickerMetadataSchema, OfficialAuthCandidateSchema } from '@line-agent/contracts';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { FRAME_LIMITS, FrameDecoder, encodeFrame, validateFrameEnvelope, type DirectMonitorPage, type DirectTailWindow, type DirectUnreadCounts, type ImportCatalogPage, type ImportCursor, type ImportDirectoryPage,
  type ImportProgress, type ImportRow, type ImportSnapshotCompletion, type ImportSnapshotMetadata, type ImportSnapshotPage,
  type NativeMonitorAccess, type OfficialIdentity, type ProtocolFrame } from './protocol.js';
import { verifyJsExternalReaderResources } from './resources.js';
import { BuildTrustSession, FAILURE_BUILD_KEYS, INVENTORY_BUILD_KEYS } from './build-trust-session.js';
import type { OfficialBuildTrustPort } from '../official-build-trust.js';
import type { ExternalSourceProbeAdmission } from '../external-source-probe-admission.js';
import {
  runOwnerReadySession,
  type OwnerProcessIdentity,
  type OwnerReadyMarkerStore,
} from './owner-ready-session.js';

export type NoEdbFixtureInventory = Readonly<{
  candidateCount: 0;
  processCount: 0;
  edbMiB: readonly [];
  walMiB: readonly [];
}>;

export type OfficialSourceInventoryVerdict = Readonly<{
  status: 'supported';
  sourceAccessed: true;
  buildCode: 'accepted' | 'candidate';
  buildVersion: string;
  mappingCode: 'line-profile-mid-v1';
  sourceDigest: string;
  liveReadState: 'not_tested';
  /** Number of official `*.edb` candidates seen; only the newest (active) one is ever opened. */
  candidateCount: number;
  processCount: 1;
  edbMiB: readonly [number];
  walMiB: readonly [number];
  /** Present only for `read_official_identity`. */
  identity?: OfficialIdentity;
}> | Readonly<{
  status: 'unsupported';
  sourceAccessed: true;
  errorCode: string;
}>;

export type { OfficialIdentity };
const MAX_OFFICIAL_CANDIDATES = 8;

export type JsExternalReaderFixturePage = Readonly<{
  pageNumber: number;
  batchDigest: string;
  hasMore: boolean;
  rows: readonly string[];
  diagnostic: string;
}>;

type FixtureChild = ChildProcessByStdio<Writable, Readable, null>;
const MAX_QUEUED_CONTROL_FRAMES = 2;
const MAX_QUEUED_CONTROL_BYTES = FRAME_LIMITS.controlBytes * MAX_QUEUED_CONTROL_FRAMES;
const MAX_QUEUED_INVENTORY_RESPONSE_FRAMES = 512;
const FIXTURE_SESSION_MAX_MS = 45_000;
const IMPORT_SESSION_DEADLINE = Date.UTC(9999, 11, 31, 23, 59, 59);
const FIXTURE_CONSUMER_CLEANUP_MS = 1_000;
const SAFE_INVENTORY_ERROR_CODES = new Set([
  'unsupported_build', 'build_rotation', 'candidate_missing', 'candidate_ambiguous', 'candidate_limit', 'process_missing',
  'process_ambiguous', 'process_limit', 'source_reparse_or_type', 'source_changed', 'source_too_large', 'source_io_error',
  'owner_invalid', 'key_unavailable', 'snapshot_hot_journal', 'snapshot_source_changed',
  'snapshot_backup_failed', 'snapshot_backup_init_failed', 'snapshot_backup_no_progress', 'snapshot_source_unavailable',
  'snapshot_key_mismatch', 'snapshot_wal_no_commit', 'snapshot_wal_invalid',
  'snapshot_database_header_invalid', 'snapshot_size_limit', 'mid_or_schema_mismatch',
  'official_account_not_active', 'deadline_invalid', 'protocol_invalid',
  'line_window_ambiguous', 'line_window_close_failed',
  'source_row_invalid', 'source_row_too_large', 'source_conversation_invalid', 'source_schema_unsupported', 'source_result_too_large',
  'cancelled',
]);

export class JsExternalReaderController {
  #active = false;
  readonly #admission: ExternalSourceProbeAdmission;
  readonly #spawn: typeof spawn;

  constructor(admission: ExternalSourceProbeAdmission, spawnBridge: typeof spawn = spawn) {
    if (!admission || typeof admission.acquire !== 'function' || typeof admission.isBusy !== 'function') {
      throw new Error('reader_admission_required');
    }
    this.#admission = admission;
    this.#spawn = spawnBridge;
  }

  async readFixtureSourcePages(input: {
    bridgePath: string;
    fixtureRoot: string;
    fixtureProcessId: number;
    requestId?: string;
    expectedMid: string;
    deadlineUnixMs: number;
    signal?: AbortSignal;
    onPage(page: JsExternalReaderFixturePage, signal?: AbortSignal): Promise<void> | void;
  }): Promise<{ pageCount: number; rowCount: number }> {
    if (this.#active) throw new Error('reader_already_active');
    const requestId = input.requestId ?? randomUUID().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/.test(requestId) || typeof input.expectedMid !== 'string' ||
        input.expectedMid.length < 1 || input.expectedMid.length > 200 || input.expectedMid.includes('\0') ||
        !Number.isSafeInteger(input.fixtureProcessId) || input.fixtureProcessId < 1 || input.fixtureProcessId > 0xffffffff ||
        !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now() || typeof input.onPage !== 'function') {
      throw new Error('reader_request_invalid');
    }
    this.#active = true;
    let releaseSharedAdmission: () => void;
    try {
      releaseSharedAdmission = await this.#admission.acquire(input.signal);
    } catch (error) {
      this.#active = false;
      throw error;
    }
    const sessionAbort = new AbortController();
    const sessionSignal = input.signal ? AbortSignal.any([input.signal, sessionAbort.signal]) : sessionAbort.signal;
    const sessionDeadlineUnixMs = Math.min(input.deadlineUnixMs, Date.now() + FIXTURE_SESSION_MAX_MS);
    let child: FixtureChild | undefined;
    let frames: FrameStream | undefined;
    let childClosed: Promise<number | null> | undefined;
    let childSettled = true;
    let consumerSettled = true;
    let sessionFinished = false;
    let consumerTask: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const releaseAdmissionIfSafe = () => {
      if (sessionFinished && childSettled && consumerSettled) {
        this.#active = false;
        releaseSharedAdmission();
      }
    };
    try {
      if (sessionSignal.aborted) throw new Error('reader_cancelled');
      const tempRoot = await realpath(os.tmpdir());
      const fixtureRoot = await realpath(input.fixtureRoot);
      const fixtureInfo = await lstat(input.fixtureRoot);
      if (fixtureInfo.isSymbolicLink() || !isPathWithin(tempRoot, fixtureRoot) || fixtureRoot.toLowerCase() === tempRoot.toLowerCase()) {
        throw new Error('reader_fixture_root_invalid');
      }
      const expectedBridgePath = path.join(fixtureRoot, 'ExternalReaderBridgeSourceTest.exe');
      const bridgePath = await realpath(input.bridgePath);
      const bridgeInfo = await lstat(input.bridgePath);
      if (bridgeInfo.isSymbolicLink() || bridgePath.toLowerCase() !== expectedBridgePath.toLowerCase()) {
        throw new Error('reader_fixture_bridge_invalid');
      }

      const runningChild = this.#spawn(bridgePath, ['--request-id', requestId], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {},
      });
      child = runningChild;
      childSettled = false;
      childClosed = waitForClose(runningChild);
      void childClosed.catch(() => undefined);
      runningChild.once('close', () => { childSettled = true; releaseAdmissionIfSafe(); });
      void childClosed.catch(() => {
        if (runningChild.pid === undefined) { childSettled = true; releaseAdmissionIfSafe(); }
      });
      frames = new FrameStream(runningChild.stdout, FRAME_LIMITS.pageBytes, {
        maxQueuedBytes: FRAME_LIMITS.pageBytes, maxQueuedFrames: 1,
      });

      const hello = await frames.next(sessionDeadlineUnixMs, sessionSignal);
      if (!validateFrameEnvelope(hello, { requestId, expectedSequence: 1, allowedKeys: ['bridgeVersion', 'capability'] }) ||
          hello.type !== 'hello' || hello.capability !== 'fixed_readonly_verify' || hello.bridgeVersion !== 'candidate-reader-0.2.0') {
        throw new Error('reader_handshake_invalid');
      }
      let inputSequence = 1;
      await writeFrame(runningChild, { version: 1, requestId, sequence: inputSequence++, type: 'init',
        operation: 'verify_local_source', expectedMid: input.expectedMid, deadlineUnixMs: sessionDeadlineUnixMs,
        fixtureRoot, fixtureProcessId: input.fixtureProcessId });
      const inventory = await frames.next(sessionDeadlineUnixMs, sessionSignal);
      if (!validateFrameEnvelope(inventory, { requestId, expectedSequence: 2, allowedKeys: ['candidateCount', 'processCount', 'edbMiB', 'walMiB'] }) ||
          inventory.type !== 'inventory' || inventory.candidateCount !== 1 || inventory.processCount !== 1 ||
          !validMiBList(inventory.edbMiB, 16_384) || !validMiBList(inventory.walMiB, 2_048)) {
        throw new Error('reader_inventory_invalid');
      }
      const workBudgetSeconds = 270 + Math.ceil(9 * ((inventory.edbMiB as number[])[0]! + (inventory.walMiB as number[])[0]!) / 24);
      if (workBudgetSeconds < 1 || workBudgetSeconds > 14_400) throw new Error('reader_inventory_invalid');
      await writeFrame(runningChild, { version: 1, requestId, sequence: inputSequence++, type: 'verify',
        expectedMid: input.expectedMid, workBudgetSeconds });
      const ready = await frames.next(sessionDeadlineUnixMs, sessionSignal);
      if (!validateFrameEnvelope(ready, { requestId, expectedSequence: 3, allowedKeys: ['keyValidated', 'identityMatched', 'mappingVersion'] }) ||
          ready.type !== 'ready' || ready.keyValidated !== true || ready.identityMatched !== true || ready.mappingVersion !== 'line-profile-mid-v1') {
        throw new Error('reader_source_verify_failed');
      }

      let pageCount = 0;
      let rowCount = 0;
      let pageNumber = 1;
      let outputSequence = 4;
      while (pageCount < 500) {
        await writeFrame(runningChild, { version: 1, requestId, sequence: inputSequence++, type: 'next', pageNumber, limitRows: 100 });
        const pageFrame = await frames.next(sessionDeadlineUnixMs, sessionSignal);
        if (!validateFrameEnvelope(pageFrame, { requestId, expectedSequence: outputSequence++, allowedKeys: ['pageNumber', 'batchDigest', 'hasMore', 'rows', 'diagnostic'] }) ||
            pageFrame.type !== 'page' || pageFrame.pageNumber !== pageNumber || typeof pageFrame.batchDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(pageFrame.batchDigest) || typeof pageFrame.hasMore !== 'boolean' ||
            !Array.isArray(pageFrame.rows) || pageFrame.rows.length > 100 || !isSafeDiagnostic(pageFrame.diagnostic) ||
            !pageFrame.rows.every((row) => typeof row === 'string')) throw new Error('reader_page_invalid');
        const rows = pageFrame.rows as string[];
        if (rows.some((row) => Buffer.byteLength(row, 'utf8') > 128 * 1024) || fixturePageDigest(pageNumber, rows) !== pageFrame.batchDigest) {
          throw new Error('reader_page_invalid');
        }
        consumerSettled = false;
        consumerTask = Promise.resolve().then(() => input.onPage({
          pageNumber, batchDigest: pageFrame.batchDigest as string, hasMore: pageFrame.hasMore as boolean,
          rows, diagnostic: pageFrame.diagnostic as string,
        }, sessionSignal)).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        void consumerTask.then(() => { consumerSettled = true; releaseAdmissionIfSafe(); });
        const consumerResult = await waitUntil(consumerTask, sessionDeadlineUnixMs, sessionSignal);
        if (!consumerResult.ok) throw consumerResult.error;
        if (sessionSignal.aborted) throw new Error('reader_cancelled');
        await writeFrame(runningChild, { version: 1, requestId, sequence: inputSequence++, type: 'ack',
          pageNumber, batchDigest: pageFrame.batchDigest });
        pageCount++;
        rowCount += rows.length;
        if (pageFrame.hasMore !== true) break;
        pageNumber++;
      }
      if (pageCount < 1 || pageCount > 500) throw new Error('reader_page_limit_exceeded');
      await writeFrame(runningChild, { version: 1, requestId, sequence: inputSequence++, type: 'close', reason: 'fixture_complete' });
      runningChild.stdin.end();
      const closed = await frames.next(sessionDeadlineUnixMs, sessionSignal);
      if (!validateFrameEnvelope(closed, { requestId, expectedSequence: outputSequence, allowedKeys: ['sourceAccessed'] }) ||
          closed.type !== 'closed' || closed.sourceAccessed !== true) throw new Error('reader_close_invalid');
      await frames.expectCleanEnd(sessionDeadlineUnixMs, sessionSignal);
      const code = await waitUntil(childClosed, sessionDeadlineUnixMs, sessionSignal);
      if (code !== 0) throw new Error('reader_process_failed');
      return { pageCount, rowCount };
    } finally {
      sessionAbort.abort();
      frames?.close();
      if (child && childClosed && !childSettled) {
        child.stdin.end();
        try { await waitUntil(childClosed, Date.now() + 15_000); }
        catch {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          try { await waitUntil(childClosed, Date.now() + 15_000); }
          catch { /* retain admission below if process ownership is uncertain */ }
        }
      }
      if (!child) childSettled = true;
      if (consumerTask && !consumerSettled) {
        try { await waitUntil(consumerTask, Date.now() + FIXTURE_CONSUMER_CLEANUP_MS); }
        catch { /* retain admission until the actual consumer promise settles */ }
      }
      sessionFinished = true;
      releaseAdmissionIfSafe();
      if (!childSettled || !consumerSettled) throw new Error('reader_cleanup_uncertain');
    }
  }

  async verifyOfficialSourceHandshake(input: {
    bridgePath: string;
    requestRoot: string;
    requestId: string;
    expectedMid: string;
    deadlineUnixMs: number;
    mainIdentity: OwnerProcessIdentity;
    markerStore: OwnerReadyMarkerStore;
    inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
    signal?: AbortSignal;
    buildTrust?: OfficialBuildTrustPort;
  }): Promise<OfficialSourceInventoryVerdict> {
    return this.#officialSourceHandshake(input, 'verify_official_source');
  }

  /**
   * Read-only: reports the MID (and display name when available) of the active
   * official LINE database. Takes no expected MID; the caller decides what to do
   * with the answer.
   */
  async readOfficialIdentityHandshake(input: {
    bridgePath: string;
    requestRoot: string;
    requestId: string;
    deadlineUnixMs: number;
    mainIdentity: OwnerProcessIdentity;
    markerStore: OwnerReadyMarkerStore;
    inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
    signal?: AbortSignal;
    buildTrust?: OfficialBuildTrustPort;
    onPhase?(phase: 'locating' | 'reading_identity'): void;
  }): Promise<OfficialSourceInventoryVerdict> {
    return this.#officialSourceHandshake(input, 'read_official_identity');
  }

  async #officialSourceHandshake(input: {
    bridgePath: string;
    requestRoot: string;
    requestId: string;
    expectedMid?: string;
    deadlineUnixMs: number;
    mainIdentity: OwnerProcessIdentity;
    markerStore: OwnerReadyMarkerStore;
    inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
    signal?: AbortSignal;
    buildTrust?: OfficialBuildTrustPort;
    onPhase?(phase: 'locating' | 'reading_identity'): void;
  }, operation: 'verify_official_source' | 'read_official_identity'): Promise<OfficialSourceInventoryVerdict> {
    const identityRead = operation === 'read_official_identity';
    // Phase callbacks stop once the session has ended; a throwing callback never affects the read.
    let sessionEnded = false;
    const phase = (value: 'locating' | 'reading_identity'): void => {
      if (sessionEnded || !input.onPhase) return;
      try { input.onPhase(value); } catch { /* progress is advisory */ }
    };
    if (!identityRead && typeof input.expectedMid !== 'string') throw new Error('reader_request_invalid');
    const trustSession = new BuildTrustSession(input.buildTrust);
    const resources = await verifyJsExternalReaderResources(path.dirname(input.bridgePath));
    const bridgePath = await realpath(input.bridgePath);
    if (bridgePath !== resources.bridgePath) throw new Error('reader_resource_integrity_failed');
    const bridgeSha256 = resources.bridgeSha256;
    const sessionDeadlineUnixMs = Math.min(input.deadlineUnixMs, Date.now() + 1_800_000);
    let childFrames: FrameStream | undefined;
    let childClosed: Promise<number | null> | undefined;
    let runningChild: FixtureChild | undefined;

    phase('locating');
    try { return await runOwnerReadySession({
      requestRoot: input.requestRoot,
      requestId: input.requestId,
      deadlineUnixMs: sessionDeadlineUnixMs,
      mainIdentity: input.mainIdentity,
      bridgeImagePath: bridgePath,
      bridgeImageSha256: bridgeSha256,
      admission: this.#admission,
      markerStore: input.markerStore,
      ...(input.signal ? { signal: input.signal } : {}),
      inspectProcess: input.inspectProcess,
      spawnChild: () => {
        const running = this.#spawn(bridgePath, ['--request-id', input.requestId], {
          stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
          cwd: input.markerStore.requestDirectory,
          env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {},
        });
        runningChild = running;
        childClosed = waitForClose(running);
        void childClosed.catch(() => undefined);
        childFrames = new FrameStream(running.stdout, FRAME_LIMITS.controlBytes, {
          maxQueuedFrames: 3,
          maxQueuedBytes: FRAME_LIMITS.controlBytes * 3,
        });
        return {
          pid: running.pid,
          isAlive: () => running.exitCode === null && running.signalCode === null,
          async prepareOwnerReady(requestId: string) {
            const hello = await childFrames!.next(sessionDeadlineUnixMs, input.signal);
            if (!validateFrameEnvelope(hello, { requestId, expectedSequence: 1, allowedKeys: ['bridgeVersion', 'capability'] }) ||
                hello.type !== 'hello' || hello.capability !== 'fixed_readonly_verify' || hello.bridgeVersion !== 'candidate-reader-0.2.0') {
              throw new Error('reader_handshake_invalid');
            }
            await writeFrame(running, { version: 1, requestId, sequence: 1, type: 'init',
              operation, ...(identityRead ? {} : { expectedMid: input.expectedMid }), deadlineUnixMs: sessionDeadlineUnixMs,
              trust: await trustSession.trustForInit() }, FRAME_LIMITS.initBytes);
          },
          async sendOwnerReady(requestId: string) {
            await writeFrame(running, { version: 1, requestId, sequence: 2, type: 'owner_ready' });
          },
          async closeInput() {
            running.stdin.end();
            try {
              await childFrames!.expectCleanEnd(sessionDeadlineUnixMs);
              const exitCode = await waitUntil(childClosed!, sessionDeadlineUnixMs);
              if (exitCode !== 0) throw new Error('reader_process_failed');
            } finally { childFrames!.close(); }
          },
          async waitClosed(deadlineUnixMs: number) {
            try { await waitUntil(childClosed!, deadlineUnixMs); return true; }
            catch { return false; }
          },
          async kill() { running.kill(); },
        };
      },
      runAfterReady: async ({ signal }) => {
        const frames = childFrames!;
        let sequence = 2;
        const first = await frames.next(sessionDeadlineUnixMs, signal);
        if (validateFrameEnvelope(first, { requestId: input.requestId, expectedSequence: sequence,
              allowedKeys: ['verdict', 'buildCode', 'mappingCode', 'errorCode', ...FAILURE_BUILD_KEYS] }) &&
            first.type === 'result' && first.verdict === 'unsupported' && first.mappingCode === 'not_checked' &&
            (first.buildCode === 'unknown' || (first.buildCode === 'unsupported' && first.errorCode === 'unsupported_build')
              || (first.buildCode === 'rotation' && first.errorCode === 'build_rotation')) &&
            typeof first.errorCode === 'string' && SAFE_INVENTORY_ERROR_CODES.has(first.errorCode)) {
          await trustSession.failed(first);
          sequence++;
          const closed = await frames.next(sessionDeadlineUnixMs, signal);
          if (!validateFrameEnvelope(closed, { requestId: input.requestId, expectedSequence: sequence, allowedKeys: ['sourceAccessed'] }) ||
              closed.type !== 'closed' || closed.sourceAccessed !== true) throw new Error('reader_close_invalid');
          return { status: 'unsupported', sourceAccessed: true, errorCode: first.errorCode };
        }
        if (!validateFrameEnvelope(first, { requestId: input.requestId, expectedSequence: sequence,
              allowedKeys: ['candidateCount', 'processCount', 'edbMiB', 'walMiB', ...INVENTORY_BUILD_KEYS] }) ||
            first.type !== 'inventory' ||
            !validCandidateCount(first.candidateCount) ||
            !validMiBList(first.edbMiB, 5_120) || !validMiBList(first.walMiB, 512, 0)) {
          throw new Error('reader_inventory_shape_invalid');
        }
        if (first.processCount !== 1) throw new Error('reader_process_count_invalid');
        await trustSession.inventory(first);
        sequence++;
        const sourceMiB = (first.edbMiB as number[])[0]! + (first.walMiB as number[])[0]!;
        const workSeconds = Math.min(1_800, 270 + Math.ceil(9 * sourceMiB / 24));
        const workDeadlineUnixMs = Math.min(sessionDeadlineUnixMs, Date.now() + workSeconds * 1_000);
        if (!runningChild) throw new Error('reader_child_unavailable');
        if (identityRead) phase('reading_identity');
        await writeFrame(runningChild, { version: 1, requestId: input.requestId, sequence: 3,
          type: 'verify', workDeadlineUnixMs });
        const result = await frames.next(workDeadlineUnixMs, signal);
        if (validateFrameEnvelope(result, { requestId: input.requestId, expectedSequence: sequence,
              allowedKeys: ['verdict', 'buildCode', 'mappingCode', 'errorCode', ...FAILURE_BUILD_KEYS] }) &&
            result.type === 'result' && result.verdict === 'unsupported' && result.buildCode === 'unknown' &&
            result.mappingCode === 'not_checked' && typeof result.errorCode === 'string' &&
            SAFE_INVENTORY_ERROR_CODES.has(result.errorCode)) {
          await trustSession.failed(result);
          sequence++;
          const closed = await frames.next(workDeadlineUnixMs, signal);
          if (!validateFrameEnvelope(closed, { requestId: input.requestId, expectedSequence: sequence,
                allowedKeys: ['sourceAccessed'] }) || closed.type !== 'closed' || closed.sourceAccessed !== true)
            throw new Error('reader_close_invalid');
          return { status: 'unsupported', sourceAccessed: true, errorCode: result.errorCode };
        }
        if (!validateFrameEnvelope(result, { requestId: input.requestId, expectedSequence: sequence,
              allowedKeys: ['verdict', 'buildCode', 'buildVersion', 'mappingCode', 'sourceDigest', 'liveReadState',
                ...(identityRead ? ['mid', 'displayName', 'picturePath', 'candidateCount'] : [])] }) ||
            result.type !== 'result' || result.verdict !== 'supported' ||
            (result.buildCode !== 'accepted' && result.buildCode !== 'candidate') ||
            typeof result.buildVersion !== 'string' || result.mappingCode !== 'line-profile-mid-v1' ||
            result.liveReadState !== 'not_tested' || typeof result.sourceDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(result.sourceDigest)) throw new Error('reader_inventory_result_invalid');
        let identity: OfficialIdentity | undefined;
        if (identityRead) {
          const displayName = result.displayName;
          const picturePath = result.picturePath;
          if (typeof result.mid !== 'string' || result.mid.length < 1 || result.mid.length > 200 || result.mid.includes('\0') ||
              result.candidateCount !== first.candidateCount ||
              !(displayName === null || (typeof displayName === 'string' && displayName.length >= 1 && displayName.length <= 256 &&
                !displayName.includes('\0'))) || !(picturePath === undefined || picturePath === null ||
                (typeof picturePath === 'string' && picturePath.length <= 2048 && !picturePath.includes('\0')))) throw new Error('reader_inventory_result_invalid');
          identity = { mid: result.mid, displayName: displayName as string | null,
            ...(picturePath === undefined ? {} : { picturePath: picturePath as string | null }) };
        }
        await trustSession.validated(result);
        sequence++;
        const closed = await frames.next(workDeadlineUnixMs, signal);
        if (!validateFrameEnvelope(closed, { requestId: input.requestId, expectedSequence: sequence, allowedKeys: ['sourceAccessed'] }) ||
            closed.type !== 'closed' || closed.sourceAccessed !== true) throw new Error('reader_close_invalid');
        return {
          status: 'supported', sourceAccessed: true, buildCode: result.buildCode as 'accepted' | 'candidate', buildVersion: result.buildVersion as string,
          mappingCode: 'line-profile-mid-v1',
          sourceDigest: result.sourceDigest, liveReadState: 'not_tested', candidateCount: first.candidateCount as number, processCount: 1,
          edbMiB: first.edbMiB as [number], walMiB: first.walMiB as [number],
          ...(identity ? { identity } : {}),
        };
      },
    }); } finally { sessionEnded = true; }
  }

  async readOfficialSnapshot(input: {
    bridgePath: string; requestRoot: string; requestId: string; expectedMid: string; deadlineUnixMs: number;
    mainIdentity: OwnerProcessIdentity; markerStore: OwnerReadyMarkerStore; buildTrust?: OfficialBuildTrustPort;
    beforeCreate?(context: { signal: AbortSignal; deadlineUnixMs: number; trackSettlement(settlement: Promise<unknown>): void }): Promise<void> | void;
    inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
    onReady(metadata: ImportSnapshotMetadata, signal?: AbortSignal): Promise<ImportCursor | null> | ImportCursor | null;
    onCatalogPage?(page: ImportCatalogPage, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onProgress(progress: ImportProgress, signal?: AbortSignal): Promise<void> | void;
    onPage(page: ImportSnapshotPage, signal?: AbortSignal): Promise<void> | void; signal?: AbortSignal;
  }): Promise<ImportSnapshotCompletion> {
    if (this.#active) throw new Error('reader_already_active');
    if (!/^[a-f0-9]{32}$/.test(input.requestId) || !input.expectedMid || !Number.isSafeInteger(input.deadlineUnixMs) ||
        input.deadlineUnixMs <= Date.now() || typeof input.onPage !== 'function') throw new Error('reader_request_invalid');
    const resources = await verifyJsExternalReaderResources(path.dirname(input.bridgePath));
    const bridgePath = await realpath(input.bridgePath);
    if (bridgePath !== resources.bridgePath) throw new Error('reader_resource_integrity_failed');
    let frames: FrameStream | undefined, closed: Promise<number | null> | undefined;
    let child: FixtureChild | undefined;
    // The caller deadline bounds startup only. Once the native scan starts,
    // progress and consumer callbacks govern liveness for long imports.
    const workDeadline = IMPORT_SESSION_DEADLINE;
    const startupDeadline = Math.min(input.deadlineUnixMs, Date.now() + 45_000);
    const trustSession = new BuildTrustSession(input.buildTrust);
    return runOwnerReadySession({
      requestRoot: input.requestRoot, requestId: input.requestId, deadlineUnixMs: input.deadlineUnixMs,
      mainIdentity: input.mainIdentity, bridgeImagePath: bridgePath, bridgeImageSha256: resources.bridgeSha256,
      admission: this.#admission, markerStore: input.markerStore, inspectProcess: input.inspectProcess,
      ...(input.beforeCreate ? { beforeCreate: input.beforeCreate } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      spawnChild: () => {
        const running = this.#spawn(bridgePath, ['--request-id', input.requestId], { stdio: ['pipe','pipe','ignore'], windowsHide: true, shell: false, cwd: input.markerStore.requestDirectory,
          env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {} });
        child = running; closed = waitForClose(running); void closed.catch(() => undefined);
        frames = new FrameStream(running.stdout, FRAME_LIMITS.initialImportPageBytes,
          { maxQueuedFrames: 512, maxQueuedBytes: FRAME_LIMITS.initialImportPageBytes });
        return { pid: running.pid, closedEvent: closed, isAlive: () => running.exitCode === null && running.signalCode === null,
          async prepareOwnerReady() {
            const hello = await frames!.next(startupDeadline, input.signal);
            if (!validateFrameEnvelope(hello,{requestId:input.requestId,expectedSequence:1,allowedKeys:['bridgeVersion','capability']}) || hello.type!=='hello' || hello.bridgeVersion!=='candidate-reader-0.2.0' || hello.capability!=='fixed_readonly_verify') throw new Error('reader_handshake_invalid');
            await writeFrame(running,{version:1,requestId:input.requestId,sequence:1,type:'init',operation:'first_import_snapshot',expectedMid:input.expectedMid,deadlineUnixMs:input.deadlineUnixMs,trust:await trustSession.trustForInit()},FRAME_LIMITS.initBytes);
          },
          async sendOwnerReady() { await writeFrame(running,{version:1,requestId:input.requestId,sequence:2,type:'owner_ready'}); },
          async closeInput() { running.stdin.end(); frames!.close(); },
          async waitClosed(deadline) { try { await waitUntil(closed!,deadline); return true; } catch { return false; } }, async kill() { running.kill(); } };
      },
      runAfterReady: async ({signal, trackSettlement}) => {
        const stream=frames!; let outSeq=2, inSeq=2;
        const progressByPhase = new Map<string, bigint>();
        const throwIfNativeResult = async (frame: ProtocolFrame): Promise<void> => {
          if (frame.type !== 'result') return;
          const safeError = typeof frame.errorCode === 'string' && SAFE_INVENTORY_ERROR_CODES.has(frame.errorCode)
            ? frame.errorCode : undefined;
          if (!validateFrameEnvelope(frame, { requestId: input.requestId, expectedSequence: outSeq++,
                allowedKeys: ['verdict', 'buildCode', 'mappingCode', 'errorCode', ...FAILURE_BUILD_KEYS] }) ||
              frame.verdict !== 'unsupported' ||
              (frame.buildCode !== 'unknown' && frame.buildCode !== 'unsupported' && frame.buildCode !== 'rotation') ||
              frame.mappingCode !== 'not_checked' || !safeError) throw new Error('reader_snapshot_result_invalid');
          await trustSession.failed(frame);
          throw new Error(`reader_source_unsupported:${safeError}`);
        };
        const nextWithProgress = async (): Promise<ProtocolFrame> => {
          for (;;) {
            const frame=await stream.next(Math.min(workDeadline,Date.now()+120_000),signal);
            if(frame.type!=='progress') return frame;
            if(!validateFrameEnvelope(frame,{requestId:input.requestId,expectedSequence:outSeq++,allowedKeys:['phase','bytesCopied','totalBytes','rowsScanned','eligibleCount','scanSteps']})) throw new Error('reader_progress_invalid');
            const phase=frame.phase;
            if(!['close_line_window','key_scan','snapshot_copy','snapshot_hash','snapshot_reread','count','page_read'].includes(String(phase))) throw new Error('reader_progress_invalid');
            const validMetric=(v:unknown)=>v===null || (typeof v==='string' && /^\d+$/.test(v));
            if(!validMetric(frame.bytesCopied)||!validMetric(frame.totalBytes)||!validMetric(frame.rowsScanned)||!validMetric(frame.eligibleCount)||!validMetric(frame.scanSteps)) throw new Error('reader_progress_invalid');
            if(phase==='close_line_window'){
              // One metric-free frame per first import: every count must be null.
              if(frame.bytesCopied!==null||frame.totalBytes!==null||frame.rowsScanned!==null||frame.eligibleCount!==null||frame.scanSteps!==null||progressByPhase.has('close_line_window')) throw new Error('reader_progress_invalid');
              progressByPhase.set('close_line_window',0n);
              await invokeConsumer((callbackSignal) => input.onProgress({phase:'close_line_window',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:null}, callbackSignal), signal, trackSettlement, 120_000);
              continue;
            }
            const metric = phase === 'count' || phase === 'page_read' ? frame.scanSteps : frame.bytesCopied;
            if (typeof metric !== 'string') throw new Error('reader_progress_invalid');
            const current = BigInt(metric), previous = progressByPhase.get(String(phase));
            const attemptLocalPhase = phase === 'snapshot_copy' || phase === 'snapshot_hash' || phase === 'snapshot_reread';
            if (!attemptLocalPhase && previous !== undefined && current <= previous) throw new Error('reader_progress_invalid');
            progressByPhase.set(String(phase), current);
            const progress: ImportProgress = {phase:phase as ImportProgress['phase'],bytesCopied:frame.bytesCopied as string|null,totalBytes:frame.totalBytes as string|null,rowsScanned:frame.rowsScanned as string|null,eligibleCount:frame.eligibleCount as string|null,scanSteps:frame.scanSteps as string|null};
            await invokeConsumer((callbackSignal) => input.onProgress(progress, callbackSignal), signal, trackSettlement, 120_000);
          }
        };
        const inventory=await stream.next(Math.min(workDeadline,Date.now()+120_000),signal);
        await throwIfNativeResult(inventory);
        if(!validateFrameEnvelope(inventory,{requestId:input.requestId,expectedSequence:outSeq++,allowedKeys:['candidateCount','processCount','edbMiB','walMiB',...INVENTORY_BUILD_KEYS]}) || inventory.type!=='inventory' || !validCandidateCount(inventory.candidateCount)) throw new Error('reader_inventory_shape_invalid'); if(inventory.processCount!==1) throw new Error('reader_process_count_invalid');
        await trustSession.inventory(inventory);
        await writeFrame(child!,{version:1,requestId:input.requestId,sequence:++inSeq,type:'verify',workDeadlineUnixMs:workDeadline});
        const ready=await nextWithProgress();
        await throwIfNativeResult(ready);
        if(!validateFrameEnvelope(ready,{requestId:input.requestId,expectedSequence:outSeq++,allowedKeys:['sourceArchiveFormat','sourceIdentityDigest','snapshotDigest','schemaVersion','eligibleCount','highWatermark']}) || ready.type!=='ready' || ready.sourceArchiveFormat!==1 || !isDigest(ready.sourceIdentityDigest) || !isDigest(ready.snapshotDigest) || typeof ready.schemaVersion!=='string' || !(ready.eligibleCount===null || /^\d+$/.test(String(ready.eligibleCount)))) throw new Error('reader_snapshot_metadata_invalid');
        await trustSession.validated();
        const metadata: ImportSnapshotMetadata={sourceArchiveFormat:1,sourceIdentityDigest:String(ready.sourceIdentityDigest),snapshotDigest:String(ready.snapshotDigest),schemaVersion:String(ready.schemaVersion),eligibleCount:ready.eligibleCount as string|null,highWatermark:parseCursor(ready.highWatermark)};
        let cursor=await invokeConsumer((callbackSignal) => input.onReady(metadata, callbackSignal), signal, trackSettlement, 120_000);
        if (cursor !== null && (!cursor || typeof cursor.createdTime !== 'string' || typeof cursor.id !== 'string')) throw new Error('reader_cursor_invalid');
        let directoryPageNumber = 0;
        for (;;) {
          if (signal.aborted) throw new Error('reader_cancelled');
          const expectedPageNumber = directoryPageNumber + 1;
          await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'directory_next', pageNumber: expectedPageNumber });
          const directoryFrame = await nextWithProgress();
          await throwIfNativeResult(directoryFrame);
          if (!validateFrameEnvelope(directoryFrame, { requestId: input.requestId, expectedSequence: outSeq++, allowedKeys: DIRECTORY_FRAME_KEYS })) {
            throw new Error('reader_directory_page_invalid');
          }
          const page = parseDirectoryPage(directoryFrame, input.requestId, expectedPageNumber);
          if (input.onDirectoryPage) await invokeConsumer((callbackSignal) => input.onDirectoryPage!(page, callbackSignal), signal, trackSettlement, 120_000);
          if (signal.aborted) throw new Error('reader_cancelled');
          await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'directory_ack',
            pageNumber: page.pageNumber, batchDigest: page.batchDigest });
          directoryPageNumber = expectedPageNumber;
          if (!page.hasMore) break;
        }
        let catalogPageNumber = 0;
        for (;;) {
          if (signal.aborted) throw new Error('reader_cancelled');
          const expectedPageNumber = catalogPageNumber + 1;
          await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'catalog_next', pageNumber: expectedPageNumber });
          const catalogFrame = await nextWithProgress();
          await throwIfNativeResult(catalogFrame);
          if (!validateFrameEnvelope(catalogFrame, { requestId: input.requestId, expectedSequence: outSeq++,
                allowedKeys: ['pageNumber', 'batchDigest', 'rows', 'hasMore'] }) || catalogFrame.type !== 'catalog_page' ||
              catalogFrame.pageNumber !== expectedPageNumber || !isDigest(catalogFrame.batchDigest) ||
              !Array.isArray(catalogFrame.rows) || catalogFrame.rows.length > 1000 || typeof catalogFrame.hasMore !== 'boolean' ||
              (catalogFrame.rows.length === 0 && catalogFrame.hasMore)) throw new Error('reader_catalog_page_invalid');
          const records = catalogFrame.rows as unknown[];
          if (!records.every((record) => NativeCatalogRecordSchema.safeParse(record).success)) throw new Error('reader_catalog_page_invalid');
          const page: ImportCatalogPage = { requestId: input.requestId, pageNumber: expectedPageNumber,
            batchDigest: String(catalogFrame.batchDigest), rows: records as ImportCatalogPage['rows'], hasMore: catalogFrame.hasMore };
          if (input.onCatalogPage) {
            await invokeConsumer((callbackSignal) => input.onCatalogPage!(page, callbackSignal), signal, trackSettlement, 120_000);
          } else if (page.rows.length > 0) throw new Error('reader_catalog_callback_required');
          if (signal.aborted) throw new Error('reader_cancelled');
          await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'catalog_ack',
            pageNumber: page.pageNumber, batchDigest: page.batchDigest });
          catalogPageNumber = expectedPageNumber;
          if (!page.hasMore) break;
        }
        let pageNumber=0,rowCount=0;
        for(;;){
          if(signal.aborted) throw new Error('reader_cancelled');
          await writeFrame(child!,{version:1,requestId:input.requestId,sequence:++inSeq,type:'next',pageNumber:pageNumber+1,limitRows:2000,cursor});
          const p=await nextWithProgress();
          await throwIfNativeResult(p);
          if(!validateFrameEnvelope(p,{requestId:input.requestId,expectedSequence:outSeq++,allowedKeys:['pageNumber','batchDigest','rows','lastCursor','hasMore']}) || p.type!=='page' || p.pageNumber!==pageNumber+1 || !isDigest(p.batchDigest) || !Array.isArray(p.rows) || p.rows.length>2000 || typeof p.hasMore!=='boolean') throw new Error('reader_page_invalid');
          const rows=p.rows as ImportRow[]; if (!rows.every(isImportRow)) throw new Error('reader_page_invalid'); const last=parseCursor(p.lastCursor);
          const page:ImportSnapshotPage={pageNumber:p.pageNumber as number,batchDigest:p.batchDigest as string,rows,lastCursor:last,hasMore:p.hasMore};
          await invokeConsumer((callbackSignal) => input.onPage(page, callbackSignal), signal, trackSettlement, 120_000);
          if (signal.aborted) throw new Error('reader_cancelled');
          await writeFrame(child!,{version:1,requestId:input.requestId,sequence:++inSeq,type:'ack',pageNumber:page.pageNumber,batchDigest:page.batchDigest,lastCursor:last});
          pageNumber++; rowCount+=rows.length; if(last) cursor=last; if(!page.hasMore) break;
        }
        await writeFrame(child!,{version:1,requestId:input.requestId,sequence:++inSeq,type:'done',pageCount:pageNumber,rowCount});
        const done=await stream.next(Math.min(workDeadline,Date.now()+120_000),signal);
        await throwIfNativeResult(done);
        if(!validateFrameEnvelope(done,{requestId:input.requestId,expectedSequence:outSeq++,allowedKeys:['sourceIdentityDigest','snapshotDigest','pageCount','rowCount','highWatermark']}) || done.type!=='complete' || done.sourceIdentityDigest!==metadata.sourceIdentityDigest || done.snapshotDigest!==metadata.snapshotDigest || done.pageCount!==pageNumber || done.rowCount!==rowCount) throw new Error('reader_completion_invalid');
        const high=parseCursor(done.highWatermark);
        const closedFrame=await stream.next(Math.min(workDeadline,Date.now()+120_000),signal);
        await throwIfNativeResult(closedFrame);
        if(!validateFrameEnvelope(closedFrame,{requestId:input.requestId,expectedSequence:outSeq,allowedKeys:['sourceAccessed']}) || closedFrame.type!=='closed' || closedFrame.sourceAccessed!==true) throw new Error('reader_close_invalid');
        // `closed` is the protocol marker, not proof that the child exited
        // cleanly. Half-close stdin so the native bridge can finish, then
        // consume stdout through EOF and validate the process exit status.
        child!.stdin.end();
        await stream.expectCleanEnd(Date.now()+120_000,signal);
        const exitCode=await waitUntil(closed!,Date.now()+120_000,signal);
        if(exitCode!==0) throw new Error('reader_process_exit_invalid');
        return {sourceIdentityDigest:metadata.sourceIdentityDigest,snapshotDigest:metadata.snapshotDigest,pageCount:pageNumber,rowCount,highWatermark:high};
      },
    });
  }

  async readOfficialMonitor(input: {
    bridgePath: string; requestRoot: string; requestId: string; expectedMid: string; sourceIdentityDigest: string;
    cursor: ImportCursor | null; deadlineUnixMs: number; mainIdentity: OwnerProcessIdentity;
    markerStore: OwnerReadyMarkerStore; inspectProcess(pid: number): Promise<OwnerProcessIdentity | null>;
    buildTrust?: OfficialBuildTrustPort;
    beforeCreate?(context: { signal: AbortSignal; deadlineUnixMs: number; trackSettlement(settlement: Promise<unknown>): void }): Promise<void> | void;
    onProgress(progress: ImportProgress, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onPage(page: DirectMonitorPage, signal?: AbortSignal): Promise<ImportCursor | null> | ImportCursor | null;
    signal?: AbortSignal; pollIntervalMs?: number;
    onReady?(access: NativeMonitorAccess, signal?: AbortSignal): Promise<void> | void;
  }): Promise<void> {
    if (this.#active) throw new Error('reader_already_active');
    if (!/^[a-f0-9]{32}$/.test(input.requestId) || !/^[0-9a-f]{64}$/.test(input.sourceIdentityDigest) ||
        !input.expectedMid || !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now() ||
        typeof input.onPage !== 'function' || (input.pollIntervalMs !== undefined &&
          (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 1000 || input.pollIntervalMs > 60_000))) {
      throw new Error('reader_request_invalid');
    }
    if (input.signal?.aborted) throw new Error('reader_cancelled');
    const startupDeadline = Math.min(input.deadlineUnixMs, Date.now() + 45_000);
    const keyScanDeadline = Date.now() + 30 * 60 * 1_000;
    const trustSession = new BuildTrustSession(input.buildTrust);
    const resources = await verifyJsExternalReaderResources(path.dirname(input.bridgePath));
    const bridgePath = await realpath(input.bridgePath);
    if (bridgePath !== resources.bridgePath) throw new Error('reader_resource_integrity_failed');
    this.#active = true;
    let frames: FrameStream | undefined;
    let closed: Promise<number | null> | undefined;
    let child: FixtureChild | undefined;
    let cancelAuxiliary: (() => void) | undefined;
    try {
      return await runOwnerReadySession({
        requestRoot: input.requestRoot, requestId: input.requestId, deadlineUnixMs: input.deadlineUnixMs,
        mainIdentity: input.mainIdentity, bridgeImagePath: bridgePath,
        bridgeImageSha256: resources.bridgeSha256,
        admission: this.#admission, markerStore: input.markerStore, inspectProcess: input.inspectProcess,
        ...(input.beforeCreate ? { beforeCreate: input.beforeCreate } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        spawnChild: () => {
          const running = this.#spawn(bridgePath, ['--request-id', input.requestId], {
            stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false, cwd: input.markerStore.requestDirectory,
            env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {},
          });
          child = running; closed = waitForClose(running); void closed.catch(() => undefined);
          frames = new FrameStream(running.stdout, FRAME_LIMITS.pageBytes,
            { maxQueuedFrames: 2, maxQueuedBytes: FRAME_LIMITS.pageBytes });
          return {
            pid: running.pid, closedEvent: closed, isAlive: () => running.exitCode === null && running.signalCode === null,
            async prepareOwnerReady() {
              const hello = await frames!.next(startupDeadline, input.signal);
              if (!validateFrameEnvelope(hello, { requestId: input.requestId, expectedSequence: 1,
                    allowedKeys: ['bridgeVersion', 'capability'] }) || hello.type !== 'hello' ||
                  hello.bridgeVersion !== 'candidate-reader-0.2.0' || hello.capability !== 'fixed_readonly_verify') {
                throw new Error('reader_handshake_invalid');
              }
              await writeFrame(running, { version: 1, requestId: input.requestId, sequence: 1, type: 'init',
                operation: 'direct_monitor', expectedMid: input.expectedMid, deadlineUnixMs: input.deadlineUnixMs,
                trust: await trustSession.trustForInit() }, FRAME_LIMITS.initBytes);
            },
            async sendOwnerReady() { await writeFrame(running, { version: 1, requestId: input.requestId, sequence: 2, type: 'owner_ready' }); },
            async closeInput() { running.stdin.end(); },
            async waitClosed(deadlineUnixMs) {
              try { const code = await waitUntil(closed!, deadlineUnixMs); frames?.close(); return code === 0; }
              catch { return false; }
            },
            async kill() { running.kill(); },
          };
        },
        runAfterReady: async ({ signal, trackSettlement }) => {
          const stream = frames!;
          let outSeq = 2, inSeq = 2, pageNumber = 0;
          let cursor = input.cursor;
          const nextValid = async (deadlineUnixMs: number): Promise<ProtocolFrame> => {
            for (;;) {
              const frame = await stream.next(Math.min(deadlineUnixMs, Date.now() + 120_000), signal);
              if (frame.type !== 'progress') return frame;
              if (!validateFrameEnvelope(frame, { requestId: input.requestId, expectedSequence: outSeq++,
                    allowedKeys: ['phase', 'bytesCopied', 'totalBytes', 'rowsScanned', 'eligibleCount', 'scanSteps'] }) ||
                  frame.phase !== 'key_scan' || typeof frame.bytesCopied !== 'string' || !/^\d+$/.test(frame.bytesCopied)) {
                throw new Error('reader_progress_invalid');
              }
              const progress: ImportProgress = { phase: 'key_scan', bytesCopied: frame.bytesCopied,
                totalBytes: typeof frame.totalBytes === 'string' ? frame.totalBytes : null,
                rowsScanned: null, eligibleCount: null, scanSteps: null };
              await invokeConsumer((callbackSignal) => input.onProgress(progress, callbackSignal), signal, trackSettlement, 120_000);
            }
          };
          const inventory = await nextValid(startupDeadline);
          if (inventory.type === 'result') {
            // A statically rejected build (rotation/untrusted) stops before inventory.
            if (validateFrameEnvelope(inventory, { requestId: input.requestId, expectedSequence: outSeq,
                  allowedKeys: ['verdict', 'buildCode', 'mappingCode', 'errorCode', ...FAILURE_BUILD_KEYS] }) &&
                inventory.verdict === 'unsupported' && inventory.mappingCode === 'not_checked' &&
                (inventory.buildCode === 'unknown' || inventory.buildCode === 'unsupported' || inventory.buildCode === 'rotation') &&
                typeof inventory.errorCode === 'string' && SAFE_INVENTORY_ERROR_CODES.has(inventory.errorCode)) {
              await trustSession.failed(inventory);
              throw new Error(`reader_source_unsupported:${inventory.errorCode}`);
            }
            throw new Error('reader_inventory_shape_invalid');
          }
          if (!validateFrameEnvelope(inventory, { requestId: input.requestId, expectedSequence: outSeq++,
                allowedKeys: ['candidateCount', 'processCount', 'edbMiB', 'walMiB', 'sourceIdentityDigest', ...INVENTORY_BUILD_KEYS] }) ||
              inventory.type !== 'inventory' || !validCandidateCount(inventory.candidateCount) ||
              typeof inventory.sourceIdentityDigest !== 'string') throw new Error('reader_inventory_shape_invalid');
          if (inventory.processCount !== 1) throw new Error('reader_process_count_invalid');
          // The reader selects the active (newest) database. A different digest means official LINE is on another account
          // than the stored source (or its database was replaced): fail closed, never retarget or move the source.
          if (inventory.sourceIdentityDigest !== input.sourceIdentityDigest) throw new Error('reader_source_identity_changed');
          await trustSession.inventory(inventory);
          await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'verify',
            workDeadlineUnixMs: keyScanDeadline, sourceIdentityDigest: input.sourceIdentityDigest, cursor });
          const ready = await nextValid(keyScanDeadline);
          if (validateFrameEnvelope(ready, { requestId: input.requestId, expectedSequence: outSeq,
                allowedKeys: ['verdict', 'buildCode', 'mappingCode', 'errorCode', ...FAILURE_BUILD_KEYS] }) &&
              ready.type === 'result' && ready.verdict === 'unsupported' && ready.mappingCode === 'not_checked' &&
              (ready.buildCode === 'unknown' || ready.buildCode === 'unsupported') && typeof ready.errorCode === 'string' &&
              SAFE_INVENTORY_ERROR_CODES.has(ready.errorCode)) {
            await trustSession.failed(ready);
            throw new Error(`reader_source_unsupported:${ready.errorCode}`);
          }
          if (!validateFrameEnvelope(ready, { requestId: input.requestId, expectedSequence: outSeq++,
              allowedKeys: ['sourceArchiveFormat', 'sourceIdentityDigest', 'schemaVersion'] }) || ready.type !== 'ready' ||
              ready.sourceArchiveFormat !== 1 || ready.sourceIdentityDigest !== input.sourceIdentityDigest || ready.schemaVersion !== 'line-profile-mid-v1') {
            throw new Error('reader_monitor_ready_invalid');
          }
          await trustSession.validated();
          const pollInterval = input.pollIntervalMs ?? 5_000;
          type AuxiliaryRequest = { type: 'auth_candidates' | 'attachment_metadata'; fields: Record<string, unknown>;
            resolve(value: any): void; reject(error: Error): void; active: boolean };
          const auxiliary: AuxiliaryRequest[] = [];
          const enqueueAuxiliary = <T>(type: AuxiliaryRequest['type'], fields: Record<string, unknown>, requestSignal?: AbortSignal): Promise<T> => {
            if (signal.aborted || requestSignal?.aborted) return Promise.reject(new Error('reader_cancelled'));
            if (auxiliary.length >= 2) return Promise.reject(new Error('reader_auxiliary_queue_full'));
            return new Promise<T>((resolve, reject) => {
              const item: AuxiliaryRequest = { type, fields, resolve, reject, active: false };
              const onAbort = () => {
                const index = auxiliary.indexOf(item);
                if (index >= 0) auxiliary.splice(index, 1);
                reject(new Error('reader_cancelled'));
              };
              requestSignal?.addEventListener('abort', onAbort, { once: true });
              const settle = (action: () => void) => {
                requestSignal?.removeEventListener('abort', onAbort);
                action();
              };
              item.resolve = (value) => settle(() => resolve(value));
              item.reject = (error) => settle(() => reject(error));
              auxiliary.push(item);
            });
          };
          const access: NativeMonitorAccess = Object.freeze({
            acquireAuthCandidates: (requestSignal) => {
              // Official-app token lookup is shelved: never ask the native reader.
              if (signal.aborted || requestSignal?.aborted) return Promise.reject(new Error('reader_cancelled'));
              return Promise.resolve({ candidates: [], errorCode: 'auth_probe_disabled' });
            },
            decodeAttachment: (request, requestSignal) => {
              const envelope = NativeSourceEnvelopeSchema.parse(request.envelope);
              if (envelope.table !== '_message' || !request.expectedMessageId || request.expectedMessageId.length > 512
                || !request.expectedChatId || request.expectedChatId.length > 512) {
                return Promise.reject(new Error('reader_attachment_request_invalid'));
              }
              return enqueueAuxiliary('attachment_metadata', { envelope, expectedMessageId: request.expectedMessageId,
                expectedChatId: request.expectedChatId }, requestSignal);
            },
          });
          if (input.onReady) {
            const readyWork = Promise.resolve().then(() => input.onReady!(access, signal));
            trackSettlement(readyWork);
            void readyWork.catch(() => undefined);
            // Let synchronous work in onReady enqueue its first auxiliary
            // request before the monitor loop can issue a page poll.
            await Promise.resolve();
          }
          cancelAuxiliary = () => {
            for (const item of auxiliary.splice(0)) item.reject(new Error('reader_cancelled'));
          };
          const processAuxiliary = async (): Promise<void> => {
            while (auxiliary.length > 0) {
              const item = auxiliary.shift()!;
              item.active = true;
              try {
                await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq,
                  type: item.type, ...item.fields }, FRAME_LIMITS.initialImportPageBytes);
                const response = await nextValid(Date.now() + 30_000);
                if (item.type === 'auth_candidates') {
                  if (!validateFrameEnvelope(response, { requestId: input.requestId, expectedSequence: outSeq++,
                    allowedKeys: ['candidates', 'errorCode'] }) || response.type !== 'auth_candidates'
                    || !Array.isArray(response.candidates) || response.candidates.length > 16
                    || !response.candidates.every((candidate) => OfficialAuthCandidateSchema.safeParse(candidate).success)
                    || !(response.errorCode === null || (typeof response.errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(response.errorCode)))) {
                    throw new Error('reader_auth_candidates_invalid');
                  }
                  item.resolve({ candidates: response.candidates, errorCode: response.errorCode });
                } else {
                  if (!validateFrameEnvelope(response, { requestId: input.requestId, expectedSequence: outSeq++,
                    allowedKeys: ['metadata', 'errorCode'] }) || response.type !== 'attachment_metadata'
                    || !(response.metadata === null || NativeAttachmentMetadataSchema.safeParse(response.metadata).success)
                    || !(response.errorCode === null || (typeof response.errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(response.errorCode)))) {
                    throw new Error('reader_attachment_metadata_invalid');
                  }
                  item.resolve({ metadata: response.metadata, errorCode: response.errorCode });
                }
              } catch (error) {
                item.reject(error instanceof Error ? error : new Error('reader_auxiliary_failed'));
                throw error;
              }
            }
          };
          // One directory pass per reader session, before the first message poll.
          let directoryPageNumber = 0;
          for (;;) {
            if (signal.aborted) throw new Error('reader_cancelled');
            const expectedPageNumber = directoryPageNumber + 1;
            await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'directory_next', pageNumber: expectedPageNumber });
            const directoryFrame = await nextValid(Date.now() + 120_000);
            if (directoryFrame.type === 'result' && directoryFrame.verdict === 'unsupported' && typeof directoryFrame.errorCode === 'string'
              && SAFE_INVENTORY_ERROR_CODES.has(directoryFrame.errorCode)) throw new Error(`reader_source_unsupported:${directoryFrame.errorCode}`);
            if (!validateFrameEnvelope(directoryFrame, { requestId: input.requestId, expectedSequence: outSeq++, allowedKeys: DIRECTORY_FRAME_KEYS })) {
              throw new Error('reader_directory_page_invalid');
            }
            const directoryPage = parseDirectoryPage(directoryFrame, input.requestId, expectedPageNumber);
            if (input.onDirectoryPage) {
              await invokeConsumer((callbackSignal) => input.onDirectoryPage!(directoryPage, callbackSignal), signal, trackSettlement, 120_000);
            }
            if (signal.aborted) throw new Error('reader_cancelled');
            await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'directory_ack',
              pageNumber: directoryPage.pageNumber, batchDigest: directoryPage.batchDigest });
            directoryPageNumber = expectedPageNumber;
            if (!directoryPage.hasMore) break;
          }
          for (;;) {
            if (signal.aborted) throw new Error('reader_cancelled');
            await processAuxiliary();
            await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'poll',
              pageNumber: pageNumber + 1, cursor });
            const pageFrame = await stream.next(Date.now() + 120_000, signal);
            if (pageFrame.type === 'progress') throw new Error('reader_progress_invalid');
            if (pageFrame.type === 'result' && pageFrame.verdict === 'unsupported' && typeof pageFrame.errorCode === 'string'
              && SAFE_INVENTORY_ERROR_CODES.has(pageFrame.errorCode)) throw new Error(`reader_source_unsupported:${pageFrame.errorCode}`);
            const pageRowsValid = Array.isArray(pageFrame.rows) && pageFrame.rows.every(isImportRow);
            const tailRowsValid = Array.isArray(pageFrame.tailRows) && pageFrame.tailRows.every(isImportRow);
            if (!validateFrameEnvelope(pageFrame, { requestId: input.requestId, expectedSequence: outSeq++,
                  allowedKeys: ['pageNumber', 'batchDigest', 'rows', 'tailRows', 'lastCursor', 'hasMore', 'tailWindow', 'unreadCounts'] }) ||
                pageFrame.type !== 'page' || pageFrame.pageNumber !== pageNumber + 1 || !isDigest(pageFrame.batchDigest) ||
                !Array.isArray(pageFrame.rows) || pageFrame.rows.length > 100 || !Array.isArray(pageFrame.tailRows) ||
                pageFrame.tailRows.length > 50 || typeof pageFrame.hasMore !== 'boolean' ||
                !pageRowsValid || !tailRowsValid) throw new Error('reader_page_invalid');
            const lastCursor = parseCursor(pageFrame.lastCursor);
            if (pageFrame.rows.length > 0 && !lastCursor) throw new Error('reader_cursor_invalid');
            const tailWindow = pageFrame.tailWindow === undefined ? undefined : parseTailWindow(pageFrame.tailWindow);
            const unreadCounts = pageFrame.unreadCounts === undefined ? undefined : parseUnreadCounts(pageFrame.unreadCounts);
            if (unreadCounts !== undefined && pageFrame.hasMore) throw new Error('reader_page_invalid');
            const page: DirectMonitorPage = { pageNumber: pageNumber + 1, batchDigest: String(pageFrame.batchDigest),
              rows: pageFrame.rows as ImportRow[], tailRows: pageFrame.tailRows as ImportRow[], lastCursor,
              hasMore: pageFrame.hasMore, ...(tailWindow === undefined ? {} : { tailWindow }),
              ...(unreadCounts === undefined ? {} : { unreadCounts }) };
            const committedCursor = await invokeConsumer((callbackSignal) => input.onPage(page, callbackSignal), signal, trackSettlement, 120_000);
            if (committedCursor !== null && (!committedCursor || typeof committedCursor.createdTime !== 'string' || typeof committedCursor.id !== 'string')) {
              throw new Error('reader_cursor_invalid');
            }
            if (signal.aborted) throw new Error('reader_cancelled');
            await writeFrame(child!, { version: 1, requestId: input.requestId, sequence: ++inSeq, type: 'ack',
              pageNumber: page.pageNumber, batchDigest: page.batchDigest, lastCursor });
            pageNumber++; cursor = committedCursor;
            if (!page.hasMore) await abortableDelay(pollInterval, signal);
          }
        },
      });
    } finally {
      cancelAuxiliary?.();
      frames?.close();
      this.#active = false;
    }
  }

  async openNoEdbFixture(input: {
    bridgePath: string;
    requestId?: string;
    expectedMid: string;
    deadlineUnixMs: number;
    signal?: AbortSignal;
  }): Promise<NoEdbFixtureInventory> {
    if (this.#active) throw new Error('reader_already_active');
    const requestId = input.requestId ?? randomUUID().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/.test(requestId) || typeof input.expectedMid !== 'string' ||
        input.expectedMid.length < 1 || input.expectedMid.length > 200 || input.expectedMid.includes('\0') ||
        !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now()) {
      throw new Error('reader_request_invalid');
    }
    this.#active = true;
    let releaseSharedAdmission: () => void;
    try {
      releaseSharedAdmission = await this.#admission.acquire(input.signal);
    } catch (error) {
      this.#active = false;
      throw error;
    }
    const sessionDeadlineUnixMs = Math.min(input.deadlineUnixMs, Date.now() + FIXTURE_SESSION_MAX_MS);
    let child: FixtureChild | undefined;
    let frames: FrameStream | undefined;
    let childClosed: Promise<number | null> | undefined;
    let ownershipReleased = false;
    try {
      if (input.signal?.aborted) throw new Error('reader_cancelled');
      const resources = await verifyJsExternalReaderResources(path.dirname(input.bridgePath));
      if (await realpath(input.bridgePath) !== resources.bridgePath) throw new Error('reader_resource_integrity_failed');
      const runningChild = this.#spawn(input.bridgePath, ['--request-id', requestId], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {},
      });
      child = runningChild;
      childClosed = waitForClose(runningChild);
      void childClosed.catch(() => undefined);
      frames = new FrameStream(runningChild.stdout, FRAME_LIMITS.controlBytes);

      const hello = await frames.next(sessionDeadlineUnixMs, input.signal);
      if (!validateFrameEnvelope(hello, { requestId, expectedSequence: 1, allowedKeys: ['bridgeVersion', 'capability'] }) ||
          hello.type !== 'hello' || hello.capability !== 'fixed_readonly_verify' || hello.bridgeVersion !== 'candidate-reader-0.2.0') {
        throw new Error('reader_handshake_invalid');
      }

      await writeFrame(runningChild, {
        version: 1, requestId, sequence: 1, type: 'init',
        expectedMid: input.expectedMid, deadlineUnixMs: sessionDeadlineUnixMs,
      });
      const inventory = await frames.next(sessionDeadlineUnixMs, input.signal);
      if (!validateFrameEnvelope(inventory, { requestId, expectedSequence: 2, allowedKeys: ['candidateCount', 'processCount', 'edbMiB', 'walMiB'] }) ||
          inventory.type !== 'inventory' || inventory.candidateCount !== 0 || inventory.processCount !== 0 ||
          !Array.isArray(inventory.edbMiB) || inventory.edbMiB.length !== 0 ||
          !Array.isArray(inventory.walMiB) || inventory.walMiB.length !== 0) {
        throw new Error('reader_inventory_invalid');
      }

      await writeFrame(runningChild, { version: 1, requestId, sequence: 2, type: 'close', reason: 'fixture_complete' });
      runningChild.stdin.end();
      const closed = await frames.next(sessionDeadlineUnixMs, input.signal);
      if (!validateFrameEnvelope(closed, { requestId, expectedSequence: 3, allowedKeys: ['sourceAccessed'] }) ||
          closed.type !== 'closed' || closed.sourceAccessed !== false) throw new Error('reader_close_invalid');
      await frames.expectCleanEnd(sessionDeadlineUnixMs, input.signal);
      const code = await waitUntil(childClosed, sessionDeadlineUnixMs, input.signal);
      if (code !== 0) throw new Error('reader_process_failed');
      ownershipReleased = true;
      return { candidateCount: 0, processCount: 0, edbMiB: [], walMiB: [] };
    } catch (error) {
      throw error;
    } finally {
      frames?.close();
      if (child && childClosed && child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        try {
          await waitUntil(childClosed, Date.now() + 15_000);
        } catch {
          child.kill();
          try { await waitUntil(childClosed, Date.now() + 15_000); }
          catch { throw new Error('reader_cleanup_uncertain'); }
        }
      }
      if (child && childClosed) {
        if (child.exitCode === null && child.signalCode === null) throw new Error('reader_cleanup_uncertain');
        ownershipReleased = true;
      } else if (!child) ownershipReleased = true;
      if (ownershipReleased) {
        this.#active = false;
        releaseSharedAdmission();
      }
    }
  }
}

export class FrameStream {
  readonly #stream: Readable;
  readonly #decoder: FrameDecoder;
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedFrames: number;
  readonly #maxChunkBytes: number;
  readonly #queue: ProtocolFrame[] = [];
  #queueBytes = 0;
  readonly #waiters: Array<{ resolve(value: ProtocolFrame): void; reject(error: Error): void }> = [];
  readonly #endWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  #failure: Error | undefined;
  #ended = false;
  #expectEnd = false;
  readonly #onData: (chunk: Buffer) => void;
  readonly #onError: (error: Error) => void;
  readonly #onEnd: () => void;

  constructor(stream: Readable, maxBytes: number, queueLimits: { maxQueuedBytes?: number; maxQueuedFrames?: number } = {}) {
    this.#stream = stream;
    this.#decoder = new FrameDecoder(maxBytes);
    this.#maxQueuedBytes = queueLimits.maxQueuedBytes ?? MAX_QUEUED_CONTROL_BYTES;
    this.#maxQueuedFrames = queueLimits.maxQueuedFrames ?? MAX_QUEUED_CONTROL_FRAMES;
    if (!Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 1 || this.#maxQueuedBytes > FRAME_LIMITS.initialImportPageBytes ||
        !Number.isSafeInteger(this.#maxQueuedFrames) || this.#maxQueuedFrames < 1 || this.#maxQueuedFrames > MAX_QUEUED_INVENTORY_RESPONSE_FRAMES) {
      throw new Error('reader_queue_limit_invalid');
    }
    this.#maxChunkBytes = this.#maxQueuedBytes + 4 * this.#maxQueuedFrames;
    this.#onData = (chunk) => {
      try {
        if (this.#expectEnd) throw new Error('reader_trailing_bytes');
        if (chunk.byteLength > this.#maxChunkBytes) throw new Error('reader_frame_queue_full');
        const decoded = this.#decoder.push(chunk);
        for (const frame of decoded) {
          const waiter = this.#waiters.shift();
          if (waiter) waiter.resolve(frame);
          else {
            const frameBytes = Buffer.byteLength(JSON.stringify(frame));
            if (this.#queue.length >= this.#maxQueuedFrames || this.#queueBytes + frameBytes > this.#maxQueuedBytes) {
              throw new Error('reader_frame_queue_full');
            }
            this.#queue.push(frame);
            this.#queueBytes += frameBytes;
          }
        }
      } catch (error) { this.#fail(error instanceof Error ? error : new Error('reader_frame_invalid')); }
    };
    this.#onError = (error) => this.#fail(error);
    this.#onEnd = () => {
      this.#ended = true;
      if (this.#decoder.hasPartialFrame) this.#fail(new Error(this.#expectEnd ? 'reader_trailing_bytes' : 'reader_frame_truncated'));
      else if (!this.#failure) this.#flushEnd();
      while (this.#endWaiters.length) this.#endWaiters.shift()!.resolve();
    };
    stream.on('data', this.#onData);
    stream.on('error', this.#onError);
    stream.on('end', this.#onEnd);
  }

  next(deadlineUnixMs: number, signal?: AbortSignal): Promise<ProtocolFrame> {
    if (this.#failure) return Promise.reject(this.#failure);
    const queued = this.#queue.shift();
    if (queued) {
      this.#queueBytes -= Buffer.byteLength(JSON.stringify(queued));
      return Promise.resolve(queued);
    }
    if (this.#ended) return Promise.reject(new Error('reader_closed_early'));
    const remaining = deadlineUnixMs - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('reader_deadline_exceeded'));
    if (this.#waiters.length >= 1) return Promise.reject(new Error('reader_waiter_limit'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        resolve: (frame: ProtocolFrame) => finish(() => resolve(frame)),
        reject: (error: Error) => finish(() => reject(error)),
      };
      const onAbort = () => waiter.reject(new Error('reader_cancelled'));
      const timer = setTimeout(() => waiter.reject(new Error('reader_deadline_exceeded')), remaining);
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        action();
      };
      this.#waiters.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  expectCleanEnd(deadlineUnixMs: number, signal?: AbortSignal): Promise<void> {
    this.#expectEnd = true;
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#queue.length) {
      this.#fail(new Error('reader_trailing_frame'));
      return Promise.reject(this.#failure);
    }
    if (this.#decoder.hasPartialFrame) {
      this.#fail(new Error('reader_trailing_bytes'));
      return Promise.reject(this.#failure);
    }
    if (this.#ended) return Promise.resolve();
    if (this.#endWaiters.length >= 1) return Promise.reject(new Error('reader_waiter_limit'));
    const remaining = deadlineUnixMs - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('reader_deadline_exceeded'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#endWaiters.indexOf(waiter);
        if (index >= 0) this.#endWaiters.splice(index, 1);
        action();
      };
      const waiter = { resolve: () => finish(resolve), reject: (error: Error) => finish(() => reject(error)) };
      const onAbort = () => waiter.reject(new Error('reader_cancelled'));
      const timer = setTimeout(() => waiter.reject(new Error('reader_deadline_exceeded')), remaining);
      this.#endWaiters.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.#stream.off('data', this.#onData);
    this.#stream.off('error', this.#onError);
    this.#stream.off('end', this.#onEnd);
    this.#fail(new Error('reader_closed'));
  }

  #fail(error: Error): void {
    if (!this.#failure) this.#failure = error;
    this.#queue.length = 0;
    this.#queueBytes = 0;
    while (this.#waiters.length) this.#waiters.shift()!.reject(this.#failure);
    while (this.#endWaiters.length) this.#endWaiters.shift()!.reject(this.#failure);
  }

  #flushEnd(): void {
    while (this.#waiters.length) this.#waiters.shift()!.reject(new Error('reader_closed_early'));
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validCandidateCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_OFFICIAL_CANDIDATES;
}

function validMiBList(value: unknown, maximum: number, minimum = 1): value is number[] {
  return Array.isArray(value) && value.length === 1 && Number.isSafeInteger(value[0]) &&
    (value[0] as number) >= minimum && (value[0] as number) <= maximum;
}

function fixturePageDigest(pageNumber: number, rows: readonly string[]): string {
  const hash = createHash('sha256');
  const metadata = Buffer.allocUnsafe(8);
  metadata.writeUInt32LE(pageNumber, 0);
  metadata.writeUInt32LE(rows.length, 4);
  hash.update(metadata);
  for (const row of rows) {
    const bytes = Buffer.from(row, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(bytes.byteLength, 0);
    hash.update(length).update(bytes);
    bytes.fill(0);
  }
  metadata.fill(0);
  return hash.digest('hex');
}

function isSafeDiagnostic(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(?:step|prepare|bind|column_decode|statement_step)\|\d+\|\d+\|sqlite=\d+(?:\.\d+)+\|cipher=SQLite3 Multiple Ciphers \d+(?:\.\d+)+\|readonly=1\|open_flags=1\|key_order=open,cipher,wal_settings,key$/.test(value);
}

const DIRECTORY_FRAME_KEYS = ['pageNumber', 'batchDigest', 'rows', 'hasMore'];
function parseDirectoryPage(frame: ProtocolFrame, requestId: string, expectedPageNumber: number): ImportDirectoryPage {
  if (frame.type !== 'directory_page' || frame.pageNumber !== expectedPageNumber || !isDigest(frame.batchDigest)
    || !Array.isArray(frame.rows) || frame.rows.length > 2000 || typeof frame.hasMore !== 'boolean'
    || (frame.rows.length === 0 && frame.hasMore)) throw new Error('reader_directory_page_invalid');
  const rows: ImportDirectoryPage['rows'][number][] = [];
  for (const row of frame.rows) {
    const parsed = NativeDirectoryRowSchema.safeParse(row);
    if (!parsed.success) throw new Error('reader_directory_page_invalid');
    rows.push(parsed.data);
  }
  return { requestId, pageNumber: expectedPageNumber, batchDigest: frame.batchDigest, hasMore: frame.hasMore, rows };
}

function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function parseCursor(value: unknown): ImportCursor | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reader_cursor_invalid');
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.createdTime !== 'string' || !/^-?\d+$/.test(cursor.createdTime) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 512) throw new Error('reader_cursor_invalid');
  return { createdTime: cursor.createdTime, id: cursor.id };
}
function parseTailCursor(value: unknown): ImportCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reader_page_invalid');
  const cursor = value as Record<string, unknown>;
  const keys = Object.keys(cursor);
  if (keys.length !== 2 || typeof cursor.createdTime !== 'string' || !/^\d{1,16}$/.test(cursor.createdTime)
    || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 512) throw new Error('reader_page_invalid');
  return { createdTime: cursor.createdTime, id: cursor.id };
}
function parseTailWindow(value: unknown): DirectTailWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reader_page_invalid');
  const window = value as Record<string, unknown>;
  const keys = Object.keys(window).sort().join(',');
  if (keys !== 'complete,ids,lower,upper' || window.complete !== true || !Array.isArray(window.ids) || window.ids.length > 50
    || window.ids.some((id) => typeof id !== 'string' || !id || id.length > 512) || new Set(window.ids).size !== window.ids.length) {
    throw new Error('reader_page_invalid');
  }
  return { upper: parseTailCursor(window.upper), lower: window.lower === null ? null : parseTailCursor(window.lower),
    complete: true, ids: window.ids as string[] };
}
function parseUnreadCounts(value: unknown): DirectUnreadCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reader_page_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(',') !== 'entries' || !Array.isArray(record.entries) || record.entries.length > 2000) {
    throw new Error('reader_page_invalid');
  }
  const seen = new Set<string>();
  const entries: [string, number][] = [];
  for (const entry of record.entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('reader_page_invalid');
    const [chatId, count] = entry as [unknown, unknown];
    if (typeof chatId !== 'string' || !chatId || chatId.length > 512 || seen.has(chatId)
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
      throw new Error('reader_page_invalid');
    }
    seen.add(chatId); entries.push([chatId, count]);
  }
  return { entries };
}
function isImportRow(value: unknown): value is ImportRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.observationId === 'string' && (/^[0-9a-f]{64}$/.test(row.observationId) || /^official-line-db:[^\u0000]{1,512}$/.test(row.observationId)) && row.canonicalMessageId === null &&
    typeof row.nativeConversationKind === 'string' && typeof row.nativeConversationId === 'string' && typeof row.nativeMessageId === 'string' &&
    ['direct','group','room','community','thread','unsupported'].includes(String(row.chatType)) && typeof row.chatId === 'string' && typeof row.senderId === 'string' &&
    (row.conversationTitle === undefined || row.conversationTitle === null || (typeof row.conversationTitle === 'string' && row.conversationTitle.length <= 256)) &&
    (row.senderPicturePath === undefined || row.senderPicturePath === null || (typeof row.senderPicturePath === 'string' && row.senderPicturePath.length <= 2048)) &&
    (row.nativeMetadata === undefined || NativeConversationMetadataSchema.safeParse(row.nativeMetadata).success) &&
    NativeSourceEnvelopeSchema.safeParse(row.nativePayload).success && (row.nativePayload as { table?: unknown }).table === '_message' &&
    (row.nativeContentType === undefined || row.nativeContentType === null || (Number.isSafeInteger(row.nativeContentType) && (row.nativeContentType as number) >= 0)) &&
    (row.nativeAttachments === undefined || (Array.isArray(row.nativeAttachments) && row.nativeAttachments.length <= 32
      && row.nativeAttachments.every((item) => NativeAttachmentDescriptorSchema.safeParse(item).success))) &&
    typeof row.kind === 'string' && typeof row.createdTime === 'string' && (row.text === null || typeof row.text === 'string') && typeof row.readonlyForSending === 'boolean';
}
async function invokeConsumer<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>, parentSignal: AbortSignal,
  trackSettlement: (settlement: Promise<unknown>) => void, timeoutMs: number,
): Promise<Awaited<T>> {
  if (parentSignal.aborted) throw new Error('reader_cancelled');
  const operationAbort = new AbortController();
  const callbackSignal = AbortSignal.any([parentSignal, operationAbort.signal]);
  const callbackPromise = Promise.resolve().then(() => {
    if (callbackSignal.aborted) throw new Error('reader_cancelled');
    return invoke(callbackSignal);
  }) as Promise<Awaited<T>>;
  const settlement = callbackPromise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  trackSettlement(settlement);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const failure = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        operationAbort.abort(new Error('reader_progress_timeout'));
        reject(new Error('reader_progress_timeout'));
      }, timeoutMs);
      onAbort = () => {
        operationAbort.abort(parentSignal.reason);
        reject(new Error('reader_cancelled'));
      };
      parentSignal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([settlement, failure]);
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) parentSignal.removeEventListener('abort', onAbort);
  }
}

function waitForClose(child: FixtureChild): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('close', (code) => resolve(code));
    child.once('error', reject);
  });
}

function waitUntil<T>(promise: Promise<T>, deadlineUnixMs: number, signal?: AbortSignal): Promise<T> {
  const remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('reader_deadline_exceeded'));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(() => reject(new Error('reader_cancelled')));
    const timer = setTimeout(() => finish(() => reject(new Error('reader_deadline_exceeded'))), remaining);
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('reader_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => finish(() => reject(new Error('reader_cancelled')));
    const finish = (action: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      action();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function writeFrame(child: FixtureChild, frame: unknown, maxBytes: number = FRAME_LIMITS.controlBytes): Promise<void> {
  if (child.stdin.destroyed || child.exitCode !== null) throw new Error('reader_process_closed');
  const encoded = encodeFrame(frame, maxBytes);
  if (child.stdin.write(encoded)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { child.stdin.off('drain', onDrain); child.stdin.off('error', onError); };
    child.stdin.once('drain', onDrain);
    child.stdin.once('error', onError);
  });
}
