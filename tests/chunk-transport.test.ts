import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RecordingChunkTransport, type BackpressureSignal, type ChunkTransportRuntime } from '../apps/client/src/media/chunk-transport.js';
import { startServer } from '../apps/server/src/server.js';
import {
  bootstrapSchema,
  failure,
  recordingSessionSchema,
  responseSchema,
  success,
  type DurableChunkAck,
  type ErrorCode,
} from '../packages/shared/src/index.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'a'.repeat(43);
const COMMITTED_AT = '2026-11-11T12:30:00.000Z';

interface RuntimeHarness {
  readonly runtime: ChunkTransportRuntime;
  readonly timers: Map<number, ReturnType<typeof setTimeout>>;
  readonly scheduled: number[];
}

function runtimeHarness(fetcher: ChunkTransportRuntime['fetch'], random: () => number = () => 0.5): RuntimeHarness {
  let nextTimer = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const scheduled: number[] = [];
  return {
    timers,
    scheduled,
    runtime: {
      fetch: fetcher,
      random,
      setTimer: (callback, milliseconds) => {
        scheduled.push(milliseconds);
        const id = nextTimer++;
        const handle = setTimeout(() => { timers.delete(id); callback(); }, milliseconds);
        timers.set(id, handle);
        return id;
      },
      clearTimer: id => {
        const handle = timers.get(id);
        if (handle) clearTimeout(handle);
        timers.delete(id);
      },
    },
  };
}

function requestAck(input: string, init: RequestInit, patch: Partial<DurableChunkAck> = {}): Response {
  const headers = new Headers(init.headers);
  const sequence = Number(input.split('/').at(-1));
  const body = init.body;
  assert.ok(body instanceof Blob);
  const ack: DurableChunkAck = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    sequence,
    byteLength: body.size,
    sha256: headers.get('X-Recorder-Chunk-SHA256') ?? '',
    committed: true,
    committedAt: COMMITTED_AT,
    ...patch,
  };
  return new Response(JSON.stringify(success(ack)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(status: number, code: ErrorCode): Response {
  return new Response(JSON.stringify(failure(code, `Synthetic ${code} response.`)), { status, headers: { 'Content-Type': 'application/json' } });
}

async function eventually(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { assertion(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

function options(overrides: Partial<ConstructorParameters<typeof RecordingChunkTransport>[0]> = {}) {
  return {
    sessionId: SESSION_ID,
    writeToken: TOKEN,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 4,
    jitterRatio: 0,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

test('uploads immutable queue heads strictly in order and waits for a delayed ACK before advancing', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const calls: Array<{ input: string; init: RequestInit }> = [];
  let active = 0;
  let maximumActive = 0;
  const harness = runtimeHarness(async (input, init) => {
    calls.push({ input, init });
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (input.endsWith('/0')) await firstGate;
    active--;
    return requestAck(input, init);
  });
  const transport = new RecordingChunkTransport(options(), harness.runtime);
  const first = await transport.enqueue(new Blob(['first'], { type: 'video/webm' }));
  const second = await transport.enqueue(new Blob(['second'], { type: 'video/webm' }));
  assert.equal(transport.start(), true);
  assert.equal(transport.start(), false);
  await eventually(() => assert.equal(calls.length, 1));
  assert.equal(transport.getSnapshot().status, 'uploading');
  assert.equal(transport.getSnapshot().outstandingBytes, 11);
  assert.equal(calls[0]?.init.body, first.blob);
  assert.equal(new Headers(calls[0]?.init.headers).get('X-Recorder-Token'), TOKEN);
  assert.equal(new Headers(calls[0]?.init.headers).get('X-Recorder-Chunk-Timestamp'), first.metadata.timestamp);
  releaseFirst?.();
  await eventually(() => assert.equal(transport.getSnapshot().acknowledgedChunks, 2));
  assert.deepEqual(calls.map(call => call.input.split('/').at(-1)), ['0', '1']);
  assert.equal(calls[1]?.init.body, second.blob);
  assert.equal(maximumActive, 1);
  assert.equal(transport.getSnapshot().outstandingBytes, 0);
  assert.equal(transport.getSnapshot().status, 'idle');
  await transport.dispose();
});

test('drain resolves only after every pending hash and durable ACK, and rejects terminal delivery failure', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const harness = runtimeHarness(async (input, init) => { await gate; return requestAck(input, init); });
  const transport = new RecordingChunkTransport(options(), harness.runtime);
  await transport.enqueue(new Blob(['drain me'], { type: 'video/webm' }));
  let drained = false;
  const result = transport.drain().then(count => { drained = true; return count; });
  await eventually(() => assert.equal(transport.getSnapshot().status, 'uploading'));
  assert.equal(drained, false);
  release?.();
  assert.equal(await result, 1);
  await transport.dispose();

  const failedHarness = runtimeHarness(async () => errorResponse(401, 'UNAUTHORIZED'));
  const failed = new RecordingChunkTransport(options(), failedHarness.runtime);
  await failed.enqueue(new Blob(['retain'], { type: 'video/webm' }));
  await assert.rejects(failed.drain(), /UNAUTHORIZED/);
  assert.equal(failed.getSnapshot().outstandingBytes, 6);
  await failed.dispose();
});

test('uploads through the real authenticated loopback ingestion endpoint', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'recorder-transport-'));
  const running = await startServer({ port: 0, dataDirectory: path.join(sandbox, 'data') });
  let transport: RecordingChunkTransport | undefined;
  try {
    const bootstrapResponse = await fetch(`${running.origin}/api/v1/bootstrap`, {
      headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' },
    });
    const bootstrap = responseSchema(bootstrapSchema).parse(await bootstrapResponse.json());
    assert.ok(bootstrap.ok);
    const sessionResponse = await fetch(`${running.origin}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        Origin: running.origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-Recorder-Token': bootstrap.data.writeToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Transport integration',
        configuration: {
          layout: 'pip', resolution: '720p', fps: 30,
          videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined',
        },
      }),
    });
    const created = responseSchema(recordingSessionSchema).parse(await sessionResponse.json());
    assert.ok(created.ok);
    const harness = runtimeHarness(async (input, init) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', running.origin);
      headers.set('Sec-Fetch-Site', 'same-origin');
      return fetch(running.origin + input, { ...init, headers });
    });
    transport = new RecordingChunkTransport(options({
      sessionId: created.data.id,
      writeToken: bootstrap.data.writeToken,
    }), harness.runtime);
    const bytes = new Blob(['real endpoint bytes'], { type: 'video/webm' });
    await transport.enqueue(bytes);
    transport.start();
    await eventually(() => assert.equal(transport?.getSnapshot().acknowledgedChunks, 1));
    const stored = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${created.data.id}`)).json());
    assert.ok(stored.ok);
    assert.deepEqual(stored.data.chunks, { committedCount: 1, committedBytes: bytes.size, nextSequence: 1 });
  } finally {
    await transport?.dispose();
    await running.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('retries a lost ACK with the same Blob and metadata identity', async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const harness = runtimeHarness(async (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) throw new TypeError('synthetic connection loss after server commit');
    return requestAck(input, init);
  });
  const transport = new RecordingChunkTransport(options(), harness.runtime);
  const item = await transport.enqueue(new Blob(['lost ack'], { type: 'video/webm;codecs=vp9,opus' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().acknowledgedChunks, 1));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.init.body, item.blob);
  assert.equal(calls[1]?.init.body, item.blob);
  assert.equal(new Headers(calls[0]?.init.headers).get('X-Recorder-Chunk-SHA256'), item.metadata.sha256);
  assert.equal(new Headers(calls[1]?.init.headers).get('X-Recorder-Chunk-SHA256'), item.metadata.sha256);
  assert.equal(transport.getSnapshot().totalAttempts, 2);
  await transport.dispose();
});

test('aborts a timed-out request and retries after bounded backoff', async () => {
  let calls = 0;
  const harness = runtimeHarness(async (input, init) => {
    calls++;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
      });
    }
    return requestAck(input, init);
  });
  const transport = new RecordingChunkTransport(options({ requestTimeoutMs: 10 }), harness.runtime);
  await transport.enqueue(new Blob(['timeout'], { type: 'video/webm' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().acknowledgedChunks, 1));
  assert.equal(calls, 2);
  assert.equal(transport.getSnapshot().totalAttempts, 2);
  assert.equal(harness.timers.size, 0);
  await transport.dispose();
});

