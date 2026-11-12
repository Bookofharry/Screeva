export type ProgressValue = { kind: 'determinate'; value: number } | { kind: 'indeterminate' };

interface ProgressBarProps {
  label: string;
  progress: ProgressValue;
  /** Optional visible caption, e.g. "Saving the last part… 3 of 5". */
  caption?: string;
}

/** Clamps to [0, 1]; non-finite values become 0 so a bad snapshot can never render a false "complete". */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Native <progress>: omitting `value` gives the indeterminate state, which is used for
 * phases with no honest percentage (stopping, finalizing — UX_DESIGN.md invariant I4).
 */
export function ProgressBar({ label, progress, caption }: ProgressBarProps) {
  return <div className="ui-progress">
    {progress.kind === 'determinate'
      ? <progress aria-label={label} max={1} value={clampProgress(progress.value)} />
      : <progress aria-label={label} />}
    {caption && <span>{caption}</span>}
  </div>;
}

