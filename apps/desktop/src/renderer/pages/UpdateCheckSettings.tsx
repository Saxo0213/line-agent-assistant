import React from 'react';
import type { DesktopApi } from '../../preload/api.js';
import { updateTextFor, type UpdateCopyKey } from '../../desktop-update-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { useUpdateCheck } from '../useUpdateCheck.js';

function two(value: number): string { return String(value).padStart(2, '0'); }
/** `MM/DD HH:mm` in the viewer's local time. */
export function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function UpdateCheckSettings({ api }: { api: DesktopApi }) {
  const locale = useDesktopLocale();
  const text = (key: UpdateCopyKey, values?: Record<string, unknown>) => updateTextFor(locale, key, values);
  const { state, setEnabled, checkNow, openReleasePage, openInstalledDetails, install } = useUpdateCheck(api);
  if (!state) return null;
  const status = state.checking ? text('checking')
    : state.lastCheckFailed ? text('checkFailed')
    : state.lastCheckedAt ? text('lastChecked', { arg0: formatCheckedAt(state.lastCheckedAt) })
    : text('neverChecked');
  return <div className="update-check-settings">
    <div className="update-check-row">
      <span id="update-check-label">{text('autoCheck')}</span>
      <button type="button" role="switch" className="schedule-switch" aria-checked={state.enabled} aria-labelledby="update-check-label" onClick={() => setEnabled(!state.enabled)}><span className="schedule-switch-thumb" aria-hidden="true" /></button>
    </div>
    <div className="update-check-row">
      <span className="muted update-check-status" role="status">{status}</span>
      <button type="button" disabled={state.checking} onClick={checkNow}>{text('checkNow')}</button>
    </div>
    {state.available && state.latestVersion && <div className="update-check-row">
      <strong>{text('latestVersion', { arg0: state.latestVersion })}</strong>
      <span className="button-row">
        <button type="button" className="primary" disabled={state.download.status === 'downloading' || state.download.status === 'ready'} onClick={install}>{text('updateNow')}</button>
        <button type="button" onClick={openReleasePage}>{text('goDownload')}</button>
      </span>
    </div>}
    {state.installedNotice && <div className="update-check-row">
      <strong>{text('installedTitle', { arg0: state.installedNotice.version })}</strong>
      <button type="button" onClick={openInstalledDetails}>{text('details')}</button>
    </div>}
    {state.available && state.download.status === 'downloading' && <span className="muted" role="status">{text('downloading')} {state.download.percent}%</span>}
    {state.available && state.download.status === 'ready' && <span className="muted" role="status">{text('restarting')}</span>}
    {state.available && state.download.status === 'error' && <span className="update-prompt-error" role="status">{text('updateFailed')}</span>}
  </div>;
}
