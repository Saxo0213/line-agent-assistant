import { appendFile, mkdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const CHAT_RESOURCE_DIAGNOSTIC_ACTIONS = ['note_list', 'note_detail', 'album_list', 'album_photos', 'photo_download'] as const;
export const CHAT_RESOURCE_DIAGNOSTIC_ERRORS = [
  'UNKNOWN', 'REQUEST_REJECTED', 'RESPONSE_INVALID', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'CANCELLED',
  'ACCOUNT_DISCONNECTED', 'ACCOUNT_BINDING_CHANGED', 'WORKER_UNAVAILABLE', 'NETWORK_ERROR', 'NOT_FOUND',
] as const;
export const CHAT_RESOURCE_DIAGNOSTIC_STAGES = ['gateway_admission', 'pending_request', 'worker_response', 'resource_read'] as const;
export const CHAT_RESOURCE_DIAGNOSTIC_REASONS = ['missing_worker', 'not_ready_worker', 'stale_binding', 'pending_stopped', 'worker_response_error', 'unknown'] as const;
export const CHAT_RESOURCE_FAILURE_CATEGORIES = ['bootstrap_failure', 'list_get_transport_failure', 'response_code_invalid', 'response_shape_invalid',
  'normalization_failure', 'response_validation', 'timeout', 'cancellation', 'unknown'] as const;
export type ChatResourceDiagnosticAction = typeof CHAT_RESOURCE_DIAGNOSTIC_ACTIONS[number];
export type ChatResourceDiagnostic = {
  source: 'modal' | 'notification' | 'mcp';
  accountId: string;
  chatId: string;
  action: ChatResourceDiagnosticAction;
  correlationId?: string;
  occurredAt: string;
  durationMs: number;
  status: 'success' | 'failure';
  errorCode?: typeof CHAT_RESOURCE_DIAGNOSTIC_ERRORS[number];
  failureStage?: typeof CHAT_RESOURCE_DIAGNOSTIC_STAGES[number];
  failureReason?: typeof CHAT_RESOURCE_DIAGNOSTIC_REASONS[number];
  failureCategory?: typeof CHAT_RESOURCE_FAILURE_CATEGORIES[number];
  responseCode?: number | 'missing' | 'non_numeric';
  currentBindingMatch?: boolean;
  currentEpochMatch?: boolean;
  workerReady?: boolean;
  itemCount: number;
  byteCount: number;
  responseFields: Array<{ name: string; type: 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' }>;
};

const logName = 'chat-resource-diagnostics.jsonl';
const maxRecordBytes = 2048;
const maxFields = 32;
const sensitiveField = /token|auth|header|cookie|secret|password|credential|content|text|message|image|photo|url|uri|body|payload|error|exception|stack/i;

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value) && !/token|password|secret|oauth|qr|pin/i.test(value);
}

