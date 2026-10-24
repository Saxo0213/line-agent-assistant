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
      const direct = linePrompt(locale, 'enrollmentDirectChallenge', { code });
      expect(direct).toContain(code);
      const relayWording: Record<typeof locale, RegExp> = {
        en: /relay.*selected contact.*They must send it from their own 1:1 chat with the Agent/i,
        'zh-TW': /轉交給選定的聯絡人.*對方須.*自己的 LINE 一對一聊天室傳給 Agent/s,
        ja: /選択した連絡先に転送.*相手が.*自分のAgentとの1対1トーク/s,
        ko: /선택한 연락처에 전달.*상대방이.*자신의 Agent 1:1 대화/s,
      };
      expect(direct).toMatch(relayWording[locale]);
      expect(linePrompt(locale, 'enrollmentGroupChallenge', { code })).toContain(code);
      expect(linePrompt(locale, 'adminWelcome')).toBe(welcome[locale]);
    }
  });

  it('uses English for unsupported runtime locale values', () => {
    expect(linePrompt('fr-FR', 'adminWelcome')).toBe(linePrompt('en', 'adminWelcome'));
  });
});
