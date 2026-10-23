import { describe, expect, it } from 'vitest';
import { lineMediaUrl, parseLineMediaUrl } from './line-media-url.js';
import type { LineMediaTarget } from './ipc.js';

describe('line media fixed URLs', () => {
  const unusual = 'id / ? # % . .. 空白 中文 😀';
  const targets: LineMediaTarget[] = [
    { type: 'account', accountId: unusual },
    { type: 'conversation', accountId: unusual, chatType: 'group', chatId: unusual },
    { type: 'member', accountId: unusual, chatType: 'community', chatId: unusual, memberId: unusual },
    { type: 'sticker', accountId: unusual, chatType: 'group', chatId: unusual, messageId: unusual },
    { type: 'sticon', accountId: unusual, chatType: 'direct', chatId: unusual, messageId: unusual, index: 63 },
    { type: 'attachment', accountId: unusual, chatType: 'group', chatId: unusual, attachmentId: unusual },
    { type: 'reaction', accountId: unusual, chatType: 'group', chatId: unusual, messageId: unusual, productId: '60ebfdc03cc24041bb139cf5', emojiId: '004' },
  ];

  it.each(targets)('round trips %s through WHATWG URL normalization', (target) => {
    const url = lineMediaUrl(target);
    expect(url).not.toBeNull();
    expect(parseLineMediaUrl(new URL(url!).href)).toEqual(target);
  });

  it.each(['\uFEFF', '\uFEFFx', '.', '..', '中文😀', 'a/b?c#d%e'])(
    'round trips each identifier exactly through WHATWG normalization for %s', (value) => {
      const cases: LineMediaTarget[] = [
        { type: 'account', accountId: value },
        { type: 'conversation', accountId: value, chatType: 'group', chatId: value },
        { type: 'member', accountId: value, chatType: 'group', chatId: value, memberId: value },
        { type: 'sticker', accountId: value, chatType: 'group', chatId: value, messageId: value },
        { type: 'sticon', accountId: value, chatType: 'group', chatId: value, messageId: value, index: 0 },
        { type: 'attachment', accountId: value, chatType: 'group', chatId: value, attachmentId: value },
      ];
      for (const target of cases) {
        const url = lineMediaUrl(target)!;
        const parsed = parseLineMediaUrl(new URL(url).href);
        expect(parsed).toEqual(target);
      }
    },
  );

  it.each([
    '', 'https://example.test/avatar/account/a', 'line-media://unknown/account/a',
    'line-media://avatar/account', 'line-media://avatar/account/YQ/extra',
    'line-media://avatar/conversation/YQ/group/Y2hhdA/extra',
    'line-media://avatar/member/YQ/group/Y2hhdA', 'line-media://sticon/YQ/group/Y2hhdA/bQ/64',
    'line-media://sticon/YQ/group/Y2hhdA/bQ/nope', 'line-media://reaction/YQ/group/Y2hhdA/bQ/XYZ/004',
    'line-media://reaction/YQ/group/Y2hhdA/bQ/60ebfdc03cc24041bb139cf5/abc', 'line-media://reaction/YQ/group/Y2hhdA/bQ/60ebfdc03cc24041bb139cf5', 'line-media://attachment/YQ/group/Y2hhdA/',
    'line-media://avatar/account/!!!!', 'line-media://avatar/account/_w',
    'line-media://avatar/account/YQ?query=1', 'line-media://avatar/account/YQ#fragment',
  ])('returns null for invalid URL %s', (url) => expect(parseLineMediaUrl(url)).toBeNull());

  it('returns null for invalid inputs and lone surrogates without throwing', () => {
    expect(lineMediaUrl({ type: 'account', accountId: '' } as LineMediaTarget)).toBeNull();
    expect(lineMediaUrl({ type: 'account', accountId: '\ud800' })).toBeNull();
    expect(lineMediaUrl({ type: 'member', accountId: 'a', chatType: 'group', chatId: 'c', memberId: '' })).toBeNull();
    expect(parseLineMediaUrl(null as unknown as string)).toBeNull();
  });
});
