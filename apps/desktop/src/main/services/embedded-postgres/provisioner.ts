import { createHash } from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedPgError } from './errors.js';
import { readWithIdle, type HttpGet } from './http.js';
import { compareVersions, resolveArtifact, type DownloadArtifact } from './manifest.js';
import { EMBEDDED_PG_ADMIN_USER, EMBEDDED_PG_DATABASE, EMBEDDED_PG_MANIFEST_URL, MANAGED_CONF_MARKER, embeddedPaths } from './pin.js';
import { resetAdminPasswordViaLocalSocket } from './password.js';
import { chooseFreePort, type BindPort } from './port.js';
import type { RunProcess } from './process.js';
import { EmbeddedPostgresServer, minimalEnv } from './server.js';
import { ensurePrivateRoot, resolveEmbeddedRoot } from './root.js';
import { extractZip } from './zip.js';

export type Fs = typeof FsPromises;
export type ProvisionPhase = 'runtime' | 'download' | 'verify' | 'extract' | 'initdb' | 'start' | 'database';
export type ProvisionProgress = { phase: ProvisionPhase; receivedBytes?: number; totalBytes?: number };
export type EmbeddedConfig = { version: string; port: number };

export type ProvisionerDeps = {
  /** %ProgramData% (ASCII root for PostgreSQL); the embedded root is derived from it and the user SID. */
  programData: string | undefined;
  getSid: () => Promise<string>;
  fs: Fs;
  run: RunProcess;
  httpGet: HttpGet;
  bindPort: BindPort;
  now: () => number;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  randomBytes: (size: number) => Buffer;
  randomUUID: () => string;
  /** "major.minor" of each file, or null when the file is missing or not a regular file. */
  fileVersions: (paths: string[]) => Promise<Array<string | null>>;
  processImage: (pid: number) => Promise<string | null>;
  ensureDatabase: (adminUrl: string, database: string) => Promise<void>;
  saveBootstrap: (configuration: { databaseUrl: string; embedded: EmbeddedConfig }) => Promise<void>;
  /** Called with the started server so the application owner can stop it on quit. */
  registerServer: (server: EmbeddedPostgresServer) => void;
  manifestUrl?: string;
  idleTimeoutMs?: number;
  manifestTimeoutMs?: number;
  progressIntervalMs?: number;
};

const VC_FILES = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const nonAscii = (value: string) => /[^\x00-\x7f]/.test(value);

/** Emits phase changes immediately and byte progress at most 4 times per second. */
export function createProgressCoalescer(emit: (event: ProvisionProgress) => void, now: () => number, intervalMs = 250) {
  let lastPhase: ProvisionPhase | undefined; let lastAt = Number.NEGATIVE_INFINITY;
  return (event: ProvisionProgress) => {
    const time = now();
    const phaseChanged = event.phase !== lastPhase;
    const complete = event.totalBytes !== undefined && event.receivedBytes === event.totalBytes;
    if (phaseChanged || complete || time - lastAt >= intervalMs) { lastPhase = event.phase; lastAt = time; emit(event); }
  };
}

export function versionAtLeast(version: string | null, minimum: string): boolean {
  return version !== null && compareVersions(version, minimum) >= 0;
}

export class EmbeddedPostgresProvisioner {
  private running = false;
  private embeddedRoot = '';
  constructor(private readonly deps: ProvisionerDeps) {}

  get isRunning(): boolean { return this.running; }

  private get systemRoot(): string { return this.deps.env.SystemRoot ?? this.deps.env.SYSTEMROOT ?? 'C:\\Windows'; }

  async checkRuntime(): Promise<void> {
    const system32 = join(this.systemRoot, 'System32');
    const versions = await this.deps.fileVersions(VC_FILES.map((name) => join(system32, name)));
    if (versions.some((version) => !versionAtLeast(version, '14.30'))) throw new EmbeddedPgError('vc_runtime_missing');
  }

  /** Finds an already extracted version (never replaced by a newer one in this release). */
  private async findInstalled(): Promise<string | null> {
    const postgres = embeddedPaths(this.embeddedRoot, '0').postgres;
    let names: string[];
    try { names = await this.deps.fs.readdir(postgres); } catch { return null; }
    const versions: string[] = [];
    for (const name of names) {
      if (!/^18\.\d+$/.test(name)) continue;
      try {
        const info = JSON.parse(await this.deps.fs.readFile(embeddedPaths(this.embeddedRoot, name).installed, 'utf8')) as { version?: unknown };
        if (info.version === name) versions.push(name);
      } catch { /* incomplete directory: ignored */ }
    }
    return versions.sort(compareVersions).at(-1) ?? null;
  }

  private async exists(path: string): Promise<boolean> {
    try { await this.deps.fs.stat(path); return true; } catch { return false; }
  }

