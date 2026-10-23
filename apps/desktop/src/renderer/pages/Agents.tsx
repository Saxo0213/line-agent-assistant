import { generatedMessageText, useExtraText, useDesktopText } from '../desktop-i18n.js';
import React, { useState } from 'react';
import type { ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import {AgentProviderAuthControl} from './AgentProviderAuthControl.js';

export function Agents({ api, providers, headingRef }: { api: DesktopApi; providers: ProviderStatus[]; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const extraText = useExtraText();
  const desktopText = useDesktopText();
  const [status, setStatus] = useState('');
  return <div className="page"><header className="page-header"><div><span className="eyebrow">{extraText('optionalLocalAnalysis')}</span><h1 tabIndex={-1} ref={headingRef}>{extraText('agents')}</h1><p>{desktopText('usesTheLocalCodexOrClaudeCliLocalAnalysis')}</p></div></header>{status && <p role="status" className="inline-notice">{generatedMessageText(status)}</p>}
    <div className="cards">{providers.map((provider) => <article className="panel" key={provider.provider}><div className="panel-top"><h2>{provider.provider === 'codex' ? 'Codex' : 'Claude'}</h2><span className="badge">{provider.status === 'logged_in' ? desktopText('loggedIn') : provider.status === 'logged_out' ? desktopText('notLoggedIn') : provider.status === 'not_installed' ? desktopText('notInstalled') : provider.status === 'unknown' ? desktopText('checkedAtRuntime') : desktopText('unavailable')}</span></div><p>{(provider.status === 'not_installed' ? desktopText('arg0WasNotFoundLineFeaturesAreUnaffected', { arg0: provider.provider }) : desktopText('officialCliLoginStatus'))}</p><AgentProviderAuthControl api={api} providerStatus={provider} onStatus={setStatus} /></article>)}</div></div>;
}
