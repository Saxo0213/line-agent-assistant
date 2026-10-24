import { describe, expect, it } from 'vitest';
import { trackOperation } from './tracked-operation.js';

describe('tracked operation diagnostics', () => {
  it('records safe context while preserving the original rejection', async () => {
    const inFlight = new Set<Promise<unknown>>();
    const failure = new Error('private message and token=secret-value');
    const recorded: Array<{ diagnostic: unknown; identity: unknown }> = [];
    const operation = trackOperation(() => Promise.reject(failure), {
      operation: 'line_ingest', identity: { accountId: 'account-diagnostic', workerInstanceId: 'worker-diagnostic' },
    }, {
      inFlight,
      isClosing: () => false,
      onFailure(diagnostic, identity) { recorded.push({ diagnostic, identity }); },
    });

    await expect(operation).rejects.toBe(failure);
    await Promise.resolve();
    expect(inFlight.size).toBe(0);
    expect(recorded).toMatchObject([{ diagnostic: { operation: 'line_ingest', stage: 'execute', category: 'unknown' },
      identity: { initiator: 'system', accountId: 'account-diagnostic', workerInstanceId: 'worker-diagnostic' } }]);
    expect(JSON.stringify(recorded)).not.toContain('private message');
    expect(JSON.stringify(recorded)).not.toContain('secret-value');
  });

  it('does not record a rejection after shutdown begins', async () => {
    const inFlight = new Set<Promise<unknown>>();
    const recorded: unknown[] = [];
    const operation = trackOperation(() => Promise.reject(new Error('closing')), {
      operation: 'delivery', identity: { accountId: 'account-diagnostic' },
    }, {
      inFlight,
      isClosing: () => true,
      onFailure(diagnostic) { recorded.push(diagnostic); },
    });

    await expect(operation).rejects.toThrow('closing');
    await Promise.resolve();
    expect(inFlight.size).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('keeps one detailed chat-resource audit instead of adding a generic duplicate', async () => {
    const inFlight = new Set<Promise<unknown>>();
    const failure = Object.assign(new Error('private archive path'), { chatResourceDiagnosticLogged: true });
    const audits: Array<{ action: string; diagnostic?: unknown }> = [
      { action: 'chat_resource_failure', diagnostic: { operation: 'chat_resource', stage: 'archive_write' } },
    ];
    const operation = trackOperation(() => Promise.reject(failure), {
      operation: 'chat_resource', identity: { accountId: 'account-diagnostic' },
    }, {
      inFlight,
      isClosing: () => false,
      onFailure(diagnostic) { audits.push({ action: 'runtime_error', diagnostic }); },
    });

    await expect(operation).rejects.toBe(failure);
    await Promise.resolve();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'chat_resource_failure', diagnostic: { stage: 'archive_write' } });
    expect(JSON.stringify(audits)).not.toContain('private archive path');
  });
});
