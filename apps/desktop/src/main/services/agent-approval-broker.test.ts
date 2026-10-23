import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WritePathEvidence } from '@line-agent/contracts';
import type { AgentApprovalEvent } from './agent-approval-broker.js';
import { AgentApprovalBroker, AgentApprovalBrokerError, MAX_AUTOMATIC_IN_FLIGHT } from './agent-approval-broker.js';

function harness(options: { level?: string; version?: number; timeout?: number; timeoutAction?: 'ALLOW' | 'DENY'; auditFails?: boolean; rememberFails?: boolean } = {}) {
  let time = 1_000;
  let seq = 0;
  const timers = new Map<number, () => void>();
  let timerSets = 0; let timerClears = 0;
  const audits: Array<{ detail: Record<string, unknown>; actor: string }> = [];
  const added: unknown[][] = [];
  const events: AgentApprovalEvent[] = [];
  const repo = {
    getExecutionPolicy: vi.fn(async () => ({ level: options.level ?? 'workspace_write', approvalTimeoutSeconds: options.timeout ?? 20, timeoutAction: options.timeoutAction ?? 'DENY',
      version: options.version ?? 1, updatedAt: new Date(0).toISOString() })),
    listToolAllowlist: vi.fn(async () => [] as Array<{ id: string; kind: 'tool' | 'bash_command'; value: string; createdAt: string }>),
    addToolAllowlistEntry: vi.fn(async (...args: unknown[]) => { added.push(args); if (options.rememberFails) throw new Error('failed'); return {} as never; }),
    recordExecutionApproval: vi.fn(async (detail: Record<string, unknown>, actor: string) => { audits.push({ detail, actor }); if (options.auditFails) throw new Error('audit failed'); }),
  };
  const evidence = vi.fn(async (target: string, root: string): Promise<WritePathEvidence | null> =>
    target.startsWith(root) ? { resolvedTarget: target, resolvedWorkspaceRoot: root } : null);
  const broker = new AgentApprovalBroker({ repository: repo as never, resolveWritePathEvidence: evidence,
    publish: (event) => events.push(event), now: () => time, randomId: () => `approval-${++seq}`,
    setTimer: (fn) => { const id = ++seq; timerSets++; timers.set(id, fn); return id; }, clearTimer: (id) => { timerClears++; timers.delete(id as number); } });
  return { broker, repo, evidence, audits, added, events, timers, get timerSets() { return timerSets; }, get timerClears() { return timerClears; }, setTime: (v: number) => { time = v; }, fireTimer: (id = timers.keys().next().value) => { if (id !== undefined) timers.get(id)?.(); } };
}
const req = (jobId: string, tool = 'Bash', input: Record<string, unknown> = { command: 'echo hello' }, signal = new AbortController().signal) =>
  ({ jobId, sessionKey: 'session', workspaceRoot: 'C:\\work', tool, input, signal });
const settleApproval = async (h: ReturnType<typeof harness>, decision: 'once' | 'session' | 'always' | 'deny') => {
  const promise = h.broker.request(req('job'));
  await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
  await h.broker.decide(h.broker.listPending()[0]!.approvalId, decision);
  return promise;
};
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

