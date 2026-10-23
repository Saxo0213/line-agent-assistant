import React from 'react';

type InlineBusyProps = { children: string; spinning?: boolean };

export function InlineBusy({ children, spinning = true }: InlineBusyProps) {
  return <span className={`inline-busy${spinning ? ' is-spinning' : ' is-static'}`} role="status" aria-live="polite">
    <span className="inline-busy-indicator" aria-hidden="true" />
    <span>{children}</span>
  </span>;
}
