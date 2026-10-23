// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { formatReadTime } from './MessageReadReceipt.js';

describe('read receipt effective locale', () => {
  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('formats same-day and older receipts with %s Intl conventions', (locale) => {
    // Local constructors keep calendar boundaries deterministic in any test runner timezone.
    const now = new Date(2026, 9, 23, 18, 30);
    const today = new Date(2026, 9, 23, 13, 5);
    const older = new Date(2026, 8, 12, 9, 7);
    expect(formatReadTime(today.toISOString(), now, locale)).toBe(new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(today));
    expect(formatReadTime(older.toISOString(), now, locale)).toBe(new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(older));
  });
});
