import React, { useEffect, useRef } from 'react';

/** Modal dialog opened from a header button. Esc and the close button close it; focus moves in and returns to the opener on close. */
export function HeaderDialog({ id, title, closeLabel, className, onClose, children }: { id: string; title: string; closeLabel: string; className: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className={`modal header-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <div className="header-dialog-top"><h2 id={`${id}-title`}>{title}</h2>
        <button type="button" data-autofocus aria-label={closeLabel} onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>;
}

/** Small dot on a header button. The text is visually hidden. */
export function AttentionDot({ label }: { label: string }) {
  return <span className="attention-dot" role="img" aria-label={label} />;
}
