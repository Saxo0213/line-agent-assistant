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
    const detail = safe(parts.join(':')).slice(0, DETAIL_MAX);
    return DIAGNOSTIC_DETAIL_PATTERN.test(detail) ? detail : undefined;
  } catch {
    return undefined;
  }
}
