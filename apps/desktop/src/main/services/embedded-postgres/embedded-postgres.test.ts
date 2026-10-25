import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddedPgError } from './errors.js';
import type { HttpGet, HttpResponse } from './http.js';
import { PINNED_ARTIFACT, resolveArtifact } from './manifest.js';
import { EMBEDDED_PG_PIN, MANAGED_CONF_MARKER } from './pin.js';
import { chooseFreePort } from './port.js';
import { runProcess, type RunProcess, type RunResult } from './process.js';
import { createProgressCoalescer, EmbeddedPostgresProvisioner, type ProvisionerDeps, type ProvisionProgress } from './provisioner.js';
import { EmbeddedPostgresServer } from './server.js';
import { deriveEmbeddedRoot, ensurePrivateRoot, resolveEmbeddedRoot } from './root.js';
import { EXTRACT_INCLUDES, extractZip, isSafeEntryName, isWantedEntry } from './zip.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr = 'boom'): RunResult => ({ code: 1, stdout: '', stderr, timedOut: false });
const EDB = (version: string) => `https://get.enterprisedb.com/postgresql/postgresql-${version}-5-windows-x64-binaries.zip`;
const LIVE_MANIFEST_BODY = '{"schema":1,"postgres":{"version":"18.6","url":"https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip","size":384620317,"sha256":"e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2"}}';

function response(chunks: Array<Buffer | string>, init: { status?: number; type?: string; hang?: boolean } = {}): HttpResponse {
  let destroyed = false; let wake: (() => void) | undefined;
  async function* body(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) { if (destroyed) throw new Error('destroyed'); yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk; }
    if (init.hang) { await new Promise<void>((resolve) => { wake = resolve; }); throw new Error('destroyed'); }
  }
  return { status: init.status ?? 200, headers: init.type === undefined ? {} : { 'content-type': init.type }, body: body(),
    destroy() { destroyed = true; wake?.(); } };
}
const manifestOf = (postgres: Record<string, unknown>) => JSON.stringify({ schema: 1, postgres });
const goodPostgres = { version: '18.7', url: EDB('18.7'), size: 10, sha256: 'a'.repeat(64) };
const noLog = () => undefined;
const manifestWith = async (body: string | HttpResponse, logs: string[] = []) => resolveArtifact({ manifestUrl: 'https://example.invalid/m.json',
  httpGet: async () => (typeof body === 'string' ? response([body], { type: 'application/json' }) : body), log: (m) => logs.push(m), timeoutMs: 50 });

describe('port selection', () => {
  it('returns the first free port in range and fails when none is free', async () => {
    const tried: number[] = [];
    expect(await chooseFreePort(async (port) => { tried.push(port); return port === 45434; })).toBe(45434);
    expect(tried).toEqual([45432, 45433, 45434]);
    await expect(chooseFreePort(async () => false)).rejects.toMatchObject({ code: 'pg_port_unavailable' });
  });
});

