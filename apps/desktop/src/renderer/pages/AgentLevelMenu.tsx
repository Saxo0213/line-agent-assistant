import { generatedMessageText, useSafeErrorText, useDesktopText } from '../desktop-i18n.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentExecutionLevel, AgentExecutionPolicy, IpcResult } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';

function levels(text: ReturnType<typeof useDesktopText>): Array<{ value: AgentExecutionLevel; label: string; hint: string }> {
  return [
    { value: 'read_only', label: text('readOnly'), hint: text('readFilesOnlyNoEditsOrShellCommands') },
    { value: 'workspace_write', label: text('workspaceWrite'), hint: text('editWorkspaceFilesShellCommandsRequireApproval') },
    { value: 'trust', label: text('trusted'), hint: text('alsoAllowWebToolsShellCommandsRequireApproval') },
    { value: 'full', label: text('fullAccess'), hint: text('runWithoutAsking') },
  ];
}
function resultError(result: IpcResult, safeErrorText: ReturnType<typeof useSafeErrorText>): { code: string; message: string } | null {
  return result.type === 'error' ? { code: result.code, message: safeErrorText(result) } : null;
}

export function AgentLevelMenu({ api, sending = false }: { api: DesktopApi; sending?: boolean }) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const LEVELS = levels(desktopText);
  const order = LEVELS.map(({ value }) => value);
  const [policy, setPolicy] = useState<AgentExecutionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const mutation = useRef(false);
  const reloadPending = useRef(false);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    if (!mounted.current) return;
    setLoading(true);
    try {
      const next = await api.getAgentExecutionPolicy();
      if (mounted.current && seq === sequence.current) setPolicy(next);
    } catch (error) {
      if (mounted.current && seq === sequence.current) setMessage(safeErrorText(error, desktopText('unableToLoadAgentPermissions')));
    } finally {
      if (mounted.current && seq === sequence.current) setLoading(false);
    }
  }, [api, desktopText, safeErrorText]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== 'agentExecutionPolicyChanged') return;
      if (mutation.current) reloadPending.current = true;
      else void load();
    });
    return () => { mounted.current = false; sequence.current += 1; unsubscribe(); };
  }, [api, load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    items.current[order.indexOf(policy?.level ?? 'read_only')]?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, policy?.level]);

  function close() { setOpen(false); trigger.current?.focus(); }

  async function select(level: AgentExecutionLevel) {
    if (!policy || saving || level === policy.level) { close(); return; }
    const target = LEVELS.find((item) => item.value === level)!;
    if (order.indexOf(level) > order.indexOf(policy.level)
      && !window.confirm(desktopText('allowBroaderAgentPermissionsArg0', { arg0: target.label }))) { close(); return; }
    const current = policy;
    mutation.current = true;
    setSaving(true);
    setMessage('');
    close();
    try {
      const failure = resultError(await api.setAgentExecutionPolicy({ level, approvalTimeoutSeconds: current.approvalTimeoutSeconds, timeoutAction: current.timeoutAction, expectedVersion: current.version }), safeErrorText);
      if (failure?.code === 'PERMISSION_VERSION_CONFLICT') {
        await load();
        if (mounted.current) setMessage(desktopText('settingsChangedElsewhereAndHaveBeenReloaded'));
      } else if (failure && mounted.current) setMessage(safeErrorText(failure));
      else await load();
    } catch (error) {
      if (mounted.current) setMessage(safeErrorText(error, desktopText('unableToUpdateAgentPermissions')));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
      if (reloadPending.current) { reloadPending.current = false; void load(); }
    }
  }

  const current = LEVELS.find((item) => item.value === policy?.level);
  return <div className="agent-level-menu" ref={root}>
    <button ref={trigger} type="button" className="agent-level-trigger" aria-haspopup="menu" aria-expanded={open}
      disabled={loading || saving || sending} onClick={() => setOpen((value) => !value)}>
      {desktopText('permissions')}{current?.label ?? desktopText('loading')}
    </button>
    {open && <div className="agent-level-options" role="menu" aria-label={desktopText('agentPermissionLevel')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = items.current.findIndex((item) => item === document.activeElement);
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + LEVELS.length) % LEVELS.length;
      items.current[next]?.focus();
    }}>
      {LEVELS.map((item, index) => <button key={item.value} ref={(element) => { items.current[index] = element; }} type="button"
        role="menuitemradio" aria-checked={policy?.level === item.value} onClick={() => void select(item.value)}>
        <span>{item.label}</span><small>{item.hint}</small>
      </button>)}
    </div>}
    {message && <span className="agent-level-status" role="status">{generatedMessageText(message)}</span>}
  </div>;
}
