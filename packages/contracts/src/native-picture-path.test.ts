import { describe, expect, it } from 'vitest';
import { normalizeNativePicturePath } from './native-source.js';

describe('normalizeNativePicturePath', () => {
  it('normalizes paths, OBS hashes, and keeps allowed HTTPS URLs', () => {
    expect(normalizeNativePicturePath('/avatar_123')).toBe('https://profile.line-scdn.net/avatar_123');
    expect(normalizeNativePicturePath('/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe('https://profile.line-scdn.net/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(normalizeNativePicturePath('abcdefghijklmnop')).toBe('https://obs.line-scdn.net/abcdefghijklmnop');
    expect(normalizeNativePicturePath('https://obs.line-apps.com/avatar')).toBe('https://obs.line-apps.com/avatar');
  });

  it('preserves an allowed absolute URL containing dot segments verbatim', () => {
    const path = 'https://obs.line-apps.com/a/../b';
    expect(normalizeNativePicturePath(path)).toBe(path);
  });

  it('accepts a relative path whose path length is exactly 2048 characters', () => {
    const path = `/${'a'.repeat(2047)}`;
    expect(normalizeNativePicturePath(path)).toBe(`https://profile.line-scdn.net${path}`);
  });

  it('rejects unsafe and oversized values', () => {
    for (const value of ['https://attacker.example/a', 'http://profile.line-scdn.net/a',
      'https://user@profile.line-scdn.net/a', 'https://profile.line-scdn.net/a#fragment',
      'x'.repeat(2049), '/a?b', '/a#b', '/a//b', '/a/', '/.', '/..', '/a/../b', '/a/./b', '']) expect(normalizeNativePicturePath(value)).toBeNull();
  });
});