describe('server manifest', () => {
  it('uses a valid manifest', async () => {
    const artifact = await manifestWith(manifestOf(goodPostgres));
    expect(artifact).toEqual({ ...goodPostgres, source: 'manifest' });
  });
  it('accepts the live text/plain manifest identical to the pin', async () => {
    const artifact = await manifestWith(response([LIVE_MANIFEST_BODY], { type: 'text/plain; charset=utf-8' }));
    expect(artifact).toEqual({ ...EMBEDDED_PG_PIN, source: 'manifest' });
  });
  it('skips the fetch when the URL is empty', async () => {
    let calls = 0;
    const artifact = await resolveArtifact({ manifestUrl: '', httpGet: async () => { calls += 1; return response([]); }, log: noLog });
    expect(calls).toBe(0);
    expect(artifact).toEqual(PINNED_ARTIFACT);
  });
  it.each([
    ['wrong host', manifestOf({ ...goodPostgres, url: 'https://evil.example/postgresql/postgresql-18.7-5-windows-x64-binaries.zip' }), 'pg_manifest_url'],
    ['major 17', manifestOf({ ...goodPostgres, version: '17.9', url: EDB('17.9') }), 'pg_manifest_schema'],
    ['major 19', manifestOf({ ...goodPostgres, version: '19.1', url: EDB('19.1') }), 'pg_manifest_schema'],
    ['downgrade', manifestOf({ ...goodPostgres, version: '18.5', url: EDB('18.5') }), 'pg_manifest_downgrade'],
    ['bad hash format', manifestOf({ ...goodPostgres, sha256: 'ABC' }), 'pg_manifest_schema'],
    ['zero size', manifestOf({ ...goodPostgres, size: 0 }), 'pg_manifest_schema'],
    ['size over 1 GiB', manifestOf({ ...goodPostgres, size: 1024 ** 3 + 1 }), 'pg_manifest_schema'],
    ['extra field', JSON.stringify({ schema: 1, postgres: goodPostgres, extra: 1 }), 'pg_manifest_schema'],
    ['version/url mismatch', manifestOf({ ...goodPostgres, version: '18.8' }), 'pg_manifest_version'],
    ['non-JSON body', '<html>', 'pg_manifest_not_json'],
  ])('falls back to the pin: %s', async (_name, body, reason) => {
    const logs: string[] = [];
    expect(await manifestWith(body, logs)).toEqual(PINNED_ARTIFACT);
    expect(logs).toEqual([reason]);
  });
  it('falls back on oversize, wrong content type, redirect, error status, timeout and fetch error', async () => {
    const cases: Array<[string, HttpResponse | Error]> = [
      ['pg_manifest_oversize', response(['x'.repeat(17 * 1024)], { type: 'application/json' })],
      ['pg_manifest_not_json', response([manifestOf(goodPostgres)], { type: 'text/html' })],
      ['pg_manifest_redirect', response([], { status: 302, type: 'application/json' })],
      ['pg_manifest_status', response([], { status: 500, type: 'application/json' })],
      ['pg_manifest_timeout', response([], { type: 'application/json', hang: true })],
      ['pg_manifest_fetch', new Error('ENOTFOUND')],
    ];
    for (const [reason, value] of cases) {
      const logs: string[] = [];
      const artifact = await resolveArtifact({ manifestUrl: 'https://example.invalid/m.json', log: (m) => logs.push(m), timeoutMs: 50,
        httpGet: async () => { if (value instanceof Error) throw value; return value; } });
      expect(artifact).toEqual(PINNED_ARTIFACT);
      expect(logs).toEqual([reason]);
    }
  });
  it('times out when the connection never answers', async () => {
    const logs: string[] = [];
    const artifact = await resolveArtifact({ manifestUrl: 'https://example.invalid/m.json', log: (m) => logs.push(m), timeoutMs: 30,
      httpGet: () => new Promise<HttpResponse>(() => undefined) });
    expect(artifact).toEqual(PINNED_ARTIFACT);
    expect(logs).toEqual(['pg_manifest_timeout']);
  });
});

