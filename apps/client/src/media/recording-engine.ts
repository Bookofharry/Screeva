export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'completed' | 'failed';

export interface RecordingSnapshot {
  status: RecordingStatus;
  durationMs: number;
  mimeType: string;
  bytes: number;
  maxBytes: number;
  hasAudio: boolean;
  resultUrl: string;
  resultSize: number;
  error: string;
}

interface MediaRecorderSurface {
  readonly state: string;
  readonly mimeType: string;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface RecordingRuntime {
  isTypeSupported(mimeType: string): boolean;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorderSurface;
  createStream(tracks: MediaStreamTrack[]): MediaStream;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(handle: number): void;
}

export interface RecordingOptions {
  maxBytes?: number;
  timesliceMs?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface RecordingChunkSink {
  onChunk(blob: Blob): void;
  onComplete(): void;
  onFailure(message: string): void;
}

export const DEFAULT_RECORDING_MEMORY_LIMIT = 128 * 1024 * 1024;
export const DEFAULT_VIDEO_BITS_PER_SECOND = 8_000_000;
export const DEFAULT_AUDIO_BITS_PER_SECOND = 128_000;
export const RECORDING_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

export function initialRecordingSnapshot(maxBytes = DEFAULT_RECORDING_MEMORY_LIMIT): RecordingSnapshot {
  return { status: 'idle', durationMs: 0, mimeType: '', bytes: 0, maxBytes, hasAudio: false, resultUrl: '', resultSize: 0, error: '' };
}

const browserRuntime: RecordingRuntime = {
  isTypeSupported: mimeType => typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(mimeType),
  createRecorder: (stream, options) => new MediaRecorder(stream, options),
  createStream: tracks => new MediaStream(tracks),
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => URL.revokeObjectURL(url),
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearTimer: handle => window.clearInterval(handle),
};

export function negotiateRecordingMimeType(isSupported: (mimeType: string) => boolean): string | null {
  for (const mimeType of RECORDING_MIME_CANDIDATES) if (isSupported(mimeType)) return mimeType;
  return null;
}

/** Records borrowed compositor/mixer tracks. It never owns or stops input tracks. */
export class RecordingEngine {
  private readonly runtime: RecordingRuntime;
  private readonly maxBytes: number;
  private readonly timesliceMs: number;
  private readonly videoBitsPerSecond: number;
  private readonly audioBitsPerSecond: number;
  private readonly listeners = new Set<(state: RecordingSnapshot) => void>();
  private status: RecordingStatus = 'idle';
  private mimeType = '';
  private error = '';
  private hasAudio = false;
  private chunks: Blob[] = [];
  private bytes = 0;
  private resultUrl = '';
  private resultSize = 0;
  private recorder: MediaRecorderSurface | null = null;
  private recorderCleanup: (() => void)[] = [];
  private sourceCleanup: (() => void)[] = [];
  private sourceTracks = new Set<MediaStreamTrack>();
  private sourceTimer: number | null = null;
  private failureReason = '';
  private stopRequested = false;
  private elapsedMs = 0;
  private segmentStartedAt: number | null = null;
  private durationTimer: number | null = null;
  private disposed = false;
  private sink: RecordingChunkSink | null = null;

  constructor(options: RecordingOptions = {}, runtime: RecordingRuntime = browserRuntime) {
    this.runtime = runtime;
    this.maxBytes = options.maxBytes ?? DEFAULT_RECORDING_MEMORY_LIMIT;
    this.timesliceMs = options.timesliceMs ?? 1000;
    this.videoBitsPerSecond = options.videoBitsPerSecond ?? DEFAULT_VIDEO_BITS_PER_SECOND;
    this.audioBitsPerSecond = options.audioBitsPerSecond ?? DEFAULT_AUDIO_BITS_PER_SECOND;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('Recording memory limit must be a positive safe integer.');
    if (!Number.isSafeInteger(this.timesliceMs) || this.timesliceMs <= 0) throw new Error('Recording timeslice must be a positive safe integer.');
    if (!Number.isSafeInteger(this.videoBitsPerSecond) || this.videoBitsPerSecond <= 0) throw new Error('Recording video bitrate must be a positive safe integer.');
    if (!Number.isSafeInteger(this.audioBitsPerSecond) || this.audioBitsPerSecond <= 0) throw new Error('Recording audio bitrate must be a positive safe integer.');
  }

