import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FaceDetectorUnsupportedError,
  LocalFaceDetector,
  normalizeFaceBoxes,
  type FaceDetectorBackend,
  type FaceDetectorRuntime,
  type RawFaceDetection,
} from '../apps/client/src/media/face-detector.js';

class Track {
  readonly kind = 'video';
  readyState: MediaStreamTrackState = 'live';
  stops = 0;
  stop(): void { this.stops++; this.readyState = 'ended'; }
}

class Stream {
  readonly track = new Track();
  getVideoTracks(): Track[] { return [this.track]; }
  getTracks(): Track[] { return [this.track]; }
}

class Video {
  srcObject: MediaProvider | null = null;
  muted = false;
  playsInline = false;
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  plays = 0;
  pauses = 0;
  playResult: Promise<void> = Promise.resolve();
  play(): Promise<void> { this.plays++; return this.playResult; }
  pause(): void { this.pauses++; }
}

class Backend implements FaceDetectorBackend {
  results: readonly RawFaceDetection[] = [];
  detections = 0;
  disposals = 0;
  detectResult: Promise<readonly RawFaceDetection[]> | null = null;
  detect(): Promise<readonly RawFaceDetection[]> {
    this.detections++;
    return this.detectResult ?? Promise.resolve(this.results);
  }
  dispose(): void { this.disposals++; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}

function fixture(options: { backendFactory?: () => FaceDetectorBackend | Promise<FaceDetectorBackend> } = {}) {
  const video = new Video();
  const backend = new Backend();
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const runtime: FaceDetectorRuntime = {
    createVideo: () => video,
    createBackend: options.backendFactory ?? (() => backend),
    now: () => now,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: id => { timers.delete(id); },
  };
  const snapshots: ReturnType<LocalFaceDetector['getSnapshot']>[] = [];
  const detector = new LocalFaceDetector(snapshot => snapshots.push(snapshot), runtime);
  const runTimer = async (elapsed = 0) => {
    const entry = [...timers.entries()][0];
    assert.ok(entry, 'expected a scheduled sample');
    timers.delete(entry[0]);
    now += elapsed;
    entry[1].callback();
    await Promise.resolve();
    await Promise.resolve();
    return entry[1].delay;
  };
  return { detector, video, backend, snapshots, timers, runTimer, setNow: (value: number) => { now = value; } };
}

test('face boxes are normalized, clipped, confidence-clamped and largest-first', () => {
  assert.deepEqual(normalizeFaceBoxes([
    { x: 160, y: 120, width: 160, height: 120, confidence: 0.8 },
    { x: -40, y: -30, width: 200, height: 150, confidence: 4 },
    { x: 639, y: 479, width: 10, height: 10, confidence: Number.NaN },
    { x: 20, y: 20, width: -1, height: 20 },
  ], 640, 480), [
    { x: 0.25, y: 0.25, width: 0.25, height: 0.25, confidence: 0.8 },
    { x: 0, y: 0, width: 0.25, height: 0.25, confidence: 1 },
    { x: 639 / 640, y: 479 / 480, width: 1 / 640, height: 1 / 480, confidence: null },
  ]);
  assert.deepEqual(normalizeFaceBoxes([{ x: 0, y: 0, width: 1, height: 1 }], 0, 10), []);
});

test('detector samples a borrowed camera near 12 Hz and reports faces', async () => {
  const f = fixture();
  const stream = new Stream();
  const pending = deferred<readonly RawFaceDetection[]>();
  f.backend.detectResult = pending.promise;
  f.detector.start(stream as unknown as MediaStream);
  await settle();
  assert.equal(f.video.srcObject, stream as unknown as MediaStream);
  f.setNow(100);
  const timer = [...f.timers.entries()][0]!;
  f.timers.delete(timer[0]);
  timer[1].callback();
  await Promise.resolve();
  f.setNow(108);
  pending.resolve([{ x: 160, y: 120, width: 320, height: 240, confidence: 0.9 }]);
  await Promise.resolve();
  await Promise.resolve();
  const snapshot = f.detector.getSnapshot();
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.lastInferenceMs, 8);
  assert.equal(snapshot.samplingHz, 12);
  assert.deepEqual(snapshot.faces[0], { x: 0.25, y: 0.25, width: 0.5, height: 0.5, confidence: 0.9 });
  assert.ok([...f.timers.values()][0]!.delay >= 1000 / 12);
  f.detector.dispose();
  assert.equal(stream.track.stops, 0);
});

