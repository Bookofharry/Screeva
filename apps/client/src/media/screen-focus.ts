import type { NormalizedRect, Size } from './compositor.js';

export interface NormalizedPoint { x: number; y: number }

export type ScreenFocusPresetId = 'code' | 'terminal' | 'browser';
export type ScreenFocusTransitionStatus = 'idle' | 'transitioning';

export interface ScreenFocusPresetDefinition {
  id: ScreenFocusPresetId;
  label: string;
}

export type ScreenFocusPresetMap = Record<ScreenFocusPresetId, NormalizedRect | null>;

export interface ScreenFocusTransitionSnapshot {
  status: ScreenFocusTransitionStatus;
  crop: NormalizedRect;
  target: NormalizedRect;
  reducedMotion: boolean;
}

export interface ScreenFocusTransitionRuntime {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export interface ScreenFocusTransitionOptions {
  durationMs?: number;
}

export const FULL_SCREEN_FOCUS: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
export const MIN_SCREEN_FOCUS_SPAN = 0.08;
export const SCREEN_FOCUS_PRESETS: readonly ScreenFocusPresetDefinition[] = [
  { id: 'code', label: 'Code' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'browser', label: 'Browser' },
];

const browserTransitionRuntime: ScreenFocusTransitionRuntime = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function normalizeScreenFocusRect(rect: NormalizedRect, minimum = MIN_SCREEN_FOCUS_SPAN): NormalizedRect {
  const safeMinimum = Math.min(1, Math.max(0.01, Number.isFinite(minimum) ? minimum : MIN_SCREEN_FOCUS_SPAN));
  const width = Math.min(1, Math.max(safeMinimum, Number.isFinite(rect.width) ? rect.width : 1));
  const height = Math.min(1, Math.max(safeMinimum, Number.isFinite(rect.height) ? rect.height : 1));
  return {
    x: Math.min(1 - width, clampUnit(rect.x)),
    y: Math.min(1 - height, clampUnit(rect.y)),
    width,
    height,
  };
}

export function normalizedFocusAspect(source: Size, destination: Size): number {
  if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return 1;
  return (destination.width / destination.height) * (source.height / source.width);
}

export function screenFocusFromPoints(
  start: NormalizedPoint,
  end: NormalizedPoint,
  normalizedAspect: number,
  minimum = MIN_SCREEN_FOCUS_SPAN,
): NormalizedRect | null {
  const startX = clampUnit(start.x);
  const startY = clampUnit(start.y);
  const endX = clampUnit(end.x);
  const endY = clampUnit(end.y);
  let width = Math.abs(endX - startX);
  let height = Math.abs(endY - startY);
  const aspect = Number.isFinite(normalizedAspect) && normalizedAspect > 0 ? normalizedAspect : 1;
  if (width / Math.max(height, Number.EPSILON) > aspect) width = height * aspect;
  else height = width / aspect;
  if (width < minimum || height < minimum) return null;
  const x = endX >= startX ? startX : startX - width;
  const y = endY >= startY ? startY : startY - height;
  return normalizeScreenFocusRect({ x, y, width, height }, minimum);
}

export function isFullScreenFocus(rect: NormalizedRect): boolean {
  const normalized = normalizeScreenFocusRect(rect);
  return Math.abs(normalized.x) < 0.001
    && Math.abs(normalized.y) < 0.001
    && Math.abs(normalized.width - 1) < 0.001
    && Math.abs(normalized.height - 1) < 0.001;
}

export function createEmptyScreenFocusPresets(): ScreenFocusPresetMap {
  return { code: null, terminal: null, browser: null };
}

export function saveScreenFocusPreset(
  presets: ScreenFocusPresetMap,
  id: ScreenFocusPresetId,
  focus: NormalizedRect,
): ScreenFocusPresetMap {
  return {
    code: presets.code ? { ...presets.code } : null,
    terminal: presets.terminal ? { ...presets.terminal } : null,
    browser: presets.browser ? { ...presets.browser } : null,
    [id]: normalizeScreenFocusRect(focus),
  };
}

export function sameScreenFocus(left: NormalizedRect, right: NormalizedRect, tolerance = 0.001): boolean {
  const a = normalizeScreenFocusRect(left);
  const b = normalizeScreenFocusRect(right);
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance;
}

export function interpolateScreenFocus(
  start: NormalizedRect,
  target: NormalizedRect,
  progress: number,
): NormalizedRect {
  const amount = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const from = normalizeScreenFocusRect(start);
  const to = normalizeScreenFocusRect(target);
  if (amount === 0) return from;
  if (amount === 1) return to;
  return normalizeScreenFocusRect({
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    width: from.width + (to.width - from.width) * amount,
    height: from.height + (to.height - from.height) * amount,
  });
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

export class ScreenFocusTransitionController {
  private readonly durationMs: number;
  private status: ScreenFocusTransitionStatus = 'idle';
  private crop = { ...FULL_SCREEN_FOCUS };
  private target = { ...FULL_SCREEN_FOCUS };
  private origin = { ...FULL_SCREEN_FOCUS };
  private startedAt = 0;
  private frameHandle: number | null = null;
  private reducedMotion = false;
  private disposed = false;

  constructor(
    private readonly onChange: (snapshot: ScreenFocusTransitionSnapshot) => void,
    private readonly runtime: ScreenFocusTransitionRuntime = browserTransitionRuntime,
    options: ScreenFocusTransitionOptions = {},
  ) {
    this.durationMs = Number.isFinite(options.durationMs)
      ? Math.max(0, options.durationMs ?? 420)
      : 420;
  }

  getSnapshot(): ScreenFocusTransitionSnapshot {
    return {
      status: this.status,
      crop: { ...this.crop },
      target: { ...this.target },
      reducedMotion: this.reducedMotion,
    };
  }

  transitionTo(focus: NormalizedRect): void {
    if (this.disposed) return;
    const next = normalizeScreenFocusRect(focus);
    if (this.status === 'transitioning' && sameScreenFocus(this.target, next)) return;
    this.target = next;
    if (this.reducedMotion || this.durationMs === 0 || sameScreenFocus(this.crop, next)) {
      this.finishImmediately();
      return;
    }
    this.origin = { ...this.crop };
    this.startedAt = this.runtime.now();
    this.status = 'transitioning';
    this.emit();
    if (this.frameHandle === null) this.frameHandle = this.runtime.requestFrame(this.tick);
  }

  setReducedMotion(reduced: boolean): void {
    if (this.disposed || this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    if (reduced && this.status === 'transitioning') this.finishImmediately();
    else this.emit();
  }

  resetSource(): void {
    if (this.disposed) return;
    this.target = { ...FULL_SCREEN_FOCUS };
    this.finishImmediately();
  }

  private readonly tick: FrameRequestCallback = timestamp => {
    this.frameHandle = null;
    if (this.disposed || this.status !== 'transitioning') return;
    const progress = Math.min(1, Math.max(0, (timestamp - this.startedAt) / this.durationMs));
    this.crop = interpolateScreenFocus(this.origin, this.target, easeInOutCubic(progress));
    if (progress >= 1) {
      this.crop = { ...this.target };
      this.status = 'idle';
    }
    this.emit();
    if (this.status === 'transitioning') this.frameHandle = this.runtime.requestFrame(this.tick);
  };

  private finishImmediately(): void {
    this.cancelFrame();
    this.crop = { ...this.target };
    this.origin = { ...this.target };
    this.status = 'idle';
    this.emit();
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
    this.cancelFrame();
  }
}

export function initialScreenFocusTransitionSnapshot(): ScreenFocusTransitionSnapshot {
  return {
    status: 'idle',
    crop: { ...FULL_SCREEN_FOCUS },
    target: { ...FULL_SCREEN_FOCUS },
    reducedMotion: false,
  };
}
