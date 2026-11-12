import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../apps/server/src/app.js';
import { canTransitionSession } from '../apps/server/src/services/sessions.js';
import { startServer } from '../apps/server/src/server.js';
import type { MetadataStore } from '../apps/server/src/storage/database.js';
import {
  bootstrapSchema,
  createSessionInputSchema,
  errorEnvelopeSchema,
  recordingSessionSchema,
  responseSchema,
  sessionListSchema,
  type CreateSessionInput,
} from '../packages/shared/src/index.js';

let sandbox: string;
let dataDirectory: string;
let running: Awaited<ReturnType<typeof startServer>>;
let token: string;

const configuration: CreateSessionInput['configuration'] = {
  layout: 'pip', resolution: '720p', fps: 30,
  videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined',
};

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'recorder-sessions-'));
  dataDirectory = path.join(sandbox, 'data');
  running = await startServer({ port: 0, dataDirectory });
  token = await getToken(running.origin);
});

after(async () => {
  await running?.close();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

async function getToken(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  const body = responseSchema(bootstrapSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data.writeToken;
}

function writeHeaders(origin = running.origin, candidate = token): Record<string, string> {
  return { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': candidate, 'Content-Type': 'application/json' };
}

async function create(title: string, inputConfiguration = configuration) {
  const response = await fetch(`${running.origin}/api/v1/sessions`, {
    method: 'POST', headers: writeHeaders(), body: JSON.stringify({ title, configuration: inputConfiguration }),
  });
  assert.equal(response.status, 201);
  const body = responseSchema(recordingSessionSchema).parse(await response.json());
  assert.ok(body.ok);
  return body.data;
}

async function assertApiError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  const body = errorEnvelopeSchema.parse(await response.json());
  assert.equal(body.error.code, code);
}

test('shared create schema is strict and lifecycle transition policy is guarded', () => {
  assert.equal(createSessionInputSchema.safeParse({ title: ' Session ', configuration }).success, true);
  for (const value of [
    { title: '', configuration },
    { title: 'x'.repeat(121), configuration },
    { title: 'Unsafe', configuration, path: '../outside' },
    { title: 'Unsafe', configuration: { ...configuration, fps: 60 } },
  ]) assert.equal(createSessionInputSchema.safeParse(value).success, false);
  assert.equal(canTransitionSession('idle', 'preview'), true);
  assert.equal(canTransitionSession('recording', 'paused'), true);
  assert.equal(canTransitionSession('completed', 'recording'), false);
  assert.equal(canTransitionSession('preview', 'completed'), false);
});

test('creates, retrieves and paginates validated sessions without accepting client paths or lifecycle state', async () => {
  const first = await create("  First creator's session  ");
  const second = await create('Second session');
  const third = await create('Third session');
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.title, "First creator's session");
  assert.equal(first.status, 'idle');
  assert.deepEqual(first.configuration, configuration);
  assert.deepEqual(first.chunks, { committedCount: 0, committedBytes: 0, nextSequence: 0 });
  assert.equal(first.createdAt, first.updatedAt);

  const retrievedResponse = await fetch(`${running.origin}/api/v1/sessions/${first.id}`);
  const retrieved = responseSchema(recordingSessionSchema).parse(await retrievedResponse.json());
  assert.equal(retrievedResponse.status, 200);
  assert.ok(retrieved.ok);
  assert.deepEqual(retrieved.data, first);

  const pageOneResponse = await fetch(`${running.origin}/api/v1/sessions?limit=2`);
  const pageOne = responseSchema(sessionListSchema).parse(await pageOneResponse.json());
  assert.ok(pageOne.ok);
  assert.equal(pageOne.data.items.length, 2);
  assert.ok(pageOne.data.nextCursor);
  const pageTwo = responseSchema(sessionListSchema).parse(await (await fetch(`${running.origin}/api/v1/sessions?limit=2&cursor=${pageOne.data.nextCursor}`)).json());
  assert.ok(pageTwo.ok);
  assert.equal(pageTwo.data.items.length >= 1, true);
  const ids = [...pageOne.data.items, ...pageTwo.data.items].map(session => session.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [first.id, second.id, third.id]) assert.equal(ids.includes(id), true);
});

test('rejects malformed creation, pagination, IDs and missing sessions with versioned errors', async () => {
  const invalidBodies = [
    {}, { title: '', configuration }, { title: 'Bad', configuration: { ...configuration, resolution: '4k' } },
    { title: 'Bad', configuration, status: 'completed' }, { title: 'Bad', configuration, directory: 'C:\\private' },
  ];
  for (const body of invalidBodies) {
    await assertApiError(await fetch(`${running.origin}/api/v1/sessions`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) }), 400, 'INVALID_REQUEST');
  }
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions`, { method: 'POST', headers: { ...writeHeaders(), 'Content-Type': 'text/plain' }, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1&limit=2', 'cursor=../outside', 'extra=true']) {
    await assertApiError(await fetch(`${running.origin}/api/v1/sessions?${query}`), 400, 'INVALID_REQUEST');
  }
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions/not-a-uuid`), 400, 'INVALID_REQUEST');
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions/00000000-0000-4000-8000-000000000000`), 404, 'NOT_FOUND');
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions?cursor=00000000-0000-4000-8000-000000000000`), 400, 'INVALID_REQUEST');
});

