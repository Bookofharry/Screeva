export type CompositionLayout = 'screen' | 'camera' | 'pip' | 'split';
export type ResolutionPreset = '720p' | '1080p';

export interface Rect { x: number; y: number; width: number; height: number }
export type NormalizedRect = Rect;
export interface Size { width: number; height: number }
export interface CompositionConfig {
  layout: CompositionLayout;
  preset: ResolutionPreset;
  fps: 30;
  screen: NormalizedRect;
  pip: NormalizedRect;
  split: number;
}
export interface CompositionSources { screen: MediaStream | null; camera: MediaStream | null }

export const RESOLUTIONS: Record<ResolutionPreset, Size> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};
export const DEFAULT_SCREEN_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
export const DEFAULT_COMPOSITION: CompositionConfig = {
  layout: 'pip', preset: '720p', fps: 30,
  screen: { ...DEFAULT_SCREEN_RECT },
  pip: { x: 0.68, y: 0.64, width: 0.28, height: 0.28 }, split: 0.65,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function clampNormalizedRect(rect: NormalizedRect, minimum = 0.12, maximum = 1): NormalizedRect {
  const width = clamp(rect.width, minimum, maximum);
  const height = clamp(rect.height, minimum, maximum);
  const minX = Math.min(0, 1 - width);
  const maxX = Math.max(0, 1 - width);
  const minY = Math.min(0, 1 - height);
  const maxY = Math.max(0, 1 - height);
  return { x: clamp(rect.x, minX, maxX), y: clamp(rect.y, minY, maxY), width, height };
}

export function normalizedToPixels(rect: NormalizedRect, output: Size): Rect {
  const safe = clampNormalizedRect(rect, 0, 2);
  return { x: safe.x * output.width, y: safe.y * output.height, width: safe.width * output.width, height: safe.height * output.height };
}

export function containRect(source: Size, destination: Rect): Rect {
  if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return { ...destination, width: 0, height: 0 };
  const scale = Math.min(destination.width / source.width, destination.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: destination.x + (destination.width - width) / 2, y: destination.y + (destination.height - height) / 2, width, height };
}

export function coverCrop(source: Size, destination: Rect): Rect {
  if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const sourceAspect = source.width / source.height;
  const destinationAspect = destination.width / destination.height;
  if (sourceAspect > destinationAspect) {
    const width = source.height * destinationAspect;
    return { x: (source.width - width) / 2, y: 0, width, height: source.height };
  }
  const height = source.width / destinationAspect;
  return { x: 0, y: (source.height - height) / 2, width: source.width, height };
}

export function splitRegions(output: Size, proportion: number): { screen: Rect; camera: Rect } {
  const screenWidth = output.width * clamp(proportion, 0.2, 0.8);
  return {
    screen: { x: 0, y: 0, width: screenWidth, height: output.height },
    camera: { x: screenWidth, y: 0, width: output.width - screenWidth, height: output.height },
  };
}

interface VideoSurface {
  srcObject: MediaProvider | null;
  muted: boolean;
  playsInline: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  play(): Promise<void>;
  pause(): void;
}
interface RenderContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: ImageSmoothingQuality;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dWidth: number, dHeight: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sWidth: number, sHeight: number, dx: number, dy: number, dWidth: number, dHeight: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  roundRect(x: number, y: number, width: number, height: number, radii?: number | number[]): void;
  clip(): void;
}
interface CanvasSurface {
  width: number;
  height: number;
  getContext(contextId: '2d', options?: CanvasRenderingContext2DSettings): RenderContext | null;
  captureStream?(frameRate?: number): MediaStream;
}
export interface CompositorRuntime {
  createVideo(): VideoSurface;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

const browserRuntime: CompositorRuntime = {
  createVideo: () => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    return video;
  },
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
};

function hasLiveVideo(stream: MediaStream | null): boolean {
  return !!stream?.getVideoTracks().some(track => track.readyState === 'live');
}

export class CanvasCompositor {
  private readonly context: RenderContext;
  private readonly videos: Record<'screen' | 'camera', VideoSurface>;
  private sources: CompositionSources = { screen: null, camera: null };
  private config: CompositionConfig = {
    ...DEFAULT_COMPOSITION,
    screen: { ...DEFAULT_COMPOSITION.screen },
    pip: { ...DEFAULT_COMPOSITION.pip },
  };
  private running = false;
  private disposed = false;
  private frameHandle: number | null = null;
  private lastFrame = Number.NEGATIVE_INFINITY;
  private output: MediaStream | null = null;
  private sourceGeneration = { screen: 0, camera: 0 };

