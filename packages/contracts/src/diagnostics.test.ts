import { describe, expect, it } from 'vitest';
import { diagnosticFailure, parseSafeDiagnostic } from './diagnostics.js';
import { IPC_ACTION_CODES } from './ipc-actions.js';
import { IpcRequestSchema } from './ipc.js';

it('allows only fixed IPC action discriminants and preserves legacy diagnostics', () => {
  expect(IPC_ACTION_CODES).toEqual(IpcRequestSchema.options.map((option) => option.shape.type.value));
  const legacy = diagnosticFailure('ipc', 'execute');
  expect(parseSafeDiagnostic(legacy)).toEqual(legacy);
  for (const ipcAction of IPC_ACTION_CODES) expect(parseSafeDiagnostic({ ...legacy, ipcAction })?.ipcAction).toBe(ipcAction);
  for (const ipcAction of ['private-sentinel', 'x'.repeat(129), null, 7]) {
    expect(parseSafeDiagnostic({ ...legacy, ipcAction })).toBeUndefined();
  }
});

describe('safe operational diagnostics', () => {
  it('keeps fixed categories while dropping arbitrary error text, payload and cause', () => {
    const sentinel = 'private-token-qr-pin-path-sql-message-note-album-provider-sentinel';
    const error = Object.assign(new Error(sentinel, { cause: { token: sentinel } }), { code: 'ETIMEDOUT' });
    const result = diagnosticFailure('history', 'read', error);
    expect(result).toMatchObject({ operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry' });
    expect(parseSafeDiagnostic({ ...result, message: sentinel, stack: sentinel, cause: error, payload: sentinel })).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(parseSafeDiagnostic({ ...result, reason: sentinel })).toBeUndefined();
  });

  it('never recommends blind retry after an uncertain external effect', () => {
    expect(diagnosticFailure('delivery', 'execute', new Error('private'), 'unknown'))
      .toMatchObject({ outcome: 'unknown', recovery: 'inspect_outcome' });
    expect(diagnosticFailure('history', 'read', { name: 'AbortError' })).toMatchObject({ category: 'cancelled', recovery: 'none' });
  });

  it('keeps only bounded upstream LINE failure facts for operational records', () => {
    const result = parseSafeDiagnostic({ operation: 'album_list', stage: 'response', category: 'invalid_response',
      recovery: 'retry', reason: 'response_code_invalid', failureKind: 'linejs_internal', upstreamCode: 102001, upstreamStatus: 503 });
    expect(result).toMatchObject({ reason: 'response_code_invalid', failureKind: 'linejs_internal', upstreamCode: 102001, upstreamStatus: 503 });
    expect(parseSafeDiagnostic({ ...result, upstreamCode: 1_000_000_001 })).toBeUndefined();
    expect(parseSafeDiagnostic({ ...result, upstreamStatus: 799 })).toBeUndefined();
    expect(parseSafeDiagnostic({ ...result, upstreamCode: 'non_numeric' })).toMatchObject({ upstreamCode: 'non_numeric' });
  });

  it('contains hostile diagnostic and exception getters', () => {
    const hostile = Object.defineProperty({}, 'name', { get() { throw new Error('private'); } });
    expect(() => diagnosticFailure('ipc', 'read', hostile)).not.toThrow();
    expect(parseSafeDiagnostic(Object.defineProperty({}, 'operation', { get() { throw new Error('private'); } }))).toBeUndefined();
  });
});
