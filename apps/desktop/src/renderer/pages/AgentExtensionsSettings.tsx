import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AGENT_MCP_RESERVED_NAME, AGENT_MCP_RESERVED_PREFIX, agentExtensionToolsGrantedByLevel,
  type AgentExtensionTools, type AgentExtensionsState, type AgentMcpImportCandidate, type AgentMcpImportListing, type AgentMcpImportResult,
  type AgentMcpServerInput, type AgentMcpServerSummary, type AgentExecutionLevel,
} from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { extensionsTextFor, type ExtensionsCopyKey } from '../../desktop-extensions-copy.js';
import { useDesktopLocale } from '../desktop-i18n.js';

type Text = (key: ExtensionsCopyKey, values?: Record<string, unknown>) => string;
type Provider = 'claude' | 'codex';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const SOURCE_LABEL = { manual: 'sourceManual', 'claude-code': 'sourceClaudeCode', 'claude-desktop': 'sourceClaudeDesktop', codex: 'sourceCodex' } as const satisfies Record<string, ExtensionsCopyKey>;
const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** Same dialog conventions as the other Settings dialogs: focus on open, Tab trapped, Esc closes, focus returns to the opener. */
function useDialog(onClose: () => void, busy: boolean) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    const target = opener.current as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input:not(:disabled), button:not(:disabled)');
    first?.focus();
    return () => { target?.focus?.(); };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) closeRef.current(); return; }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')).filter((item) => !item.hasAttribute('disabled') && item.getAttribute('tabindex') !== '-1');
    if (items.length === 0) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !ref.current.contains(active))) { event.preventDefault(); first.focus(); }
  };
  return { ref, onKeyDown };
}

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange?: (next: boolean) => void }) {
  return <button type="button" role="switch" className="schedule-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange?.(!checked)}><span className="schedule-switch-thumb" aria-hidden="true" /></button>;
}

// ---------------------------------------------------------------- add / edit dialog

interface Pair { key: string; value: string; stored: boolean }
export interface FormState {
  name: string; transport: 'stdio' | 'http'; providers: Record<Provider, boolean>; command: string; args: string; env: Pair[];
  url: string; headers: Pair[]; enabled: boolean;
}
interface PairError { key?: ExtensionsCopyKey; value?: ExtensionsCopyKey }
interface FormErrors { name?: ExtensionsCopyKey; command?: ExtensionsCopyKey; url?: ExtensionsCopyKey; providers?: ExtensionsCopyKey; env: Record<number, PairError>; headers: Record<number, PairError> }

function initialForm(server: AgentMcpServerSummary | null): FormState {
  if (!server) return { name: '', transport: 'stdio', providers: { claude: true, codex: true }, command: '', args: '', env: [], url: '', headers: [], enabled: true };
  return {
    name: server.name, transport: server.transport, providers: { claude: server.providers.includes('claude'), codex: server.providers.includes('codex') },
    command: server.command ?? '', args: server.args.join('\n'), env: Object.keys(server.env).map((key) => ({ key, value: '', stored: true })),
    url: server.url ?? '', headers: Object.keys(server.headers).map((key) => ({ key, value: '', stored: true })), enabled: server.enabled,
  };
}

function validPairs(pairs: Pair[], pattern: RegExp, keyError: ExtensionsCopyKey, header: boolean): Record<number, PairError> {
  const errors: Record<number, PairError> = {};
  const seen = new Set<string>();
  pairs.forEach((pair, index) => {
    const error: PairError = {};
    const key = header ? pair.key.trim().toLowerCase() : pair.key.trim();
    if (!pattern.test(pair.key.trim())) error.key = keyError;
    else if (seen.has(key)) error.key = 'errKeyDuplicate';
    seen.add(key);
    if (pair.value === '' && !pair.stored) error.value = 'errValueRequired';
    else if (header && /[\r\n]/.test(pair.value)) error.value = 'errValueLine';
    if (error.key || error.value) errors[index] = error;
  });
  return errors;
}

