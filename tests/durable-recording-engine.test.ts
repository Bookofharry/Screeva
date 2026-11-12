import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DurableRecordingEngine, type DurableRecordingRuntime } from '../apps/client/src/media/durable-recording-engine.js';
import { RecordingChunkTransport, type ChunkTransportRuntime } from '../apps/client/src/media/chunk-transport.js';
import { RECORDING_MIME_CANDIDATES, RecordingEngine, type RecordingRuntime } from '../apps/client/src/media/recording-engine.js';
import { startServer } from '../apps/server/src/server.js';
import { recordingSessionSchema, responseSchema, type RecordingConfiguration } from '../packages/shared/src/index.js';

class Track extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stops = 0;
  constructor(readonly kind: 'video' | 'audio') { super(); }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
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
  finalData: Blob | null = null;
  stops = 0;
  constructor(options: MediaRecorderOptions) { super(); this.mimeType = options.mimeType ?? ''; }
  start() { this.state = 'recording'; this.dispatchEvent(new Event('start')); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() { this.stops++; this.state = 'inactive'; if (this.finalData) this.emitData(this.finalData); this.dispatchEvent(new Event('stop')); }
  emitData(blob: Blob) { const event = new Event('dataavailable'); Object.defineProperty(event, 'data', { value: blob }); this.dispatchEvent(event); }
}

function recorderHarness() {
  const recorders: Recorder[] = [];
  const runtime: RecordingRuntime = {
    isTypeSupported: type => type === RECORDING_MIME_CANDIDATES[0],
    createRecorder: (_stream, options) => { const recorder = new Recorder(options); recorders.push(recorder); return recorder; },
    createStream: tracks => new Stream(tracks as unknown as Track[]) as unknown as MediaStream,
    createObjectURL: () => { throw new Error('durable recording must not create object URLs'); },
    revokeObjectURL: () => undefined,
    now: () => 1000,
    setTimer: () => 1,
    clearTimer: () => undefined,
  };
  return { engine: new RecordingEngine({ timesliceMs: 1000, maxBytes: 1 }, runtime), recorders };
}

function mappedRuntimes(origin: string, intercept?: (input: string, init: RequestInit) => Promise<Response> | null) {
  let nextTimer = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const mappedFetch = async (input: string, init: RequestInit) => {
    const intercepted = intercept?.(input, init);
    if (intercepted) return intercepted;
    const headers = new Headers(init.headers);
    headers.set('Sec-Fetch-Site', 'same-origin');
    if ((init.method ?? 'GET') !== 'GET') headers.set('Origin', origin);
    return fetch(origin + input, { ...init, headers });
  };
  const timer = {
    setTimer(callback: () => void, milliseconds: number) {
      const id = ++nextTimer;
      timers.set(id, setTimeout(() => { timers.delete(id); callback(); }, milliseconds));
      return id;
    },
    clearTimer(id: number) { const handle = timers.get(id); if (handle) clearTimeout(handle); timers.delete(id); },
  };
  const controller: DurableRecordingRuntime = { fetch: mappedFetch, ...timer };
  const transport: ChunkTransportRuntime = { fetch: mappedFetch, random: () => 0.5, ...timer };
  return { controller, transport, timers };
}

const configuration: RecordingConfiguration = {
  layout: 'screen', resolution: '720p', fps: 30,
  videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'none',
};
const media = (stream: Stream) => stream as unknown as MediaStream;

async function eventually(assertion: () => void, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
}

