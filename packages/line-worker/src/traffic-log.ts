import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Local log of the HTTP requests that this process sends to LINE hosts.
 *
 * The log only observes. It uses the undici diagnostics channels. It never reads, clones or consumes
 * a request body or a response body. It never makes a request. Each handler catches all errors,
 * because a subscriber that throws would raise an uncaught exception in the request path.
 */

export type TrafficProcessKind = 'worker' | 'main';
export type TrafficTransport = 'DESKTOPWIN' | 'CHROMEOS' | null;
export type TrafficBodyKind = 'none' | 'buffer' | 'string' | 'stream' | 'other';

export type TrafficRecord = Readonly<{
  ts: string;
  durationMs: number;
  process: TrafficProcessKind;
  pid: number;
  transport: TrafficTransport;
  accountRef: string | null;
  method: string;
  origin: string;
  path: string;
  queryKeys: string[];
  httpVersion: '1.1' | '2' | null;
  requestLine: string | null;
  headers: Array<[string, string]> | null;
  /** True when content-length or transfer-encoding was added by this log, because undici writes them after the diagnostics message. */
  framingDerived: boolean;
  obsParams: { keys: string[]; types: Record<string, string> } | null;
  body: { kind: TrafficBodyKind; length: number | null; sha256: string | null };
  jsonShape?: unknown;
  label: string | null;
  status?: number;
  error?: string;
}>;

export type TrafficLogOptions = Readonly<{
  /** Directory for the JSONL files. */
  directory: string;
  processKind: TrafficProcessKind;
  transport: TrafficTransport;
  /** The log stores only the first 12 hex characters of the SHA-256 of this value. */
  accountId?: string;
  /** Replaces the file append. Tests use it to make the writer fail. */
  appendLines?: (file: string, text: string) => Promise<void>;
  /** Replaces the exit flush. Tests use it to make the writer fail. */
  appendLinesSync?: (file: string, text: string) => void;
  now?: () => Date;
  pid?: number;
  flushIntervalMs?: number;
  maxQueuedRecords?: number;
}>;

export type TrafficLogHandle = Readonly<{
  /** Writes all queued records. It never rejects. */
  flush(): Promise<void>;
  /** Unsubscribes, flushes and stops the timer. It never rejects. */
  stop(): Promise<void>;
  stats(): { written: number; dropped: number };
}>;

/** The adapter sets this label around each LINE RPC dispatch. The create channel runs in the caller async context. */
export const trafficLabel = new AsyncLocalStorage<string>();

const LINE_HOST_SUFFIXES = ['.line-apps.com', '.line-scdn.net', '.line.me', '.line.naver.jp', '.naver.jp'] as const;
const LINE_HOST_ROOTS = ['line-apps.com', 'line-scdn.net', 'line.me', 'line.naver.jp', 'naver.jp'] as const;
const SECRET_HEADERS: ReadonlySet<string> = new Set(['x-line-access', 'x-hmac', 'cookie', 'authorization',
  'x-line-channeltoken', 'x-talk-meta', 'x-line-session-id']);
const MAX_HASHED_BODY_BYTES = 1024 * 1024;
const MAX_JSON_ARRAY_ELEMENTS = 20;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 2000;
const DEFAULT_MAX_QUEUED_RECORDS = 20_000;

export function isLineHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return LINE_HOST_ROOTS.some((root) => host === root) || LINE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function hostnameOfOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(origin);
  return match?.[1] ?? null;
}

const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function accountRefOf(accountId: string): string {
  return sha256Hex(accountId).slice(0, 12);
}