export function validateServerForm(form: FormState): FormErrors {
  const errors: FormErrors = { env: {}, headers: {} };
  const name = form.name.trim();
  if (name === AGENT_MCP_RESERVED_NAME || name.startsWith(AGENT_MCP_RESERVED_PREFIX)) errors.name = 'errNameReserved';
  else if (!NAME_PATTERN.test(name)) errors.name = 'errNameInvalid';
  if (!form.providers.claude && !form.providers.codex) errors.providers = 'errProviderRequired';
  if (form.transport === 'stdio') {
    if (form.command.trim() === '') errors.command = 'errCommandRequired';
    errors.env = validPairs(form.env, ENV_KEY_PATTERN, 'errKeyInvalid', false);
  } else {
    try { const url = new URL(form.url.trim()); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol'); }
    catch { errors.url = 'errUrlInvalid'; }
    errors.headers = validPairs(form.headers, HEADER_KEY_PATTERN, 'errHeaderInvalid', true);
  }
  return errors;
}
const hasErrors = (errors: FormErrors) => !!(errors.name || errors.command || errors.url || errors.providers || Object.keys(errors.env).length || Object.keys(errors.headers).length);

export function buildServerInput(form: FormState, id: string | undefined): AgentMcpServerInput {
  const pairs = (list: Pair[]) => Object.fromEntries(list.map((pair) => [pair.key.trim(), pair.value]));
  return {
    ...(id ? { id } : {}), name: form.name.trim(), transport: form.transport, enabled: form.enabled,
    providers: (['claude', 'codex'] as const).filter((provider) => form.providers[provider]),
    args: form.transport === 'stdio' ? form.args.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== '') : [],
    env: form.transport === 'stdio' ? pairs(form.env) : {},
    headers: form.transport === 'http' ? pairs(form.headers) : {},
    ...(form.transport === 'stdio' ? { command: form.command.trim() } : { url: form.url.trim() }),
  };
}

