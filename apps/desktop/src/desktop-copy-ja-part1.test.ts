import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART1 } from './desktop-copy-ja-part1.js';

const permissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
const expectedKeys = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !permissionKeys.includes(key)).slice(0, 92);
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 1', () => {
  it('contains exactly the first 92 English keys', () => {
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART1).sort()).toEqual([...expectedKeys].sort());
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART1[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('includes accurate representative Japanese labels and messages', () => {
    expect(JAPANESE_DESKTOP_COPY_PART1.agentQueued).toBe('Agent はキューに追加されました');
    expect(JAPANESE_DESKTOP_COPY_PART1.chats).toBe('チャット');
    expect(JAPANESE_DESKTOP_COPY_PART1.agentRequestsToolArg0).toContain('{arg0}');
    expect(JAPANESE_DESKTOP_COPY_PART1.enterAWholeNumberFrom10To900).toBe('10～900 の整数を入力してください');
  });
});
