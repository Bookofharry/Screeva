import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MediaPipeFaceDetectorBackend,
  createMediaPipeFaceDetectorBackend,
  type MediaPipeVisionModule,
} from '../apps/client/src/media/mediapipe-face-backend.js';

test('MediaPipe factory uses only self-hosted assets and video-mode face options', async () => {
  const calls: { wasmRoot?: string; fileset?: unknown; options?: unknown } = {};
  const detector = {
    detectForVideo: () => ({ detections: [] }),
    close() {},
  };
  const module: MediaPipeVisionModule = {
    FilesetResolver: {
      forVisionTasks: async wasmRoot => {
        calls.wasmRoot = wasmRoot;
        return { local: true };
      },
    },
    FaceDetector: {
      createFromOptions: async (fileset, options) => {
        calls.fileset = fileset;
        calls.options = options;
        return detector;
      },
    },
  };
  const backend = await createMediaPipeFaceDetectorBackend({
    assetRoot: '/local-vision/',
    loadModule: async () => module,
  });
  assert.equal(calls.wasmRoot, '/local-vision/wasm');
  assert.deepEqual(calls.fileset, { local: true });
  assert.deepEqual(calls.options, {
    baseOptions: { modelAssetPath: '/local-vision/models/blaze_face_short_range.tflite' },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
    minSuppressionThreshold: 0.3,
  });
  backend.dispose();
});

test('MediaPipe backend maps boxes and confidence with monotonic timestamps', async () => {
  const timestamps: number[] = [];
  let closes = 0;
  const times = [100, 100, Number.NaN];
  const backend = new MediaPipeFaceDetectorBackend({
    detectForVideo: (_source, timestamp) => {
      timestamps.push(timestamp);
      return {
        detections: [
          { boundingBox: { originX: 10, originY: 20, width: 30, height: 40 }, categories: [{ score: 0.91 }] },
          { categories: [{ score: 0.5 }] },
        ],
      };
    },
    close: () => { closes++; },
  }, () => times.shift() ?? 0);
  const source = {} as CanvasImageSource;
  assert.deepEqual(await backend.detect(source), [{ x: 10, y: 20, width: 30, height: 40, confidence: 0.91 }]);
  await backend.detect(source);
  await backend.detect(source);
  assert.equal(timestamps[0], 100);
  assert.ok(timestamps[1]! > timestamps[0]!);
  assert.ok(timestamps[2]! > timestamps[1]!);
  backend.dispose();
  backend.dispose();
  assert.equal(closes, 1);
  await assert.rejects(() => backend.detect(source), /closed/);
});

test('MediaPipe initialization failures remain visible to the lifecycle engine', async () => {
  const module: MediaPipeVisionModule = {
    FilesetResolver: { forVisionTasks: async () => { throw new Error('local wasm missing'); } },
    FaceDetector: { createFromOptions: async () => { throw new Error('must not run'); } },
  };
  await assert.rejects(
    () => createMediaPipeFaceDetectorBackend({ loadModule: async () => module }),
    /local wasm missing/,
  );
});
