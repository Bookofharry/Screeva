import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecoveryInspection } from '../packages/shared/src/index.js';
import { describeRecoveryCondition, recoveryLaunchNotice, summarizeRecovery } from '../apps/client/src/ui/recovery-ui.js';

function inspection(overrides: Partial<RecoveryInspection> = {}): RecoveryInspection {
  return {
    schemaVersion: 1,
    sessionId: crypto.randomUUID(),
    title: 'Interrupted fixture',
    lifecycleStatus: 'interrupted',
    condition: 'valid-incomplete',
    committedChunkCount: 2,
    contiguousChunkCount: 2,
    verifiedBytes: 512,
    activeOperation: false,
    recoverable: true,
    message: 'Verified chunks are available.',
    output: null,
    ...overrides,
  };
}

test('recovery conditions use truthful human-readable labels', () => {
  assert.equal(describeRecoveryCondition('valid-incomplete').label, 'Verified incomplete');
  assert.equal(describeRecoveryCondition('finalizing').label, 'Finalization interrupted');
  assert.equal(describeRecoveryCondition('corrupt').tone, 'danger');
  assert.match(describeRecoveryCondition('empty').detail, /no acknowledged media bytes/i);
  assert.match(describeRecoveryCondition('active').detail, /still active/i);
});

test('recovery summary excludes active uploads from interruption attention', () => {
  const summary = summarizeRecovery([
    inspection(),
    inspection({ condition: 'active', recoverable: false, activeOperation: true }),
    inspection({ condition: 'corrupt', recoverable: false }),
    inspection({ condition: 'empty', recoverable: false, committedChunkCount: 0, contiguousChunkCount: 0, verifiedBytes: 0 }),
  ]);
  assert.deepEqual(summary, {
    totalCount: 4,
    attentionCount: 3,
    recoverableCount: 1,
    corruptCount: 1,
    unavailableCount: 0,
    emptyCount: 1,
    activeCount: 1,
  });
});

test('launch notice never promises corrupt, empty, or browser-only data is recoverable', () => {
  assert.equal(recoveryLaunchNotice(summarizeRecovery([inspection({ condition: 'active', recoverable: false })])), null);
  const recoverable = recoveryLaunchNotice(summarizeRecovery([inspection()]));
  assert.equal(recoverable?.tone, 'warning');
  assert.match(recoverable?.detail ?? '', /Browser-only data cannot be recovered/);
  const corrupt = recoveryLaunchNotice(summarizeRecovery([inspection({ condition: 'corrupt', recoverable: false })]));
  assert.equal(corrupt?.tone, 'danger');
  assert.match(corrupt?.detail ?? '', /cannot be presented as recovered/);
});
