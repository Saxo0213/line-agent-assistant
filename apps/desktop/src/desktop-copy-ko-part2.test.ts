import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART2 } from './desktop-copy-ko-part2.js';

describe('Korean desktop copy part 2', () => {
  it('contains exactly English source keys 92 through 183', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(92, 184).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART2).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART2)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses accurate Korean labels and messages for representative entries', () => {
    expect(KOREAN_DESKTOP_COPY_PART2.save).toBe('저장');
    expect(KOREAN_DESKTOP_COPY_PART2.revokeAllAgentAccessForArg0NNscopeArg1).toBe('“{arg0}”의 모든 Agent 접근 권한을 취소할까요?\n\n범위: {arg1}');
    expect(KOREAN_DESKTOP_COPY_PART2.maximumArg0MbPerFile).toBe('파일당 최대 {arg0}MB');
    expect(KOREAN_DESKTOP_COPY_PART2.enterAMessageForArg0).toBe('{arg0}에게 보낼 메시지를 입력하세요…');
  });
});
