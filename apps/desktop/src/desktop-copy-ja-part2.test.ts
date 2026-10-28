import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART2 } from './desktop-copy-ja-part2.js';

const permissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
const expectedKeys = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !permissionKeys.includes(key)).slice(92, 184);
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 2', () => {
  it('contains exactly English keys at indices 92–183', () => {
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART2).sort()).toEqual([...expectedKeys].sort());
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
