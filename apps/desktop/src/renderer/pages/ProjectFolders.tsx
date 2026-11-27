import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationKey, LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { projectFoldersTextFor, type ProjectFoldersCopyKey } from '../../desktop-project-folders-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { ProjectFoldersPanel, type OwnedChatType } from './ProjectFoldersPanel.js';

export type ProjectFolderChat = ConversationKey & { title?: string | undefined; localOnly?: boolean | undefined };

export const CHAT_TYPE_TEXT = { direct: 'chatTypeDirect', group: 'chatTypeGroup', room: 'chatTypeRoom' } as const satisfies Record<OwnedChatType, ProjectFoldersCopyKey>;
export const isOwnedChatType = (value: string): value is OwnedChatType => value in CHAT_TYPE_TEXT;
export const optionValue = (chat: { chatType: string; chatId: string }): string => JSON.stringify([chat.chatType, chat.chatId]);

/** The chats of the Agent account that a Settings folder section can manage, and the section's own chat selection. */
export function useAgentChatSelection(accounts: LineAccountSummary[], conversations: readonly ProjectFolderChat[]) {
  const agent = accounts.find((account) => account.productRole === 'AGENT');
  const accountId = agent?.accountId ?? '';
  const chats = useMemo(() => conversations
    .filter((chat) => chat.accountId === accountId && isOwnedChatType(chat.chatType) && chat.localOnly !== true)
    .map((chat) => ({ chatType: chat.chatType as OwnedChatType, chatId: chat.chatId, title: chat.title?.trim() || chat.chatId }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.chatId.localeCompare(right.chatId)), [accountId, conversations]);
  const [selected, setSelected] = useState('');
  const chat = chats.find((item) => optionValue(item) === selected);
  // A chat that is no longer listed (or another Agent account) clears the selection.
  useEffect(() => { if (selected && !chat) setSelected(''); }, [chat, selected]);
  return { agent, accountId, chats, selected, setSelected, chat };
}

/** The chat selector of one Settings folder section. */
export function FolderChatSelect({ id, chats, selected, onChange }: { id: string; chats: readonly { chatType: OwnedChatType; chatId: string; title: string }[]; selected: string; onChange(value: string): void }) {
  const locale = useDesktopLocale();
  const text = useCallback((key: ProjectFoldersCopyKey) => projectFoldersTextFor(locale, key), [locale]);
  return <div className="project-folders-chat"><label htmlFor={id}>{text('chatLabel')}</label>
    <select id={id} value={selected} onChange={(event) => onChange(event.target.value)}>
      <option value="">{text('chatPlaceholder')}</option>
      {chats.map((item) => <option key={optionValue(item)} value={optionValue(item)}>{`${item.title}（${text(CHAT_TYPE_TEXT[item.chatType])}）`}</option>)}
    </select>
  </div>;
}

/** Settings → 資料夾, section 1: the Agent access (project) folders of one chat of the Agent account. */
export function ProjectFolders({ api, accounts, conversations }: { api: DesktopApi; accounts: LineAccountSummary[]; conversations: readonly ProjectFolderChat[] }) {
  const locale = useDesktopLocale();
  const text = useCallback((key: ProjectFoldersCopyKey, values?: Record<string, unknown>) => projectFoldersTextFor(locale, key, values), [locale]);
  const { agent, accountId, chats, selected, setSelected, chat } = useAgentChatSelection(accounts, conversations);

  return <>
  <section className="panel project-folders" aria-labelledby="project-folders-heading">
    <div className="panel-top"><div><h2 id="project-folders-heading">{text('heading')}</h2><p>{text('note')}</p></div></div>
    {!agent ? <p role="status">{text('noAgentAccount')}</p> : chats.length === 0 ? <p role="status">{text('noChats')}</p>
      : <FolderChatSelect id="project-folders-chat" chats={chats} selected={selected} onChange={setSelected} />}
  </section>
  {agent && chat && <section className="panel conversation-help project-folders" aria-labelledby="project-folders-chat-heading">
      <div className="panel-top"><div><h2 id="project-folders-chat-heading">{text('chatFoldersTitle', { arg0: `${chat.title}（${text(CHAT_TYPE_TEXT[chat.chatType])}）` })}</h2></div></div>
      <ProjectFoldersPanel api={api} route={{ accountId, chatType: chat.chatType, chatId: chat.chatId }} />
  </section>}
  </>;
}