function PairEditor({ legend, pairs, errors, header, text, onChange }: {
  legend: string; pairs: Pair[]; errors: Record<number, PairError>; header: boolean; text: Text; onChange: (next: Pair[]) => void;
}) {
  const baseId = useId();
  return <fieldset className="schedule-field extension-pairs">
    <legend className="schedule-label">{legend}</legend>
    {pairs.map((pair, index) => {
      const error = errors[index];
      const keyId = `${baseId}-k${index}`; const valueId = `${baseId}-v${index}`;
      return <div className="extension-pair" key={index}>
        <div className="extension-pair-field">
          <label htmlFor={keyId} className="sr-only">{text('keyLabel')}</label>
          <input id={keyId} name={`${header ? 'header' : 'env'}-key-${index}`} autoComplete="off" spellCheck={false} value={pair.key} placeholder={text('keyLabel')} readOnly={pair.stored}
            aria-invalid={error?.key ? true : undefined} aria-describedby={error?.key ? `${keyId}-e` : undefined}
            onChange={(event) => onChange(pairs.map((item, position) => position === index ? { ...item, key: event.target.value } : item))} />
          {error?.key && <p id={`${keyId}-e`} role="alert" className="schedule-error">{text(error.key)}</p>}
        </div>
        <div className="extension-pair-field">
          <label htmlFor={valueId} className="sr-only">{text('valueLabel')}</label>
          <input id={valueId} name={`${header ? 'header' : 'env'}-value-${index}`} type="password" autoComplete="new-password" spellCheck={false} value={pair.value}
            placeholder={pair.stored ? text('keepValue') : text('valueLabel')}
            aria-invalid={error?.value ? true : undefined} aria-describedby={error?.value ? `${valueId}-e` : undefined}
            onChange={(event) => onChange(pairs.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} />
          {error?.value && <p id={`${valueId}-e`} role="alert" className="schedule-error">{text(error.value)}</p>}
        </div>
        <button type="button" aria-label={text('removePair', { arg0: pair.key || String(index + 1) })} onClick={() => onChange(pairs.filter((_item, position) => position !== index))}>×</button>
      </div>;
    })}
    <div><button type="button" onClick={() => onChange([...pairs, { key: '', value: '', stored: false }])}>{text('addPair')}</button></div>
  </fieldset>;
}

function ServerDialog({ server, text, existingNames, onSave, onClose }: {
  server: AgentMcpServerSummary | null; text: Text; existingNames: string[];
  onSave: (input: AgentMcpServerInput) => Promise<{ ok: true } | { ok: false; field?: 'name'; message: ExtensionsCopyKey }>; onClose: () => void;
}) {
  const [form, setForm] = useState(() => initialForm(server));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ field?: 'name'; message: ExtensionsCopyKey } | null>(null);
  const savingRef = useRef(false);
  const dialog = useDialog(onClose, saving);
  const ids = { heading: useId(), name: useId(), nameHint: useId(), nameError: useId(), command: useId(), commandError: useId(), args: useId(), url: useId(), urlError: useId(), providersError: useId() };
  const errors = useMemo(() => validateServerForm(form), [form]);
  const nameTaken = existingNames.includes(form.name.trim()) && form.name.trim() !== server?.name;
  const visible: FormErrors = attempted ? { ...errors, ...(errors.name || !nameTaken ? {} : { name: 'errNameTaken' as const }) } : { env: {}, headers: {} };
  const update = (patch: Partial<FormState>) => { setForm((current) => ({ ...current, ...patch })); setFailure(null); };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    setAttempted(true);
    if (hasErrors(errors) || nameTaken) {
      window.setTimeout(() => dialog.ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    savingRef.current = true; setSaving(true); setFailure(null);
    try {
      const result = await onSave(buildServerInput(form, server?.id));
      if (!result.ok) {
        setFailure(result);
        if (result.field === 'name') window.setTimeout(() => document.getElementById(ids.name)?.focus(), 0);
      }
    } finally { savingRef.current = false; setSaving(false); }
  }

  const nameError = visible.name ?? (failure?.field === 'name' ? failure.message : undefined);
  return <div className="modal-scrim" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog.ref} className="modal schedule-dialog extension-dialog" role="dialog" aria-modal="true" aria-labelledby={ids.heading} onKeyDown={dialog.onKeyDown}>
      <form className="schedule-form" onSubmit={(event) => void submit(event)} noValidate>
        <h2 id={ids.heading} className="schedule-header">{server ? text('dialogEditTitle') : text('dialogAddTitle')}</h2>
        <div className="schedule-body">
          <div className="schedule-field">
            <label htmlFor={ids.name} className="schedule-label">{text('fieldName')}</label>
            <input id={ids.name} name="name" data-autofocus autoComplete="off" spellCheck={false} maxLength={40} value={form.name} onChange={(event) => update({ name: event.target.value })}
              aria-invalid={nameError ? true : undefined} aria-describedby={`${ids.nameHint}${nameError ? ` ${ids.nameError}` : ''}`} />
            <p id={ids.nameHint} className="schedule-hint">{text('nameHint')}</p>
            {nameError && <p id={ids.nameError} role="alert" className="schedule-error">{text(nameError)}</p>}
          </div>
          <fieldset className="schedule-field">
            <legend className="schedule-label">{text('fieldTransport')}</legend>
            <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldTransport')}>
              {(['stdio', 'http'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={form.transport === value} className={form.transport === value ? 'active' : undefined}
                onClick={() => update({ transport: value })}>{text(value === 'stdio' ? 'transportStdio' : 'transportHttp')}</button>)}
            </div>
          </fieldset>
          <fieldset className="schedule-field">
            <legend className="schedule-label">{text('fieldProviders')}</legend>
            <div className="extension-providers">
              {(['claude', 'codex'] as const).map((provider) => <label key={provider} className="schedule-enabled"><input type="checkbox" name={`provider-${provider}`} checked={form.providers[provider]}
                aria-invalid={visible.providers ? true : undefined} aria-describedby={visible.providers ? ids.providersError : undefined}
                onChange={(event) => update({ providers: { ...form.providers, [provider]: event.target.checked } })} />{PROVIDER_LABEL[provider]}</label>)}
            </div>
            {visible.providers && <p id={ids.providersError} role="alert" className="schedule-error">{text(visible.providers)}</p>}
          </fieldset>
          {form.transport === 'stdio' ? <>
            <div className="schedule-field">
              <label htmlFor={ids.command} className="schedule-label">{text('fieldCommand')}</label>
              <input id={ids.command} name="command" autoComplete="off" spellCheck={false} className="schedule-mono" value={form.command} onChange={(event) => update({ command: event.target.value })}
                aria-invalid={visible.command ? true : undefined} aria-describedby={visible.command ? ids.commandError : undefined} />
              {visible.command && <p id={ids.commandError} role="alert" className="schedule-error">{text(visible.command)}</p>}
            </div>
            <div className="schedule-field">
              <label htmlFor={ids.args} className="schedule-label">{text('fieldArgs')}</label>
              <textarea id={ids.args} name="args" rows={3} spellCheck={false} className="schedule-mono" value={form.args} onChange={(event) => update({ args: event.target.value })} />
            </div>
            <PairEditor legend={text('fieldEnv')} pairs={form.env} errors={visible.env} header={false} text={text} onChange={(env) => update({ env })} />
          </> : <>
            <div className="schedule-field">
              <label htmlFor={ids.url} className="schedule-label">{text('fieldUrl')}</label>
              <input id={ids.url} name="url" type="url" inputMode="url" autoComplete="off" spellCheck={false} className="schedule-mono" value={form.url} placeholder="https://" onChange={(event) => update({ url: event.target.value })}
                aria-invalid={visible.url ? true : undefined} aria-describedby={visible.url ? ids.urlError : undefined} />
              {visible.url && <p id={ids.urlError} role="alert" className="schedule-error">{text(visible.url)}</p>}
            </div>
            <PairEditor legend={text('fieldHeaders')} pairs={form.headers} errors={visible.headers} header text={text} onChange={(headers) => update({ headers })} />
          </>}
          <p className="schedule-hint">{text('secretNote')} {form.transport === 'stdio' ? text('argsNote') : ''}</p>
          <label className="schedule-enabled"><input type="checkbox" name="enabled" checked={form.enabled} onChange={(event) => update({ enabled: event.target.checked })} />{text('fieldEnabled')}</label>
          {failure && !failure.field && <p role="alert" className="schedule-error">{text(failure.message)}</p>}
        </div>
        <div className="modal-actions schedule-footer">
          <button type="button" disabled={saving} onClick={onClose}>{text('cancel')}</button>
          <button type="submit" className="primary" disabled={saving}>{saving ? text('saving') : text('save')}</button>
        </div>
      </form>
    </section>
  </div>;
}

// ---------------------------------------------------------------- delete confirmation

function DeleteDialog({ server, text, busy, failed, onConfirm, onClose }: { server: AgentMcpServerSummary; text: Text; busy: boolean; failed: boolean; onConfirm: () => void; onClose: () => void }) {
  const dialog = useDialog(onClose, busy);
  const heading = useId(); const body = useId();
  return <div className="modal-scrim" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog.ref} className="modal" role="alertdialog" aria-modal="true" aria-labelledby={heading} aria-describedby={body} onKeyDown={dialog.onKeyDown}>
      <h2 id={heading}>{text('deleteTitle', { arg0: server.name })}</h2>
      <p id={body}>{text('deleteBody')}</p>
      {failed && <p role="alert" className="schedule-error">{text('actionFailed')}</p>}
      <div className="modal-actions">
        <button type="button" data-autofocus disabled={busy} onClick={onClose}>{text('cancel')}</button>
        <button type="button" className="primary schedule-danger" disabled={busy} onClick={onConfirm}>{text('delete')}</button>
      </div>
    </section>
  </div>;
}

