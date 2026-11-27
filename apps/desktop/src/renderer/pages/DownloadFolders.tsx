import React from 'react';
import type { LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { projectFoldersTextFor } from '../../desktop-project-folders-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { ChatDownloadLocationPanel, downloadFoldersText } from './ChatDownloadLocation.js';
import { CHAT_TYPE_TEXT, FolderChatSelect, useAgentChatSelection, type ProjectFolderChat } from './ProjectFolders.js';

/** Settings → 資料夾, section 2: the download folders of one chat. It has its own chat selection and shares no state with section 1. */
export function DownloadFolders({ api, accounts, conversations }: { api: DesktopApi; accounts: LineAccountSummary[]; conversations: readonly ProjectFolderChat[] }) {
  const locale = useDesktopLocale();
  const text = downloadFoldersText(locale);
  const { agent, accountId, chats, selected, setSelected, chat } = useAgentChatSelection(accounts, conversations);

  return <>
  <section className="panel download-folders" aria-labelledby="download-folders-heading">
    <div className="panel-top"><div><h2 id="download-folders-heading">{text.heading}</h2><p>{text.meaning}</p></div></div>
    {!agent ? <p role="status">{projectFoldersTextFor(locale, 'noAgentAccount')}</p> : chats.length === 0 ? <p role="status">{projectFoldersTextFor(locale, 'noChats')}</p>
      : <FolderChatSelect id="download-folders-chat" chats={chats} selected={selected} onChange={setSelected} />}
  </section>
  {agent && chat && <section className="panel conversation-help download-folders" aria-labelledby="download-folders-chat-heading">
    <div className="panel-top"><div><h2 id="download-folders-chat-heading">{projectFoldersTextFor(locale, 'chatFoldersTitle', { arg0: `${chat.title}（${projectFoldersTextFor(locale, CHAT_TYPE_TEXT[chat.chatType])}）` })}</h2></div></div>
    <ChatDownloadLocationPanel api={api} route={{ accountId, chatType: chat.chatType, chatId: chat.chatId }} />
  </section>}
  </>;
}
