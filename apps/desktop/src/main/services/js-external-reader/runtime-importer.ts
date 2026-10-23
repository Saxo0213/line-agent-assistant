import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OfficialSnapshotImporter } from '../../connected-facade.js';
import { JsExternalReaderController } from './controller.js';
import { FileOwnerReadyMarkerStore, type OwnerProcessIdentity } from './owner-ready-session.js';
import { verifyJsExternalReaderResources } from './resources.js';
import type { ExternalSourceProbeAdmission } from '../external-source-probe-admission.js';
import type { ProcessLiveness } from './stale-owner-marker-reconciliation.js';
import type { ImportCursor } from './protocol.js';
import type { OfficialBuildTrustPort } from '../official-build-trust.js';

const execFileAsync = promisify(execFile);
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const REQUEST_STARTUP_TIMEOUT_MS = 45_000;

export function mapOfficialIdentityRead(identity: Readonly<{ mid: string; displayName: string | null; picturePath?: string | null }>, candidateCount: number) {
  return { status: 'supported' as const, mid: identity.mid, displayName: identity.displayName,
    ...(identity.picturePath === undefined ? {} : { picturePath: identity.picturePath }), candidateCount };
}

export async function createJsOfficialSnapshotImporter(input: Readonly<{
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  localAppData: string | undefined;
  admission: ExternalSourceProbeAdmission;
  /** Persisted official-build trust; omitted means seeds only and no promotion. */
  buildTrust?: OfficialBuildTrustPort;
}>): Promise<OfficialSnapshotImporter> {
  if (process.platform !== 'win32' || !input.localAppData || !path.isAbsolute(input.localAppData)) {
    throw new Error('reader_resource_integrity_failed');
  }
  const resourceRoot = input.packaged
    ? path.join(input.resourcesPath, 'app.asar.unpacked', 'dist', 'js-external-reader', 'v1')
    : path.join(input.appPath, 'dist', 'js-external-reader', 'v1');
  const resources = await verifyJsExternalReaderResources(resourceRoot);
  const controller = new JsExternalReaderController(input.admission);
  const requestRoot = path.join(input.localAppData, 'LINEJS', 'js-external-imports');
  const mainIdentity = await inspectProcess(process.pid);
  if (!mainIdentity || path.resolve(mainIdentity.imagePath).toLowerCase() !== path.resolve(process.execPath).toLowerCase()) {
    throw new Error('reader_main_identity_invalid');
  }

  return {
    async verifyOfficialSource(request) {
      if (request.signal.aborted) throw new Error('reader_cancelled');
      const requestId = randomUUID().replaceAll('-', '');
      const markerStore = new FileOwnerReadyMarkerStore(requestRoot, requestId, ensurePrivateDirectory);
      await ensurePrivateDirectory(requestRoot);
      const verdict = await controller.verifyOfficialSourceHandshake({
        bridgePath: resources.bridgePath,
        requestRoot,
        requestId,
        expectedMid: request.expectedMid,
        deadlineUnixMs: Date.now() + REQUEST_STARTUP_TIMEOUT_MS,
        mainIdentity,
        markerStore,
        inspectProcess,
        signal: request.signal,
        ...(input.buildTrust ? { buildTrust: input.buildTrust } : {}),
      });
      return verdict.status === 'supported' ? { status: 'supported' } : { status: 'unsupported', errorCode: verdict.errorCode };
    },
    async readOfficialIdentity(request) {
      if (request.signal.aborted) throw new Error('reader_cancelled');
      const requestId = randomUUID().replaceAll('-', '');
      const markerStore = new FileOwnerReadyMarkerStore(requestRoot, requestId, ensurePrivateDirectory);
      await ensurePrivateDirectory(requestRoot);
      const verdict = await controller.readOfficialIdentityHandshake({
        bridgePath: resources.bridgePath,
        requestRoot,
        requestId,
        deadlineUnixMs: Date.now() + REQUEST_STARTUP_TIMEOUT_MS,
        mainIdentity,
        markerStore,
        inspectProcess,
        signal: request.signal,
        ...(request.onPhase ? { onPhase: request.onPhase } : {}),
        ...(input.buildTrust ? { buildTrust: input.buildTrust } : {}),
      });
      if (verdict.status !== 'supported') return { status: 'unsupported', errorCode: verdict.errorCode };
      if (!verdict.identity) throw new Error('reader_inventory_result_invalid');
      return mapOfficialIdentityRead(verdict.identity, verdict.candidateCount);
    },
    async readOfficialSnapshot(request) {
      if (request.signal.aborted) throw new Error('reader_cancelled');
      const requestId = randomUUID().replaceAll('-', '');
      const deadlineUnixMs = Date.now() + REQUEST_STARTUP_TIMEOUT_MS;
      const markerStore = new FileOwnerReadyMarkerStore(requestRoot, requestId, ensurePrivateDirectory);
      return controller.readOfficialSnapshot({
        bridgePath: resources.bridgePath,
        requestRoot,
        requestId,
        expectedMid: request.expectedMid,
        deadlineUnixMs,
        mainIdentity,
        markerStore,
        inspectProcess,
        ...(input.buildTrust ? { buildTrust: input.buildTrust } : {}),
        beforeCreate: async ({ signal }) => {
          if (signal.aborted) throw new Error('reader_cancelled');
          await ensurePrivateDirectory(requestRoot);
          if (signal.aborted) throw new Error('reader_cancelled');
        },
        signal: request.signal,
        onReady: request.onReady,
        onProgress: request.onProgress,
        // The facade's committers must reach the controller: without them a catalog page fails the first
        // import and the directory pass (friend names, titles) would never be stored.
        ...(request.onCatalogPage ? { onCatalogPage: request.onCatalogPage } : {}),
        ...(request.onDirectoryPage ? { onDirectoryPage: request.onDirectoryPage } : {}),
        onPage: request.onPage,
      });
    },
    async readOfficialMonitor(request) {
      if (request.signal.aborted) throw new Error('reader_cancelled');
      const requestId = randomUUID().replaceAll('-', '');
      const deadlineUnixMs = Date.now() + REQUEST_STARTUP_TIMEOUT_MS;
      const markerStore = new FileOwnerReadyMarkerStore(requestRoot, requestId, ensurePrivateDirectory);
      return controller.readOfficialMonitor({
        bridgePath: resources.bridgePath,
        requestRoot,
        requestId,
        expectedMid: request.expectedMid,
        sourceIdentityDigest: request.sourceIdentityDigest,
        cursor: request.cursor as ImportCursor | null,
        deadlineUnixMs,
        mainIdentity,
        markerStore,
        inspectProcess,
        ...(input.buildTrust ? { buildTrust: input.buildTrust } : {}),
        beforeCreate: async ({ signal }) => {
          if (signal.aborted) throw new Error('reader_cancelled');
          await ensurePrivateDirectory(requestRoot);
          if (signal.aborted) throw new Error('reader_cancelled');
        },
        signal: request.signal,
        ...(request.onReady ? { onReady: request.onReady } : {}),
        ...(request.onDirectoryPage ? { onDirectoryPage: request.onDirectoryPage } : {}),
        onProgress: request.onProgress,
        onPage: request.onPage,
      });
    },
  };
}

