import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART7 } from './desktop-copy-ja-part7.js';

const permissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
const expectedKeys = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !permissionKeys.includes(key)).slice(552, 644);
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 7', () => {
  it('contains exactly English keys at indices 552–643', () => {
    expect(expectedKeys).toHaveLength(92);
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART7).sort()).toEqual([...expectedKeys].sort());
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
    expect(JAPANESE_DESKTOP_COPY_PART7.chooseTheToolsThisTokenCanUseEachOperation).toContain('アカウント範囲にも制限されます');
    expect(JAPANESE_DESKTOP_COPY_PART7.agentCodexPrompt).toBe('/agent codex <prompt>');
    expect(JAPANESE_DESKTOP_COPY_PART7.copyThisOneTimeTokenNowItCannotBe).toContain('閉じる前にコピーしてください');
  });
});
