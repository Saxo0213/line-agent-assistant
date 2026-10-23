import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { KOREAN_DESKTOP_COPY_PART3 } from './desktop-copy-ko-part3.js';

describe('Korean desktop copy part 3', () => {
  it('contains exactly English source keys 184 through 275', () => {
    const newPermissionKeys = ['permissionCurrentChat', 'permissionCurrentChatDescription', 'permissionAllChats', 'permissionAllChatsDescription', 'permissionFolderRead', 'permissionFolderReadDescription', 'permissionFolderWrite', 'permissionFolderWriteDescription', 'permissionLocalTools', 'permissionLocalToolsDescription'];
    const expected = Object.keys(ENGLISH_DESKTOP_COPY).filter((key) => !newPermissionKeys.includes(key)).slice(184, 276).sort();
    expect(Object.keys(KOREAN_DESKTOP_COPY_PART3).sort()).toEqual(expected);
  });

  it('has nonblank translations with matching interpolation placeholders', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map(([match]) => match).sort();
    for (const [key, value] of Object.entries(KOREAN_DESKTOP_COPY_PART3)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(ENGLISH_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]));
    }
  });

  it('uses natural Korean for representative labels and messages', () => {
    expect(KOREAN_DESKTOP_COPY_PART3.systemNotReady).toBe('시스템이 준비되지 않았습니다');
    expect(KOREAN_DESKTOP_COPY_PART3.unableToOpenAttachmentCheckThatTheFileExists).toBe('첨부 파일을 열 수 없습니다. 파일이 있는지, 기본 Windows 앱이 설정되어 있는지 확인하세요.');
    expect(KOREAN_DESKTOP_COPY_PART3.lineDeliveryIsUncertainCheckTheConversationFirst).toBe('LINE 메시지 전송 여부가 확실하지 않습니다. 먼저 대화에서 확인하세요.');
    expect(KOREAN_DESKTOP_COPY_PART3.enterAMessageToSendToLine).toBe('LINE으로 보낼 메시지를 입력하세요…');
  });
});
