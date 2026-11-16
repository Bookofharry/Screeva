import type { FaceBox } from './face-detector.js';
import { clampNormalizedRect, type NormalizedRect } from './compositor.js';

export type AutoFrameStatus = 'idle' | 'tracking' | 'holding' | 'recentering';

export interface AutoFrameSnapshot {
  enabled: boolean;
  status: AutoFrameStatus;
  crop: NormalizedRect;
  target: NormalizedRect;
  lastFaceAt: number | null;
}

export interface AutoFrameRuntime {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export interface AutoFrameOptions {
  holdMs?: number;
  trackingResponseMs?: number;
  recenterResponseMs?: number;
  minimumCrop?: number;
  faceCoverage?: number;
  movementDeadZone?: number;
  zoomDeadZone?: number;
}

const FULL_FRAME: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const DEFAULT_OPTIONS: Required<AutoFrameOptions> = {
  holdMs: 1_500,
  trackingResponseMs: 260,
  recenterResponseMs: 650,
  minimumCrop: 0.38,
  faceCoverage: 0.38,
  movementDeadZone: 0.045,
  zoomDeadZone: 0.05,
};

const browserRuntime: AutoFrameRuntime = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
};

function cloneRect(rect: NormalizedRect): NormalizedRect {
  return { ...rect };
}

