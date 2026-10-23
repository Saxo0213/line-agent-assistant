import { generatedMessageText, safeErrorTextFor, useDesktopText } from '../desktop-i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../../preload/api.js';
import type { SetupProgressEvent } from '../../setup-protocol.js';
import { localeFromState, useLocale } from '../locale-context.js';

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const SAFE_ERROR_CODE = /^[a-z0-9_:.-]{1,120}$/;
const PHASE_KEYS = {
  runtime: 'checkingRuntime', download: 'downloadingDatabaseFiles', verify: 'verifyingFiles', extract: 'extracting',
  initdb: 'initializingDatabase', start: 'startingDatabase', database: 'creatingTables',
} as const;
const megabytes = (bytes: number) => Math.round(bytes / 1048576);

/** Starts the database install on mount without a click, saves the default folders, then restarts (or exits in installer setup-only mode, decided by main). */
export function SetupWizard({ api, defaultAttachmentRoot, defaultAgentWorkspace }: {
  api: DesktopApi; defaultAttachmentRoot: string; defaultAgentWorkspace: string;
}) {
  const locale = localeFromState(useLocale());
  const text = useDesktopText();
  const phaseText = (phase: SetupProgressEvent['phase']) => text(PHASE_KEYS[phase]);
  const [running, setRunning] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<SetupProgressEvent | null>(null);
  const [failure, setFailure] = useState<{ message: string; code: string | null } | null>(null);
  const started = useRef(false);
  const provisioned = useRef(false);
  useEffect(() => api.onSetupProgress?.(setProgress), [api]);

  async function run() {
    setRunning(true); setFailure(null); setProgress(null);
    try {
      if (!provisioned.current) { await api.startEmbeddedProvision(); provisioned.current = true; }
      setSaving(true);
      const result = await api.saveEmbeddedSetup(defaultAttachmentRoot, defaultAgentWorkspace);
      if (result.restartRequired) await api.restartApplication();
    } catch (error) {
      const code = typeof (error as { errorCode?: unknown })?.errorCode === 'string' ? (error as { errorCode: string }).errorCode : null;
      setFailure({ message: safeErrorTextFor(locale, error, text('unableToInstallDatabase')), code: code && SAFE_ERROR_CODE.test(code) ? code : null });
      setRunning(false); setSaving(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- starts exactly once per mount, including under StrictMode double effects
  }, []);

  return <div className="setup-shell" lang={locale}><main className="setup-wizard" aria-labelledby="setup-title">
    <h1 id="setup-title">{text('installDatabase')}</h1>
    {running && <div role="status">
      <p>{saving ? phaseText('database') : progress?.phase === 'download' && progress.totalBytes
        ? `${phaseText('download')} ${megabytes(progress.receivedBytes ?? 0)} / ${megabytes(progress.totalBytes)} MB`
        : progress ? phaseText(progress.phase) : phaseText('runtime')}</p>
      {!saving && progress?.phase === 'download' && progress.totalBytes
        ? <progress className="setup-progress" max={progress.totalBytes} value={progress.receivedBytes ?? 0} aria-label={text('downloadProgress')} />
        : <progress className="setup-progress" aria-label={text('installationProgress')} />}
    </div>}
    {failure && <div role="alert" className="error-banner">
      {failure.code === 'vc_runtime_missing' ? <><p>{text('microsoftVisualCRuntimeRequired')}</p>
        <p><button type="button" onClick={() => void api.openExternalUrl(VC_REDIST_URL)}>{text('openMicrosoftDownloadPage')}</button></p></> : <p>{generatedMessageText(failure.message)}</p>}
      {failure.code && <p className="progress-error-code">{text('errorCode')}<span>{failure.code}</span></p>}
    </div>}
    <div className="wizard-actions">
      {running
        ? !saving && <button onClick={() => void api.cancelEmbeddedProvision()}>{text('cancel')}</button>
        : <button className="primary" onClick={() => void run()}>{failure?.code === 'vc_runtime_missing' ? text('recheck') : text('retry')}</button>}
    </div>
  </main></div>;
}