export function parseChatResourceDiagnostic(value: unknown): ChatResourceDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if ((input.source !== 'modal' && input.source !== 'notification' && input.source !== 'mcp') || !boundedId(input.accountId)
    || !boundedId(input.chatId) || !CHAT_RESOURCE_DIAGNOSTIC_ACTIONS.includes(input.action as ChatResourceDiagnosticAction)
    || typeof input.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input.occurredAt)
    || !Number.isFinite(Date.parse(input.occurredAt)) || !Number.isSafeInteger(input.durationMs) || (input.durationMs as number) < 0 || (input.durationMs as number) > 86_400_000
    || (input.status !== 'success' && input.status !== 'failure') || !Number.isSafeInteger(input.itemCount)
    || (input.itemCount as number) < 0 || (input.itemCount as number) > 100_000 || !Number.isSafeInteger(input.byteCount)
    || (input.byteCount as number) < 0 || (input.byteCount as number) > 100_000_000
    || !Array.isArray(input.responseFields) || input.responseFields.length > maxFields) return null;
  if (input.errorCode !== undefined && !CHAT_RESOURCE_DIAGNOSTIC_ERRORS.includes(input.errorCode as typeof CHAT_RESOURCE_DIAGNOSTIC_ERRORS[number])) return null;
  if (input.failureStage !== undefined && !CHAT_RESOURCE_DIAGNOSTIC_STAGES.includes(input.failureStage as typeof CHAT_RESOURCE_DIAGNOSTIC_STAGES[number])) return null;
  if (input.failureReason !== undefined && !CHAT_RESOURCE_DIAGNOSTIC_REASONS.includes(input.failureReason as typeof CHAT_RESOURCE_DIAGNOSTIC_REASONS[number])) return null;
  if (input.failureCategory !== undefined && !CHAT_RESOURCE_FAILURE_CATEGORIES.includes(input.failureCategory as typeof CHAT_RESOURCE_FAILURE_CATEGORIES[number])) return null;
  if (input.responseCode !== undefined && !(typeof input.responseCode === 'number' && Number.isFinite(input.responseCode)
    && Math.abs(input.responseCode) <= 1_000_000_000 || input.responseCode === 'missing' || input.responseCode === 'non_numeric')) return null;
  if (input.responseCode !== undefined && (input.status !== 'failure' || input.failureCategory !== 'response_code_invalid'
    || (input.action !== 'note_list' && input.action !== 'note_detail'))) return null;
  for (const field of ['currentBindingMatch', 'currentEpochMatch', 'workerReady'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') return null;
  }
  const responseFields: ChatResourceDiagnostic['responseFields'] = [];
  for (const field of input.responseFields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
    const { name, type } = field as Record<string, unknown>;
    if (typeof name !== 'string' || name.length > 48 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)
      || !['null', 'boolean', 'number', 'string', 'array', 'object'].includes(type as string)) return null;
    if (!sensitiveField.test(name)) responseFields.push({ name, type: type as ChatResourceDiagnostic['responseFields'][number]['type'] });
  }
  const result: ChatResourceDiagnostic = {
    source: input.source, accountId: input.accountId, chatId: input.chatId,
    action: input.action as ChatResourceDiagnosticAction, occurredAt: input.occurredAt,
    durationMs: input.durationMs as number, status: input.status, itemCount: input.itemCount as number,
    byteCount: input.byteCount as number, responseFields,
  };
  if (input.correlationId !== undefined) {
    if (!boundedId(input.correlationId)) return null;
    result.correlationId = input.correlationId;
  }
  if (input.errorCode !== undefined) result.errorCode = input.errorCode as NonNullable<ChatResourceDiagnostic['errorCode']>;
  if (input.failureStage !== undefined) result.failureStage = input.failureStage as NonNullable<ChatResourceDiagnostic['failureStage']>;
  if (input.failureReason !== undefined) result.failureReason = input.failureReason as NonNullable<ChatResourceDiagnostic['failureReason']>;
  if (input.failureCategory !== undefined) result.failureCategory = input.failureCategory as NonNullable<ChatResourceDiagnostic['failureCategory']>;
  if (input.responseCode !== undefined) result.responseCode = input.responseCode as NonNullable<ChatResourceDiagnostic['responseCode']>;
  if (input.currentBindingMatch !== undefined) result.currentBindingMatch = input.currentBindingMatch as boolean;
  if (input.currentEpochMatch !== undefined) result.currentEpochMatch = input.currentEpochMatch as boolean;
  if (input.workerReady !== undefined) result.workerReady = input.workerReady as boolean;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxRecordBytes) return null;
  return result;
}

export interface ChatResourceDiagnosticsOptions {
  onSinkFailure?: (stage: 'write' | 'queue' | 'shutdown') => void;
  appDataDirectory: string;
  maxFileBytes?: number;
  retainedFiles?: number;
  queueCapacity?: number;
  shutdownTimeoutMs?: number;
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value!))) : fallback;
}

export function createChatResourceDiagnostics(options: ChatResourceDiagnosticsOptions) {
  const reportSink = (stage: 'write' | 'queue' | 'shutdown') => {
    try { options.onSinkFailure?.(stage); } catch { /* Sink observers cannot affect resource reads. */ }
  };
  const filePath = resolve(options.appDataDirectory, logName);
  const maxFileBytes = boundedOption(options.maxFileBytes, 1024 * 1024, 4096, 10 * 1024 * 1024);
  const retainedFiles = boundedOption(options.retainedFiles, 4, 1, 8);
  const queueCapacity = boundedOption(options.queueCapacity, 128, 1, 512);
  const shutdownTimeoutMs = boundedOption(options.shutdownTimeoutMs, 2000, 1, 10_000);
  const queue: string[] = [];
  let draining: Promise<void> | undefined;
  let closed = false;

  async function rotateIfNeeded(lineBytes: number): Promise<void> {
    let size: number;
    try { size = (await stat(filePath)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (size + lineBytes <= maxFileBytes) return;
    if (retainedFiles === 1) {
      await truncate(filePath, 0);
      return;
    }
    await rm(`${filePath}.${retainedFiles - 1}`, { force: true });
    for (let index = retainedFiles - 2; index >= 1; index -= 1) {
      try { await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await rename(filePath, `${filePath}.1`);
  }

  async function drain(): Promise<void> {
    while (queue.length) {
      const line = queue.shift()!;
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
        await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
      } catch { reportSink('write'); }
    }
  }
  function startDrain(): void {
    if (!draining) draining = drain().finally(() => { draining = undefined; if (queue.length && !closed) startDrain(); });
  }

  return {
    filePath,
    record(input: unknown): void {
      if (closed) return;
      const record = parseChatResourceDiagnostic(input);
      if (!record) return;
      const line = `${JSON.stringify(record)}\n`;
      if (queue.length >= queueCapacity) { reportSink('queue'); return; }
      queue.push(line);
      startDrain();
    },
    async shutdown(): Promise<void> {
      closed = true;
      if (!draining) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([draining, new Promise<void>((resolve) => { timer = setTimeout(resolve, shutdownTimeoutMs); })]);
      if (timer) clearTimeout(timer);
      if (queue.length) reportSink('shutdown');
      queue.length = 0;
    },
  };
}

export type ChatResourceDiagnostics = ReturnType<typeof createChatResourceDiagnostics>;