  subscribe(listener: (state: RecordingSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RecordingSnapshot {
    return {
      status: this.status,
      durationMs: this.currentDuration(),
      mimeType: this.mimeType,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hasAudio: this.hasAudio,
      resultUrl: this.resultUrl,
      resultSize: this.resultSize,
      error: this.error,
    };
  }

  start(video: MediaStream | null, audio: MediaStream | null): boolean {
    return this.begin(video, audio, null);
  }

  /** Streams emitted blobs to a borrower without retaining them for preview. */
  startStreaming(video: MediaStream | null, audio: MediaStream | null, sink: RecordingChunkSink): boolean {
    return this.begin(video, audio, sink);
  }

  private begin(video: MediaStream | null, audio: MediaStream | null, sink: RecordingChunkSink | null): boolean {
    if (this.disposed || ['starting', 'recording', 'paused', 'stopping'].includes(this.status)) return false;
    this.clearResult();
    this.resetAttempt();
    this.sink = sink;

    const videoTrack = video?.getVideoTracks().find(track => track.readyState === 'live');
    if (!videoTrack) return this.rejectStart('Canvas video output is unavailable. Reload the page or use a supported browser.');
    const audioTrack = audio?.getAudioTracks().find(track => track.readyState === 'live');
    const mimeType = negotiateRecordingMimeType(this.runtime.isTypeSupported);
    if (!mimeType) return this.rejectStart('This browser does not support the required WebM MediaRecorder configuration. Try current desktop Chrome or Edge.');

    const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
    this.mimeType = mimeType;
    this.hasAudio = !!audioTrack;
    this.status = 'starting';
    this.publish();

    try {
      const stream = this.runtime.createStream(tracks);
      const recorderOptions: MediaRecorderOptions = { mimeType, videoBitsPerSecond: this.videoBitsPerSecond };
      if (audioTrack) recorderOptions.audioBitsPerSecond = this.audioBitsPerSecond;
      const recorder = this.runtime.createRecorder(stream, recorderOptions);
      this.recorder = recorder;
      this.observeRecorder(recorder);
      this.observeSources(tracks);
      recorder.start(this.timesliceMs);
      return true;
    } catch {
      const recorder = this.recorder;
      this.detachActive();
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* start already failed */ }
      }
      this.fail('Recording could not start with the selected WebM configuration.');
      return false;
    }
  }

  private rejectStart(message: string): false {
    this.status = 'failed';
    this.error = message;
    this.publish();
    return false;
  }

  private observeRecorder(recorder: MediaRecorderSurface): void {
    const started: EventListener = () => this.onStarted(recorder);
    const data: EventListener = event => this.onData(event as BlobEvent);
    const stopped: EventListener = () => this.onStopped(recorder);
    const failed: EventListener = event => {
      const detail = (event as Event & { error?: DOMException }).error;
      this.terminateWithFailure(detail?.name === 'UnknownError'
        ? 'The browser encoder failed. Stop other media work and try a shorter recording.'
        : 'Recording failed because the browser encoder reported an error.');
    };
    for (const [type, listener] of [['start', started], ['dataavailable', data], ['stop', stopped], ['error', failed]] as const) {
      recorder.addEventListener(type, listener);
      this.recorderCleanup.push(() => recorder.removeEventListener(type, listener));
    }
  }

  private observeSources(tracks: MediaStreamTrack[]): void {
    this.sourceTracks = new Set(tracks);
    for (const track of tracks) {
      const ended = () => this.terminateWithFailure(this.sourceFailure(track));
      track.addEventListener('ended', ended);
      this.sourceCleanup.push(() => track.removeEventListener('ended', ended));
    }
    this.sourceTimer = this.runtime.setTimer(() => {
      const ended = [...this.sourceTracks].find(track => track.readyState === 'ended');
      if (ended) this.terminateWithFailure(this.sourceFailure(ended));
    }, 250);
  }

