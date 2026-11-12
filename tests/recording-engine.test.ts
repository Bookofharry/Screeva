import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AUDIO_BITS_PER_SECOND, DEFAULT_VIDEO_BITS_PER_SECOND, RECORDING_MIME_CANDIDATES, RecordingEngine, negotiateRecordingMimeType, type RecordingRuntime } from '../apps/client/src/media/recording-engine.js';

class Track extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stops = 0;
  constructor(readonly kind: 'video' | 'audio') { super(); }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  endSilently() { this.readyState = 'ended'; }
}

class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}

class Recorder extends EventTarget {
  state = 'inactive';
  readonly mimeType: string;
  readonly options: MediaRecorderOptions;
  starts: number[] = [];
  pauses = 0;
  resumes = 0;
  stops = 0;
  deferStart = false;
  finalData: Blob | null = null;

  constructor(readonly stream: MediaStream, options: MediaRecorderOptions) {
    super(); this.mimeType = options.mimeType ?? ''; this.options = options;
  }
  start(timeslice?: number) {
    this.starts.push(timeslice ?? 0);
    if (!this.deferStart) this.emitStart();
  }
  emitStart() { this.state = 'recording'; this.dispatchEvent(new Event('start')); }
  pause() { this.pauses++; this.state = 'paused'; }
  resume() { this.resumes++; this.state = 'recording'; }
  stop() {
    this.stops++;
    this.state = 'inactive';
    if (this.finalData) this.emitData(this.finalData);
    this.dispatchEvent(new Event('stop'));
  }
  emitData(data: Blob) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
  emitError(name = 'UnknownError') {
    const event = new Event('error');
    Object.defineProperty(event, 'error', { value: new DOMException('encoder', name) });
    this.dispatchEvent(event);
  }
}

function fixture(options: { supported?: string[]; maxBytes?: number; deferStart?: boolean; throwCreate?: boolean } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const revoked: string[] = [];
  const blobs: Blob[] = [];
  const recorders: Recorder[] = [];
  const streams: Stream[] = [];
  const supported = new Set(options.supported ?? [RECORDING_MIME_CANDIDATES[0]]);
  const runtime: RecordingRuntime = {
    isTypeSupported: mime => supported.has(mime),
    createRecorder: (stream, recorderOptions) => {
      if (options.throwCreate) throw new DOMException('unsupported', 'NotSupportedError');
      const recorder = new Recorder(stream, recorderOptions);
      recorder.deferStart = options.deferStart ?? false;
      recorders.push(recorder);
      return recorder;
    },
    createStream: tracks => { const stream = new Stream(tracks as unknown as Track[]); streams.push(stream); return stream as unknown as MediaStream; },
    createObjectURL: blob => { blobs.push(blob); return `blob:test-${blobs.length}`; },
    revokeObjectURL: url => { revoked.push(url); },
    now: () => now,
    setTimer: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer: handle => { timers.delete(handle); },
  };
  const engine = new RecordingEngine({ maxBytes: options.maxBytes ?? 1024, timesliceMs: 250 }, runtime);
  return {
    engine, recorders, streams, revoked, blobs, timers,
    advance(milliseconds: number) { now += milliseconds; for (const callback of timers.values()) callback(); },
  };
}

const media = (stream: Stream) => stream as unknown as MediaStream;

test('MIME negotiation follows preference order and reports unsupported configurations', () => {
  assert.equal(negotiateRecordingMimeType(type => type === 'video/webm'), 'video/webm');
  assert.equal(negotiateRecordingMimeType(type => type.includes('vp8')), 'video/webm;codecs=vp8,opus');
  assert.equal(negotiateRecordingMimeType(() => false), null);
});