// ---------------------------------------------------------------- import dialog

const ISSUE_TEXT = { UNSUPPORTED_TRANSPORT: 'issueUnsupportedTransport', UNSUPPORTED_AUTH: 'issueUnsupportedAuth', INVALID_DEFINITION: 'issueInvalid', RESERVED_NAME: 'issueReserved' } as const satisfies Record<string, ExtensionsCopyKey>;
const SOURCE_ERROR_TEXT = { INVALID_FORMAT: 'importSourceInvalid', READ_FAILED: 'importSourceUnreadable' } as const satisfies Record<string, ExtensionsCopyKey>;
const selectionKey = (source: string, sourceName: string) => `${source}\u0000${sourceName}`;

function ImportDialog({ api, text, onImported, onClose }: { api: DesktopApi; text: Text; onImported: () => void; onClose: () => void }) {
  const [listing, setListing] = useState<AgentMcpImportListing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AgentMcpImportResult | 'failed' | null>(null);
  const busyRef = useRef(false);
  const dialog = useDialog(onClose, busy);
  const heading = useId();
  const load = useCallback(() => {
    setListing(null); setLoadFailed(false);
    api.listAgentMcpImportCandidates().then(setListing, () => setLoadFailed(true));
  }, [api]);
  useEffect(load, [load]);
  const importable = (candidate: AgentMcpImportCandidate) => !candidate.issue && !candidate.nameTaken;
  const toggle = (candidate: AgentMcpImportCandidate, checked: boolean) => setSelected((current) => {
    const next = new Set(current); const key = selectionKey(candidate.source, candidate.sourceName);
    if (checked) next.add(key); else next.delete(key);
    return next;
  });
  async function submit() {
    if (busyRef.current || selected.size === 0 || !listing) return;
    busyRef.current = true; setBusy(true);
    try {
      const items = listing.sources.flatMap((source) => source.candidates.filter((candidate) => selected.has(selectionKey(candidate.source, candidate.sourceName)))
        .map((candidate) => ({ source: candidate.source, sourceName: candidate.sourceName })));
      const result = await api.importAgentMcpServers(items);
      if (result.type === 'importAgentMcpServers') { setOutcome(result.result); onImported(); } else setOutcome('failed');
    } catch { setOutcome('failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const sourceTitle = (source: keyof typeof SOURCE_LABEL) => text(SOURCE_LABEL[source]);
  const anyCandidates = listing?.sources.some((source) => source.candidates.length > 0) ?? false;
  return <div className="modal-scrim" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog.ref} className="modal schedule-dialog extension-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} onKeyDown={dialog.onKeyDown}>
      <h2 id={heading} className="schedule-header">{text('importTitle')}</h2>
      <div className="schedule-body">
        <p className="schedule-hint">{text('importIntro')}</p>
        {outcome === null && !listing && !loadFailed && <p role="status" className="muted">{text('importLoading')}</p>}
        {outcome === null && loadFailed && <div role="alert" className="schedule-error">{text('loadFailed')} <button type="button" onClick={load}>{text('retry')}</button></div>}
        {outcome === null && listing && <>
          {!anyCandidates && <p role="status" className="muted">{text('importNoneFound')}</p>}
          {listing.sources.map((source) => <fieldset className="extension-import-source" key={source.source}>
            <legend className="schedule-label">{sourceTitle(source.source)}</legend>
            {source.status === 'missing' && <p className="muted">{text('importSourceMissing')}</p>}
            {source.status === 'error' && <p role="alert" className="schedule-error">{text(SOURCE_ERROR_TEXT[source.error ?? 'READ_FAILED'])}</p>}
            {source.candidates.map((candidate) => {
              const key = selectionKey(candidate.source, candidate.sourceName);
              const reason = candidate.issue ? text(ISSUE_TEXT[candidate.issue]) : candidate.nameTaken ? text('importNameTaken') : '';
              const detail = candidate.transport === 'stdio' ? [candidate.command, ...candidate.args].filter(Boolean).join(' ') : candidate.url ?? '';
              return <label className="extension-candidate" key={key}>
                <input type="checkbox" checked={selected.has(key)} disabled={!importable(candidate) || busy} onChange={(event) => toggle(candidate, event.target.checked)} />
                <span className="extension-candidate-body">
                  <strong>{candidate.name}</strong>
                  <span className="badge">{candidate.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
                  {detail && <code className="extension-detail">{detail}</code>}
                  {candidate.envKeys.length > 0 && <small className="muted">{text('importEnvKeys', { arg0: candidate.envKeys.join(', ') })}</small>}
                  {candidate.headerKeys.length > 0 && <small className="muted">{text('importHeaderKeys', { arg0: candidate.headerKeys.join(', ') })}</small>}
                  {reason && <small className="schedule-error">{reason}</small>}
                </span>
              </label>;
            })}
          </fieldset>)}
        </>}
        {outcome === 'failed' && <p role="alert" className="schedule-error">{text('actionFailed')}</p>}
        {outcome && outcome !== 'failed' && <div role="status">
          <p>{outcome.imported.length > 0 ? text('importDoneImported', { arg0: outcome.imported.join(', ') }) : text('importNothing')}</p>
          {outcome.skipped.length > 0 && <p className="muted">{text('importDoneSkipped', { arg0: outcome.skipped.map((item) => item.sourceName).join(', ') })}</p>}
        </div>}
      </div>
      <div className="modal-actions schedule-footer">
        {outcome && outcome !== 'failed'
          ? <button type="button" className="primary" onClick={onClose}>{text('done')}</button>
          : <>
            <button type="button" disabled={busy} onClick={onClose}>{text('cancel')}</button>
            <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={() => void submit()}>{text('importSelected')}</button>
          </>}
      </div>
    </section>
  </div>;
}

// ---------------------------------------------------------------- section

type ToolKey = keyof AgentExtensionTools;
const TOOL_ROWS: Array<{ key: ToolKey; label: ExtensionsCopyKey; description: ExtensionsCopyKey }> = [
  { key: 'webSearch', label: 'toolWebSearch', description: 'toolWebSearchDesc' },
  { key: 'webFetch', label: 'toolWebFetch', description: 'toolWebFetchDesc' },
  { key: 'bash', label: 'toolBash', description: 'toolBashDesc' },
  { key: 'fileRead', label: 'toolFileRead', description: 'toolFileReadDesc' },
  { key: 'fileWrite', label: 'toolFileWrite', description: 'toolFileWriteDesc' },
];

export function AgentExtensionsSettings({ api }: { api: DesktopApi }) {
  const locale = useDesktopLocale();
  const text: Text = useCallback((key, values) => extensionsTextFor(locale, key, values), [locale]);
  const [state, setState] = useState<AgentExtensionsState | null>(null);
  const [level, setLevel] = useState<AgentExecutionLevel | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<ExtensionsCopyKey | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'edit'; server: AgentMcpServerSummary | null } | { kind: 'import' } | { kind: 'delete'; server: AgentMcpServerSummary } | null>(null);
  const [deleteState, setDeleteState] = useState<{ busy: boolean; failed: boolean }>({ busy: false, failed: false });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const mounted = useRef(true);
  const headingId = useId(); const noteId = useId();

  const load = useCallback(async () => {
    try {
      const next = await api.getAgentExtensions();
      if (mounted.current) { setState(next); setLoadFailed(false); }
    } catch { if (mounted.current) setLoadFailed(true); }
  }, [api]);
  const loadLevel = useCallback(() => {
    if (typeof api.getAgentExecutionPolicy !== 'function') return;
    api.getAgentExecutionPolicy().then((policy) => { if (mounted.current) setLevel(policy.level); }, () => undefined);
  }, [api]);
  useEffect(() => {
    mounted.current = true; void load(); loadLevel();
    const unsubscribe = api.onEvent?.((event) => { if (event.type === 'agentExecutionPolicyChanged') loadLevel(); });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [api, load, loadLevel]);

  const granted = agentExtensionToolsGrantedByLevel(level ?? 'read_only');

  async function save(input: AgentMcpServerInput) {
    try {
      const result = await api.saveAgentMcpServer(input);
      if (result.type === 'saveAgentMcpServer') { setDialog(null); setNotice(null); await load(); return { ok: true as const }; }
      if (result.type === 'error') {
        if (result.code === 'AGENT_EXTENSION_NAME_TAKEN') return { ok: false as const, field: 'name' as const, message: 'errNameTaken' as const };
        if (result.code === 'AGENT_EXTENSION_LIMIT') return { ok: false as const, message: 'errLimit' as const };
        if (result.code === 'AGENT_EXTENSION_NOT_FOUND') return { ok: false as const, message: 'errNotFound' as const };
      }
    } catch { /* falls through to the generic message */ }
    return { ok: false as const, message: 'actionFailed' as const };
  }

  async function setEnabled(server: AgentMcpServerSummary, enabled: boolean) {
    setPendingId(server.id); setNotice(null);
    try {
      const result = await api.setAgentMcpServerEnabled(server.id, enabled);
      if (result.type !== 'setAgentMcpServerEnabled') setNotice('actionFailed');
    } catch { setNotice('actionFailed'); }
    finally { if (mounted.current) setPendingId(null); await load(); }
  }

  async function setTool(key: ToolKey, value: boolean) {
    if (!state) return;
    const previous = state.tools;
    setState({ ...state, tools: { ...state.tools, [key]: value } });
    setNotice(null);
    try {
      const result = await api.setAgentExtensionTools({ ...previous, [key]: value });
      if (result.type !== 'setAgentExtensionTools') throw new Error('rejected');
      if (mounted.current) setState((current) => current ? { ...current, tools: result.tools } : current);
    } catch { if (mounted.current) { setState((current) => current ? { ...current, tools: previous } : current); setNotice('actionFailed'); } }
  }

  async function confirmDelete(server: AgentMcpServerSummary) {
    setDeleteState({ busy: true, failed: false });
    try {
      const result = await api.deleteAgentMcpServer(server.id);
      if (result.type === 'deleteAgentMcpServer' || (result.type === 'error' && result.code === 'AGENT_EXTENSION_NOT_FOUND')) { setDialog(null); setDeleteState({ busy: false, failed: false }); await load(); return; }
    } catch { /* shown below */ }
    setDeleteState({ busy: false, failed: true });
  }

  const servers = state?.servers ?? [];
  return <section className="panel agent-extensions-settings" aria-labelledby={headingId} aria-describedby={noteId}>
    <div className="panel-top">
      <div><h2 id={headingId}>{text('heading')}</h2><p id={noteId}>{text('note')}</p></div>
      <div className="button-row extension-header-actions">
        <button type="button" disabled={!state} onClick={() => setDialog({ kind: 'import' })}>{text('importLocal')}</button>
        <button type="button" className="primary" disabled={!state} onClick={() => setDialog({ kind: 'edit', server: null })}>{text('addManual')}</button>
      </div>
    </div>
    {notice && <p role="alert" className="schedule-error">{text(notice)}</p>}
    {!state && !loadFailed && <p role="status" className="muted">{text('loading')}</p>}
    {loadFailed && <div role="alert" className="schedule-error">{text('loadFailed')} <button type="button" onClick={() => void load()}>{text('retry')}</button></div>}
    {state && <>
      {servers.length === 0
        ? <p className="muted">{text('emptyList')}</p>
        : <ul className="extension-list" aria-label={text('listLabel')}>
          {servers.map((server) => <li className="extension-row" key={server.id}>
            <div className="extension-row-main">
              <div className="extension-row-title"><strong>{server.name}</strong>
                <span className="badge">{text(SOURCE_LABEL[server.source])}</span>
                <span className="badge">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
              </div>
              <small className="muted">{text('appliesTo', { arg0: server.providers.map((provider) => PROVIDER_LABEL[provider]).join(' / ') })}</small>
            </div>
            <div className="extension-row-actions">
              <Switch checked={server.enabled} label={text('enableServer', { arg0: server.name })} disabled={pendingId === server.id} onChange={(next) => void setEnabled(server, next)} />
              <button type="button" aria-label={text('editServer', { arg0: server.name })} onClick={() => setDialog({ kind: 'edit', server })}>{text('edit')}</button>
              <button type="button" aria-label={text('deleteServer', { arg0: server.name })} onClick={() => { setDeleteState({ busy: false, failed: false }); setDialog({ kind: 'delete', server }); }}>{text('delete')}</button>
            </div>
          </li>)}
        </ul>}
      <div className="extension-tools">
        <h3>{text('toolsTitle')}</h3>
        <p className="schedule-hint">{text('toolsNote')}</p>
        {TOOL_ROWS.map((row) => {
          const byLevel = granted[row.key] && row.key !== 'webSearch';
          const labelId = `extension-tool-${row.key}`;
          return <div className="extension-tool-row" key={row.key}>
            <div className="extension-tool-text">
              <span id={labelId}>{text(row.label)}</span>
              <small className="muted">{byLevel ? text('levelGranted') : text(row.description)}{row.key === 'webSearch' && granted.webSearch ? ` ${text('toolWebSearchLevel')}` : ''}</small>
            </div>
            <Switch checked={byLevel || state.tools[row.key]} label={text(row.label)} disabled={byLevel} onChange={(next) => void setTool(row.key, next)} />
          </div>;
        })}
        <div className="extension-tool-row">
          <div className="extension-tool-text">
            <span id="extension-connector">{text('connectorTitle')} <span className="badge">{text('connectorUnavailable')}</span></span>
            <small className="muted">{text('connectorDesc')} {text('connectorReason')}</small>
          </div>
          <Switch checked={false} label={text('connectorTitle')} disabled />
        </div>
      </div>
    </>}
    {dialog?.kind === 'edit' && <ServerDialog server={dialog.server} text={text} existingNames={servers.map((server) => server.name)} onSave={save} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'import' && <ImportDialog api={api} text={text} onImported={() => void load()} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'delete' && <DeleteDialog server={dialog.server} text={text} busy={deleteState.busy} failed={deleteState.failed} onConfirm={() => void confirmDelete(dialog.server)} onClose={() => setDialog(null)} />}
  </section>;
}
