import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/src/app.js';
import type { FFprobeAdapter } from '../apps/server/src/media/ffprobe.js';
import { startServer } from '../apps/server/src/server.js';
import { createChunkIngestionService, type ChunkIngestionHooks } from '../apps/server/src/services/chunks.js';
import { createFinalizationService } from '../apps/server/src/services/finalization.js';
import { createRecoveryService } from '../apps/server/src/services/recovery.js';
import { SessionActivityRegistry } from '../apps/server/src/services/session-activity.js';
import { SessionOperationLock } from '../apps/server/src/services/session-operation-lock.js';
import { openMetadata, type MetadataStore } from '../apps/server/src/storage/database.js';
import {
  bootstrapSchema,
  durableChunkAckSchema,
  finalizedRecordingSchema,
  recordingSessionSchema,
  recoveryInspectionSchema,
  responseSchema,
} from '../packages/shared/src/index.js';

const configuration = { layout: 'screen' as const, resolution: '720p' as const, fps: 30 as const,
  videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' as const };
const acceptingProbe: FFprobeAdapter = { probe: async () => ({ formatName: 'matroska,webm', durationMs: 1000,
  video: { codec: 'vp8', width: 1280, height: 720 }, audio: null }) };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(run: (data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'screeva-faults-'));
  try { await run(path.join(root, 'data')); } finally { await rm(root, { recursive: true, force: true }); }
}

