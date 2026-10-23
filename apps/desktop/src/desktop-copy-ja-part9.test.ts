import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART9 } from './desktop-copy-ja-part9.js';

const expectedKeys = [
  'permissionCurrentChat',
  'permissionCurrentChatDescription',
  'permissionAllChats',
  'permissionAllChatsDescription',
  'permissionFolderRead',
  'permissionFolderReadDescription',
  'permissionFolderWrite',
  'permissionFolderWriteDescription',
  'permissionLocalTools',
  'permissionLocalToolsDescription',
] as const;
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 9', () => {
  it('contains exactly the ten newly added permission keys', () => {
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART9).sort()).toEqual([...expectedKeys].sort());
  });

  it('has meaningful Japanese values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys) {
      const translation = JAPANESE_DESKTOP_COPY_PART9[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });
});
