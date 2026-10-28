import { describe, expect, it, vi } from 'vitest';
import { createUtilityWorkerGateway, type IngestLatencyReport } from './utility-worker-gateway.js';

class FakeChild {
  readonly posted: unknown[] = [];
  private message?: (value: unknown) => void;
  private owner: Record<string, unknown> = {};
  postMessage(value: unknown) {
    this.posted.push(value);
    if ((value as { type?: string })?.type === 'init') {
      const init = value as Record<string, unknown>;
      this.owner = { transportOwnerId: init.transportOwnerId, transportGeneration: init.transportGeneration, writeGrantVersion: init.writeGrantVersion };
    }
  }
  private exit?: () => void;
  kill() { this.exit?.(); }
  on(event: 'message' | 'exit', listener: (value?: unknown) => void) { if (event === 'message') this.message = listener; else this.exit = listener; }
  emit(value: unknown) { this.message?.({ data: { ...this.owner, ...(value as object) }, ports: [] }); }
}

const cursor = (revision: string) => ({ version: 1, revision, globalRev: revision, individualRev: '0' });
const envelope = (id: string, occurredAt: string) => ({ eventId: `e-${id}`, accountId: 'acct', chatId: 'chat', chatType: 'direct', senderId: 'u1',
  messageId: id, kind: 'text', text: 'SECRET BODY', mentionIds: [], mentionRanges: [], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt, attachments: [], raw: {} });

async function harness(handler: (event: { batchId: string; cursorAfter: unknown; controlEpoch: number; workerInstanceId: string; accountId: string }, ack: () => Promise<void>) => Promise<void>) {
  const child = new FakeChild();
  let clock = Date.parse('2026-10-28T00:00:00.000Z');
  const reports: IngestLatencyReport[] = [];
  const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, now: () => clock, onIngestLatency: (report) => reports.push(report) });
  const calls: string[] = [];
  gateway.onEvent(async (_instance, event) => {
    if (event.type !== 'batch') return;
    calls.push(event.batchId);
    await handler(event, () => gateway.send({ type: 'ackBatch', accountId: event.accountId, workerInstanceId: event.workerInstanceId,
      controlEpoch: event.controlEpoch, batchId: event.batchId, cursorAfter: event.cursorAfter }).then(() => undefined));
  });
  const binding = { accountId: 'acct', workerInstanceId: 'worker-1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  await gateway.start(binding.accountId, binding);
  const batch = (batchId: string, occurredAt: string) => child.emit({ type: 'batch', accountId: 'acct', workerInstanceId: 'worker-1', controlEpoch: 1,
    batchId, cursorBefore: cursor('0'), cursorAfter: cursor('1'), envelopes: [envelope(`m-${batchId}`, occurredAt)] });
  return { child, gateway, reports, calls, batch, advance: (ms: number) => { clock += ms; }, base: clock };
}
const iso = (ms: number) => new Date(ms).toISOString();

describe('live batch ingest dedupe and timing', () => {
  it('ingests a batchId once while it is queued, being ingested, or just acked', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness(async (_event, ack) => { await gate; await ack(); });
    h.batch('b1', iso(h.base));
    h.batch('b1', iso(h.base));
    h.batch('b1', iso(h.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toEqual(['b1']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.batch('b1', iso(h.base)); // worker has not processed the ack yet
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toEqual(['b1']);
    expect(h.child.posted.filter((item) => (item as { type?: string }).type === 'ackBatch')).toHaveLength(1);
    h.batch('b2', iso(h.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toEqual(['b1', 'b2']);
    await h.gateway.shutdown();
  });

  it('forgets a batch that finished without an ack so the next re-emission is ingested again', async () => {
    const h = await harness(async () => undefined);
    h.batch('b1', iso(h.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.batch('b1', iso(h.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toEqual(['b1', 'b1']);
    await h.gateway.shutdown();
  });

  it('records a slow LINE-to-Main batch with counts only', async () => {
    const h = await harness(async (_event, ack) => { await new Promise((resolve) => setTimeout(resolve, 3)); h.advance(1_000); await ack(); });
    h.advance(15_000);
    h.batch('b1', iso(h.base));
    h.batch('b1', iso(h.base));
    h.batch('b1', iso(h.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    expect(h.reports).toEqual([{ accountId: 'acct', workerInstanceId: 'worker-1', kind: 'upstream',
      latency: { lineToMainMs: 15_000, mainIngestMs: 1_000, queueLength: 0, messageCount: 1, reemitCount: 2 } }]);
    expect(JSON.stringify(h.reports)).not.toContain('SECRET');
    await h.gateway.shutdown();
  });

  it('records a slow Main queue/ingest batch and stays silent for fast ones', async () => {
    const slow = await harness(async (_event, ack) => { slow.advance(3_000); await ack(); });
    slow.batch('b1', iso(slow.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vi.waitFor(() => expect(slow.reports).toHaveLength(1));
    expect(slow.reports).toMatchObject([{ kind: 'main', latency: { lineToMainMs: 0, mainIngestMs: 3_000, reemitCount: 0 } }]);
    await slow.gateway.shutdown();
    const fast = await harness(async (_event, ack) => { fast.advance(500); await ack(); });
    fast.advance(4_000);
    fast.batch('b1', iso(fast.base));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fast.calls).toEqual(['b1']);
    expect(fast.reports).toEqual([]);
    await fast.gateway.shutdown();
  });

  it('treats a batch older than the backlog threshold as catch-up: never upstream, still main when Main is slow', async () => {
    const fast = await harness(async (_event, ack) => { fast.advance(100); await ack(); });
    fast.batch('b1', iso(fast.base - 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fast.calls).toEqual(['b1']);
    expect(fast.reports).toEqual([]);
    await fast.gateway.shutdown();
    const slow = await harness(async (_event, ack) => { slow.advance(3_000); await ack(); });
    slow.batch('b1', iso(slow.base - 3_600_000));
    await vi.waitFor(() => expect(slow.reports).toHaveLength(1));
    expect(slow.reports[0]).toMatchObject({ kind: 'main', latency: { mainIngestMs: 3_000 } });
    await slow.gateway.shutdown();
  });
});
