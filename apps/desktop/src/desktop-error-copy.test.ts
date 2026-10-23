import { describe, expect, it } from 'vitest';
import {
  DESKTOP_ERROR_COPY,
  JAPANESE_DESKTOP_ERROR_COPY,
  KOREAN_DESKTOP_ERROR_COPY,
  desktopErrorText,
} from './desktop-error-copy.js';

describe('desktop error copy', () => {
  it('uses Japanese and Korean descriptions for known error codes', () => {
    expect(desktopErrorText('ja', 'AUTH_REQUIRED')).toBe(JAPANESE_DESKTOP_ERROR_COPY.AUTH_REQUIRED);
    expect(desktopErrorText('ko', 'pg_download_failed')).toBe(KOREAN_DESKTOP_ERROR_COPY.pg_download_failed);
  });

  it('retains Traditional Chinese and English fallback behavior', () => {
    expect(desktopErrorText('zh-TW', 'AUTH_REQUIRED')).toBe(DESKTOP_ERROR_COPY.AUTH_REQUIRED['zh-TW']);
    expect(desktopErrorText('en', 'AUTH_REQUIRED')).toBe(DESKTOP_ERROR_COPY.AUTH_REQUIRED.en);
    expect(desktopErrorText('invalid-locale' as never, 'AUTH_REQUIRED')).toBe(DESKTOP_ERROR_COPY.AUTH_REQUIRED.en);
  });

  it('returns undefined for unknown codes', () => {
    expect(desktopErrorText('ja', 'UNKNOWN_ERROR_CODE')).toBeUndefined();
    expect(desktopErrorText('ko', undefined)).toBeUndefined();
  });

  it('keeps Japanese and Korean translations in exact parity with all 44 error codes', () => {
    const codes = Object.keys(DESKTOP_ERROR_COPY).sort();
    expect(codes).toHaveLength(44);
    expect(Object.keys(JAPANESE_DESKTOP_ERROR_COPY).sort()).toEqual(codes);
    expect(Object.keys(KOREAN_DESKTOP_ERROR_COPY).sort()).toEqual(codes);
  });
});
