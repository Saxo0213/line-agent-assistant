import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcResult, ProjectFolderEntry, ProjectFolderMode } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { projectFoldersTextFor, type ProjectFoldersCopyKey } from '../../desktop-project-folders-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';

export type OwnedChatType = 'direct' | 'group' | 'room';
export type ProjectFolderRoute = { accountId: string; chatType: OwnedChatType; chatId: string };
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

/** The access (project) folders of one chat: list, add, change mode, remove. Used by Settings → 資料夾 and by the chat header dialog. */
export function ProjectFoldersPanel({ api, route }: { api: DesktopApi; route: ProjectFolderRoute }) {
  const locale = useDesktopLocale();
  const text = useCallback((key: ProjectFoldersCopyKey, values?: Record<string, unknown>) => projectFoldersTextFor(locale, key, values), [locale]);
  const { accountId, chatType, chatId } = route;
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

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true); setLoadFailed(false);
    try {
      const result = await api.listProjectFolders({ accountId, chatType, chatId });
      if (seq !== requestSeq.current) return;
      if (result.type !== 'listProjectFolders') { setFolders(null); setLoadFailed(true); setMessage({ kind: 'error', text: errorText(result) }); return; }
      setFolders(result.folders);
    } catch {
      if (seq === requestSeq.current) { setFolders(null); setLoadFailed(true); }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [accountId, api, chatId, chatType, errorText]);

  // Load when the panel mounts and when the chat changes. A title change does not reload.
  useEffect(() => {
    setPending(null); setMessage(null); setFolders(null); setLoadFailed(false);
    void load();
    return () => { requestSeq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, chatType, chatId]);

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
    const result = await api.bindProjectFolder({ accountId, chatType, chatId, path, mode });
    if (result.type !== 'bindProjectFolder') { setMessage({ kind: 'error', text: errorText(result) }); return; }
    if (fromPending) setPending(null);
    setMessage({ kind: 'notice', text: text(result.status === 'created' ? 'added' : result.status === 'updated' ? 'modeChanged' : 'unchanged') });
    await load();
  });

  const remove = (path: string) => run(async () => {
    if (!window.confirm(text('removeConfirm', { arg0: path }))) return;
    const result = await api.unbindProjectFolder({ accountId, chatType, chatId, path });
    if (result.type !== 'unbindProjectFolder') { setMessage({ kind: 'error', text: errorText(result) }); return; }
    setMessage({ kind: 'notice', text: text(result.removed ? 'removed' : 'alreadyRemoved') });
    await load();
  });

  const modeText = (mode: ProjectFolderMode) => text(mode === 'READ_WRITE' ? 'modeReadWrite' : 'modeRead');
  const modeSelect = (label: string, value: ProjectFolderMode, onChange: (mode: ProjectFolderMode) => void) =>
    <select aria-label={label} value={value} disabled={busy} onChange={(event) => onChange(event.target.value as ProjectFolderMode)}>
      <option value="READ">{modeText('READ')}</option>
      <option value="READ_WRITE">{modeText('READ_WRITE')}</option>
    </select>;

  return <div className="project-folders">
    <div className="perm-message-slot">{message && <div className={message.kind === 'error' ? 'error-banner' : 'inline-notice'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}</div>
    {loading && folders === null && <p className="project-folders-note" role="status">{text('loading')}</p>}
    {loadFailed && <p className="project-folders-note" role="alert">{text('loadFailed')} <button type="button" onClick={() => void load()}>{text('retry')}</button></p>}
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
  </div>;
}