afterEach(() => vi.restoreAllMocks());
describe('AgentApprovalBroker', () => {
  it('audits automatic allow and deny decisions', async () => {
    const allow = harness();
    expect((await allow.broker.request(req('read', 'Read', { file_path: 'x' }))).behavior).toBe('allow');
    expect(allow.audits[0]?.detail.outcome).toBe('auto_allow');
    const deny = harness({ level: 'read_only' });
    expect(await deny.broker.request(req('write', 'Write', { file_path: 'C:\\work\\x' }))).toMatchObject({ behavior: 'deny' });
    expect(deny.audits[0]?.detail.outcome).toBe('auto_deny');
  });
  it.each(['once', 'session', 'always'] as const)('allows a Bash ask with %s', async (decision) => {
    const h = harness();
    expect(await settleApproval(h, decision)).toMatchObject({ behavior: 'allow', updatedInput: { command: 'echo hello' } });
    expect(h.events.map((e) => e.type)).toEqual(['requested', 'resolved']);
    expect(h.audits.at(-1)?.detail.outcome).toBe(`allow_${decision}`);
  });
  it('denies a Bash ask and reports card actor', async () => {
    const h = harness();
    expect(await settleApproval(h, 'deny')).toMatchObject({ behavior: 'deny', message: 'The user denied this tool use.' });
    expect(h.audits[0]?.actor).toBe('operator');
  });
  it('reuses session exact commands only, and clears on policy version change', async () => {
    const h = harness(); await settleApproval(h, 'session');
    expect((await h.broker.request(req('next'))).behavior).toBe('allow');
    const changed = req('different', 'Bash', { command: 'echo other' });
    const pending = h.broker.request(changed); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1)); h.broker.cancelJob('different'); await pending;
    const changedVersion = harness(); await settleApproval(changedVersion, 'session');
    changedVersion.repo.getExecutionPolicy.mockImplementation(async () => ({ level: 'workspace_write', approvalTimeoutSeconds: 20, timeoutAction: 'DENY', version: 2, updatedAt: '' }));
    const next = changedVersion.broker.request(req('changed')); await vi.waitFor(() => expect(changedVersion.broker.listPending()).toHaveLength(1)); changedVersion.broker.cancelJob('changed'); await next;
  });
  it('caps session entries to 64 and sessions to 256', async () => {
    const h = harness();
    for (let i = 0; i < 65; i++) { const p = h.broker.request({ ...req(`j${i}`, 'Bash', { command: `c${i}` }), sessionKey: 'session' }); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1)); await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'session'); await p; }
    expect(h.broker.listPending()).toHaveLength(0);
    const oldest = h.broker.request({ ...req('oldest', 'Bash', { command: 'c0' }), sessionKey: 'session' });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.broker.listPending()[0]?.jobId).toBe('oldest'); h.broker.cancelJob('oldest'); await oldest;
    // Exercise LRU with separate sessions and one pending approval at a time.
    for (let i = 0; i < 257; i++) { const p = h.broker.request({ ...req(`s${i}`, 'Bash', { command: `s${i}` }), sessionKey: `s${i}` }); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1)); await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'session'); await p; }
    expect(h.broker.listPending()).toHaveLength(0);
    const oldestSession = h.broker.request({ ...req('old-session', 'Bash', { command: 's0' }), sessionKey: 's0' });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.broker.listPending()[0]?.jobId).toBe('old-session'); h.broker.cancelJob('old-session'); await oldestSession;
  }, 60000);
  it('persists always entries with exact Bash command and permits one-time allow on persistence failure', async () => {
    const h = harness(); await settleApproval(h, 'always');
    expect(h.added[0]).toEqual(['bash_command', 'echo hello', 'operator']);
    const failed = harness({ rememberFails: true }); expect((await settleApproval(failed, 'always')).behavior).toBe('allow');
    expect(failed.audits[0]?.detail.rememberFailed).toBe(true);
  });
  it.each(['timeout', 'abort', 'cancelJob', 'close'] as const)('%s settles as deny and removes timer', async (how) => {
    const h = harness(); const controller = new AbortController(); const p = h.broker.request(req('job', 'Bash', { command: 'x' }, controller.signal));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    if (how === 'timeout') h.fireTimer(); else if (how === 'abort') controller.abort(); else if (how === 'cancelJob') h.broker.cancelJob('job'); else h.broker.close();
    expect(await p).toMatchObject({ behavior: 'deny' }); expect(h.timers.size).toBe(0);
    if (how === 'close') expect(await h.broker.request(req('later'))).toMatchObject({ behavior: 'deny' });
  });
  it('allows an expired approval once when the captured policy says ALLOW and audits that outcome', async () => {
    const h = harness({ timeoutAction: 'ALLOW' });
    const pending = h.broker.request(req('job'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.repo.getExecutionPolicy.mockResolvedValue({ level: 'workspace_write', approvalTimeoutSeconds: 20, timeoutAction: 'DENY', version: 2, updatedAt: new Date(1).toISOString() });
    h.fireTimer();
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { command: 'echo hello' } });
    expect(h.audits).toEqual([{ detail: expect.objectContaining({ outcome: 'timeout_allow', timeoutAction: 'ALLOW', policyVersion: 1 }), actor: 'system' }]);
    expect(h.added).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'allowed' });
    const next = h.broker.request(req('next'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.broker.listPending()[0]?.jobId).toBe('next');
    h.broker.cancelJob('next');
    await next;
  });
  it('fails closed when automatic timeout allowance cannot be audited', async () => {
    const h = harness({ timeoutAction: 'ALLOW', auditFails: true });
    const pending = h.broker.request(req('job'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.fireTimer();
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'timeout' });
    expect(h.added).toHaveLength(0);
  });
  it('does not allow on timeout if the request was aborted while the timeout audit was pending', async () => {
    const h = harness({ timeoutAction: 'ALLOW' });
    const controller = new AbortController();
    const audit = deferred();
    const entered = deferred();
    h.repo.recordExecutionApproval.mockImplementation(async () => { entered.resolve(); await audit.promise; });
    const pending = h.broker.request(req('job', 'Bash', { command: 'x' }, controller.signal));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.fireTimer();
    await entered.promise;
    controller.abort();
    audit.resolve();
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'timeout' });
  });
  it('does not allow on timeout if the broker closes while the timeout audit is pending', async () => {
    const h = harness({ timeoutAction: 'ALLOW' });
    const audit = deferred();
    const entered = deferred();
    h.repo.recordExecutionApproval.mockImplementation(async () => { entered.resolve(); await audit.promise; });
    const pending = h.broker.request(req('job'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.fireTimer();
    await entered.promise;
    const closing = h.broker.close();
    audit.resolve();
    await closing;
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'timeout' });
  });
  it('denies a timeout allowance cancelled while its audit is pending and does not remember it', async () => {
    const h = harness({ timeoutAction: 'ALLOW' });
    const audit = deferred();
    const entered = deferred();
    h.repo.recordExecutionApproval.mockImplementation(async () => { entered.resolve(); await audit.promise; });
    const pending = h.broker.request(req('job'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.fireTimer();
    await entered.promise;
    h.broker.cancelJob('job');
    audit.resolve();
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'timeout' });
    expect(h.added).toHaveLength(0);
    expect(h.broker.listPending()).toHaveLength(0);
    const next = h.broker.request(req('next'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.broker.listPending()[0]?.jobId).toBe('next');
    h.broker.cancelJob('next');
    await next;
  });
  it('rejects repeated decisions and disallows remembering long Bash commands', async () => {
    const h = harness(); const p = h.broker.request(req('job')); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    const id = h.broker.listPending()[0]!.approvalId; await h.broker.decide(id, 'once'); await p;
    await expect(h.broker.decide(id, 'once')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
    const long = harness(); const longReq = long.broker.request(req('long', 'Bash', { command: 'x'.repeat(2001) })); await vi.waitFor(() => expect(long.broker.listPending()).toHaveLength(1));
    expect(long.broker.listPending()[0]?.canRemember).toBe(false);
    await expect(long.broker.decide(long.broker.listPending()[0]!.approvalId, 'always')).rejects.toMatchObject({ code: 'APPROVAL_REMEMBER_UNAVAILABLE' });
    long.broker.cancelJob('long'); await longReq;
    expect(new AgentApprovalBrokerError('APPROVAL_NOT_PENDING')).toBeInstanceOf(Error);
  });
  it('enforces one per job and 32 globally', async () => {
    const h = harness(); const promises = Array.from({ length: 32 }, (_, i) => h.broker.request(req(`j${i}`)));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(32));
    expect(await h.broker.request(req('j0'))).toMatchObject({ behavior: 'deny', message: 'Too many pending approvals.' });
    expect(await h.broker.request(req('overflow'))).toMatchObject({ behavior: 'deny', message: 'Too many pending approvals.' });
    h.broker.close(); await Promise.all(promises);
  });
  it('fails closed when allow audit fails', async () => {
    const h = harness({ level: 'full', auditFails: true });
    expect(await h.broker.request(req('job'))).toMatchObject({ behavior: 'deny' });
  });
  it.each(['timeout', 'abort', 'cancelJob', 'close'] as const)('holds settling always persistence through %s', async (trigger) => {
    const h = harness(); const gate = deferred(); const entered = deferred();
    h.repo.addToolAllowlistEntry.mockImplementation(async () => { entered.resolve(); await gate.promise; return {} as never; });
    const controller = new AbortController(); const p = h.broker.request(req('job', 'Bash', { command: 'x' }, controller.signal));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1)); const id = h.broker.listPending()[0]!.approvalId;
    const deciding = h.broker.decide(id, 'always'); await entered.promise;
    expect(h.broker.listPending()).toHaveLength(0);
    if (trigger === 'timeout') h.fireTimer(); else if (trigger === 'abort') controller.abort(); else if (trigger === 'cancelJob') h.broker.cancelJob('job');
    const closing = trigger === 'close' ? h.broker.close() : undefined;
    let closed = false; if (closing) void closing.then(() => { closed = true; });
    await Promise.resolve(); if (closing) expect(closed).toBe(false);
    gate.resolve(); await deciding; await closing;
    expect(await p).toMatchObject({ behavior: trigger === 'close' ? 'deny' : 'allow' });
  });
  it('keeps settling requests in capacity while hiding them from listPending', async () => {
    const h = harness(); const gate = deferred(); const entered = deferred();
    let calls = 0;
    h.repo.recordExecutionApproval.mockImplementation(async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } });
    const p = h.broker.request(req('job')); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    const id = h.broker.listPending()[0]!.approvalId; const d = h.broker.decide(id, 'once'); await entered.promise;
    expect(h.broker.listPending()).toHaveLength(0);
    await expect(h.broker.decide(id, 'once')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
    expect(await h.broker.request(req('job'))).toMatchObject({ behavior: 'deny' });
    gate.resolve(); await d; await p;
  });
  it('changes an allow to denied when close starts during audit', async () => {
    const h = harness(); const gate = deferred(); const entered = deferred();
    h.repo.recordExecutionApproval.mockImplementation(async () => { entered.resolve(); await gate.promise; });
    const p = h.broker.request(req('job')); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    const d = h.broker.decide(h.broker.listPending()[0]!.approvalId, 'once'); await entered.promise;
    const closing = h.broker.close(); gate.resolve(); await d; await closing;
    expect(await p).toMatchObject({ behavior: 'deny' }); expect(h.events.at(-1)).toMatchObject({ type: 'resolved', outcome: 'denied' });
  });
  it.each(['once', 'session', 'always'] as const)('publishes denied when %s allow audit fails', async (decision) => {
    const h = harness({ auditFails: true });
    expect(await settleApproval(h, decision)).toMatchObject({ behavior: 'deny' });
    expect(h.events.filter((e) => e.type === 'resolved')).toEqual([expect.objectContaining({ outcome: 'denied' })]);
  });
  it('uses write path evidence and exposes write target summaries', async () => {
    const h = harness();
    expect((await h.broker.request(req('inside', 'Write', { file_path: 'C:\\work\\a' }))).behavior).toBe('allow');
    const p = h.broker.request(req('outside', 'Write', { file_path: 'D:\\other\\a' })); await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.broker.listPending()[0]?.summary).toBe('D:\\other\\a'); h.broker.cancelJob('outside'); await p;
  });
  const repositoryCalls = (h: ReturnType<typeof harness>) => h.repo.getExecutionPolicy.mock.calls.length + h.repo.listToolAllowlist.mock.calls.length
    + h.repo.addToolAllowlistEntry.mock.calls.length + h.repo.recordExecutionApproval.mock.calls.length + h.evidence.mock.calls.length;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); };

  it.each(['getExecutionPolicy', 'listToolAllowlist', 'resolveWritePathEvidence', 'autoAllowAudit', 'autoDenyAudit'] as const)(
    'close() waits for an in-flight %s and the request ends as deny with no later repository call', async (held) => {
      const h = harness({ level: held === 'autoDenyAudit' ? 'read_only' : 'workspace_write' });
      const gate = deferred(); const entered = deferred();
      const hold = async () => { entered.resolve(); await gate.promise; };
      if (held === 'getExecutionPolicy') h.repo.getExecutionPolicy.mockImplementation(async () => { await hold();
        return { level: 'workspace_write', approvalTimeoutSeconds: 20, timeoutAction: 'DENY', version: 1, updatedAt: '' }; });
      if (held === 'listToolAllowlist') h.repo.listToolAllowlist.mockImplementation(async () => { await hold(); return []; });
      if (held === 'resolveWritePathEvidence') h.evidence.mockImplementation(async (target, root) => { await hold();
        return { resolvedTarget: target, resolvedWorkspaceRoot: root }; });
      if (held === 'autoAllowAudit' || held === 'autoDenyAudit') h.repo.recordExecutionApproval.mockImplementation(async () => { await hold(); });
      // A Write inside the workspace is auto-allowed at workspace_write and auto-denied at read_only.
      const request = h.broker.request(req('job', 'Write', { file_path: 'C:\\work\\a.txt' }));
      await entered.promise;
      let closed = false;
      const closing = h.broker.close().then(() => { closed = true; });
      await flush();
      expect(closed).toBe(false);
      gate.resolve();
      await closing;
      expect(await request).toMatchObject({ behavior: 'deny' });
      const callsAtClose = repositoryCalls(h);
      await flush();
      expect(repositoryCalls(h)).toBe(callsAtClose);
      expect(h.broker.listPending()).toHaveLength(0);
    });

  it('denies a request admitted after close() began with zero repository calls', async () => {
    const h = harness(); const gate = deferred(); const entered = deferred();
    h.repo.getExecutionPolicy.mockImplementationOnce(async () => { entered.resolve(); await gate.promise;
      return { level: 'workspace_write', approvalTimeoutSeconds: 20, timeoutAction: 'DENY', version: 1, updatedAt: '' }; });
    const first = h.broker.request(req('first', 'Read', { file_path: 'x' }));
    await entered.promise;
    const closing = h.broker.close();
    const before = repositoryCalls(h);
    expect(await h.broker.request(req('during', 'Read', { file_path: 'x' }))).toMatchObject({ behavior: 'deny' });
    expect(repositoryCalls(h)).toBe(before);
    gate.resolve(); await closing;
    expect(await first).toMatchObject({ behavior: 'deny' });
    expect(await h.broker.request(req('after', 'Read', { file_path: 'x' }))).toMatchObject({ behavior: 'deny' });
    expect(await h.broker.request(req('after-bash'))).toMatchObject({ behavior: 'deny' });
    expect(repositoryCalls(h)).toBe(before);
  });

  it(`caps automatic in-flight requests at ${MAX_AUTOMATIC_IN_FLIGHT} without DB work, excluding card waits`, async () => {
    const h = harness(); const gate = deferred();
    const card = h.broker.request(req('card-job'));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.repo.getExecutionPolicy.mockImplementation(async () => { await gate.promise;
      return { level: 'workspace_write', approvalTimeoutSeconds: 20, timeoutAction: 'DENY', version: 1, updatedAt: '' }; });
    const policyCallsBefore = h.repo.getExecutionPolicy.mock.calls.length;
    const held = Array.from({ length: MAX_AUTOMATIC_IN_FLIGHT }, (_, i) => h.broker.request(req(`auto-${i}`, 'Read', { file_path: 'x' })));
    await vi.waitFor(() => expect(h.repo.getExecutionPolicy.mock.calls.length - policyCallsBefore).toBe(MAX_AUTOMATIC_IN_FLIGHT));
    const before = repositoryCalls(h);
    expect(await h.broker.request(req('overflow', 'Read', { file_path: 'x' })))
      .toMatchObject({ behavior: 'deny', message: 'Too many concurrent approval requests.' });
    expect(repositoryCalls(h)).toBe(before);
    gate.resolve();
    for (const result of await Promise.all(held)) expect(result.behavior).toBe('allow');
    // Capacity is returned once the automatic requests finish.
    expect((await h.broker.request(req('after', 'Read', { file_path: 'x' }))).behavior).toBe('allow');
    h.broker.cancelJob('card-job');
    expect(await card).toMatchObject({ behavior: 'deny' });
  });

  it('clears every timer on settlement', async () => {
    const h = harness(); const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener'); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const p = h.broker.request(req('job', 'Bash', { command: 'x' }, controller.signal));
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'once'); await p;
    expect(h.timers.size).toBe(0); expect(h.timerSets).toBe(h.timerClears); expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
  });
});
