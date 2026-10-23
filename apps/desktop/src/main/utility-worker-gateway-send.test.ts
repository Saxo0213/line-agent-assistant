import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUtilityWorkerGateway } from './utility-worker-gateway.js';

class FakeChild {
  readonly posted: any[] = [];
  private message?: (value: unknown) => void;
  private exit?: () => void;
  private owner: Record<string, unknown> = {};
  postMessage(value: any) {
    this.posted.push(value);
    if (value?.type === 'init') {
      this.owner = { transportOwnerId: value.transportOwnerId, transportGeneration: value.transportGeneration,
        writeGrantVersion: value.writeGrantVersion };
    }
  }
  kill() { this.exit?.(); }
  on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
    if (event === 'message') this.message = listener; else this.exit = listener;
  }
  emitRaw(value: unknown) {
    const requestId = (value as { requestId?: string }).requestId;
    const sent = requestId && [...this.posted].reverse().find((item) => item.requestId === requestId);
    this.message?.({ data: { ...this.owner, ...(sent ? { operationId: sent.operationId, attemptId: sent.attemptId } : {}),
      ...(value as object) }, ports: [] });
  }
  ack(current: Record<string, unknown>) {
    const { accountId, workerInstanceId, controlEpoch } = current as { accountId: string; workerInstanceId: string; controlEpoch: number };
    this.emitRaw({ type: 'workerProtocolAck', accountId, workerInstanceId, controlEpoch, protocolVersion: 4, manualSend: true });
    this.emitRaw({ type: 'modeAck', ...current, mode: 'ACTIVE_CONTROL', drained: true });
  }
  sent(current: Record<string, unknown>, requestId: string, status: 'sent' | 'failed' = 'sent') {
    const { accountId, workerInstanceId, controlEpoch } = current as { accountId: string; workerInstanceId: string; controlEpoch: number };
    this.emitRaw({ type: 'sendResult', accountId, workerInstanceId, controlEpoch, requestId, status, messageId: status === 'sent' ? 'm' : null, error: null });
  }
  get sends() { return this.posted.filter((item) => ['sendText', 'manualSendText', 'sendMedia'].includes(item.type)); }
}

const sha256 = 'a'.repeat(64);
type Gateway = ReturnType<typeof createUtilityWorkerGateway>;
const open: Gateway[] = [];
afterEach(async () => {
  for (const gateway of open.splice(0)) await gateway.shutdown().catch(() => undefined);
  vi.useRealTimers();
});

async function harness(extra: Parameters<typeof createUtilityWorkerGateway>[0] extends infer T ? Partial<T> : never = {}) {
  const children = new Map<string, FakeChild>();
  const gateway = createUtilityWorkerGateway({ spawn: (binding: { accountId: string }) => { const child = new FakeChild(); children.set(binding.accountId, child); return child; },
    pollIntervalMs: 3_600_000, random: () => 0, ...extra } as never);
  open.push(gateway);
  const accounts = new Map<string, Record<string, unknown>>();
  const add = async (accountId: string) => {
    const current = await gateway.start(accountId, { accountId, workerInstanceId: `${accountId}-w`, controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    children.get(accountId)!.ack(current as never);
    accounts.set(accountId, current as never);
    return current as Record<string, unknown>;
  };
  const text = (accountId: string, requestId: string, body = 'hi') => gateway.send({ type: 'sendText', ...accounts.get(accountId)!,
    requestId, chatType: 'direct', chatId: 'u-peer', text: body, replyToMessageId: null } as never);
  const media = (accountId: string, requestId: string, signal?: AbortSignal) => gateway.sendMedia!({ ...(accounts.get(accountId) as object),
    requestId, chatType: 'direct', chatId: 'u-peer', kind: 'file', filePath: 'C:\\work\\a.bin', fileName: 'a.bin', sizeBytes: 3, sha256 } as never, signal);
  return { gateway, children, accounts, add, text, media };
}

describe('media send gateway', () => {
  it('serializes media sends across accounts and fills owner fields, permit and timeout', async () => {
    const h = await harness();
    await h.add('a1'); await h.add('a2');
    const first = h.media('a1', 'm1');
    const second = h.media('a2', 'm2');
    await vi.waitFor(() => expect(h.children.get('a1')!.sends).toHaveLength(1));
    expect(h.children.get('a1')!.sends[0]).toMatchObject({ type: 'sendMedia', timeoutMs: 120_000, operationId: 'm1',
      transportOwnerId: expect.any(String), effectPermit: expect.any(String), attemptId: expect.any(String) });
    expect(h.children.get('a2')!.sends).toHaveLength(0);
    h.children.get('a1')!.sent(h.accounts.get('a1')!, 'm1');
    await expect(first).resolves.toMatchObject({ status: 'sent' });
    await vi.waitFor(() => expect(h.children.get('a2')!.sends).toHaveLength(1));
    h.children.get('a2')!.sent(h.accounts.get('a2')!, 'm2');
    await expect(second).resolves.toMatchObject({ status: 'sent' });
  });

  it('releases the media slot on a gateway timeout and on cancellation', async () => {
    vi.useFakeTimers();
    const h = await harness();
    await h.add('a1'); await h.add('a2');
    const first = h.media('a1', 'm1');
    const second = h.media('a2', 'm2');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.children.get('a2')!.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(125_000);
    await expect(first).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.children.get('a2')!.sends).toHaveLength(1);
    const controller = new AbortController();
    const third = h.media('a1', 'm3', controller.signal);
    const cancelled = expect(third).rejects.toThrow('cancelled');
    controller.abort();
    await cancelled;
    h.children.get('a2')!.sent(h.accounts.get('a2')!, 'm2');
    await expect(second).resolves.toMatchObject({ status: 'sent' });
  });

  it('leaves no timers or listeners after a drain and shutdown', async () => {
    vi.useFakeTimers();
    const h = await harness();
    await h.add('a1');
    const controller = new AbortController();
    const send = h.media('a1', 'm1', controller.signal);
    const queued = h.media('a1', 'm2');
    const rejected = expect(queued).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    h.children.get('a1')!.sent(h.accounts.get('a1')!, 'm1');
    await send;
    await h.gateway.shutdown();
    await rejected;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.gateway.inventory!()).toMatchObject({ ownedTimers: 0, ownedListeners: 0, pendingTasks: 0 });
  });
});

