// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_STATUS_MARKERS, AgentStatusMarker, LINE_REACTION_GLYPHS, agentJobStatusLabel, type AgentJobStatus } from './AgentStatusMarker.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';

const renderLocale = (locale: 'en' | 'zh-TW' | 'ja' | 'ko', children: React.ReactNode) => render(<LocaleProvider value={{ status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} } satisfies LocaleState}>{children}</LocaleProvider>);

afterEach(cleanup);

describe('AgentStatusMarker glyphs', () => {
  const draw = (status: AgentJobStatus) => renderLocale('zh-TW', <AgentStatusMarker status={status} />).container;

  it.each([
    ['queued', 'AMAZING'], ['running', 'NICE'], ['completed', 'LOVE'], ['failed', 'SAD'], ['cancelled', 'FUN'], ['interrupted', 'OMG'],
  ] as const)('%s renders only the %s reaction glyph at 20px', (status, reaction) => {
    const root = draw(status);
    const glyph = root.querySelector('.agent-status-glyph')!;
    expect(glyph.textContent).toBe(LINE_REACTION_GLYPHS[reaction]);
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.classList.contains('agent-status-glyph')).toBe(true);
    expect(AGENT_STATUS_MARKERS[status].lineReaction).toBe(reaction);
  });

  it.each(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as AgentJobStatus[])('%s exposes its glyph only as hidden decoration beside aria-label and title', (status) => {
    const marker = draw(status).querySelector('.agent-status-marker')!;
    expect(marker.querySelector('.agent-status-glyph')?.getAttribute('aria-hidden')).toBe('true');
    expect(marker.getAttribute('role')).toBe('status');
    expect(marker.getAttribute('aria-label')).toBe(agentJobStatusLabel('zh-TW', status));
    expect(marker.getAttribute('title')).toBe(agentJobStatusLabel('zh-TW', status));
  });

  it.each([
    ['en', 'Agent queued'], ['zh-TW', 'Agent 等待中'], ['ja', 'Agent はキューに追加されました'], ['ko', 'Agent 대기 중'],
  ] as const)('labels the queued marker from the selected %s catalog', (locale, expected) => {
    const marker = renderLocale(locale, <AgentStatusMarker status="queued" />).container.querySelector('.agent-status-marker')!;
    expect(marker.getAttribute('aria-label')).toBe(expected);
  });

  it('keeps the preview labelled without a status role', () => {
    const { container } = renderLocale('zh-TW', <AgentStatusMarker status="queued" preview previewName="等待中預覽" />);
    const marker = container.querySelector('.agent-status-marker')!;
    expect(marker.getAttribute('aria-label')).toBe('等待中預覽');
    expect(marker.getAttribute('role')).toBeNull();
    expect(marker.querySelector('.agent-status-glyph')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('maps the six statuses to six distinct neutral glyphs and the specified reaction notes', () => {
    const statuses = Object.keys(AGENT_STATUS_MARKERS) as AgentJobStatus[];
    expect(new Set(statuses.map((s) => AGENT_STATUS_MARKERS[s].glyph)).size).toBe(6);
    expect(statuses.map((s) => AGENT_STATUS_MARKERS[s].note)).toEqual([
      'LINE reaction: AMAZING', '(alternating)', 'LINE reaction: LOVE', 'LINE reaction: SAD', 'LINE reaction: FUN', 'LINE reaction: OMG',
    ]);
  });

  it('draws the three rotation glyphs in the running preview only; the chat marker keeps one', () => {
    const preview = renderLocale('zh-TW', <AgentStatusMarker status="running" preview previewName="執行中預覽" />).container;
    expect([...preview.querySelectorAll('.agent-status-glyph')].map((glyph) => glyph.textContent)).toEqual([
      LINE_REACTION_GLYPHS.NICE, LINE_REACTION_GLYPHS.AMAZING, LINE_REACTION_GLYPHS.FUN,
    ]);
    expect(draw('running').querySelectorAll('.agent-status-glyph').length).toBe(1);
    expect(render(<AgentStatusMarker status="queued" preview />).container.querySelectorAll('.agent-status-glyph').length).toBe(1);
  });
});
