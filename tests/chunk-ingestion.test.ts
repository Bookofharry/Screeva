import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/server/src/app.js';
import {
  createChunkIngestionService,
  MAX_RECORDING_CHUNK_BYTES,
  type ChunkIngestionHooks,
} from '../apps/server/src/services/chunks.js';
import { startServer } from '../apps/server/src/server.js';
import { openMetadata, type MetadataStore } from '../apps/server/src/storage/database.js';
import {
  bootstrapSchema,
  durableChunkAckSchema,
  errorEnvelopeSchema,
  recoveryInspectionSchema,
  recordingSessionSchema,
  responseSchema,
} from '../packages/shared/src/index.js';

const TIMESTAMP = '2026-11-11T12:00:00.000Z';
const configuration = {
  layout: 'pip' as const, resolution: '720p' as const, fps: 30 as const,
  videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined' as const,
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function tokenFor(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  const body = responseSchema(bootstrapSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data.writeToken;
}

async function createSession(origin: string, token: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/sessions`, {
    method: 'POST',
    headers: writeHeaders(origin, token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: 'Chunk fixture', configuration }),
  });
  const body = responseSchema(recordingSessionSchema).parse(await response.json());
  assert.equal(response.status, 201);
  assert.ok(body.ok);
  return body.data.id;
}

function writeHeaders(origin: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': token, ...extra };
}

function chunkHeaders(origin: string, token: string, bytes: Uint8Array, extra: Record<string, string> = {}): Record<string, string> {
  return writeHeaders(origin, token, {
    'Content-Type': 'video/webm;codecs=vp9,opus',
    'Content-Length': String(bytes.byteLength),
    'X-Recorder-Chunk-SHA256': sha256(bytes),
    'X-Recorder-Chunk-Timestamp': TIMESTAMP,
    ...extra,
  });
}

async function upload(origin: string, token: string, sessionId: string, sequence: number, bytes: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/api/v1/sessions/${sessionId}/chunks/${sequence}`, {
    method: 'PUT', headers: chunkHeaders(origin, token, bytes, extra), body: Buffer.from(bytes),
  });
}

async function assertError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  const body = errorEnvelopeSchema.parse(await response.json());
  assert.equal(body.error.code, code);
}

