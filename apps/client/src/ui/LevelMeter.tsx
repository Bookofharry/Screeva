import type { CSSProperties } from 'react';

export type LevelState = 'active' | 'muted' | 'unavailable';

interface LevelMeterProps {
  label: string;
  /** Linear level from the mixer analyser, 0–1. */
  level: number;
  state?: LevelState;
  segments?: number;
}

/** Number of lit segments for a level; clamps out-of-range and non-finite input. */
export function litSegments(level: number, segments: number): number {
  if (!Number.isFinite(level) || segments <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, level)) * segments);
}

/**
 * Segmented level meter. Exposed as an ARIA meter (not a live region), so a
 * screen reader reads the value on demand rather than announcing every frame.
 */
export function LevelMeter({ label, level, state = 'active', segments = 10 }: LevelMeterProps) {
  const count = Math.max(1, Math.floor(segments));
  const lit = state === 'unavailable' ? 0 : litSegments(level, count);
  const percent = Math.round((lit / count) * 100);
  const valueText = state === 'unavailable' ? 'No input' : state === 'muted' ? `Muted, ${percent}%` : `${percent}%`;
  return <div
    className={state === 'active' ? 'ui-level' : `ui-level ui-level--${state}`}
    role="meter"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    aria-valuetext={valueText}
    style={{ '--ui-level-segments': count } as CSSProperties}
  >
    {Array.from({ length: count }, (_, index) => <span
      key={index}
      aria-hidden="true"
      className={[
        'ui-level__segment',
        index < lit ? 'ui-level__segment--on' : '',
        index >= Math.ceil(count * 0.8) ? 'ui-level__segment--hot' : '',
      ].filter(Boolean).join(' ')}
    />)}
  </div>;
}

