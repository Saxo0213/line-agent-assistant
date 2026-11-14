// Minimal CDP client over --remote-debugging-pipe. Chrome reads on fd 3 and writes on fd 4.
// Each JSON message ends with one NUL byte. This module kills only the Chrome process that it started.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { BridgeError } from './errors.js';

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  readonly method: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const GRACEFUL_CLOSE_MS = 4_000;

export class CdpPipe {
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #toChrome: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Map<string, Set<CdpEventHandler>>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;

  private constructor(child: ChildProcess, toChrome: Writable, fromChrome: Readable) {
    this.#child = child;
    this.#toChrome = toChrome;
    this.pid = child.pid ?? 0;
    this.#exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        this.#closed = true;
        // The real exit code goes into the error text for diagnostics.
        this.#failAll(new BridgeError('CDP_CLOSED', `Chrome process ended (exit code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
        resolve();
      });
    });
    fromChrome.on('data', (chunk: Buffer) => this.#onData(chunk));
    fromChrome.on('error', () => undefined);
    toChrome.on('error', () => undefined);
  }

  /** Starts Chrome with the given arguments and connects to its pipe. */
  static async start(chromePath: string, args: readonly string[]): Promise<CdpPipe> {
    const child = spawn(chromePath, [...args], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(new BridgeError('CHROME_START_FAILED', error.message, { cause: error })));
    });
    const toChrome = child.stdio[3] as Writable | null | undefined;
    const fromChrome = child.stdio[4] as Readable | null | undefined;
    if (!toChrome || !fromChrome) {
      if (child.pid) await killTree(child.pid);
      throw new BridgeError('CHROME_START_FAILED', 'Chrome pipe is not available');
    }
    return new CdpPipe(child, toChrome, fromChrome);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new BridgeError('CDP_CLOSED', `${method}: Chrome process ended`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError('CDP_TIMEOUT', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      this.#toChrome.write(`${message}\0`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(new BridgeError('CDP_CLOSED', `${method}: write failed`, { cause: error }));
      });
    });
  }

  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.#handlers.get(method);
    if (!set) {
      set = new Set();
      this.#handlers.set(method, set);
    }
    const handlers = set;
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Asks Chrome to close, then kills the process tree of this Chrome only. Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.#closed) {
      await this.send('Browser.close', {}, undefined, GRACEFUL_CLOSE_MS).catch(() => undefined);
      await Promise.race([this.#exited, new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_CLOSE_MS))]);
    }
    if (this.pid && this.#child.exitCode === null && this.#child.signalCode === null) await killTree(this.pid);
    await Promise.race([this.#exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    this.#closed = true;
    this.#failAll(new BridgeError('CDP_CLOSED', 'bridge closed'));
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let end = this.#buffer.indexOf(0);
    while (end !== -1) {
      const raw = this.#buffer.subarray(0, end).toString('utf8');
      this.#buffer = this.#buffer.subarray(end + 1);
      if (raw.length > 0) this.#dispatch(raw);
      end = this.#buffer.indexOf(0);
    }
  }

  #dispatch(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new BridgeError('CDP_ERROR', `${pending.method}: ${message.error.message ?? 'error'} (${message.error.code ?? 0})`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params ?? {}, message.sessionId);
    }
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already ended
    }
    resolve();
  });
}
