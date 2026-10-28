import { useExtraText, useDesktopLocale, useDesktopText } from '../desktop-i18n.js';
import React, { useRef, useState } from 'react';
import type { ConversationKey, ConversationSummary, LineAccountSummary, MessageSearchResult } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { chatTypeLabel, conversationFallbackTitle } from '../chatTypeLabels.js';

export function Search({ api, accounts, conversations, accountScopeId, onAccountScopeChange, onOpen, headingRef }: {
  api: DesktopApi;
  accounts: LineAccountSummary[];
  conversations: ConversationSummary[];
  accountScopeId: string | null;
  onAccountScopeChange: (accountId: string | null) => void;
  onOpen: (key: ConversationKey) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const desktopText = useDesktopText();
  const extraText = useExtraText();
  const locale = useDesktopLocale();
  const [text, setText] = useState('');
  const [chatType, setChatType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [attachments, setAttachments] = useState(false);
  const [results, setResults] = useState<MessageSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const hasSearched = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Searches run only on an explicit action; the sequence guard drops stale responses.
  const lineageIds = accounts.filter((account) => account.agentLineage !== undefined || account.productRole === 'AGENT').map((account) => account.accountId);
  const currentAgentId = accounts.find((account) => account.agentLineage === 'current')?.accountId
    ?? accounts.find((account) => account.productRole === 'AGENT')?.accountId ?? null;
  const isLineage = (accountId: string) => lineageIds.includes(accountId);
  const inAgentGroup = (item: MessageSearchResult) => item.lineage === 'agent' || isLineage(item.accountId);
  const runSearch = (scopeId: string | null) => {
    const current = ++generation.current;
    hasSearched.current = true;
    setSearching(true);
    setError('');
    const agentScope = scopeId !== null && isLineage(scopeId);
    void api.searchMessages({ ...(scopeId === null ? {} : agentScope ? { scope: { kind: 'agent' as const } } : { accountId: scopeId }), text, limit: 100 }).then((messages) => {
      if (current !== generation.current) return;
      setResults(messages.filter((item) => (scopeId === null || (agentScope ? inAgentGroup(item) : item.accountId === scopeId))
        && (!chatType || item.chatType === chatType)
        && (!from || item.occurredAt.slice(0, 10) >= from)
        && (!to || item.occurredAt.slice(0, 10) <= to)));
      setSearching(false);
    }).catch(() => {
      if (current !== generation.current) return;
      setError(desktopText('searchIsTemporarilyUnavailableCheckDatabaseSettings'));
      setSearching(false);
    });
  };
  const agentTabActive = accountScopeId !== null && isLineage(accountScopeId);
  const selectAccount = (accountId: string | null) => {
    onAccountScopeChange(accountId);
    if (hasSearched.current) runSearch(accountId);
  };

  const accountName = (id: string) => {
    const name = accounts.find((account) => account.accountId === id)?.displayName ?? desktopText('lineAccount');
    if (accounts.filter((account) => account.displayName === name).length < 2) return name;
    return desktopText('arg0AccountArg1', { arg0: name, arg1: accounts.findIndex((account) => account.accountId === id) + 1 });
  };
  const conversationFor = (item: MessageSearchResult) => conversations.find((conversation) => conversation.accountId === item.accountId
    && conversation.chatType === item.chatType && conversation.chatId === item.chatId);
  // Every account of the Agent lineage is one group: the same chat found in several of them is one conversation.
  const AGENT_GROUP = 'agent-lineage';
  const accountGroups = Array.from((results ?? []).reduce((map, item) => {
    const groupId = inAgentGroup(item) ? AGENT_GROUP : item.accountId;
    const current = map.get(groupId) ?? [];
    current.push(item);
    map.set(groupId, current);
    return map;
  }, new Map<string, MessageSearchResult[]>()).entries());
  const dedupeAgentItems = (items: MessageSearchResult[]) => {
    const kept = new Map<string, MessageSearchResult>();
    for (const item of items) {
      const key = JSON.stringify([item.chatType, item.chatId, item.messageId]);
      const held = kept.get(key);
      if (!held || (held.accountId !== currentAgentId && item.accountId === currentAgentId)) kept.set(key, item);
    }
    return Array.from(kept.values());
  };
  const conversationGroups = (items: MessageSearchResult[], agentGroup: boolean) => Array.from(items.reduce((map, item) => {
    const key = agentGroup ? JSON.stringify([item.chatType, item.chatId]) : JSON.stringify([item.accountId, item.chatType, item.chatId]);
    const current = map.get(key) ?? [];
    current.push(item);
    map.set(key, current);
    return map;
  }, new Map<string, MessageSearchResult[]>()).entries());

  return <div className="page search-page">
    <header className="page-header compact"><div><span className="eyebrow">{extraText('archiveSearch')}</span><div className="page-title-row"><h1 tabIndex={-1} ref={headingRef}>{desktopText('searchChatHistory')}</h1><p>{desktopText('searchByAccountTypeDateAndMessageContent')}</p></div></div></header>
    <form className="panel filter-grid" onSubmit={(event) => { event.preventDefault(); if (!searching) runSearch(accountScopeId); }}>
      <div className="search-row-main">
        <label>{desktopText('messageOrFilename')}<input value={text} onChange={(event) => setText(event.target.value)} /></label>
        <button type="submit" className="primary" disabled={searching}>{searching ? desktopText('searching') : desktopText('search')}</button>
      </div>
      <div className="search-row-filters">
        <label>{desktopText('type')}<select value={chatType} onChange={(event) => setChatType(event.target.value)}><option value="">{desktopText('all')}</option><option value="direct">{desktopText('direct')}</option><option value="group">{desktopText('group')}</option><option value="room">{desktopText('room')}</option><option value="community">{desktopText('community')}</option><option value="thread">{desktopText('thread')}</option></select></label>
        <label>{desktopText('startDate492')}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>{desktopText('endDate')}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={attachments} onChange={(event) => setAttachments(event.target.checked)} />{desktopText('attachmentsOnly')}</label>
      </div>
    </form>
    <div className="settings-tabs search-account-tabs" role="tablist" aria-label={desktopText('filterAccounts')}>
      <button type="button" role="tab" aria-selected={accountScopeId === null} className={accountScopeId === null ? 'active' : ''} onClick={() => selectAccount(null)}>{desktopText('allAccounts')}</button>
      {lineageIds.length > 0 && <button type="button" role="tab" aria-selected={agentTabActive} className={agentTabActive ? 'active' : ''}
        onClick={() => selectAccount(currentAgentId ?? lineageIds[0]!)}>{extraText('searchAgentTab')}</button>}
      {accounts.filter((item) => !isLineage(item.accountId)).map((item) => <button type="button" role="tab" key={item.accountId} aria-selected={accountScopeId === item.accountId}
        className={accountScopeId === item.accountId ? 'active' : ''} onClick={() => selectAccount(item.accountId)}>{item.productRole === 'PRIMARY_ADMIN' ? extraText('searchPrimaryAdminTab') : accountName(item.accountId)}</button>)}
    </div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {attachments && <p className="inline-notice">{desktopText('attachmentFilteringIsNotYetConnectedToDatabaseSearch')}</p>}
    <section className="result-list">
      {accountGroups.map(([accountId, rawItems]) => {
        const agentGroup = accountId === AGENT_GROUP;
        const accountItems = agentGroup ? dedupeAgentItems(rawItems) : rawItems;
        const groupLabel = agentGroup ? extraText('searchAgentTab') : accountName(accountId);
        return <section className="search-account-group" key={accountId}>
        <h2>{groupLabel}</h2>
        {conversationGroups(accountItems, agentGroup).map(([groupKey, items], index) => {
          const first = items[0]!;
          const preferred = items.find((item) => item.accountId === currentAgentId) ?? first;
          const conversation = conversationFor(preferred);
          const title = preferred.conversationTitle || first.conversationTitle || conversation?.title || conversationFallbackTitle(first.chatType);
          const open = expanded.has(groupKey);
          const panelId = `search-results-${accountId}-${index}`;
          const category = chatTypeLabel(first.chatType);
          return <section className="search-group" key={groupKey}>
            <button className="search-group-heading" aria-expanded={open} aria-controls={panelId} onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
              return next;
            })}>
              <div><h3>{title}</h3><span>{agentGroup ? groupLabel : accountName(first.accountId)} · {category}</span></div><b>{items.length} {desktopText('results')}</b>
            </button>
            {open && <div id={panelId} className="search-table" role="table" aria-label={desktopText('arg0SearchResults', { arg0: title })}>
              <div className="search-table-head" role="row"><span role="columnheader">{desktopText('displayName')}</span><span role="columnheader">{desktopText('time')}</span><span role="columnheader">{desktopText('content')}</span><span role="columnheader">{desktopText('action')}</span></div>
              {items.map((item) => {
                const nickname = item.senderName || desktopText(item.isOwn === true ? 'me' : item.isOwn === false ? 'otherPerson' : 'unknown');
                const time = new Date(item.occurredAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const former = agentGroup && item.accountId !== currentAgentId;
                // Prefer the current Agent account's copy of the chat; otherwise the original account's read-only view.
                const openKey = agentGroup && currentAgentId !== null && conversations.some((entry) => entry.accountId === currentAgentId
                  && entry.chatType === item.chatType && entry.chatId === item.chatId)
                  ? { accountId: currentAgentId, chatType: item.chatType, chatId: item.chatId }
                  : { accountId: item.accountId, chatType: item.chatType, chatId: item.chatId };
                return <button className="search-row" key={`${item.accountId}:${item.messageId}`} aria-label={desktopText('arg0Arg1Arg2OpenInChat', { arg0: nickname, arg1: time, arg2: item.text ?? desktopText('attachmentOrSystemMessage') })}
                  onClick={() => onOpen(openKey)}>
                  <span className="search-nickname">{nickname}</span><time>{time}</time><span className="search-content">{item.text || desktopText('attachmentOrSystemMessage')}{former && <small className="search-former-agent"> · {extraText('formerAgentAccount')}</small>}</span><span className="search-open" aria-hidden="true">{desktopText('open505')}</span>
                </button>;
              })}
            </div>}
          </section>;
        })}
      </section>;
      })}
      {results === null && !error && !searching && <p className="empty">{desktopText('enterCriteriaAndClickSearch')}</p>}
      {results !== null && !results.length && !error && !searching && <p className="empty">{desktopText('noMatchingRecordsShortenTheDateRangeOrRemove')}</p>}
    </section>
  </div>;
}
