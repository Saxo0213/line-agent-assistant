import { desktopTextFor, useDesktopLocale, useDesktopText } from './desktop-i18n.js';
import type { Locale } from '../locale.js';
import React from 'react';
import type { TimelineMessage } from '../main/service-facade.js';

/** Project-authored neutral glyphs, keyed to the corresponding LINE reaction types. */
export const LINE_REACTION_GLYPHS: Record<'NICE' | 'LOVE' | 'FUN' | 'AMAZING' | 'SAD' | 'OMG', string> = {
  NICE: '●', LOVE: '♡', FUN: '✳', AMAZING: '✦', SAD: '▼', OMG: '!',
};

export type AgentJobStatus = NonNullable<TimelineMessage['agentJobStatus']>;

export function agentJobStatusLabel(locale: Locale, status: AgentJobStatus): string {
  switch (status) {
    case 'queued': return desktopTextFor(locale, 'agentQueued');
    case 'running': return desktopTextFor(locale, 'agentRunning');
    case 'completed': return desktopTextFor(locale, 'agentCompleted');
    case 'failed': return desktopTextFor(locale, 'agentFailed');
    case 'cancelled': return desktopTextFor(locale, 'agentCancelled');
    case 'interrupted': return desktopTextFor(locale, 'agentInterrupted');
  }
}

/** Marker edge length in CSS px (also set in styles.css); the marker is icon only. */
export const AGENT_STATUS_ICON_SIZE = 20;

/**
 * Shared by the chat timeline and the Settings preview so both draw the same 20px glyph.
 * Icon only: the label lives in `aria-label` / `title`, never as visible text.
 */
export function AgentStatusMarker({ status, preview = false, previewName }: { status: AgentJobStatus; preview?: boolean; previewName?: string }) {
  const locale = useDesktopLocale();
  const desktopText = useDesktopText();
  const label = agentJobStatusLabel(locale, status);
  const { glyph, rotation } = AGENT_STATUS_MARKERS[status];
  // The Settings preview draws every rotation glyph; the chat marker keeps a single glyph.
  const glyphs = preview && rotation ? rotation.map((reaction) => LINE_REACTION_GLYPHS[reaction]) : [glyph];
  return <div className={`agent-status-marker ${status}${preview ? ' preview' : ''}`}
    {...(preview ? { 'aria-label': previewName ?? desktopText('arg0Preview', { arg0: label }) } : { role: 'status', 'aria-label': label, title: label })}>
    {glyphs.map((value, index) => <span key={index} className="agent-status-glyph" aria-hidden="true">{value}</span>)}
  </div>;
}

/**
 * Fixed marker per Agent status. The authority is the reaction table in `src/main/services/agent-service.ts`
 * (`noteQueued`, `sendReaction`, `reactCancelledQueued`): keep this table in sync with it (the renderer must not import
 * main code; `running` rotates NICE/AMAZING/FUN via `HEARTBEAT_REACTIONS` there, every 10 s). Each status uses a neutral
 * project glyph keyed to the LINE reaction the Agent puts on the triggering message.
 */
export const AGENT_STATUS_MARKERS: Record<AgentJobStatus, { glyph: string; lineReaction: 'AMAZING' | 'NICE' | 'LOVE' | 'SAD' | 'FUN' | 'OMG'; note: string; rotation?: ReadonlyArray<'NICE' | 'AMAZING' | 'FUN'> }> = {
  queued: { glyph: LINE_REACTION_GLYPHS.AMAZING, lineReaction: 'AMAZING', note: 'LINE reaction: AMAZING' },
  running: { glyph: LINE_REACTION_GLYPHS.NICE, lineReaction: 'NICE', note: '(alternating)', rotation: ['NICE', 'AMAZING', 'FUN'] },
  completed: { glyph: LINE_REACTION_GLYPHS.LOVE, lineReaction: 'LOVE', note: 'LINE reaction: LOVE' },
  failed: { glyph: LINE_REACTION_GLYPHS.SAD, lineReaction: 'SAD', note: 'LINE reaction: SAD' },
  cancelled: { glyph: LINE_REACTION_GLYPHS.FUN, lineReaction: 'FUN', note: 'LINE reaction: FUN' },
  interrupted: { glyph: LINE_REACTION_GLYPHS.OMG, lineReaction: 'OMG', note: 'LINE reaction: OMG' },
};
