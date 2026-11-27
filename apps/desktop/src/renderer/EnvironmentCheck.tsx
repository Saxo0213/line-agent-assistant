import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../preload/api.js';
import type { EnvironmentCheckResult, EnvironmentItemId } from '../environment-check-protocol.js';
import { environmentTextFor, type EnvironmentCopyKey } from '../desktop-environment-copy.js';
import { useDesktopLocale } from './desktop-i18n.js';
import { HeaderDialog } from './HeaderDialog.js';

const NAME_KEY: Record<EnvironmentItemId, EnvironmentCopyKey> = {
  chrome: 'chromeName', lineExtension: 'lineExtensionName', lineDesktop: 'lineDesktopName', nodejs: 'nodejsName', claude: 'claudeName', codex: 'codexName',
};
const PURPOSE_KEY: Record<EnvironmentItemId, EnvironmentCopyKey> = {
  chrome: 'chromePurpose', lineExtension: 'lineExtensionPurpose', lineDesktop: 'lineDesktopPurpose', nodejs: 'nodejsPurpose', claude: 'claudePurpose', codex: 'codexPurpose',
};
const STATUS_KEY = { ok: 'statusOk', missing: 'statusMissing', unknown: 'statusUnknown' } as const satisfies Record<string, EnvironmentCopyKey>;

/** Check state from Main. The check runs once on mount, on 重新檢查, and when an install window closes. Stays inactive when the bridge is missing (older test doubles). */
export function useEnvironmentCheck(api: DesktopApi) {
  const [result, setResult] = useState<EnvironmentCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    if (!api.getEnvironmentCheck) return;
    setBusy(true);
    try {
      const next = await api.getEnvironmentCheck();
      if (live.current) { setResult(next); setFailed(false); }
    } catch { if (live.current) setFailed(true); }
    finally { if (live.current) setBusy(false); }
  }, [api]);
  useEffect(() => {
    live.current = true;
    void refresh();
    const unsubscribe = api.onEnvironmentCheckChanged?.(() => { void refresh(); });
    return () => { live.current = false; unsubscribe?.(); };
  }, [api, refresh]);
  const install = useCallback((id: EnvironmentItemId) => { void api.installEnvironmentItem?.(id).catch(() => undefined); }, [api]);
  return { result, busy, failed, refresh, install, available: api.getEnvironmentCheck !== undefined, needsAttention: result?.items.some((item) => item.status === 'missing') === true };
}

export type EnvironmentCheckState = ReturnType<typeof useEnvironmentCheck>;

/** Dialog opened from the Settings header. It checks again when it opens. */
export function EnvironmentCheckDialog({ check, onClose }: { check: EnvironmentCheckState; onClose: () => void }) {
  const locale = useDesktopLocale();
  const text = (key: EnvironmentCopyKey) => environmentTextFor(locale, key);
  const { refresh } = check;
  useEffect(() => { void refresh(); }, [refresh]);
  const nodeMissing = check.result?.items.find((item) => item.id === 'nodejs')?.status === 'missing';
  return <HeaderDialog id="environment-check" title={text('title')} closeLabel={text('close')} className="environment-check-dialog" onClose={onClose}>
    <p className="muted header-dialog-intro">{text('intro')}</p>
    <table className="environment-check-table">
      <thead><tr><th scope="col">{text('colItem')}</th><th scope="col">{text('colStatus')}</th><th scope="col">{text('colAction')}</th></tr></thead>
      <tbody>
        {check.result?.items.map((item) => {
          const blocked = item.id === 'codex' && nodeMissing;
          return <tr key={item.id}>
            <td><div className="environment-check-name"><strong>{text(NAME_KEY[item.id])}</strong><span className="muted">{text(PURPOSE_KEY[item.id])}</span></div></td>
            <td><span className={`badge environment-check-status ${item.status}`}>{text(STATUS_KEY[item.status])}{item.status === 'ok' && item.version ? ` ${item.version}` : ''}</span></td>
            <td>{item.status === 'missing' && <div className="environment-check-action">
              <button type="button" disabled={blocked} onClick={() => check.install(item.id)}>{text('install')}</button>
              {blocked && <span className="muted">{text('needNode')}</span>}
            </div>}</td>
          </tr>;
        })}
      </tbody>
    </table>
    {check.failed && <p role="alert">{text('checkFailed')}</p>}
    <div className="modal-actions">
      <button type="button" disabled={check.busy} onClick={() => void check.refresh()}>{check.busy ? text('checking') : text('recheck')}</button>
    </div>
  </HeaderDialog>;
}
