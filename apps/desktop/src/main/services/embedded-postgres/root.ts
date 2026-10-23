import { isAbsolute, join } from 'node:path';
import { EmbeddedPgError } from './errors.js';
import type { RunProcess } from './process.js';

export const SID_PATTERN = /^S-1-5-\d+(-\d+){1,14}$/;
const SYSTEM_SID = 'S-1-5-18';
const nonAscii = (value: string) => /[^\x00-\x7f]/.test(value);

export function isValidSid(value: string): boolean {
  return SID_PATTERN.test(value);
}

/**
 * `%ProgramData%\LineAgentAssistant\postgres\<SID>`. PostgreSQL on Windows needs ASCII paths for both binaries and data,
 * so the root never lives under the user profile. Derived on every start; bootstrap.json stores no path.
 */
export function deriveEmbeddedRoot(programData: string | undefined, sid: string): string {
  if (!programData || !isAbsolute(programData)) throw new EmbeddedPgError('pg_path_unsupported', 'ProgramData missing or relative');
  if (!isValidSid(sid)) throw new EmbeddedPgError('pg_acl_failed', 'invalid SID');
  const root = join(programData, 'LineAgentAssistant', 'postgres', sid);
  if (nonAscii(root)) throw new EmbeddedPgError('pg_path_unsupported', 'non-ASCII root');
  return root;
}

export async function resolveEmbeddedRoot(options: { programData: string | undefined; getSid: () => Promise<string> }): Promise<string> {
  // Check ProgramData before asking for the SID so a bad location fails before anything else happens.
  if (!options.programData || !isAbsolute(options.programData) || nonAscii(options.programData)) {
    throw new EmbeddedPgError('pg_path_unsupported', 'ProgramData missing, relative or non-ASCII');
  }
  return deriveEmbeddedRoot(options.programData, await options.getSid());
}

/** Creates the SID folder and restricts it to that user and SYSTEM before anything else is written into it. */
export async function ensurePrivateRoot(options: { root: string; sid: string; mkdir: (path: string) => Promise<unknown>; run: RunProcess;
  env: Record<string, string>; systemRoot: string }): Promise<void> {
  if (!isValidSid(options.sid)) throw new EmbeddedPgError('pg_acl_failed', 'invalid SID');
  await options.mkdir(options.root);
  const result = await options.run(join(options.systemRoot, 'System32', 'icacls.exe'),
    [options.root, '/inheritance:r', '/grant:r', `*${options.sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`], { timeoutMs: 30_000, env: options.env });
  if (result.code !== 0 || result.timedOut) throw new EmbeddedPgError('pg_acl_failed', result.stderr.slice(0, 500));
}
