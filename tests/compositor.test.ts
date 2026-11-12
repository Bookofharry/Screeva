import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasCompositor, clampNormalizedRect, containRect, coverCrop, normalizedToPixels, splitRegions, type CompositorRuntime } from '../apps/client/src/media/compositor.js';

class Track {
  kind = 'video'; readyState: MediaStreamTrackState = 'live'; stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
}
class Stream {
  track = new Track();
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
}
class Video {
  srcObject: MediaProvider | null = null; muted = false; playsInline = false;
  readyState = 4; videoWidth = 1920; videoHeight = 1080; plays = 0; pauses = 0;
  async play() { this.plays++; }
  pause() { this.pauses++; }
}
class Context {
  fillStyle: string | CanvasGradient | CanvasPattern = ''; font = ''; textAlign: CanvasTextAlign = 'start'; textBaseline: CanvasTextBaseline = 'alphabetic';
  fills: unknown[][] = []; texts: unknown[][] = []; draws: unknown[][] = []; saves = 0; restores = 0; clips = 0;
  fillRect(...args: number[]) { this.fills.push(args); }
  fillText(...args: [string, number, number]) { this.texts.push(args); }
  drawImage(...args: unknown[]) { this.draws.push(args); }
  save() { this.saves++; } restore() { this.restores++; } beginPath() {} roundRect() {} clip() { this.clips++; }
}
class Canvas {
  width = 0; height = 0; context = new Context(); captures: number[] = []; output = new Stream();
  getContext() { return this.context; }
  captureStream(fps?: number) { this.captures.push(fps ?? 0); return this.output as unknown as MediaStream; }
}
function fixture() {
  const canvas = new Canvas(); const videos = [new Video(), new Video()];
  let nextId = 0; const callbacks = new Map<number, FrameRequestCallback>(); const cancelled: number[] = [];
  const runtime: CompositorRuntime = {
    createVideo: () => videos.shift()!,
    requestFrame: callback => { const id = ++nextId; callbacks.set(id, callback); return id; },
    cancelFrame: id => { cancelled.push(id); callbacks.delete(id); },
  };
  // The engine consumes in screen/camera order; retain explicit references first.
  const screenVideo = videos[0]!; const cameraVideo = videos[1]!;
  const compositor = new CanvasCompositor(canvas as never, runtime);
  return { canvas, compositor, screenVideo, cameraVideo, callbacks, cancelled };
}

test('contain geometry preserves all pixels and centers letterboxing', () => {
  const fitted = containRect({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 1000, height: 1000 });
  assert.ok(Math.abs(fitted.x) < 1e-9); assert.ok(Math.abs(fitted.width - 1000) < 1e-9);
  assert.deepEqual({ y: fitted.y, height: fitted.height }, { y: 218.75, height: 562.5 });
  assert.deepEqual(containRect({ width: 1000, height: 1000 }, { x: 10, y: 20, width: 1600, height: 900 }), { x: 360, y: 20, width: 900, height: 900 });
  assert.deepEqual(containRect({ width: 0, height: 10 }, { x: 2, y: 3, width: 4, height: 5 }), { x: 2, y: 3, width: 0, height: 0 });
});

test('cover crop centers the source without stretching', () => {
  assert.deepEqual(coverCrop({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 500, height: 500 }), { x: 420, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(coverCrop({ width: 1000, height: 1000 }, { x: 0, y: 0, width: 1600, height: 900 }), { x: 0, y: 218.75, width: 1000, height: 562.5 });
  assert.deepEqual(coverCrop({ width: -1, height: 10 }, { x: 0, y: 0, width: 2, height: 2 }), { x: 0, y: 0, width: 0, height: 0 });
});

test('normalized PIP and split geometry clamp to the canvas', () => {
  assert.deepEqual(clampNormalizedRect({ x: 0.95, y: -1, width: 0.4, height: 2 }), { x: 0.6, y: 0, width: 0.4, height: 1 });
  assert.deepEqual(normalizedToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, { width: 1280, height: 720 }), { x: 320, y: 360, width: 640, height: 180 });
  assert.deepEqual(splitRegions({ width: 1000, height: 500 }, 0.65), { screen: { x: 0, y: 0, width: 650, height: 500 }, camera: { x: 650, y: 0, width: 350, height: 500 } });
  assert.equal(splitRegions({ width: 1000, height: 500 }, 1).screen.width, 800);
});

test('engine renders screen contain plus camera PIP cover using exact geometry', async t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  const screen = new Stream(); const camera = new Stream();
  f.screenVideo.videoWidth = 1920; f.screenVideo.videoHeight = 1080;
  f.cameraVideo.videoWidth = 640; f.cameraVideo.videoHeight = 480;
  f.compositor.setSources({ screen: screen as unknown as MediaStream, camera: camera as unknown as MediaStream });
  await Promise.resolve();
  f.compositor.setConfig({ layout: 'pip', pip: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } });
  const draws = f.canvas.context.draws.slice(-2);
  assert.deepEqual(draws[0]?.slice(1), [0, 0, 1280, 720]);
  assert.deepEqual(draws[1]?.slice(1), [0, 60, 640, 360, 640, 360, 320, 180]);
  assert.equal(f.canvas.context.clips > 0, true);
  assert.equal(screen.track.stops, 0); assert.equal(camera.track.stops, 0);
});

