import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART4 } from './desktop-copy-ja-part4.js';

const permissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
const expectedKeys = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !permissionKeys.includes(key)).slice(276, 368);
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 4', () => {
  it('contains exactly English keys at indices 276–367', () => {
    expect(expectedKeys).toHaveLength(92);
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART4).sort()).toEqual([...expectedKeys].sort());
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART4[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for representative status, search, and LINE copy', () => {
    expect(JAPANESE_DESKTOP_COPY_PART4.messagesAppearHereAfterAnAccountLogsIn).toBe('アカウントにログインすると、ここにメッセージが表示されます。');
    expect(JAPANESE_DESKTOP_COPY_PART4.codexAndClaudeAreNotConfiguredLineSyncSearch).toContain('LINE の同期、検索、手動返信には影響しません');
    expect(JAPANESE_DESKTOP_COPY_PART4.theCurrentLineAccountIsNotThePrimaryAdministrator).toContain('外部監視を開始する前に');
    expect(JAPANESE_DESKTOP_COPY_PART4.lineLoginSuccessful).toBe('LINE にログインしました');
  });
});
