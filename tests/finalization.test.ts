import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { createFFprobeAdapter, type FFprobeAdapter } from '../apps/server/src/media/ffprobe.js';
import { createFinalizationService } from '../apps/server/src/services/finalization.js';
import { openMetadata, type MetadataStore } from '../apps/server/src/storage/database.js';
import { startServer } from '../apps/server/src/server.js';
import { responseSchema, finalizedRecordingSchema, recordingSessionSchema } from '../packages/shared/src/index.js';

const configuration = { layout: 'screen' as const, resolution: '720p' as const, fps: 30 as const, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' as const };
const fakeProbe: FFprobeAdapter = { probe: async () => ({ formatName: 'matroska,webm', durationMs: 1000, video: { codec: 'vp8', width: 1280, height: 720 }, audio: null }) };

async function fixture(run: (data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-finalize-'));
  try { await run(path.join(root, 'data')); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function token(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  return (await response.json() as { data: { writeToken: string } }).data.writeToken;
}

function writeHeaders(origin: string, writeToken: string, contentType = 'application/json') {
  return { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': writeToken, 'Content-Type': contentType };
}

async function createSession(origin: string, writeToken: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/sessions`, {
    method: 'POST', headers: writeHeaders(origin, writeToken), body: JSON.stringify({ title: 'Finalization fixture', configuration }),
  });
  const body = responseSchema(recordingSessionSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data.id;
}

async function upload(origin: string, writeToken: string, sessionId: string, sequence: number, bytes: Uint8Array) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const response = await fetch(`${origin}/api/v1/sessions/${sessionId}/chunks/${sequence}`, {
    method: 'PUT',
    headers: {
      ...writeHeaders(origin, writeToken, 'video/webm;codecs=vp8'),
      'Content-Length': String(bytes.byteLength),
      'X-Recorder-Chunk-Sha256': sha256,
      'X-Recorder-Chunk-Timestamp': new Date(1_800_000_000_000 + sequence).toISOString(),
    },
    body: Buffer.from(bytes),
  });
  assert.equal(response.status, 200, await response.text());
}

async function finalize(origin: string, writeToken: string, sessionId: string, expectedChunkCount: number) {
  return fetch(`${origin}/api/v1/sessions/${sessionId}/finalize`, {
    method: 'POST', headers: writeHeaders(origin, writeToken), body: JSON.stringify({ expectedChunkCount }),
  });
}

async function prepare(data: string, chunks: readonly Uint8Array[], probe = fakeProbe) {
  const running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  try {
    const writeToken = await token(running.origin);
    const sessionId = await createSession(running.origin, writeToken);
    for (const [sequence, bytes] of chunks.entries()) await upload(running.origin, writeToken, sessionId, sequence, bytes);
    return { ...running, writeToken, sessionId };
  } catch (error) {
    await running.close();
    throw error;
  }
}

test('authenticated finalization concatenates exact chunk bytes, preserves originals, persists metadata and is idempotent', () => fixture(async data => {
  const chunks = [Buffer.from('webm-header-'), Buffer.from('middle-cluster-'), Buffer.from('ending-cluster')];
  const running = await prepare(data, chunks);
  try {
    assert.equal((await finalize(running.origin, '', running.sessionId, 3)).status, 401);
    const response = await finalize(running.origin, running.writeToken, running.sessionId, 3);
    assert.equal(response.status, 200);
    const parsed = responseSchema(finalizedRecordingSchema).parse(await response.json());
    assert.ok(parsed.ok);
    const combined = Buffer.concat(chunks);
    assert.equal(parsed.data.byteLength, combined.length);
    assert.equal(parsed.data.sha256, createHash('sha256').update(combined).digest('hex'));
    const outputPath = path.join(data, 'sessions', running.sessionId, 'final', 'recording.webm');
    assert.deepEqual(await readFile(outputPath), combined);
    for (let sequence = 0; sequence < chunks.length; sequence++) {
      assert.equal((await stat(path.join(data, 'sessions', running.sessionId, 'capture', `${String(sequence).padStart(12, '0')}.webm.part`))).size, chunks[sequence]?.length);
    }
    const repeated = await finalize(running.origin, running.writeToken, running.sessionId, 3);
    assert.equal(repeated.status, 200);
    assert.deepEqual((await repeated.json() as { data: unknown }).data, parsed.data);
    assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 2)).status, 409);
    const stored = responseSchema(recordingSessionSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions/${running.sessionId}`)).json());
    assert.ok(stored.ok);
    assert.equal(stored.data.status, 'completed');
    assert.deepEqual(stored.data.output, parsed.data);
  } finally { await running.close(); }
}));

test('finalization rejects missing ledger entries and detects truncated or same-length corrupted committed chunks', () => fixture(async data => {
  const running = await prepare(data, [Buffer.from('first'), Buffer.from('second')]);
  try {
    assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 3)).status, 409);
    const first = path.join(data, 'sessions', running.sessionId, 'capture', '000000000000.webm.part');
    await writeFile(first, Buffer.from('x'));
    assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 2)).status, 500);
    await writeFile(first, Buffer.from('zzzzz'));
    assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 2)).status, 500);
    assert.equal(existsSync(path.join(data, 'sessions', running.sessionId, 'final', 'recording.commit.json')), false);
  } finally { await running.close(); }
}));