test('screen-only letterboxes and camera-only uses centered cover crop', t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  const screen = new Stream(); const camera = new Stream();
  f.screenVideo.videoWidth = 1000; f.screenVideo.videoHeight = 1000;
  f.cameraVideo.videoWidth = 1920; f.cameraVideo.videoHeight = 1080;
  f.compositor.setSources({ screen: screen as unknown as MediaStream, camera: camera as unknown as MediaStream });
  f.compositor.setConfig({ layout: 'screen' });
  assert.deepEqual(f.canvas.context.draws.at(-1)?.slice(1), [280, 0, 720, 720]);
  f.compositor.setConfig({ layout: 'camera' });
  assert.deepEqual(f.canvas.context.draws.at(-1)?.slice(1), [0, 0, 1920, 1080, 0, 0, 1280, 720]);
});

test('split respects proportions and resolution presets', t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  const screen = new Stream(); const camera = new Stream();
  f.compositor.setSources({ screen: screen as unknown as MediaStream, camera: camera as unknown as MediaStream });
  f.compositor.setConfig({ layout: 'split', split: 0.6, preset: '1080p' });
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  const draws = f.canvas.context.draws.slice(-2);
  assert.deepEqual(draws[0]?.slice(1), [0, 216, 1152, 648]);
  assert.deepEqual(draws[1]?.slice(5), [1152, 0, 768, 1080]);
  assert.equal(f.compositor.getConfig().fps, 30);
});

test('missing and ended sources fall back to the remaining source, then a placeholder', t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  const screen = new Stream(); const camera = new Stream();
  f.compositor.setConfig({ layout: 'split' });
  f.compositor.setSources({ screen: screen as unknown as MediaStream, camera: null });
  assert.deepEqual(f.canvas.context.draws.at(-1)?.slice(1), [0, 0, 1280, 720]);
  f.compositor.setSources({ screen: null, camera: camera as unknown as MediaStream });
  assert.equal(f.canvas.context.draws.at(-1)?.length, 9);
  camera.track.readyState = 'ended'; f.compositor.renderFrame();
  assert.equal(f.canvas.context.texts.at(-1)?.[0], 'Start screen or camera capture to compose a scene.');
  assert.equal(screen.track.stops, 0); assert.equal(camera.track.stops, 0);
});

test('source replacement detaches borrowed streams without stopping tracks', async () => {
  const f = fixture(); const first = new Stream(); const second = new Stream();
  f.compositor.setSources({ screen: first as unknown as MediaStream, camera: null });
  f.compositor.setSources({ screen: second as unknown as MediaStream, camera: null });
  await Promise.resolve();
  assert.equal(f.screenVideo.srcObject, second as unknown as MediaStream);
  assert.equal(f.screenVideo.pauses >= 2, true);
  f.compositor.dispose();
  assert.equal(first.track.stops, 0); assert.equal(second.track.stops, 0);
  assert.equal(f.screenVideo.srcObject, null);
});

test('start is idempotent, targets 30 fps and stop cancels exactly one loop', t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  f.compositor.start(); f.compositor.start();
  assert.equal(f.callbacks.size, 1);
  const first = [...f.callbacks.entries()][0]!; f.callbacks.delete(first[0]); first[1](0);
  const afterFirst = f.canvas.context.fills.length;
  const second = [...f.callbacks.entries()][0]!; f.callbacks.delete(second[0]); second[1](10);
  assert.equal(f.canvas.context.fills.length, afterFirst);
  const third = [...f.callbacks.entries()][0]!; f.callbacks.delete(third[0]); third[1](34);
  assert.equal(f.canvas.context.fills.length > afterFirst, true);
  f.compositor.stop(); f.compositor.stop(); assert.equal(f.cancelled.length, 1);
});

test('output capture is cached at 30 fps and only compositor-owned output stops on dispose', () => {
  const f = fixture(); const source = new Stream();
  f.compositor.setSources({ screen: source as unknown as MediaStream, camera: null });
  const first = f.compositor.getOutputStream(); const second = f.compositor.getOutputStream();
  assert.equal(first, second); assert.deepEqual(f.canvas.captures, [30]);
  f.compositor.dispose();
  assert.equal(f.canvas.output.track.stops, 1); assert.equal(source.track.stops, 0);
  assert.throws(() => f.compositor.getOutputStream(), /disposed/);
});

test('unsupported canvas output reports an error without affecting rendering', t => {
  const f = fixture(); t.after(() => f.compositor.dispose());
  f.canvas.captureStream = undefined as never;
  assert.throws(() => f.compositor.getOutputStream(), /unsupported/);
  f.compositor.renderFrame(); assert.equal(f.canvas.context.texts.length > 0, true);
});