  private onStarted(recorder: MediaRecorderSurface): void {
    if (this.disposed || this.recorder !== recorder) return;
    if (this.stopRequested || this.status === 'stopping') {
      if (recorder.state !== 'inactive') this.tryStopRecorder(recorder);
      return;
    }
    this.status = 'recording';
    this.segmentStartedAt = this.runtime.now();
    this.startDurationTimer();
    this.publish();
  }

  private onData(event: BlobEvent): void {
    if (this.disposed || !event.data.size || this.failureReason) return;
    if (this.sink) {
      this.bytes += event.data.size;
      try { this.sink.onChunk(event.data); }
      catch { this.terminateWithFailure('The durable chunk queue could not accept encoded data.'); }
      this.publish();
      return;
    }
    if (this.bytes + event.data.size > this.maxBytes) {
      this.chunks = [];
      this.bytes = 0;
      this.terminateWithFailure(`The temporary recording reached the ${formatBytes(this.maxBytes)} memory limit and was stopped. Record a shorter clip; durable storage is not implemented yet.`);
      return;
    }
    this.chunks.push(event.data);
    this.bytes += event.data.size;
    this.publish();
  }

  pause(): boolean {
    if (this.disposed || this.status !== 'recording' || !this.recorder) return false;
    try {
      this.commitDuration();
      this.recorder.pause();
      this.status = 'paused';
      this.stopDurationTimer();
      this.publish();
      return true;
    } catch {
      this.terminateWithFailure('The browser could not pause this recording.');
      return false;
    }
  }

  resume(): boolean {
    if (this.disposed || this.status !== 'paused' || !this.recorder) return false;
    try {
      this.recorder.resume();
      this.segmentStartedAt = this.runtime.now();
      this.status = 'recording';
      this.startDurationTimer();
      this.publish();
      return true;
    } catch {
      this.terminateWithFailure('The browser could not resume this recording.');
      return false;
    }
  }

  stop(): boolean {
    if (this.disposed || !['starting', 'recording', 'paused'].includes(this.status) || !this.recorder) return false;
    if (this.status === 'recording') this.commitDuration();
    this.stopDurationTimer();
    this.stopRequested = true;
    this.status = 'stopping';
    this.publish();
    if (this.recorder.state !== 'inactive') this.tryStopRecorder(this.recorder);
    return true;
  }

  abort(message: string): boolean {
    if (this.disposed || !['starting', 'recording', 'paused', 'stopping'].includes(this.status) || !this.recorder) return false;
    this.terminateWithFailure(message);
    return true;
  }

  private tryStopRecorder(recorder: MediaRecorderSurface): void {
    try { recorder.stop(); }
    catch { this.finishFailure(this.failureReason || 'The browser could not stop the recording cleanly.'); }
  }

  private terminateWithFailure(message: string): void {
    if (this.disposed || !this.recorder || ['completed', 'failed'].includes(this.status)) return;
    this.failureReason = message;
    if (this.status === 'recording') this.commitDuration();
    this.stopDurationTimer();
    this.status = 'stopping';
    this.error = message;
    this.publish();
    if (this.recorder.state === 'inactive') this.finishFailure(message);
    else this.tryStopRecorder(this.recorder);
  }

