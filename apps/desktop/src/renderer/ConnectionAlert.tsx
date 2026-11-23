import React from 'react';
import type { AppSnapshot } from '@line-agent/contracts';
import { useDesktopText } from './desktop-i18n.js';

type Account = AppSnapshot['accounts'][number];

/** An account is abnormal when its LINE system login is degraded or needs a new login. The Primary Admin is skipped while external monitoring runs. */
export function abnormalConnectionAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => {
    if (account.productRole !== 'AGENT' && account.productRole !== 'PRIMARY_ADMIN') return false;
    if (account.status !== 'degraded' && account.status !== 'reauth_required') return false;
    const stage = account.externalImportProgress?.stage;
    const monitoring = stage === 'monitoring' || stage === 'syncing';
    return !(monitoring && account.productRole === 'PRIMARY_ADMIN');
  });
}

/** Floating non-modal card: one line per abnormal account. It stays until the status is normal and has no dismiss button. */
export function ConnectionAlert({ accounts, onView }: { accounts: readonly Account[]; onView: () => void }) {
  const desktopText = useDesktopText();
  const abnormal = abnormalConnectionAccounts(accounts);
  if (abnormal.length === 0) return null;
  const nameOf = (account: Account) => account.displayName?.trim() || (account.productRole === 'PRIMARY_ADMIN' ? 'Primary Admin' : desktopText('agentNavigation'));
  return <div className="update-prompt connection-alert" role="status" aria-live="polite">
    {abnormal.map((account) => <strong className="update-prompt-title" key={account.accountId}>{desktopText('connectionAlertArg0', { arg0: nameOf(account) })}</strong>)}
    <div className="update-prompt-actions"><button type="button" className="primary" onClick={onView}>{desktopText('connectionAlertView')}</button></div>
  </div>;
}
