import type { RecoveryInspection } from '../../../../packages/shared/src/index.js';
import type { BannerTone } from './Banner.js';
import type { StatusTone } from './StatusPill.js';

export interface RecoveryConditionPresentation {
  label: string;
  tone: StatusTone;
  detail: string;
}

export interface RecoverySummary {
  totalCount: number;
  attentionCount: number;
  recoverableCount: number;
  corruptCount: number;
  unavailableCount: number;
  emptyCount: number;
  activeCount: number;
}

export interface RecoveryLaunchNotice {
  tone: BannerTone;
  title: string;
  detail: string;
}

const conditionPresentation: Record<RecoveryInspection['condition'], RecoveryConditionPresentation> = {
  empty: {
    label: 'No acknowledged chunks',
    tone: 'neutral',
    detail: 'The local server has no acknowledged media bytes for this session.',
  },
  active: {
    label: 'Activity in progress',
    tone: 'warning',
    detail: 'Recording, upload, finalization, or another recovery operation is still active.',
  },
  'valid-incomplete': {
    label: 'Verified incomplete',
    tone: 'warning',
    detail: 'The contiguous server-acknowledged chunks passed size and SHA-256 verification.',
  },
  corrupt: {
    label: 'Corrupt evidence',
    tone: 'danger',
    detail: 'Committed metadata or files disagree. This session is quarantined from salvage.',
  },
  finalizing: {
    label: 'Finalization interrupted',
    tone: 'warning',
    detail: 'A previous finalization stopped; the verified acknowledged chunks can be retried.',
  },
  completed: {
    label: 'Already completed',
    tone: 'ok',
    detail: 'The server has already validated and completed this recording.',
  },
  unavailable: {
    label: 'Storage unavailable',
    tone: 'danger',
    detail: 'The local server could not safely inspect this session’s committed storage.',
  },
};

export function describeRecoveryCondition(condition: RecoveryInspection['condition']): RecoveryConditionPresentation {
  return conditionPresentation[condition];
}

export function summarizeRecovery(items: readonly RecoveryInspection[]): RecoverySummary {
  let recoverableCount = 0;
  let corruptCount = 0;
  let unavailableCount = 0;
  let emptyCount = 0;
  let activeCount = 0;
  for (const item of items) {
    if (item.recoverable) recoverableCount += 1;
    if (item.condition === 'corrupt') corruptCount += 1;
    if (item.condition === 'unavailable') unavailableCount += 1;
    if (item.condition === 'empty') emptyCount += 1;
    if (item.condition === 'active') activeCount += 1;
  }
  return {
    totalCount: items.length,
    attentionCount: items.length - activeCount,
    recoverableCount,
    corruptCount,
    unavailableCount,
    emptyCount,
    activeCount,
  };
}

export function recoveryLaunchNotice(summary: RecoverySummary): RecoveryLaunchNotice | null {
  if (summary.attentionCount === 0) return null;
  if (summary.corruptCount > 0 || summary.unavailableCount > 0) {
    const affected = summary.corruptCount + summary.unavailableCount;
    return {
      tone: 'danger',
      title: `${affected} interrupted session${affected === 1 ? '' : 's'} require attention`,
      detail: 'Unsafe or unavailable evidence is isolated and cannot be presented as recovered. Review Recovery for exact conditions.',
    };
  }
  if (summary.recoverableCount > 0) {
    return {
      tone: 'warning',
      title: `${summary.recoverableCount} interrupted recording${summary.recoverableCount === 1 ? '' : 's'} can be salvaged best-effort`,
      detail: 'Only server-acknowledged, independently verified chunks are available. Browser-only data cannot be recovered.',
    };
  }
  return {
    tone: 'warning',
    title: `${summary.attentionCount} unfinished session${summary.attentionCount === 1 ? '' : 's'} need review`,
    detail: 'The local server has no verified salvageable output for these sessions. Recovery explains each condition.',
  };
}
