import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FULL_SCREEN_FOCUS,
  ScreenFocusTransitionController,
  createEmptyScreenFocusPresets,
  interpolateScreenFocus,
  isFullScreenFocus,
  normalizeScreenFocusRect,
  normalizedFocusAspect,
  sameScreenFocus,
  saveScreenFocusPreset,
  screenFocusFromPoints,
  type ScreenFocusTransitionRuntime,
} from '../apps/client/src/media/screen-focus.js';

test('screen focus rectangles clamp finite geometry inside normalized source bounds', () => {
  assert.deepEqual(normalizeScreenFocusRect({ x: -2, y: 0.95, width: 0.4, height: 0.4 }), { x: 0, y: 0.6, width: 0.4, height: 0.4 });
  assert.deepEqual(normalizeScreenFocusRect({ x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN }), FULL_SCREEN_FOCUS);
  assert.deepEqual(normalizeScreenFocusRect({ x: 0.8, y: 0.8, width: 0.001, height: 0.001 }), { x: 0.8, y: 0.8, width: 0.08, height: 0.08 });
});

test('selection preserves destination pixel aspect in normalized source coordinates', () => {
  const aspect = normalizedFocusAspect({ width: 640, height: 480 }, { width: 1280, height: 720 });
  assert.equal(aspect, 4 / 3);
  const forward = screenFocusFromPoints({ x: 0.75, y: 0.4 }, { x: 1, y: 0.65 }, aspect);
  assert.deepEqual(forward, { x: 0.75, y: 0.4, width: 0.25, height: 0.1875 });
  const reverse = screenFocusFromPoints({ x: 1, y: 0.65 }, { x: 0.75, y: 0.4 }, aspect);
  assert.deepEqual(reverse, { x: 0.75, y: 0.4625, width: 0.25, height: 0.1875 });
  assert.equal(screenFocusFromPoints({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.51 }, aspect), null);
});

test('aspect fallback and full-frame detection are defensive', () => {
  assert.equal(normalizedFocusAspect({ width: 0, height: 1 }, { width: 1, height: 1 }), 1);
  assert.equal(isFullScreenFocus(FULL_SCREEN_FOCUS), true);
  assert.equal(isFullScreenFocus({ x: 0, y: 0, width: 0.9, height: 1 }), false);
});

test('named presets clone normalized focus without mutating existing slots', () => {
  const empty = createEmptyScreenFocusPresets();
  const code = saveScreenFocusPreset(empty, 'code', { x: 0.8, y: -1, width: 0.4, height: 0.4 });
  assert.deepEqual(code.code, { x: 0.6, y: 0, width: 0.4, height: 0.4 });
  assert.deepEqual(empty, { code: null, terminal: null, browser: null });
  const terminal = saveScreenFocusPreset(code, 'terminal', { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
  assert.notEqual(terminal.code, code.code);
  assert.deepEqual(terminal.code, code.code);
  assert.equal(terminal.browser, null);
});

test('focus interpolation is bounded and reaches exact endpoints', () => {
  const start = { x: 0, y: 0, width: 1, height: 1 };
  const target = { x: 0.7, y: 0.6, width: 0.3, height: 0.4 };
  assert.deepEqual(interpolateScreenFocus(start, target, -1), start);
  assert.deepEqual(interpolateScreenFocus(start, target, 1), target);
  const middle = interpolateScreenFocus(start, target, 0.5);
  assert.deepEqual(middle, { x: 0.35, y: 0.3, width: 0.65, height: 0.7 });
  assert.equal(middle.x + middle.width <= 1, true);
  assert.equal(middle.y + middle.height <= 1, true);
  assert.equal(sameScreenFocus(middle, { ...middle, x: middle.x + 0.0005 }), true);
});

function transitionFixture() {
  let now = 0;
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const runtime: ScreenFocusTransitionRuntime = {
    now: () => now,
    requestFrame: callback => {
      const handle = ++id;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame: handle => {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
  };
  const snapshots: ReturnType<ScreenFocusTransitionController['getSnapshot']>[] = [];
  const controller = new ScreenFocusTransitionController(snapshot => snapshots.push(snapshot), runtime, { durationMs: 400 });
  const step = (elapsed: number) => {
    const entry = [...callbacks.entries()][0];
    assert.ok(entry, 'expected one focus transition callback');
    callbacks.delete(entry[0]);
    now += elapsed;
    entry[1](now);
  };
  return { controller, callbacks, cancelled, snapshots, step };
}

test('transition controller eases, retargets from current crop and owns only one loop', () => {
  const f = transitionFixture();
  const first = { x: 0.6, y: 0.2, width: 0.4, height: 0.5 };
  const second = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  f.controller.transitionTo(first);
  f.controller.transitionTo(first);
  assert.equal(f.callbacks.size, 1);
  f.step(200);
  const halfway = f.controller.getSnapshot().crop;
  assert.equal(f.controller.getSnapshot().status, 'transitioning');
  assert.ok(halfway.x > 0 && halfway.x < first.x);
  f.controller.transitionTo(second);
  assert.deepEqual(f.controller.getSnapshot().crop, halfway);
  assert.equal(f.callbacks.size, 1);
  f.step(400);
  assert.deepEqual(f.controller.getSnapshot().crop, second);
  assert.equal(f.controller.getSnapshot().status, 'idle');
  assert.equal(f.callbacks.size, 0);
  f.controller.dispose();
});

test('reduced motion, source reset and disposal finish safely and cancel pending work', () => {
  const f = transitionFixture();
  const focus = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  f.controller.transitionTo(focus);
  f.controller.setReducedMotion(true);
  assert.deepEqual(f.controller.getSnapshot().crop, focus);
  assert.equal(f.callbacks.size, 0);
  f.controller.setReducedMotion(false);
  f.controller.transitionTo(FULL_SCREEN_FOCUS);
  assert.equal(f.callbacks.size, 1);
  f.controller.resetSource();
  assert.deepEqual(f.controller.getSnapshot().crop, FULL_SCREEN_FOCUS);
  assert.equal(f.callbacks.size, 0);
  f.controller.transitionTo(focus);
  f.controller.dispose();
  assert.equal(f.callbacks.size, 0);
  f.controller.transitionTo(FULL_SCREEN_FOCUS);
  assert.deepEqual(f.controller.getSnapshot().target, focus);
  assert.ok(f.cancelled.length >= 3);
});
