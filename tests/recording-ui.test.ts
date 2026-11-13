import assert from 'node:assert/strict';
import test from 'node:test';
import { initialDurableRecordingSnapshot } from '../apps/client/src/media/durable-recording-engine.js';
import { initialRecordingSnapshot } from '../apps/client/src/media/recording-engine.js';
import {
  deriveRecordingDockActions,
  deriveUploadProgress,
  recordingDocumentTitle,
  shouldGuardBeforeUnload,
} from '../apps/client/src/ui/recording-ui.js';

test('recording dock actions preserve the requested primary hierarchy', () => {
  assert.deepEqual(deriveRecordingDockActions('durable', 'idle', 'idle'), {
    startLabel: 'Start recording', showPause: false, showResume: false, showStop: false, stopIsPrimary: false, showClear: false,
  });
  assert.deepEqual(deriveRecordingDockActions('durable', 'recording', 'recording'), {
    startLabel: null, showPause: true, showResume: false, showStop: true, stopIsPrimary: true, showClear: false,
  });
  assert.deepEqual(deriveRecordingDockActions('durable', 'paused', 'paused'), {
    startLabel: null, showPause: false, showResume: true, showStop: true, stopIsPrimary: false, showClear: false,
  });
  assert.deepEqual(deriveRecordingDockActions('durable', 'completed', 'completed'), {
    startLabel: 'Start new recording', showPause: false, showResume: false, showStop: false, stopIsPrimary: false, showClear: true,
  });
  assert.equal(deriveRecordingDockActions('durable', 'finalizing', 'completed').startLabel, null);
  assert.equal(deriveRecordingDockActions('durable', 'retrying', 'recording').showStop, false);
});

test('beforeunload guard is limited to unsafe recording and save phases', () => {
  const temporary = initialRecordingSnapshot();
  const durable = initialDurableRecordingSnapshot();
  assert.equal(shouldGuardBeforeUnload(temporary, durable), false);
  assert.equal(shouldGuardBeforeUnload({ status: 'starting' }, durable), false);
  assert.equal(shouldGuardBeforeUnload({ status: 'recording' }, durable), true);
  assert.equal(shouldGuardBeforeUnload(temporary, { status: 'creating' }), false);
  for (const status of ['recording', 'paused', 'stopping', 'uploading', 'retrying', 'finalizing'] as const) {
    assert.equal(shouldGuardBeforeUnload(temporary, { status }), true, status);
  }
  assert.equal(shouldGuardBeforeUnload(temporary, { status: 'completed' }), false);
  assert.equal(shouldGuardBeforeUnload(temporary, { status: 'failed' }), false);
});

test('upload progress and document title never imply unverified completion', () => {
  assert.equal(deriveUploadProgress(0, 0), 0);
  assert.equal(deriveUploadProgress(3, 2), 0.6);
  assert.equal(deriveUploadProgress(-1, Number.NaN), 0);
  assert.equal(recordingDocumentTitle('recording', '00:12'), '● REC 00:12 — Screeva');
  assert.equal(recordingDocumentTitle('paused', '00:12'), 'Paused 00:12 — Screeva');
  assert.equal(recordingDocumentTitle('finalizing', '00:12'), 'Saving recording… — Screeva');
  assert.equal(recordingDocumentTitle('failed', '00:12'), 'Screeva — Your Screen. Your Studio.');
});
