import type { NormalizedRect } from './compositor.js';

export type CameraFramingMode = 'manual' | 'auto';

export interface ManualCameraFrame {
  zoom: number;
  panX: number;
  panY: number;
}

export const MIN_CAMERA_ZOOM = 1;
export const MAX_CAMERA_ZOOM = 2.6;
export const DEFAULT_MANUAL_CAMERA_FRAME: ManualCameraFrame = {
  zoom: 1,
  panX: 0.5,
  panY: 0.5,
};

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));
}

export function normalizeManualCameraFrame(frame: ManualCameraFrame): ManualCameraFrame {
  return {
    zoom: clamp(frame.zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM, DEFAULT_MANUAL_CAMERA_FRAME.zoom),
    panX: clamp(frame.panX, 0, 1, DEFAULT_MANUAL_CAMERA_FRAME.panX),
    panY: clamp(frame.panY, 0, 1, DEFAULT_MANUAL_CAMERA_FRAME.panY),
  };
}

export function manualCameraCrop(frame: ManualCameraFrame): NormalizedRect {
  const normalized = normalizeManualCameraFrame(frame);
  const size = 1 / normalized.zoom;
  const travel = 1 - size;
  return {
    x: normalized.panX * travel,
    y: normalized.panY * travel,
    width: size,
    height: size,
  };
}

export function isDefaultManualCameraFrame(frame: ManualCameraFrame): boolean {
  const normalized = normalizeManualCameraFrame(frame);
  return Math.abs(normalized.zoom - DEFAULT_MANUAL_CAMERA_FRAME.zoom) < 0.001
    && Math.abs(normalized.panX - DEFAULT_MANUAL_CAMERA_FRAME.panX) < 0.001
    && Math.abs(normalized.panY - DEFAULT_MANUAL_CAMERA_FRAME.panY) < 0.001;
}
