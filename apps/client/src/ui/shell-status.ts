import type { Capabilities } from '../../../../packages/shared/src/index.js';
import { initialDurableRecordingSnapshot, type DurableRecordingSnapshot } from '../media/durable-recording-engine.js';
import { initialRecordingSnapshot, type RecordingSnapshot } from '../media/recording-engine.js';
import type { IconName } from './Icon.js';
import type { StatusTone } from './StatusPill.js';

export type StudioViewId = 'studio' | 'recordings' | 'recovery' | 'guides' | 'settings';

export interface StudioViewDefinition {
  id: StudioViewId;
  label: string;
  hash: `#${StudioViewId}`;
  icon: IconName;
  heading: string;
  eyebrow: string;
  description: string;
}

export const DEFAULT_STUDIO_VIEW: StudioViewDefinition = {
  id: 'studio',
  label: 'Studio',
  hash: '#studio',
  icon: 'screen',
  eyebrow: 'RECORDING STUDIO',
  heading: 'A local home for your next recording.',
  description: 'Choose your inputs, compose the scene, then record either a temporary preview or an acknowledged local session. Durable completion is shown only after the local service finalizes the WebM.',
};

export const STUDIO_VIEWS: readonly StudioViewDefinition[] = [
  DEFAULT_STUDIO_VIEW,
  {
    id: 'recordings',
    label: 'Recordings',
    hash: '#recordings',
    icon: 'library',
    eyebrow: 'SESSION LIBRARY',
    heading: 'Recorded local sessions.',
    description: 'Inspect durable sessions stored on this computer, including acknowledged chunk counts and verified WebM output metadata.',
  },
  {
    id: 'recovery',
    label: 'Recovery',
    hash: '#recovery',
    icon: 'recover',
    eyebrow: 'DURABILITY & SALVAGE',
    heading: 'Interrupted session recovery.',
    description: 'Inspect unfinished durable sessions and salvage contiguous server-acknowledged WebM chunks without overwriting original data.',
  },
  {
    id: 'guides',
    label: 'Guides',
    hash: '#guides',
    icon: 'book',
    eyebrow: 'DOCUMENTATION & WORKFLOWS',
    heading: 'Guides & reference documentation.',
    description: 'Learn how Local Creator Recorder captures sources, composites scenes, saves crash-safe sessions, and protects local-only privacy.',
  },
  {
    id: 'settings',
    label: 'Settings',
    hash: '#settings',
    icon: 'check',
    eyebrow: 'LOCAL WORKSPACE',
    heading: 'Workspace status and diagnostics.',
    description: 'Verify local service connectivity, authenticated write access, and local-first privacy and capability boundaries.',
  },
] as const;

export interface CaptureSummary {
  activeCount: number;
  pendingCount: number;
}

export interface RecordingStatusSummary {
  mode: 'durable' | 'temporary';
  temporary: RecordingSnapshot;
  durable: DurableRecordingSnapshot;
}

export type ServiceReadinessState = 'connecting' | 'connected' | 'offline';
export type ShellActivityState =
  | 'idle'
  | 'capturing'
  | 'starting'
  | 'creating'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'uploading'
  | 'retrying'
  | 'finalizing'
  | 'saved'
  | 'completed'
  | 'failed';

export interface BackgroundActivityBanner {
  tone: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
}

export interface GlobalShellStatus {
  serviceState: ServiceReadinessState;
  serviceLabel: 'Connecting…' | 'Connected' | 'Unavailable';
  serviceTone: StatusTone;
  activityState: ShellActivityState;
  activityLabel: string;
  activityTone: StatusTone;
  isRecordingOrSaving: boolean;
  hasLiveSession: boolean;
  backgroundBanner: BackgroundActivityBanner | null;
}

export function initialCaptureSummary(): CaptureSummary {
  return { activeCount: 0, pendingCount: 0 };
}

export function initialRecordingStatusSummary(): RecordingStatusSummary {
  return {
    mode: 'temporary',
    temporary: initialRecordingSnapshot(),
    durable: initialDurableRecordingSnapshot(),
  };
}

