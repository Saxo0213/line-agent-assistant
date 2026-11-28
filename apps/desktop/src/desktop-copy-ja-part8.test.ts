import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART8 } from './desktop-copy-ja-part8.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART8) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 8', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART8[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese and preserves command syntax and product names', () => {
    expect(JAPANESE_DESKTOP_COPY_PART8.useCodexForThisPromptOnlyFollowTheCommand).toContain('コマンドの後にプロンプトを入力します');
    expect(JAPANESE_DESKTOP_COPY_PART8.agentClaudePrompt).toBe('/agent claude <prompt>');
    expect(JAPANESE_DESKTOP_COPY_PART8.lineAgentAssistantIsAnIndependentlyDevelopedThirdParty).toContain('LY Corporation');
    expect(JAPANESE_DESKTOP_COPY_PART8.retriedArg0Times).toBe(' · {arg0} 回再試行');
  });
});
