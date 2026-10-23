import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LineWorkerEvent } from '@line-agent/contracts';

export type WorkerSecrets = Extract<LineWorkerEvent, { type: 'secretRotation' }>['secrets'];

export interface SecretBackend {
  protect(plain: Uint8Array): Promise<Uint8Array>;
  unprotect(cipher: Uint8Array): Promise<Uint8Array>;
}

type RotationJob = { workerInstanceId: string; loginAttemptId: string; secrets: WorkerSecrets;
  resolve(value: boolean): void; reject(error: unknown): void };

async function runDpapi(operation: 'Protect' | 'Unprotect', data: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== 'win32') throw new Error('DPAPI secret backend is Windows-only');
  const script = `Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $output=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($output))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`DPAPI operation failed: ${Buffer.concat(errors).toString('utf8').slice(0, 200)}`)); return; }
      try { resolve(Buffer.from(Buffer.concat(output).toString('utf8').trim(), 'base64')); }
      catch (error) { reject(error); }
    });
    child.stdin.end(Buffer.from(data).toString('base64'));
  });
}

export class DpapiUserSecretBackend implements SecretBackend {
  protect(plain: Uint8Array): Promise<Uint8Array> { return runDpapi('Protect', plain); }
  unprotect(cipher: Uint8Array): Promise<Uint8Array> { return runDpapi('Unprotect', cipher); }
}

export class SecretStore {
  private readonly attempts = new Map<string, { workerInstanceId: string; loginAttemptId: string }>();
  private readonly rotationLanes = new Map<string, Promise<void>>();
  private readonly pendingRotations = new Map<string, RotationJob>();
  private roomActivationKey: Promise<Buffer> | undefined;
  constructor(private readonly root: string, private readonly backend: SecretBackend = new DpapiUserSecretBackend()) {}

  beginLogin(accountId: string, workerInstanceId: string, loginAttemptId: string): void {
    this.validAccount(accountId);
    this.attempts.set(accountId, { workerInstanceId, loginAttemptId });
  }

  async closeLogin(accountId: string, workerInstanceId: string, loginAttemptId: string): Promise<void> {
    this.validAccount(accountId);
    const active = this.attempts.get(accountId);
    if (active?.workerInstanceId !== workerInstanceId || active.loginAttemptId !== loginAttemptId) return;
    this.attempts.delete(accountId);
    this.pendingRotations.get(accountId)?.resolve(false);
    this.pendingRotations.delete(accountId);
  }

  async saveRotation(accountId: string, workerInstanceId: string, loginAttemptId: string, secrets: WorkerSecrets): Promise<boolean> {
    this.validAccount(accountId);
    const expected = this.attempts.get(accountId);
    if (expected?.workerInstanceId !== workerInstanceId || expected.loginAttemptId !== loginAttemptId) return false;
    return await new Promise<boolean>((resolve, reject) => {
      this.pendingRotations.get(accountId)?.resolve(false);
      this.pendingRotations.set(accountId, { workerInstanceId, loginAttemptId, secrets: structuredClone(secrets), resolve, reject });
      if (!this.rotationLanes.has(accountId)) {
        const lane = Promise.resolve().then(() => this.drainRotations(accountId));
        this.rotationLanes.set(accountId, lane);
        void lane.finally(() => { if (this.rotationLanes.get(accountId) === lane) this.rotationLanes.delete(accountId); });
      }
    });
  }

  private async drainRotations(accountId: string): Promise<void> {
    const folder = join(this.root, 'secrets');
    await mkdir(folder, { recursive: true });
    while (this.pendingRotations.has(accountId)) {
      const job = this.pendingRotations.get(accountId)!;
      this.pendingRotations.delete(accountId);
      const current = () => {
        const active = this.attempts.get(accountId);
        return active?.workerInstanceId === job.workerInstanceId && active.loginAttemptId === job.loginAttemptId;
      };
      try {
        if (!current() || this.pendingRotations.has(accountId)) { job.resolve(false); continue; }
        const cipher = await this.backend.protect(Buffer.from(JSON.stringify(job.secrets), 'utf8'));
        if (!current() || this.pendingRotations.has(accountId)) { job.resolve(false); continue; }
        const temporary = join(folder, `${accountId}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, cipher, { mode: 0o600, flag: 'wx' });
          if (!current() || this.pendingRotations.has(accountId)) { job.resolve(false); continue; }
          await rename(temporary, join(folder, `${accountId}.bin`));
          job.resolve(true);
        } finally { await rm(temporary, { force: true }); }
      } catch (error) { job.reject(error); }
    }
  }

  async load(accountId: string): Promise<WorkerSecrets | null> {
    this.validAccount(accountId);
    let cipher: Buffer;
    try { cipher = await readFile(join(this.root, 'secrets', `${accountId}.bin`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const plain = await this.backend.unprotect(cipher);
    return JSON.parse(Buffer.from(plain).toString('utf8')) as WorkerSecrets;
  }

  loadOrCreateRoomActivationDigestKey(): Promise<Buffer> {
    return this.roomActivationKey ??= this.readOrCreateRoomActivationDigestKey();
  }

  private async readOrCreateRoomActivationDigestKey(): Promise<Buffer> {
    const folder = join(this.root, 'secrets');
    const path = join(folder, 'room-activation-key.bin');
    await mkdir(folder, { recursive: true });
    const decode = async (cipher: Buffer): Promise<Buffer> => {
      const key = Buffer.from(await this.backend.unprotect(cipher));
      if (key.length !== 32) throw new Error('Stored room activation digest key is invalid');
      return key;
    };
    try { return await decode(await readFile(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const key = randomBytes(32);
    const cipher = Buffer.from(await this.backend.protect(key));
    try {
      await writeFile(path, cipher, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return decode(await readFile(path));
    }
  }

  async clear(accountId: string): Promise<void> {
    this.validAccount(accountId);
    this.attempts.delete(accountId);
    this.pendingRotations.get(accountId)?.resolve(false);
    this.pendingRotations.delete(accountId);
    await (this.rotationLanes.get(accountId) ?? Promise.resolve());
    await rm(join(this.root, 'secrets', `${accountId}.bin`), { force: true });
  }

  private validAccount(accountId: string): void {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw new Error('Invalid account identity');
  }
}
