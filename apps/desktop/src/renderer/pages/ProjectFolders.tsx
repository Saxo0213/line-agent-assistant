import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationKey, IpcResult, LineAccountSummary, ProjectFolderEntry, ProjectFolderMode } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { projectFoldersTextFor, type ProjectFoldersCopyKey } from '../../desktop-project-folders-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';

export type ProjectFolderChat = ConversationKey & { title?: string | undefined; localOnly?: boolean | undefined };
type Message = { kind: 'notice' | 'error'; text: string };
type Pending = { path: string; mode: ProjectFolderMode };

const ERROR_TEXT: Record<string, ProjectFoldersCopyKey> = {
  PROJECT_FOLDER_NOT_ABSOLUTE: 'errNotAbsolute',
  PROJECT_FOLDER_NOT_FOUND: 'errNotFound',
  PROJECT_FOLDER_FORBIDDEN: 'errForbidden',
  PROJECT_FOLDER_UNSUPPORTED_CHARS: 'errUnsupportedChars',
  PROJECT_FOLDER_ACCOUNT_INVALID: 'errAccount',
  PROJECT_FOLDER_PICKER_UNAVAILABLE: 'errPicker',
};
const CHAT_TYPE_TEXT = { direct: 'chatTypeDirect', group: 'chatTypeGroup', room: 'chatTypeRoom' } as const satisfies Record<string, ProjectFoldersCopyKey>;
type OwnedChatType = keyof typeof CHAT_TYPE_TEXT;
const isOwnedChatType = (value: string): value is OwnedChatType => value in CHAT_TYPE_TEXT;
const optionValue = (chat: { chatType: string; chatId: string }): string => JSON.stringify([chat.chatType, chat.chatId]);

