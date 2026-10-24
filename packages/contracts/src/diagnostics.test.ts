import { describe, expect, it } from 'vitest';
import { diagnosticFailure, parseSafeDiagnostic } from './diagnostics.js';

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

  it('contains hostile diagnostic and exception getters', () => {
    const hostile = Object.defineProperty({}, 'name', { get() { throw new Error('private'); } });
    expect(() => diagnosticFailure('ipc', 'read', hostile)).not.toThrow();
    expect(parseSafeDiagnostic(Object.defineProperty({}, 'operation', { get() { throw new Error('private'); } }))).toBeUndefined();
  });
});
