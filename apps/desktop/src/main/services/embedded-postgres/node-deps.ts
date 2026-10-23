import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedPgError } from './errors.js';
import { httpGet } from './http.js';
import { resolveEmbeddedRoot } from './root.js';
import { bindPort } from './port.js';
import { runProcess } from './process.js';
import type { ProvisionerDeps } from './provisioner.js';
import { minimalEnv, type ServerDeps } from './server.js';

function powershellPath(env: Record<string, string | undefined>): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** "major.minor" of each file through the Windows version resource; null for a missing or non-regular file. */
export function createFileVersions(env: Record<string, string | undefined>) {
  return async (paths: string[]): Promise<Array<string | null>> => {
    const regular: string[] = [];
    for (const path of paths) { try { if ((await fs.lstat(path)).isFile()) regular.push(path); } catch { /* missing */ } }
    if (regular.length !== paths.length) return paths.map((path) => (regular.includes(path) ? '0.0' : null));
    const quoted = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(',');
    const script = `foreach ($f in @(${quoted})) { $v = (Get-Item -LiteralPath $f).VersionInfo; "$($v.FileMajorPart).$($v.FileMinorPart)" }`;
    const result = await runProcess(powershellPath(env), ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 20_000, env: minimalEnv(env, join(env.SystemRoot ?? 'C:\\Windows', 'System32')) });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return paths.map((_path, index) => (/^\d+\.\d+$/.test(lines[index] ?? '') ? lines[index]! : null));
  };
}

export function createProcessImage(env: Record<string, string | undefined>): ServerDeps['processImage'] {
  return async (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const result = await runProcess(powershellPath(env), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`],
      { timeoutMs: 20_000, env: minimalEnv(env, join(env.SystemRoot ?? 'C:\\Windows', 'System32')) });
    const line = result.stdout.split(/\r?\n/)[0]?.trim();
    return result.code === 0 && line ? line : null;
  };
}

export function createServerDeps(env: Record<string, string | undefined>, log: (message: string) => void): ServerDeps {
  return { run: runProcess, bindPort, env, log, readFile: (path) => fs.readFile(path, 'utf8'),
    mkdir: (path) => fs.mkdir(path, { recursive: true }), processImage: createProcessImage(env) };
}

/** SID of the current process token (`whoami /user`), validated by the caller. */
export function createSidReader(env: Record<string, string | undefined>): () => Promise<string> {
  return async () => {
    const system32 = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
    const result = await runProcess(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 20_000, env: minimalEnv(env, system32) });
    const fields = result.stdout.trim().split(/\r?\n/)[0]?.match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1)) ?? [];
    const sid = fields[1];
    if (result.code !== 0 || !sid) throw new EmbeddedPgError('pg_acl_failed', 'cannot read the current SID');
    return sid;
  };
}

/** Embedded root of the current user, derived like the provisioner does (no path is persisted). */
export async function resolveCurrentEmbeddedRoot(env: Record<string, string | undefined> = process.env): Promise<string> {
  return resolveEmbeddedRoot({ programData: env.ProgramData ?? env.PROGRAMDATA, getSid: createSidReader(env) });
}

export function createNodeProvisionerDeps(options: Pick<ProvisionerDeps, 'ensureDatabase' | 'saveBootstrap' | 'registerServer' | 'log'>
  & { env?: Record<string, string | undefined> }): ProvisionerDeps {
  const env = options.env ?? process.env;
  return { programData: env.ProgramData ?? env.PROGRAMDATA, getSid: createSidReader(env), fs, run: runProcess, httpGet, bindPort, now: () => Date.now(), env, log: options.log,
    randomBytes, randomUUID, fileVersions: createFileVersions(env), processImage: createProcessImage(env),
    ensureDatabase: options.ensureDatabase, saveBootstrap: options.saveBootstrap, registerServer: options.registerServer };
}