/** Settings → 資料夾: the project folders of one chat of the Agent account. */
export function ProjectFolders({ api, accounts, conversations }: { api: DesktopApi; accounts: LineAccountSummary[]; conversations: readonly ProjectFolderChat[] }) {
  const locale = useDesktopLocale();
  const text = useCallback((key: ProjectFoldersCopyKey, values?: Record<string, unknown>) => projectFoldersTextFor(locale, key, values), [locale]);
  const agent = accounts.find((account) => account.productRole === 'AGENT');
  const accountId = agent?.accountId ?? '';
  const chats = useMemo(() => conversations
    .filter((chat) => chat.accountId === accountId && isOwnedChatType(chat.chatType) && chat.localOnly !== true)
    .map((chat) => ({ chatType: chat.chatType as OwnedChatType, chatId: chat.chatId, title: chat.title?.trim() || chat.chatId }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.chatId.localeCompare(right.chatId)), [accountId, conversations]);
  const [selected, setSelected] = useState('');
  const chat = chats.find((item) => optionValue(item) === selected);
  const [folders, setFolders] = useState<ProjectFolderEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const requestSeq = useRef(0);

  const errorText = useCallback((result: IpcResult | null): string => {
    const key = result?.type === 'error' ? ERROR_TEXT[result.code] : undefined;
    return text(key ?? 'errGeneric');
  }, [text]);

  const load = useCallback(async (target: { chatType: OwnedChatType; chatId: string }) => {
    const seq = ++requestSeq.current;
    setLoading(true); setLoadFailed(false);
    try {
      const result = await api.listProjectFolders({ accountId, chatType: target.chatType, chatId: target.chatId });
      if (seq !== requestSeq.current) return;
      if (result.type !== 'listProjectFolders') { setFolders(null); setLoadFailed(true); setMessage({ kind: 'error', text: errorText(result) }); return; }
      setFolders(result.folders);
    } catch {
      if (seq === requestSeq.current) { setFolders(null); setLoadFailed(true); }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [accountId, api, errorText]);

  // A chat that is no longer listed (or another Agent account) clears the selection.
  useEffect(() => { if (selected && !chat) setSelected(''); }, [chat, selected]);
  useEffect(() => {
    setPending(null); setMessage(null); setFolders(null); setLoadFailed(false);
    if (!chat) { requestSeq.current += 1; setLoading(false); return; }
    void load(chat);
    return () => { requestSeq.current += 1; };
    // Reload only when the selected chat changes, not when its title changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.chatType, chat?.chatId, accountId]);

  const target = chat ? { accountId, chatType: chat.chatType, chatId: chat.chatId } : null;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try { await action(); } catch { setMessage({ kind: 'error', text: text('errGeneric') }); } finally { setBusy(false); }
  }

  const pick = () => run(async () => {
    const result = await api.chooseProjectFolder();
    if (result.type === 'chooseProjectFolder') { if (result.path) setPending({ path: result.path, mode: 'READ' }); return; }
    setMessage({ kind: 'error', text: errorText(result) });
  });

  const bind = (path: string, mode: ProjectFolderMode, fromPending: boolean) => run(async () => {
    if (!target || !chat) return;
    const result = await api.bindProjectFolder({ ...target, path, mode });
    if (result.type !== 'bindProjectFolder') { setMessage({ kind: 'error', text: errorText(result) }); return; }
    if (fromPending) setPending(null);
    setMessage({ kind: 'notice', text: text(result.status === 'created' ? 'added' : result.status === 'updated' ? 'modeChanged' : 'unchanged') });
    await load(chat);
  });

  const remove = (path: string) => run(async () => {
    if (!target || !chat) return;
    if (!window.confirm(text('removeConfirm', { arg0: path }))) return;
    const result = await api.unbindProjectFolder({ ...target, path });
    if (result.type !== 'unbindProjectFolder') { setMessage({ kind: 'error', text: errorText(result) }); return; }
    setMessage({ kind: 'notice', text: text(result.removed ? 'removed' : 'alreadyRemoved') });
    await load(chat);
  });

  const modeText = (mode: ProjectFolderMode) => text(mode === 'READ_WRITE' ? 'modeReadWrite' : 'modeRead');
  const modeSelect = (label: string, value: ProjectFolderMode, onChange: (mode: ProjectFolderMode) => void) =>
    <select aria-label={label} value={value} disabled={busy} onChange={(event) => onChange(event.target.value as ProjectFolderMode)}>
      <option value="READ">{modeText('READ')}</option>
      <option value="READ_WRITE">{modeText('READ_WRITE')}</option>
    </select>;

  return <>
  <section className="panel project-folders" aria-labelledby="project-folders-heading">
    <div className="panel-top"><div><h2 id="project-folders-heading">{text('heading')}</h2><p>{text('note')}</p></div></div>
    {!agent ? <p role="status">{text('noAgentAccount')}</p> : chats.length === 0 ? <p role="status">{text('noChats')}</p> : <>
      <div className="project-folders-chat"><label htmlFor="project-folders-chat">{text('chatLabel')}</label>
        <select id="project-folders-chat" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
          <option value="">{text('chatPlaceholder')}</option>
          {chats.map((item) => <option key={optionValue(item)} value={optionValue(item)}>{`${item.title}（${text(CHAT_TYPE_TEXT[item.chatType])}）`}</option>)}
        </select>
      </div>
    </>}
  </section>
  {agent && chat && <section className="panel conversation-help project-folders" aria-labelledby="project-folders-chat-heading">
      <div className="panel-top"><div><h2 id="project-folders-chat-heading">{text('chatFoldersTitle', { arg0: `${chat.title}（${text(CHAT_TYPE_TEXT[chat.chatType])}）` })}</h2></div></div>
      <div className="perm-message-slot">{message && <div className={message.kind === 'error' ? 'error-banner' : 'inline-notice'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}</div>
      <>
        {loading && folders === null && <p className="project-folders-note" role="status">{text('loading')}</p>}
        {loadFailed && <p className="project-folders-note" role="alert">{text('loadFailed')} <button type="button" onClick={() => void load(chat)}>{text('retry')}</button></p>}
        {folders !== null && <>
          <div className="project-folders-toolbar"><p className="project-folders-count" role="status">{text('count', { arg0: folders.length })}</p>
            <button type="button" className="primary" disabled={busy || pending !== null} onClick={() => void pick()}>{busy && pending === null ? text('pickerBusy') : text('add')}</button></div>
          {pending && <div className="project-folders-pending" role="group" aria-label={text('pendingTitle')}>
            <span>{text('pendingTitle')}</span>
            <span className="project-folders-path" title={pending.path}>{pending.path}</span>
            {modeSelect(text('modeFor', { arg0: pending.path }), pending.mode, (mode) => setPending({ ...pending, mode }))}
            <div className="project-folders-pending-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void bind(pending.path, pending.mode, true)}>{text('confirmAdd')}</button>
              <button type="button" disabled={busy} onClick={() => setPending(null)}>{text('cancel')}</button>
            </div>
          </div>}
          {folders.length === 0 ? <p className="project-folders-note" role="status">{text('empty')}</p> : <div className="conversation-help-table-wrap project-folders-table"><table aria-label={text('listLabel')}>
            <thead><tr><th scope="col">{text('colPath')}</th><th scope="col">{text('colMode')}</th><th scope="col">{text('colAction')}</th></tr></thead>
            <tbody>{folders.map((folder) => <tr key={folder.path}>
              <td><code title={folder.path}>{folder.path}</code></td>
              <td>{modeSelect(text('modeFor', { arg0: folder.path }), folder.mode, (mode) => { if (mode !== folder.mode) void bind(folder.path, mode, false); })}</td>
              <td><button type="button" disabled={busy} aria-label={text('removeFor', { arg0: folder.path })} onClick={() => void remove(folder.path)}>{text('remove')}</button></td>
            </tr>)}</tbody>
          </table></div>}
        </>}
      </>
  </section>}
  </>;
}
