import { dirname, join, normalize } from 'node:path';
import { EmbeddedPgError } from './errors.js';
import { chooseFreePort, type BindPort } from './port.js';
import type { RunProcess } from './process.js';

export type ServerDeps = {
  run: RunProcess;
  bindPort: BindPort;
  readFile: (path: string) => Promise<string>;
  mkdir: (path: string) => Promise<unknown>;
  /** Full path of the executable image of a process, or null when it cannot be determined. */
  processImage: (pid: number) => Promise<string | null>;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
};

export function minimalEnv(env: Record<string, string | undefined>, binDirectory: string): Record<string, string> {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const result: Record<string, string> = { SystemRoot: systemRoot, windir: systemRoot,
    PATH: `${binDirectory};${join(systemRoot, 'System32')}` };
  const temp = env.TEMP ?? env.TMP;
  if (temp) { result.TEMP = temp; result.TMP = temp; }
  return result;
}

const nonAscii = (value: string) => /[^\x00-\x7f]/.test(value);


/**
 * Owns exactly one postmaster for the embedded data directory. No poller, no watchdog, no restart loop:
 * every `pg_ctl` child is awaited with a hard timeout.
 */
export class EmbeddedPostgresServer {
  private started = false;
  private usedPort: number;
  constructor(private readonly options: { binDirectory: string; dataDirectory: string; logFile: string; port: number }, private readonly deps: ServerDeps) { this.usedPort = options.port; }

  get isStarted(): boolean { return this.started; }
  /** The port the server runs on after `start`; the configured port before. */
  get port(): number { return this.usedPort; }

  private pgCtl(args: string[], timeoutMs: number) {
    return this.deps.run(join(this.options.binDirectory, 'pg_ctl.exe'), ['-D', this.options.dataDirectory, ...args],
      { timeoutMs, env: minimalEnv(this.deps.env, this.options.binDirectory) });
  }

  /** Port number recorded on line 4 of postmaster.pid, with the pid on line 1. */
  private async readPostmasterPid(): Promise<{ pid: number; port: number } | null> {
    try {
      const lines = (await this.deps.readFile(join(this.options.dataDirectory, 'postmaster.pid'))).split(/\r?\n/);
      const pid = Number(lines[0]); const port = Number(lines[3]);
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(port) ? { pid, port } : null;
    } catch { return null; }
  }

  /**
   * A postmaster already running on this data directory is an orphan from a previous app session. It is ours only if
   * its port (unless `anyPort`) and process image match; then it is stopped. Returns true when one was stopped.
   */
  async stopOrphan(options: { anyPort?: boolean } = {}): Promise<boolean> {
    const status = await this.pgCtl(['status'], 20_000);
    if (status.code !== 0) return false;
    const info = await this.readPostmasterPid();
    const image = info ? await this.deps.processImage(info.pid) : null;
    const expected = normalize(join(this.options.binDirectory, 'postgres.exe')).toLowerCase();
    if (!info || (!options.anyPort && info.port !== this.options.port) || !image || normalize(image).toLowerCase() !== expected) {
      throw new EmbeddedPgError('pg_port_in_use', 'running postmaster is not ours');
    }
    const stopped = await this.pgCtl(['stop', '-m', 'fast', '-w', '-t', '30'], 35_000);
    if (stopped.code !== 0 || stopped.timedOut) throw new EmbeddedPgError('pg_stop_timeout', stopped.stderr.slice(0, 500));
    return true;
  }

  /**
   * Starts on the stored port, passed on the command line so `bootstrap.json` stays the one port authority. With
   * `fallbackPorts`, a stored port that cannot be bound is replaced by the first free port of the range (the caller
   * persists the new port, see `port`). A running postmaster of ours on any port is stopped first.
   */
  async start(options: { fallbackPorts?: boolean } = {}): Promise<void> {
    await this.stopOrphan({ anyPort: true });
    let port = this.options.port;
    if (!(await this.deps.bindPort(port))) {
      if (options.fallbackPorts !== true) throw new EmbeddedPgError('pg_port_in_use');
      port = await chooseFreePort(this.deps.bindPort, port);
    }
    await this.deps.mkdir(dirname(this.options.logFile));
    const result = await this.pgCtl(['-l', this.options.logFile, '-o', `-p ${port}`, '-w', '-t', '60', 'start'], 75_000);
    if (result.code !== 0 || result.timedOut) {
      this.deps.log('pg_start_failed');
      throw new EmbeddedPgError(nonAscii(this.options.dataDirectory) || nonAscii(this.options.binDirectory) ? 'pg_path_unsupported' : 'pg_start_failed',
        result.stderr.slice(0, 500));
    }
    this.usedPort = port;
    this.started = true;
  }

  /** `fast` first, `immediate` on timeout; bounded at 45 s in total. */
  async stop(): Promise<void> {
    if (!this.started) return;
    const fast = await this.pgCtl(['stop', '-m', 'fast', '-w', '-t', '30'], 33_000);
    if (fast.code !== 0 || fast.timedOut) {
      this.deps.log('pg_stop_fast_failed');
      const immediate = await this.pgCtl(['stop', '-m', 'immediate', '-w', '-t', '8'], 11_000);
      if (immediate.code !== 0 || immediate.timedOut) throw new EmbeddedPgError('pg_stop_timeout', immediate.stderr.slice(0, 500));
    }
    this.started = false;
  }
}

