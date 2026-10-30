// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import { describe, expect, it } from 'vitest';
import { formatCallLabelFor } from './Conversations.js';
import { generatedPreviewFor } from '../desktop-i18n.js';
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

  it.each([
    ['zh-TW', '語音通話 · 通話時間 02:18', '視訊通話 · 通話時間 1:02:05', '未接來電', '已取消通話', '對方未接聽', '通話'],
    ['en', 'Voice call · Duration 02:18', 'Video call · Duration 1:02:05', 'Missed call', 'Cancelled call', 'No answer', 'Call'],
  ] as const)('chat-list preview of a call matches the timeline text in %s', (locale, voice, video, missed, cancelled, noAnswer, bare) => {
    const facts = (call: { media: 'audio' | 'video' | null; result: string | null; durationMs: number | null }, direction: 'inbound' | 'outbound') =>
      generatedPreviewFor(locale, { kind: 'call', call: { ...call, direction } }, 'Call History : 138000 millisecs');
    expect(facts({ media: 'audio', result: 'NORMAL', durationMs: 138000 }, 'inbound')).toBe(voice);
    expect(facts({ media: 'video', result: 'NORMAL', durationMs: 3725000 }, 'outbound')).toBe(video);
    expect(facts({ media: 'audio', result: 'CANCELED', durationMs: 0 }, 'inbound')).toBe(missed);
    expect(facts({ media: 'audio', result: 'CANCELED', durationMs: 0 }, 'outbound')).toBe(cancelled);
    expect(facts({ media: 'audio', result: 'NORMAL', durationMs: null }, 'outbound')).toBe(noAnswer);
    expect(generatedPreviewFor(locale, { kind: 'call' }, 'Call History : 138000 millisecs')).toBe(bare);
    for (const direction of ['inbound', 'outbound'] as const) for (const call of [{ media: 'audio', result: 'NORMAL', durationMs: 74000 }, { media: 'video', result: 'BUSY', durationMs: null }] as const) {
      expect(facts(call, direction)).toBe(formatCallLabelFor(locale, call, direction, 6, null));
    }
  });
  it.each([
    ['ja', '音声通話・通話時間 02:18', '不在着信', 'キャンセルされた通話', '応答なし'],
    ['ko', '음성 통화', '부재중 통화', '취소된 통화', '응답 없음'],
  ] as const)('chat-list call preview uses the %s copy', (locale, voice, missed, cancelled, noAnswer) => {
    const facts = (call: { media: 'audio' | 'video' | null; result: string | null; durationMs: number | null }, direction: 'inbound' | 'outbound') =>
      generatedPreviewFor(locale, { kind: 'call', call: { ...call, direction } }, null);
    expect(facts({ media: 'audio', result: 'NORMAL', durationMs: 138000 }, 'inbound')).toContain(voice);
    expect(facts({ media: 'audio', result: 'NORMAL', durationMs: 138000 }, 'inbound')).toContain('02:18');
    expect(facts({ media: 'audio', result: 'CANCELED', durationMs: 0 }, 'inbound')).toBe(missed);
    expect(facts({ media: 'audio', result: 'CANCELED', durationMs: 0 }, 'outbound')).toBe(cancelled);
    expect(facts({ media: 'audio', result: 'BUSY', durationMs: null }, 'outbound')).toBe(noAnswer);
  });
});
