import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART1 } from './desktop-copy-ko-part1.js';

describe('Korean desktop copy part 1', () => {
  it('contains exactly English source keys 0 through 91', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(0, 92).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART1).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART1)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses accurate Korean labels and messages for representative entries', () => {
    expect(KOREAN_DESKTOP_COPY_PART1.chats).toBe('채팅');
    expect(KOREAN_DESKTOP_COPY_PART1.allowForThisSession).toBe('이번 세션에서 허용');
    expect(KOREAN_DESKTOP_COPY_PART1.unableToLoadSystemStatusCheckSettingsAndReconnect).toBe('시스템 상태를 불러올 수 없습니다. 설정을 확인하고 다시 연결하세요.');
    expect(KOREAN_DESKTOP_COPY_PART1.agentRequestsToolArg0).toBe('Agent가 도구 사용을 요청함: {arg0}');
  });
});
