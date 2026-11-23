// Bounded diagnostic of a failed LINE login. It uses only fixed parts of the caught error:
// the login step, the error class name, a fixed reason slug, the service method and a numeric code.
// It never copies an error message, a response body, a URL query, or any token.

import { DIAGNOSTIC_DETAIL_PATTERN } from '@line-agent/contracts';

/** Same key as `LOGIN_STAGE_KEY` in `@line-agent/line-chrome`. */
const STAGE_KEY = 'loginStage';
const DETAIL_MAX = 160;

/** Record the login step on a thrown error. The first tag stays. A value that is not an object is ignored. */
export function tagLoginStage(error: unknown, stage: string): void {
  if (typeof error !== 'object' || error === null || Object.hasOwn(error, STAGE_KEY)) return;
  try {
    Object.defineProperty(error, STAGE_KEY, { value: stage, enumerable: false, configurable: true });
  } catch { /* A frozen error keeps no tag. */ }
}

const METHOD_KEY = 'lineMethod';
const STATUS_KEY = 'httpStatus';
const KIND_KEY = 'failureKind';
const METHOD_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const KIND_PATTERN = /^[a-z0-9_]{1,40}$/;

function defineOnce(error: object, key: string, value: unknown): void {
  if (Object.hasOwn(error, key)) return;
  try {
    Object.defineProperty(error, key, { value, enumerable: false, configurable: true });
  } catch { /* A frozen error keeps no tag. */ }
}

/** Record the LINEJS method, the HTTP status and a fixed failure kind on a thrown error. The first tag of each field stays. */
export function tagLinejsFailure(error: unknown, info: { method?: string; httpStatus?: number; kind?: string }): void {
  if (typeof error !== 'object' || error === null) return;
  if (info.method !== undefined && METHOD_PATTERN.test(info.method)) defineOnce(error, METHOD_KEY, info.method);
  if (info.httpStatus !== undefined && Number.isInteger(info.httpStatus) && info.httpStatus >= 100 && info.httpStatus <= 599) {
    defineOnce(error, STATUS_KEY, info.httpStatus);
  }
  if (info.kind !== undefined && KIND_PATTERN.test(info.kind)) defineOnce(error, KIND_KEY, info.kind);
}

/** True when the error already carries a LINEJS method tag. */
export function hasLinejsMethodTag(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Object.hasOwn(error, METHOD_KEY);
}

const E2EE_KEY_SIZE_MESSAGES = new Set(['bad n size', 'bad p size', 'bad key size', 'bad nonce size', 'bad public key size',
  'bad secret key size', 'wrong public key length', 'wrong secret key length']);
const THRIFT_PARSE_PREFIXES = ['fid ', 'recv fid', 'Invalid type', "cAN't rEad TyPE", 'Invalid data'];

/** Map an error message to one fixed kind. The message text is never copied. */
export function classifyLinejsFailure(error: unknown): string {
  let message: unknown;
  try { message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined; } catch { message = undefined; }
  if (typeof message !== 'string') return 'local_error';
  if (message.startsWith('Request internal failed: status=')) return 'unparsable_response';
  if (E2EE_KEY_SIZE_MESSAGES.has(message)) return 'e2ee_key_size';
  if (THRIFT_PARSE_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'thrift_parse';
  return 'local_error';
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, '_');

function read(record: Record<string, unknown>, key: string): unknown {
  try { return record[key]; } catch { return undefined; }
}

function className(record: Record<string, unknown>): string {
  const name = read(record, 'name');
  if (typeof name === 'string' && name !== '') return name;
  const constructorName = (read(record, 'constructor') as { name?: unknown } | undefined)?.name;
  return typeof constructorName === 'string' && constructorName !== '' ? constructorName : 'Error';
}

function methodOf(record: Record<string, unknown>): string | null {
  const path = read(record, 'path');
  if (typeof path !== 'string') return null;
  const last = path.split('?')[0]!.split('/').filter((part) => part !== '').at(-1);
  return last === undefined ? null : last;
}

function codeOf(record: Record<string, unknown>): string | null {
  for (const key of ['code', 'status', 'outerCode']) {
    const value = read(record, key);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (key === 'code' && typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value)) return value;
  }
  return null;
}

/** Format: `<stage>:<ErrorClass>[:<method>][:<code>]`. A login protocol error gives its fixed slug in place of method and code. */
export function buildLoginFailureDetail(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) return 'unknown:NonError';
    const record = error as Record<string, unknown>;
    const stage = read(record, STAGE_KEY);
    const parts = [typeof stage === 'string' && stage !== '' ? stage : 'unknown', className(record)];
    const slug = read(record, 'slug');
    if (typeof slug === 'string' && slug !== '') parts.push(slug);
    else {
      const method = methodOf(record);
      if (method !== null) parts.push(method);
      const code = codeOf(record);
      if (code !== null) parts.push(code);
    }
    const lineMethod = read(record, METHOD_KEY);
    if (typeof lineMethod === 'string' && METHOD_PATTERN.test(lineMethod)) parts.push(lineMethod);
    const httpStatus = read(record, STATUS_KEY);
    if (typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) parts.push(`http${httpStatus}`);
    const failureKind = read(record, KIND_KEY);
    if (typeof failureKind === 'string' && KIND_PATTERN.test(failureKind)) parts.push(failureKind);
    const detail = safe(parts.join(':')).slice(0, DETAIL_MAX);
    return DIAGNOSTIC_DETAIL_PATTERN.test(detail) ? detail : undefined;
  } catch {
    return undefined;
  }
}

/** The HTTP status tag of a failed login, when it is a valid HTTP status. */
export function loginHttpStatus(error: unknown): number | undefined {
  const value = typeof error === 'object' && error !== null ? read(error as Record<string, unknown>, STATUS_KEY) : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