test('retries transient HTTP failures with capped exponential delay and jitter', async () => {
  let calls = 0;
  const harness = runtimeHarness(async (input, init) => {
    calls++;
    if (calls < 3) return errorResponse(503, 'INTERNAL_ERROR');
    return requestAck(input, init);
  }, () => 1);
  const transport = new RecordingChunkTransport(options({
    baseRetryDelayMs: 10,
    maxRetryDelayMs: 15,
    jitterRatio: 0.2,
  }), harness.runtime);
  await transport.enqueue(new Blob(['server retry'], { type: 'video/webm' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().acknowledgedChunks, 1));
  assert.equal(calls, 3);
  assert.deepEqual(harness.scheduled.filter(delay => delay < 1000), [12, 15]);
  await transport.dispose();
});

test('exhausts transient retries without releasing the queued Blob', async () => {
  const signals: BackpressureSignal[] = [];
  const harness = runtimeHarness(async () => { throw new TypeError('offline'); });
  const transport = new RecordingChunkTransport(options({ maxAttempts: 3, onBackpressure: signal => signals.push(signal) }), harness.runtime);
  const item = await transport.enqueue(new Blob(['retain me'], { type: 'video/webm' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().status, 'failed'));
  const state = transport.getSnapshot();
  assert.equal(state.totalAttempts, 3);
  assert.equal(state.attempts, 3);
  assert.equal(state.outstandingBytes, item.blob.size);
  assert.match(state.error, /failed after 3 attempts/);
  assert.equal(signals.at(-1)?.reason, 'transport-failed');
  await transport.dispose();
  assert.equal(transport.getSnapshot().outstandingBytes, 0);
});

test('treats authentication, validation, conflicts and unsupported media as terminal', async () => {
  const cases: Array<[number, ErrorCode]> = [
    [400, 'INVALID_REQUEST'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
    [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA_TYPE'],
  ];
  for (const [status, code] of cases) {
    let calls = 0;
    const harness = runtimeHarness(async () => { calls++; return errorResponse(status, code); });
    const transport = new RecordingChunkTransport(options(), harness.runtime);
    await transport.enqueue(new Blob([code], { type: 'video/webm' }));
    transport.start();
    await eventually(() => assert.equal(transport.getSnapshot().status, 'failed'));
    assert.equal(calls, 1);
    assert.match(transport.getSnapshot().error, new RegExp(code));
    await transport.dispose();
  }
});

test('rejects malformed and conflicting successful ACKs without retrying or releasing bytes', async () => {
  const fetchers: ChunkTransportRuntime['fetch'][] = [
    async () => new Response(JSON.stringify(success({ unexpected: true })), { status: 200 }),
    async (input, init) => requestAck(input, init, { sha256: '0'.repeat(64) }),
  ];
  for (const fetcher of fetchers) {
    let calls = 0;
    const harness = runtimeHarness(async (input, init) => { calls++; return fetcher(input, init); });
    const transport = new RecordingChunkTransport(options(), harness.runtime);
    const item = await transport.enqueue(new Blob(['bad ack'], { type: 'video/webm' }));
    transport.start();
    await eventually(() => assert.equal(transport.getSnapshot().status, 'failed'));
    assert.equal(calls, 1);
    assert.equal(transport.getSnapshot().outstandingBytes, item.blob.size);
    assert.match(transport.getSnapshot().error, /ACK/);
    await transport.dispose();
  }
});

test('signals high-water backpressure before the hard queue bound and reports capacity rejection', async () => {
  const signals: BackpressureSignal[] = [];
  const harness = runtimeHarness(async (input, init) => requestAck(input, init));
  const transport = new RecordingChunkTransport(options({
    queue: { maxItems: 2, maxBytes: 100 }, highWaterItems: 2, highWaterBytes: 100,
    onBackpressure: signal => signals.push(signal),
  }), harness.runtime);
  await transport.enqueue(new Blob(['first'], { type: 'video/webm' }));
  await transport.enqueue(new Blob(['second'], { type: 'video/webm' }));
  assert.equal(transport.getSnapshot().backpressured, true);
  assert.equal(signals[0]?.reason, 'high-water');
  await assert.rejects(transport.enqueue(new Blob(['third'], { type: 'video/webm' })), /item capacity/);
  assert.equal(signals.at(-1)?.reason, 'capacity-exceeded');
  assert.equal(transport.getSnapshot().queuedItems, 2);
  assert.equal(transport.getSnapshot().outstandingBytes, 11);
  await transport.dispose();
});

test('releases a failed hashing reservation and clears transient backpressure state', async () => {
  const harness = runtimeHarness(async (input, init) => requestAck(input, init));
  const transport = new RecordingChunkTransport(options({
    queue: { maxItems: 1, maxBytes: 100 }, highWaterItems: 1, highWaterBytes: 100,
  }), harness.runtime);
  await assert.rejects(transport.enqueue(new Blob(['invalid media'], { type: 'application/octet-stream' })));
  assert.equal(transport.getSnapshot().backpressured, false);
  assert.equal(transport.getSnapshot().pendingItems, 0);
  assert.equal(transport.getSnapshot().outstandingBytes, 0);
  await transport.dispose();
});

test('dispose aborts in-flight work, ignores a late ACK and clears retained bytes and timers', async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  let observedAbort = false;
  let capturedInput = '';
  let capturedInit: RequestInit | undefined;
  const harness = runtimeHarness(async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    init.signal?.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    return new Promise<Response>(resolve => { resolveFetch = resolve; });
  });
  const transport = new RecordingChunkTransport(options(), harness.runtime);
  await transport.enqueue(new Blob(['late'], { type: 'video/webm' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().status, 'uploading'));
  const disposal = transport.dispose();
  assert.equal(observedAbort, true);
  assert.ok(capturedInit);
  resolveFetch?.(requestAck(capturedInput, capturedInit));
  await disposal;
  assert.equal(transport.getSnapshot().status, 'disposed');
  assert.equal(transport.getSnapshot().acknowledgedChunks, 0);
  assert.equal(transport.getSnapshot().outstandingBytes, 0);
  assert.equal(harness.timers.size, 0);
  await assert.rejects(transport.enqueue(new Blob(['later'], { type: 'video/webm' })), /disposed/);
});

test('dispose cancels a pending backoff so no later retry can start', async () => {
  let calls = 0;
  const harness = runtimeHarness(async () => { calls++; throw new TypeError('offline'); });
  const transport = new RecordingChunkTransport(options({ baseRetryDelayMs: 100, maxRetryDelayMs: 100 }), harness.runtime);
  await transport.enqueue(new Blob(['cancel retry'], { type: 'video/webm' }));
  transport.start();
  await eventually(() => assert.equal(transport.getSnapshot().status, 'retrying'));
  await transport.dispose();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls, 1);
  assert.equal(harness.timers.size, 0);
});
