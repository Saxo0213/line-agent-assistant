import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { BootstrapConfiguration } from '../bootstrap-settings.js';
import { isValidEmbeddedPassword } from '../../../setup-protocol.js';
import { EmbeddedPgError } from './errors.js';
import { EMBEDDED_PG_ADMIN_USER } from './pin.js';
import type { RunProcess } from './process.js';
import { ensurePrivateRoot } from './root.js';
import { minimalEnv } from './server.js';

const SCRAM_ITERATIONS = 4096;

/**
 * PostgreSQL SCRAM-SHA-256 verifier; the plaintext password never reaches the server or its logs. The password is
 * hashed as given: callers accept printable ASCII only, where SASLprep is the identity.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const alterRoleSql = (verifier: string): string => {
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('Invalid password verifier');
  return `ALTER ROLE ${EMBEDDED_PG_ADMIN_USER} PASSWORD '${verifier}'`;
};

export type PasswordPool = { query(sql: string): Promise<unknown>; end(): Promise<void> };

/** One short-lived connection with the given credentials; only the verifier is sent. */
export async function setRolePassword(createPool: (url: string) => PasswordPool, databaseUrl: string, verifier: string): Promise<void> {
  const sql = alterRoleSql(verifier);
  const pool = createPool(databaseUrl);
  try { await pool.query(sql); } finally { await pool.end().catch(() => undefined); }
}

function passwordOf(databaseUrl: string): string { return decodeURIComponent(new URL(databaseUrl).password); }

function withPassword(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl);
  return `${url.protocol}//${url.username}:${encodeURIComponent(password)}@${url.host}${url.pathname}${url.search}`;
}

export type PasswordChangeDeps = {
  load(): Promise<BootstrapConfiguration | null>;
  save(configuration: BootstrapConfiguration): Promise<void>;
  setRolePassword(databaseUrl: string, verifier: string): Promise<void>;
  log(message: string): void;
};

/**
 * ALTER ROLE with the current credentials, then save bootstrap with the new URL. A failed save puts the old password
 * back (connecting with the new one). The caller restarts the application afterwards.
 */
export async function changeEmbeddedPassword(deps: PasswordChangeDeps, password: string): Promise<void> {
  if (!isValidEmbeddedPassword(password)) throw new EmbeddedPgError('pg_password_invalid');
  const current = await deps.load();
  if (!current?.embedded) throw new EmbeddedPgError('pg_not_embedded');
  const oldPassword = passwordOf(current.databaseUrl);
  const newUrl = withPassword(current.databaseUrl, password);
  try { await deps.setRolePassword(current.databaseUrl, scramSha256Verifier(password)); }
  catch { deps.log('pg_password_change_failed'); throw new EmbeddedPgError('pg_password_change_failed'); }
  try { await deps.save({ ...current, databaseUrl: newUrl }); }
  catch {
    deps.log('pg_password_save_failed');
    try { await deps.setRolePassword(newUrl, scramSha256Verifier(oldPassword)); } catch { deps.log('pg_password_rollback_failed'); }
    throw new EmbeddedPgError('pg_password_save_failed');
  }
}

export type LocalSocketResetOptions = {
  run: RunProcess;
  fs: { mkdir(path: string, options: { recursive: boolean }): Promise<unknown>; writeFile(path: string, data: string): Promise<unknown>; rm(path: string, options: { recursive: boolean; force: boolean }): Promise<unknown> };
  binDirectory: string;
  dataDirectory: string;
  logFile: string;
  /** Port of the embedded server; only the Unix-socket file name uses it (nothing listens on TCP during the reset). */
  port: number;
  env: Record<string, string | undefined>;
  password: string;
  /** Short ASCII parent for the private temporary directory (%ProgramData%): a Unix socket path is limited to about 100 characters. */
  scratchParent: string;
  sid: string;
  randomBytes: (size: number) => Buffer;
};

