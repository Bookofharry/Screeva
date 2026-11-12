export type AudioSourceKind = 'microphone' | 'display';
export type AudioMixMode = 'none' | 'microphone' | 'display' | 'combined';

export interface AudioSourceControl {
  gain: number;
  muted: boolean;
}

export interface AudioSourceState extends AudioSourceControl {
  available: boolean;
  trackMuted: boolean;
  level: number;
}

export interface AudioMixerState {
  mode: AudioMixMode;
  contextState: string;
  microphone: AudioSourceState;
  display: AudioSourceState;
}

export interface AudioMixerSources {
  microphone: MediaStream | null;
  display: MediaStream | null;
}

interface AudioParamSurface { value: number }
interface AudioNodeSurface {
  connect(destination: AudioNodeSurface): unknown;
  disconnect(): void;
}
interface GainNodeSurface extends AudioNodeSurface { gain: AudioParamSurface }
interface AnalyserNodeSurface extends AudioNodeSurface {
  fftSize: number;
  getByteTimeDomainData(data: Uint8Array<ArrayBuffer>): void;
}
interface DestinationNodeSurface extends AudioNodeSurface { stream: MediaStream }
interface AudioContextSurface {
  readonly state: string;
  createMediaStreamSource(stream: MediaStream): AudioNodeSurface;
  createGain(): GainNodeSurface;
  createAnalyser(): AnalyserNodeSurface;
  createMediaStreamDestination(): DestinationNodeSurface;
  resume(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface AudioMixerRuntime {
  createContext(): AudioContextSurface;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

interface AudioRoute {
  stream: MediaStream | null;
  source: AudioNodeSurface | null;
  gainNode: GainNodeSurface;
  analyser: AnalyserNodeSurface;
  tracks: Set<MediaStreamTrack>;
  streamCleanup: (() => void)[];
  trackCleanup: (() => void)[];
  control: AudioSourceControl;
  level: number;
}

const kinds: AudioSourceKind[] = ['microphone', 'display'];
const clampGain = (value: number) => Math.min(2, Math.max(0, Number.isFinite(value) ? value : 1));

const browserRuntime: AudioMixerRuntime = {
  createContext: () => {
    if (typeof AudioContext !== 'function') throw new Error('Web Audio is unavailable in this browser.');
    return new AudioContext() as unknown as AudioContextSurface;
  },
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
};

function defaultSourceState(): AudioSourceState {
  return { available: false, trackMuted: false, gain: 1, muted: false, level: 0 };
}

export function initialAudioMixerState(contextState = 'unavailable'): AudioMixerState {
  return { mode: 'none', contextState, microphone: defaultSourceState(), display: defaultSourceState() };
}

/** Borrows CaptureManager streams. It owns only its Web Audio graph and destination stream. */
export class AudioMixer {
  private readonly context: AudioContextSurface;
  private readonly destination: DestinationNodeSurface;
  private readonly routes: Record<AudioSourceKind, AudioRoute>;
  private readonly listeners = new Set<(state: AudioMixerState) => void>();
  private disposed = false;
  private running = false;
  private frameHandle: number | null = null;
  private lastMeterFrame = Number.NEGATIVE_INFINITY;
  private readonly meterData = new Uint8Array(256);
  private readonly contextChanged = () => this.publish();

  constructor(private readonly runtime: AudioMixerRuntime = browserRuntime) {
    this.context = runtime.createContext();
    this.destination = this.context.createMediaStreamDestination();
    const createRoute = (): AudioRoute => {
      const gainNode = this.context.createGain();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 256;
      gainNode.connect(analyser);
      analyser.connect(this.destination);
      return {
        stream: null,
        source: null,
        gainNode,
        analyser,
        tracks: new Set(),
        streamCleanup: [],
        trackCleanup: [],
        control: { gain: 1, muted: false },
        level: 0,
      };
    };
    this.routes = { microphone: createRoute(), display: createRoute() };
    this.context.addEventListener('statechange', this.contextChanged);
  }

  subscribe(listener: (state: AudioMixerState) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AudioMixerState {
    const stateFor = (kind: AudioSourceKind): AudioSourceState => {
      const route = this.routes[kind];
      const live = [...route.tracks].filter(track => track.readyState === 'live');
      const available = live.length > 0;
      const trackMuted = available && live.every(track => track.muted || !track.enabled);
      return {
        ...route.control,
        available,
        trackMuted,
        level: !available || trackMuted || route.control.muted || route.control.gain === 0 ? 0 : route.level,
      };
    };
    const microphone = stateFor('microphone');
    const display = stateFor('display');
    const microphoneActive = microphone.available && !microphone.trackMuted && !microphone.muted && microphone.gain > 0;
    const displayActive = display.available && !display.trackMuted && !display.muted && display.gain > 0;
    const mode: AudioMixMode = microphoneActive && displayActive ? 'combined' : microphoneActive ? 'microphone' : displayActive ? 'display' : 'none';
    return { mode, contextState: this.context.state, microphone, display };
  }

  setSources(sources: AudioMixerSources): void {
    if (this.disposed) return;
    this.setSource('microphone', sources.microphone);
    this.setSource('display', sources.display);
  }

  private setSource(kind: AudioSourceKind, stream: MediaStream | null): void {
    const route = this.routes[kind];
    if (route.stream === stream) return;
    this.clearSource(route);
    route.stream = stream;
    if (stream) {
      const changed = () => this.rebuildSource(kind);
      for (const event of ['addtrack', 'removetrack', 'inactive']) {
        stream.addEventListener(event, changed);
        route.streamCleanup.push(() => stream.removeEventListener(event, changed));
      }
      this.rebuildSource(kind);
    } else {
      route.level = 0;
      this.publish();
    }
  }

  private rebuildSource(kind: AudioSourceKind): void {
    if (this.disposed) return;
    const route = this.routes[kind];
    route.source?.disconnect();
    route.source = null;
    for (const cleanup of route.trackCleanup.splice(0)) cleanup();
    route.tracks = new Set(route.stream?.getAudioTracks() ?? []);
    for (const track of route.tracks) {
      const changed = () => {
        if (track.readyState === 'ended') this.rebuildSource(kind);
        else this.publish();
      };
      for (const event of ['ended', 'mute', 'unmute']) {
        track.addEventListener(event, changed);
        route.trackCleanup.push(() => track.removeEventListener(event, changed));
      }
    }
    if (route.stream && [...route.tracks].some(track => track.readyState === 'live')) {
      route.source = this.context.createMediaStreamSource(route.stream);
      route.source.connect(route.gainNode);
    } else {
      route.level = 0;
    }
    this.publish();
  }

  private clearSource(route: AudioRoute): void {
    route.source?.disconnect();
    route.source = null;
    for (const cleanup of route.trackCleanup.splice(0)) cleanup();
    for (const cleanup of route.streamCleanup.splice(0)) cleanup();
    route.stream = null;
    route.tracks.clear();
    route.level = 0;
  }

  setControl(kind: AudioSourceKind, patch: Partial<AudioSourceControl>): void {
    if (this.disposed) return;
    const route = this.routes[kind];
    route.control = {
      gain: patch.gain === undefined ? route.control.gain : clampGain(patch.gain),
      muted: patch.muted === undefined ? route.control.muted : patch.muted,
    };
    route.gainNode.gain.value = route.control.muted ? 0 : route.control.gain;
    if (route.control.muted || route.control.gain === 0) route.level = 0;
    this.publish();
  }

  async resume(): Promise<void> {
    if (this.disposed) throw new Error('Audio mixer is disposed.');
    if (this.context.state !== 'running') await this.context.resume();
    this.publish();
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastMeterFrame = Number.NEGATIVE_INFINITY;
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
    if (timestamp - this.lastMeterFrame >= 50) {
      this.sampleMeters();
      this.lastMeterFrame = timestamp;
    }
    this.frameHandle = this.runtime.requestFrame(this.tick);
  };

  sampleMeters(): void {
    if (this.disposed) return;
    for (const kind of kinds) {
      const route = this.routes[kind];
      const snapshot = this.getSnapshot()[kind];
      if (!snapshot.available || snapshot.trackMuted || snapshot.muted || snapshot.gain === 0 || this.context.state !== 'running') {
        route.level = 0;
        continue;
      }
      route.analyser.getByteTimeDomainData(this.meterData);
      let sum = 0;
      for (const sample of this.meterData) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      route.level = Math.min(1, Math.sqrt(sum / this.meterData.length) * Math.SQRT2);
    }
    this.publish();
  }

  getOutputStream(): MediaStream {
    if (this.disposed) throw new Error('Audio mixer is disposed.');
    return this.destination.stream;
  }

  private publish(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.context.removeEventListener('statechange', this.contextChanged);
    for (const kind of kinds) {
      const route = this.routes[kind];
      this.clearSource(route);
      route.gainNode.disconnect();
      route.analyser.disconnect();
    }
    this.destination.disconnect();
    for (const track of this.destination.stream.getTracks()) track.stop();
    this.listeners.clear();
    void this.context.close().catch(() => undefined);
  }
}
