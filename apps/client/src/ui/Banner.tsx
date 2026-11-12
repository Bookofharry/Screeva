import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export type BannerTone = 'info' | 'warning' | 'danger';

interface BannerProps {
  tone?: BannerTone | undefined;
  title?: string | undefined;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
  /**
   * Announce the banner when it appears. Danger banners default to role="alert";
   * info and warning default to no live role so persistent banners don't repeat.
   */
  announce?: boolean | undefined;
  /** Optional accessible name when exposed as a status/alert landmark. */
  statusLabel?: string | undefined;
}

const icons: Record<BannerTone, IconName> = { info: 'check', warning: 'warning', danger: 'error' };

export function Banner({ tone = 'info', title, children, action, announce, statusLabel }: BannerProps) {
  const live = announce ?? tone === 'danger';
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return <div
    className={`ui-banner ui-banner--${tone}`}
    {...(role ? { role } : {})}
    {...(statusLabel ? { 'aria-label': statusLabel } : {})}
  >
    <Icon name={icons[tone]} />
    <div className="ui-banner__body">
      {title && <strong className="ui-banner__title">{title}</strong>}
      {children}
    </div>
    {action && <div className="ui-banner__action">{action}</div>}
  </div>;
}
