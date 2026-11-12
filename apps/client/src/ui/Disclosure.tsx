import type { ReactNode } from 'react';

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Progressive disclosure built on native <details>/<summary>, which provides
 * keyboard support and expanded/collapsed semantics without scripting.
 * Content stays mounted while closed, so engines rendered inside are never torn down by toggling.
 */
export function Disclosure({ summary, children, defaultOpen = false, className }: DisclosureProps) {
  return <details className={className ? `ui-disclosure ${className}` : 'ui-disclosure'} open={defaultOpen || undefined}>
    <summary>{summary}</summary>
    <div className="ui-disclosure__content">{children}</div>
  </details>;
}

