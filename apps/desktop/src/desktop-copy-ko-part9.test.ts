import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART9 } from './desktop-copy-ko-part9.js';

describe('Korean desktop copy part 9', () => {
  it('contains the rotation interval label, permission keys, and unsend keys', () => {
    const expected = ['agentStatusRotationIntervalSeconds', 'externalMonitorAuthorityChanged', 'externalMonitorCheckpointChanged', 'externalMonitorSourceChanged', 'externalMonitorReaderStartupFailed', 'externalMonitorReaderFailed', 'externalMonitorDatabaseFailed', 'externalMonitorFailureUnknown', 'permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription', 'unsendMessage', 'unsendConfirm', 'unsendTimeWindow', 'unsendOneHour', 'unsendSevenDays', 'unsendWindowSaved', 'unsendFailed', 'historyReadFailed', 'chatResourceReadFailed', 'profileRefreshFailed', 'messageSendFailed', 'messageUnsendFailed', 'messageReactionFailed', 'friendRelationCheckFailed', 'friendAddFailed', 'primaryAdminNotFriend', 'attachmentDownloadOperationFailed', 'credentialRestoreFailed', 'lineSyncFailed', 'mediaWasNotSentTryAgain', 'mediaSendingRequiresDirectOrGroupChat'];
    expect(expected).toHaveLength(39);
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART9).sort()).toEqual(expected.sort());
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART9)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses clear Korean permission labels and descriptions', () => {
    expect(KOREAN_DESKTOP_COPY_PART9.permissionCurrentChat).toBe('이 채팅 기록 조회');
    expect(KOREAN_DESKTOP_COPY_PART9.permissionAllChats).toBe('모든 채팅 기록 조회');
    expect(KOREAN_DESKTOP_COPY_PART9.permissionFolderRead).toBe('이 채팅 폴더 읽기');
    expect(KOREAN_DESKTOP_COPY_PART9.permissionFolderWrite).toBe('이 채팅 폴더에 쓰기');
    expect(KOREAN_DESKTOP_COPY_PART9.permissionLocalTools).toBe('로컬 작업 공간 사용(파일 및 명령)');
  });
});