async function fixture(run: (root: string, data: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-chunks-'));
  try { await run(root, path.join(root, 'data')); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function startCustom(dataDirectory: string, hooks: ChunkIngestionHooks = {}, wrapStore?: (store: MetadataStore) => MetadataStore) {
  const underlying = await openMetadata(dataDirectory);
  const store = wrapStore?.(underlying) ?? underlying;
  const chunks = createChunkIngestionService(store, dataDirectory, hooks);
  await chunks.reconcile();
  let host = '';
  const server = createServer(createApp({ store, chunks, expectedHost: () => host }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing test address.')); return; }
      host = `127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return {
    origin: `http://${host}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => {
      underlying.close();
      if (error) reject(error); else resolve();
    })),
  };
}

test('streams, hashes, durably records and idempotently acknowledges exact sequential chunks', () => fixture(async (_root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  try {
    const token = await tokenFor(running.origin);
    const sessionId = await createSession(running.origin, token);
    const firstBytes = new TextEncoder().encode('synthetic webm chunk zero');
    const firstResponse = await upload(running.origin, token, sessionId, 0, firstBytes);
    assert.equal(firstResponse.status, 200);
    const firstBody = responseSchema(durableChunkAckSchema).parse(await firstResponse.json());
    assert.ok(firstBody.ok);
    assert.equal(firstBody.data.sequence, 0);
    assert.equal(firstBody.data.sha256, sha256(firstBytes));

    const capture = path.join(data, 'sessions', sessionId, 'capture');
    assert.deepEqual(await readFile(path.join(capture, '000000000000.webm.part')), Buffer.from(firstBytes));
    const sidecar = JSON.parse(await readFile(path.join(capture, '000000000000.commit.json'), 'utf8')) as { sha256: string };
    assert.equal(sidecar.sha256, sha256(firstBytes));

    const retry = responseSchema(durableChunkAckSchema).parse(await (await upload(running.origin, token, sessionId, 0, firstBytes)).json());
    assert.ok(retry.ok);
    assert.deepEqual(retry.data, firstBody.data);
    await assertError(await upload(running.origin, token, sessionId, 0, new TextEncoder().encode('conflict')), 409, 'CONFLICT');
    await assertError(await upload(running.origin, token, sessionId, 2, new TextEncoder().encode('gap')), 409, 'CONFLICT');

    const secondBytes = new TextEncoder().encode('synthetic webm chunk one');
    assert.equal((await upload(running.origin, token, sessionId, 1, secondBytes)).status, 200);
    const sessionResponse = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${sessionId}`)).json());
    assert.ok(sessionResponse.ok);
    assert.deepEqual(sessionResponse.data.chunks, {
      committedCount: 2,
      committedBytes: firstBytes.byteLength + secondBytes.byteLength,
      nextSequence: 2,
    });
  } finally { await running.close(); }
}));

test('rejects malformed declarations, wrong hashes, oversized chunks and unauthorized writes without artifacts', () => fixture(async (_root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  try {
    const token = await tokenFor(running.origin);
    const sessionId = await createSession(running.origin, token);
    const bytes = new TextEncoder().encode('invalid fixture');
    await assertError(await fetch(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
      method: 'PUT', headers: chunkHeaders(running.origin, token, bytes, { 'Content-Type': 'application/octet-stream' }), body: Buffer.from(bytes),
    }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await assertError(await fetch(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
      method: 'PUT', headers: chunkHeaders(running.origin, token, bytes, { 'Content-Type': 'application/json' }), body: Buffer.from(bytes),
    }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await assertError(await upload(running.origin, token, sessionId, 0, bytes, { 'X-Recorder-Chunk-SHA256': '0'.repeat(64) }), 400, 'INVALID_REQUEST');
    await assertError(await fetch(`${running.origin}/api/v1/sessions/${sessionId}/chunks/00`, {
      method: 'PUT', headers: chunkHeaders(running.origin, token, bytes), body: Buffer.from(bytes),
    }), 400, 'INVALID_REQUEST');
    await assertError(await fetch(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
      method: 'PUT', headers: { ...chunkHeaders(running.origin, token, bytes), 'X-Recorder-Token': 'a'.repeat(43) }, body: Buffer.from(bytes),
    }), 401, 'UNAUTHORIZED');
    await assertError(await fetch(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
      method: 'PUT', headers: { ...chunkHeaders(running.origin, token, bytes), Origin: 'https://evil.example' }, body: Buffer.from(bytes),
    }), 403, 'FORBIDDEN');

    const oversized = await new Promise<Response>((resolve, reject) => {
      const req = request(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
        method: 'PUT',
        headers: writeHeaders(running.origin, token, {
          'Content-Type': 'video/webm',
          'Content-Length': String(MAX_RECORDING_CHUNK_BYTES + 1),
          'X-Recorder-Chunk-SHA256': '0'.repeat(64),
          'X-Recorder-Chunk-Timestamp': TIMESTAMP,
        }),
      }, res => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode ?? 500 })));
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    await assertError(oversized, 413, 'PAYLOAD_TOO_LARGE');
    const capture = path.join(data, 'sessions', sessionId, 'capture');
    assert.deepEqual((await readdir(capture)).filter(name => name.startsWith('.upload-')), []);
  } finally { await running.close(); }
}));

test('serializes same-session concurrency into one commit and rejects a conflicting duplicate', () => fixture(async (_root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  try {
    const token = await tokenFor(running.origin);
    const sessionId = await createSession(running.origin, token);
    const bytes = new TextEncoder().encode('concurrent identical bytes');
    const [left, right] = await Promise.all([
      upload(running.origin, token, sessionId, 0, bytes),
      upload(running.origin, token, sessionId, 0, bytes),
    ]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    const a = responseSchema(durableChunkAckSchema).parse(await left.json());
    const b = responseSchema(durableChunkAckSchema).parse(await right.json());
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.data, b.data);
    const session = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${sessionId}`)).json());
    assert.ok(session.ok);
    assert.deepEqual(session.data.chunks, { committedCount: 1, committedBytes: bytes.byteLength, nextSequence: 1 });

    const conflictingSession = await createSession(running.origin, token);
    const [firstConflict, secondConflict] = await Promise.all([
      upload(running.origin, token, conflictingSession, 0, new TextEncoder().encode('concurrent left')),
      upload(running.origin, token, conflictingSession, 0, new TextEncoder().encode('concurrent right')),
    ]);
    assert.deepEqual([firstConflict.status, secondConflict.status].sort(), [200, 409]);
    const rejected = firstConflict.status === 409 ? firstConflict : secondConflict;
    assert.equal(errorEnvelopeSchema.parse(await rejected.json()).error.code, 'CONFLICT');
  } finally { await running.close(); }
}));

