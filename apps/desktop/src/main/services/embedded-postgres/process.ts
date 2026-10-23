import { spawn, type ChildProcess } from 'node:child_process';

export type RunOptions = { timeoutMs: number; env?: Record<string, string>; input?: string; cwd?: string; signal?: AbortSignal | undefined };
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type RunProcess = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

const OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Spawns with an argument array (no shell), hidden window, a hard timeout that kills the child, and awaits exit. */
export const runProcess: RunProcess = (file, args, options) => new Promise<RunResult>((resolve, reject) => {
  let child: ChildProcess;
  try {
    child = spawn(file, [...args], { shell: false, windowsHide: true, env: options.env ?? {}, cwd: options.cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch (error) { reject(error); return; }
  let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
  const append = (current: string, chunk: Buffer) => (current.length < OUTPUT_LIMIT ? current + chunk.toString('utf8') : current);
  child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  const onAbort = () => { child.kill(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
    child.stdout?.destroy(); child.stderr?.destroy();
    action();
  };
  child.once('error', (error) => finish(() => reject(error)));
  child.once('exit', (code) => finish(() => resolve({ code, stdout, stderr, timedOut })));
  if (options.input !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.input); }
});
