import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART6 } from './desktop-copy-ko-part6.js';

describe('Korean desktop copy part 6', () => {
  it('contains exactly English source keys 460 through 551', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(460, 552).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART6).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART6)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for account setup, search, and attachment messages', () => {
    expect(KOREAN_DESKTOP_COPY_PART6.primaryAdministratorConfiguredAndExternalMonitoringStarted).toBe('기본 관리자를 설정하고 외부 모니터링을 시작했습니다.');
    expect(KOREAN_DESKTOP_COPY_PART6.searchByAccountTypeDateAndMessageContent).toBe('계정, 유형, 날짜 및 메시지 내용으로 검색합니다.');
    expect(KOREAN_DESKTOP_COPY_PART6.moveExistingAttachmentsToThisFolderNNArg0).toContain('첨부 파일을 이 폴더로 옮기시겠습니까?');
    expect(KOREAN_DESKTOP_COPY_PART6.unableToUpdateLocalMcpConnectionSettingsCheckApp).toContain('다시 시도하세요.');
  });
});
