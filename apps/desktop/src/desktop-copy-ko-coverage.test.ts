import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART1 } from './desktop-copy-ko-part1.js';
import { KOREAN_DESKTOP_COPY_PART2 } from './desktop-copy-ko-part2.js';
import { KOREAN_DESKTOP_COPY_PART3 } from './desktop-copy-ko-part3.js';
import { KOREAN_DESKTOP_COPY_PART4 } from './desktop-copy-ko-part4.js';
import { KOREAN_DESKTOP_COPY_PART5 } from './desktop-copy-ko-part5.js';
import { KOREAN_DESKTOP_COPY_PART6 } from './desktop-copy-ko-part6.js';
import { KOREAN_DESKTOP_COPY_PART7 } from './desktop-copy-ko-part7.js';
import { KOREAN_DESKTOP_COPY_PART8 } from './desktop-copy-ko-part8.js';
import { KOREAN_DESKTOP_COPY_PART9 } from './desktop-copy-ko-part9.js';

describe('Korean desktop copy coverage', () => {
  it('covers all 766 English keys exactly once across parts 1 through 9', () => {
    const parts = [
      KOREAN_DESKTOP_COPY_PART1,
      KOREAN_DESKTOP_COPY_PART2,
      KOREAN_DESKTOP_COPY_PART3,
      KOREAN_DESKTOP_COPY_PART4,
      KOREAN_DESKTOP_COPY_PART5,
      KOREAN_DESKTOP_COPY_PART6,
      KOREAN_DESKTOP_COPY_PART7,
      KOREAN_DESKTOP_COPY_PART8,
      KOREAN_DESKTOP_COPY_PART9,
    ];
    const keys = parts.flatMap((part) => Object.keys(part));
    expect(Object.keys(ENGLISH_DESKTOP_COPY)).toHaveLength(766);
    expect(keys).toHaveLength(766);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(ENGLISH_DESKTOP_COPY).sort());
  });
});