const MID = /^[ucr][0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIdSegment(segment: string): boolean {
  if (MID.test(segment) || UUID.test(segment) || segment.startsWith('reqid-')) return true;
  if (/^\d{8,}$/.test(segment)) return true;
  return segment.length > 24 && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

/** Replaces id-like path segments with a short hash. The query string is not part of the result. */
export function redactPath(path: string): { path: string; queryKeys: string[] } {
  const queryStart = path.indexOf('?');
  const pathOnly = queryStart < 0 ? path : path.slice(0, queryStart);
  const query = queryStart < 0 ? '' : path.slice(queryStart + 1).split('#')[0] ?? '';
  const queryKeys = query === '' ? [] : query.split('&').filter((pair) => pair !== '').map((pair) => {
    const key = pair.split('=')[0] ?? '';
    try { return decodeURIComponent(key); } catch { return key; }
  });
  const redacted = pathOnly.split('/').map((segment) => isIdSegment(segment) ? `<id:${sha256Hex(segment).slice(0, 8)}>` : segment).join('/');
  return { path: redacted, queryKeys };
}

function valueTypeOf(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function describeObsParams(value: string): TrafficRecord['obsParams'] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    return { keys: entries.map(([key]) => key), types: Object.fromEntries(entries.map(([key, item]) => [key, valueTypeOf(item)])) };
  } catch { return null; }
}

export function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  return SECRET_HEADERS.has(lower) || lower.includes('token') || lower === 'x-obs-params'
    ? `<redacted:${value.length}>` : value;
}

/** Structure of a JSON value with keys in order. A leaf shows its type and length, never its value. */
export function jsonShapeOf(value: unknown): unknown {
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return '<truncated>';
    if (item === null) return 'null';
    if (Array.isArray(item)) return item.slice(0, MAX_JSON_ARRAY_ELEMENTS).map((element) => walk(element, depth + 1));
    switch (typeof item) {
      case 'string': return `string:${item.length}`;
      case 'number': return `number:${String(item).length}`;
      case 'boolean': return 'boolean';
      case 'object': return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, walk(child, depth + 1)]));
      default: return typeof item;
    }
  };
  return walk(value, 0);
}

type UndiciRequest = {
  method?: unknown; origin?: unknown; path?: unknown; body?: unknown; contentLength?: unknown; contentType?: unknown;
};

type Pending = {
  ts: string;
  startedAt: number;
  label: string | null;
  method: string;
  origin: string;
  rawPath: string;
  body: TrafficRecord['body'];
  jsonShape?: unknown;
  contentLength: number | null;
  block?: string;
};