  private onStopped(recorder: MediaRecorderSurface): void {
    if (this.disposed || this.recorder !== recorder) return;
    if (this.failureReason) {
      this.finishFailure(this.failureReason);
      return;
    }
    if (this.status !== 'stopping') {
      const ended = [...this.sourceTracks].find(track => track.readyState === 'ended');
      this.finishFailure(ended ? this.sourceFailure(ended) : 'Recording stopped unexpectedly. Start a new recording when the outputs are ready.');
      return;
    }
    if (this.sink) {
      if (!this.bytes) {
        this.finishFailure('The browser produced an empty recording. Record for longer and try again.');
        return;
      }
      const sink = this.sink;
      this.detachActive();
      this.mimeType = recorder.mimeType || this.mimeType;
      this.resultSize = this.bytes;
      this.status = 'completed';
      this.error = '';
      this.sink = null;
      this.publish();
      try { sink.onComplete(); }
      catch { /* the durable controller owns completion errors */ }
      return;
    }
    const mimeType = recorder.mimeType || this.mimeType;
    const blob = new Blob(this.chunks, { type: mimeType });
    if (!blob.size) {
      this.finishFailure('The browser produced an empty recording. Record for longer and try again.');
      return;
    }
    this.detachActive();
    let resultUrl: string;
    try { resultUrl = this.runtime.createObjectURL(blob); }
    catch { this.finishFailure('The browser could not create a local preview URL for this recording.'); return; }
    this.mimeType = mimeType;
    this.resultSize = blob.size;
    this.bytes = blob.size;
    this.resultUrl = resultUrl;
    this.chunks = [];
    this.status = 'completed';
    this.error = '';
    this.publish();
  }

  private finishFailure(message: string): void {
    const sink = this.sink;
    this.sink = null;
    this.detachActive();
    this.chunks = [];
    this.bytes = 0;
    this.resultSize = 0;
    this.status = 'failed';
    this.error = message;
    this.publish();
    try { sink?.onFailure(message); }
    catch { /* the durable controller owns failure reporting */ }
  }

  private sourceFailure(track: MediaStreamTrack): string {
    return `${track.kind === 'video' ? 'Canvas video' : 'Mixed audio'} output ended while recording. Start a new recording after the source is ready.`;
  }

  reset(): boolean {
    if (this.disposed || ['starting', 'recording', 'paused', 'stopping'].includes(this.status)) return false;
    this.clearResult();
    this.resetAttempt();
    this.publish();
    return true;
  }

  private resetAttempt(): void {
    this.status = 'idle';
    this.mimeType = '';
    this.error = '';
    this.hasAudio = false;
    this.chunks = [];
    this.bytes = 0;
    this.failureReason = '';
    this.sink = null;
    this.stopRequested = false;
    this.elapsedMs = 0;
    this.segmentStartedAt = null;
    this.stopDurationTimer();
  }

  private clearResult(): void {
    if (this.resultUrl) this.runtime.revokeObjectURL(this.resultUrl);
    this.resultUrl = '';
    this.resultSize = 0;
  }

  private currentDuration(): number {
    return this.elapsedMs + (this.segmentStartedAt === null ? 0 : Math.max(0, this.runtime.now() - this.segmentStartedAt));
  }

  private commitDuration(): void {
    if (this.segmentStartedAt === null) return;
    this.elapsedMs += Math.max(0, this.runtime.now() - this.segmentStartedAt);
    this.segmentStartedAt = null;
  }

  private startDurationTimer(): void {
    this.stopDurationTimer();
    this.durationTimer = this.runtime.setTimer(() => this.publish(), 200);
  }

  private stopDurationTimer(): void {
    if (this.durationTimer === null) return;
    this.runtime.clearTimer(this.durationTimer);
    this.durationTimer = null;
  }

  private detachActive(): void {
    this.stopDurationTimer();
    for (const cleanup of this.recorderCleanup.splice(0)) cleanup();
    for (const cleanup of this.sourceCleanup.splice(0)) cleanup();
    if (this.sourceTimer !== null) this.runtime.clearTimer(this.sourceTimer);
    this.sourceTimer = null;
    this.sourceTracks.clear();
    this.recorder = null;
    this.segmentStartedAt = null;
  }

  private fail(message: string): void {
    this.status = 'failed';
    this.error = message;
    this.chunks = [];
    this.bytes = 0;
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const recorder = this.recorder;
    this.detachActive();
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* encoder is already unavailable */ }
    }
    this.clearResult();
    this.chunks = [];
    this.bytes = 0;
    this.listeners.clear();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KiB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MiB`;
}
