import { createHash, randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FRAME_LIMITS } from './protocol.js';
import { FileOwnerReadyMarkerStore, type OwnerProcessIdentity } from './owner-ready-session.js';
import type { JsExternalReaderController as SourceController } from './controller.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';
import {
  OFFICIAL_BUILD_SEED_BUILD, OFFICIAL_BUILD_SEED_THUMBPRINT, initialOfficialBuildTrustState, officialBuildBridgeTrust,
  type OfficialBuildEvent, type OfficialBuildTrustPort,
} from '../official-build-trust.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const resourceRoot = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1');
const bridgePath = path.join(resourceRoot, 'ExternalReaderBridge.exe');
const bundlePath = path.join(resourceRoot, 'controller.mjs');
let PackagedController: typeof SourceController;

const CANDIDATE = { version: '26.5.0.3975', bytes: 30_700_001, sha256: 'c'.repeat(64) };
const candidateInventory = { buildCode: 'candidate', buildVersion: CANDIDATE.version, buildBytes: CANDIDATE.bytes, buildSha256: CANDIDATE.sha256 };
const acceptedInventory = { buildCode: 'accepted', buildVersion: '26.4.2.3957', buildBytes: OFFICIAL_BUILD_SEED_BUILD.bytes,
  buildSha256: OFFICIAL_BUILD_SEED_BUILD.sha256 };
const THUMBPRINT = 'A'.repeat(40);

type BridgeOptions = {
  operation: 'verify_official_source' | 'first_import_snapshot' | 'direct_monitor';
  inventory?: Record<string, unknown>;
  rejection?: Record<string, unknown>;
  verifyFailure?: string;
  onInit?(frame: Record<string, unknown>): void;
};

function frame(requestId: string, sequence: number, type: string, fields: Record<string, unknown> = {}): Buffer {
  return encodeFrame({ version: 1, requestId, sequence, type, ...fields }, FRAME_LIMITS.controlBytes);
}

function fakeBridge(requestId: string, childPid: number, options: BridgeOptions) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: null; pid: number; exitCode: number | null;
    signalCode: NodeJS.Signals | null; kill: () => boolean;
  };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = null;
  child.pid = childPid; child.exitCode = null; child.signalCode = null;
  const decoder = new FrameDecoder(FRAME_LIMITS.initBytes);
  let out = 0;
  const emit = (type: string, fields: Record<string, unknown> = {}) => child.stdout.write(frame(requestId, ++out, type, fields));
  const finish = (code: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.stdout.end(); child.emit('close', code, null);
  };
  child.kill = () => { finish(1); return true; };
  child.stdin.on('finish', () => finish(0));
  child.stdin.on('data', (chunk: Buffer) => {
    for (const request of decoder.push(chunk)) {
      if (request.type === 'init') {
        expect(request.operation).toBe(options.operation);
        options.onInit?.(request);
      } else if (request.type === 'owner_ready') {
        if (options.rejection) {
          emit('result', { verdict: 'unsupported', mappingCode: 'not_checked', ...options.rejection });
          if (options.operation === 'verify_official_source') emit('closed', { sourceAccessed: true });
          return;
        }
        emit('inventory', { ...(options.inventory ?? acceptedInventory), candidateCount: 1, processCount: 1, edbMiB: [1], walMiB: [1],
          ...(options.operation === 'direct_monitor' ? { sourceIdentityDigest: 'b'.repeat(64) } : {}) });
      } else if (request.type === 'verify') {
        if (options.verifyFailure) {
          emit('result', { verdict: 'unsupported', buildCode: 'unknown', mappingCode: 'not_checked', errorCode: options.verifyFailure });
          if (options.operation === 'verify_official_source') emit('closed', { sourceAccessed: true });
          continue;
        }
        if (options.operation === 'direct_monitor') {
          emit('ready', { sourceArchiveFormat: 1, sourceIdentityDigest: 'b'.repeat(64), schemaVersion: 'line-profile-mid-v1' });
        } else if (options.operation === 'verify_official_source') {
          const inventory = options.inventory ?? acceptedInventory;
          emit('result', { verdict: 'supported', buildCode: inventory.buildCode, buildVersion: inventory.buildVersion,
            mappingCode: 'line-profile-mid-v1', sourceDigest: 'a'.repeat(64), liveReadState: 'not_tested' });
          emit('closed', { sourceAccessed: true });
        }
      }
    }
  });
  queueMicrotask(() => emit('hello', { bridgeVersion: 'candidate-reader-0.2.0', capability: 'fixed_readonly_verify' }));
  return child;
}

