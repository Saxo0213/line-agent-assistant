import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART9 } from './desktop-copy-ja-part9.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART9) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 9', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has meaningful Japanese values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys) {
      const translation = JAPANESE_DESKTOP_COPY_PART9[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });
});