  async provision(options: { signal: AbortSignal; onProgress: (event: ProvisionProgress) => void }): Promise<EmbeddedConfig> {
    if (this.running) throw new Error('Embedded PostgreSQL provisioning is already running');
    this.running = true;
    const emit = createProgressCoalescer(options.onProgress, this.deps.now, this.deps.progressIntervalMs);
    const checkAbort = () => { if (options.signal.aborted) throw new EmbeddedPgError('pg_download_cancelled'); };
    let server: EmbeddedPostgresServer | undefined;
    try {
      // Guard first: ProgramData must be absolute and ASCII before anything else (including the download) happens.
      let sid = '';
      this.embeddedRoot = await resolveEmbeddedRoot({ programData: this.deps.programData, getSid: async () => (sid = await this.deps.getSid()) });
      emit({ phase: 'runtime' });
      await this.checkRuntime();
      checkAbort();
      // Private ACL (user + SYSTEM only) before anything is written into the root; re-applied on every provision.
      await ensurePrivateRoot({ root: this.embeddedRoot, sid, mkdir: (path) => this.deps.fs.mkdir(path, { recursive: true }), run: this.deps.run,
        env: minimalEnv(this.deps.env, join(this.systemRoot, 'System32')), systemRoot: this.systemRoot });

      let version = await this.findInstalled();
      emit({ phase: 'download' });
      if (version === null) {
        const artifact = await resolveArtifact({ manifestUrl: this.deps.manifestUrl ?? EMBEDDED_PG_MANIFEST_URL, httpGet: this.deps.httpGet,
          log: this.deps.log, timeoutMs: this.deps.manifestTimeoutMs });
        checkAbort();
        await this.install(artifact, options.signal, emit);
        version = artifact.version;
      } else {
        const offered = await resolveArtifact({ manifestUrl: this.deps.manifestUrl ?? EMBEDDED_PG_MANIFEST_URL, httpGet: this.deps.httpGet,
          log: this.deps.log, timeoutMs: this.deps.manifestTimeoutMs });
        if (compareVersions(offered.version, version) > 0) this.deps.log(`pg_update_available installed=${version} offered=${offered.version}`);
      }
      checkAbort();

      const paths = embeddedPaths(this.embeddedRoot, version);
      const env = minimalEnv(this.deps.env, paths.bin);
      const password = this.deps.randomBytes(32).toString('base64url');
      emit({ phase: 'initdb' });
      const port = await chooseFreePort(this.deps.bindPort);
      if (await this.exists(join(paths.data, 'PG_VERSION'))) {
        // An interrupted earlier run left a data directory whose password was never saved: stop an orphan and reset it.
        await new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port: 0 }, this.serverDeps()).stopOrphan({ anyPort: true });
        try {
          await resetAdminPasswordViaLocalSocket({ run: this.deps.run, fs: this.deps.fs, binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log,
            port, env: this.deps.env, password, scratchParent: this.deps.programData ?? '', sid, randomBytes: this.deps.randomBytes });
        } catch (error) {
          throw new EmbeddedPgError('pg_initdb_failed', error instanceof EmbeddedPgError ? error.detail : undefined);
        }
      } else {
        await this.initdb(paths, env, password);
      }
      checkAbort();

      await this.writeManagedSettings(paths.data, port);

