import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART7 } from './desktop-copy-ko-part7.js';

describe('Korean desktop copy part 7', () => {
  it('has only keys that English defines', () => {
    const keys = Object.keys(KOREAN_DESKTOP_COPY_PART7);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART7)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for automatic replies, token access, and command prompts', () => {
    expect(KOREAN_DESKTOP_COPY_PART7.thisRuleWasDeletedElsewhereYourEditsAreKept).toContain('편집 내용은 유지됩니다');
    expect(KOREAN_DESKTOP_COPY_PART7.agentCodexPrompt).toBe('/agent codex <프롬프트>');
  });
});
