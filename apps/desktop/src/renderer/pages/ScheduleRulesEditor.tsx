import React, { useId, useState } from 'react';
import type { AgentScheduleRuleAction, AgentScheduleTarget } from '@line-agent/contracts';
import { AGENT_SCHEDULE_RULE_ACTIONS } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import {
  ACTION_KEYS, CHAT_TYPES, LEAVES_MAX, LIST_VALUES_MAX, PER_CHAT_RANGE, RULES_MAX, TEXT_CHARS_RANGE,
  countDraftLeaves, enumValueLabel, enumValues, isSingleOp, leafForMetric, leafWithOp, metricKey, metricKind, metricsOf, moveItem, newGroup, newLeaf, newRule, opLabel, opsOf,
  type ChatType, type DraftGroup, type DraftLeaf, type DraftRule, type Metric, type NewMessagesDraft, type RuleError, type RuleScope,
} from '../scheduleRules.js';
import { ChatCombobox, KeywordInput, type Text } from './ScheduleFields.js';

type Errors = Record<string, RuleError>;

function ErrorLine({ text, error, id }: { text: Text; error: RuleError | undefined; id: string }) {
  return error ? <p id={id} role="alert" className="schedule-error">{text(error.key, error.values)}</p> : null;
}

/** Keyword list of one condition. The typed word is added when the box loses focus, so a word is never lost on save. */
function LeafKeywords({ text, keywords, onChange, error, errorId }: { text: Text; keywords: string[]; onChange: (keywords: string[]) => void; error: RuleError | undefined; errorId: string }) {
  const [pending, setPending] = useState('');
  return <KeywordInput text={text} keywords={keywords} onChange={onChange} error={error} errorId={errorId} pending={pending} onPending={setPending} commitOnBlur />;
}

function LeafRow({ api, text, scope, leaf, onChange, onRemove, removable, errors }: {
  api: DesktopApi; text: Text; scope: RuleScope; leaf: DraftLeaf; onChange: (leaf: DraftLeaf) => void; onRemove: () => void; removable: boolean; errors: Errors;
}) {
  const errorId = useId();
  const keywordsErrorId = useId();
  const kind = metricKind(leaf.metric);
  const error = errors[leaf.key];
  const invalid = error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
  const single = isSingleOp(leaf.op);
  // chat.id is picked with the chat search: in and not_in. A stored == or != keeps its operator.
  const ops = leaf.metric === 'chat.id' && !single ? ['in', 'not_in'] : leaf.metric === 'chat.id' ? ['in', 'not_in', leaf.op] : opsOf(leaf.metric);
  const toggle = (value: string) => onChange({ ...leaf, list: leaf.list.includes(value) ? leaf.list.filter((item) => item !== value) : [...leaf.list, value] });
  const picked: AgentScheduleTarget[] = leaf.list.map((id) => {
    const chat = leaf.chats[id];
    return { accountId: chat?.accountId ?? '', chatType: (chat?.chatType ?? '') as ChatType, chatId: id, title: chat?.title ?? '' };
  });
  const onPick = (targets: AgentScheduleTarget[]) => {
    const list = [...new Set(targets.map((target) => target.chatId))];
    const chats = { ...leaf.chats };
    for (const id of Object.keys(chats)) if (!list.includes(id)) delete chats[id];
    for (const target of targets) chats[target.chatId] = { accountId: target.accountId, chatType: target.chatType, title: target.title };
    onChange({ ...leaf, list, chats });
  };
  return <div className="schedule-cond-item">
    <div className="schedule-cond-row">
      <select name="metric" aria-label={text('condMetric')} value={leaf.metric} onChange={(event) => onChange(leafForMetric(event.target.value as Metric, leaf.key))}>
        {metricsOf(scope).map((metric) => <option key={metric} value={metric}>{text(metricKey(metric))}</option>)}
      </select>
      <select name="op" aria-label={text('condOp')} value={leaf.op} onChange={(event) => onChange(leafWithOp(leaf, event.target.value))}>
        {ops.map((op) => <option key={op} value={op}>{opLabel(op, text, kind === 'number')}</option>)}
      </select>
      {kind === 'number' && <input name="value" type="number" inputMode="numeric" min={0} className="schedule-number" autoComplete="off" aria-label={text('condValue')} value={leaf.value}
        onChange={(event) => onChange({ ...leaf, value: event.target.value })} {...invalid} />}
      {kind === 'enum' && single && <select name="value" aria-label={text('condValue')} value={leaf.list[0] ?? ''} onChange={(event) => onChange({ ...leaf, list: [event.target.value] })}>
        {enumValues(leaf.metric).map((value) => <option key={value} value={value}>{enumValueLabel(value, text)}</option>)}
      </select>}
      {kind === 'enum' && !single && <div className="schedule-days" role="group" aria-label={text('condValue')}>
        {(leaf.metric === 'chat.type' ? CHAT_TYPES : enumValues(leaf.metric)).map((value) => <button key={value} type="button" aria-pressed={leaf.list.includes(value)}
          className={leaf.list.includes(value) ? 'active' : undefined} onClick={() => toggle(value)}>{enumValueLabel(value, text)}</button>)}
      </div>}
      <button type="button" className="schedule-icon-button" aria-label={text('condRemoveRow')} disabled={!removable} onClick={onRemove}><span aria-hidden="true">×</span></button>
    </div>
    {(kind === 'number' || kind === 'enum') && <ErrorLine text={text} error={error} id={errorId} />}
    {leaf.metric === 'chat.keywordHits' && <LeafKeywords text={text} keywords={leaf.keywords} onChange={(keywords) => onChange({ ...leaf, keywords })} error={errors[`${leaf.key}.keywords`]} errorId={keywordsErrorId} />}
    {kind === 'chatId' && <ChatCombobox api={api} text={text} label={text('condChats')} purpose="read" selected={picked} max={single ? 1 : LIST_VALUES_MAX} onChange={onPick} error={error} errorId={errorId} />}
    {kind === 'textContains' && <LeafKeywords text={text} keywords={leaf.list} onChange={(list) => onChange({ ...leaf, list })} error={error} errorId={errorId} />}
  </div>;
}

