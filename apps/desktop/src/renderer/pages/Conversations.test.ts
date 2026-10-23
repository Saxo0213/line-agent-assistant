// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import { describe, expect, it } from 'vitest';
import { formatCallLabelFor } from './Conversations.js';
import { chatTypeLabel } from '../chatTypeLabels.js';

describe('formatCallLabel', () => {
  it.each([
    ['en', 'Direct'], ['zh-TW', '個人'], ['ja', '個人'], ['ko', '일대일'],
  ] as const)('uses the selected %s catalog', (locale, expected) => {
    expect(chatTypeLabel(locale, 'direct')).toBe(expected);
  });
  it('formats audio and video durations', () => {
    expect(formatCallLabelFor('zh-TW', { media: 'audio', result: 'NORMAL', durationMs: 74000 }, 'outbound', 6, null)).toBe('語音通話 · 通話時間 01:14');
    expect(formatCallLabelFor('zh-TW', { media: 'video', result: 'NORMAL', durationMs: 3725000 }, 'outbound', 6, null)).toBe('視訊通話 · 通話時間 1:02:05');
  });
  it('labels canceled and other unsuccessful calls by direction', () => {
    const canceled = { media: 'audio' as const, result: 'CANCELED', durationMs: 0 };
    expect(formatCallLabelFor('zh-TW', canceled, 'inbound', 6, null)).toBe('未接來電');
    expect(formatCallLabelFor('zh-TW', canceled, 'outbound', 6, null)).toBe('已取消通話');
    expect(formatCallLabelFor('zh-TW', { ...canceled, result: 'BUSY' }, 'inbound', 6, null)).toBe('未接來電');
    expect(formatCallLabelFor('zh-TW', { ...canceled, result: 'BUSY' }, 'outbound', 6, null)).toBe('對方未接聽');
    expect(formatCallLabelFor('zh-TW', { ...canceled, result: 'NORMAL', durationMs: null }, 'outbound', 6, null)).toBe('對方未接聽');
  });
  it('preserves the old system event label when call data is absent', () => {
    expect(formatCallLabelFor('zh-TW', undefined, 'inbound', 6, 'legacy')).toBe('通話 legacy');
  });
});