describe('zip extraction', () => {
  it('rejects zip-slip, absolute, drive and backslash names', () => {
    for (const name of ['pgsql/../evil.dll', '../evil', '/abs/x', 'C:/x', 'C:evil', 'pgsql\\bin\\x']) expect(isSafeEntryName(name)).toBe(false);
    expect(isSafeEntryName('pgsql/bin/postgres.exe')).toBe(true);
  });
  it('allows only bin, lib, share, the license and the two runtime DLLs', () => {
    for (const name of ['pgsql/bin/postgres.exe', 'pgsql/lib/x.dll', 'pgsql/share/a/b', 'pgsql/server_license.txt',
      'pgsql/pgAdmin 4/python/vcruntime140.dll', 'pgsql/pgAdmin 4/python/vcruntime140_1.dll']) expect(isWantedEntry(name)).toBe(true);
    for (const name of ['pgsql/pgAdmin 4/runtime/pgadmin4.exe', 'pgsql/StackBuilder/x.exe', 'pgsql/doc/a.html', 'pgsql/include/x.h', 'pgsql/pgAdmin 4/python/python.exe'])
      expect(isWantedEntry(name)).toBe(false);
  });
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'pg-zip-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const required = ['pgsql/bin/postgres.exe', 'pgsql/bin/initdb.exe', 'pgsql/bin/pg_ctl.exe'];
  it('refuses to extract when any listed name is unsafe', async () => {
    const calls: string[][] = [];
    const run: RunProcess = async (_file, args) => { calls.push([...args]); return ok([...required, 'pgsql/../../evil.dll'].join('\r\n')); };
    await expect(extractZip({ run, tarExe: 'tar.exe', zipPath: 'x.zip', destination: directory, env: {}, fs })).rejects.toMatchObject({ code: 'pg_extract_failed' });
    expect(calls).toHaveLength(1);
  });
  it('extracts with an explicit include list that skips pgAdmin, StackBuilder and doc, then keeps only the VC DLLs', async () => {
    const calls: string[][] = [];
    const run: RunProcess = async (_file, args) => {
      calls.push([...args]);
      if (args[0] === '-tf') return ok([...required, 'pgsql/pgAdmin 4/runtime/x.exe', 'pgsql/doc/a.html'].join('\r\n'));
      await fs.mkdir(join(directory, 'bin'), { recursive: true }); await fs.mkdir(join(directory, 'pgAdmin 4', 'python'), { recursive: true });
      await fs.writeFile(join(directory, 'pgAdmin 4', 'python', 'vcruntime140.dll'), 'a'); await fs.writeFile(join(directory, 'pgAdmin 4', 'python', 'vcruntime140_1.dll'), 'b');
      return ok();
    };
    await extractZip({ run, tarExe: 'tar.exe', zipPath: 'x.zip', destination: directory, env: {}, fs });
    expect(calls[1]!.slice(calls[1]!.indexOf('--strip-components=1') + 1)).toEqual([...EXTRACT_INCLUDES]);
    expect(calls[1]!.join('|')).not.toMatch(/StackBuilder|\/doc|include|pgadmin4/);
    expect(await fs.readdir(directory)).toEqual(['bin']);
    expect((await fs.readdir(join(directory, 'bin'))).sort()).toEqual(['vcruntime140.dll', 'vcruntime140_1.dll']);
  });
  it('fails when required binaries are missing from the listing', async () => {
    const run: RunProcess = async () => ok('pgsql/bin/postgres.exe');
    await expect(extractZip({ run, tarExe: 'tar.exe', zipPath: 'x.zip', destination: directory, env: {}, fs })).rejects.toMatchObject({ code: 'pg_extract_failed' });
  });
});

describe('progress coalescing', () => {
  it('emits phase changes at once and byte progress at most four times per second', () => {
    let clock = 0; const events: ProvisionProgress[] = [];
    const emit = createProgressCoalescer((event) => events.push(event), () => clock);
    emit({ phase: 'runtime' });
    for (let index = 0; index < 100; index += 1) { clock += 10; emit({ phase: 'download', receivedBytes: index, totalBytes: 1000 }); }
    emit({ phase: 'download', receivedBytes: 1000, totalBytes: 1000 });
    const downloads = events.filter((event) => event.phase === 'download');
    expect(downloads.length).toBeLessThanOrEqual(6);
    expect(events[0]).toEqual({ phase: 'runtime' });
    expect(events.at(-1)).toEqual({ phase: 'download', receivedBytes: 1000, totalBytes: 1000 });
  });
});

