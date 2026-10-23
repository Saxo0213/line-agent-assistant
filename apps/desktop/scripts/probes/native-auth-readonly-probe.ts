import { Pool } from 'pg';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapSettings } from '../../src/main/services/bootstrap-settings.js';
import type { SecretBackend } from '../../src/main/services/secret-store.js';
import { createLinejsProviderClient, runBoundedNativeAuthProbe, runNativeCandidateHelper, runProviderValidation } from './native-auth-readonly.js';

class BoundedCurrentUserDpapiBackend implements SecretBackend {
  constructor(private readonly signal: AbortSignal, private readonly deadlineUnixMs: number) {}
  async protect(): Promise<Uint8Array> { throw new Error('dpapi_protect_not_permitted'); }
  async unprotect(protectedBytes: Uint8Array): Promise<Uint8Array> {
    if (process.platform !== 'win32') throw new Error('windows_dpapi_required');
    if (this.signal.aborted) throw new Error('probe_cancelled');
    const script = `Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $output=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($output))`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ['LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value && value.length <= 4096 && !value.includes('\0')) environment[key] = value;
    }
    const executable = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment, shell: false });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let exited = false;
    let failure: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let rejectClose: ((error: Error) => void) | undefined;
    const shutdownGraceMs = 500;
    const closePromise = new Promise<number | null>((resolve, reject) => {
      rejectClose = reject;
      child.once('close', (code) => { exited = true; resolve(code); });
    });
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      try { child.kill(); } catch { /* only this owned DPAPI helper is targeted */ }
      stopTimer = setTimeout(() => {
        if (exited) return;
        try { child.kill('SIGKILL'); } catch { /* process may already be closed */ }
        shutdownTimer = setTimeout(() => {
          if (!exited) { failure = new Error('dpapi_shutdown_failed'); rejectClose?.(failure); }
        }, shutdownGraceMs);
      }, shutdownGraceMs);
    };
    const onAbort = () => stop(new Error('probe_cancelled'));
    this.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024) stop(new Error('dpapi_output_too_large'));
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', () => undefined);
    child.once('error', () => stop(new Error('dpapi_unavailable')));
    child.stdin.once('error', () => stop(new Error('dpapi_unavailable')));
    const remainingMs = Math.min(5_000, this.deadlineUnixMs - Date.now());
    if (remainingMs <= 0) stop(new Error('native_candidate_timeout'));
    else timeout = setTimeout(() => stop(new Error('native_candidate_timeout')), remainingMs);
    if (this.signal.aborted) onAbort();
    const input = Buffer.from(protectedBytes).toString('base64');
    child.stdin.end(input, 'ascii');
    try {
      const code = await closePromise;
      if (failure) throw failure;
      if (code !== 0 || outputBytes === 0) throw new Error('dpapi_unavailable');
      const encodedPlaintext = Buffer.concat(output).toString('ascii');
      if (encodedPlaintext.length > 24 * 1024 || encodedPlaintext.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedPlaintext)) {
        throw new Error('dpapi_output_invalid');
      }
      return Buffer.from(encodedPlaintext, 'base64');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      this.signal.removeEventListener('abort', onAbort);
      for (const chunk of output) chunk.fill(0);
      output.length = 0;
    }
  }
}

async function readExpectedPrimaryMid(signal: AbortSignal, deadlineUnixMs: number): Promise<string> {
  const configuration = await new BootstrapSettings(process.env,
    new BoundedCurrentUserDpapiBackend(signal, deadlineUnixMs)).load();
  if (!configuration) throw new Error('bootstrap_unavailable');
  const remainingMs = Math.min(5_000, deadlineUnixMs - Date.now());
  if (signal.aborted || remainingMs <= 0) throw new Error('native_candidate_timeout');
  const pool = new Pool({ connectionString: configuration.databaseUrl, max: 1, connectionTimeoutMillis: remainingMs,
    idleTimeoutMillis: 5_000, statement_timeout: remainingMs, query_timeout: remainingMs });
  try {
    if (signal.aborted) throw new Error('probe_cancelled');
    const result = await pool.query<{ own_mid: string }>(
      `SELECT own_mid FROM line_accounts
       WHERE product_role='PRIMARY_ADMIN' AND connection_mode='EXTERNAL_MONITOR'
         AND source_transition_state='STABLE' AND own_mid IS NOT NULL
       LIMIT 2`);
    if (result.rows.length !== 1 || !/^u[0-9a-fA-F]{32}$/.test(result.rows[0]!.own_mid)) {
      throw new Error('expected_account_unavailable');
    }
    return result.rows[0]!.own_mid;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const deadlineUnixMs = Date.now() + 90_000;
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const executablePath = join(dirname(fileURLToPath(import.meta.url)), 'official-auth-candidate.exe');
    const result = await runBoundedNativeAuthProbe({ deadlineUnixMs, signal: controller.signal,
      readExpectedMid: readExpectedPrimaryMid,
      acquireCandidates: (signal, deadline, onDuration) => runNativeCandidateHelper({ executablePath, signal,
        timeoutMs: Math.min(22_000, deadline - Date.now()), onDuration }),
      validate: ({ expectedMid, candidates, signal, deadlineUnixMs: deadline }) => runProviderValidation({
        candidates, expectedMid, deadlineUnixMs: deadline, signal,
        createClient: (candidate, context) => createLinejsProviderClient({ application: candidate.application,
          budget: context.budget, signal: context.signal }) }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'failed', candidatesTried: 0, matchedAccount: false,
      obsAuthorizationReceived: false, failure: controller.signal.aborted ? 'cancelled' : 'provider_failure',
      requestsAttempted: 0, maxConcurrentRequests: 0, nativeAcquisitionDurationMs: 0 })}\n`);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

void main();
