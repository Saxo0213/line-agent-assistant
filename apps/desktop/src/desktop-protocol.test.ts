import { describe, expect, it } from 'vitest';
import { DesktopReadRequestSchema, DesktopReadResultSchema, MessagePageSchema } from './desktop-protocol.js';

describe('list-message timeline contract', () => {
  const base = {
    accountId: 'account-A', chatType: 'direct', chatId: 'chat-A', messageId: 'message-A',
    senderId: 'user-A', senderName: 'Sender', senderAvatarAvailable: false, text: null,
    occurredAt: '2026-10-17T00:00:00.000Z', direction: 'inbound', replyToMessageId: null, replyTo: null,
    deleted: false, attachments: [],
  } as const;

  it('carries only an allowlisted sticker descriptor on timeline rows', () => {
    const page = MessagePageSchema.parse({ messages: [{ ...base, kind: 'sticker', sticker: {
      stickerId: '123456789', animated: true, altText: 'Hello sticker',
    } }], olderCursor: null });

    expect(page.messages[0]).toMatchObject({ kind: 'sticker', sticker: {
      stickerId: '123456789', animated: true, altText: 'Hello sticker',
    } });
    expect(MessagePageSchema.safeParse({ messages: [{ ...base, kind: 'sticker', sticker: {
      stickerId: '123/../../escape', animated: true, altText: null,
    } }], olderCursor: null }).success).toBe(false);
    expect(MessagePageSchema.safeParse({ messages: [{ ...base, kind: 'sticker', sticker: {
      stickerId: '123456789', animated: true, altText: null, sourceUrl: 'https://example.test/x.png',
    } }], olderCursor: null }).success).toBe(false);
  });

  it('defaults absent mention ranges and normalizes invalid or overlapping ranges before validation', () => {
    const page = MessagePageSchema.parse({ messages: [{ ...base, text: 'A😀B', kind: 'text', sticker: null,
      mentionRanges: [{ start: 3, end: 4, userId: 'user-B' }, { start: 1, end: 3, userId: 'user-A' },
        { start: 2, end: 3, userId: 'split-surrogate' }, { start: 1, end: 4, userId: 'overlap' },
        { start: 0, end: 1, userId: '' }, { start: 9, end: 10, userId: 'outside' }, null],
    }], olderCursor: null });
    expect(page.messages[0]?.mentionRanges).toEqual([{ start: 1, end: 3, userId: 'user-A' }, { start: 3, end: 4, userId: 'user-B' }]);
    expect(MessagePageSchema.parse({ messages: [{ ...base, text: 'plain', kind: 'text', sticker: null }], olderCursor: null })
      .messages[0]?.mentionRanges).toEqual([]);
    expect(MessagePageSchema.parse({ messages: [{ ...base, text: 'plain', kind: 'text', sticker: null, mentionRanges: null }], olderCursor: null })
      .messages[0]?.mentionRanges).toEqual([]);
  });
});

describe('system activity read contracts', () => {
  it('accepts bounded activity and error projections and rejects sensitive or oversized rows', () => {
    const activity = { type: 'listSystemActivity', partial: false, activity: [
      { kind: 'audit', createdAt: '2026-10-17T10:00:00.000Z', action: '系統啟動', phase: '已完成' },
      { kind: 'attachment', createdAt: '2026-10-17T10:01:00.000Z', action: '圖片下載', status: '等待下載', attachmentKind: 'image', retryCount: 0,
        key: { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' } },
    ] };
    const errors = { type: 'listSystemErrors', partial: true, errors: [
      { createdAt: '2026-10-17T10:02:00.000Z', action: '附件下載', code: 'ATTACHMENT_DOWNLOAD_FAILED' },
    ] };
    expect(DesktopReadRequestSchema.parse({ type: 'listSystemActivity' })).toEqual({ type: 'listSystemActivity' });
    expect(DesktopReadRequestSchema.parse({ type: 'listSystemErrors' })).toEqual({ type: 'listSystemErrors' });
    expect(DesktopReadResultSchema.parse(activity)).toEqual(activity);
    expect(DesktopReadResultSchema.parse(errors)).toEqual(errors);
    expect(DesktopReadResultSchema.safeParse({ ...errors, errors: Array(101).fill(errors.errors[0]) }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ ...errors, errors: [{ ...errors.errors[0], path: 'C:\\secret' }] }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ ...errors, errors: [{ ...errors.errors[0], code: 'SECRET_CUSTOMER_VALUE' }] }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ ...errors, errors: [{ ...errors.errors[0], action: 'customer@example.com' }] }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ ...activity, activity: [{ ...activity.activity[1], attachmentId: 'secret-id' }] }).success).toBe(false);
  });
});

describe('friend list read contract', () => {
  const row = { mid: 'u1', name: 'Amy', avatarAvailable: false, hasConversation: true };
  it('declares every field of the strict friend request and result', () => {
    expect(DesktopReadRequestSchema.safeParse({ type: 'listFriends', accountId: 'a' }).success).toBe(true);
    expect(DesktopReadRequestSchema.safeParse({ type: 'listFriends', accountId: 'a', extra: 1 }).success).toBe(false);
    expect(DesktopReadRequestSchema.safeParse({ type: 'listFriends' }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ type: 'listFriends', friends: [row] }).success).toBe(true);
    expect(DesktopReadResultSchema.safeParse({ type: 'listFriends', friends: [{ ...row, picturePath: 'secret' }] }).success).toBe(false);
    expect(DesktopReadResultSchema.safeParse({ type: 'listFriends', friends: Array(5001).fill(row) }).success).toBe(false);
  });
});
