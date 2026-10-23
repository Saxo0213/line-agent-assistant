import { describe, expect, it, vi } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import { AdminPairingService } from './admin-pairing-service.js';

const message = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'event', accountId: 'account', chatType: 'direct', chatId: 'chat', senderId: 'user', messageId: 'message',
  kind: 'text', text: '123456', mentionIds: [], mentionRanges: [], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-16T00:00:00.000Z', attachments: [], raw: {}, ...overrides,
});

describe('AdminPairingService', () => {
  it('binds an exact token from live 1-to-1 chat once', async () => {
    const store = { hasPrimary: vi.fn(async () => false), bindPrimary: vi.fn(async () => true) };
    const service = new AdminPairingService(store, () => 1_000, () => '123456');
    expect(await service.begin('account')).toEqual({ token: '123456', expiresAt: new Date(181_000).toISOString() });
    expect(await service.consume(message())).toBe(true);
    expect(store.bindPrimary).toHaveBeenCalledWith('account', 'chat', 'user');
    expect(await service.consume(message())).toBe(false);
  });

  it('rejects group, history, wrong and expired tokens', async () => {
    let now = 1_000;
    const store = { hasPrimary: vi.fn(async () => false), bindPrimary: vi.fn(async () => true) };
    const service = new AdminPairingService(store, () => now, () => '123456');
    await service.begin('account');
    expect(await service.consume(message({ chatType: 'group' }))).toBe(false);
    expect(await service.consume(message({ ingestion: { source: 'history', cursor: null } }))).toBe(false);
    expect(await service.consume(message({ text: '654321' }))).toBe(false);
    now = 181_000;
    expect(await service.consume(message())).toBe(false);
    expect(store.bindPrimary).not.toHaveBeenCalled();
  });
});
