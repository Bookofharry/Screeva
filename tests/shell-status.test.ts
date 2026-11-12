import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Capabilities } from '../packages/shared/src/index.js';
import { GuidesPanel } from '../apps/client/src/components/GuidesPanel.js';
import { RecordingsPanel } from '../apps/client/src/components/RecordingsPanel.js';
import { SettingsPanel } from '../apps/client/src/components/SettingsPanel.js';
import { initialDurableRecordingSnapshot } from '../apps/client/src/media/durable-recording-engine.js';
import { initialRecordingSnapshot } from '../apps/client/src/media/recording-engine.js';
import {
  STUDIO_VIEWS,
  deriveGlobalShellStatus,
  formatClockDuration,
  initialCaptureSummary,
  initialRecordingStatusSummary,
  parseViewFromHash,
  viewToHash,
} from '../apps/client/src/ui/shell-status.js';

const readyCapabilities: Capabilities = {
  name: 'Local Creator Recorder',
  milestone: 'reliability',
  storage: 'ready',
  recording: true,
  export: false,
};

test('parses and formats URL hashes for all studio views', () => {
  assert.deepEqual(STUDIO_VIEWS.map(view => view.id), ['studio', 'recordings', 'recovery', 'guides', 'settings']);
  assert.equal(parseViewFromHash(''), 'studio');
  assert.equal(parseViewFromHash('#'), 'studio');
  assert.equal(parseViewFromHash('#studio'), 'studio');
  assert.equal(parseViewFromHash('#recordings'), 'recordings');
  assert.equal(parseViewFromHash('#/Recovery'), 'recovery');
  assert.equal(parseViewFromHash('#guides'), 'guides');
  assert.equal(parseViewFromHash('#settings?tab=workspace'), 'settings');
  assert.equal(parseViewFromHash('#nonexistent'), 'studio');

  assert.equal(viewToHash('studio'), '#studio');
  assert.equal(viewToHash('recordings'), '#recordings');
  assert.equal(viewToHash('recovery'), '#recovery');
  assert.equal(viewToHash('guides'), '#guides');
  assert.equal(viewToHash('settings'), '#settings');
});

test('formats durations as MM:SS and HH:MM:SS', () => {
  assert.equal(formatClockDuration(0), '00:00');
  assert.equal(formatClockDuration(9_400), '00:09');
  assert.equal(formatClockDuration(65_000), '01:05');
  assert.equal(formatClockDuration(3_661_000), '01:01:01');
});

test('derives service readiness states accurately', () => {
  const connecting = deriveGlobalShellStatus({
    capabilities: null,
    serviceError: '',
    capture: initialCaptureSummary(),
    recording: initialRecordingStatusSummary(),
    activeView: 'studio',
  });
  assert.equal(connecting.serviceState, 'connecting');
  assert.equal(connecting.serviceLabel, 'Connecting…');
  assert.equal(connecting.serviceTone, 'neutral');

  const connected = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: initialCaptureSummary(),
    recording: initialRecordingStatusSummary(),
    activeView: 'studio',
  });
  assert.equal(connected.serviceState, 'connected');
  assert.equal(connected.serviceLabel, 'Connected');
  assert.equal(connected.serviceTone, 'ok');

  const offline = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: 'Cannot reach the local service.',
    capture: initialCaptureSummary(),
    recording: initialRecordingStatusSummary(),
    activeView: 'studio',
  });
  assert.equal(offline.serviceState, 'offline');
  assert.equal(offline.serviceLabel, 'Unavailable');
  assert.equal(offline.serviceTone, 'danger');
});