describe('send pacing', () => {
  it('sends the first message after idle immediately and spaces the next by the drawn gap', async () => {
    vi.useFakeTimers();
    const h = await harness({ random: () => 0.5 });
    await h.add('a1');
    const child = h.children.get('a1')!;
    const one = h.text('a1', 's1');
    expect(child.sends).toHaveLength(1);
    const startedAt = Date.now();
    const two = h.text('a1', 's2');
    child.sent(h.accounts.get('a1')!, 's1');
    await one;
    const gap = 1_000 + Math.floor(0.5 * 2_001) + 40; // 'hi' adds 2 chars x 20 ms
    await vi.advanceTimersByTimeAsync(gap - 1);
    expect(child.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.sends).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(gap);
    child.sent(h.accounts.get('a1')!, 's2');
    await two;
  });

  it('keeps the random gap within 1000-3000 ms', async () => {
    for (const [value, expected] of [[0, 1_040], [0.9999999, 3_040]] as const) { // plus 40 ms for the 2-char body
      vi.useFakeTimers();
      const h = await harness({ random: () => value });
      await h.add('a1');
      const child = h.children.get('a1')!;
      const one = h.text('a1', 's1');
      child.sent(h.accounts.get('a1')!, 's1');
      await one;
      const two = h.text('a1', 's2');
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(child.sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.sends).toHaveLength(2);
      child.sent(h.accounts.get('a1')!, 's2');
      await two;
      await h.gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('adds 20 ms per character for text, capped at 7000 ms, and nothing for media', async () => {
    vi.useFakeTimers();
    const h = await harness({ random: () => 0 });
    await h.add('a1');
    const child = h.children.get('a1')!;
    const settle = async (requestId: string, pending: Promise<unknown>) => { child.sent(h.accounts.get('a1')!, requestId); await pending; };
    await settle('s1', h.text('a1', 's1'));
    const hundred = h.text('a1', 's2', 'x'.repeat(100));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(child.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.sends).toHaveLength(2);
    await settle('s2', hundred);
    const long = h.text('a1', 's3', '\u{1F600}'.repeat(1_000));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(child.sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.sends).toHaveLength(3);
    await settle('s3', long);
    const media = h.media('a1', 'm1');
    await vi.advanceTimersByTimeAsync(999);
    expect(child.sends).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.sends).toHaveLength(4);
    await settle('m1', media);
  });

  it('does not let one account block another', async () => {
    vi.useFakeTimers();
    const h = await harness({ random: () => 0.9 });
    await h.add('a1'); await h.add('a2');
    const one = h.text('a1', 's1');
    h.children.get('a1')!.sent(h.accounts.get('a1')!, 's1');
    await one;
    const waiting = h.text('a1', 's2');
    const other = h.text('a2', 'o1');
    expect(h.children.get('a2')!.sends).toHaveLength(1);
    expect(h.children.get('a1')!.sends).toHaveLength(1);
    h.children.get('a2')!.sent(h.accounts.get('a2')!, 'o1');
    await other;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.children.get('a1')!.sends).toHaveLength(2);
    h.children.get('a1')!.sent(h.accounts.get('a1')!, 's2');
    await waiting;
  });

  it('starts the response timeout at dispatch, not at enqueue', async () => {
    vi.useFakeTimers();
    const h = await harness({ random: () => 0, responseTimeoutMs: 5_000 });
    await h.add('a1');
    const child = h.children.get('a1')!;
    const one = h.text('a1', 's1');
    child.sent(h.accounts.get('a1')!, 's1');
    await one;
    const two = h.text('a1', 's2');
    await vi.advanceTimersByTimeAsync(1_040);
    expect(child.sends).toHaveLength(2);
    let settled = false;
    void two.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(two).resolves.toMatchObject({ status: 'unknown' });
  });

  it('cancels the pending gap on revokeControl, stop and shutdown, leaving no timers', async () => {
    vi.useFakeTimers();
    const h = await harness({ random: () => 0.9 });
    await h.add('a1'); await h.add('a2'); await h.add('a3');
    for (const id of ['a1', 'a2', 'a3']) {
      const first = h.text(id, `${id}-1`);
      h.children.get(id)!.sent(h.accounts.get(id)!, `${id}-1`);
      await first;
    }
    const revoked = h.text('a1', 'a1-2');
    const stopped = h.text('a2', 'a2-2');
    const closing = h.text('a3', 'a3-2');
    const outcomes = [expect(revoked).resolves.toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED' }),
      expect(stopped).rejects.toThrow(), expect(closing).rejects.toThrow()];
    await h.gateway.send({ type: 'revokeControl', ...h.accounts.get('a1')! } as never);
    await h.gateway.stop('a2');
    await h.gateway.shutdown();
    await Promise.all(outcomes);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const id of ['a1', 'a2', 'a3']) expect(h.children.get(id)!.sends).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
