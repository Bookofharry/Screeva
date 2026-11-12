import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FFprobeAdapter } from '../apps/server/src/media/ffprobe.js';
import { startServer } from '../apps/server/src/server.js';
import {
  finalizedRecordingSchema,
  recoveryInspectionSchema,
  recoveryListSchema,
  responseSchema,
} from '../packages/shared/src/index.js';

const configuration = { layout: 'screen' as const, resolution: '720p' as const, fps: 30 as const,
  videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' as const };
const probe: FFprobeAdapter = { probe: async () => ({ formatName: 'matroska,webm', durationMs: 750,
  video: { codec: 'vp8', width: 1280, height: 720 }, audio: null }) };

async function fixture(run: (data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-recovery-'));
  try { await run(path.join(root, 'data')); } finally { await rm(root, { recursive: true, force: true }); }
}

async function token(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  return (await response.json() as { data: { writeToken: string } }).data.writeToken;
}
function headers(origin: string, writeToken: string, json = true) {
  return { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': writeToken, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
async function create(origin: string, writeToken: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/sessions`, { method: 'POST', headers: headers(origin, writeToken),
    body: JSON.stringify({ title: 'Interrupted fixture', configuration }) });
  return (await response.json() as { data: { id: string } }).data.id;
}
async function upload(origin: string, writeToken: string, id: string, sequence: number, bytes: Buffer) {
  const response = await fetch(`${origin}/api/v1/sessions/${id}/chunks/${sequence}`, { method: 'PUT', headers: {
    ...headers(origin, writeToken, false), 'Content-Type': 'video/webm;codecs=vp8', 'Content-Length': String(bytes.length),
    'X-Recorder-Chunk-Sha256': createHash('sha256').update(bytes).digest('hex'),
    'X-Recorder-Chunk-Timestamp': new Date(1_800_000_000_000 + sequence).toISOString(),
  }, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  assert.equal(response.status, 200, await response.text());
}
async function inspect(origin: string, writeToken: string, id: string) {
  const response = await fetch(`${origin}/api/v1/sessions/${id}/recovery`, { headers: headers(origin, writeToken, false) });
  return { response, body: responseSchema(recoveryInspectionSchema).parse(await response.json()) };
}
async function salvage(origin: string, writeToken: string, id: string) {
  return fetch(`${origin}/api/v1/sessions/${id}/recovery/salvage`, { method: 'POST', headers: headers(origin, writeToken), body: '{}' });
}

test('restart detects an interrupted session and idempotently salvages only verified acknowledged chunks', () => fixture(async data => {
  let running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  let writeToken = await token(running.origin);
  const id = await create(running.origin, writeToken);
  const chunks = [Buffer.from('first acknowledged webm fragment'), Buffer.from('second acknowledged webm fragment')];
  for (const [sequence, bytes] of chunks.entries()) await upload(running.origin, writeToken, id, sequence, bytes);
  await running.close();

  running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  try {
    writeToken = await token(running.origin);
    const checked = await inspect(running.origin, writeToken, id);
    assert.ok(checked.body.ok);
    assert.equal(checked.body.data.lifecycleStatus, 'interrupted');
    assert.equal(checked.body.data.condition, 'valid-incomplete');
    assert.equal(checked.body.data.contiguousChunkCount, 2);
    assert.equal(checked.body.data.verifiedBytes, chunks[0]!.length + chunks[1]!.length);
    assert.equal(checked.body.data.recoverable, true);

    const [first, duplicate] = await Promise.all([salvage(running.origin, writeToken, id), salvage(running.origin, writeToken, id)]);
    assert.equal(first.status, 200); assert.equal(duplicate.status, 200);
    const firstBody = responseSchema(finalizedRecordingSchema).parse(await first.json());
    const duplicateBody = responseSchema(finalizedRecordingSchema).parse(await duplicate.json());
    assert.ok(firstBody.ok); assert.ok(duplicateBody.ok);
    assert.deepEqual(duplicateBody.data, firstBody.data);
    const repeated = await salvage(running.origin, writeToken, id);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await readFile(path.join(data, 'sessions', id, 'capture', '000000000000.webm.part')), chunks[0]);
    assert.deepEqual(await readFile(path.join(data, 'sessions', id, 'capture', '000000000001.webm.part')), chunks[1]);
  } finally { await running.close(); }
}));

test('inspection distinguishes empty and active sessions and requires authenticated same-origin access', () => fixture(async data => {
  const running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  try {
    const writeToken = await token(running.origin);
    const empty = await create(running.origin, writeToken);
    const emptyCheck = await inspect(running.origin, writeToken, empty);
    assert.ok(emptyCheck.body.ok); assert.equal(emptyCheck.body.data.condition, 'empty');
    assert.equal((await salvage(running.origin, writeToken, empty)).status, 409);

    const active = await create(running.origin, writeToken);
    await upload(running.origin, writeToken, active, 0, Buffer.from('acknowledged active data'));
    const heartbeat = await fetch(`${running.origin}/api/v1/sessions/${active}/heartbeat`, { method: 'POST', headers: headers(running.origin, writeToken), body: '{}' });
    assert.equal(heartbeat.status, 200);
    const activeCheck = await inspect(running.origin, writeToken, active);
    assert.ok(activeCheck.body.ok); assert.equal(activeCheck.body.data.condition, 'active');
    assert.equal((await salvage(running.origin, writeToken, active)).status, 409);

    assert.equal((await fetch(`${running.origin}/api/v1/recovery`, { headers: { Origin: running.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': 'x'.repeat(43) } })).status, 401);
    assert.equal((await fetch(`${running.origin}/api/v1/recovery`, { headers: { 'X-Recorder-Token': writeToken } })).status, 403);
    const listResponse = await fetch(`${running.origin}/api/v1/recovery`, { headers: headers(running.origin, writeToken, false) });
    const list = responseSchema(recoveryListSchema).parse(await listResponse.json());
    assert.ok(list.ok); assert.equal(list.data.items.length, 2);
  } finally { await running.close(); }
}));

test('failed media probe never claims recovery completion and a restart can safely retry', () => fixture(async data => {
  const brokenProbe: FFprobeAdapter = { probe: async () => { throw new Error('synthetic probe failure'); } };
  let running = await startServer({ port: 0, dataDirectory: data, ffprobe: brokenProbe });
  let writeToken = await token(running.origin);
  const id = await create(running.origin, writeToken);
  await upload(running.origin, writeToken, id, 0, Buffer.from('probe failure fixture'));
  await running.close();

  running = await startServer({ port: 0, dataDirectory: data, ffprobe: brokenProbe });
  writeToken = await token(running.origin);
  assert.equal((await salvage(running.origin, writeToken, id)).status, 500);
  const afterFailure = await inspect(running.origin, writeToken, id);
  assert.ok(afterFailure.body.ok); assert.equal(afterFailure.body.data.lifecycleStatus, 'finalizing');
  assert.equal(afterFailure.body.data.recoverable, true);
  await running.close();

  running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  try {
    writeToken = await token(running.origin);
    const retried = await salvage(running.origin, writeToken, id);
    assert.equal(retried.status, 200);
    const body = responseSchema(finalizedRecordingSchema).parse(await retried.json());
    assert.ok(body.ok);
  } finally { await running.close(); }
}));

test('missing committed bytes remain corrupt and cannot be salvaged after restart', () => fixture(async data => {
  let running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  let writeToken = await token(running.origin);
  const id = await create(running.origin, writeToken);
  await upload(running.origin, writeToken, id, 0, Buffer.from('will be missing'));
  await running.close();
  await unlink(path.join(data, 'sessions', id, 'capture', '000000000000.webm.part'));
  running = await startServer({ port: 0, dataDirectory: data, ffprobe: probe });
  try {
    writeToken = await token(running.origin);
    const checked = await inspect(running.origin, writeToken, id);
    assert.ok(checked.body.ok); assert.equal(checked.body.data.condition, 'corrupt');
    assert.equal(checked.body.data.recoverable, false);
    assert.equal((await salvage(running.origin, writeToken, id)).status, 409);
  } finally { await running.close(); }
}));
