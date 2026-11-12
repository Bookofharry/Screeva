import type { ReactNode } from 'react';

export type StatusTone = 'neutral' | 'ok' | 'warning' | 'danger' | 'recording';

interface StatusPillProps {
  tone?: StatusTone;
  children: ReactNode;
  /** Accessible name for the status region; when set the pill is exposed as role="status". */
  statusLabel?: string;
  /** Shows a leading dot. Recording pills always show one (pulsing unless reduced motion). */
  dot?: boolean;
}

/** Text is always present; colour only reinforces the state (UX_DESIGN.md §2.5). */
export function StatusPill({ tone = 'neutral', children, statusLabel, dot = false }: StatusPillProps) {
  return <span
    className={tone === 'neutral' ? 'ui-pill' : `ui-pill ui-pill--${tone}`}
    {...(statusLabel ? { role: 'status', 'aria-label': statusLabel } : {})}
  >
    {(dot || tone === 'recording') && <span className="ui-pill__dot" aria-hidden="true" />}
    {children}
  </span>;
}