/**
 * Resets the admin password without `postgres --single` (PostgreSQL refuses to run under an administrator token).
 * The stopped server is started by `pg_ctl` (restricted token) with options only: no TCP listener, a Unix socket in a
 * private temporary directory and a temporary HBA file allowing `local ... trust` for the admin role. `psql` then reads
 * the SCRAM verifier from stdin. The real pg_hba.conf and postgresql.conf are never modified. The caller must have
 * stopped the server first. The server is stopped and the temporary directory removed on every path.
 */
export async function resetAdminPasswordViaLocalSocket(options: LocalSocketResetOptions): Promise<void> {
  const systemRoot = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? 'C:\\Windows';
  const scratch = join(options.scratchParent, `lapw-${options.randomBytes(6).toString('hex')}`);
  // The path travels inside one pg_ctl -o string: no spaces, quotes or non-ASCII characters.
  if (!/^[A-Za-z0-9:_\\/.~-]+$/.test(scratch)) throw new EmbeddedPgError('pg_path_unsupported', 'scratch path');
  const posix = scratch.replace(/\\/g, '/');
  const hba = `${posix}/pg_hba.local.conf`;
  const env = minimalEnv(options.env, options.binDirectory);
  const pgCtl = join(options.binDirectory, 'pg_ctl.exe');
  const sql = `${alterRoleSql(scramSha256Verifier(options.password))};\n`;
  let attempted = false;
  let failed = true;
  try {
    await ensurePrivateRoot({ root: scratch, sid: options.sid, mkdir: (path) => options.fs.mkdir(path, { recursive: true }), run: options.run,
      env: minimalEnv(options.env, join(systemRoot, 'System32')), systemRoot });
    await options.fs.writeFile(join(scratch, 'pg_hba.local.conf'), `local all ${EMBEDDED_PG_ADMIN_USER} trust\n`);
    await options.fs.mkdir(dirname(options.logFile), { recursive: true });
    attempted = true;
    const serverOptions = `-c listen_addresses= -c unix_socket_directories=${posix} -c hba_file=${hba} -c port=${options.port}`;
    const started = await options.run(pgCtl, ['-D', options.dataDirectory, '-l', options.logFile, '-w', '-t', '60', '-o', serverOptions, 'start'],
      { timeoutMs: 75_000, env });
    if (started.code !== 0 || started.timedOut) throw new EmbeddedPgError('pg_start_failed', started.stderr.slice(0, 500));
    const applied = await options.run(join(options.binDirectory, 'psql.exe'),
      ['-h', posix, '-p', String(options.port), '-U', EMBEDDED_PG_ADMIN_USER, '-d', 'postgres', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      { timeoutMs: 60_000, env, input: sql });
    if (applied.code !== 0 || applied.timedOut) throw new EmbeddedPgError('pg_password_change_failed', applied.stderr.slice(0, 500));
    failed = false;
  } finally {
    let stopFailure: EmbeddedPgError | undefined;
    if (attempted) {
      try {
        const stopped = await options.run(pgCtl, ['-D', options.dataDirectory, 'stop', '-m', 'fast', '-w', '-t', '30'], { timeoutMs: 35_000, env });
        if (stopped.code !== 0 || stopped.timedOut) stopFailure = new EmbeddedPgError('pg_stop_timeout', stopped.stderr.slice(0, 500));
      } catch { stopFailure = new EmbeddedPgError('pg_stop_timeout'); }
    }
    await options.fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    // A stop failure after a successful reset must surface; during another failure that error stays the reported one.
    if (stopFailure && !failed) throw stopFailure;
  }
}

/**
 * Embedded startup: connect; on SQLSTATE 28P01 run `recover` once (stop, reset to the bootstrap password, start) and
 * connect again. A second failure is returned to the caller unchanged.
 */
export async function connectWithPasswordRecovery<T>(options: { connect(): Promise<T>; recover(): Promise<void> }): Promise<T> {
  try { return await options.connect(); }
  catch (error) {
    if ((error as { code?: unknown } | null)?.code !== '28P01') throw error;
  }
  await options.recover();
  return options.connect();
}

export { passwordOf as passwordFromDatabaseUrl };