export function parseViewFromHash(hash: string): StudioViewId {
  const cleaned = hash.trim().replace(/^#\/?/, '').split(/[/?]/, 1)[0]?.toLowerCase() ?? '';
  if (cleaned === 'recordings' || cleaned === 'recovery' || cleaned === 'guides' || cleaned === 'settings' || cleaned === 'studio') {
    return cleaned;
  }
  return 'studio';
}

export function viewToHash(view: StudioViewId): `#${StudioViewId}` {
  return `#${view}`;
}

export function formatClockDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const DURABLE_ACTIVE_STATES = new Set<DurableRecordingSnapshot['status']>([
  'creating',
  'recording',
  'paused',
  'stopping',
  'uploading',
  'retrying',
  'finalizing',
]);

const TEMPORARY_ACTIVE_STATES = new Set<RecordingSnapshot['status']>([
  'starting',
  'recording',
  'paused',
  'stopping',
]);

export function deriveGlobalShellStatus(input: {
  capabilities: Capabilities | null;
  serviceError: string;
  capture: CaptureSummary;
  recording: RecordingStatusSummary;
  activeView: StudioViewId;
}): GlobalShellStatus {
  const { capabilities, serviceError, capture, recording, activeView } = input;
  const serviceState: ServiceReadinessState = serviceError
    ? 'offline'
    : capabilities
      ? 'connected'
      : 'connecting';
  const serviceLabel = serviceState === 'offline'
    ? 'Unavailable'
    : serviceState === 'connected'
      ? 'Connected'
      : 'Connecting…';
  const serviceTone: StatusTone = serviceState === 'offline'
    ? 'danger'
    : serviceState === 'connected'
      ? 'ok'
      : 'neutral';

  const durableActive = DURABLE_ACTIVE_STATES.has(recording.durable.status);
  const temporaryActive = TEMPORARY_ACTIVE_STATES.has(recording.temporary.status);
  const effectiveMode: 'durable' | 'temporary' = durableActive
    ? 'durable'
    : temporaryActive
      ? 'temporary'
      : recording.mode;

  let activityState: ShellActivityState = 'idle';
  let activityLabel = 'Studio idle';
  let activityTone: StatusTone = 'neutral';
  let isRecordingOrSaving = false;

  if (effectiveMode === 'durable' && recording.durable.status !== 'idle') {
    const { status, durationMs, queuedChunks } = recording.durable;
    switch (status) {
      case 'creating':
        activityState = 'creating';
        activityLabel = 'Creating session…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'recording':
        activityState = 'recording';
        activityLabel = `Recording · ${formatClockDuration(durationMs)}`;
        activityTone = 'recording';
        isRecordingOrSaving = true;
        break;
      case 'paused':
        activityState = 'paused';
        activityLabel = `Paused · ${formatClockDuration(durationMs)}`;
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'stopping':
        activityState = 'stopping';
        activityLabel = 'Stopping…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'uploading':
        activityState = 'uploading';
        activityLabel = queuedChunks > 0 ? `Uploading (${queuedChunks} queued)` : 'Uploading chunks…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'retrying':
        activityState = 'retrying';
        activityLabel = 'Retrying upload…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'finalizing':
        activityState = 'finalizing';
        activityLabel = 'Finalizing WebM…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'completed':
        activityState = 'saved';
        activityLabel = 'Session saved';
        activityTone = 'ok';
        break;
      case 'failed':
        activityState = 'failed';
        activityLabel = 'Recording error';
        activityTone = 'danger';
        break;
    }
  } else if (effectiveMode === 'temporary' && recording.temporary.status !== 'idle') {
    const { status, durationMs } = recording.temporary;
    switch (status) {
      case 'starting':
        activityState = 'starting';
        activityLabel = 'Starting…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'recording':
        activityState = 'recording';
        activityLabel = `Recording · ${formatClockDuration(durationMs)}`;
        activityTone = 'recording';
        isRecordingOrSaving = true;
        break;
      case 'paused':
        activityState = 'paused';
        activityLabel = `Paused · ${formatClockDuration(durationMs)}`;
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'stopping':
        activityState = 'stopping';
        activityLabel = 'Stopping…';
        activityTone = 'warning';
        isRecordingOrSaving = true;
        break;
      case 'completed':
        activityState = 'completed';
        activityLabel = 'Preview ready';
        activityTone = 'ok';
        break;
      case 'failed':
        activityState = 'failed';
        activityLabel = 'Recording error';
        activityTone = 'danger';
        break;
    }
  } else if (capture.activeCount > 0) {
    activityState = 'capturing';
    activityLabel = `${capture.activeCount} source${capture.activeCount === 1 ? '' : 's'} active`;
    activityTone = 'ok';
  }

  const hasLiveSession = isRecordingOrSaving || capture.activeCount > 0 || capture.pendingCount > 0;

  let backgroundBanner: BackgroundActivityBanner | null = null;
  if (activeView !== 'studio') {
    if (activityState === 'recording' || activityState === 'paused') {
      const duration = effectiveMode === 'durable'
        ? formatClockDuration(recording.durable.durationMs)
        : formatClockDuration(recording.temporary.durationMs);
      backgroundBanner = {
        tone: 'warning',
        title: activityState === 'recording' ? `Recording continues in Studio (${duration})` : `Recording is paused in Studio (${duration})`,
        detail: effectiveMode === 'durable'
          ? `Acknowledged chunks: ${recording.durable.acknowledgedChunks} · Queued in browser: ${recording.durable.queuedChunks}. Switching views does not interrupt capture or chunk uploads.`
          : 'Temporary preview recording remains active in memory while you browse other views.',
      };
    } else if (
      activityState === 'creating'
      || activityState === 'starting'
      || activityState === 'stopping'
      || activityState === 'uploading'
      || activityState === 'retrying'
      || activityState === 'finalizing'
    ) {
      backgroundBanner = {
        tone: 'warning',
        title: `Studio is ${activityLabel.toLowerCase()}`,
        detail: effectiveMode === 'durable'
          ? `Acknowledged chunks: ${recording.durable.acknowledgedChunks} · Queued in browser: ${recording.durable.queuedChunks}. Keep this tab open until finalization completes.`
          : 'Studio recorder is finishing your clip in the background.',
      };
    } else if (activityState === 'failed') {
      const errorMessage = effectiveMode === 'durable' ? recording.durable.error : recording.temporary.error;
      backgroundBanner = {
        tone: 'danger',
        title: 'Studio recording requires attention',
        detail: errorMessage || 'The active recording encountered an error in Studio.',
      };
    } else if (capture.activeCount > 0) {
      backgroundBanner = {
        tone: 'info',
        title: `${capture.activeCount} live capture source${capture.activeCount === 1 ? ' is' : 's are'} running in Studio`,
        detail: 'Your screen, camera, or microphone streams remain active while you inspect other views.',
      };
    }
  }

  return {
    serviceState,
    serviceLabel,
    serviceTone,
    activityState,
    activityLabel,
    activityTone,
    isRecordingOrSaving,
    hasLiveSession,
    backgroundBanner,
  };
}