describe('server lifecycle', () => {
  const options = { binDirectory: 'C:\\pg\\18.6\\bin', dataDirectory: 'C:\\pg\\data', logFile: 'C:\\pg\\logs\\postgresql.log', port: 55432 };
  function harness(overrides: { status?: number; image?: string | null; pidPort?: number; bound?: boolean; stopFast?: RunResult; startResult?: RunResult } = {}) {
    const calls: string[] = [];
    const run: RunProcess = async (_file, args) => {
      const verb = args.includes('status') ? 'status' : args.includes('start') ? 'start' : `stop:${args[args.indexOf('-m') + 1]}`;
      calls.push(verb);
      if (verb === 'status') return { ...ok(), code: overrides.status ?? 3 };
      if (verb === 'start') return overrides.startResult ?? ok();
      if (verb === 'stop:fast') return overrides.stopFast ?? ok();
      return ok();
    };
    const server = new EmbeddedPostgresServer(options, { run, bindPort: async () => overrides.bound ?? true, env: {}, log: noLog,
      readFile: async () => `4242\n${options.dataDirectory}\n1\n${overrides.pidPort ?? 55432}\n`, mkdir: async () => undefined,
      processImage: async () => (overrides.image === undefined ? 'C:\\pg\\18.6\\bin\\postgres.exe' : overrides.image) });
    return { server, calls };
  }
  it('starts a stopped server and stops it fast', async () => {
    const { server, calls } = harness();
    await server.start(); await server.stop(); await server.stop();
    expect(calls).toEqual(['status', 'start', 'stop:fast']);
  });
  it('stops an orphan that is ours before starting', async () => {
    const { server, calls } = harness({ status: 0 });
    await server.start();
    expect(calls).toEqual(['status', 'stop:fast', 'start']);
  });
  it.each([['another process image', { image: 'C:\\other\\postgres.exe' }], ['unknown image', { image: null }]])(
    'never touches a running postmaster with %s', async (_name, overrides) => {
      const { server, calls } = harness({ status: 0, ...overrides });
      await expect(server.start()).rejects.toMatchObject({ code: 'pg_port_in_use' });
      expect(calls).toEqual(['status']);
    });
  it('fails with pg_port_in_use when the saved port is taken', async () => {
    const { server, calls } = harness({ bound: false });
    await expect(server.start()).rejects.toMatchObject({ code: 'pg_port_in_use' });
    expect(calls).toEqual(['status']);
  });
  it('maps start failures, with pg_path_unsupported for non-ASCII paths', async () => {
    await expect(harness({ startResult: failed() }).server.start()).rejects.toMatchObject({ code: 'pg_start_failed' });
    const calls: string[] = [];
    const nonAscii = new EmbeddedPostgresServer({ ...options, dataDirectory: 'C:\\使用者\\data' }, { run: async (_f, args) => { calls.push(args.join(' ')); return args.includes('status') ? { ...ok(), code: 3 } : failed(); },
      bindPort: async () => true, env: {}, log: noLog, readFile: async () => '', mkdir: async () => undefined, processImage: async () => null });
    await expect(nonAscii.start()).rejects.toMatchObject({ code: 'pg_path_unsupported' });
  });
  it('escalates to immediate on a fast-stop timeout and reports pg_stop_timeout when that fails too', async () => {
    const slow = harness({ stopFast: { code: null, stdout: '', stderr: '', timedOut: true } });
    await slow.server.start(); await slow.server.stop();
    expect(slow.calls).toEqual(['status', 'start', 'stop:fast', 'stop:immediate']);
    const broken: RunProcess = async (_f, args) => (args.includes('status') ? { ...ok(), code: 3 } : args.includes('start') ? ok() : failed());
    const server = new EmbeddedPostgresServer(options, { run: broken, bindPort: async () => true, env: {}, log: noLog, readFile: async () => '', mkdir: async () => undefined, processImage: async () => null });
    await server.start();
    await expect(server.stop()).rejects.toMatchObject({ code: 'pg_stop_timeout' });
  });
});

describe('process runner', () => {
  it('kills a child that exceeds its timeout and awaits its exit', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300, env: {} });
    expect(result.timedOut).toBe(true);
  });
  it('passes stdin and captures output without a shell', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 10_000, env: {}, input: 'hello' });
    expect(result).toMatchObject({ code: 0, stdout: 'hello', timedOut: false });
  });
});

