import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record';
export type ButtonSize = 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks activation while keeping the visible label. */
  busy?: boolean;
  icon?: ReactNode;
}

export function buttonClassName(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return ['ui-button', `ui-button--${variant}`, size === 'lg' ? 'ui-button--lg' : '', extra ?? ''].filter(Boolean).join(' ');
}

export function Button({ variant = 'primary', size = 'md', busy = false, icon, type = 'button', className, disabled, children, ...rest }: ButtonProps) {
  return <button
    {...rest}
    type={type}
    className={buttonClassName(variant, size, className)}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
  >
    {busy ? <span className="ui-spinner" aria-hidden="true" /> : variant === 'record' && !icon ? <span className="ui-button__dot" aria-hidden="true" /> : icon}
    {children}
  </button>;
}

