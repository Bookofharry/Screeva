import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutoFrameController,
  applyFramingDeadZone,
  interpolateCrop,
  targetCropForFace,
  type AutoFrameRuntime,
} from '../apps/client/src/media/auto-framer.js';

const face = (x: number, y: number, width: number, height: number) => ({
  x, y, width, height, confidence: 0.9,
});

function fixture() {
  let now = 0;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const runtime: AutoFrameRuntime = {
    now: () => now,
    requestFrame: callback => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: id => {
      cancelled.push(id);
      callbacks.delete(id);
    },
  };
  const snapshots: ReturnType<AutoFrameController['getSnapshot']>[] = [];
  const controller = new AutoFrameController(snapshot => snapshots.push(snapshot), runtime);
  const step = (elapsed: number) => {
    const entry = [...callbacks.entries()][0];
    assert.ok(entry, 'expected one auto-frame animation callback');
    callbacks.delete(entry[0]);
    now += elapsed;
    entry[1](now);
  };
  return { controller, callbacks, cancelled, snapshots, step, now: () => now };
}

test('face targets are normalized, bounded and centered around the primary presenter', () => {
  const target = targetCropForFace(face(0.05, 0.3, 0.1, 0.15));
  assert.equal(target.x, 0);
  assert.ok(Math.abs(target.y - 0.17763157894736842) < 1e-12);
  assert.ok(Math.abs(target.width - 0.39473684210526316) < 1e-12);
  assert.equal(target.height, target.width);
  assert.deepEqual(targetCropForFace(face(0.3, 0.2, 0.4, 0.4)), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(targetCropForFace(face(Number.NaN, 0, 1, 1)), { x: 0, y: 0, width: 1, height: 1 });
});

test('dead-zone rejects small face jitter while interpolation remains bounded', () => {
  const current = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const jitter = { x: 0.21, y: 0.19, width: 0.51, height: 0.51 };
  assert.deepEqual(applyFramingDeadZone(current, jitter), current);
  assert.deepEqual(interpolateCrop(current, { x: 0, y: 0, width: 1, height: 1 }, 0), current);
  assert.deepEqual(interpolateCrop(current, { x: 0, y: 0, width: 1, height: 1 }, 4), { x: 0, y: 0, width: 1, height: 1 });
});

test('controller smooths toward the largest face without creating duplicate loops', () => {
  const f = fixture();
  f.controller.setEnabled(true);
  f.controller.updateFaces([
    face(0.75, 0.2, 0.08, 0.08),
    face(0.05, 0.25, 0.18, 0.24),
  ]);
  f.controller.updateFaces([face(0.05, 0.25, 0.18, 0.24)]);
  assert.equal(f.callbacks.size, 1);
  const target = f.controller.getSnapshot().target;
  assert.ok(target.x < 0.1, 'largest left-hand face should drive framing');
  f.step(16);
  const first = f.controller.getSnapshot().crop;
  assert.ok(first.width < 1 && first.width > target.width, 'crop should ease instead of jumping');
  for (let index = 0; index < 100 && f.callbacks.size; index++) f.step(16);
  const settled = f.controller.getSnapshot();
  assert.equal(settled.status, 'tracking');
  assert.ok(Math.abs(settled.crop.width - target.width) < 0.001);
  f.controller.dispose();
});

test('temporary face loss holds framing, then smoothly recenters', () => {
  const f = fixture();
  f.controller.setEnabled(true);
  f.controller.updateFaces([face(0.05, 0.25, 0.18, 0.2)]);
  for (let index = 0; index < 100 && f.callbacks.size; index++) f.step(16);
  const tracked = f.controller.getSnapshot().crop;
  f.controller.updateFaces([face(0.05, 0.25, 0.18, 0.2)], f.now());
  f.controller.updateFaces([], f.now());
  assert.equal(f.controller.getSnapshot().status, 'holding');
  f.step(1_400);
  assert.equal(f.controller.getSnapshot().status, 'holding');
  assert.deepEqual(f.controller.getSnapshot().crop, tracked);
  f.step(101);
  const recentring = f.controller.getSnapshot();
  assert.equal(recentring.status, 'recentering');
  assert.ok(recentring.crop.width > tracked.width && recentring.crop.width < 1);
  for (let index = 0; index < 100 && f.callbacks.size; index++) f.step(50);
  assert.deepEqual(f.controller.getSnapshot().crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(f.controller.getSnapshot().status, 'idle');
  f.controller.dispose();
});

test('disable, source replacement and dispose reset state and cancel owned work only', () => {
  const f = fixture();
  f.controller.setEnabled(true);
  f.controller.updateFaces([face(0.1, 0.1, 0.2, 0.2)]);
  assert.equal(f.callbacks.size, 1);
  f.controller.resetSource();
  assert.equal(f.callbacks.size, 0);
  assert.deepEqual(f.controller.getSnapshot().crop, { x: 0, y: 0, width: 1, height: 1 });
  f.controller.updateFaces([face(0.7, 0.7, 0.1, 0.1)]);
  assert.equal(f.callbacks.size, 1);
  f.controller.setEnabled(false);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.controller.getSnapshot().enabled, false);
  f.controller.dispose();
  f.controller.setEnabled(true);
  f.controller.updateFaces([face(0, 0, 0.1, 0.1)]);
  assert.equal(f.callbacks.size, 0);
  assert.ok(f.cancelled.length >= 2);
});