test('durable controller creates a session, streams ordered chunks, drains ACKs, retries finalization and reports completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-durable-engine-'));
  const running = await startServer({
    port: 0, dataDirectory: path.join(root, 'data'),
    ffprobe: { probe: async () => ({ formatName: 'matroska,webm', durationMs: 1000, video: { codec: 'vp9', width: 1280, height: 720 }, audio: null }) },
  });
  let finalizeCalls = 0;
  const runtimes = mappedRuntimes(running.origin, (input) => {
    if (input.endsWith('/finalize') && ++finalizeCalls === 1) return Promise.reject(new TypeError('synthetic network outage'));
    return null;
  });
  const recorder = recorderHarness();
  const controller = new DurableRecordingEngine({
    engine: recorder.engine,
    runtime: runtimes.controller,
    createTransport: (sessionId, writeToken, onBackpressure) => new RecordingChunkTransport({
      sessionId, writeToken, onBackpressure, baseRetryDelayMs: 1, maxRetryDelayMs: 2, jitterRatio: 0,
    }, runtimes.transport),
  });
  const states: string[] = [];
  const unsubscribe = controller.subscribe(state => states.push(state.status));
  const video = new Track('video');
  try {
    assert.equal(await controller.start(media(new Stream([video])), null, 'Durable integration', configuration), true);
    const native = recorder.recorders[0]!;
    native.emitData(new Blob(['first-'], { type: 'video/webm;codecs=vp9,opus' }));
    native.emitData(new Blob(['second-'], { type: 'video/webm;codecs=vp9,opus' }));
    native.finalData = new Blob(['third'], { type: 'video/webm;codecs=vp9,opus' });
    assert.equal(controller.stop(), true);
    await eventually(() => assert.equal(controller.getSnapshot().status, 'completed'));
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.acknowledgedChunks, 3);
    assert.equal(snapshot.outstandingBytes, 0);
    assert.equal(snapshot.output?.expectedChunkCount, 3);
    assert.equal(finalizeCalls, 2);
    assert.ok(states.includes('recording'));
    assert.ok(states.includes('uploading'));
    assert.ok(states.includes('finalizing'));
    assert.equal(video.stops, 0);
    const stored = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${snapshot.sessionId}`)).json());
    assert.ok(stored.ok);
    assert.equal(stored.data.status, 'completed');
    assert.equal(stored.data.chunks.committedCount, 3);
  } finally {
    unsubscribe(); await controller.dispose(); await running.close(); await rm(root, { recursive: true, force: true });
  }
});

test('source loss and terminal authorization failure stop safely without claiming completion or stopping borrowed tracks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-durable-failure-'));
  const running = await startServer({ port: 0, dataDirectory: path.join(root, 'data') });
  const runtimes = mappedRuntimes(running.origin);
  const recorder = recorderHarness();
  const video = new Track('video');
  const controller = new DurableRecordingEngine({
    engine: recorder.engine, runtime: runtimes.controller,
    createTransport: (sessionId, _writeToken, onBackpressure) => new RecordingChunkTransport({ sessionId, writeToken: 'x'.repeat(43), onBackpressure, maxAttempts: 1 }, runtimes.transport),
  });
  try {
    assert.equal(await controller.start(media(new Stream([video])), null, 'Failure integration', configuration), true);
    recorder.recorders[0]!.emitData(new Blob(['unacknowledged'], { type: 'video/webm' }));
    await eventually(() => assert.equal(controller.getSnapshot().status, 'failed'));
    assert.match(controller.getSnapshot().error, /authorize|Reload/i);
    assert.equal(controller.getSnapshot().output, null);
    assert.equal(video.stops, 0);
  } finally { await controller.dispose(); await running.close(); await rm(root, { recursive: true, force: true }); }

  const sourceRecorder = recorderHarness();
  const sourceVideo = new Track('video');
  const inertTransport = {
    state: { status: 'idle', queuedItems: 0, outstandingBytes: 0, pendingItems: 0, pendingBytes: 0, maxItems: 1, maxBytes: 100,
      attempts: 0, totalAttempts: 0, acknowledgedChunks: 0, activeSequence: null, retryDelayMs: 0, backpressured: false, error: '' } as const,
    start: () => true, enqueue: async () => undefined, drain: async () => 0,
    getSnapshot() { return this.state; }, subscribe: () => () => undefined, dispose: async () => undefined,
  };
  const source = new DurableRecordingEngine({
    engine: sourceRecorder.engine,
    runtime: {
      fetch: async (input) => input.endsWith('/bootstrap')
        ? new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { writeToken: 'a'.repeat(43) } }))
        : input.endsWith('/heartbeat')
          ? new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { active: true, expiresAt: '2026-11-11T00:00:10.000Z' } }))
          : new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { schemaVersion: 1, id: '123e4567-e89b-42d3-a456-426614174000', title: 'Source', status: 'idle', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z', configuration, chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 }, output: null } })),
      setTimer: () => 1, clearTimer: () => undefined,
    },
    createTransport: () => inertTransport,
  });
  assert.equal(await source.start(media(new Stream([sourceVideo])), null, 'Source', configuration), true);
  sourceVideo.end();
  assert.equal(source.getSnapshot().status, 'failed');
  assert.match(source.getSnapshot().error, /Canvas video output ended/);
  assert.equal(sourceVideo.stops, 0);
  await source.dispose();
});

test('duplicate start, queue memory saturation and reload disposal cannot silently complete a session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-durable-races-'));
  const running = await startServer({ port: 0, dataDirectory: path.join(root, 'data') });
  const runtimes = mappedRuntimes(running.origin);
  const recorder = recorderHarness();
  const video = new Track('video');
  const controller = new DurableRecordingEngine({
    engine: recorder.engine, runtime: runtimes.controller,
    createTransport: (sessionId, writeToken, onBackpressure) => new RecordingChunkTransport({
      sessionId, writeToken, onBackpressure, queue: { maxItems: 1, maxBytes: 5 }, highWaterItems: 1, highWaterBytes: 5,
    }, runtimes.transport),
  });
  try {
    const starting = controller.start(media(new Stream([video])), null, 'Race fixture', configuration);
    assert.equal(await controller.start(media(new Stream([video])), null, 'Duplicate', configuration), false);
    assert.equal(await starting, true);
    recorder.recorders[0]!.emitData(new Blob(['123456'], { type: 'video/webm' }));
    await eventually(() => assert.equal(controller.getSnapshot().status, 'failed'));
    assert.match(controller.getSnapshot().error, /capacity|memory limit/i);
    assert.equal(controller.getSnapshot().output, null);
    assert.equal(video.stops, 0);
  } finally { await controller.dispose(); }

  const reloadRecorder = recorderHarness();
  const reloadVideo = new Track('video');
  const reload = new DurableRecordingEngine({
    engine: reloadRecorder.engine, runtime: runtimes.controller,
    createTransport: (sessionId, writeToken, onBackpressure) => new RecordingChunkTransport({ sessionId, writeToken, onBackpressure }, runtimes.transport),
  });
  assert.equal(await reload.start(media(new Stream([reloadVideo])), null, 'Reload fixture', configuration), true);
  reloadRecorder.recorders[0]!.emitData(new Blob(['committed-before-reload'], { type: 'video/webm' }));
  await eventually(() => assert.equal(reload.getSnapshot().acknowledgedChunks, 1));
  const sessionId = reload.getSnapshot().sessionId;
  await reload.dispose();
  const stored = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${sessionId}`)).json());
  assert.ok(stored.ok);
  assert.notEqual(stored.data.status, 'completed');
  assert.equal(stored.data.output, null);
  assert.equal(stored.data.chunks.committedCount, 1);
  assert.equal(reloadVideo.stops, 0);
  await running.close();
  await rm(root, { recursive: true, force: true });
});

