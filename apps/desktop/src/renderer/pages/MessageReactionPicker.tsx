import React, { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import type { WritableConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { TimelineMessage } from '../../main/service-facade.js';
import { LINE_REACTION_GLYPHS } from '../AgentStatusMarker.js';
import { safeErrorTextFor, useDesktopLocale, useExtraText } from '../desktop-i18n.js';

type ManualReaction = 'NICE' | 'LOVE' | 'FUN' | 'AMAZING' | 'SAD' | 'OMG';
const CHOICES = [
  ['NICE', 'reactionNice'], ['LOVE', 'reactionLove'], ['FUN', 'reactionFun'],
  ['AMAZING', 'reactionAmazing'], ['SAD', 'reactionSad'], ['OMG', 'reactionOmg'],
] as const satisfies ReadonlyArray<readonly [ManualReaction, string]>;

/**
 * A small reaction button of one message. It opens the six predefined LINE reactions (the same artwork as the reaction pills).
 * A click on the reaction that the account already has sends UNDO. A failure shows its text next to the button.
 */
export function MessageReactionPicker({ api, route, message }: {
  api: DesktopApi; route: WritableConversationKey; message: Pick<TimelineMessage, 'messageId' | 'reactions'>;
}) {
  const locale = useDesktopLocale();
  const extra = useExtraText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The own reaction after a click that succeeded. The stored reaction list may arrive later, so it takes over when its own reaction changes.
  const [ownOverride, setOwnOverride] = useState<ManualReaction | null | undefined>(undefined);
  const root = useRef<HTMLSpanElement>(null);
  const storedOwn = message.reactions?.find((reaction) => reaction.own === true && reaction.kind !== 'PAID')?.kind ?? null;
  useEffect(() => { setOwnOverride(undefined); }, [storedOwn]);
  const own = ownOverride !== undefined ? ownOverride : (storedOwn as ManualReaction | null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function choose(kind: ManualReaction) {
    if (busy || !api.reactMessage) return;
    setOpen(false); setBusy(true); setError(null);
    const reaction = own === kind ? 'UNDO' as const : kind;
    try {
      const result = await api.reactMessage(route, message.messageId, reaction);
      if (result.ok) setOwnOverride(reaction === 'UNDO' ? null : kind);
      else setError(safeErrorTextFor(locale, result, extra('reactionFailed')));
    } catch (failure) {
      setError(safeErrorTextFor(locale, failure, extra('reactionFailed')));
    } finally { setBusy(false); }
  }

  return <span className={`reaction-picker${open ? ' open' : ''}`} ref={root}
    onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="reply-action reaction-action" aria-haspopup="menu" aria-expanded={open} disabled={busy}
      aria-label={extra('reactionButton')} title={extra('reactionButton')} onClick={() => { setError(null); setOpen((value) => !value); }}>
      <Smile size={16} aria-hidden="true" /></button>
    {open && <span role="menu" className="reaction-menu" aria-label={extra('reactionButton')}>
      {CHOICES.map(([kind, copyKey]) => <button type="button" role="menuitem" key={kind} className="reaction-choice" aria-pressed={own === kind}
        aria-label={extra(copyKey)} title={extra(copyKey)} onClick={() => void choose(kind)}>
        <span className="message-reaction-icon" aria-hidden="true">{LINE_REACTION_GLYPHS[kind]}</span>
      </button>)}
    </span>}
    {error && <span role="alert" className="message-reaction-error">{error}</span>}
  </span>;
}
