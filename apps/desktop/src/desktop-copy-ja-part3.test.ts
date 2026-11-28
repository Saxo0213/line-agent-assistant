import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART3 } from './desktop-copy-ja-part3.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART3) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 3', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART3[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for representative chat and status copy', () => {
    expect(JAPANESE_DESKTOP_COPY_PART3.smtwtfs).toBe('日月火水木金土');
    expect(JAPANESE_DESKTOP_COPY_PART3.unableToLoadMessagesExistingChatsRemainAvailable).toBe('メッセージを読み込めません。既存のチャットは引き続き利用できます。');
    expect(JAPANESE_DESKTOP_COPY_PART3.noMessagesYetAfterLineLoginNewMessagesAre).toContain('LINE にログイン');
    expect(JAPANESE_DESKTOP_COPY_PART3.coreFeaturesNeedAttention).toBe('主要機能の確認が必要です');
  });
});