test('records borrowed video/audio through pause, resume and stop with active-time duration', () => {
  const f = fixture(); const video = new Track('video'); const audio = new Track('audio');
  assert.equal(f.engine.start(media(new Stream([video])), media(new Stream([audio]))), true);
  assert.equal(f.engine.getSnapshot().status, 'recording');
  assert.equal(f.engine.getSnapshot().hasAudio, true);
  assert.deepEqual(f.streams[0]?.tracks, [video, audio]);
  assert.deepEqual(f.recorders[0]?.starts, [250]);
  assert.equal(f.recorders[0]?.options.videoBitsPerSecond, DEFAULT_VIDEO_BITS_PER_SECOND);
  assert.equal(f.recorders[0]?.options.audioBitsPerSecond, DEFAULT_AUDIO_BITS_PER_SECOND);
  assert.equal(f.engine.start(null, null), false);
  f.advance(1000);
  assert.equal(f.engine.pause(), true);
  assert.equal(f.engine.pause(), false);
  assert.equal(f.engine.getSnapshot().durationMs, 1000);
  f.advance(500);
  assert.equal(f.engine.getSnapshot().durationMs, 1000);
  assert.equal(f.engine.resume(), true);
  assert.equal(f.engine.resume(), false);
  f.advance(750);
  f.recorders[0]!.emitData(new Blob(['abc']));
  f.recorders[0]!.finalData = new Blob(['def']);
  assert.equal(f.engine.stop(), true);
  assert.equal(f.engine.stop(), false);
  const result = f.engine.getSnapshot();
  assert.equal(result.status, 'completed');
  assert.equal(result.durationMs, 1750);
  assert.equal(result.resultSize, 6);
  assert.equal(result.resultUrl, 'blob:test-1');
  assert.equal(result.mimeType, RECORDING_MIME_CANDIDATES[0]);
  assert.equal(video.stops, 0); assert.equal(audio.stops, 0);
  assert.equal(f.blobs[0]?.type, RECORDING_MIME_CANDIDATES[0]);
});

test('stop during starting is serialized and cannot duplicate encoder stops', () => {
  const f = fixture({ deferStart: true }); const video = new Track('video');
  assert.equal(f.engine.start(media(new Stream([video])), null), true);
  assert.equal(f.engine.getSnapshot().status, 'starting');
  assert.equal(f.engine.stop(), true);
  assert.equal(f.engine.stop(), false);
  assert.equal(f.recorders[0]?.stops, 0);
  f.recorders[0]!.finalData = new Blob(['frame']);
  f.recorders[0]!.emitStart();
  assert.equal(f.recorders[0]?.stops, 1);
  assert.equal(f.engine.getSnapshot().status, 'completed');
  assert.equal(video.stops, 0);
  assert.equal(f.recorders[0]?.options.audioBitsPerSecond, undefined);
});

test('validates explicit bitrate bounds before constructing a recorder', () => {
  assert.throws(() => new RecordingEngine({ videoBitsPerSecond: 0 }), /video bitrate/);
  assert.throws(() => new RecordingEngine({ audioBitsPerSecond: Number.NaN }), /audio bitrate/);
});

test('missing video, unsupported MIME and recorder construction failures become recoverable failed states', () => {
  const missing = fixture();
  assert.equal(missing.engine.start(null, null), false);
  assert.match(missing.engine.getSnapshot().error, /Canvas video output/);
  assert.equal(missing.engine.reset(), true);
  assert.equal(missing.engine.getSnapshot().status, 'idle');

  const unsupported = fixture({ supported: [] });
  assert.equal(unsupported.engine.start(media(new Stream([new Track('video')])), null), false);
  assert.match(unsupported.engine.getSnapshot().error, /does not support/);

  const rejected = fixture({ throwCreate: true });
  assert.equal(rejected.engine.start(media(new Stream([new Track('video')])), null), false);
  assert.match(rejected.engine.getSnapshot().error, /could not start/);
});

