import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecoveryClient } from '../apps/client/src/media/recovery-client.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(43);
const inspection = { schemaVersion: 1, sessionId: id, title: 'Interrupted', lifecycleStatus: 'interrupted',
  condition: 'valid-incomplete', committedChunkCount: 1, contiguousChunkCount: 1, verifiedBytes: 12,
  activeOperation: false, recoverable: true, message: 'Verified.', output: null };
const output = { schemaVersion: 1, sessionId: id, expectedChunkCount: 1, byteLength: 12, sha256: 'b'.repeat(64),
  mimeType: 'video/webm', finalizedAt: '2026-11-11T12:00:00.000Z',
  probe: { formatName: 'webm', durationMs: 1000, video: { codec: 'vp8', width: 1280, height: 720 }, audio: null } };

test('recovery client authorizes once, validates inspection, and sends explicit salvage', async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const client = new RecoveryClient({ fetch: async (input, init) => {
    requests.push({ input, init });
    if (input.endsWith('/bootstrap')) return new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { writeToken: token } }));
    if (input.endsWith('/recovery/salvage')) return new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: output }));
    return new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { items: [inspection] } }));
  } });
  assert.deepEqual(await client.list(), [inspection]);
  assert.deepEqual(await client.salvage(id), output);
  assert.equal(requests.filter(request => request.input.endsWith('/bootstrap')).length, 1);
  const salvage = requests.at(-1)!;
  assert.equal(salvage.init.method, 'POST');
  assert.equal(salvage.init.body, '{}');
  assert.equal(new Headers(salvage.init.headers).get('X-Recorder-Token'), token);
});

test('recovery client rejects malformed or unauthorized responses without claiming success', async () => {
  const client = new RecoveryClient({ fetch: async input => input.endsWith('/bootstrap')
    ? new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { writeToken: token } }))
    : new Response(JSON.stringify({ apiVersion: 'v1', ok: false, error: { code: 'UNAUTHORIZED', message: 'Reload to authorize.' } }), { status: 401 }) });
  await assert.rejects(client.list(), /Reload to authorize/);

  const malformed = new RecoveryClient({ fetch: async input => input.endsWith('/bootstrap')
    ? new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { writeToken: token } }))
    : new Response(JSON.stringify({ apiVersion: 'v1', ok: true, data: { items: [{ recoverable: true }] } })) });
  await assert.rejects(malformed.list(), /could not be inspected/i);
});
