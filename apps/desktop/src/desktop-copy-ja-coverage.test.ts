import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART1 } from './desktop-copy-ja-part1.js';
import { JAPANESE_DESKTOP_COPY_PART2 } from './desktop-copy-ja-part2.js';
import { JAPANESE_DESKTOP_COPY_PART3 } from './desktop-copy-ja-part3.js';
import { JAPANESE_DESKTOP_COPY_PART4 } from './desktop-copy-ja-part4.js';
import { JAPANESE_DESKTOP_COPY_PART5 } from './desktop-copy-ja-part5.js';
import { JAPANESE_DESKTOP_COPY_PART6 } from './desktop-copy-ja-part6.js';
import { JAPANESE_DESKTOP_COPY_PART7 } from './desktop-copy-ja-part7.js';
import { JAPANESE_DESKTOP_COPY_PART8 } from './desktop-copy-ja-part8.js';
import { JAPANESE_DESKTOP_COPY_PART9 } from './desktop-copy-ja-part9.js';

const parts = [
  JAPANESE_DESKTOP_COPY_PART1,
  JAPANESE_DESKTOP_COPY_PART2,
  JAPANESE_DESKTOP_COPY_PART3,
  JAPANESE_DESKTOP_COPY_PART4,
  JAPANESE_DESKTOP_COPY_PART5,
  JAPANESE_DESKTOP_COPY_PART6,
  JAPANESE_DESKTOP_COPY_PART7,
  JAPANESE_DESKTOP_COPY_PART8,
  JAPANESE_DESKTOP_COPY_PART9,
];

describe('Japanese desktop copy coverage', () => {
  it('covers all 766 English keys exactly once across parts 1–9', () => {
    const coveredKeys = parts.flatMap((part) => Object.keys(part));
    const englishKeys = Object.keys(ENGLISH_DESKTOP_COPY);

    expect(englishKeys).toHaveLength(766);
    expect(coveredKeys).toHaveLength(766);
    expect(new Set(coveredKeys).size).toBe(766);
    expect(coveredKeys.sort()).toEqual(englishKeys.sort());
  });
});