async function queryProcessLiveness(pid: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) return { kind: 'unknown' };
  const script = `$ErrorActionPreference='Stop'; try { ` +
    `$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; ` +
    `if($null -eq $p){ [Console]::Out.WriteLine('absent'); exit 0 }; ` +
    `$started=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString(); ` +
    `if($started -notmatch '^\\d{15,20}$'){ exit 4 }; ` +
    `[Console]::Out.WriteLine('present|'+$started); exit 0 ` +
    `} catch { exit 5 }`;
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: PROCESS_IDENTITY_TIMEOUT_MS, maxBuffer: 1024,
    });
    const value = result.stdout.trim();
    if (value === 'absent') return { kind: 'absent' };
    const match = /^present\|(\d{15,20})$/.exec(value);
    return match ? { kind: 'present', startedAt: match[1]! } : { kind: 'unknown' };
  } catch { return { kind: 'unknown' }; }
}

async function inspectProcess(pid: number): Promise<OwnerProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) return null;
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    `if(!$c -or !$c.ExecutablePath){exit 3}; ` +
    `[Console]::Out.WriteLine($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()); ` +
    `[Console]::Out.WriteLine($c.ExecutablePath)`;
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: PROCESS_IDENTITY_TIMEOUT_MS, maxBuffer: 4096,
    });
    const [startedAt, imagePath] = result.stdout.trimEnd().split(/\r?\n/);
    if (!startedAt || !/^\d{15,20}$/.test(startedAt) || !imagePath || !path.isAbsolute(imagePath) || imagePath.includes('\0')) return null;
    const info = await lstat(imagePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 512 * 1024 * 1024 ||
        path.resolve(await realpath(imagePath)).toLowerCase() !== path.resolve(imagePath).toLowerCase()) return null;
    const hash = createHash('sha256');
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(imagePath);
      stream.on('data', (chunk: Buffer | string) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += data.byteLength;
        if (bytes > info.size || bytes > 512 * 1024 * 1024) stream.destroy(new Error('reader_process_image_invalid'));
        else hash.update(data);
      });
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    if (bytes !== info.size) return null;
    return { pid, startedAt, imagePath, imageSha256: hash.digest('hex') };
  } catch { return null; }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(current)) !== path.resolve(current)) {
      throw new Error('reader_owner_directory_invalid');
    }
  }
  const escaped = resolved.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ` +
    `$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'))); ` +
    `$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$inherit,'None','Allow'))); ` +
    `Set-Acl -LiteralPath '${escaped}' -AclObject $acl; 'restricted'`;
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: PROCESS_IDENTITY_TIMEOUT_MS, maxBuffer: 1024,
  });
  if (result.stdout.trim() !== 'restricted') throw new Error('reader_owner_directory_invalid');
}
