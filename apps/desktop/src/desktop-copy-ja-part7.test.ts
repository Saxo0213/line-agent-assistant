import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART7 } from './desktop-copy-ja-part7.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART7) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 7', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART7[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for automatic replies, MCP authorization, and commands', () => {
    expect(JAPANESE_DESKTOP_COPY_PART7.thisRuleWasDeletedElsewhereYourEditsAreKept).toContain('編集内容は保持されています');
    expect(JAPANESE_DESKTOP_COPY_PART7.agentCodexPrompt).toBe('/agent codex <prompt>');
  });
});