test('cleans an interrupted request temporary file without advancing durable metadata', () => fixture(async (_root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  try {
    const token = await tokenFor(running.origin);
    const sessionId = await createSession(running.origin, token);
    const capture = path.join(data, 'sessions', sessionId, 'capture');
    const req = request(`${running.origin}/api/v1/sessions/${sessionId}/chunks/0`, {
      method: 'PUT', headers: writeHeaders(running.origin, token, {
        'Content-Type': 'video/webm', 'Content-Length': '1024',
        'X-Recorder-Chunk-SHA256': '0'.repeat(64), 'X-Recorder-Chunk-Timestamp': TIMESTAMP,
      }),
    });
    const closed = new Promise<void>(resolve => {
      req.on('error', () => resolve());
      req.on('close', resolve);
    });
    req.write(Buffer.alloc(16));
    let observedTemporary = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const names = await readdir(capture).catch(() => []);
      if (names.some(name => name.startsWith('.upload-'))) { observedTemporary = true; break; }
      await new Promise(wait => setTimeout(wait, 5));
    }
    assert.equal(observedTemporary, true);
    req.destroy();
    await closed;
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = await readdir(capture).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      });
      if (!names.some(name => name.startsWith('.upload-'))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(await readdir(capture).catch(() => []), []);
    const session = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${sessionId}`)).json());
    assert.ok(session.ok);
    assert.deepEqual(session.data.chunks, { committedCount: 0, committedBytes: 0, nextSequence: 0 });
  } finally { await running.close(); }
}));

test('restart reconciles flushed files after a database failure and rotates authorization', () => fixture(async (_root, data) => {
  const failing = await startCustom(data, {}, store => ({
    isReady: () => store.isReady(),
    insertSession: session => store.insertSession(session),
    findSession: id => store.findSession(id),
    listSessionIds: () => store.listSessionIds(),
    listSessions: (limit, cursor) => store.listSessions(limit, cursor),
    findChunk: (sessionId, sequence) => store.findChunk(sessionId, sequence),
    listChunks: () => store.listChunks(),
    commitChunk: () => { throw new Error('synthetic database commit failure'); },
    beginFinalization: (sessionId, expectedChunkCount, updatedAt) => store.beginFinalization(sessionId, expectedChunkCount, updatedAt),
    completeFinalization: output => store.completeFinalization(output),
    markInterrupted: (sessionId, updatedAt) => store.markInterrupted(sessionId, updatedAt),
    markRecoverable: (sessionId, updatedAt) => store.markRecoverable(sessionId, updatedAt),
    close: () => undefined,
  }));
  const oldToken = await tokenFor(failing.origin);
  const sessionId = await createSession(failing.origin, oldToken);
  const bytes = new TextEncoder().encode('recoverable commit pair');
  await assertError(await upload(failing.origin, oldToken, sessionId, 0, bytes), 500, 'INTERNAL_ERROR');
  await failing.close();

  const restarted = await startServer({ port: 0, dataDirectory: data });
  try {
    const newToken = await tokenFor(restarted.origin);
    assert.notEqual(newToken, oldToken);
    await assertError(await upload(restarted.origin, oldToken, sessionId, 0, bytes), 401, 'UNAUTHORIZED');
    const retry = await upload(restarted.origin, newToken, sessionId, 0, bytes);
    assert.equal(retry.status, 200);
    const ack = responseSchema(durableChunkAckSchema).parse(await retry.json());
    assert.ok(ack.ok);
    const session = responseSchema(recordingSessionSchema).parse(await (await fetch(`${restarted.origin}/api/v1/sessions/${sessionId}`)).json());
    assert.ok(session.ok);
    assert.deepEqual(session.data.chunks, { committedCount: 1, committedBytes: bytes.byteLength, nextSequence: 1 });
  } finally { await restarted.close(); }
}));

test('restart removes an uncommitted media-only partial and accepts a clean retry', () => fixture(async (_root, data) => {
  const failing = await startCustom(data, { afterFilePublished: () => { throw new Error('synthetic post-rename failure'); } });
  const token = await tokenFor(failing.origin);
  const sessionId = await createSession(failing.origin, token);
  const bytes = new TextEncoder().encode('media-only partial');
  await assertError(await upload(failing.origin, token, sessionId, 0, bytes), 500, 'INTERNAL_ERROR');
  await failing.close();

  const restarted = await startServer({ port: 0, dataDirectory: data });
  try {
    const nextToken = await tokenFor(restarted.origin);
    const response = await upload(restarted.origin, nextToken, sessionId, 0, bytes);
    assert.equal(response.status, 200);
    assert.deepEqual((await readdir(path.join(data, 'sessions', sessionId, 'capture'))).sort(), [
      '000000000000.commit.json', '000000000000.webm.part',
    ]);
  } finally { await restarted.close(); }
}));

test('restart keeps corrupt acknowledged media quarantined and exposes authenticated recovery inspection', () => fixture(async (_root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  const token = await tokenFor(running.origin);
  const sessionId = await createSession(running.origin, token);
  const bytes = new TextEncoder().encode('committed before tamper');
  assert.equal((await upload(running.origin, token, sessionId, 0, bytes)).status, 200);
  await running.close();
  const media = path.join(data, 'sessions', sessionId, 'capture', '000000000000.webm.part');
  await writeFile(media, 'tampered');
  const restarted = await startServer({ port: 0, dataDirectory: data });
  try {
    const freshToken = await tokenFor(restarted.origin);
    const inspected = await fetch(`${restarted.origin}/api/v1/sessions/${sessionId}/recovery`, { headers: {
      Origin: restarted.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': freshToken,
    } });
    const body = responseSchema(recoveryInspectionSchema).parse(await inspected.json());
    assert.ok(body.ok);
    assert.equal(body.data.condition, 'corrupt');
    assert.equal(body.data.recoverable, false);
    assert.equal(await readFile(media, 'utf8'), 'tampered');
  } finally { await restarted.close(); }
}));

test('rejects a linked capture directory without writing outside storage', () => fixture(async (root, data) => {
  const running = await startServer({ port: 0, dataDirectory: data });
  try {
    const token = await tokenFor(running.origin);
    const sessionId = await createSession(running.origin, token);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const session = path.join(data, 'sessions', sessionId);
    await mkdir(session);
    await symlink(outside, path.join(session, 'capture'), process.platform === 'win32' ? 'junction' : 'dir');
    await assertError(await upload(running.origin, token, sessionId, 0, new TextEncoder().encode('blocked')), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await readdir(outside), []);
  } finally { await running.close(); }
}));
