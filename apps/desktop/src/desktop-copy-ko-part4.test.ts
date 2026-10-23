import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART4 } from './desktop-copy-ko-part4.js';

describe('Korean desktop copy part 4', () => {
  it('contains exactly English source keys 276 through 367', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(276, 368).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART4).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART4)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for representative labels and messages', () => {
    expect(KOREAN_DESKTOP_COPY_PART4.selectAChat).toBe('채팅을 선택하세요');
    expect(KOREAN_DESKTOP_COPY_PART4.databaseDisconnectedLineSendingIsPausedToPreserveComplete).toBe('데이터베이스 연결이 끊겼습니다. 기록을 온전히 보존하기 위해 LINE 전송을 일시 중지했습니다.');
    expect(KOREAN_DESKTOP_COPY_PART4.loggingInToLine).toBe('LINE 로그인 중');
    expect(KOREAN_DESKTOP_COPY_PART4.unableToReadTheCurrentLineAccountOpenLine).toBe('현재 LINE 계정을 확인할 수 없습니다. LINE을 열고 로그인하세요.');
  });
});
