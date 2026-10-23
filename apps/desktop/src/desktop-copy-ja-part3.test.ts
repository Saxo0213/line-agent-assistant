import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART3 } from './desktop-copy-ja-part3.js';

const permissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription'];
const expectedKeys = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !permissionKeys.includes(key)).slice(184, 276);
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 3', () => {
  it('contains exactly English keys at indices 184–275', () => {
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART3).sort()).toEqual([...expectedKeys].sort());
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART3[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for representative chat and status copy', () => {
    expect(JAPANESE_DESKTOP_COPY_PART3.smtwtfs).toBe('日月火水木金土');
    expect(JAPANESE_DESKTOP_COPY_PART3.unableToLoadMessagesExistingChatsRemainAvailable).toBe('メッセージを読み込めません。既存のチャットは引き続き利用できます。');
    expect(JAPANESE_DESKTOP_COPY_PART3.noMessagesYetAfterLineLoginNewMessagesAre).toContain('LINE にログイン');
    expect(JAPANESE_DESKTOP_COPY_PART3.coreFeaturesNeedAttention).toBe('主要機能の確認が必要です');
  });
});
