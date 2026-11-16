import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRecordingShortcut, type RecordingShortcutInput } from '../apps/client/src/ui/keyboard-shortcuts.js';

function shortcut(overrides: Partial<RecordingShortcutInput> = {}): RecordingShortcutInput {
  return {
    key: 'r',
    enabled: true,
    blocked: false,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    countdownActive: false,
    canStart: true,
    canStop: false,
    canPause: false,
    canResume: false,
    ...overrides,
  };
}

test('R starts when ready and stops only when the recorder exposes Stop', () => {
  assert.equal(resolveRecordingShortcut(shortcut()), 'start');
  assert.equal(resolveRecordingShortcut(shortcut({ canStart: false, canStop: true })), 'stop');
  assert.equal(resolveRecordingShortcut(shortcut({ canStart: false, canStop: false })), null);
});

test('P follows the recorder pause/resume state without inventing actions', () => {
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'p', canStart: false, canPause: true })), 'pause');
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'P', canStart: false, canResume: true })), 'resume');
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'p', canStart: false })), null);
});

test('Escape cancels only a live countdown', () => {
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'Escape', countdownActive: true })), 'cancel-countdown');
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'Escape' })), null);
});

test('off switch, target guards, repeats and browser modifiers suppress shortcuts', () => {
  for (const key of ['r', 'p', 'Escape']) {
    assert.equal(resolveRecordingShortcut(shortcut({ key, enabled: false, countdownActive: true, canPause: true })), null);
  }
  assert.equal(resolveRecordingShortcut(shortcut({ blocked: true })), null);
  assert.equal(resolveRecordingShortcut(shortcut({ repeat: true })), null);
  assert.equal(resolveRecordingShortcut(shortcut({ ctrlKey: true })), null);
  assert.equal(resolveRecordingShortcut(shortcut({ altKey: true })), null);
  assert.equal(resolveRecordingShortcut(shortcut({ metaKey: true })), null);
  assert.equal(resolveRecordingShortcut(shortcut({ key: 'x' })), null);
});
