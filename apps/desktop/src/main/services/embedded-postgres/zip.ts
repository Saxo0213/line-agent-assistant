import type { copyFile, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedPgError } from './errors.js';
import type { RunProcess } from './process.js';

export type ZipFs = { lstat: typeof lstat; readdir: typeof readdir; copyFile: typeof copyFile; rm: typeof rm };

const VC_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll'] as const;
/** The only archive members ever extracted. bsdtar matches a directory name recursively. */
export const EXTRACT_INCLUDES: readonly string[] = Object.freeze([
  'pgsql/bin', 'pgsql/lib', 'pgsql/share', 'pgsql/server_license.txt',
  ...VC_DLLS.map((name) => `pgsql/pgAdmin 4/python/${name}`),
]);
const REQUIRED = ['pgsql/bin/postgres.exe', 'pgsql/bin/initdb.exe', 'pgsql/bin/pg_ctl.exe'];

/** Zip-slip check for one archive member name. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

/** True when the member belongs to the extraction allow-list. */
export function isWantedEntry(name: string): boolean {
  return EXTRACT_INCLUDES.some((item) => name === item || name === `${item}/` || name.startsWith(`${item}/`));
}

export function parseListing(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

async function assertNoLinks(directory: string, fs: ZipFs): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await fs.lstat(path);
    if (info.isSymbolicLink()) throw new EmbeddedPgError('pg_extract_failed', 'reparse point');
    if (info.isDirectory()) await assertNoLinks(path, fs);
  }
}

/**
 * Extracts the allow-listed members of the verified zip into `destination` (without the `pgsql/` prefix) using
 * Windows bsdtar. Names are validated from the listing first; links are rejected afterwards.
 */
export async function extractZip(options: { run: RunProcess; tarExe: string; zipPath: string; destination: string;
  env: Record<string, string>; fs: ZipFs; timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<void> {
  const { run, tarExe, zipPath, destination, env, fs } = options;
  const listing = await run(tarExe, ['-tf', zipPath], { timeoutMs: 120_000, env, signal: options.signal });
  if (listing.code !== 0 || listing.timedOut) throw new EmbeddedPgError('pg_extract_failed', listing.stderr.slice(0, 500));
  const names = parseListing(listing.stdout);
  if (names.some((name) => !isSafeEntryName(name))) throw new EmbeddedPgError('pg_extract_failed', 'unsafe entry name');
  for (const required of REQUIRED) if (!names.includes(required)) throw new EmbeddedPgError('pg_extract_failed', `missing ${required}`);
  const result = await run(tarExe, ['-xf', zipPath, '-C', destination, '--strip-components=1', ...EXTRACT_INCLUDES],
    { timeoutMs: options.timeoutMs ?? 600_000, env, signal: options.signal });
  if (result.code !== 0 || result.timedOut) throw new EmbeddedPgError('pg_extract_failed', result.stderr.slice(0, 500));
  await assertNoLinks(destination, fs);
  for (const name of VC_DLLS) await fs.copyFile(join(destination, 'pgAdmin 4', 'python', name), join(destination, 'bin', name));
  await fs.rm(join(destination, 'pgAdmin 4'), { recursive: true, force: true });
}
