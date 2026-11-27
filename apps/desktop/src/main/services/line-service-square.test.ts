import { describe, expect, it, vi } from 'vitest';
import type { LineWorkerCommand, LineWorkerEvent, SafeDiagnostic } from '@line-agent/contracts';
import { LineService } from './line-service.js';

type SquareBatch = Extract<LineWorkerEvent, { type: 'squareBatch' }>;
const chatId = `m${'1'.repeat(32)}`;
const senderId = `p${'2'.repeat(32)}`;
const binding = { accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
const squareBatch = (overrides: Partial<SquareBatch> = {}): SquareBatch => ({ type: 'squareBatch', accountId: 'a', workerInstanceId: 'w1',
  controlEpoch: 1, batchId: 'sq1', tokenBefore: null, tokenAfter: 'token-1',
  envelopes: [{ eventId: 'e1', accountId: 'a', chatType: 'community', chatId, senderId, messageId: 'sm1', kind: 'text', text: 'hello',
    mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
    occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: { square: { eventType: 'RECEIVE_MESSAGE', own: false } } }],
  ...overrides } as SquareBatch);

function harness(options: { status?: unknown; receive?: boolean; role?: 'AGENT' | 'PRIMARY_ADMIN' } = {}) {
  const commands: LineWorkerCommand[] = [];
  const diagnostics: SafeDiagnostic[] = [];
  const forbidden = vi.fn(async () => { throw new Error('Talk routing must not run for a community batch'); });
  const ingestSquareBatch = vi.fn(async (_input: unknown) => options.status ?? { status: 'stored', inserted: 1 });
  const getAttachmentBySource = vi.fn(async () => null as { attachmentId: string } | null);
  const setAttachmentBlockReason = vi.fn(async () => true);
  const messages = { ingestSquareBatch, getAttachmentBySource, setAttachmentBlockReason,
    ingestBatchAndRoute: forbidden, ingestBatchSource: forbidden, admitLiveBatch: forbidden, prepareBatchConversations: forbidden,
    existingLiveRoutes: forbidden, recordBatchRoutes: forbidden };
  const accounts = { async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; },
    async resolveCapabilities() { return { productRole: options.role ?? 'AGENT', connectionMode: 'SYSTEM_LOGIN' }; } };
  const settings = { getLineSquareReceive: vi.fn(async () => options.receive ?? true) };
  const kick = vi.fn();
  const classifyInbound = vi.fn(async () => false);
  const service = new LineService(accounts as never, messages as never, settings as never, { async send(command) { commands.push(command); } },
    { kick, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    classifyInbound, undefined, undefined, undefined, 'en', (diagnostic) => diagnostics.push(diagnostic));
  return { service, commands, diagnostics, ingestSquareBatch, getAttachmentBySource, setAttachmentBlockReason, kick, classifyInbound, forbidden };
}

describe('LineService community batch', () => {
  it('stores a batch for archive only, acks it with the batch token and gives the new message ids', async () => {
    const h = harness();
    await h.service.bind(binding);
    await expect(h.service.handleWorkerEvent('w1', squareBatch())).resolves.toEqual(['sm1']);
    expect(h.ingestSquareBatch).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', batchId: 'sq1', tokenBefore: null,
      tokenAfter: 'token-1', lease: { workerInstanceId: 'w1', controlEpoch: 1 } }));
    expect(h.commands).toEqual([{ type: 'ackSquareBatch', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, batchId: 'sq1', tokenAfter: 'token-1' }]);
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.classifyInbound).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
    expect(h.diagnostics).toEqual([]);
  });

  it('acks a replay again and publishes nothing', async () => {
    const h = harness({ status: { status: 'replay' } });
    await h.service.bind(binding);
    await expect(h.service.handleWorkerEvent('w1', squareBatch())).resolves.toBeUndefined();
    expect(h.commands).toMatchObject([{ type: 'ackSquareBatch', batchId: 'sq1', tokenAfter: 'token-1' }]);
  });

  it.each(['token_conflict', 'digest_conflict'])('does not ack %s and records one diagnostic for each batch', async (status) => {
    const h = harness({ status: { status } });
    await h.service.bind(binding);
    await h.service.handleWorkerEvent('w1', squareBatch());
    await h.service.handleWorkerEvent('w1', squareBatch());
    expect(h.commands).toEqual([]);
    expect(h.diagnostics).toEqual([expect.objectContaining({ operation: 'ackSquareBatch', detail: `square_batch:${status}` })]);
    await h.service.handleWorkerEvent('w1', squareBatch({ batchId: 'sq2' }));
    expect(h.diagnostics).toHaveLength(2);
  });

  it('does not store or ack when the setting is off, and records one diagnostic', async () => {
    const h = harness({ receive: false });
    await h.service.bind(binding);
    await h.service.handleWorkerEvent('w1', squareBatch());
    await h.service.handleWorkerEvent('w1', squareBatch({ batchId: 'sq2' }));
    expect(h.ingestSquareBatch).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.diagnostics).toEqual([expect.objectContaining({ operation: 'ackSquareBatch', detail: 'square_receive_off' })]);
  });

  it('does not store a batch of a non-Agent account', async () => {
    const h = harness({ role: 'PRIMARY_ADMIN' });
    await h.service.bind(binding);
    await h.service.handleWorkerEvent('w1', squareBatch());
    expect(h.ingestSquareBatch).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  it('does not store a batch from a stale control epoch', async () => {
    const h = harness();
    await h.service.bind(binding);
    await h.service.handleWorkerEvent('w1', squareBatch({ controlEpoch: 2 }));
    expect(h.ingestSquareBatch).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  it('keeps a store failure as one diagnostic with no ack and no throw', async () => {
    const h = harness();
    h.ingestSquareBatch.mockRejectedValue(new Error('db down'));
    await h.service.bind(binding);
    await expect(h.service.handleWorkerEvent('w1', squareBatch())).resolves.toBeUndefined();
    expect(h.commands).toEqual([]);
    expect(h.diagnostics).toEqual([expect.objectContaining({ operation: 'ackSquareBatch', detail: 'square_batch:store_failed' })]);
  });

  it('marks a new community attachment as not available', async () => {
    const h = harness();
    h.getAttachmentBySource.mockResolvedValue({ attachmentId: 'att-1' });
    const event = squareBatch();
    event.envelopes = [{ ...event.envelopes[0]!, kind: 'image',
      attachments: [{ id: 'ext-1', kind: 'image', name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }] } as never];
    await h.service.bind(binding);
    await h.service.handleWorkerEvent('w1', event);
    expect(h.setAttachmentBlockReason).toHaveBeenCalledWith('att-1', 'COMMUNITY_DOWNLOAD_UNSUPPORTED');
    expect(h.commands).toMatchObject([{ type: 'ackSquareBatch' }]);
  });

  it('does not change the connection state for the square suspension error', async () => {
    const h = harness();
    await h.service.bind(binding);
    const apply = vi.fn(async () => true);
    (h.service as unknown as { accounts: { applyWorkerConnectionStatus: unknown } }).accounts.applyWorkerConnectionStatus = apply;
    await h.service.handleWorkerEvent('w1', { type: 'error', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      code: 'LINE_SQUARE_SUSPENDED', message: 'LINE_SQUARE_SUSPENDED', retryable: false } as LineWorkerEvent);
    expect(apply).not.toHaveBeenCalled();
  });
});
