import type { DurableRecordingSnapshot, DurableRecordingStatus } from '../media/durable-recording-engine.js';
import type { RecordingSnapshot, RecordingStatus } from '../media/recording-engine.js';

export type RecordingMode = 'durable' | 'temporary';

export interface RecordingDockActions {
  startLabel: 'Start recording' | 'Start new recording' | null;
  showPause: boolean;
  showResume: boolean;
  showStop: boolean;
  stopIsPrimary: boolean;
  showClear: boolean;
}

const durableUnloadStates = new Set<DurableRecordingStatus>([
  'recording',
  'paused',
  'stopping',
  'uploading',
  'retrying',
  'finalizing',
]);

const temporaryUnloadStates = new Set<RecordingStatus>(['recording', 'paused', 'stopping']);

export function shouldGuardBeforeUnload(
  temporary: Pick<RecordingSnapshot, 'status'>,
  durable: Pick<DurableRecordingSnapshot, 'status'>,
): boolean {
  return temporaryUnloadStates.has(temporary.status) || durableUnloadStates.has(durable.status);
}

export function deriveUploadProgress(acknowledgedChunks: number, queuedChunks: number): number {
  const acknowledged = Number.isSafeInteger(acknowledgedChunks) && acknowledgedChunks > 0 ? acknowledgedChunks : 0;
  const queued = Number.isSafeInteger(queuedChunks) && queuedChunks > 0 ? queuedChunks : 0;
  const total = acknowledged + queued;
  return total === 0 ? 0 : acknowledged / total;
}

export function deriveRecordingDockActions(
  mode: RecordingMode,
  selectedStatus: DurableRecordingStatus | RecordingStatus,
  recorderStatus: RecordingStatus,
): RecordingDockActions {
  const terminal = selectedStatus === 'completed' || selectedStatus === 'failed';
  if (terminal) {
    return {
      startLabel: 'Start new recording',
      showPause: false,
      showResume: false,
      showStop: false,
      stopIsPrimary: false,
      showClear: true,
    };
  }

  if (selectedStatus === 'retrying' || selectedStatus === 'finalizing' || selectedStatus === 'stopping' || selectedStatus === 'creating') {
    return {
      startLabel: null,
      showPause: false,
      showResume: false,
      showStop: false,
      stopIsPrimary: false,
      showClear: false,
    };
  }

  if (recorderStatus === 'recording') {
    return {
      startLabel: null,
      showPause: true,
      showResume: false,
      showStop: true,
      stopIsPrimary: true,
      showClear: false,
    };
  }

  if (recorderStatus === 'paused') {
    return {
      startLabel: null,
      showPause: false,
      showResume: true,
      showStop: true,
      stopIsPrimary: false,
      showClear: false,
    };
  }

  if (mode === 'temporary' && recorderStatus === 'starting') {
    return {
      startLabel: null,
      showPause: false,
      showResume: false,
      showStop: true,
      stopIsPrimary: true,
      showClear: false,
    };
  }

  if (selectedStatus === 'idle') {
    return {
      startLabel: 'Start recording',
      showPause: false,
      showResume: false,
      showStop: false,
      stopIsPrimary: false,
      showClear: false,
    };
  }

  return {
    startLabel: null,
    showPause: false,
    showResume: false,
    showStop: false,
    stopIsPrimary: false,
    showClear: false,
  };
}

export function recordingDocumentTitle(
  activityState: 'recording' | 'paused' | 'stopping' | 'uploading' | 'retrying' | 'finalizing' | string,
  duration: string,
  baseTitle = 'Screeva — Your Screen. Your Studio.',
): string {
  if (activityState === 'recording') return `● REC ${duration} — Screeva`;
  if (activityState === 'paused') return `Paused ${duration} — Screeva`;
  if (activityState === 'stopping' || activityState === 'uploading' || activityState === 'retrying' || activityState === 'finalizing') {
    return 'Saving recording… — Screeva';
  }
  return baseTitle;
}
