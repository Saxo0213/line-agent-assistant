import { generatedMessageText, useDesktopText } from '../desktop-i18n.js';
import React, { useCallback, useEffect, useState } from 'react';

export type ComposerSeverity = 'info' | 'warning' | 'error';
export type ComposerMessage = { severity: ComposerSeverity; text: string; action?: { label: string; run: () => void }; sticky?: boolean; key?: string } | null;

const INFO_MS = 4000;

/**
 * One system message per chat-room composer; a newer message replaces the older one.
 * Info auto-clears after a few seconds. Warnings and errors stay until cleared.
 */
export function useComposerStatus() {
  const [message, setMessage] = useState<ComposerMessage>(null);
  useEffect(() => {
    if (message?.severity !== 'info' || message.sticky) return;
    const timer = setTimeout(() => setMessage(null), INFO_MS);
    return () => clearTimeout(timer);
  }, [message]);
  const show = useCallback((severity: ComposerSeverity, text: string, action?: { label: string; run: () => void }) => {
    setMessage(text ? (action ? { severity, text, action } : { severity, text }) : null);
  }, []);
  const setError = useCallback((text: string) => show('error', text), [show]);
  const setWarning = useCallback((text: string, action?: { label: string; run: () => void }, key?: string) => {
    setMessage(text ? { severity: 'warning', text, ...(action ? { action } : {}), ...(key ? { key } : {}) } : null);
  }, []);
  const setNotice = useCallback((text: string) => show('info', text), [show]);
  const clear = useCallback(() => setMessage(null), []);
  /** Clear only when the slot still shows the message with this key; never an unrelated one. */
  const clearKey = useCallback((key: string) => setMessage((current) => (current?.key === key ? null : current)), []);
  return { message, show, setError, setWarning, setNotice, clear, clearKey };
}

/**
 * Always-rendered, fixed-height slot placed left of the send button. Text is one line with
 * ellipsis (full text in the tooltip), so showing or clearing a message never moves other content.
 */
export function ComposerStatus({ message, onDismiss }: { message: ComposerMessage; onDismiss: () => void }) {
  const desktopText = useDesktopText();
  return <div className="composer-status" data-testid="composer-status">
    {message && <>
      <span className={`composer-status-text ${message.severity}`} role={message.severity === 'error' ? 'alert' : 'status'} title={generatedMessageText(message.text)}>{generatedMessageText(message.text)}</span>
      {message.action && <button type="button" className="composer-status-action" onClick={message.action.run}>{generatedMessageText(message.action.label)}</button>}
      {message.severity !== 'info' && !message.sticky && <button type="button" className="composer-status-dismiss" aria-label={desktopText('clearMessage')} onClick={onDismiss}>×</button>}
    </>}
  </div>;
}