test('slow inference lowers sampling frequency without overlapping detection', async () => {
  const f = fixture();
  const stream = new Stream();
  const pending = deferred<readonly RawFaceDetection[]>();
  f.backend.detectResult = pending.promise;
  f.detector.start(stream as unknown as MediaStream);
  await settle();
  f.setNow(10);
  const timer = [...f.timers.entries()][0]!;
  f.timers.delete(timer[0]);
  timer[1].callback();
  await Promise.resolve();
  assert.equal(f.backend.detections, 1);
  f.setNow(210);
  pending.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  const snapshot = f.detector.getSnapshot();
  assert.equal(snapshot.averageInferenceMs, 200);
  assert.equal(snapshot.samplingHz, 3.3);
  assert.equal([...f.timers.values()][0]!.delay, 300);
  assert.equal(f.backend.detections, 1);
  f.detector.dispose();
});

test('replacement invalidates late results and never stops either source', async () => {
  const backends = [new Backend(), new Backend()];
  const pending = deferred<readonly RawFaceDetection[]>();
  backends[0]!.detectResult = pending.promise;
  let index = 0;
  const f = fixture({ backendFactory: () => backends[index++]! });
  const first = new Stream();
  const second = new Stream();
  f.detector.start(first as unknown as MediaStream);
  await settle();
  const timer = [...f.timers.entries()][0]!;
  f.timers.delete(timer[0]);
  timer[1].callback();
  await Promise.resolve();
  f.detector.start(second as unknown as MediaStream);
  await settle();
  pending.resolve([{ x: 0, y: 0, width: 640, height: 480 }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.detector.getSnapshot().sampleCount, 0);
  assert.equal(f.video.srcObject, second as unknown as MediaStream);
  assert.equal(backends[0]!.disposals, 1);
  assert.equal(first.track.stops, 0);
  assert.equal(second.track.stops, 0);
  f.detector.dispose();
});

test('ended source, unsupported runtime and detection errors are truthful and cleaned up', async t => {
  await t.test('ended camera becomes source-lost', async () => {
    const f = fixture();
    const stream = new Stream();
    f.detector.start(stream as unknown as MediaStream);
    await settle();
    stream.track.readyState = 'ended';
    await f.runTimer();
    assert.equal(f.detector.getSnapshot().status, 'source-lost');
    assert.match(f.detector.getSnapshot().error ?? '', /ended/i);
    assert.equal(f.video.srcObject, null);
    assert.equal(stream.track.stops, 0);
    f.detector.dispose();
  });

  await t.test('missing platform detector is unsupported', async () => {
    const f = fixture({ backendFactory: () => { throw new FaceDetectorUnsupportedError(); } });
    const stream = new Stream();
    f.detector.start(stream as unknown as MediaStream);
    await settle();
    assert.equal(f.detector.getSnapshot().status, 'unsupported');
    assert.equal(f.video.srcObject, null);
    assert.equal(stream.track.stops, 0);
    f.detector.dispose();
  });

  await t.test('backend rejection becomes failed', async () => {
    const f = fixture();
    const stream = new Stream();
    const pending = deferred<readonly RawFaceDetection[]>();
    f.backend.detectResult = pending.promise;
    f.detector.start(stream as unknown as MediaStream);
    await settle();
    const running = f.runTimer();
    pending.reject(new Error('detector crashed'));
    await running;
    assert.equal(f.detector.getSnapshot().status, 'failed');
    assert.equal(f.detector.getSnapshot().error, 'detector crashed');
    assert.equal(stream.track.stops, 0);
    f.detector.dispose();
  });
});

test('stop and dispose cancel timers, detach video, and preserve borrowed tracks', async () => {
  const f = fixture();
  const stream = new Stream();
  f.detector.start(stream as unknown as MediaStream);
  await settle();
  assert.equal(f.timers.size, 1);
  f.detector.stop();
  assert.equal(f.detector.getSnapshot().status, 'idle');
  assert.equal(f.timers.size, 0);
  assert.equal(f.video.srcObject, null);
  assert.equal(stream.track.stops, 0);
  f.detector.dispose();
  f.detector.start(stream as unknown as MediaStream);
  assert.equal(f.video.srcObject, null);
  assert.equal(stream.track.stops, 0);
});

test('late asynchronous backend creation is disposed without resurrecting a stopped source', async () => {
  const pending = deferred<FaceDetectorBackend>();
  const lateBackend = new Backend();
  const f = fixture({ backendFactory: () => pending.promise });
  const stream = new Stream();
  f.detector.start(stream as unknown as MediaStream);
  f.detector.stop();
  pending.resolve(lateBackend);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lateBackend.disposals, 1);
  assert.equal(lateBackend.detections, 0);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.video.plays, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(stream.track.stops, 0);
  f.detector.dispose();
});