describe('provisioner', () => {
  const body = Buffer.from('fake-postgres-zip');
  const sha = createHash('sha256').update(body).digest('hex');
  const manifest = manifestOf({ version: '18.7', url: EDB('18.7'), size: body.length, sha256: sha });
  let root: string;
  const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  let base = '';
  beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'pg-prov-')); base = join(root, 'LineAgentAssistant', 'postgres', SID); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function build(overrides: { download?: () => HttpResponse; running?: { value: boolean }; vc?: Array<string | null>; startFails?: boolean } = {}) {
    const calls: Array<{ exe: string; args: string[]; input?: string | undefined }> = [];
    const state = { zipRequests: 0, pwfileSeen: '', saved: [] as unknown[], registered: 0, databases: [] as string[], logs: [] as string[], running: false };
    const httpGet: HttpGet = async (url) => {
      if (url.includes('manifest')) return response([manifest], { type: 'text/plain; charset=utf-8' });
      state.zipRequests += 1;
      return overrides.download ? overrides.download() : response([body]);
    };
    const run: RunProcess = async (file, args, options) => {
      const exe = basename(file).toLowerCase();
      calls.push({ exe, args: [...args], input: options.input });
      if (exe === 'tar.exe') {
        if (args[0] === '-tf') return ok(['pgsql/bin/postgres.exe', 'pgsql/bin/initdb.exe', 'pgsql/bin/pg_ctl.exe'].join('\n'));
        const destination = args[args.indexOf('-C') + 1]!;
        await fs.mkdir(join(destination, 'bin'), { recursive: true }); await fs.mkdir(join(destination, 'pgAdmin 4', 'python'), { recursive: true });
        for (const name of ['postgres.exe', 'initdb.exe', 'pg_ctl.exe']) await fs.writeFile(join(destination, 'bin', name), 'x');
        for (const name of ['vcruntime140.dll', 'vcruntime140_1.dll']) await fs.writeFile(join(destination, 'pgAdmin 4', 'python', name), 'x');
        return ok();
      }
      if (exe === 'initdb.exe') {
        const pwfile = args.find((arg) => arg.startsWith('--pwfile='))!.slice('--pwfile='.length);
        state.pwfileSeen = await fs.readFile(pwfile, 'utf8');
        const data = args[args.indexOf('-D') + 1]!;
        await fs.mkdir(data, { recursive: true }); await fs.writeFile(join(data, 'PG_VERSION'), '18'); await fs.writeFile(join(data, 'postgresql.conf'), '#conf\nmax_connections = 100\n');
        return ok();
      }
      if (exe === 'pg_ctl.exe') {
        if (args.includes('status')) return { ...ok(), code: state.running ? 0 : 3 };
        if (args.includes('start')) { if (overrides.startFails) return failed(); state.running = true; return ok(); }
        state.running = false; return ok();
      }
      return ok();
    };
    let clock = 0;
    const deps: ProvisionerDeps = { programData: root, getSid: async () => SID, fs, run, httpGet, bindPort: async (port) => port !== 45432, now: () => (clock += 1000),
      env: { SystemRoot: 'C:\\Windows' }, log: (message) => state.logs.push(message), randomBytes: (size) => Buffer.alloc(size, 7), randomUUID: () => crypto.randomUUID(),
      fileVersions: async (paths) => overrides.vc ?? paths.map(() => '14.38'), processImage: async () => join(base, '18.7', 'bin', 'postgres.exe'),
      ensureDatabase: async (_url, name) => { state.databases.push(name); },
      saveBootstrap: async (configuration) => { state.saved.push(configuration); }, registerServer: () => { state.registered += 1; },
      manifestUrl: 'https://example.invalid/manifest.json', idleTimeoutMs: 40, manifestTimeoutMs: 200 };
    const provisioner = new EmbeddedPostgresProvisioner(deps);
    const go = (signal = new AbortController().signal, events: ProvisionProgress[] = []) => provisioner.provision({ signal, onProgress: (event) => events.push(event) });
    return { go, state, calls, root: () => root, provisioner };
  }
  const downloadsLeft = async () => { try { return await fs.readdir(join(base, 'downloads')); } catch { return []; } };

  it('downloads, verifies, extracts, initializes, starts and saves the bootstrap', async () => {
    const { go, state, calls } = build();
    const events: ProvisionProgress[] = [];
    const result = await go(undefined, events);
    expect(result).toEqual({ version: '18.7', port: 45433 });
    expect(JSON.parse(await fs.readFile(join(base, '18.7', '.installed.json'), 'utf8'))).toEqual({ version: '18.7', sha256: sha, source: 'manifest' });
    expect(await downloadsLeft()).toEqual([]);
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining(['runtime', 'download', 'verify', 'extract', 'initdb', 'start', 'database']));
    const conf = await fs.readFile(join(base, 'data', 'postgresql.conf'), 'utf8');
    expect(conf).toContain(MANAGED_CONF_MARKER);
    expect(conf).toContain("listen_addresses = '127.0.0.1'");
    expect(conf).toContain('port = 45433');
    expect(conf).toContain('max_connections = 30');
    expect(conf).toContain('logging_collector = off');
    const password = state.pwfileSeen;
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(password);
    expect(calls.find((call) => call.exe === 'initdb.exe')!.args).toEqual(expect.arrayContaining(['-U', 'line_agent_admin', '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C']));
    expect((await fs.readdir(base)).filter((name) => name.startsWith('pw-'))).toEqual([]);
    expect(state.databases).toEqual(['line_agent']);
    expect(state.saved).toEqual([{ databaseUrl: `postgresql://line_agent_admin:${password}@127.0.0.1:45433/line_agent?sslmode=disable`, embedded: { version: '18.7', port: 45433 } }]);
    expect(state.registered).toBe(1);
  });

  it('reports vc_runtime_missing before any download', async () => {
    const { go, state } = build({ vc: ['14.38', null, '14.38'] });
    await expect(go()).rejects.toMatchObject({ code: 'vc_runtime_missing' });
    expect(state.zipRequests).toBe(0);
    const old = build({ vc: ['14.20', '14.38', '14.38'] });
    await expect(old.go()).rejects.toMatchObject({ code: 'vc_runtime_missing' });
  });

  it('deletes the file and fails with pg_hash_mismatch on a wrong hash', async () => {
    const { go } = build({ download: () => response([Buffer.from('tampered-contents')]) });
    await expect(go()).rejects.toMatchObject({ code: 'pg_hash_mismatch' });
    expect(await downloadsLeft()).toEqual([]);
    expect(await fs.readdir(base).catch(() => [])).not.toContain('18.7');
  });

  it('refuses redirects and error statuses', async () => {
    const { go } = build({ download: () => response([], { status: 302 }) });
    await expect(go()).rejects.toMatchObject({ code: 'pg_download_failed' });
    expect(await downloadsLeft()).toEqual([]);
  });

  it('times out a stalled download and removes the partial file', async () => {
    const { go } = build({ download: () => response([body.subarray(0, 4)], { hang: true }) });
    await expect(go()).rejects.toMatchObject({ code: 'pg_download_timeout' });
    expect(await downloadsLeft()).toEqual([]);
  });

  it('cancels a running download and removes the partial file', async () => {
    const controller = new AbortController();
    const { go } = build({ download: () => response([body.subarray(0, 4)], { hang: true }) });
    const promise = go(controller.signal, []);
    const outcome = promise.catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 10);
    expect(await outcome).toMatchObject({ code: 'pg_download_cancelled' });
    expect(await downloadsLeft()).toEqual([]);
  });

  it('skips download and initdb when the install and data already exist, resetting the unknown password', async () => {
    const first = build();
    await first.go();
    const second = build();
    await second.go();
    expect(second.state.zipRequests).toBe(0);
    expect(second.calls.some((call) => call.exe === 'initdb.exe')).toBe(false);
    expect(second.calls.some((call) => call.exe === 'postgres.exe')).toBe(false);
    const reset = second.calls.find((call) => call.exe === 'psql.exe');
    expect(reset?.args).toEqual(expect.arrayContaining(['-U', 'line_agent_admin', '-d', 'postgres', '-f', '-']));
    expect(reset?.input).toMatch(/^ALTER ROLE line_agent_admin PASSWORD 'SCRAM-SHA-256\$4096:[^']+';\n$/);
    expect(JSON.stringify(second.calls.map((call) => call.args))).not.toContain(Buffer.alloc(32, 7).toString('base64url'));
    expect(reset?.input).not.toContain(Buffer.alloc(32, 7).toString('base64url'));
    const conf = await fs.readFile(join(base, 'data', 'postgresql.conf'), 'utf8');
    expect(conf.split(MANAGED_CONF_MARKER)).toHaveLength(2);
  });

  it('never deletes a non-empty data directory without PG_VERSION', async () => {
    await fs.mkdir(join(base, 'data'), { recursive: true });
    await fs.writeFile(join(base, 'data', 'precious.txt'), 'keep');
    const { go, calls } = build();
    await expect(go()).rejects.toMatchObject({ code: 'pg_data_conflict' });
    expect(await fs.readFile(join(base, 'data', 'precious.txt'), 'utf8')).toBe('keep');
    expect(calls.some((call) => call.exe === 'initdb.exe')).toBe(false);
  });

  it('stops the server it started when a later step fails, and registers nothing', async () => {
    const { go, state } = build({ startFails: true });
    await expect(go()).rejects.toBeInstanceOf(EmbeddedPgError);
    expect(state.registered).toBe(0);
    expect(state.saved).toEqual([]);
  });

  it('allows only one provisioning at a time', async () => {
    const { go } = build({ download: () => response([body.subarray(0, 4)], { hang: true }) });
    const first = go().catch((error: unknown) => error);
    await expect(go()).rejects.toThrow(/already running/);
    await first;
  });
});

