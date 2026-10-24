import { describe, expect, it } from 'vitest';
import { createOperationalAudit, parseOperationalAuditEvent, type AuditEvent } from './operational-audit.js';

describe('operational audit', () => {
  it('never coalesces unidentified independent operations and retains identified repeats once', async () => {
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
    const diagnostic = { operation: 'delivery', stage: 'execute', category: 'unknown', recovery: 'retry' } as const;
    audit.failure(diagnostic); audit.failure(diagnostic);
    for (let index = 0; index < 100; index++) audit.failure(diagnostic, { requestId: 'request-a', jobId: 'job-a', background: true });
    audit.failure(diagnostic, { requestId: 'request-b', jobId: 'job-b' });
    await audit.flush();
    expect(stored).toHaveLength(4);
    expect(new Set(stored.map((event) => event.correlationId)).size).toBe(4);
    expect(stored.slice(2)).toMatchObject([{ requestId: 'request-a', jobId: 'job-a' }, { requestId: 'request-b', jobId: 'job-b' }]);
  });
  it('keeps independent requests, jobs and providers distinct while coalescing background repeats', async () => {
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
    const diagnostic = { operation: 'agent', stage: 'execute', category: 'unknown', recovery: 'retry' } as const;
    audit.failure(diagnostic, { jobId: 'job-a' }); audit.failure(diagnostic, { jobId: 'job-b' });
    audit.failure(diagnostic, { requestId: 'request-a' }); audit.failure(diagnostic, { requestId: 'request-b' });
    audit.failure({ ...diagnostic, provider: 'codex' }, { background: true }); audit.failure({ ...diagnostic, provider: 'claude' }, { background: true });
    const correlated = audit.failure({ ...diagnostic, provider: 'claude' }, { background: true });
    await audit.flush(); expect(stored).toHaveLength(6);
    expect(correlated).toBe(stored[5]?.correlationId);
  });

  it('coalesces an idle/burst failure stream within fixed memory and drains without creating timers', async () => {
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
    for (let index = 0; index < 10_000; index++) {
      audit.failure({ operation: 'poll', stage: 'execute', category: 'timeout', recovery: 'retry' }, { background: true });
    }
    audit.failure({ operation: 'history', stage: 'read', category: 'cancelled', recovery: 'none' });
    await audit.flush();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty('background');
    expect(audit.health()).toEqual({ databaseFailed: false, fallbackFailed: false, droppedCount: 0, queuedCount: 0, failureKeys: 1 });
    expect(audit.pendingActionCount).toBe(0);
  });

  it('bounds retained background failure scopes through repeated burst and idle drains', async () => {
    const audit = createOperationalAudit({ append: async () => {}, appendFallback: async () => {}, logSinkState() {} });
    for (let burst = 0; burst < 5; burst++) {
      for (let scope = 0; scope < 200; scope++) audit.failure({ operation: 'poll', stage: 'execute', category: 'timeout', recovery: 'retry' },
        { accountId: `account-${burst}-${scope}`, background: true });
      await audit.flush();
      expect(audit.health()).toMatchObject({ queuedCount: 0, failureKeys: 128, droppedCount: 0 });
      expect(audit.pendingActionCount).toBe(0);
    }
  });

  it('round trips fixed diagnostic fields and discards arbitrary exception content', async () => {
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
    audit.observed('worker_operation_error', { initiator: 'worker', requestId: 'request-a', errorCode: 'HISTORY_READ_FAILED',
      diagnostic: { operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry', statusCode: 504,
        message: 'secret-sentinel', cause: new Error('secret-sentinel') } as never });
    await audit.flush();
    expect(parseOperationalAuditEvent(JSON.parse(JSON.stringify(stored[0])))).toMatchObject({ requestId: 'request-a',
      diagnostic: { operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry', statusCode: 504 } });
    expect(JSON.stringify(stored)).not.toContain('secret-sentinel');
    expect(parseOperationalAuditEvent({ ...stored[0], diagnostic: { operation: 'secret-sentinel' } })).toBeNull();
  });

  it('records requested and terminal events with one correlation id and only allowlisted fields', async () => {
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({
      async append(event) { stored.push(event); },
      async appendFallback() {},
      logSinkState() {},
    });

    const correlationId = audit.request('secret_clear', {
      initiator: 'user', accountId: 'account-a', requestId: 'request-a',
      reasonCode: 'operator_action', token: 'must-not-be-recorded',
    } as never);
    audit.complete(correlationId, 'succeeded', { resultCode: 'secret_removed', password: 'must-not-be-recorded' } as never);
    await audit.flush();

    expect(stored).toHaveLength(2);
    expect(stored.map((event) => [event.action, event.phase, event.correlationId])).toEqual([
      ['secret_clear', 'requested', correlationId], ['secret_clear', 'succeeded', correlationId],
    ]);
    expect(JSON.stringify(stored)).not.toContain('must-not-be-recorded');
    expect(Object.keys(stored[0]!).sort()).toEqual([
      'accountId', 'action', 'correlationId', 'createdAt', 'initiator', 'phase', 'reasonCode', 'requestId',
    ]);
  });

  it('falls back without throwing when database writes fail', async () => {
    const fallback: AuditEvent[] = [];
    const database: AuditEvent[] = [];
    const sinkChanges: Array<{ state: 'failed' | 'recovered'; droppedCount: number }> = [];
    let workerContinued = false;
    let databaseAvailable = false;
    let databaseAttempts = 0;
    const audit = createOperationalAudit({
      async append(event) { databaseAttempts += 1; if (!databaseAvailable) throw new Error('database outage with sensitive payload'); database.push(event); },
      async appendFallback(event) { fallback.push(event); },
      logSinkState(state, _error, droppedCount) { sinkChanges.push({ state, droppedCount }); },
    });

    const correlationId = audit.request('worker_stop', { initiator: 'system', accountId: 'account-a' });
    audit.complete(correlationId, 'failed', { errorCode: 'WORKER_STOP_TIMEOUT' });
    workerContinued = true;
    await audit.flush();

    expect(workerContinued).toBe(true);
    expect(fallback.filter((event) => event.action === 'worker_stop').map((event) => event.phase)).toEqual(['requested', 'failed']);
    expect(audit.sinkEvents()).toContainEqual(expect.objectContaining({ action: 'audit_sink_failed', errorCode: 'DATABASE_WRITE_FAILED' }));
    expect(databaseAttempts).toBe(6);
    expect(JSON.stringify(fallback)).not.toContain('sensitive payload');
    expect(sinkChanges.map(({ state }) => state)).toEqual(['failed']);
    databaseAvailable = true;
    audit.observed('worker_exited', { initiator: 'worker', accountId: 'account-a', workerInstanceId: 'worker-a' });
    await audit.flush();
    expect(sinkChanges).toEqual([{ state: 'failed', droppedCount: 0 }, { state: 'recovered', droppedCount: 0 }]);
    expect(fallback).toHaveLength(2);
    expect(database.map((event) => event.action)).toEqual(['worker_exited', 'audit_sink_failed', 'audit_sink_recovered']);
  });

  it('drops the oldest queued audit events when its bounded queue is full', async () => {
    const stored: AuditEvent[] = [];
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const audit = createOperationalAudit({
      async append(event) { if (!stored.length) { started(); await gate; } stored.push(event); },
      async appendFallback() {}, logSinkState() {}, capacity: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      audit.observed('worker_exited', { initiator: 'worker', correlationId: `worker-${index}` });
      if (index === 0) await entered;
    }
    expect(audit.droppedCount).toBe(1);
    release();
    await audit.flush();
    expect(stored.map((event) => event.correlationId)).toEqual(['worker-0', 'worker-2', 'worker-3']);
  });

  it('bounds pending action correlations and ignores completion after eviction', async () => {
    const stored: AuditEvent[] = [];
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const audit = createOperationalAudit({
      async append(event) { if (!stored.length) { started(); await gate; } stored.push(event); },
      async appendFallback() {}, logSinkState() {}, capacity: 2,
    });
    const first = audit.request('secret_clear', { initiator: 'user', requestId: 'request-first' });
    await entered;
    const second = audit.request('agent_codex_login', { initiator: 'user', requestId: 'request-second' });
    const third = audit.request('agent_claude_logout', { initiator: 'user', requestId: 'request-third' });

    expect(audit.pendingActionCount).toBe(2);
    audit.complete(first, 'succeeded', { resultCode: 'secret_removed' });
    audit.complete(second, 'succeeded', { resultCode: 'agent_auth_action_completed' });
    audit.complete(third, 'succeeded', { resultCode: 'agent_auth_action_completed' });
    release();
    await audit.flush();

    expect(audit.pendingActionCount).toBe(0);
    expect(stored.filter((event) => event.phase === 'succeeded').map((event) => event.action)).toEqual([
      'agent_codex_login', 'agent_claude_logout',
    ]);
  });

  it('bounds drain time when database and fallback sinks never settle', async () => {
    let databaseAttempts = 0;
    let fallbackAttempts = 0;
    const audit = createOperationalAudit({
      append() { databaseAttempts += 1; return new Promise<void>(() => {}); },
      appendFallback() { fallbackAttempts += 1; return new Promise<void>(() => {}); },
      logSinkState() {}, sinkTimeoutMs: 5, fallbackTimeoutMs: 5, retryDelayMs: 0,
    });

    audit.observed('worker_exited', { initiator: 'worker' });
    await Promise.race([
      audit.flush(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('flush exceeded bounded sink deadlines')), 250)),
    ]);

    expect(databaseAttempts).toBe(3);
    expect(fallbackAttempts).toBe(1);
  });

  it('abandons queued audit events at the overall shutdown flush deadline and counts drops', async () => {
    const audit = createOperationalAudit({
      append() { return new Promise<void>(() => {}); },
      appendFallback() { return new Promise<void>(() => {}); },
      logSinkState() {}, capacity: 10, sinkTimeoutMs: 20, fallbackTimeoutMs: 20,
      retryDelayMs: 0, flushTimeoutMs: 5,
    });
    for (let index = 0; index < 5; index += 1) {
      audit.observed('worker_exited', { initiator: 'worker', correlationId: `shutdown-${index}` });
    }

    await Promise.race([
      audit.flush(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('shutdown flush was unbounded')), 100)),
    ]);
    expect(audit.droppedCount).toBe(5);
    audit.observed('worker_exited', { initiator: 'worker', correlationId: 'after-deadline' });
    expect(audit.droppedCount).toBe(6);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