/** One group of conditions: an all/any switch, its rows and (in a root group only) child groups. A child group holds rows only: two levels at most. */
function ConditionGroup({ api, text, scope, group, onChange, onRemove, canAdd, errors }: {
  api: DesktopApi; text: Text; scope: RuleScope; group: DraftGroup; onChange: (group: DraftGroup) => void; onRemove?: (() => void) | undefined; canAdd: boolean; errors: Errors;
}) {
  const errorId = useId();
  const nested = onRemove !== undefined;
  const setChild = (index: number, child: DraftLeaf | DraftGroup) => onChange({ ...group, children: group.children.map((item, i) => i === index ? child : item) });
  const removeChild = (index: number) => onChange({ ...group, children: group.children.filter((_, i) => i !== index) });
  const mode = (value: 'all' | 'any') => <button type="button" role="radio" aria-checked={group.mode === value} className={group.mode === value ? 'active' : undefined}
    onClick={() => onChange({ ...group, mode: value })}>{text(value === 'all' ? 'condModeAll' : 'condModeAny')}</button>;
  return <div className="schedule-cond-group" {...(nested ? { role: 'group', 'aria-label': text('condSubGroup') } : {})}>
    <div className="schedule-cond-head">
      <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldCondMode')}>{mode('all')}{mode('any')}</div>
      {nested && <button type="button" className="schedule-icon-button" aria-label={text('condRemoveGroup')} onClick={onRemove}><span aria-hidden="true">×</span></button>}
    </div>
    <ErrorLine text={text} error={errors[group.key]} id={errorId} />
    <ul className="schedule-cond-rows">{group.children.map((child, index) => <li key={child.key}>
      {child.type === 'leaf'
        ? <LeafRow api={api} text={text} scope={scope} leaf={child} errors={errors} removable={group.children.length > 1} onChange={(leaf) => setChild(index, leaf)} onRemove={() => removeChild(index)} />
        : <ConditionGroup api={api} text={text} scope={scope} group={child} errors={errors} canAdd={canAdd} onChange={(next) => setChild(index, next)} onRemove={() => removeChild(index)} />}
    </li>)}</ul>
    <div className="schedule-cond-add">
      <button type="button" disabled={!canAdd} onClick={() => onChange({ ...group, children: [...group.children, newLeaf(scope)] })}>{text('condAddRow')}</button>
      {!nested && <button type="button" disabled={!canAdd} onClick={() => onChange({ ...group, children: [...group.children, newGroup(scope, false)] })}>{text('condAddGroup')}</button>}
    </div>
  </div>;
}

const ACTIONS: readonly AgentScheduleRuleAction[] = AGENT_SCHEDULE_RULE_ACTIONS;

