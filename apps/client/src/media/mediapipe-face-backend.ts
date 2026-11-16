import type { FaceDetectorBackend, RawFaceDetection } from './face-detector.js';

interface MediaPipeBoundingBox {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

interface MediaPipeDetection {
  boundingBox?: MediaPipeBoundingBox | undefined;
  categories: Array<{ score: number }>;
}

interface MediaPipeDetector {
  detectForVideo(source: CanvasImageSource, timestampMs: number): { detections: MediaPipeDetection[] };
  close(): void;
}

export interface MediaPipeVisionModule {
  FilesetResolver: {
    forVisionTasks(wasmRoot: string): Promise<unknown>;
  };
  FaceDetector: {
    createFromOptions(
      fileset: unknown,
      options: {
        baseOptions: { modelAssetPath: string };
        runningMode: 'VIDEO';
        minDetectionConfidence: number;
        minSuppressionThreshold: number;
      },
    ): Promise<MediaPipeDetector>;
  };
}

export interface MediaPipeBackendOptions {
  assetRoot?: string | undefined;
  loadModule?: (() => Promise<MediaPipeVisionModule>) | undefined;
  now?: (() => number) | undefined;
}

const defaultModuleLoader = async (): Promise<MediaPipeVisionModule> => {
  const module = await import('@mediapipe/tasks-vision');
  return module as unknown as MediaPipeVisionModule;
};

export class MediaPipeFaceDetectorBackend implements FaceDetectorBackend {
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly detector: MediaPipeDetector,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async detect(source: CanvasImageSource): Promise<readonly RawFaceDetection[]> {
    if (this.disposed) throw new Error('MediaPipe face detector is closed.');
    const current = this.now();
    const timestamp = Number.isFinite(current)
      ? Math.max(current, this.lastTimestamp + 0.001)
      : this.lastTimestamp + 1;
    this.lastTimestamp = timestamp;
    const result = this.detector.detectForVideo(source, timestamp);
    return result.detections.flatMap(detection => {
      const box = detection.boundingBox;
      if (!box) return [];
      const score = detection.categories[0]?.score;
      return [{
        x: box.originX,
        y: box.originY,
        width: box.width,
        height: box.height,
        ...(score === undefined ? {} : { confidence: score }),
      }];
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detector.close();
  }
}

export async function createMediaPipeFaceDetectorBackend(
  options: MediaPipeBackendOptions = {},
): Promise<MediaPipeFaceDetectorBackend> {
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is unavailable for local face detection.');
  const assetRoot = (options.assetRoot ?? '/vision').replace(/\/$/, '');
  const module = await (options.loadModule ?? defaultModuleLoader)();
  const fileset = await module.FilesetResolver.forVisionTasks(`${assetRoot}/wasm`);
  const detector = await module.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${assetRoot}/models/blaze_face_short_range.tflite` },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
    minSuppressionThreshold: 0.3,
  });
  return new MediaPipeFaceDetectorBackend(detector, options.now);
}
