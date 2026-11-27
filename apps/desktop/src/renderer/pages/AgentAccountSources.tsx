import React, { useEffect, useState } from 'react';
import type { AgentAccountSource, AgentAccountSourceUsage, ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopText, useSafeErrorText } from '../desktop-i18n.js';

type Provider = AgentAccountSource['provider'];

/** Settings list of the CLI account sources of one provider. It shows no email, path or id. */
export function AgentAccountSources({ api, provider, sources, onStatus }: {
  api: DesktopApi;
  provider: Provider;
  sources: AgentAccountSource[];
  onStatus?: (message: string) => void;
}) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const [live, setLive] = useState<AgentAccountSource[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [added, setAdded] = useState(false);
  const [usage, setUsage] = useState<Record<string, AgentAccountSourceUsage>>({});
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // A snapshot update replaces the local copy from the last action.
  useEffect(() => { setLive(null); }, [sources]);

  const statusLabel: Record<ProviderStatus['status'], string> = {
    unknown: desktopText('checkedAtRuntime'), logged_in: desktopText('loggedIn'), logged_out: desktopText('notLoggedIn'),
    not_installed: desktopText('notInstalled'), error: desktopText('unavailable'),
  };
  const all = live ?? sources;
  const rows = all.filter((item) => item.provider === provider)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  type Result = { ok: boolean; sources?: AgentAccountSource[]; usage?: AgentAccountSourceUsage };
  async function run(id: string, action: () => Promise<unknown>, onOk?: (result: Result) => void): Promise<boolean> {
    if (busyId !== null) return false;
    setBusyId(id); setError('');
    try {
      const result = await action() as Result;
      if (result.ok) {
        if (result.sources) setLive(result.sources);
        onOk?.(result);
        return true;
      }
      const text = safeErrorText(result, desktopText('acctSrcActionFailed'));
      setError(text); onStatus?.(text);
      return false;
    } catch {
      const text = desktopText('acctSrcActionFailed');
      setError(text); onStatus?.(text);
      return false;
    } finally { setBusyId(null); }
  }

  async function add() {
    const label = newLabel.trim();
    if (!label || label.length > 80) return;
    setAdded(false);
    if (await run('', () => api.agentSourceAdd(provider, label))) { setNewLabel(''); setAdded(true); }
  }
  async function login(id: string) {
    setLoginId(id);
    try { await run(id, () => api.agentSourceLogin(id)); } finally { setLoginId(null); }
  }
  async function remove(item: AgentAccountSource) {
    if (!window.confirm(desktopText('acctSrcDeleteConfirm', { arg0: item.label }))) return;
    await run(item.id, () => api.agentSourceRemove(item.id), () => setUsage(({ [item.id]: _gone, ...rest }) => rest));
  }
  async function saveRename(id: string) {
    const label = renameText.trim();
    if (!label || label.length > 80) return;
    if (await run(id, () => api.agentSourceRename(id, label))) setRenameId(null);
  }
  function formatReset(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  return <div className="account-sources">
    {rows.map((item, index) => {
      const busy = busyId !== null;
      const canMove = item.order !== null;
      const shown = usage[item.id];
      return <div className="account-source" key={item.id} data-source-row>
        <div className="account-source-head">
          {renameId === item.id
            ? <span className="account-source-rename">
              <input aria-label={desktopText('acctSrcLabelInput')} value={renameText} maxLength={80} onChange={(event) => setRenameText(event.target.value)} />
              <button type="button" disabled={busy || !renameText.trim()} onClick={() => void saveRename(item.id)}>{desktopText('acctSrcRenameSave')}</button>
              <button type="button" onClick={() => setRenameId(null)}>{desktopText('acctSrcRenameCancel')}</button>
            </span>
            : <strong className="account-source-label">{item.label}</strong>}
          {item.kind === 'system' && <span className="badge">{desktopText('acctSrcSystem')}</span>}
          {item.isDefault && item.status !== 'not_installed' && <span className="badge">{desktopText('acctSrcDefault')}</span>}
          <span className="badge">{statusLabel[item.status]}</span>
          {item.inUse && item.status !== 'not_installed' && <span className="badge">{desktopText('acctSrcInUse')}</span>}
        </div>
        <div className="button-row account-source-actions">
          <label className="account-source-fallback"><input type="checkbox" checked={item.fallbackEnabled} disabled={busy} onChange={(event) => void run(item.id, () => api.agentSourceSetFallback(item.id, event.target.checked))} /> {desktopText('acctSrcFallback')}</label>
          {!item.isDefault && <button type="button" disabled={busy} onClick={() => void run(item.id, () => api.agentSourceSetDefault(provider, item.id))}>{desktopText('acctSrcSetDefault')}</button>}
          <button type="button" disabled={busy || !canMove || index === 0} onClick={() => void run(item.id, () => api.agentSourceMove(item.id, 'up'))}>{desktopText('acctSrcMoveUp')}</button>
          <button type="button" disabled={busy || !canMove || index === rows.length - 1} onClick={() => void run(item.id, () => api.agentSourceMove(item.id, 'down'))}>{desktopText('acctSrcMoveDown')}</button>
          <button type="button" disabled={busy} onClick={() => void login(item.id)}>{loginId === item.id ? desktopText('acctSrcLoggingIn') : desktopText('acctSrcLogin')}</button>
          {item.status === 'logged_in' && <button type="button" disabled={busy} onClick={() => void run(item.id, () => api.agentSourceLogout(item.id))}>{desktopText('acctSrcLogout')}</button>}
          <button type="button" disabled={busy} onClick={() => void run(item.id, () => api.agentSourceRefresh(item.id))}>{desktopText('acctSrcRecheck')}</button>
          <button type="button" disabled={busy} onClick={() => void run(item.id, () => api.agentSourceUsage(item.id, true), (result) => { if (result.usage) setUsage((current) => ({ ...current, [item.id]: result.usage! })); })}>{desktopText('acctSrcUsage')}</button>
          {item.kind === 'managed' && <>
            <button type="button" disabled={busy} onClick={() => { setRenameId(item.id); setRenameText(item.label); }}>{desktopText('acctSrcRename')}</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove(item)}>{desktopText('acctSrcDelete')}</button>
          </>}
        </div>
        {shown && <ul className="account-source-usage">
          {shown.error && <li>{shown.error}</li>}
          {!shown.error && shown.windows.length === 0 && <li>{desktopText('acctSrcNoUsage')}</li>}
          {shown.windows.map((window_, windowIndex) => <li key={windowIndex}>
            {window_.label} · {desktopText('acctSrcUsedPercent', { arg0: String(Math.round(window_.usedPercent)) })}
            {window_.resetsAt ? ` · ${desktopText('acctSrcResetsAt', { arg0: formatReset(window_.resetsAt) })}` : ''}
          </li>)}
        </ul>}
      </div>;
    })}
    <div className="account-source-add">
      <input aria-label={desktopText('acctSrcLabelInput')} placeholder={desktopText('acctSrcLabelInput')} value={newLabel} maxLength={80}
        onChange={(event) => { setNewLabel(event.target.value); setAdded(false); }}
        onKeyDown={(event) => { if (event.key === 'Enter') void add(); }} />
      <button type="button" disabled={busyId !== null || !newLabel.trim()} onClick={() => void add()}>{desktopText('acctSrcAdd')}</button>
    </div>
    {added && <p className="muted" role="status">{desktopText('acctSrcAddHint')}</p>}
    {error && <p className="schedule-error" role="alert">{error}</p>}
  </div>;
}

/** The one switch of automatic source failover. It is on by default. */
export function AgentAutoFailoverSwitch({ api, enabled, onStatus }: {
  api: DesktopApi;
  enabled: boolean;
  onStatus?: (message: string) => void;
}) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const [value, setValue] = useState(enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(enabled); }, [enabled]);
  async function change(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.agentSourceSetAutoFailover(next);
      if (result.ok) setValue(next);
      else onStatus?.(safeErrorText(result, desktopText('acctSrcActionFailed')));
    } catch {
      onStatus?.(desktopText('acctSrcActionFailed'));
    } finally { setBusy(false); }
  }
  return <div className="agent-setting-section account-source-failover">
    <label><input type="checkbox" role="switch" checked={value} disabled={busy} onChange={(event) => void change(event.target.checked)} /> {desktopText('acctSrcAutoFailover')}</label>
    <p className="muted">{desktopText('acctSrcAutoFailoverHelp')}</p>
  </div>;
}
