import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART8 } from './desktop-copy-ko-part8.js';

describe('Korean desktop copy part 8', () => {
  it('has only keys that English defines', () => {
    const keys = Object.keys(KOREAN_DESKTOP_COPY_PART8);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART8)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for commands, account authorization, and system errors', () => {
    expect(KOREAN_DESKTOP_COPY_PART8.agentClaudePrompt).toBe('/agent claude <프롬프트>');
    expect(KOREAN_DESKTOP_COPY_PART8.addUsersToTheAgentAccessAllowlistInDirect).toContain('연락처 카드');
    expect(KOREAN_DESKTOP_COPY_PART8.lineFriendListExceedsProcessingLimit).toContain('처리 한도');
    expect(KOREAN_DESKTOP_COPY_PART8.retriedArg0Times).toBe(' · {arg0}회 재시도함');
  });
});
