import { useSafeErrorText, useDesktopText } from '../desktop-i18n.js';
import React, {useState} from 'react';
import type {ProviderStatus} from '@line-agent/contracts';
import type {DesktopApi} from '../../preload/api.js';

export function AgentProviderAuthControl({api,providerStatus,onStatus}: {
  api:DesktopApi;
  providerStatus:ProviderStatus;
  onStatus:(message:string)=>void;
}) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const [busy,setBusy]=useState(false);
  const providerName=providerStatus.provider==='codex'?'Codex':'Claude';
  if(providerStatus.status==='not_installed') return null;
  const refresh=providerStatus.status==='unknown'||providerStatus.status==='error';
  const loggedIn=providerStatus.status==='logged_in';

  async function act() {
    if(busy) return;
    if(loggedIn && !window.confirm(desktopText('logOutOfArg0Cli', { arg0: providerName }))) return;
    setBusy(true);
    try {
      const result=refresh?await api.agentRefreshStatus(providerStatus.provider)
        :loggedIn?await api.agentLogout(providerStatus.provider):await api.agentLogin(providerStatus.provider);
      onStatus(result.ok?desktopText('arg0StatusActionCompleted', { arg0: providerName }):safeErrorText(result));
    } catch {
      onStatus(desktopText('arg0StatusActionFailed', { arg0: providerName }));
    } finally { setBusy(false); }
  }

  if (refresh) return <button type="button" aria-label={desktopText('recheckArg0', { arg0: providerName })} disabled={busy} onClick={() => void act()}>{desktopText('recheck')}</button>;
  const label=loggedIn?desktopText('logOut'):desktopText('logIn');
  return <button type="button" aria-label={`${label} ${providerName}`} disabled={busy} onClick={() => void act()}>{label}</button>;
}
