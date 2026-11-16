export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number | null;
}

export interface RawFaceDetection {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number | undefined;
}

export type FaceDetectorStatus = 'idle' | 'starting' | 'running' | 'no-face' | 'source-lost' | 'unsupported' | 'failed';

export interface FaceDetectorSnapshot {
  status: FaceDetectorStatus;
  faces: readonly FaceBox[];
  sampleCount: number;
  skippedSamples: number;
  lastInferenceMs: number | null;
  averageInferenceMs: number | null;
  samplingHz: number;
  error: string | null;
}

export interface FaceDetectorBackend {
  detect(source: CanvasImageSource): Promise<readonly RawFaceDetection[]>;
  dispose(): void;
}

interface DetectorVideo {
  srcObject: MediaProvider | null;
  muted: boolean;
  playsInline: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  play(): Promise<void>;
  pause(): void;
}

export interface FaceDetectorRuntime {
  createVideo(): DetectorVideo;
  createBackend(): FaceDetectorBackend | Promise<FaceDetectorBackend>;
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

interface NativeDetectedFace {
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence?: number | undefined;
}

interface NativeFaceDetectorInstance {
  detect(source: CanvasImageSource): Promise<readonly NativeDetectedFace[]>;
}

type NativeFaceDetectorConstructor = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => NativeFaceDetectorInstance;

export class FaceDetectorUnsupportedError extends Error {
  constructor(message = 'Local face detection is unavailable in this browser.') {
    super(message);
    this.name = 'FaceDetectorUnsupportedError';
  }
}

class NativeFaceDetectorBackend implements FaceDetectorBackend {
  private readonly detector: NativeFaceDetectorInstance;

  constructor() {
    const candidate = (globalThis as typeof globalThis & { FaceDetector?: NativeFaceDetectorConstructor }).FaceDetector;
    if (!candidate) throw new FaceDetectorUnsupportedError();
    this.detector = new candidate({ fastMode: true, maxDetectedFaces: 4 });
  }

