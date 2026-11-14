import React, { useEffect, useId, useState } from 'react';
import type { DesktopApi } from '../../preload/api.js';
import type { FormError, MentionMember } from '../scheduleForm.js';
import type { Text } from './ScheduleFields.js';

type Candidate = { accountId: string; mid: string; label: string };
type AccountOption = { accountId: string; name: string };

/** Shown list of matches; the friend lists are long, so only the first matches are listed. */
const MATCHES_MAX = 20;

/**
 * Multi-select of the members that a mention rule watches. The candidates are the friends of the Agent and Primary Admin accounts;
 * a MID can also be entered by hand. The label of a member is the name that was shown when it was picked.
 */
export function ScheduleMentionMembers({ api, text, members, max, onChange, error, errorId }: {
  api: DesktopApi; text: Text; members: readonly MentionMember[]; max: number; onChange(members: MentionMember[]): void; error?: FormError | undefined; errorId: string;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [query, setQuery] = useState('');
  const [manualAccount, setManualAccount] = useState('');
  const [manualMid, setManualMid] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const searchId = useId();
  useEffect(() => {
    let active = true;
    void (async () => {
      const snapshot = await api.getSnapshot();
      const roleAccounts = snapshot.accounts.filter((account) => account.productRole === 'AGENT' || account.productRole === 'PRIMARY_ADMIN');
      if (!active) return;
      setAccounts(roleAccounts.map((account) => ({ accountId: account.accountId, name: account.displayName || account.accountId })));
      const lists = await Promise.all(roleAccounts.map((account) => api.listFriends(account.accountId).then(
        (friends) => friends.map((friend) => ({ accountId: account.accountId, mid: friend.mid, label: friend.name || friend.mid })), () => [] as Candidate[])));
      if (!active) return;
      const unique = new Map<string, Candidate>();
      for (const candidate of lists.flat()) if (!unique.has(candidate.mid)) unique.set(candidate.mid, candidate);
      setCandidates([...unique.values()].sort((a, b) => a.label.localeCompare(b.label)));
    })().catch(() => undefined);
    return () => { active = false; };
  }, [api]);
  const chosen = new Set(members.map((member) => member.mid));
  const full = members.length >= max;
  const needle = query.trim().toLowerCase();
  const matches = needle ? candidates.filter((candidate) => !chosen.has(candidate.mid) && candidate.label.toLowerCase().includes(needle)).slice(0, MATCHES_MAX) : [];
  const add = (member: MentionMember) => {
    if (full || chosen.has(member.mid)) return;
    onChange([...members, member]); setQuery('');
  };
  const manualMidTrimmed = manualMid.trim();
  const manualAccountId = manualAccount || accounts[0]?.accountId || '';
  const canAddManual = !full && manualMidTrimmed.length > 0 && manualAccountId.length > 0 && !chosen.has(manualMidTrimmed);
  return <div className="schedule-field" role="group" aria-labelledby={`${searchId}-label`}>
    <div className="schedule-label-row">
      <label id={`${searchId}-label`} htmlFor={searchId} className="schedule-label">{text('mentionMembers')}</label>
      {members.length > 0 && <span className="schedule-hint" aria-live="polite">{text('mentionCount', { arg0: members.length, arg1: max })}</span>}
    </div>
    {members.length > 0 && <ul className="schedule-chips">{members.map((member) => <li key={member.mid} className="schedule-chip">
      <span>{member.label || member.mid}</span>
      <button type="button" aria-label={text('mentionRemove', { arg0: member.label || member.mid })} onClick={() => onChange(members.filter((item) => item.mid !== member.mid))}><span aria-hidden="true">×</span></button>
    </li>)}</ul>}
    <div className="schedule-combobox">
      <input id={searchId} type="search" name="mention-search" autoComplete="off" value={query} placeholder={text('mentionSearch')} disabled={full}
        aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); const first = matches[0]; if (first) add(first); } }} />
      {needle && <div className="schedule-dropdown">
        {matches.length > 0
          ? <div role="listbox" aria-label={text('mentionMembers')}>{matches.map((candidate) => <div key={candidate.mid} role="option" aria-selected={false} className="schedule-option"
            aria-label={text('mentionAdd', { arg0: candidate.label })} onMouseDown={(event) => event.preventDefault()} onClick={() => add(candidate)}><span>{candidate.label}</span></div>)}</div>
          : <p className="schedule-hint schedule-dropdown-status" role="status">{text('mentionNoFriends')}</p>}
      </div>}
    </div>
    <details>
      <summary>{text('mentionManual')}</summary>
      <div className="schedule-field">
        <select aria-label={text('forwardSenderAccount')} value={manualAccountId} onChange={(event) => setManualAccount(event.target.value)}>
          {accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.name}</option>)}
        </select>
        <div className="schedule-inline">
          <input aria-label={text('forwardSenderMid')} placeholder={text('forwardSenderMid')} autoComplete="off" value={manualMid} onChange={(event) => setManualMid(event.target.value)} />
          <input aria-label={text('forwardSenderLabel')} placeholder={text('forwardSenderLabel')} autoComplete="off" value={manualLabel} onChange={(event) => setManualLabel(event.target.value)} />
          <button type="button" disabled={!canAddManual} onClick={() => { add({ accountId: manualAccountId, mid: manualMidTrimmed, label: manualLabel.trim() || manualMidTrimmed }); setManualMid(''); setManualLabel(''); }}>{text('mentionManualAdd')}</button>
        </div>
      </div>
    </details>
    {error && <p id={errorId} role="alert" className="schedule-error">{text(error.key, error.values)}</p>}
  </div>;
}
