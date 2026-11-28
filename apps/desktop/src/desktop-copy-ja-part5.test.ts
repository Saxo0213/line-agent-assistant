import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART5 } from './desktop-copy-ja-part5.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART5) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 5', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART5[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for representative login, monitoring, and import copy', () => {
    expect(JAPANESE_DESKTOP_COPY_PART5.logInToLineAccount).toBe('LINE アカウントにログイン');
    expect(JAPANESE_DESKTOP_COPY_PART5.logOutOfArg0ChatHistoryAndAttachmentIndexes).toContain('保持されます');
    expect(JAPANESE_DESKTOP_COPY_PART5.primaryAdministratorVerificationMonitoringStartedEnterTheCodeIn).toContain('3 分以内');
    expect(JAPANESE_DESKTOP_COPY_PART5.importingIntoDatabaseArg0Arg1Messages).toContain('{arg0}{arg1} 件のメッセージ');
  });
});