  async detect(source: CanvasImageSource): Promise<readonly RawFaceDetection[]> {
    try {
      const detections = await this.detector.detect(source);
      return detections.map(({ boundingBox, confidence }) => ({
        x: boundingBox.x,
        y: boundingBox.y,
        width: boundingBox.width,
        height: boundingBox.height,
        ...(confidence === undefined ? {} : { confidence }),
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        throw new FaceDetectorUnsupportedError();
      }
      throw error;
    }
  }

  dispose(): void {
    // The native Shape Detection API currently exposes no close method.
  }
}

const browserRuntime: FaceDetectorRuntime = {
  createVideo: () => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    return video;
  },
  createBackend: async () => {
    try {
      const { createMediaPipeFaceDetectorBackend } = await import('./mediapipe-face-backend.js');
      return await createMediaPipeFaceDetectorBackend();
    } catch (error) {
      const candidate = (globalThis as typeof globalThis & { FaceDetector?: NativeFaceDetectorConstructor }).FaceDetector;
      if (candidate) return new NativeFaceDetectorBackend();
      throw error;
    }
  },
  now: () => performance.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: handle => window.clearTimeout(handle),
};

const INITIAL_SNAPSHOT: FaceDetectorSnapshot = {
  status: 'idle',
  faces: [],
  sampleCount: 0,
  skippedSamples: 0,
  lastInferenceMs: null,
  averageInferenceMs: null,
  samplingHz: 12,
  error: null,
};

export function initialFaceDetectorSnapshot(): FaceDetectorSnapshot {
  return { ...INITIAL_SNAPSHOT, faces: [] };
}

function safeNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function normalizeFaceBoxes(
  detections: readonly RawFaceDetection[],
  sourceWidth: number,
  sourceHeight: number,
): FaceBox[] {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return [];
  const normalized: FaceBox[] = [];
  for (const detection of detections) {
    const x = safeNumber(detection.x);
    const y = safeNumber(detection.y);
    const width = safeNumber(detection.width);
    const height = safeNumber(detection.height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
    const left = Math.max(0, Math.min(sourceWidth, x));
    const top = Math.max(0, Math.min(sourceHeight, y));
    const right = Math.max(left, Math.min(sourceWidth, x + width));
    const bottom = Math.max(top, Math.min(sourceHeight, y + height));
    if (right <= left || bottom <= top) continue;
    const confidence = detection.confidence === undefined || !Number.isFinite(detection.confidence)
      ? null
      : Math.max(0, Math.min(1, detection.confidence));
    normalized.push({
      x: left / sourceWidth,
      y: top / sourceHeight,
      width: (right - left) / sourceWidth,
      height: (bottom - top) / sourceHeight,
      confidence,
    });
  }
  return normalized.sort((a, b) => (b.width * b.height) - (a.width * a.height));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Face detection failed.';
}

export class LocalFaceDetector {
  private readonly video: DetectorVideo;
  private backend: FaceDetectorBackend | null = null;
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private generation = 0;
  private disposed = false;
  private inferenceRunning = false;
  private averageInferenceMs: number | null = null;
  private snapshot: FaceDetectorSnapshot = { ...INITIAL_SNAPSHOT };

  constructor(
    private readonly onChange: (snapshot: FaceDetectorSnapshot) => void,
    private readonly runtime: FaceDetectorRuntime = browserRuntime,
  ) {
    this.video = runtime.createVideo();
    this.video.muted = true;
    this.video.playsInline = true;
  }

  getSnapshot(): FaceDetectorSnapshot {
    return { ...this.snapshot, faces: this.snapshot.faces.map(face => ({ ...face })) };
  }

  start(stream: MediaStream): void {
    if (this.disposed || this.stream === stream) return;
    this.detach(false);
    const generation = ++this.generation;
    this.stream = stream;
    this.video.srcObject = stream;
    this.averageInferenceMs = null;
    this.update({ ...INITIAL_SNAPSHOT, status: 'starting' });
    void this.initialize(generation);
  }

  private async initialize(generation: number): Promise<void> {
    let backend: FaceDetectorBackend;
    try {
      backend = await this.runtime.createBackend();
    } catch (error) {
      this.fail(error, generation);
      return;
    }
    if (this.disposed || generation !== this.generation) {
      backend.dispose();
      return;
    }
    this.backend = backend;
    try {
      await this.video.play();
      if (this.disposed || generation !== this.generation) return;
      this.schedule(0, generation);
    } catch (error) {
      this.fail(error, generation);
    }
  }

  stop(): void {
    if (this.disposed) return;
    ++this.generation;
    this.detach(false);
    this.averageInferenceMs = null;
    this.update({ ...INITIAL_SNAPSHOT });
  }

  private schedule(delayMs: number, generation: number): void {
    if (this.disposed || generation !== this.generation || !this.stream) return;
    if (this.timer !== null) this.runtime.clearTimer(this.timer);
    this.timer = this.runtime.setTimer(() => {
      this.timer = null;
      void this.sample(generation);
    }, Math.max(0, delayMs));
  }

  private async sample(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || !this.stream || !this.backend) return;
    const live = this.stream.getVideoTracks().some(track => track.readyState === 'live');
    if (!live) {
      this.detach(false);
      this.update({ ...this.snapshot, status: 'source-lost', faces: [], samplingHz: 0, error: 'The camera source ended.' });
      return;
    }
    if (this.inferenceRunning) {
      this.update({ ...this.snapshot, skippedSamples: this.snapshot.skippedSamples + 1 });
      this.schedule(this.intervalMs(), generation);
      return;
    }
    if (this.video.readyState < 2 || this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
      this.update({ ...this.snapshot, status: 'starting', skippedSamples: this.snapshot.skippedSamples + 1 });
      this.schedule(50, generation);
      return;
    }

    this.inferenceRunning = true;
    const started = this.runtime.now();
    try {
      const detections = await this.backend.detect(this.video as CanvasImageSource);
      if (this.disposed || generation !== this.generation) return;
      const elapsed = Math.max(0, this.runtime.now() - started);
      this.averageInferenceMs = this.averageInferenceMs === null ? elapsed : (this.averageInferenceMs * 0.8) + (elapsed * 0.2);
      const faces = normalizeFaceBoxes(detections, this.video.videoWidth, this.video.videoHeight);
      this.update({
        ...this.snapshot,
        status: faces.length ? 'running' : 'no-face',
        faces,
        sampleCount: this.snapshot.sampleCount + 1,
        lastInferenceMs: elapsed,
        averageInferenceMs: this.averageInferenceMs,
        samplingHz: Math.round((1000 / this.intervalMs()) * 10) / 10,
        error: null,
      });
    } catch (error) {
      this.fail(error, generation);
      return;
    } finally {
      this.inferenceRunning = false;
    }
    this.schedule(this.intervalMs(), generation);
  }

  private intervalMs(): number {
    const targetInterval = 1000 / 12;
    const performanceInterval = (this.averageInferenceMs ?? 0) * 1.5;
    return Math.min(500, Math.max(targetInterval, performanceInterval));
  }

  private fail(error: unknown, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    const unsupported = error instanceof FaceDetectorUnsupportedError;
    this.detach(false);
    this.update({
      ...this.snapshot,
      status: unsupported ? 'unsupported' : 'failed',
      faces: [],
      samplingHz: 0,
      error: errorMessage(error),
    });
  }

  private update(snapshot: FaceDetectorSnapshot): void {
    this.snapshot = { ...snapshot, faces: snapshot.faces.map(face => ({ ...face })) };
    this.onChange(this.getSnapshot());
  }

  private detach(invalidate: boolean): void {
    if (invalidate) ++this.generation;
    if (this.timer !== null) this.runtime.clearTimer(this.timer);
    this.timer = null;
    this.backend?.dispose();
    this.backend = null;
    this.video.pause();
    this.video.srcObject = null;
    this.stream = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach(true);
    this.snapshot = { ...INITIAL_SNAPSHOT };
  }
}