function writeHeaders(origin: string, token: string, json = true) {
  return { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': token,
    ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function token(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  const body = responseSchema(bootstrapSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data.writeToken;
}

async function createSession(origin: string, writeToken: string, title = 'Fault fixture'): Promise<string> {
  const response = await fetch(`${origin}/api/v1/sessions`, { method: 'POST', headers: writeHeaders(origin, writeToken),
    body: JSON.stringify({ title, configuration }) });
  const body = responseSchema(recordingSessionSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data.id;
}

async function upload(origin: string, writeToken: string, sessionId: string, sequence: number, bytes: Buffer): Promise<Response> {
  return fetch(`${origin}/api/v1/sessions/${sessionId}/chunks/${sequence}`, { method: 'PUT', headers: {
    ...writeHeaders(origin, writeToken, false), 'Content-Type': 'video/webm;codecs=vp8', 'Content-Length': String(bytes.length),
    'X-Recorder-Chunk-SHA256': createHash('sha256').update(bytes).digest('hex'),
    'X-Recorder-Chunk-Timestamp': new Date(1_800_000_000_000 + sequence).toISOString(),
  }, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

async function session(origin: string, id: string) {
  const body = responseSchema(recordingSessionSchema).parse(await (await fetch(`${origin}/api/v1/sessions/${id}`)).json());
  assert.ok(body.ok);
  return body.data;
}

async function inspect(origin: string, writeToken: string, id: string) {
  const body = responseSchema(recoveryInspectionSchema).parse(await (await fetch(`${origin}/api/v1/sessions/${id}/recovery`, {
    headers: writeHeaders(origin, writeToken, false),
  })).json());
  assert.ok(body.ok);
  return body.data;
}

async function startInjected(data: string, options: { hooks?: ChunkIngestionHooks; probe?: FFprobeAdapter; wrapStore?: (store: MetadataStore) => MetadataStore } = {}) {
  const underlying = await openMetadata(data);
  const store = options.wrapStore?.(underlying) ?? underlying;
  const locks = new SessionOperationLock();
  const activity = new SessionActivityRegistry();
  const chunks = createChunkIngestionService(store, data, options.hooks ?? {}, locks);
  const finalization = createFinalizationService(store, data, options.probe ?? acceptingProbe, {}, locks);
  const recovery = createRecoveryService(store, data, finalization, locks, activity);
  await chunks.reconcile(); await finalization.reconcile(); await recovery.reconcile();
  let host = '';
  const server = createServer(createApp({ store, chunks, finalization, recovery, activity, locks, expectedHost: () => host }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing test address.')); return; }
      host = `127.0.0.1:${address.port}`; resolve();
    });
  });
  return { origin: `http://${host}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => { underlying.close(); if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  }) };
}

test('disk-full publication failure emits no ACK, preserves prior chunks, and repeated reconciliation is stable', () => fixture(async data => {
  const injected = await startInjected(data, { hooks: { afterFilePublished: chunk => {
    if (chunk.sequence === 1) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
  } } });
  const firstToken = await token(injected.origin);
  const id = await createSession(injected.origin, firstToken);
  const first = Buffer.from('valid committed prefix');
  const failed = Buffer.from('must never be acknowledged');
  assert.equal((await upload(injected.origin, firstToken, id, 0, first)).status, 200);
  assert.equal((await upload(injected.origin, firstToken, id, 1, failed)).status, 500);
  assert.deepEqual((await session(injected.origin, id)).chunks, { committedCount: 1, committedBytes: first.length, nextSequence: 1 });
  await injected.close();

  let restarted = await startServer({ port: 0, dataDirectory: data, ffprobe: acceptingProbe });
  const nextToken = await token(restarted.origin);
  assert.equal((await upload(restarted.origin, firstToken, id, 1, failed)).status, 401, 'stale token must not revive an upload');
  assert.equal((await upload(restarted.origin, nextToken, id, 1, failed)).status, 409, 'restart seals the acknowledged prefix for recovery');
  await restarted.close();
  restarted = await startServer({ port: 0, dataDirectory: data, ffprobe: acceptingProbe });
  try {
    const stored = await session(restarted.origin, id);
    assert.equal(stored.chunks.committedCount, 1);
    const capture = path.join(data, 'sessions', id, 'capture');
    assert.deepEqual(await readFile(path.join(capture, '000000000000.webm.part')), first);
    assert.deepEqual((await readdir(capture)).sort(), [
      '000000000000.commit.json', '000000000000.webm.part',
    ]);
  } finally { await restarted.close(); }
}));

test('held upload excludes heartbeat and salvage while finalization waits for the durable commit', () => fixture(async data => {
  const entered = deferred(); const release = deferred();
  const injected = await startInjected(data, { hooks: { afterSidecarPublished: async () => { entered.resolve(); await release.promise; } } });
  try {
    const writeToken = await token(injected.origin);
    const id = await createSession(injected.origin, writeToken);
    let uploadSettled = false;
    const uploading = upload(injected.origin, writeToken, id, 0, Buffer.from('serialized durable bytes')).then(response => {
      uploadSettled = true; return response;
    });
    await entered.promise;
    assert.equal(uploadSettled, false, 'sidecar publication is not a durable ACK');
    const heartbeat = await fetch(`${injected.origin}/api/v1/sessions/${id}/heartbeat`, {
      method: 'POST', headers: writeHeaders(injected.origin, writeToken), body: '{}',
    });
    assert.equal(heartbeat.status, 409);
    const salvage = await fetch(`${injected.origin}/api/v1/sessions/${id}/recovery/salvage`, {
      method: 'POST', headers: writeHeaders(injected.origin, writeToken), body: '{}',
    });
    assert.equal(salvage.status, 409);
    assert.equal((await inspect(injected.origin, writeToken, id)).condition, 'active');
    let finalizeSettled = false;
    const finalizing = fetch(`${injected.origin}/api/v1/sessions/${id}/finalize`, {
      method: 'POST', headers: writeHeaders(injected.origin, writeToken), body: JSON.stringify({ expectedChunkCount: 1 }),
    }).then(response => { finalizeSettled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finalizeSettled, false, 'finalization must wait behind ingestion');
    release.resolve();
    const uploadResponse = await uploading;
    assert.equal(uploadResponse.status, 200);
    const ack = responseSchema(durableChunkAckSchema).parse(await uploadResponse.json());
    assert.ok(ack.ok); assert.equal(ack.data.sequence, 0);
    const finalResponse = await finalizing;
    assert.equal(finalResponse.status, 200);
    const output = responseSchema(finalizedRecordingSchema).parse(await finalResponse.json());
    assert.ok(output.ok);
    assert.equal((await session(injected.origin, id)).status, 'completed');
  } finally { release.resolve(); await injected.close(); }
}));

test('corrupt and missing sidecars remain isolated while malformed WebM cannot become completed', () => fixture(async data => {
  let running = await startServer({ port: 0, dataDirectory: data, ffprobe: acceptingProbe });
  let writeToken = await token(running.origin);
  const corruptId = await createSession(running.origin, writeToken, 'Corrupt sidecar');
  const missingId = await createSession(running.origin, writeToken, 'Missing sidecar');
  const malformedId = await createSession(running.origin, writeToken, 'Malformed WebM');
  for (const id of [corruptId, missingId, malformedId]) assert.equal((await upload(running.origin, writeToken, id, 0, Buffer.from(`bytes-${id}`))).status, 200);
  await running.close();
  await writeFile(path.join(data, 'sessions', corruptId, 'capture', '000000000000.commit.json'), '{}');
  await unlink(path.join(data, 'sessions', missingId, 'capture', '000000000000.commit.json'));

  const rejectingProbe: FFprobeAdapter = { probe: async () => { throw new Error('synthetic malformed WebM rejection'); } };
  running = await startServer({ port: 0, dataDirectory: data, ffprobe: rejectingProbe });
  try {
    writeToken = await token(running.origin);
    assert.equal((await inspect(running.origin, writeToken, corruptId)).condition, 'corrupt');
    assert.equal((await inspect(running.origin, writeToken, missingId)).condition, 'corrupt');
    assert.equal((await inspect(running.origin, writeToken, malformedId)).condition, 'valid-incomplete');
    for (const id of [corruptId, missingId]) {
      const response = await fetch(`${running.origin}/api/v1/sessions/${id}/recovery/salvage`, {
        method: 'POST', headers: writeHeaders(running.origin, writeToken), body: '{}',
      });
      assert.equal(response.status, 409);
    }
    const malformed = await fetch(`${running.origin}/api/v1/sessions/${malformedId}/recovery/salvage`, {
      method: 'POST', headers: writeHeaders(running.origin, writeToken), body: '{}',
    });
    assert.equal(malformed.status, 500);
    const stored = await session(running.origin, malformedId);
    assert.notEqual(stored.status, 'completed');
    assert.equal(stored.output, null);
    assert.deepEqual(await readFile(path.join(data, 'sessions', malformedId, 'capture', '000000000000.webm.part')), Buffer.from(`bytes-${malformedId}`));
  } finally { await running.close(); }
}));

test('SQLite commit failure cannot ACK and restart reconciliation promotes only the flushed sidecar pair', () => fixture(async data => {
  const injected = await startInjected(data, { wrapStore: store => ({
    isReady: () => store.isReady(), insertSession: value => store.insertSession(value), findSession: id => store.findSession(id),
    listSessionIds: () => store.listSessionIds(), listSessions: (limit, cursor) => store.listSessions(limit, cursor),
    findChunk: (id, sequence) => store.findChunk(id, sequence), listChunks: () => store.listChunks(),
    commitChunk: () => { throw new Error('synthetic SQLite full/commit failure'); },
    beginFinalization: (id, count, at) => store.beginFinalization(id, count, at), completeFinalization: output => store.completeFinalization(output),
    markInterrupted: (id, at) => store.markInterrupted(id, at), markRecoverable: (id, at) => store.markRecoverable(id, at), close: () => undefined,
  }) });
  const oldToken = await token(injected.origin);
  const id = await createSession(injected.origin, oldToken);
  const bytes = Buffer.from('flushed before SQLite failure');
  assert.equal((await upload(injected.origin, oldToken, id, 0, bytes)).status, 500);
  assert.equal((await session(injected.origin, id)).chunks.committedCount, 0);
  await injected.close();

  const restarted = await startServer({ port: 0, dataDirectory: data, ffprobe: acceptingProbe });
  try {
    const freshToken = await token(restarted.origin);
    const stored = await session(restarted.origin, id);
    assert.equal(stored.chunks.committedCount, 1);
    assert.equal((await upload(restarted.origin, oldToken, id, 0, bytes)).status, 401);
    const retry = await upload(restarted.origin, freshToken, id, 0, bytes);
    assert.equal(retry.status, 200);
    const ack = responseSchema(durableChunkAckSchema).parse(await retry.json());
    assert.ok(ack.ok);
    assert.deepEqual(await readFile(path.join(data, 'sessions', id, 'capture', '000000000000.webm.part')), bytes);
  } finally { await restarted.close(); }
}));