  constructor(private readonly canvas: CanvasSurface, private readonly runtime: CompositorRuntime = browserRuntime) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D rendering is unavailable.');
    this.context = context;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = 'high';
    this.videos = { screen: runtime.createVideo(), camera: runtime.createVideo() };
    this.applyResolution();
  }

  getConfig(): CompositionConfig {
    return {
      ...this.config,
      screen: { ...this.config.screen },
      pip: { ...this.config.pip },
    };
  }

  setConfig(patch: Partial<CompositionConfig>): void {
    if (this.disposed) return;
    this.config = {
      ...this.config, ...patch,
      fps: 30,
      screen: patch.screen ? clampNormalizedRect(patch.screen, 0.2, 2) : this.config.screen,
      pip: patch.pip ? clampNormalizedRect(patch.pip) : this.config.pip,
      split: patch.split === undefined ? this.config.split : clamp(patch.split, 0.2, 0.8),
    };
    this.applyResolution();
    this.renderFrame();
  }

  private applyResolution(): void {
    const resolution = RESOLUTIONS[this.config.preset];
    if (this.canvas.width !== resolution.width) this.canvas.width = resolution.width;
    if (this.canvas.height !== resolution.height) this.canvas.height = resolution.height;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = 'high';
  }

  setSources(sources: CompositionSources): void {
    if (this.disposed) return;
    for (const kind of ['screen', 'camera'] as const) {
      if (this.sources[kind] === sources[kind]) continue;
      this.sources = { ...this.sources, [kind]: sources[kind] };
      const generation = ++this.sourceGeneration[kind];
      const video = this.videos[kind];
      video.pause();
      video.srcObject = sources[kind];
      if (sources[kind]) void video.play().catch(() => {
        // A later replacement owns the element now; the next frame remains truthful.
        if (!this.disposed && generation === this.sourceGeneration[kind]) this.renderFrame();
      });
    }
    this.renderFrame();
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastFrame = Number.NEGATIVE_INFINITY;
    this.frameHandle = this.runtime.requestFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.frameHandle !== null) this.runtime.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private readonly tick: FrameRequestCallback = timestamp => {
    if (!this.running || this.disposed) return;
    if (timestamp - this.lastFrame >= 1000 / this.config.fps - 0.5) {
      this.renderFrame();
      this.lastFrame = timestamp;
    }
    this.frameHandle = this.runtime.requestFrame(this.tick);
  };

  renderFrame(): void {
    if (this.disposed) return;
    const output = { width: this.canvas.width, height: this.canvas.height };
    this.context.fillStyle = '#080e0c';
    this.context.fillRect(0, 0, output.width, output.height);
    const screenReady = hasLiveVideo(this.sources.screen) && this.videos.screen.readyState >= 2 && this.videos.screen.videoWidth > 0;
    const cameraReady = hasLiveVideo(this.sources.camera) && this.videos.camera.readyState >= 2 && this.videos.camera.videoWidth > 0;
    const full = { x: 0, y: 0, width: output.width, height: output.height };

    if (!screenReady && !cameraReady) {
      this.placeholder('Start screen or camera capture to compose a scene.', full);
      return;
    }
    const screenTarget = (this.config.layout === 'screen' || this.config.layout === 'pip')
      ? normalizedToPixels(this.config.screen, output)
      : full;
    if (!screenReady) { this.drawCamera(full); return; }
    if (!cameraReady) { this.drawScreen(screenTarget); return; }

    switch (this.config.layout) {
      case 'screen': this.drawScreen(screenTarget); break;
      case 'camera': this.drawCamera(full); break;
      case 'pip':
        this.drawScreen(screenTarget);
        this.drawCamera(normalizedToPixels(this.config.pip, output), true);
        break;
      case 'split': {
        const regions = splitRegions(output, this.config.split);
        this.drawScreen(regions.screen);
        this.drawCamera(regions.camera);
        break;
      }
    }
  }

  private drawScreen(destination: Rect): void {
    const video = this.videos.screen;
    const fitted = containRect({ width: video.videoWidth, height: video.videoHeight }, destination);
    this.context.drawImage(video as CanvasImageSource, fitted.x, fitted.y, fitted.width, fitted.height);
  }

  private drawCamera(destination: Rect, rounded = false): void {
    const video = this.videos.camera;
    const crop = coverCrop({ width: video.videoWidth, height: video.videoHeight }, destination);
    this.context.save();
    if (rounded) {
      this.context.beginPath();
      this.context.roundRect(destination.x, destination.y, destination.width, destination.height, Math.max(8, this.canvas.width * 0.008));
      this.context.clip();
    }
    this.context.drawImage(video as CanvasImageSource, crop.x, crop.y, crop.width, crop.height, destination.x, destination.y, destination.width, destination.height);
    this.context.restore();
  }

  private placeholder(message: string, destination: Rect): void {
    this.context.fillStyle = '#17221f';
    this.context.fillRect(destination.x, destination.y, destination.width, destination.height);
    this.context.fillStyle = '#b0c0b8';
    this.context.font = `${Math.max(16, Math.round(this.canvas.width / 55))}px system-ui, sans-serif`;
    this.context.textAlign = 'center'; this.context.textBaseline = 'middle';
    this.context.fillText(message, destination.x + destination.width / 2, destination.y + destination.height / 2);
  }

  getOutputStream(): MediaStream {
    if (this.disposed) throw new Error('Compositor is disposed.');
    if (this.output) return this.output;
    if (!this.canvas.captureStream) throw new Error('Canvas captureStream is unsupported.');
    this.output = this.canvas.captureStream(this.config.fps);
    return this.output;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    for (const kind of ['screen', 'camera'] as const) {
      ++this.sourceGeneration[kind];
      this.videos[kind].pause();
      this.videos[kind].srcObject = null;
    }
    for (const track of this.output?.getTracks() ?? []) track.stop();
    this.output = null;
    this.sources = { screen: null, camera: null };
  }
}
