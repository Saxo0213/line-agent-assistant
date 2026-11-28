import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART6 } from './desktop-copy-ja-part6.js';

const expectedKeys = Object.keys(JAPANESE_DESKTOP_COPY_PART6) as (keyof typeof ENGLISH_DESKTOP_COPY)[];
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 6', () => {
  it('has only keys that English defines', () => {
    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) expect(key in ENGLISH_DESKTOP_COPY, key).toBe(true);
  });

  it('has nonblank values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys as (keyof typeof ENGLISH_DESKTOP_COPY)[]) {
      const translation = JAPANESE_DESKTOP_COPY_PART6[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });

  it('uses natural Japanese for search, attachment, and MCP settings copy', () => {
    expect(JAPANESE_DESKTOP_COPY_PART6.searchByAccountTypeDateAndMessageContent).toBe('アカウント、種類、日付、メッセージ内容で検索します。');
    expect(JAPANESE_DESKTOP_COPY_PART6.moveExistingAttachmentsToThisFolderNNArg0).toContain('移動が完了すると、アプリが再起動します。');
    expect(JAPANESE_DESKTOP_COPY_PART6.codexSettingsContainAnUnmanagedLinejsMcpEntryCheck).toContain('LINEJS MCP');
    expect(JAPANESE_DESKTOP_COPY_PART6.unableToSaveAgentSettingsCheckAndRetry).toContain('もう一度お試しください');
  });
});
