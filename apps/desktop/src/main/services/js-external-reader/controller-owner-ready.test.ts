import { createHash, randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFrame, FrameDecoder, FRAME_LIMITS } from './protocol.js';
import { FileOwnerReadyMarkerStore, type OwnerProcessIdentity } from './owner-ready-session.js';
import type { JsExternalReaderController as SourceController } from './controller.js';
import { mainExternalSourceProbeAdmission } from '../external-source-probe-admission.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const resourceRoot = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1');
const bridgePath = path.join(resourceRoot, 'ExternalReaderBridge.exe');
const bundlePath = path.join(resourceRoot, 'controller.mjs');
let PackagedController: typeof SourceController;

function outputFrame(requestId: string, sequence: number, type: string, fields: Record<string, unknown> = {}): Buffer {
  return encodeFrame({ version: 1, requestId, sequence, type, ...fields }, type === 'page' || type === 'catalog_page' || type === 'directory_page' ? FRAME_LIMITS.initialImportPageBytes : FRAME_LIMITS.controlBytes);
}

describe('packaged candidate owner-ready bridge handshake', () => {
  beforeAll(async () => {
    buildDesktopScript(desktopRoot, 'build-js-external-reader.mjs');
    const loaded = await import(`${pathToFileURL(bundlePath).href}?test=${randomUUID()}`) as { JsExternalReaderController: typeof SourceController };
    PackagedController = loaded.JsExternalReaderController;
  });

  it('drives a 2,000-row initial page above 1 MiB through consumer settlement and ACK', async () => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-controller-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_590;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000090', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { pageSize: 2000, rowTextBytes: 700 });
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    try {
      const controller = new PackagedController(mainExternalSourceProbeAdmission, (() => child as never) as unknown as typeof spawn);
      const phases: string[] = [];
      const completion = await controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async (metadata, signal) => { expect(metadata.eligibleCount).toBe('2000'); expect(signal?.aborted).toBe(false); order.push('ready-committed'); return null; },
        onProgress: async (progress, signal) => { expect(signal?.aborted).toBe(false); phases.push(progress.phase); },
        onPage: async (page, signal) => {
          expect(page.rows).toHaveLength(2000);
          expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeGreaterThan(FRAME_LIMITS.pageBytes);
          expect(signal?.aborted).toBe(false); order.push('page-committed');
        },
      });
      expect(completion).toMatchObject({ pageCount: 1, rowCount: 2000, sourceIdentityDigest: '1'.repeat(64), snapshotDigest: '2'.repeat(64) });
      expect(phases).toEqual(['close_line_window','snapshot_copy','count','page_read']);
      expect(order.indexOf('ready-committed')).toBeLessThan(order.indexOf('next:null:2000'));
      expect(order.indexOf('page-committed')).toBeLessThan(order.indexOf('ack'));
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('commits each validated catalog page before its independent ACK and message page', async () => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-catalog-controller-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_589;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000089', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { catalogRows: 1 });
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async (metadata) => { expect(metadata.sourceArchiveFormat).toBe(1); return null; },
        onProgress: () => undefined,
        onCatalogPage: async (page) => {
          expect(page.requestId).toBe(requestId);
          expect(page.pageNumber).toBe(1);
          expect(page.rows[0]).toMatchObject({ tableName: '_contact', nativePayload: { table: '_contact' } });
          order.push('catalog-committed');
        },
        onPage: () => undefined,
      });
      expect(order.indexOf('catalog-committed')).toBeLessThan(order.indexOf('catalog-ack'));
      expect(order.indexOf('catalog-ack')).toBeLessThan(order.indexOf('next:null:2000'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const directoryContact = { kind: 'contact', mid: 'u-1', displayName: 'Real Name', nickname: '張襄君', type: 0, status: 1 };
  const directoryChat = { kind: 'conversation', chatId: 'u-1', chatType: 'direct', title: '張襄君',
    nativeMetadata: { midType: 0, parentChatId: null, communityId: null } };

  it('commits every directory page before its ACK, before the catalog and message pages', async () => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-directory-controller-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_587;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000087', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { directoryPages: [[directoryContact], [directoryChat]] });
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async () => null, onProgress: () => undefined,
        onDirectoryPage: async (page) => {
          expect(page.requestId).toBe(requestId);
          expect(page.rows).toHaveLength(1);
          order.push(`directory-committed:${page.pageNumber}:${page.rows[0]!.kind}:${page.hasMore}`);
        },
        onPage: () => undefined,
      });
      expect(order.filter((item) => item.startsWith('directory') || item.startsWith('catalog') || item.startsWith('next'))).toEqual([
        'directory-next:1', 'directory-committed:1:contact:true', 'directory-ack:1',
        'directory-next:2', 'directory-committed:2:conversation:false', 'directory-ack:2',
        'catalog-next:1', 'catalog-ack', 'next:null:2000']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['a row outside the directory schema', { directoryPages: [[{ ...directoryContact, phone: '0900' }]] }],
    ['an unknown row kind', { directoryPages: [[{ kind: 'profile', mid: 'u-1' }]] }],
    ['a non-final empty page', { emptyDirectoryWithMore: true }],
    ['an oversized page', { directoryPages: [Array.from({ length: 2001 }, () => directoryContact)] }],
  ] as Array<[string, NonNullable<Parameters<typeof fakeImportBridge>[4]>]>)('rejects %s before ACK or any later page', async (_label, options) => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-directory-invalid-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_586;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000086', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, options);
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async () => null, onProgress: () => undefined, onDirectoryPage: () => { order.push('directory-committed'); }, onPage: () => undefined,
      })).rejects.toThrow('reader_directory_page_invalid');
      expect(order).not.toContain('directory-committed');
      expect(order.some((item) => item.startsWith('directory-ack') || item.startsWith('catalog') || item.startsWith('next'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs one directory pass per direct-monitor session before the first message poll', async () => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-directory-monitor-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_585;
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000085', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { directMonitor: true, directoryPages: [[directoryContact, directoryChat]] });
    const abort = new AbortController();
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await expect(controller.readOfficialMonitor({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64),
        cursor: null, deadlineUnixMs: Date.now() + 10_000, signal: abort.signal, pollIntervalMs: 1000,
        mainIdentity: { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) },
        markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onProgress: async () => undefined,
        onDirectoryPage: async (page) => { order.push(`directory-committed:${page.rows.length}`); },
        onPage: async () => { order.push('page-committed'); abort.abort(); return null; },
      })).rejects.toThrow();
      expect(order.filter((item) => item !== 'owner-ready')).toEqual(['directory-next:1', 'directory-committed:2', 'directory-ack:1', 'poll', 'page-committed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['source_changed', 'mid_or_schema_mismatch'])('maps a native %s result during the monitor directory pass to reader_source_unsupported', async (errorCode) => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-directory-result-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_584;
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000084', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { directMonitor: true, directoryResultError: errorCode });
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await expect(controller.readOfficialMonitor({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64),
        cursor: null, deadlineUnixMs: Date.now() + 10_000, pollIntervalMs: 1000,
        mainIdentity: { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) },
        markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onProgress: async () => undefined, onPage: async () => null,
      })).rejects.toThrow(`reader_source_unsupported:${errorCode}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each<[string, { directMonitor?: boolean; inventoryOverride: Record<string, unknown> }, string]>([
    ['a different source identity digest (official LINE is on another account)', { directMonitor: true, inventoryOverride: { sourceIdentityDigest: 'c'.repeat(64) } }, 'reader_source_identity_changed'],
    ['a malformed inventory shape', { directMonitor: true, inventoryOverride: { candidateCount: 99 } }, 'reader_inventory_shape_invalid'],
    ['a missing digest', { directMonitor: true, inventoryOverride: { sourceIdentityDigest: 7 } }, 'reader_inventory_shape_invalid'],
    ['more than one LINE process', { directMonitor: true, inventoryOverride: { processCount: 2 } }, 'reader_process_count_invalid'],
    ['more than one LINE process in a first import', { inventoryOverride: { processCount: 2 } }, 'reader_process_count_invalid'],
    ['a malformed first-import inventory', { inventoryOverride: { candidateCount: 99 } }, 'reader_inventory_shape_invalid'],
  ])('fails closed with its own code for %s', async (_name, options, code) => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-inventory-code-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_590;
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000090', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, options);
    const common = { bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
      mainIdentity: { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) },
      markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
      inspectProcess: async (pid: number) => pid === childPid ? identity : null,
      onProgress: async () => undefined };
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      const run = options.directMonitor
        ? controller.readOfficialMonitor({ ...common, sourceIdentityDigest: 'b'.repeat(64), cursor: null, pollIntervalMs: 1000, onPage: async () => null })
        : controller.readOfficialSnapshot({ ...common, onReady: async () => null, onPage: async () => undefined });
      await expect(run).rejects.toThrow(code);
      // Fail closed: no key scan was requested after a rejected inventory and nothing was committed.
      expect(order.some((item) => item.startsWith('page-') || item.startsWith('poll'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a catalog row whose protected table does not match its catalog key before ACK', async () => {
    const requestId = randomUUID().replaceAll('-', ''), root = await mkdtemp(path.join(os.tmpdir(), 'reader-catalog-invalid-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_588;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000088', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
      { catalogRows: 1, invalidCatalogEnvelope: true });
    try {
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async () => null, onProgress: () => undefined, onPage: () => undefined,
      })).rejects.toThrow('reader_catalog_page_invalid');
      expect(order).toContain('catalog-next:1');
      expect(order).not.toContain('catalog-ack');
      expect(order.some((item) => item.startsWith('next:'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['line_window_ambiguous', 'line_window_close_failed', 'source_row_invalid', 'source_conversation_invalid', 'source_schema_unsupported', 'source_result_too_large'])(
    'adapts the native %s result during first-import startup', async (errorCode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-window-error-'));
      const requestId = randomUUID().replaceAll('-', ''), childPid = 55_599;
      const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
      const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000099', imagePath: bridgePath, imageSha256: bridgeSha256 };
      const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { unsupportedErrorCode: errorCode });
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      try {
        await expect(controller.readOfficialSnapshot({
          bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
          mainIdentity: { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) },
          markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
          inspectProcess: async (pid) => pid === childPid ? identity : null,
          onReady: async () => null, onProgress: async () => undefined, onPage: async () => undefined,
        })).rejects.toThrow(`reader_source_unsupported:${errorCode}`);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

  it.each(['line_window_ambiguous', 'line_window_close_failed', 'source_row_invalid', 'source_conversation_invalid', 'source_schema_unsupported', 'source_result_too_large'])(
    'adapts the native %s result during direct-monitor startup', async (errorCode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'reader-monitor-window-error-'));
      const requestId = randomUUID().replaceAll('-', ''), childPid = 55_598;
      const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
      const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000098', imagePath: bridgePath, imageSha256: bridgeSha256 };
      const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order,
        { unsupportedErrorCode: errorCode, directMonitor: true });
      const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
      try {
        await expect(controller.readOfficialMonitor({
          bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64),
          cursor: null, deadlineUnixMs: Date.now() + 10_000,
          mainIdentity: { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) },
          markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
          inspectProcess: async (pid) => pid === childPid ? identity : null,
          onProgress: async () => undefined, onPage: async () => null,
        })).rejects.toThrow(`reader_source_unsupported:${errorCode}`);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

  it.each([
    ['trailing frame', { trailingFrame: true }],
    ['partial trailing bytes', { partialTail: true }],
    ['nonzero child exit', { exitCodeOnEnd: 7 }],
    ['forced termination', { forcedTermination: true }],
  ] as const)('rejects completion with %s and releases admission after cleanup', async (_label, options) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-invalid-close-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_596;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000096', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, options);
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => null, onProgress: async () => undefined, onPage: async () => undefined,
      })).rejects.toThrow();
      expect(order).toContain('ack');
      expect(admission.isBusy()).toBe(false);
      await expect(readdir(path.join(root, `probe-${requestId}`))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['onReady', 'onProgress', 'onPage'] as const)('aborts hung %s immediately and holds admission until settlement', async (stage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-hung-callback-'));
    const requestId = randomUUID().replaceAll('-', ''), secondRequestId = randomUUID().replaceAll('-', '');
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_591;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000091', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order);
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    const abort = new AbortController();
    let began!: () => void, settle!: () => void, callbackSignal: AbortSignal | undefined;
    const callbackStarted = new Promise<void>((resolve) => { began = resolve; });
    const callbackResult = new Promise<void>((resolve) => { settle = resolve; });
    const hang = (signal?: AbortSignal) => { callbackSignal = signal; began(); return callbackResult; };
    const request = controller.readOfficialSnapshot({
      bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
      mainIdentity, markerStore: store, inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
      onReady: async (_metadata, signal) => { if (stage === 'onReady') { await hang(signal); } return null; },
      onProgress: async (_progress, signal) => { if (stage === 'onProgress') await hang(signal); },
      onPage: async (_page, signal) => { if (stage === 'onPage') await hang(signal); },
      signal: abort.signal,
    });
    await callbackStarted;
    abort.abort(new Error('operator_cancelled'));
    await expect(request).rejects.toThrow('reader_owner_cleanup_uncertain');
    expect(callbackSignal?.aborted).toBe(true);
    expect(order).not.toContain('ack');
    expect(admission.isBusy()).toBe(true);

    const secondChildPid = childPid + 1;
    const secondIdentity: OwnerProcessIdentity = { ...childIdentity, pid: secondChildPid };
    const waitAbort = new AbortController();
    const waitingSecond = expect(controller.readOfficialSnapshot({
      signal: waitAbort.signal,
      bridgePath, requestRoot: root, requestId: secondRequestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
      mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, secondRequestId, async (directory) => ensurePrivateDirectory(directory)),
      inspectProcess: async (pid) => pid === secondChildPid ? secondIdentity : null,
      onReady: () => null, onProgress: () => undefined, onPage: () => undefined,
    })).rejects.toThrow('wait_cancelled');
    waitAbort.abort(new Error('wait_cancelled'));
    await waitingSecond;

    settle();
    const releaseDeadline = Date.now() + 2_000;
    while (admission.isBusy() && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admission.isBusy()).toBe(false);
    await expect(readdir(path.join(root, `probe-${requestId}`))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('times out an unsettled consumer with abort, no ACK, and a bounded public failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-callback-timeout-'));
    const requestId = randomUUID().replaceAll('-', '');
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex'), childPid = 55_592;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000092', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order);
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    const abort = new AbortController();
    let began!: () => void, settle!: () => void, callbackSignal: AbortSignal | undefined;
    const callbackStarted = new Promise<void>((resolve) => { began = resolve; });
    const callbackResult = new Promise<void>((resolve) => { settle = resolve; });
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === 120_000 ? 20 : timeout, ...args)) as typeof setTimeout);
    try {
      const pending = controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? childIdentity : null,
        onReady: async () => null, onProgress: async () => undefined,
        onPage: async (_page, signal) => { callbackSignal = signal; began(); await callbackResult; },
      });
      await callbackStarted;
      await expect(pending).rejects.toThrow('reader_owner_cleanup_uncertain');
      expect(callbackSignal?.aborted).toBe(true);
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(true);
      settle();
      const releaseDeadline = Date.now() + 2_000;
      while (admission.isBusy() && Date.now() < releaseDeadline) await new Promise((resolve) => originalSetTimeout(resolve, 10));
      expect(admission.isBusy()).toBe(false);
      await expect(readdir(path.join(root, `probe-${requestId}`))).rejects.toThrow();
    } finally {
      timeoutSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps a productive native VM scan alive beyond the idle threshold and caller deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-slow-scan-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_594;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000094', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { slowCountProgress: true });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === 120_000 ? 250 : timeout, ...args)) as typeof setTimeout);
    const startedAt = Date.now();
    try {
      const result = await controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 2_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => null, onProgress: async () => undefined, onPage: async () => undefined,
      });
      expect(result.rowCount).toBe(1);
      expect(Date.now() - startedAt).toBeGreaterThan(2_000);
      expect(order).toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed on a duplicate native VM progress metric', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-duplicate-progress-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_593;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000093', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { duplicateCountProgress: true });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => { throw new Error('ready_must_not_run'); }, onProgress: () => undefined, onPage: () => undefined,
      })).rejects.toThrow('reader_progress_invalid');
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('surfaces a validated native safe result error instead of reporting bad snapshot metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-native-result-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_596;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000096', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { nativeError: 'key_unavailable' });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => { throw new Error('ready_must_not_run'); }, onProgress: () => undefined, onPage: () => undefined,
      })).rejects.toThrow('reader_source_unsupported:key_unavailable');
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('surfaces a validated native safe result before inventory validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-result-before-inventory-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_598;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000098', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { nativeErrorBeforeInventory: 'snapshot_source_changed' });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => { throw new Error('ready_must_not_run'); }, onProgress: () => undefined, onPage: () => undefined,
      })).rejects.toThrow('reader_source_unsupported:snapshot_source_changed');
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('surfaces a validated native safe result after ready before page validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-result-after-ready-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_599;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000099', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { nativeErrorAfterReady: 'snapshot_wal_invalid' });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => null, onProgress: () => undefined,
        onPage: () => { throw new Error('page_must_not_run'); },
      })).rejects.toThrow('reader_source_unsupported:snapshot_wal_invalid');
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails a frozen native VM scan after one idle window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-frozen-scan-'));
    const requestId = randomUUID().replaceAll('-', ''), childPid = 55_595;
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000095', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [], child = fakeImportBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, { frozenCountProgress: true });
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new PackagedController(admission, (() => child as never) as unknown as typeof spawn);
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === 120_000 ? 100 : timeout, ...args)) as typeof setTimeout);
    try {
      await expect(controller.readOfficialSnapshot({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === childPid ? identity : null,
        onReady: async () => null, onProgress: async () => undefined, onPage: async () => undefined,
      })).rejects.toThrow('reader_deadline_exceeded');
      expect(order).not.toContain('ack');
      expect(admission.isBusy()).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('promotes child ownership before owner-ready and leaves source discovery closed', async () => {
    const requestId = randomUUID().replaceAll('-', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-owner-ready-controller-'));
    const bytes = await readFile(bridgePath);
    const bridgeSha256 = createHash('sha256').update(bytes).digest('hex');
    const childPid = 55_555;
    const childIdentity: OwnerProcessIdentity = {
      pid: childPid, startedAt: '134000000000000055', imagePath: bridgePath, imageSha256: bridgeSha256,
    };
    const mainIdentity: OwnerProcessIdentity = {
      pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64),
    };
    const order: string[] = [];
    const child = fakeBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order);
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    try {
      const controller = new PackagedController(mainExternalSourceProbeAdmission, (() => child as never) as unknown as typeof spawn);
      const result = await controller.verifyOfficialSourceHandshake({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid: number) => pid === childPid ? childIdentity : null,
      });
      expect(result).toEqual({
        status: 'supported', sourceAccessed: true, buildCode: 'accepted', buildVersion: '26.4.2.3957',
        mappingCode: 'line-profile-mid-v1', sourceDigest: 'a'.repeat(64), liveReadState: 'not_tested',
        candidateCount: 1, processCount: 1, edbMiB: [1], walMiB: [1],
      });
      expect(order.indexOf('owned-marker')).toBeLessThan(order.indexOf('owner-ready'));
      expect(order.indexOf('owner-ready')).toBeLessThan(order.indexOf('synthetic-inventory-after-ready'));
      expect(order).not.toContain('official-source-discovery');
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the identity-read phases once each, in order, and never after the session ends', async () => {
    const requestId = randomUUID().replaceAll('-', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-identity-phases-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const childPid = 55_555;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000055', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [];
    const child = fakeBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, false, true);
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    try {
      const controller = new PackagedController(mainExternalSourceProbeAdmission, (() => child as never) as unknown as typeof spawn);
      const result = await controller.readOfficialIdentityHandshake({
        bridgePath, requestRoot: root, requestId, deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid: number) => pid === childPid ? childIdentity : null,
        onPhase: (phase) => { order.push(`phase:${phase}`); },
      });
      expect(result).toMatchObject({ status: 'supported', identity: { mid: `u${'1'.repeat(32)}`, displayName: '王小明' } });
      expect(order.filter((entry) => entry.startsWith('phase:'))).toEqual(['phase:locating', 'phase:reading_identity']);
      expect(order.indexOf('phase:locating')).toBeLessThan(order.indexOf('owner-ready'));
      expect(order.indexOf('synthetic-inventory-after-ready')).toBeLessThan(order.indexOf('phase:reading_identity'));
      expect(order.indexOf('phase:reading_identity')).toBeLessThan(order.indexOf('verify-frame'));
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports only the locating phase when the identity read is cancelled before the inventory', async () => {
    const requestId = randomUUID().replaceAll('-', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-identity-phases-cancel-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const childPid = 55_556;
    const childIdentity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000056', imagePath: bridgePath, imageSha256: bridgeSha256 };
    const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
    const order: string[] = [];
    const child = fakeBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, true, true);
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    const controller = new PackagedController(mainExternalSourceProbeAdmission, (() => child as never) as unknown as typeof spawn);
    const abort = new AbortController();
    const phases: string[] = [];
    let inspectionCount = 0;
    let notifyIdentityChecked!: () => void;
    const identityChecked = new Promise<void>((resolve) => { notifyIdentityChecked = resolve; });
    try {
      const pending = controller.readOfficialIdentityHandshake({
        bridgePath, requestRoot: root, requestId, deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid: number) => {
          inspectionCount += 1;
          if (inspectionCount === 2) notifyIdentityChecked();
          return pid === childPid ? childIdentity : null;
        },
        signal: abort.signal, onPhase: (phase) => { phases.push(phase); },
      });
      const outcome = pending.then(() => null, (error: unknown) => error);
      const earlyFailure = await Promise.race([identityChecked.then(() => null), outcome]);
      if (earlyFailure) throw earlyFailure;
      await new Promise((resolve) => setTimeout(resolve, 50));
      abort.abort();
      expect((await outcome as Error).message).toMatch(/cancel|abort|closed_early/i);
      expect(phases).toEqual(['locating']);
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
    } finally { abort.abort(); await rm(root, { recursive: true, force: true }); }
  });

  it('cancels a child waiting for its hello without source work and releases the fence', async () => {
    const requestId = randomUUID().replaceAll('-', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-owner-ready-cancel-'));
    const bytes = await readFile(bridgePath);
    const bridgeSha256 = createHash('sha256').update(bytes).digest('hex');
    const childPid = 55_556;
    const childIdentity: OwnerProcessIdentity = {
      pid: childPid, startedAt: '134000000000000056', imagePath: bridgePath, imageSha256: bridgeSha256,
    };
    const mainIdentity: OwnerProcessIdentity = {
      pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64),
    };
    const order: string[] = [];
    const child = fakeBridge(requestId, childPid, path.join(root, `probe-${requestId}`, 'owner.json'), order, true);
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    const spawnMock = vi.fn(() => child as never) as unknown as typeof spawn;
    const controller = new PackagedController(mainExternalSourceProbeAdmission, spawnMock);
    const abort = new AbortController();
    let inspectionCount = 0;
    let notifyIdentityChecked!: () => void;
    const identityChecked = new Promise<void>((resolve) => { notifyIdentityChecked = resolve; });
    try {
      const pending = controller.verifyOfficialSourceHandshake({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid: number) => {
          inspectionCount += 1;
          if (inspectionCount === 2) notifyIdentityChecked();
          return pid === childPid ? childIdentity : null;
        },
        signal: abort.signal,
      });
      const outcome = pending.then(() => null, (error: unknown) => error);
      const earlyFailure = await Promise.race([identityChecked.then(() => null), outcome]);
      if (earlyFailure) throw earlyFailure;
      await new Promise((resolve) => setTimeout(resolve, 50));
      abort.abort();
      expect((await outcome as Error).message).toMatch(/cancel|abort|closed_early/i);
      expect(order).not.toContain('owner-ready');
      expect(order).not.toContain('synthetic-inventory-after-ready');
      expect(child.exitCode).toBe(0);
      await expect(readFile(path.join(root, `probe-${requestId}`, 'owner.json'))).rejects.toThrow();
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
    } finally {
      abort.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['cancel before init', 'before-init'],
    ['cancel before owner-ready', 'before-ready'],
    ['deadline before owner-ready', 'deadline-before-ready'],
  ] as const)('%s with the packaged native bridge and releases admission after confirmed closure', async (_label, mode) => {
    const requestId = randomUUID().replaceAll('-', '');
    const root = await mkdtemp(path.join(os.tmpdir(), 'reader-owner-ready-native-close-'));
    const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
    const mainIdentity: OwnerProcessIdentity = {
      pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64),
    };
    const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
    const abort = new AbortController();
    let child: ReturnType<typeof spawnProcess> | undefined;
    let heldOutput: PassThrough | undefined;
    let releaseOutput: (() => void) | undefined;
    const controller = new PackagedController(mainExternalSourceProbeAdmission, ((...args: Parameters<typeof spawnProcess>) => {
      child = spawnProcess(...args);
      if (mode === 'before-init') {
        const childStdout = child.stdout;
        if (!childStdout) throw new Error('synthetic_bridge_stdout_missing');
        heldOutput = new PassThrough();
        let released = false;
        let ended = false;
        const queued: Buffer[] = [];
        const flush = () => {
          if (!released) return;
          for (const chunk of queued.splice(0)) heldOutput!.write(chunk);
          if (ended) heldOutput!.end();
        };
        childStdout.on('data', (chunk: Buffer) => { queued.push(chunk); flush(); });
        childStdout.once('end', () => { ended = true; flush(); });
        releaseOutput = () => { released = true; flush(); };
        Object.defineProperty(child, 'stdout', { configurable: true, value: heldOutput });
      }
      return child;
    }) as typeof spawnProcess);
    const deadlineUnixMs = Date.now() + (mode === 'deadline-before-ready' ? 5_000 : 10_000);
    let inspectionCount = 0;
    try {
      const pending = controller.verifyOfficialSourceHandshake({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs,
        mainIdentity, markerStore: store,
        inspectProcess: async (pid: number) => {
          inspectionCount += 1;
          const identity = child && pid === child.pid ? {
            pid, startedAt: '134000000000000077', imagePath: bridgePath, imageSha256: bridgeSha256,
          } : null;
          if (mode === 'before-init' && inspectionCount === 1) {
            releaseOutput?.();
            abort.abort();
          }
          if (mode === 'before-ready' && inspectionCount === 3) abort.abort();
          if (mode === 'deadline-before-ready' && inspectionCount === 3) {
            while (Date.now() <= deadlineUnixMs) { /* deterministic synthetic deadline boundary */ }
          }
          return identity;
        },
        ...(mode === 'deadline-before-ready' ? {} : { signal: abort.signal }),
      });
      if (mode === 'deadline-before-ready') await expect(pending).rejects.toThrow(/deadline/i);
      else await expect(pending).rejects.toThrow(/cancel|abort/i);

      if (mode === 'deadline-before-ready') {
        expect(child?.exitCode).not.toBeNull();
        expect(child?.exitCode).not.toBe(0);
      }
      else expect(child?.exitCode).toBe(4);
      await expect(readFile(path.join(root, `probe-${requestId}`, 'owner.json'))).rejects.toThrow();
      expect(mainExternalSourceProbeAdmission.isBusy()).toBe(false);
      const release = await mainExternalSourceProbeAdmission.acquire();
      release();
    } finally {
      abort.abort();
      releaseOutput?.();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

// The marker is promoted with an atomic replace; on Windows a read that lands inside the replace fails transiently
// (ENOENT/EPERM), which used to make the fake bridge exit 2 and fail unrelated assertions on its exit code.
async function readMarkerEventually(markerPath: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await readFile(markerPath, 'utf8'); }
    catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function fakeBridge(requestId: string, childPid: number, markerPath: string, order: string[], holdHello = false, identity = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: null; pid: number; exitCode: number | null;
    signalCode: NodeJS.Signals | null; kill: () => boolean;
  };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = null;
  child.pid = childPid; child.exitCode = null; child.signalCode = null;
  const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
  const finish = (code: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    child.emit('close', code, null);
  };
  child.kill = () => { finish(1); return true; };
  child.stdin.on('finish', () => finish(0));
  child.stdin.on('data', (chunk: Buffer) => {
    for (const request of decoder.push(chunk)) {
      if (request.type === 'init') {
        expect(request.operation).toBe(identity ? 'read_official_identity' : 'verify_official_source');
      } else if (request.type === 'owner_ready') {
        void readMarkerEventually(markerPath).then((content) => {
          const marker = JSON.parse(content) as { phase: string; childPid: number; childStartedAt: string };
          expect(marker).toMatchObject({ phase: 'owned', childPid, childStartedAt: '134000000000000055' });
          order.push('owned-marker');
          order.push('owner-ready');
          const inventoryFrame = outputFrame(requestId, 2, 'inventory', {
            buildCode: 'accepted', buildVersion: '26.4.2.3957', buildBytes: 30634432, buildSha256: '893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1', candidateCount: 1, processCount: 1, edbMiB: [1], walMiB: [1],
          });
          order.push('synthetic-inventory-after-ready');
          child.stdout.write(inventoryFrame);
        }).catch(() => finish(2));
      } else if (request.type === 'verify') {
          expect(request.workDeadlineUnixMs).toBeGreaterThan(Date.now());
          order.push('verify-frame');
          const resultFrame = outputFrame(requestId, 3, 'result', {
            verdict: 'supported', buildCode: 'accepted', buildVersion: '26.4.2.3957', mappingCode: 'line-profile-mid-v1',
            sourceDigest: 'a'.repeat(64), liveReadState: 'not_tested',
            ...(identity ? { mid: `u${'1'.repeat(32)}`, displayName: '王小明', candidateCount: 1 } : {}),
          });
          const closedFrame = outputFrame(requestId, 4, 'closed', { sourceAccessed: true });
          child.stdout.write(Buffer.concat([resultFrame, closedFrame]));
      }
    }
  });
  const sendHello = () => child.stdout.write(outputFrame(requestId, 1, 'hello', {
    bridgeVersion: 'candidate-reader-0.2.0', capability: 'fixed_readonly_verify',
  }));
  // holdHello: the bridge never greets, so a request is deterministically still waiting for its hello when the test
  // acts (no timer to race the abort under load). Nothing in this file needs the hello released later.
  if (!holdHello) queueMicrotask(sendHello);
  return child;
}

function fakeImportBridge(requestId: string, childPid: number, markerPath: string, order: string[], options: { inventoryOverride?: Record<string, unknown>; duplicateCountProgress?: boolean; slowCountProgress?: boolean; frozenCountProgress?: boolean; nativeError?: string; nativeErrorBeforeInventory?: string; nativeErrorAfterReady?: string; trailingFrame?: boolean; partialTail?: boolean; exitCodeOnEnd?: number; forcedTermination?: boolean; unsupportedErrorCode?: string; directMonitor?: boolean; pageSize?: number; rowTextBytes?: number; catalogRows?: number; invalidCatalogEnvelope?: boolean; directoryPages?: unknown[][]; emptyDirectoryWithMore?: boolean; directoryResultError?: string } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: null; pid: number; exitCode: number | null;
    signalCode: NodeJS.Signals | null; kill: () => boolean;
  };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = null;
  child.pid=childPid; child.exitCode=null; child.signalCode=null;
  const decoder=new FrameDecoder(FRAME_LIMITS.controlBytes); let out=0;
  let progressTimer: NodeJS.Timeout | undefined;
  const emit=(type:string,fields:Record<string,unknown>={})=>child.stdout.write(outputFrame(requestId,++out,type,fields));
  const finish=(code:number)=>{if(child.exitCode!==null||child.signalCode!==null)return;if(progressTimer)clearInterval(progressTimer);if(options.forcedTermination){child.signalCode='SIGKILL';child.stdout.end();child.emit('close',null,'SIGKILL');return;}child.exitCode=code;child.stdout.end();child.emit('close',code,null);};
  child.kill=()=>{finish(1);return true;}; child.stdin.on('finish',()=>finish(options.exitCodeOnEnd ?? 0));
  child.stdin.on('data',(chunk:Buffer)=>{for(const frame of decoder.push(chunk)){
    if(frame.type==='init') expect(frame.operation).toBe(options.directMonitor ? 'direct_monitor' : 'first_import_snapshot');
    else if(frame.type==='owner_ready') void readFile(markerPath,'utf8').then(content=>{
      expect(JSON.parse(content)).toMatchObject({phase:'owned',childPid}); order.push('owner-ready');
      if (options.nativeErrorBeforeInventory) { emit('result',{verdict:'unsupported',buildCode:'unknown',mappingCode:'not_checked',errorCode:options.nativeErrorBeforeInventory}); return; }
      emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[1],...(options.directMonitor ? {sourceIdentityDigest:'b'.repeat(64)} : {}),...(options.inventoryOverride ?? {})});
    });
    else if(frame.type==='verify'){
      if (options.nativeError) { emit('result', { verdict: 'unsupported', buildCode: 'unknown', mappingCode: 'not_checked', errorCode: options.nativeError }); return; }
      if (options.unsupportedErrorCode) { emit('result',{verdict:'unsupported',buildCode:'unknown',mappingCode:'not_checked',errorCode:options.unsupportedErrorCode}); emit('closed',{sourceAccessed:true}); continue; }
      if (options.directMonitor) { emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:'b'.repeat(64),schemaVersion:'line-profile-mid-v1'}); continue; }
      emit('progress',{phase:'close_line_window',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:null});
      emit('progress',{phase:'snapshot_copy',bytesCopied:'10',totalBytes:'10',rowsScanned:null,eligibleCount:null,scanSteps:null});
      emit('progress',{phase:'count',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:'1000'});
      const pageSize=options.pageSize ?? 1;
      const ready=()=>emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:'1'.repeat(64),snapshotDigest:'2'.repeat(64),schemaVersion:'line-profile-mid-v1',eligibleCount:String(pageSize),highWatermark:{createdTime:String(pageSize),id:`m${pageSize}`}});
      if (options.duplicateCountProgress) emit('progress',{phase:'count',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:'1000'});
      if (options.slowCountProgress) {
        let steps=2000, ticks=0;
        progressTimer=setInterval(()=>{
          emit('progress',{phase:'count',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:String(steps)});
          steps+=1000;
          if (++ticks===26) { clearInterval(progressTimer); progressTimer=undefined; ready(); }
        },100);
      } else if (!options.frozenCountProgress) ready();
    } else if(frame.type==='directory_next'){
      order.push(`directory-next:${String(frame.pageNumber)}`);
      if (options.directoryResultError) { emit('result', { verdict: 'unsupported', buildCode: 'unknown', mappingCode: 'not_checked', errorCode: options.directoryResultError }); return; }
      const pages = options.directoryPages ?? [[]];
      const index = Number(frame.pageNumber) - 1;
      emit('directory_page', { pageNumber: frame.pageNumber, batchDigest: `${'5'.repeat(63)}${String(frame.pageNumber)}`,
        rows: pages[index] ?? [], hasMore: options.emptyDirectoryWithMore ? true : index < pages.length - 1 });
    } else if(frame.type==='directory_ack') { order.push(`directory-ack:${String(frame.pageNumber)}`); }
    else if(frame.type==='poll') {
      order.push('poll');
      emit('page',{pageNumber:frame.pageNumber,batchDigest:'6'.repeat(64),rows:[],tailRows:[],lastCursor:null,hasMore:false});
    } else if(frame.type==='catalog_next'){
      order.push(`catalog-next:${String(frame.pageNumber)}`);
      const rows = Array.from({ length: options.catalogRows ?? 0 }, () => ({ tableName: '_contact', recordKey: 'pk:["u-1"]',
        nativePayload: { format: 1, table: '_contact', sourceDigest: 'c'.repeat(64), encoding: 'dpapi', data: 'AQID' } }));
      if (options.invalidCatalogEnvelope && rows.length) (rows[0] as { nativePayload: { table: string } }).nativePayload.table = '_groupChat';
      emit('catalog_page', { pageNumber: frame.pageNumber, batchDigest: '4'.repeat(64), rows, hasMore: false });
    } else if(frame.type==='catalog_ack') { expect(frame.pageNumber).toBe(1); expect(frame.batchDigest).toBe('4'.repeat(64)); order.push('catalog-ack'); }
    else if(frame.type==='next'){
      order.push(`${frame.cursor===null?'next:null':'next:cursor'}:${String(frame.limitRows)}`);
      if (options.nativeErrorAfterReady) { emit('result',{verdict:'unsupported',buildCode:'unknown',mappingCode:'not_checked',errorCode:options.nativeErrorAfterReady}); continue; }
      emit('progress',{phase:'page_read',bytesCopied:null,totalBytes:null,rowsScanned:null,eligibleCount:null,scanSteps:'2000'});
      const pageSize=options.pageSize ?? 1;
      const rowText = 'x'.repeat(options.rowTextBytes ?? 8);
      const rows=Array.from({length:pageSize},(_,index)=>({observationId:`official-line-db:m${index+1}`,canonicalMessageId:null,nativeConversationKind:'direct',nativeConversationId:'chat',nativeMessageId:`m${index+1}`,chatType:'direct',chatId:'chat',senderId:'sender',kind:'text',createdTime:String(index+1),text:rowText,readonlyForSending:false,nativePayload:{format:1,table:'_message',sourceDigest:'d'.repeat(64),encoding:'dpapi',data:'AQID'}}));
      emit('page',{pageNumber:1,batchDigest:'3'.repeat(64),rows,lastCursor:{createdTime:String(pageSize),id:`m${pageSize}`},hasMore:false});
    } else if(frame.type==='ack') { const pageSize=options.pageSize ?? 1; expect(frame.lastCursor).toEqual({createdTime:String(pageSize),id:`m${pageSize}`}); order.push('ack'); }
    else if(frame.type==='done') { const pageSize=options.pageSize ?? 1; emit('complete',{sourceIdentityDigest:'1'.repeat(64),snapshotDigest:'2'.repeat(64),pageCount:1,rowCount:pageSize,highWatermark:{createdTime:String(pageSize),id:`m${pageSize}`}}); emit('closed',{sourceAccessed:true}); if(options.trailingFrame) emit('progress',{phase:'snapshot_copy',bytesCopied:'11',totalBytes:'10',rowsScanned:null,eligibleCount:null,scanSteps:null}); if(options.partialTail) child.stdout.write(Buffer.from([0,0,0])); }
  }});
  queueMicrotask(()=>emit('hello',{bridgeVersion:'candidate-reader-0.2.0',capability:'fixed_readonly_verify'}));
  return child;
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
