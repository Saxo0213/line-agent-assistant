import React, { useEffect, useState } from 'react';
import { AGENT_PERSONA_MAX_LENGTH, type AgentLiveliness } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopText, useSafeErrorText } from '../desktop-i18n.js';

const LEVELS: ReadonlyArray<{ value: AgentLiveliness; label: 'personaLivelinessQuiet' | 'personaLivelinessNormal' | 'personaLivelinessLively' }> = [
  { value: 'quiet', label: 'personaLivelinessQuiet' },
  { value: 'normal', label: 'personaLivelinessNormal' },
  { value: 'lively', label: 'personaLivelinessLively' },
];

/** Settings > Assistant: the global Agent persona (docs/architecture/agent-persona.md). */
export function AgentPersonaSettings({ api }: { api: DesktopApi }) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const [description, setDescription] = useState('');
  const [liveliness, setLiveliness] = useState<AgentLiveliness>('normal');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (typeof api.getAgentPersona !== 'function') return;
    let live = true;
    void api.getAgentPersona().then((persona) => {
      if (!live) return;
      setDescription(persona.description); setLiveliness(persona.liveliness); setLoaded(true);
    }).catch((error: unknown) => { if (live) setMessage(safeErrorText(error, desktopText('personaLoadFailed'))); });
    return () => { live = false; };
  }, [api, desktopText, safeErrorText]);

  if (typeof api.getAgentPersona !== 'function') return null;

  async function save() {
    setBusy(true); setMessage('');
    try {
      const saved = await api.setAgentPersona({ description: description.trim(), liveliness });
      setDescription(saved.description); setLiveliness(saved.liveliness); setMessage(desktopText('personaSaved'));
    } catch (error) { setMessage(safeErrorText(error, desktopText('personaSaveFailed'))); }
    finally { setBusy(false); }
  }

  return <section className="panel agent-persona-settings" aria-labelledby="agent-persona-title">
    <div className="panel-top"><div><h2 id="agent-persona-title">{desktopText('personaTitle')}</h2><p>{desktopText('personaIntro')}</p></div>
      <button className="primary" disabled={busy || !loaded || description.length > AGENT_PERSONA_MAX_LENGTH} onClick={() => void save()}>{desktopText('personaSave')}</button></div>
    <label>{desktopText('personaDescriptionLabel')}
      <textarea aria-label={desktopText('personaDescriptionLabel')} value={description} maxLength={AGENT_PERSONA_MAX_LENGTH} rows={4}
        placeholder={desktopText('personaDescriptionPlaceholder')} disabled={!loaded} onChange={(event) => setDescription(event.target.value)} />
      <small>{desktopText('personaCount', { arg0: String(description.length), arg1: String(AGENT_PERSONA_MAX_LENGTH) })}</small>
    </label>
    <fieldset className="agent-persona-liveliness" disabled={!loaded || busy}>
      <legend>{desktopText('personaLivelinessLabel')}</legend>
      {LEVELS.map((level) => <label key={level.value}>
        <input type="radio" name="agent-persona-liveliness" value={level.value} checked={liveliness === level.value} onChange={() => setLiveliness(level.value)} />
        {desktopText(level.label)}</label>)}
      <p>{desktopText('personaLivelinessHelp')}</p>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </section>;
}
