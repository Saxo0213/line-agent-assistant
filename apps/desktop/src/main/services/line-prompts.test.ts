import { describe, expect, it } from 'vitest';
import { LINE_PROMPT_CATALOG, linePrompt } from './line-prompts.js';

describe('LINE prompt translations', () => {
  it('has the same typed prompt keys in every supported locale', () => {
    const englishKeys = Object.keys(LINE_PROMPT_CATALOG.en).sort();
    for (const locale of ['zh-TW', 'ja', 'ko'] as const) {
      expect(Object.keys(LINE_PROMPT_CATALOG[locale]).sort()).toEqual(englishKeys);
    }
  });

  it('keeps machine tokens intact in localized direct and group enrollment messages', () => {
    const code = 'LW-ABCDEFG2';
    const welcome: Record<'en' | 'zh-TW' | 'ja' | 'ko', string> = {
      en: 'Welcome as the primary administrator.', 'zh-TW': '歡迎你成為本系統管理員',
      ja: '本システムの管理者として登録されました。', ko: '이 시스템의 기본 관리자로 등록되었습니다.',
    };
    for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
      expect(linePrompt(locale, 'enrollmentDirectChallenge', { code })).toContain(code);
      expect(linePrompt(locale, 'enrollmentGroupChallenge', { code })).toContain(code);
      expect(linePrompt(locale, 'adminWelcome')).toBe(welcome[locale]);
    }
  });

  it('uses English for unsupported runtime locale values', () => {
    expect(linePrompt('fr-FR', 'adminWelcome')).toBe(linePrompt('en', 'adminWelcome'));
  });
});