describe('ASCII ProgramData root and private ACL', () => {
  const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  it('derives the ProgramData LineAgentAssistant postgres SID root', () => {
    expect(deriveEmbeddedRoot('C:\\ProgramData', SID)).toBe(join('C:\\ProgramData', 'LineAgentAssistant', 'postgres', SID));
  });
  it.each(['', 'S-1-1-0', 'S-1-5-21', 'S-1-5-21-1/../x', 'S-1-5-21-1-2;calc', `S-1-5-${'1-'.repeat(16)}1`, 'x'])('rejects the invalid SID %j', (sid) => {
    expect(() => deriveEmbeddedRoot('C:\\ProgramData', sid)).toThrow(EmbeddedPgError);
  });
  it.each([[undefined], ['ProgramData'], ['C:\\程式資料']])('guards ProgramData %j with pg_path_unsupported', async (programData) => {
    await expect(resolveEmbeddedRoot({ programData, getSid: async () => SID })).rejects.toMatchObject({ code: 'pg_path_unsupported' });
  });
  it('grants only the user and SYSTEM, without inheritance, through an argument array', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const made: string[] = [];
    await ensurePrivateRoot({ root: 'C:\\PD\\root', sid: SID, mkdir: async (path) => { made.push(path); }, env: {}, systemRoot: 'C:\\Windows',
      run: async (file, args) => { calls.push({ file, args: [...args] }); return ok(); } });
    expect(made).toEqual(['C:\\PD\\root']);
    expect(calls).toEqual([{ file: join('C:\\Windows', 'System32', 'icacls.exe'),
      args: ['C:\\PD\\root', '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'] }]);
  });
  const harness = (programData: string, icacls: RunResult) => {
    const calls: string[] = [];
    const run: RunProcess = async (file) => { calls.push(basename(file).toLowerCase()); return basename(file).toLowerCase() === 'icacls.exe' ? icacls : ok(); };
    const requests: string[] = [];
    const deps: ProvisionerDeps = { programData, getSid: async () => SID, fs, run, httpGet: async (url) => { requests.push(url); return response([]); },
      bindPort: async () => true, now: () => 0, env: { SystemRoot: 'C:\\Windows' }, log: noLog, randomBytes: (size) => Buffer.alloc(size, 1), randomUUID: () => crypto.randomUUID(),
      fileVersions: async (paths) => paths.map(() => '14.38'), processImage: async () => null, ensureDatabase: async () => undefined,
      saveBootstrap: async () => undefined, registerServer: () => undefined, manifestUrl: 'https://example.invalid/manifest.json' };
    return { provisioner: new EmbeddedPostgresProvisioner(deps), calls, requests };
  };
  it('fails with pg_acl_failed and writes nothing after a failed icacls', async () => {
    const programData = await fs.mkdtemp(join(tmpdir(), 'pg-acl-'));
    try {
      const { provisioner, calls, requests } = harness(programData, failed('denied'));
      await expect(provisioner.provision({ signal: new AbortController().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: 'pg_acl_failed' });
      expect(requests).toEqual([]);
      expect(calls).toEqual(['icacls.exe']);
      const root = join(programData, 'LineAgentAssistant', 'postgres', SID);
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(programData, { recursive: true, force: true }); }
  });
  it('fails with pg_path_unsupported before any download for a non-ASCII ProgramData', async () => {
    const { provisioner, calls, requests } = harness('C:\\程式資料', ok());
    await expect(provisioner.provision({ signal: new AbortController().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: 'pg_path_unsupported' });
    expect(requests).toEqual([]);
    expect(calls).toEqual([]);
  });
});