/** Editor of a new_messages task: message filter, ordered rules and parameters. `errors` holds the errors to show (empty until the user tries to save or preview). */
export function ScheduleRulesEditor({ api, text, draft, onChange, errors }: {
  api: DesktopApi; text: Text; draft: NewMessagesDraft; onChange: (draft: NewMessagesDraft) => void; errors: Errors;
}) {
  const ids = { perChat: useId(), textChars: useId(), perChatError: useId(), textCharsError: useId(), sendWhenEmpty: useId() };
  const canAdd = countDraftLeaves(draft) < LEAVES_MAX;
  const setRule = (index: number, patch: Partial<DraftRule>) => onChange({ ...draft, rules: draft.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const param = (name: 'maxMessagesPerChat' | 'maxTextChars', id: string, errorId: string, label: Parameters<Text>[0], range: { min: number; max: number }) => <div className="schedule-settings">
    <label htmlFor={id} className="schedule-label">{text(label)}</label>
    <input id={id} name={name} type="number" inputMode="numeric" min={range.min} max={range.max} className="schedule-number" autoComplete="off" value={draft[name]}
      onChange={(event) => onChange({ ...draft, [name]: event.target.value })} {...(errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {})} />
    <ErrorLine text={text} error={errors[name]} id={errorId} />
  </div>;
  return <>
    <fieldset className="schedule-field schedule-rules-section">
      <legend className="schedule-label">{text('fieldMessageFilter')}</legend>
      <p className="schedule-hint">{text('messageFilterHint')}</p>
      {draft.messageFilter
        ? <>
          <ConditionGroup api={api} text={text} scope="message" group={draft.messageFilter} errors={errors} canAdd={canAdd} onChange={(messageFilter) => onChange({ ...draft, messageFilter })} />
          <div><button type="button" onClick={() => onChange({ ...draft, messageFilter: null })}>{text('messageFilterRemove')}</button></div>
        </>
        : <div><button type="button" disabled={!canAdd} onClick={() => onChange({ ...draft, messageFilter: newGroup('message', true) })}>{text('messageFilterAdd')}</button></div>}
    </fieldset>

    <fieldset className="schedule-field schedule-rules-section">
      <legend className="schedule-label">{text('fieldRules')}</legend>
      <p className="schedule-hint">{text('rulesHint')}</p>
      <p className="schedule-hint">{text('rulesLimit', { arg0: RULES_MAX, arg1: LEAVES_MAX })}</p>
      <ol className="schedule-rule-list">
        {draft.rules.map((rule, index) => <li key={rule.key} className="schedule-rule">
          <div role="group" aria-label={text('ruleTitle', { arg0: index + 1 })} className="schedule-rule-body">
            <div className="schedule-rule-head">
              <strong>{text('ruleTitle', { arg0: index + 1 })}</strong>
              <div className="schedule-rule-tools">
                <button type="button" className="schedule-icon-button" aria-label={text('ruleMoveUp', { arg0: index + 1 })} disabled={index === 0}
                  onClick={() => onChange({ ...draft, rules: moveItem(draft.rules, index, -1) })}><span aria-hidden="true">↑</span></button>
                <button type="button" className="schedule-icon-button" aria-label={text('ruleMoveDown', { arg0: index + 1 })} disabled={index === draft.rules.length - 1}
                  onClick={() => onChange({ ...draft, rules: moveItem(draft.rules, index, 1) })}><span aria-hidden="true">↓</span></button>
                <button type="button" className="schedule-icon-button" aria-label={text('ruleRemove', { arg0: index + 1 })}
                  onClick={() => onChange({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}><span aria-hidden="true">×</span></button>
              </div>
            </div>
            <ConditionGroup api={api} text={text} scope="rule" group={rule.when} errors={errors} canAdd={canAdd} onChange={(when) => setRule(index, { when })} />
            <div className="schedule-rule-then">
              <span className="schedule-label">{text('ruleAction')}</span>
              <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('ruleAction')}>
                {ACTIONS.map((action) => <button key={action} type="button" role="radio" aria-checked={rule.then === action} className={rule.then === action ? 'active' : undefined}
                  onClick={() => setRule(index, { then: action })}>{text(ACTION_KEYS[action])}</button>)}
              </div>
            </div>
          </div>
        </li>)}
        <li className="schedule-rule schedule-rule-default">{text('ruleDefault')}</li>
      </ol>
      <div><button type="button" disabled={draft.rules.length >= RULES_MAX || !canAdd} onClick={() => onChange({ ...draft, rules: [...draft.rules, newRule()] })}>{text('ruleAdd')}</button></div>
    </fieldset>

    <div className="schedule-field schedule-rules-section">
      {param('maxMessagesPerChat', ids.perChat, ids.perChatError, 'fieldMaxMessages', PER_CHAT_RANGE)}
      {param('maxTextChars', ids.textChars, ids.textCharsError, 'fieldMaxTextChars', TEXT_CHARS_RANGE)}
      <div className="schedule-settings">
        <span className="schedule-label" id={ids.sendWhenEmpty}>{text('fieldSendWhenEmpty')}</span>
        <button type="button" role="switch" aria-checked={draft.sendWhenEmpty} aria-labelledby={ids.sendWhenEmpty} className="schedule-switch"
          onClick={() => onChange({ ...draft, sendWhenEmpty: !draft.sendWhenEmpty })}><span className="schedule-switch-thumb" /></button>
      </div>
    </div>
  </>;
}

