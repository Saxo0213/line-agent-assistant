import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART2 } from './desktop-copy-ja-part2.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART2) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 2', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART2[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese phrasing for representative permission and status messages', () => {
    expect(JAPANESE_DESKTOP_COPY_PART2.clearAllPermanentlyAllowedTools).toBe('常に許可したツールをすべて削除しますか？');
    expect(JAPANESE_DESKTOP_COPY_PART2.revokeAllAgentAccessForArg0NNscopeArg1).toContain('「{arg0}」');
    expect(JAPANESE_DESKTOP_COPY_PART2.arg0CliRequiresLoginGoToSettingsAgentLog).toContain('設定 → Agent');
    expect(JAPANESE_DESKTOP_COPY_PART2.connectionError).toBe('接続エラー');
  });
});
