import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART5 } from './desktop-copy-ko-part5.js';

describe('Korean desktop copy part 5', () => {
  it('contains exactly English source keys 368 through 459', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(368, 460).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART5).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART5)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for representative login, status, and search messages', () => {
    expect(KOREAN_DESKTOP_COPY_PART5.loginError).toBe('로그인 오류');
    expect(KOREAN_DESKTOP_COPY_PART5.stopExternalMonitoringForArg0ImportedDataAndSync).toBe('“{arg0}”의 외부 모니터링을 중지하시겠습니까? 가져온 데이터와 동기화 진행 상황은 유지됩니다.');
    expect(KOREAN_DESKTOP_COPY_PART5.primaryAdministratorVerificationMonitoringStartedEnterTheCodeIn).toContain('3분 이내에');
    expect(KOREAN_DESKTOP_COPY_PART5.importingIntoDatabaseArg0Arg1Messages).toBe('데이터베이스로 가져오는 중… {arg0}{arg1}개 메시지');
  });
});