      emit({ phase: 'start' });
      server = new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port }, this.serverDeps());
      await server.start();
      checkAbort();

      emit({ phase: 'database' });
      const credentials = `${EMBEDDED_PG_ADMIN_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}`;
      await this.deps.ensureDatabase(`postgresql://${credentials}/postgres?sslmode=disable`, EMBEDDED_PG_DATABASE);
      const embedded = { version, port };
      await this.deps.saveBootstrap({ databaseUrl: `postgresql://${credentials}/${EMBEDDED_PG_DATABASE}?sslmode=disable`, embedded });
      this.deps.registerServer(server);
      return embedded;
    } catch (error) {
      if (server?.isStarted) await server.stop().catch(() => undefined);
      throw error;
    } finally { this.running = false; }
  }

  private serverDeps() {
    return { run: this.deps.run, bindPort: this.deps.bindPort, env: this.deps.env, log: this.deps.log,
      readFile: (path: string) => this.deps.fs.readFile(path, 'utf8'), mkdir: (path: string) => this.deps.fs.mkdir(path, { recursive: true }),
      processImage: this.deps.processImage };
  }

  private async writeManagedSettings(data: string, port: number): Promise<void> {
    const file = join(data, 'postgresql.conf');
    let text = await this.deps.fs.readFile(file, 'utf8');
    const markerAt = text.indexOf(MANAGED_CONF_MARKER);
    if (markerAt >= 0) text = text.slice(0, markerAt);
    const block = [MANAGED_CONF_MARKER, "listen_addresses = '127.0.0.1'", `port = ${port}`, 'max_connections = 30', 'logging_collector = off', ''].join('\n');
    await this.deps.fs.writeFile(file, `${text.replace(/\s*$/, '\n')}\n${block}`, 'utf8');
  }

  private async initdb(paths: ReturnType<typeof embeddedPaths>, env: Record<string, string>, password: string): Promise<void> {
    const { fs } = this.deps;
    await fs.mkdir(paths.postgres, { recursive: true });
    try {
      const entries = await fs.readdir(paths.data);
      if (entries.length > 0) throw new EmbeddedPgError('pg_data_conflict');
    } catch (error) { if (error instanceof EmbeddedPgError) throw error; }
    const pwfile = join(paths.postgres, `pw-${this.deps.randomUUID()}.tmp`);
    await fs.writeFile(pwfile, password, { flag: 'wx', mode: 0o600 });
    try {
      const result = await this.deps.run(join(paths.bin, 'initdb.exe'), ['-D', paths.data, '-U', EMBEDDED_PG_ADMIN_USER, `--pwfile=${pwfile}`,
        '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { timeoutMs: 180_000, env });
      if (result.code !== 0 || result.timedOut) {
        this.deps.log(`pg_initdb_failed: ${result.stderr.slice(0, 500)}`);
        throw new EmbeddedPgError(nonAscii(paths.data) ? 'pg_path_unsupported' : 'pg_initdb_failed', result.stderr.slice(0, 500));
      }
    } finally { await fs.rm(pwfile, { force: true }); }
  }

  /** Download, verify, extract (skipped by the caller when `.installed.json` already exists). */
  private async install(artifact: DownloadArtifact, signal: AbortSignal, emit: (event: ProvisionProgress) => void): Promise<void> {
    const { fs } = this.deps;
    const paths = embeddedPaths(this.embeddedRoot, artifact.version);
    const zipName = artifact.url.slice(artifact.url.lastIndexOf('/') + 1);
    const partial = join(paths.downloads, `${zipName}.partial`);
    const zip = join(paths.downloads, zipName);
    await fs.mkdir(paths.downloads, { recursive: true });
    await fs.rm(partial, { force: true });
    await this.download(artifact, partial, signal, emit);
    emit({ phase: 'verify' });
    await fs.rename(partial, zip);

    emit({ phase: 'extract' });
    const staging = `${paths.install}.extract-${this.deps.randomUUID()}`;
    try {
      await fs.mkdir(staging, { recursive: true });
      await extractZip({ run: this.deps.run, tarExe: join(this.systemRoot, 'System32', 'tar.exe'), zipPath: zip, destination: staging,
        env: minimalEnv(this.deps.env, join(this.systemRoot, 'System32')), fs, signal });
      await fs.writeFile(join(staging, '.installed.json'), JSON.stringify({ version: artifact.version, sha256: artifact.sha256, source: artifact.source }));
      await fs.rm(paths.install, { recursive: true, force: true });
      await fs.rename(staging, paths.install);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      if (error instanceof EmbeddedPgError) throw error;
      throw new EmbeddedPgError('pg_extract_failed', error instanceof Error ? error.message : undefined);
    }
    await fs.rm(zip, { force: true });
  }

  private async download(artifact: DownloadArtifact, partial: string, signal: AbortSignal, emit: (event: ProvisionProgress) => void): Promise<void> {
    const { fs } = this.deps;
    const idleMs = this.deps.idleTimeoutMs ?? 60_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let handle: Awaited<ReturnType<Fs['open']>> | undefined;
    let timedOut = false;
    const timeout = () => { timedOut = true; controller.abort(); return new EmbeddedPgError('pg_download_timeout'); };
    try {
      const hash = createHash('sha256'); let received = 0;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const connectLimit = new Promise<never>((_resolve, reject) => { connectTimer = setTimeout(() => reject(timeout()), idleMs); });
      connectLimit.catch(() => undefined);
      let response;
      try { response = await Promise.race([this.deps.httpGet(artifact.url, controller.signal), connectLimit]); }
      finally { if (connectTimer) clearTimeout(connectTimer); }
      if (response.status !== 200) { response.destroy(); throw new EmbeddedPgError('pg_download_failed', `status ${response.status}`); }
      const destroyOnAbort = () => response.destroy();
      if (controller.signal.aborted) destroyOnAbort(); else controller.signal.addEventListener('abort', destroyOnAbort, { once: true });
      handle = await fs.open(partial, 'w');
      emit({ phase: 'download', receivedBytes: 0, totalBytes: artifact.size });
      for await (const chunk of readWithIdle(response, idleMs, timeout)) {
        received += chunk.byteLength;
        if (received > artifact.size) throw new EmbeddedPgError('pg_hash_mismatch', 'oversize');
        hash.update(chunk);
        await handle.write(chunk);
        emit({ phase: 'download', receivedBytes: received, totalBytes: artifact.size });
      }
      await handle.close(); handle = undefined;
      if (received !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new EmbeddedPgError('pg_hash_mismatch');
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(partial, { force: true });
      if (error instanceof EmbeddedPgError) throw error;
      if (signal.aborted) throw new EmbeddedPgError('pg_download_cancelled');
      if (timedOut) throw new EmbeddedPgError('pg_download_timeout');
      throw new EmbeddedPgError('pg_download_failed', error instanceof Error ? error.message : undefined);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
}