test('sustained high-water backpressure stops encoding before the bounded queue is exhausted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-durable-pressure-'));
  const running = await startServer({ port: 0, dataDirectory: path.join(root, 'data') });
  const runtimes = mappedRuntimes(running.origin, (input, init) => {
    if (!input.includes('/chunks/')) return null;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
  });
  const recorder = recorderHarness();
  const video = new Track('video');
  const controller = new DurableRecordingEngine({
    engine: recorder.engine, runtime: runtimes.controller, backpressureGraceMs: 10,
    createTransport: (sessionId, writeToken, onBackpressure) => new RecordingChunkTransport({
      sessionId, writeToken, onBackpressure, queue: { maxItems: 2, maxBytes: 100 }, highWaterItems: 1, highWaterBytes: 100,
      requestTimeoutMs: 10_000,
    }, runtimes.transport),
  });
  try {
    assert.equal(await controller.start(media(new Stream([video])), null, 'Backpressure fixture', configuration), true);
    recorder.recorders[0]!.emitData(new Blob(['queued'], { type: 'video/webm' }));
    await eventually(() => assert.equal(controller.getSnapshot().status, 'failed'));
    assert.match(controller.getSnapshot().error, /backpressured/);
    assert.equal(controller.getSnapshot().outstandingBytes, 6);
    assert.equal(recorder.recorders[0]?.stops, 1);
    assert.equal(video.stops, 0);
  } finally {
    await controller.dispose(); await running.close(); await rm(root, { recursive: true, force: true });
  }
});
