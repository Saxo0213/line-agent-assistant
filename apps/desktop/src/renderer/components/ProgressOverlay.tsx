import { generatedMessageText, useDesktopText } from '../desktop-i18n.js';
import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  title: string;
  step: string;
  children?: React.ReactNode;
  error?: string | null;
  /** Safe machine code shown on its own selectable line under the error sentence. */
  errorCode?: string | null;
  onClose?: () => void;
  spinner?: boolean;
};

/** Window-wide blocking progress dialog. The app shell stays inert until it closes. */
export function ProgressOverlay({ title, step, children, error, errorCode, onClose, spinner = true }: Props) {
  const desktopText = useDesktopText();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useRef(`progress-title-${Math.random().toString(36).slice(2)}`);

  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const wasInert = shell?.hasAttribute('inert') ?? false;
    const wasHidden = shell?.getAttribute('aria-hidden');
    if (shell) { shell.setAttribute('inert', ''); shell.setAttribute('aria-hidden', 'true'); }
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      if (!items.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = items[0]!; const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => {
      window.removeEventListener('keydown', trap, true);
      if (shell) { if (!wasInert) shell.removeAttribute('inert'); if (wasHidden === null || wasHidden === undefined) shell.removeAttribute('aria-hidden'); else shell.setAttribute('aria-hidden', wasHidden); }
      previousFocus?.focus();
    };
  }, []);

  return createPortal(<div className="progress-overlay">
    <div className="progress-card" role="dialog" aria-modal="true" aria-labelledby={titleId.current} tabIndex={-1} ref={dialog}>
      <h2 id={titleId.current}>{generatedMessageText(title)}</h2>
      {(error || step) && <p role={error ? 'alert' : 'status'} className={error ? 'progress-error' : undefined}>{error ?? step}</p>}
      {error && errorCode && <p className="progress-error-code">{desktopText('errorCode')}<span>{errorCode}</span></p>}
      {!error && spinner && <div className="progress-spinner" aria-hidden="true" />}
      {children}
      {error && onClose && <div className="progress-actions"><button autoFocus onClick={onClose}>{desktopText('close')}</button></div>}
    </div>
  </div>, document.body);
}