function rectDistance(left: NormalizedRect, right: NormalizedRect): number {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

function finiteFace(face: FaceBox): boolean {
  return [face.x, face.y, face.width, face.height].every(Number.isFinite)
    && face.width > 0
    && face.height > 0;
}

export function targetCropForFace(
  face: FaceBox,
  options: Pick<Required<AutoFrameOptions>, 'minimumCrop' | 'faceCoverage'> = DEFAULT_OPTIONS,
): NormalizedRect {
  if (!finiteFace(face)) return cloneRect(FULL_FRAME);
  const span = Math.max(face.width, face.height);
  const size = Math.min(1, Math.max(options.minimumCrop, span / options.faceCoverage));
  const centerX = face.x + face.width / 2;
  const centerY = face.y + face.height / 2;
  return clampNormalizedRect({
    x: centerX - size / 2,
    y: centerY - size / 2,
    width: size,
    height: size,
  }, options.minimumCrop, 1);
}

export function applyFramingDeadZone(
  current: NormalizedRect,
  desired: NormalizedRect,
  movementDeadZone = DEFAULT_OPTIONS.movementDeadZone,
  zoomDeadZone = DEFAULT_OPTIONS.zoomDeadZone,
  minimumCrop = DEFAULT_OPTIONS.minimumCrop,
): NormalizedRect {
  const currentCenterX = current.x + current.width / 2;
  const currentCenterY = current.y + current.height / 2;
  const desiredCenterX = desired.x + desired.width / 2;
  const desiredCenterY = desired.y + desired.height / 2;
  const centerX = Math.abs(desiredCenterX - currentCenterX) <= current.width * movementDeadZone
    ? currentCenterX
    : desiredCenterX;
  const centerY = Math.abs(desiredCenterY - currentCenterY) <= current.height * movementDeadZone
    ? currentCenterY
    : desiredCenterY;
  const size = Math.abs(desired.width - current.width) <= current.width * zoomDeadZone
    ? current.width
    : desired.width;
  return clampNormalizedRect({
    x: centerX - size / 2,
    y: centerY - size / 2,
    width: size,
    height: size,
  }, minimumCrop, 1);
}

export function interpolateCrop(
  current: NormalizedRect,
  target: NormalizedRect,
  alpha: number,
  minimumCrop = DEFAULT_OPTIONS.minimumCrop,
): NormalizedRect {
  const safeAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  return clampNormalizedRect({
    x: current.x + (target.x - current.x) * safeAlpha,
    y: current.y + (target.y - current.y) * safeAlpha,
    width: current.width + (target.width - current.width) * safeAlpha,
    height: current.height + (target.height - current.height) * safeAlpha,
  }, minimumCrop, 1);
}

export class AutoFrameController {
  private readonly options: Required<AutoFrameOptions>;
  private enabled = false;
  private disposed = false;
  private status: AutoFrameStatus = 'idle';
  private crop = cloneRect(FULL_FRAME);
  private target = cloneRect(FULL_FRAME);
  private lastFaceAt: number | null = null;
  private lastFrameAt: number | null = null;
  private frameHandle: number | null = null;

  constructor(
    private readonly onChange: (snapshot: AutoFrameSnapshot) => void,
    private readonly runtime: AutoFrameRuntime = browserRuntime,
    options: AutoFrameOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getSnapshot(): AutoFrameSnapshot {
    return {
      enabled: this.enabled,
      status: this.status,
      crop: cloneRect(this.crop),
      target: cloneRect(this.target),
      lastFaceAt: this.lastFaceAt,
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.resetState();
    this.emit();
  }

  updateFaces(faces: readonly FaceBox[], observedAt = this.runtime.now()): void {
    if (this.disposed || !this.enabled) return;
    const primary = faces.reduce<FaceBox | undefined>((largest, face) => {
      if (!finiteFace(face)) return largest;
      if (!largest || face.width * face.height > largest.width * largest.height) return face;
      return largest;
    }, undefined);
    if (primary) {
      this.lastFaceAt = observedAt;
      const desired = targetCropForFace(primary, this.options);
      this.target = applyFramingDeadZone(
        this.crop,
        desired,
        this.options.movementDeadZone,
        this.options.zoomDeadZone,
        this.options.minimumCrop,
      );
      this.status = 'tracking';
      this.ensureFrame();
      return;
    }
    this.applyMissingFace(observedAt);
  }

  resetSource(): void {
    if (this.disposed) return;
    this.resetState();
    this.emit();
  }

  private applyMissingFace(now: number): void {
    if (this.lastFaceAt !== null && now - this.lastFaceAt < this.options.holdMs) {
      this.status = 'holding';
      this.ensureFrame();
      return;
    }
    this.target = cloneRect(FULL_FRAME);
    if (rectDistance(this.crop, FULL_FRAME) > 0.0005) {
      this.status = 'recentering';
      this.ensureFrame();
    } else {
      this.status = 'idle';
      this.cancelFrame();
      this.emit();
    }
  }

  private ensureFrame(): void {
    if (this.frameHandle !== null || !this.enabled || this.disposed) return;
    this.lastFrameAt = this.runtime.now();
    this.frameHandle = this.runtime.requestFrame(this.tick);
  }

  private readonly tick: FrameRequestCallback = timestamp => {
    this.frameHandle = null;
    if (!this.enabled || this.disposed) return;
    const previous = this.lastFrameAt ?? timestamp;
    const elapsed = Math.min(100, Math.max(0, timestamp - previous));
    this.lastFrameAt = timestamp;

    if (this.status === 'holding' && this.lastFaceAt !== null && timestamp - this.lastFaceAt >= this.options.holdMs) {
      this.target = cloneRect(FULL_FRAME);
      this.status = 'recentering';
    }

    const response = this.status === 'recentering'
      ? this.options.recenterResponseMs
      : this.options.trackingResponseMs;
    const alpha = response <= 0 ? 1 : 1 - Math.exp(-elapsed / response);
    this.crop = interpolateCrop(this.crop, this.target, alpha, this.options.minimumCrop);
    if (rectDistance(this.crop, this.target) <= 0.0005) this.crop = cloneRect(this.target);
    this.emit();

    const waitingForHold = this.status === 'holding';
    const moving = rectDistance(this.crop, this.target) > 0.0005;
    if (waitingForHold || moving) {
      this.frameHandle = this.runtime.requestFrame(this.tick);
    } else if (this.status === 'recentering') {
      this.status = 'idle';
      this.emit();
    }
  };

  private resetState(): void {
    this.cancelFrame();
    this.status = 'idle';
    this.crop = cloneRect(FULL_FRAME);
    this.target = cloneRect(FULL_FRAME);
    this.lastFaceAt = null;
    this.lastFrameAt = null;
  }

  private cancelFrame(): void {
    if (this.frameHandle !== null) this.runtime.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private emit(): void {
    this.onChange(this.getSnapshot());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.resetState();
  }
}

export function initialAutoFrameSnapshot(): AutoFrameSnapshot {
  return {
    enabled: false,
    status: 'idle',
    crop: cloneRect(FULL_FRAME),
    target: cloneRect(FULL_FRAME),
    lastFaceAt: null,
  };
}
