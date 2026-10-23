import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';

// Korean translations for the ten Agent permission catalog entries.
export const KOREAN_DESKTOP_COPY_PART9 = {
  permissionCurrentChat: '이 채팅 기록 조회',
  permissionCurrentChatDescription: 'Agent가 실행을 요청한 채팅의 메시지 기록을 조회하도록 허용합니다.',
  permissionAllChats: '모든 채팅 기록 조회',
  permissionAllChatsDescription: 'Agent가 이 계정의 모든 채팅에서 메시지 기록을 조회하도록 허용합니다.',
  permissionFolderRead: '이 채팅 폴더 읽기',
  permissionFolderReadDescription: 'Agent가 이 채팅(그룹 또는 1:1 채팅)의 폴더에 있는 메모, 정리된 기록 및 파일을 읽도록 허용합니다.',
  permissionFolderWrite: '이 채팅 폴더에 쓰기',
  permissionFolderWriteDescription: 'Agent가 이 채팅(그룹 또는 1:1 채팅)의 폴더에 파일을 만들고 수정하도록 허용합니다.',
  permissionLocalTools: '로컬 작업 공간 사용(파일 및 명령)',
  permissionLocalToolsDescription: 'Agent가 채팅 폴더를 벗어나 CLI에 내장된 파일 및 명령 도구를 사용하도록 허용합니다.',
} satisfies Partial<Record<keyof typeof ENGLISH_DESKTOP_COPY, string>>;
