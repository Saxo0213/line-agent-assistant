import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';

export const JAPANESE_DESKTOP_COPY_PART9: Partial<Record<keyof typeof ENGLISH_DESKTOP_COPY, string>> = {
  permissionCurrentChat: 'このチャットの記録を照会',
  permissionCurrentChatDescription: 'Agent が起動されたチャットのメッセージ記録を照会できるようにします。',
  permissionAllChats: 'すべてのチャットの記録を照会',
  permissionAllChatsDescription: 'Agent がこのアカウントのすべてのチャットのメッセージ記録を照会できるようにします。',
  permissionFolderRead: 'このチャットのフォルダーを読み取る',
  permissionFolderReadDescription: 'Agent がこのチャット（グループまたは個人）のフォルダーにあるメモ、整理済みの記録、ファイルを読み取れるようにします。',
  permissionFolderWrite: 'このチャットのフォルダーに書き込む',
  permissionFolderWriteDescription: 'Agent がこのチャット（グループまたは個人）のフォルダー内にファイルを作成・編集できるようにします。',
  permissionLocalTools: 'ローカルワークスペースを使用（ファイルとコマンド）',
  permissionLocalToolsDescription: 'Agent が CLI に組み込まれたファイル操作・コマンド実行ツールを使い、チャットフォルダーの範囲を超えて操作できるようにします。',
};
