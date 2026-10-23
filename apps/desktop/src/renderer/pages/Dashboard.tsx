import { useExtraText, useDesktopText } from '../desktop-i18n.js';
import React from 'react';
import type { ComponentHealth, LineAccountSummary } from '@line-agent/contracts';

export function Dashboard({ components, accounts, onSettings, headingRef }: { components: ComponentHealth[]; accounts: LineAccountSummary[]; onSettings: () => void; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const desktopText = useDesktopText();
  const extraText = useExtraText();
  const core = components.filter((item) => item.name === 'database' || item.name === 'lineWorker');
  const databaseUnavailable = components.some((item) => item.name === 'database' && item.status !== 'ready');
  const hasConnectedAccount = accounts.some((account) => account.status === 'connected');
  const optional = components.filter((item) => item.name === 'codex' || item.name === 'claude');
  return <div className="page"><header className="page-header"><div><span className="eyebrow">{extraText('operations')}</span><h1 tabIndex={-1} ref={headingRef}>{desktopText('systemStatus')}</h1><p>{desktopText('lineTheDatabaseAndLocalAgentsEachHaveTheir')}</p></div></header>
    <div className="section-grid dashboard-status-grid"><section className="panel"><h2>{desktopText('coreFeatures')}</h2>{core.length ? core.map((item) => {
      const awaitingLineLogin = item.name === 'lineWorker' && item.status === 'stopped' && !hasConnectedAccount;
      return <div className="status-row" key={item.name}><span className={`status-dot ${awaitingLineLogin ? 'neutral' : item.status}`} /><div><strong>{item.name === 'database' ? 'PostgreSQL' : 'LINE workers'}</strong><p>{awaitingLineLogin ? desktopText('noLineAccountLoggedIn') : item.status === 'ready' ? desktopText('connected') : desktopText('temporarilyUnavailable')}</p></div>{item.name === 'database' && item.status !== 'ready' && <button onClick={onSettings}>{desktopText('checkSettings')}</button>}</div>;
    }) : <div className="status-row"><p>{desktopText('coreComponentsHaveNotStarted')}</p><button onClick={onSettings}>{desktopText('checkSettings')}</button></div>}</section>
      <section className="panel"><h2>{desktopText('optionalAgents')}</h2>{optional.length ? optional.map((item) => <div className="status-row" key={item.name}><span className={`status-dot ${item.status}`} /><div><strong>{item.name === 'codex' ? 'Codex' : 'Claude'}</strong><p>{(item.status === 'ready' ? desktopText('available') : desktopText('notConfigured'))}</p></div></div>) : <p>{desktopText('codexAndClaudeAreNotConfiguredLineSyncSearch')}</p>}</section></div>
    {databaseUnavailable && <div className="error-banner" role="alert">{desktopText('databaseDisconnectedLineSendingIsPausedToPreserveComplete')}<button onClick={onSettings}>{desktopText('checkSettings')}</button></div>}
  </div>;
}
