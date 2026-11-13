import type { SVGProps } from 'react';

/** Inline SVG paths drawn on a 24×24 grid with a 1.75 stroke (UX_DESIGN.md §6.4). Bundled locally; no icon font or remote asset. */
const paths = {
  screen: 'M3 5h18v11H3z M8 20h8 M12 16v4',
  camera: 'M3 7h12v10H3z M15 10l6-3v10l-6-3',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  'mic-off': 'M15 9V6a3 3 0 0 0-5.7-1.3 M9 9v2a3 3 0 0 0 4.6 2.5 M5 11a7 7 0 0 0 11.5 5.4 M19 11a7 7 0 0 1-.6 2.8 M12 18v3 M3 3l18 18',
  speaker: 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a7.5 7.5 0 0 1 0 11',
  record: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z',
  pause: 'M8 5v14 M16 5v14',
  stop: 'M6 6h12v12H6z',
  check: 'M5 12.5l4.5 4.5L19 7',
  warning: 'M12 3l10 18H2z M12 10v5 M12 18v.01',
  error: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9 9l6 6 M15 9l-6 6',
  library: 'M4 4h4v16H4z M10 4h4v16h-4z M16 5l4 1-3 14-4-1',
  recover: 'M4 12a8 8 0 1 0 2.3-5.7 M4 4v4h4 M12 8v4l3 2',
  chevron: 'M9 6l6 6-6 6',
  sliders: 'M4 6h10 M18 6h2 M14 4v4 M4 12h4 M12 12h8 M8 10v4 M4 18h12 M20 18h0 M16 16v4',
  close: 'M6 6l12 12 M18 6l-12 12',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H12v17H6.5A2.5 2.5 0 0 0 4 22.5z M20 5.5A2.5 2.5 0 0 0 17.5 3H12v17h5.5a2.5 2.5 0 0 1 2.5 2.5z',
} as const;

export type IconName = keyof typeof paths;
export const ICON_NAMES = Object.keys(paths) as IconName[];

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  size?: number;
  /** Accessible name. Omit for decorative icons, which are hidden from assistive technology. */
  title?: string;
}

export function Icon({ name, size = 20, title, className, ...rest }: IconProps) {
  const labelled = !!title?.trim();
  return <svg
    {...rest}
    className={className ? `ui-icon ${className}` : 'ui-icon'}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    focusable="false"
    {...(labelled ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
  >
    {labelled && <title>{title}</title>}
    <path d={paths[name]} />
  </svg>;
}

