import React, { useEffect, useRef, useState } from 'react';
import type { AgentSchedulePreviewNewMessagesInput, AgentSchedulePreviewNewMessagesOutput } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { shortWall } from '../scheduleForm.js';
import { ACTION_KEYS } from '../scheduleRules.js';
import type { Text } from './ScheduleFields.js';

type State = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: AgentSchedulePreviewNewMessagesOutput } | { status: 'error'; message: string };

/**
 * Preview (試算) of a new_messages form. It only reads: it never saves the form, sends nothing and starts no LLM.
 * `formKey` changes with every form change: the old result goes away and an answer to an older request is ignored.
 */
export function NewMessagesPreview({ api, text, timezone, formKey, buildInput, onInvalid }: {
  api: DesktopApi; text: Text; timezone: string; formKey: string;
  /** The preview input of the form now, or null when the form is not valid (the caller then shows the errors). */
  buildInput: () => AgentSchedulePreviewNewMessagesInput | null; onInvalid: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const request = useRef(0);
  useEffect(() => { request.current += 1; setState({ status: 'idle' }); }, [formKey]);
  useEffect(() => () => { request.current += 1; }, []);

  async function run() {
    const input = buildInput();
    if (!input) { onInvalid(); return; }
    const id = ++request.current;
    setState({ status: 'running' });
    try {
      const result = await api.previewAgentScheduleNewMessages(input);
      if (request.current === id) setState({ status: 'done', result });
    } catch (error) {
      if (request.current === id) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const result = state.status === 'done' ? state.result : null;
  return <div className="schedule-field schedule-preview" role="group" aria-label={text('previewButton')}>
    <div className="schedule-inline schedule-preview-actions">
      <button type="button" disabled={state.status === 'running'} onClick={() => void run()}>{state.status === 'running' ? text('previewRunning') : text('previewButton')}</button>
    </div>
    <p className="schedule-hint">{text('previewNote')}</p>
    <div aria-live="polite" className="schedule-preview-result">
      {state.status === 'error' && <p role="alert" className="schedule-error">{text('previewFailed', { arg0: state.message })}</p>}
      {result && <>
        <h3 className="schedule-label">{text('previewTitle')}</h3>
        <p className="schedule-hint">{text('previewRange', { arg0: shortWall(result.from, timezone), arg1: shortWall(result.to, timezone) })}</p>
        <p className="schedule-hint">{text('previewTotals', { arg0: result.messageCount, arg1: result.chatCount, arg2: result.listedChars })}</p>
        {result.incomplete && <p className="schedule-error" role="status">{text('previewIncomplete')}</p>}
        {result.chats.length === 0 && <p className="schedule-hint">{text('previewEmpty')}</p>}
        {result.chats.length > 0 && <ul className="schedule-preview-list">{result.chats.map((chat) => <li key={`${chat.accountId}\u0000${chat.chatType}\u0000${chat.chatId}`}>
          <div className="schedule-preview-line"><strong>{chat.title || chat.chatId}</strong><span>{text('previewChatLine', { arg0: chat.messageCount, arg1: text(ACTION_KEYS[chat.action]) })}</span></div>
          <details><summary>{text('previewShowText')}</summary><pre className="schedule-preview-text">{chat.text}</pre></details>
        </li>)}</ul>}
      </>}
    </div>
  </div>;
}
