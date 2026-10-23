import { describe, expect, it } from 'vitest';
import { createFakeExternalMonitorAdapter } from './external-monitor-adapter.js';

describe('external monitor adapter boundary', () => {
  it('provides a bounded fake reader and no write operation', async () => {
    const adapter = createFakeExternalMonitorAdapter(Array.from({ length: 3 }, (_, index) => ({
      observationId: `fake-${index}`, canonicalMessageId: null, chatType: 'direct' as const,
      chatId: 'chat', senderId: 'sender', kind: 'text', text: 'history', occurredAt: '2026-10-17T00:00:00Z',
    })));
    await expect(adapter.verifySource({ accountId: 'a', ownMid: 'mid-a' })).resolves.toEqual({ sourceIdentity: 'fake:a:mid-a' });
    const fence = { expectedModeRevision: 7, expectedCheckpoint: { rowid: '42' } };
    const batch = await adapter.readBatch({ accountId: 'a', sourceId: 'source-a', generation: 1, fence, cursor: null, limit: 2 });
    expect(batch.observations).toHaveLength(2);
    expect(batch).toMatchObject(fence);
    expect('send' in adapter).toBe(false);
  });
});
