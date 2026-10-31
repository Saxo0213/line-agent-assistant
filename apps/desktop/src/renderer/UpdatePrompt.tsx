import React from 'react';
import type { DesktopApi } from '../preload/api.js';
import { updateTextFor, type UpdateCopyKey } from '../desktop-update-copy.js';
import { useDesktopLocale } from './desktop-i18n.js';
import { useUpdateCheck } from './useUpdateCheck.js';

/** Floating non-modal card at the bottom-left; new updates can be ignored while install notices remain until details open. */
export function UpdatePrompt({ api }: { api: DesktopApi }) {
  const locale = useDesktopLocale();
  const text = (key: UpdateCopyKey, values?: Record<string, unknown>) => updateTextFor(locale, key, values);
  const { state, ignore, install, openReleasePage, openInstalledDetails } = useUpdateCheck(api);
  if (!state) return null;
  const hasActionableUpdate = state.available && !!state.latestVersion && state.ignoredVersion !== state.latestVersion;
  if (!hasActionableUpdate && state.installedNotice) return <div className="update-prompt" role="status" aria-live="polite">
    <strong className="update-prompt-title">{text('installedTitle', { arg0: state.installedNotice.version })}</strong>
    <div className="update-prompt-actions"><button type="button" className="primary" onClick={openInstalledDetails}>{text('details')}</button></div>
  </div>;
  if (!hasActionableUpdate || !state.latestVersion) return null;
  const version = state.latestVersion;
  const { status, percent } = state.download;
  return <div className="update-prompt" role="status" aria-live="polite">
    <strong className="update-prompt-title">{text('promptTitle', { arg0: version })}</strong>
    {status === 'idle' && !state.canAutoInstall && <span className="muted update-prompt-note">{text('devNote')}</span>}
    {status === 'downloading' && <div className="update-prompt-progress">
      <progress max={100} value={percent} aria-label={text('downloading')} />
      <span>{text('downloading')} {percent}%</span>
    </div>}
    {status === 'ready' && <span className="muted">{text('restarting')}</span>}
    {status === 'error' && <span className="update-prompt-error">{text('updateFailed')}</span>}
    {(status === 'idle' || status === 'error') && <div className="update-prompt-actions">
      {status === 'idle'
        ? <button type="button" className="primary" onClick={install}>{text('update')}</button>
        : <button type="button" className="primary" onClick={openReleasePage}>{text('openDownloadPage')}</button>}
      <button type="button" onClick={() => ignore(version)}>{text('ignore')}</button>
    </div>}
  </div>;
}
