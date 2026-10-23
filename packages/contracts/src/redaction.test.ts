import { describe, expect, it } from 'vitest';
import { redactMessageContent, redactRoomTokens, redactSensitiveString, redactSensitiveText, redactVerificationCodes, storedTextForKind } from './redaction.js';

describe('shared message-text storage contract', () => {
  it('replaces only the matched substring with its marker', () => {
    expect(redactVerificationCodes('use LW-ABCDEFGH now').text).toBe('use [REDACTED_VERIFICATION_CODE] now');
    expect(redactRoomTokens('join RA-a1b2_c3 please').text).toBe('join [REDACTED] please');
    expect(redactSensitiveText('LW-ABCDEFGH and RA-xyz and LW-ZZZZZZZ2').text)
      .toBe('[REDACTED_VERIFICATION_CODE] and [REDACTED] and [REDACTED_VERIFICATION_CODE]');
    expect(redactSensitiveText('nothing secret').redacted).toBe(false);
    // The alphabet excludes ambiguous characters, so this is not a code.
    expect(redactVerificationCodes('LW-ABCDEFGO').text).toBe('LW-ABCDEFGO');
    expect(redactSensitiveString('file-LW-ABCDEFGH.pdf')).toBe('file-[REDACTED_VERIFICATION_CODE].pdf');
  });

  it('recomputes mention ranges against the redacted text and drops ranges overlapping a secret', () => {
    const text = 'LW-ABCDEFGH hi @Bob and @Cy';
    const result = redactVerificationCodes(text, [
      { start: 15, end: 19, userId: 'bob' }, { start: 24, end: 27, userId: 'cy' }]);
    expect(result.text).toBe('[REDACTED_VERIFICATION_CODE] hi @Bob and @Cy');
    expect(result.mentionRanges.map((range) => result.text.slice(range.start, range.end))).toEqual(['@Bob', '@Cy']);
    expect(result.mentionRanges.map((range) => range.userId)).toEqual(['bob', 'cy']);
    // A range before the secret is unchanged; one touching it is dropped.
    const before = redactVerificationCodes('@Bob LW-ABCDEFGH', [{ start: 0, end: 4, userId: 'bob' }, { start: 3, end: 8, userId: 'x' }]);
    expect(before.mentionRanges).toEqual([{ start: 0, end: 4, userId: 'bob' }]);
  });

  it('redacts sensitive strings in normalized content projections', () => {
    expect(redactMessageContent({ format: 1, type: 'location', title: 'LW-ABCDEFGH', address: 'RA-room', latitude: null, longitude: null }))
      .toEqual({ format: 1, type: 'location', title: '[REDACTED_VERIFICATION_CODE]', address: '[REDACTED]', latitude: null, longitude: null });
    expect(redactMessageContent({ format: 1, type: 'unsupported', nativeContentType: 42, fallbackText: 'LW-ABCDEFGH' }))
      .toMatchObject({ fallbackText: '[REDACTED_VERIFICATION_CODE]' });
  });

  it('composes room tokens first and codes second, like the live path', () => {
    const live = redactVerificationCodes(redactRoomTokens('a LW-ABCDEFGH b RA-tok c').text).text;
    expect(redactSensitiveText('a LW-ABCDEFGH b RA-tok c').text).toBe(live);
  });

  it('stores a text body only for text messages', () => {
    for (const kind of ['image', 'video', 'audio', 'file', 'sticker', 'contact']) expect(storedTextForKind(kind, 'caption')).toBeNull();
    expect(storedTextForKind('text', 'hello')).toBe('hello');
    expect(storedTextForKind('text', '')).toBe('');
    expect(storedTextForKind('event', 'joined')).toBe('joined');
  });
});