test('probe failure leaves chunks intact and a restart can safely retry finalization', () => fixture(async data => {
  const rejectingProbe: FFprobeAdapter = { probe: async () => { throw new Error('synthetic probe failure'); } };
  const running = await prepare(data, [Buffer.from('a'), Buffer.from('b')], rejectingProbe);
  assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 2)).status, 500);
  const sessionId = running.sessionId;
  await running.close();
  const restarted = await startServer({ port: 0, dataDirectory: data, ffprobe: fakeProbe });
  try {
    const freshToken = await token(restarted.origin);
    assert.equal((await finalize(restarted.origin, freshToken, sessionId, 2)).status, 200);
  } finally { await restarted.close(); }
}));

test('finalization rejects linked output directories and never writes through them', () => fixture(async data => {
  const running = await prepare(data, [Buffer.from('safe-source')]);
  try {
    const outside = path.join(path.dirname(data), 'outside-final');
    await mkdir(outside);
    await symlink(outside, path.join(data, 'sessions', running.sessionId, 'final'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await finalize(running.origin, running.writeToken, running.sessionId, 1)).status, 500);
    assert.deepEqual(await readdir(outside), []);
  } finally { await running.close(); }
}));

test('restart removes an interrupted media-only publish and recovers a sidecar-published database failure', () => fixture(async data => {
  const prepared = await prepare(data, [Buffer.from('one'), Buffer.from('two')]);
  const sessionId = prepared.sessionId;
  await prepared.close();

  let store = await openMetadata(data);
  const interrupted = createFinalizationService(store, data, fakeProbe, { afterOutputPublished: () => { throw new Error('synthetic disk interruption'); } });
  await assert.rejects(interrupted.finalize(sessionId, 2));
  store.close();

  let restarted = await startServer({ port: 0, dataDirectory: data, ffprobe: fakeProbe });
  const freshToken = await token(restarted.origin);
  assert.equal((await finalize(restarted.origin, freshToken, sessionId, 2)).status, 200);
  await restarted.close();

  const secondData = `${data}-db`;
  const second = await prepare(secondData, [Buffer.from('alpha'), Buffer.from('omega')]);
  const secondId = second.sessionId;
  await second.close();
  store = await openMetadata(secondData);
  const failingStore: MetadataStore = {
    isReady: () => store.isReady(), insertSession: value => store.insertSession(value), findSession: id => store.findSession(id),
    listSessionIds: () => store.listSessionIds(), listSessions: (limit, cursor) => store.listSessions(limit, cursor),
    findChunk: (id, sequence) => store.findChunk(id, sequence), listChunks: () => store.listChunks(), commitChunk: value => store.commitChunk(value),
    beginFinalization: (id, count, at) => store.beginFinalization(id, count, at),
    completeFinalization: () => { throw new Error('synthetic database completion failure'); }, close: () => undefined,
    markInterrupted: (id, at) => store.markInterrupted(id, at), markRecoverable: (id, at) => store.markRecoverable(id, at),
  };
  await assert.rejects(createFinalizationService(failingStore, secondData, fakeProbe).finalize(secondId, 2));
  store.close();
  restarted = await startServer({ port: 0, dataDirectory: secondData, ffprobe: fakeProbe });
  try {
    const response = responseSchema(recordingSessionSchema).parse(await (await fetch(`${restarted.origin}/api/v1/sessions/${secondId}`)).json());
    assert.ok(response.ok);
    assert.equal(response.data.status, 'completed');
    assert.equal(response.data.output?.expectedChunkCount, 2);
  } finally { await restarted.close(); }
}));

const ffprobeAvailable = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { windowsHide: true }).status === 0;
test('actual browser-produced multi-chunk WebM is accepted by real FFprobe', { skip: ffprobeAvailable ? false : 'FFprobe is not installed; real media validation was not executed.' }, () => fixture(async data => {
  const browser = await chromium.launch({ headless: true });
  let bytes: Uint8Array;
  try {
    const page = await browser.newPage();
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d')!;
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.start(100);
      for (let frame = 0; frame < 30; frame++) {
        context.fillStyle = frame % 2 ? '#f00' : '#00f'; context.fillRect(0, 0, 320, 180);
        await new Promise(resolve => setTimeout(resolve, 34));
      }
      await new Promise<void>(resolve => { recorder.onstop = () => resolve(); recorder.stop(); });
      const buffer = await new Blob(chunks).arrayBuffer();
      return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    });
    bytes = Buffer.from(base64, 'base64');
  } finally { await browser.close(); }
  const cut1 = Math.floor(bytes.length / 3); const cut2 = Math.floor(bytes.length * 2 / 3);
  const running = await prepare(data, [bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)], createFFprobeAdapter());
  try {
    const response = await finalize(running.origin, running.writeToken, running.sessionId, 3);
    assert.equal(response.status, 200, await response.text());
  } finally { await running.close(); }
}));