test('memory limit stops safely, discards partial chunks and leaves borrowed tracks live', () => {
  const f = fixture({ maxBytes: 5 }); const video = new Track('video'); const audio = new Track('audio');
  f.engine.start(media(new Stream([video])), media(new Stream([audio])));
  f.recorders[0]!.emitData(new Blob(['1234']));
  assert.equal(f.engine.getSnapshot().bytes, 4);
  f.recorders[0]!.emitData(new Blob(['56']));
  assert.equal(f.recorders[0]?.stops, 1);
  assert.equal(f.engine.getSnapshot().status, 'failed');
  assert.match(f.engine.getSnapshot().error, /memory limit/);
  assert.equal(f.engine.getSnapshot().bytes, 0);
  assert.equal(f.blobs.length, 0);
  assert.equal(video.stops, 0); assert.equal(audio.stops, 0);
});

test('streaming mode forwards each non-empty Blob without retaining a whole recording or enforcing the temporary cap', () => {
  const f = fixture({ maxBytes: 5 }); const video = new Track('video');
  const chunks: Blob[] = []; const events: string[] = [];
  assert.equal(f.engine.startStreaming(media(new Stream([video])), null, {
    onChunk: blob => { chunks.push(blob); events.push(`chunk:${blob.size}`); },
    onComplete: () => events.push('complete'),
    onFailure: message => events.push(`failed:${message}`),
  }), true);
  f.recorders[0]!.emitData(new Blob(['1234'], { type: 'video/webm' }));
  f.recorders[0]!.finalData = new Blob(['5678'], { type: 'video/webm' });
  assert.equal(f.engine.stop(), true);
  assert.deepEqual(events, ['chunk:4', 'chunk:4', 'complete']);
  assert.equal(chunks.length, 2);
  assert.equal(f.engine.getSnapshot().bytes, 8);
  assert.equal(f.engine.getSnapshot().resultUrl, '');
  assert.equal(f.blobs.length, 0);
  assert.equal(video.stops, 0);
});

test('encoder errors and source loss stop once and never stop source tracks', () => {
  const encoder = fixture(); const video = new Track('video');
  encoder.engine.start(media(new Stream([video])), null);
  encoder.recorders[0]!.emitError();
  assert.equal(encoder.engine.getSnapshot().status, 'failed');
  assert.equal(encoder.recorders[0]?.stops, 1);
  assert.equal(video.stops, 0);

  const source = fixture(); const sourceVideo = new Track('video'); const audio = new Track('audio');
  source.engine.start(media(new Stream([sourceVideo])), media(new Stream([audio])));
  audio.end();
  assert.equal(source.engine.getSnapshot().status, 'failed');
  assert.match(source.engine.getSnapshot().error, /Mixed audio output ended/);
  assert.equal(source.recorders[0]?.stops, 1);
  assert.equal(sourceVideo.stops, 0); assert.equal(audio.stops, 0);

  const silent = fixture(); const silentVideo = new Track('video');
  silent.engine.start(media(new Stream([silentVideo])), null);
  silentVideo.endSilently();
  silent.advance(250);
  assert.equal(silent.engine.getSnapshot().status, 'failed');
  assert.match(silent.engine.getSnapshot().error, /Canvas video output ended/);
  assert.equal(silentVideo.stops, 0);
});

test('reset and dispose revoke object URLs, release timers and stop only the encoder', async () => {
  const f = fixture(); const video = new Track('video'); const audio = new Track('audio');
  f.engine.start(media(new Stream([video])), media(new Stream([audio])));
  f.recorders[0]!.finalData = new Blob(['recording']);
  f.engine.stop();
  assert.equal(f.engine.getSnapshot().status, 'completed');
  assert.equal(f.engine.reset(), true);
  assert.deepEqual(f.revoked, ['blob:test-1']);
  assert.equal(f.engine.getSnapshot().status, 'idle');

  f.engine.start(media(new Stream([video])), media(new Stream([audio])));
  const recorder = f.recorders[1]!;
  f.engine.dispose(); f.engine.dispose();
  await Promise.resolve();
  assert.equal(recorder.stops, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(video.stops, 0); assert.equal(audio.stops, 0);
  assert.equal(f.engine.start(media(new Stream([video])), null), false);
});