function recordingPort(options: { failRecord?: boolean } = {}): OfficialBuildTrustPort & { events: OfficialBuildEvent[] } {
  const events: OfficialBuildEvent[] = [];
  return {
    events,
    bridgeTrust: () => officialBuildBridgeTrust(initialOfficialBuildTrustState()),
    record(event) { if (options.failRecord) throw new Error('store_down'); events.push(event); },
  };
}

async function session<T>(options: BridgeOptions, run: (input: {
  controller: SourceController; root: string; requestId: string; childPid: number; identity: OwnerProcessIdentity;
  mainIdentity: OwnerProcessIdentity; store: FileOwnerReadyMarkerStore;
}) => Promise<T>): Promise<T> {
  const requestId = randomUUID().replaceAll('-', '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-build-trust-'));
  const childPid = 56_000 + Math.floor(Math.random() * 1000);
  const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
  const identity: OwnerProcessIdentity = { pid: childPid, startedAt: '134000000000000077', imagePath: bridgePath, imageSha256: bridgeSha256 };
  const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
  const child = fakeBridge(requestId, childPid, options);
  const controller = new PackagedController(new ExternalSourceProbeAdmissionGate(), (() => child as never) as unknown as typeof spawn);
  const store = new FileOwnerReadyMarkerStore(root, requestId, async (directory) => ensurePrivateDirectory(directory));
  try { return await run({ controller, root, requestId, childPid, identity, mainIdentity, store }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('official build trust through the reader controller', () => {
  beforeAll(async () => {
    buildDesktopScript(desktopRoot, 'build-js-external-reader.mjs', ['ignore', 'ignore', 'inherit']);
    const loaded = await import(`${pathToFileURL(bundlePath).href}?test=${randomUUID()}`) as { JsExternalReaderController: typeof SourceController };
    PackagedController = loaded.JsExternalReaderController;
  });

  const handshake = (port: OfficialBuildTrustPort | undefined, options: Omit<BridgeOptions, 'operation'>) =>
    session({ operation: 'verify_official_source', ...options }, ({ controller, root, requestId, childPid, identity, mainIdentity, store }) =>
      controller.verifyOfficialSourceHandshake({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 5_000,
        mainIdentity, markerStore: store, inspectProcess: async (pid: number) => pid === childPid ? identity : null,
        ...(port ? { buildTrust: port } : {}),
      }));

  it('sends the persisted trust lists in init and promotes a candidate after a successful verification', async () => {
    const port = recordingPort();
    let init: Record<string, unknown> | undefined;
    const result = await handshake(port, { inventory: candidateInventory, onInit: (frame) => { init = frame; } });
    expect(init?.trust).toEqual({ accepted: [OFFICIAL_BUILD_SEED_BUILD], pinned: [OFFICIAL_BUILD_SEED_THUMBPRINT] });
    expect(result).toMatchObject({ status: 'supported', buildCode: 'candidate', buildVersion: CANDIDATE.version });
    expect(port.events).toEqual([
      { kind: 'observed', verdict: 'candidate', build: CANDIDATE },
      { kind: 'validated', build: CANDIDATE },
    ]);
  });

  it('does not promote an already accepted build and still sends seeds without a port', async () => {
    const port = recordingPort();
    await handshake(port, {});
    expect(port.events).toEqual([{ kind: 'observed', verdict: 'accepted', build: { ...OFFICIAL_BUILD_SEED_BUILD } }]);
    let init: Record<string, unknown> | undefined;
    await handshake(undefined, { onInit: (frame) => { init = frame; } });
    expect(init?.trust).toEqual({ accepted: [OFFICIAL_BUILD_SEED_BUILD], pinned: [OFFICIAL_BUILD_SEED_THUMBPRINT] });
  });

  it('treats a non-seed version-only accepted build as accepted for an identity read, without promotion or error', async () => {
    const port = recordingPort();
    const versionOnly = { buildCode: 'accepted', buildVersion: '27.1.0.4100', buildBytes: 31_000_123, buildSha256: 'd'.repeat(64) };
    const result = await handshake(port, { inventory: versionOnly });
    expect(result).toMatchObject({ status: 'supported', buildCode: 'accepted', buildVersion: '27.1.0.4100' });
    expect(port.events).toEqual([{ kind: 'observed', verdict: 'accepted', build: { version: '27.1.0.4100', bytes: 31_000_123, sha256: 'd'.repeat(64) } }]);
  });

  it('starts a direct monitor on a non-seed version-only accepted build without promotion', async () => {
    const port = recordingPort();
    const versionOnly = { buildCode: 'accepted', buildVersion: '27.1.0.4100', buildBytes: 31_000_123, buildSha256: 'd'.repeat(64) };
    const abort = new AbortController();
    let sawReady = false;
    const outcome = await session({ operation: 'direct_monitor', inventory: versionOnly },
      async ({ controller, root, requestId, childPid, identity, mainIdentity, store }) => {
        const pending = controller.readOfficialMonitor({
          bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64), cursor: null,
          deadlineUnixMs: Date.now() + 10_000, mainIdentity, markerStore: store,
          inspectProcess: async (pid) => pid === childPid ? identity : null, buildTrust: port,
          onProgress: () => undefined, onPage: async () => null, signal: abort.signal,
        });
        const settled = pending.then(() => 'resolved', (error: Error) => error.message);
        for (let attempt = 0; attempt < 100 && !port.events.some((event) => event.kind === 'observed'); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        sawReady = port.events.some((event) => event.kind === 'observed');
        abort.abort();
        return settled;
      });
    expect(sawReady).toBe(true);
    expect(outcome).toMatch(/cancel|abort/i);
    expect(port.events.every((event) => event.kind === 'observed')).toBe(true);
  }, 20_000);

  it('records a signer rotation with its thumbprint and never reaches inventory', async () => {
    const port = recordingPort();
    const result = await handshake(port, { rejection: { buildCode: 'rotation', errorCode: 'build_rotation', buildReason: 'not_pinned',
      buildVersion: CANDIDATE.version, signerThumbprint: THUMBPRINT } });
    expect(result).toEqual({ status: 'unsupported', sourceAccessed: true, errorCode: 'build_rotation' });
    expect(port.events).toEqual([{ kind: 'blocked', verdict: 'rotation', version: CANDIDATE.version, reason: 'not_pinned', thumbprint: THUMBPRINT }]);
  });

  it('records an untrusted build under the existing unsupported_build wire code', async () => {
    const port = recordingPort();
    const result = await handshake(port, { rejection: { buildCode: 'unsupported', errorCode: 'unsupported_build', buildReason: 'unsigned' } });
    expect(result).toEqual({ status: 'unsupported', sourceAccessed: true, errorCode: 'unsupported_build' });
    expect(port.events).toEqual([{ kind: 'blocked', verdict: 'untrusted', version: null, reason: 'unsigned' }]);
  });

  it.each([
    ['key_unavailable', 'key_scan_failed'],
    ['snapshot_key_mismatch', 'key_scan_failed'],
    ['source_schema_unsupported', 'schema_changed'],
    ['snapshot_database_header_invalid', 'schema_changed'],
  ] as const)('classifies a candidate %s failure as %s without promotion', async (code, verdict) => {
    const port = recordingPort();
    const result = await handshake(port, { inventory: candidateInventory, verifyFailure: code });
    expect(result).toMatchObject({ status: 'unsupported', errorCode: code });
    expect(port.events).toEqual([
      { kind: 'observed', verdict: 'candidate', build: CANDIDATE },
      { kind: 'failed', verdict, build: CANDIDATE, reason: code },
    ]);
  });

  it('leaves a wrong-account (mid_or_schema_mismatch) candidate failure inconclusive', async () => {
    const port = recordingPort();
    await handshake(port, { inventory: candidateInventory, verifyFailure: 'mid_or_schema_mismatch' });
    expect(port.events).toEqual([{ kind: 'observed', verdict: 'candidate', build: CANDIDATE }]);
  });

  it('does not reclassify an accepted build failure as a compatibility problem', async () => {
    const port = recordingPort();
    await handshake(port, { verifyFailure: 'key_unavailable' });
    expect(port.events).toEqual([{ kind: 'observed', verdict: 'accepted', build: { ...OFFICIAL_BUILD_SEED_BUILD } }]);
  });

  it('never fails the read because trust persistence failed', async () => {
    const result = await handshake(recordingPort({ failRecord: true }), { inventory: candidateInventory });
    expect(result).toMatchObject({ status: 'supported', buildCode: 'candidate' });
  });

  it.each([
    ['legacy buildCode', { ...acceptedInventory, buildCode: 'supported_26_4_2_3957' }],
    ['missing sha', { buildCode: 'accepted', buildVersion: '26.4.2.3957', buildBytes: 1 }],
    ['bad sha', { ...candidateInventory, buildSha256: 'XYZ' }],
    ['bad version', { ...candidateInventory, buildVersion: '26.5' }],
    ['oversized build', { ...candidateInventory, buildBytes: 200 * 1024 * 1024 }],
  ])('rejects a malformed inventory build identity (%s)', async (_name, inventory) => {
    const port = recordingPort();
    await expect(handshake(port, { inventory })).rejects.toThrow('reader_inventory_invalid');
    expect(port.events).toEqual([]);
  });

  it('promotes a candidate when a direct monitor session reaches ready, and accepts promoted trust in init', async () => {
    const port = recordingPort();
    const promoted = { ...initialOfficialBuildTrustState(), acceptedBuilds: [...initialOfficialBuildTrustState().acceptedBuilds, { ...CANDIDATE, acceptedAt: '2026-10-20T00:00:00.000Z' }] };
    const promotedPort: OfficialBuildTrustPort & { events: OfficialBuildEvent[] } = { ...port, bridgeTrust: () => officialBuildBridgeTrust(promoted) };
    let init: Record<string, unknown> | undefined;
    const abort = new AbortController();
    const outcome = await session({ operation: 'direct_monitor', inventory: candidateInventory, onInit: (frame) => { init = frame; } },
      async ({ controller, root, requestId, childPid, identity, mainIdentity, store }) => {
        const pending = controller.readOfficialMonitor({
          bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64), cursor: null,
          deadlineUnixMs: Date.now() + 10_000, mainIdentity, markerStore: store,
          inspectProcess: async (pid) => pid === childPid ? identity : null, buildTrust: promotedPort,
          onProgress: () => undefined, onPage: async () => null, signal: abort.signal,
        });
        const settled = pending.then(() => 'resolved', (error: Error) => error.message);
        for (let attempt = 0; attempt < 100 && !port.events.some((event) => event.kind === 'validated'); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        abort.abort();
        return settled;
      });
    expect(outcome).toMatch(/cancel|abort/i);
    expect((init?.trust as { accepted: unknown[] }).accepted).toHaveLength(2);
    expect(port.events).toEqual([
      { kind: 'observed', verdict: 'candidate', build: CANDIDATE },
      { kind: 'validated', build: CANDIDATE },
    ]);
  }, 20_000);

  it('adapts a statically rejected build into a finite monitor error and records it', async () => {
    const port = recordingPort();
    await session({ operation: 'direct_monitor', rejection: { buildCode: 'rotation', errorCode: 'build_rotation',
      buildReason: 'not_pinned', buildVersion: CANDIDATE.version, signerThumbprint: THUMBPRINT } },
    async ({ controller, root, requestId, childPid, identity, mainIdentity, store }) => {
      await expect(controller.readOfficialMonitor({
        bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64), cursor: null,
        deadlineUnixMs: Date.now() + 10_000, mainIdentity, markerStore: store,
        inspectProcess: async (pid) => pid === childPid ? identity : null, buildTrust: port,
        onProgress: () => undefined, onPage: async () => null,
      })).rejects.toThrow('reader_source_unsupported:build_rotation');
    });
    expect(port.events).toEqual([{ kind: 'blocked', verdict: 'rotation', version: CANDIDATE.version, reason: 'not_pinned', thumbprint: THUMBPRINT }]);
  });

  it('records a candidate key failure during first import without promotion', async () => {
    const port = recordingPort();
    await session({ operation: 'first_import_snapshot', inventory: candidateInventory, verifyFailure: 'key_unavailable' },
      async ({ controller, root, requestId, childPid, identity, mainIdentity, store }) => {
        await expect(controller.readOfficialSnapshot({
          bridgePath, requestRoot: root, requestId, expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000,
          mainIdentity, markerStore: store, inspectProcess: async (pid) => pid === childPid ? identity : null, buildTrust: port,
          onReady: async () => null, onProgress: () => undefined, onPage: () => undefined,
        })).rejects.toThrow('reader_source_unsupported:key_unavailable');
      });
    expect(port.events).toEqual([
      { kind: 'observed', verdict: 'candidate', build: CANDIDATE },
      { kind: 'failed', verdict: 'key_scan_failed', build: CANDIDATE, reason: 'key_unavailable' },
    ]);
  });
});

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
