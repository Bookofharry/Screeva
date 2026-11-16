import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MANUAL_CAMERA_FRAME,
  isDefaultManualCameraFrame,
  manualCameraCrop,
  normalizeManualCameraFrame,
} from '../apps/client/src/media/camera-framing.js';

test('manual camera controls normalize invalid, underflow and overflow values', () => {
  assert.deepEqual(normalizeManualCameraFrame({ zoom: 0, panX: -2, panY: 4 }), { zoom: 1, panX: 0, panY: 1 });
  assert.deepEqual(normalizeManualCameraFrame({ zoom: 9, panX: 0.25, panY: 0.75 }), { zoom: 2.6, panX: 0.25, panY: 0.75 });
  assert.deepEqual(normalizeManualCameraFrame({ zoom: Number.NaN, panX: Number.NaN, panY: Number.POSITIVE_INFINITY }), DEFAULT_MANUAL_CAMERA_FRAME);
});

test('manual zoom and pan produce a bounded normalized square source crop', () => {
  assert.deepEqual(manualCameraCrop(DEFAULT_MANUAL_CAMERA_FRAME), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(manualCameraCrop({ zoom: 2, panX: 0, panY: 1 }), { x: 0, y: 0.5, width: 0.5, height: 0.5 });
  assert.deepEqual(manualCameraCrop({ zoom: 2, panX: 1, panY: 0 }), { x: 0.5, y: 0, width: 0.5, height: 0.5 });
  const maximum = manualCameraCrop({ zoom: 2.6, panX: 1, panY: 1 });
  assert.ok(maximum.x >= 0 && maximum.y >= 0);
  assert.ok(maximum.x + maximum.width <= 1);
  assert.ok(maximum.y + maximum.height <= 1);
});

test('default detection compares normalized values without mutating its input', () => {
  const input = { zoom: Number.NaN, panX: 0.5, panY: 0.5 };
  assert.equal(isDefaultManualCameraFrame(input), true);
  assert.equal(Number.isNaN(input.zoom), true);
  assert.equal(isDefaultManualCameraFrame({ zoom: 1.01, panX: 0.5, panY: 0.5 }), false);
});