function classifyBody(request: UndiciRequest): { body: TrafficRecord['body']; jsonText: string | null } {
  const contentLength = typeof request.contentLength === 'number' ? request.contentLength : null;
  const raw = request.body;
  if (raw === null || raw === undefined) return { body: { kind: 'none', length: contentLength, sha256: null }, jsonText: null };
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const kind: TrafficBodyKind = typeof raw === 'string' ? 'string' : 'buffer';
    const length = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
    if (length > MAX_HASHED_BODY_BYTES) return { body: { kind, length, sha256: null }, jsonText: null };
    return { body: { kind, length, sha256: sha256Hex(raw) }, jsonText: typeof raw === 'string' ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8') };
  }
  // fetch wraps every body in an async generator. Its bytes cannot be seen without a read, so only the length is known.
  const iterable = typeof (raw as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    || typeof (raw as { pipe?: unknown }).pipe === 'function' || typeof (raw as { getReader?: unknown }).getReader === 'function';
  if (iterable && contentLength === null) return { body: { kind: 'stream', length: null, sha256: null }, jsonText: null };
  return { body: { kind: 'other', length: contentLength, sha256: null }, jsonText: null };
}

/** Adds the framing headers that undici writes after it publishes the header block. */
function derivedFraming(method: string, pending: Pending): Array<[string, string]> {
  const expectsPayload = ['PUT', 'POST', 'PATCH', 'QUERY', 'PROPFIND', 'PROPPATCH'].includes(method);
  let length = pending.contentLength;
  if (length === 0 && !expectsPayload) length = null;
  if (pending.body.kind === 'none') return length === 0 ? [['content-length', '0']] : [];
  return length === null ? [['transfer-encoding', 'chunked']] : [['content-length', String(length)]];
}

function parseBlock(block: string): { requestLine: string | null; httpVersion: '1.1' | '2'; lines: Array<[string, string]> } {
  const rows = block.split('\r\n').filter((row) => row !== '');
  const first = rows[0] ?? '';
  const isH1 = /^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(first);
  const lines: Array<[string, string]> = [];
  for (const row of isH1 ? rows.slice(1) : rows) {
    const separator = row.indexOf(':', row.startsWith(':') ? 1 : 0);
    if (separator <= 0) continue;
    lines.push([row.slice(0, separator), row.slice(separator + 1).replace(/^ /, '')]);
  }
  return { requestLine: isH1 ? first : null, httpVersion: isH1 ? '1.1' : '2', lines };
}

function labelFromPath(path: string): string | null {
  const match = /\/thrift\/[^/]+\/[^/]+\/([A-Za-z0-9_]+)$/.exec(path.split('?')[0] ?? '');
  return match?.[1] ?? null;
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name || error.name : typeof (error as { name?: unknown })?.name === 'string' ? String((error as { name: string }).name) : '';
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error';
}

const pad = (value: number): string => String(value).padStart(2, '0');
function dayOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

let active: TrafficLogHandle | undefined;

/** Starts the log in this process. A second call returns the running log. */
export function startTrafficLog(options: TrafficLogOptions): TrafficLogHandle {
  if (active) return active;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const accountRef = options.accountId === undefined ? null : accountRefOf(options.accountId);
  const appendLines = options.appendLines ?? ((file, text) => appendFile(file, text, 'utf8'));
  const appendLinesSync = options.appendLinesSync ?? ((file, text) => appendFileSync(file, text, 'utf8'));
  const maxQueued = options.maxQueuedRecords ?? DEFAULT_MAX_QUEUED_RECORDS;
  const pending = new WeakMap<object, Pending>();
  const queue: Array<{ file: string; line: string }> = [];
  let written = 0;
  let dropped = 0;
  let directoryReady = false;
  let flushChain: Promise<void> = Promise.resolve();
  let stopped = false;

  const fileFor = (at: Date): string => join(options.directory, `${dayOf(at)}-${options.processKind}-${pid}.jsonl`);

  const enqueue = (record: TrafficRecord, at: Date): void => {
    try {
      if (queue.length >= maxQueued) { dropped += 1; return; }
      queue.push({ file: fileFor(at), line: `${JSON.stringify(record)}\n` });
    } catch { dropped += 1; }
  };

  const takeBatches = (): Map<string, string[]> => {
    const batches = new Map<string, string[]>();
    for (const item of queue.splice(0)) {
      const lines = batches.get(item.file);
      if (lines) lines.push(item.line); else batches.set(item.file, [item.line]);
    }
    return batches;
  };

  const flushNow = async (): Promise<void> => {
    try {
      const batches = takeBatches();
      if (batches.size === 0) return;
      try {
        if (!directoryReady) { await mkdir(options.directory, { recursive: true }); directoryReady = true; }
      } catch { for (const lines of batches.values()) dropped += lines.length; return; }
      for (const [file, lines] of batches) {
        try { await appendLines(file, lines.join('')); written += lines.length; }
        catch { dropped += lines.length; }
      }
    } catch { /* The log never throws. */ }
  };

  const flush = (): Promise<void> => {
    flushChain = flushChain.then(flushNow, flushNow);
    return flushChain;
  };

  const flushOnExit = (): void => {
    try {
      const batches = takeBatches();
      if (batches.size === 0) return;
      try { mkdirSync(options.directory, { recursive: true }); } catch { for (const lines of batches.values()) dropped += lines.length; return; }
      for (const [file, lines] of batches) {
        try { appendLinesSync(file, lines.join('')); written += lines.length; }
        catch { dropped += lines.length; }
      }
    } catch { /* The log never throws. */ }
  };

  const timer = setInterval(() => { void flush(); }, options.flushIntervalMs ?? 1000);
  timer.unref();
  process.on('exit', flushOnExit);

  const finish = (request: object, result: { status?: number; error?: string }): void => {
    const state = pending.get(request);
    if (!state) return;
    pending.delete(request);
    const redacted = redactPath(state.rawPath);
    const parsed = state.block === undefined ? null : parseBlock(state.block);
    const framing = parsed && parsed.httpVersion === '1.1' ? derivedFraming(state.method, state) : [];
    const headers = parsed ? [...parsed.lines, ...framing].map(([name, value]): [string, string] => [name, redactHeaderValue(name, value)]) : null;
    const obsHeader = parsed?.lines.find(([name]) => name.toLowerCase() === 'x-obs-params');
    const record: TrafficRecord = {
      ts: state.ts, durationMs: Math.round(performance.now() - state.startedAt), process: options.processKind, pid,
      transport: options.transport, accountRef, method: state.method, origin: state.origin,
      path: redacted.path, queryKeys: redacted.queryKeys, httpVersion: parsed?.httpVersion ?? null,
      requestLine: parsed ? `${state.method} ${redacted.path} HTTP/${parsed.httpVersion === '1.1' ? '1.1' : '2'}` : null,
      headers, framingDerived: framing.length > 0,
      obsParams: obsHeader ? describeObsParams(obsHeader[1]) : null,
      body: state.body, ...(state.jsonShape === undefined ? {} : { jsonShape: state.jsonShape }),
      label: state.label ?? (options.transport === 'CHROMEOS' ? labelFromPath(state.rawPath) : null),
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    enqueue(record, new Date(state.ts));
  };

  const guard = (handler: (message: unknown) => void) => (message: unknown): void => {
    try { handler(message); } catch { dropped += 1; }
  };

  const onCreate = guard((message) => {
    const request = (message as { request?: UndiciRequest }).request;
    if (!request || typeof request !== 'object') return;
    const host = hostnameOfOrigin(request.origin);
    if (host === null || !isLineHost(host)) return;
    const { body, jsonText } = classifyBody(request);
    const contentType = typeof request.contentType === 'string' ? request.contentType : null;
    const state: Pending = {
      ts: now().toISOString(), startedAt: performance.now(), label: trafficLabel.getStore() ?? null,
      method: typeof request.method === 'string' ? request.method : '', origin: String(request.origin),
      rawPath: typeof request.path === 'string' ? request.path : '', body,
      // undici takes the length of a string or buffer body from the body itself.
      contentLength: body.kind === 'string' || body.kind === 'buffer' ? body.length
        : typeof request.contentLength === 'number' ? request.contentLength : null,
    };
    if (jsonText !== null) state.jsonShape = tryJsonShape(jsonText, contentType);
    pending.set(request, state);
  });

  const onSendHeaders = guard((message) => {
    const { request, headers } = message as { request?: object; headers?: unknown };
    const state = request ? pending.get(request) : undefined;
    if (!state || typeof headers !== 'string') return;
    state.block = headers;
  });

  const onHeaders = guard((message) => {
    const { request, response } = message as { request?: object; response?: { statusCode?: unknown } };
    if (!request || typeof response?.statusCode !== 'number') return;
    finish(request, { status: response.statusCode });
  });

  const onError = guard((message) => {
    const { request, error } = message as { request?: object; error?: unknown };
    if (request) finish(request, { error: errorName(error) });
  });

  subscribe('undici:request:create', onCreate);
  subscribe('undici:client:sendHeaders', onSendHeaders);
  subscribe('undici:request:headers', onHeaders);
  subscribe('undici:request:error', onError);

  const handle: TrafficLogHandle = {
    flush,
    stats: () => ({ written, dropped }),
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        unsubscribe('undici:request:create', onCreate);
        unsubscribe('undici:client:sendHeaders', onSendHeaders);
        unsubscribe('undici:request:headers', onHeaders);
        unsubscribe('undici:request:error', onError);
        clearInterval(timer);
        process.off('exit', flushOnExit);
      } catch { /* Nothing to undo. */ }
      await flush();
      if (active === handle) active = undefined;
    },
  };
  active = handle;
  return handle;
}

function tryJsonShape(text: string, contentType: string | null): unknown {
  if (contentType !== null && !/json/i.test(contentType)) return undefined;
  if (contentType === null && !/^\s*[{[]/.test(text)) return undefined;
  try { return jsonShapeOf(JSON.parse(text)); } catch { return undefined; }
}
