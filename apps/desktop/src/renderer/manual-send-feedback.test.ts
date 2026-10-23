import { describe, expect, it } from 'vitest';
import { addManualSendFeedback, type ManualSendFeedback } from './manual-send-feedback.js';

const entry = (id: string, status: ManualSendFeedback['status']): ManualSendFeedback => ({
  id, key: { accountId: 'a', chatType: 'group', chatId: id }, routeKey: id, text: id,
  replyToMessageId: null, createdAt: id, status,
});

describe('bounded manual send feedback', () => {
  it('evicts the oldest settled entry and never evicts a pending entry', () => {
    const entries = Array.from({ length: 99 }, (_, index) => entry(`pending-${index}`, 'pending'));
    entries.unshift(entry('oldest-failed', 'failed'));
    const next = addManualSendFeedback(entries, entry('new-entry', 'pending'));
    expect(next).toHaveLength(100);
    expect(next?.some((item) => item.id === 'oldest-failed')).toBe(false);
    expect(next?.filter((item) => item.status === 'pending')).toHaveLength(100);
  });

  it('rejects a new entry when all 100 retained entries are pending', () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry(`pending-${index}`, 'pending'));
    expect(addManualSendFeedback(entries, entry('overflow', 'pending'))).toBeNull();
  });
});