test('derives capture, recording, upload, retry, finalization, saved, and failed statuses', () => {
  const capturing = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 2, pendingCount: 0 },
    recording: initialRecordingStatusSummary(),
    activeView: 'recordings',
  });
  assert.equal(capturing.activityState, 'capturing');
  assert.equal(capturing.activityLabel, '2 sources active');
  assert.equal(capturing.hasLiveSession, true);
  assert.equal(capturing.isRecordingOrSaving, false);
  assert.match(capturing.backgroundBanner?.title ?? '', /2 live capture sources are running in Studio/);

  const recordingDurable = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 1, pendingCount: 0 },
    recording: {
      mode: 'durable',
      temporary: initialRecordingSnapshot(),
      durable: {
        ...initialDurableRecordingSnapshot(),
        status: 'recording',
        recorderStatus: 'recording',
        durationMs: 14_000,
        acknowledgedChunks: 3,
        queuedChunks: 1,
      },
    },
    activeView: 'recovery',
  });
  assert.equal(recordingDurable.activityState, 'recording');
  assert.equal(recordingDurable.activityLabel, 'Recording · 00:14');
  assert.equal(recordingDurable.activityTone, 'recording');
  assert.equal(recordingDurable.isRecordingOrSaving, true);
  assert.match(recordingDurable.backgroundBanner?.title ?? '', /Recording continues in Studio \(00:14\)/);
  assert.match(recordingDurable.backgroundBanner?.detail ?? '', /Acknowledged chunks: 3/);

  const uploadingDurable = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 1, pendingCount: 0 },
    recording: {
      mode: 'durable',
      temporary: initialRecordingSnapshot(),
      durable: {
        ...initialDurableRecordingSnapshot(),
        status: 'uploading',
        queuedChunks: 2,
        acknowledgedChunks: 4,
      },
    },
    activeView: 'settings',
  });
  assert.equal(uploadingDurable.activityState, 'uploading');
  assert.equal(uploadingDurable.activityLabel, 'Uploading (2 queued)');
  assert.equal(uploadingDurable.isRecordingOrSaving, true);
  assert.match(uploadingDurable.backgroundBanner?.title ?? '', /uploading \(2 queued\)/);

  const finalizingDurable = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 1, pendingCount: 0 },
    recording: {
      mode: 'durable',
      temporary: initialRecordingSnapshot(),
      durable: {
        ...initialDurableRecordingSnapshot(),
        status: 'finalizing',
      },
    },
    activeView: 'recordings',
  });
  assert.equal(finalizingDurable.activityState, 'finalizing');
  assert.equal(finalizingDurable.activityLabel, 'Finalizing WebM…');
  assert.equal(finalizingDurable.isRecordingOrSaving, true);

  const savedDurable = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 0, pendingCount: 0 },
    recording: {
      mode: 'durable',
      temporary: initialRecordingSnapshot(),
      durable: {
        ...initialDurableRecordingSnapshot(),
        status: 'completed',
      },
    },
    activeView: 'studio',
  });
  assert.equal(savedDurable.activityState, 'saved');
  assert.equal(savedDurable.activityLabel, 'Session saved');
  assert.equal(savedDurable.activityTone, 'ok');
  assert.equal(savedDurable.isRecordingOrSaving, false);
  assert.equal(savedDurable.backgroundBanner, null);
});

test('derives temporary recorder and failure states and renders truthful SettingsPanel / RecordingsPanel markup', () => {
  const pausedTemporary = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 1, pendingCount: 0 },
    recording: {
      mode: 'temporary',
      temporary: {
        ...initialRecordingSnapshot(),
        status: 'paused',
        durationMs: 42_000,
      },
      durable: initialDurableRecordingSnapshot(),
    },
    activeView: 'settings',
  });
  assert.equal(pausedTemporary.activityState, 'paused');
  assert.equal(pausedTemporary.activityLabel, 'Paused · 00:42');
  assert.equal(pausedTemporary.isRecordingOrSaving, true);
  assert.match(pausedTemporary.backgroundBanner?.title ?? '', /Recording is paused in Studio \(00:42\)/);

  const failedDurable = deriveGlobalShellStatus({
    capabilities: readyCapabilities,
    serviceError: '',
    capture: { activeCount: 1, pendingCount: 0 },
    recording: {
      mode: 'durable',
      temporary: initialRecordingSnapshot(),
      durable: {
        ...initialDurableRecordingSnapshot(),
        status: 'failed',
        error: 'Finalization failed.',
      },
    },
    activeView: 'recordings',
  });
  assert.equal(failedDurable.activityState, 'failed');
  assert.equal(failedDurable.activityLabel, 'Recording error');
  assert.equal(failedDurable.activityTone, 'danger');
  assert.equal(failedDurable.backgroundBanner?.tone, 'danger');
  assert.equal(failedDurable.backgroundBanner?.detail, 'Finalization failed.');

  const settingsMarkup = renderToStaticMarkup(createElement(SettingsPanel, {
    capabilities: readyCapabilities,
    error: '',
    checking: false,
    checkResult: 'Local access verified.',
    onRetryConnection: () => {},
    onRunWriteCheck: () => {},
  }));
  assert.match(settingsMarkup, /Your local workspace/);
  assert.match(settingsMarkup, /Ready · SQLite/);
  assert.match(settingsMarkup, /Not implemented/);
  assert.match(settingsMarkup, /Local-only security &amp; storage boundaries/);

  const recordingsMarkup = renderToStaticMarkup(createElement(RecordingsPanel, {}));
  assert.match(recordingsMarkup, /Your saved videos/);
  assert.match(recordingsMarkup, /Save to computer/);
  assert.match(recordingsMarkup, /Loading local sessions…/);

  const guidesMarkup = renderToStaticMarkup(createElement(GuidesPanel, {}));
  assert.match(guidesMarkup, /How Local Creator Recorder works/);
  assert.match(guidesMarkup, /Quick start in 4 steps/);
  assert.match(guidesMarkup, /Crash recovery &amp; salvage/);
});

