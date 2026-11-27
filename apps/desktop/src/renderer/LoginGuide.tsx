import React from 'react';
import type { LineAccountSummary } from '@line-agent/contracts';
import { useDesktopText } from './desktop-i18n.js';
import { HeaderDialog } from './HeaderDialog.js';

/** Which login guide steps are done, from the account list. */
export function loginGuideState(accounts: readonly LineAccountSummary[]) {
  const agent = accounts.find((account) => account.productRole === 'AGENT');
  const admin = accounts.find((account) => account.productRole === 'PRIMARY_ADMIN');
  const bridge = admin?.downloadBridge;
  const agentDone = agent?.status === 'connected';
  const adminDone = admin !== undefined || agent?.hasPrimaryAdmin === true;
  const bridgeDone = bridge?.state === 'logged_in' && bridge.identity === 'verified';
  return { agentDone, adminDone, bridgeDone, needsAttention: !(agentDone && adminDone) };
}

/** Dialog opened from the Settings header. */
export function LoginGuideDialog({ accounts, closeLabel, onClose }: { accounts: readonly LineAccountSummary[]; closeLabel: string; onClose: () => void }) {
  const desktopText = useDesktopText();
  const { agentDone, adminDone, bridgeDone } = loginGuideState(accounts);
  const badge = (done: boolean) => <span className={`badge login-guide-badge ${done ? 'done' : 'todo'}`}>{done ? desktopText('loginGuideDone') : desktopText('loginGuideNotDone')}</span>;
  return <HeaderDialog id="login-guide" title={desktopText('loginGuideSummary')} closeLabel={closeLabel} className="login-guide-dialog" onClose={onClose}>
    <p className="muted header-dialog-intro">{desktopText('loginGuideIntro')}</p>
    <ol className="login-guide-steps">
      <li><div className="login-guide-step-head"><strong>{desktopText('loginGuideStep1Title')}</strong>{badge(agentDone)}</div>
        <p>{desktopText('loginGuideStep1Purpose')}</p><p>{desktopText('loginGuideStep1Login')}</p><p>{desktopText('loginGuideStep1Warning')}</p></li>
      <li><div className="login-guide-step-head"><strong>{desktopText('loginGuideStep2Title')}</strong>{badge(adminDone)}</div>
        <p>{desktopText('loginGuideStep2Purpose')}</p><p>{desktopText('loginGuideStep2Setup')}</p><p>{desktopText('loginGuideStep2Alternative')}</p></li>
      <li><div className="login-guide-step-head"><strong>{desktopText('loginGuideStep3Title')}</strong></div>
        <p>{desktopText('loginGuideStep3Body')}</p></li>
      <li><div className="login-guide-step-head"><strong>{desktopText('loginGuideStep4Title')}</strong><span className="login-guide-badges"><span className="badge login-guide-badge optional">{desktopText('loginGuideOptional')}</span>{bridgeDone && badge(true)}</span></div>
        <p>{desktopText('loginGuideStep4Purpose')}</p><p>{desktopText('loginGuideStep4Setup')}</p></li>
    </ol>
  </HeaderDialog>;
}