test('session creation retains same-origin write authentication while reads remain local-origin guarded', async () => {
  const body = JSON.stringify({ title: 'Auth fixture', configuration });
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 403, 'FORBIDDEN');
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions`, { method: 'POST', headers: writeHeaders(running.origin, 'a'.repeat(43)), body }), 401, 'UNAUTHORIZED');
  await assertApiError(await fetch(`${running.origin}/api/v1/sessions`, { headers: { Origin: 'https://evil.example' } }), 403, 'FORBIDDEN');
});

test('created metadata survives a clean server restart with a rotated write token', async () => {
  const created = await create('Restart persistence');
  const previousToken = token;
  await running.close();
  running = await startServer({ port: 0, dataDirectory });
  token = await getToken(running.origin);
  assert.notEqual(token, previousToken);
  const response = await fetch(`${running.origin}/api/v1/sessions/${created.id}`);
  const body = responseSchema(recordingSessionSchema).parse(await response.json());
  assert.ok(body.ok);
  assert.deepEqual(body.data, created);
});

test('database failures return a generic versioned error without leaking details', async () => {
  const failureStore: MetadataStore = {
    isReady: () => true,
    insertSession: () => { throw new Error('private database path and SQL detail'); },
    findSession: () => { throw new Error('private database path and SQL detail'); },
    listSessionIds: () => { throw new Error('private database path and SQL detail'); },
    listSessions: () => { throw new Error('private database path and SQL detail'); },
    findChunk: () => { throw new Error('private database path and SQL detail'); },
    listChunks: () => { throw new Error('private database path and SQL detail'); },
    commitChunk: () => { throw new Error('private database path and SQL detail'); },
    beginFinalization: () => { throw new Error('private database path and SQL detail'); },
    completeFinalization: () => { throw new Error('private database path and SQL detail'); },
    markInterrupted: () => { throw new Error('private database path and SQL detail'); },
    markRecoverable: () => { throw new Error('private database path and SQL detail'); },
    close: () => undefined,
  };
  let host = '';
  const server = createServer(createApp({ expectedHost: () => host, store: failureStore }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing test address.')); return; }
      host = `127.0.0.1:${address.port}`;
      resolve();
    });
  });
  try {
    const response = await fetch(`http://${host}/api/v1/sessions`);
    assert.equal(response.status, 500);
    const text = await response.text();
    const parsed = errorEnvelopeSchema.parse(JSON.parse(text));
    assert.equal(parsed.error.code, 'INTERNAL_ERROR');
    assert.equal(text.includes('private database'), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
