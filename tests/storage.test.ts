import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMetadata } from '../apps/server/src/storage/database.js';
import { sessionDirectory } from '../apps/server/src/storage/paths.js';
import { startServer } from '../apps/server/src/server.js';
import type { RecordingSession } from '../packages/shared/src/index.js';

async function fixture(run: (root: string, data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-storage-'));
  try { await run(root, path.join(root, 'data')); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('initializes real local directories and schema; reopening preserves existing rows and media bytes', () => fixture(async (_root, data) => {
  const first = await openMetadata(data);
  assert.equal(first.isReady(), true);
  const id = randomUUID();
  const record: RecordingSession = {
    schemaVersion: 1, id, title: 'Persistence fixture', status: 'interrupted',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    configuration: { layout: 'pip', resolution: '720p', fps: 30, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined' },
    chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 },
    output: null,
  };
  first.insertSession(record);
  first.close();
  assert.deepEqual((await readdir(data)).sort(), ['exports', 'logs', 'recorder.sqlite', 'sessions']);
  const db = new DatabaseSync(path.join(data, 'recorder.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
  db.close();
  const sessionPath = await sessionDirectory(data, id);
  await mkdir(sessionPath);
  const marker = path.join(sessionPath, 'synthetic-marker.txt');
  await writeFile(marker, 'synthetic preservation marker');
  const second = await openMetadata(data);
  assert.deepEqual(second.findSession(id), record);
  second.close();
  const reopened = new DatabaseSync(path.join(data, 'recorder.sqlite'));
  assert.equal(reopened.prepare('SELECT status FROM sessions WHERE id = ?').get(id)?.status, 'interrupted');
  reopened.close();
  assert.equal(await readFile(marker, 'utf8'), 'synthetic preservation marker');
}));

test('migrates schema v1 transactionally and preserves legacy sessions with safe defaults', () => fixture(async (_root, data) => {
  await mkdir(data);
  const id = randomUUID();
  const databasePath = path.join(data, 'recorder.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'preview', 'recording', 'paused', 'finalizing', 'completed', 'interrupted', 'recoverable', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'interrupted', '2026-11-10T00:00:00.000Z', '2026-11-10T00:01:00.000Z');
  legacy.close();
  const store = await openMetadata(data);
  const migrated = store.findSession(id);
  assert.ok(migrated);
  assert.equal(migrated.title, 'Untitled recording');
  assert.equal(migrated.status, 'interrupted');
  assert.deepEqual(migrated.chunks, { committedCount: 0, committedBytes: 0, nextSequence: 0 });
  store.close();
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 4);
  assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sessions_v1'").get()?.count, 0);
  reopened.close();
}));

test('migrates schema v2 by adding an empty chunk ledger without changing session metadata', () => fixture(async (_root, data) => {
  await mkdir(data);
  const id = randomUUID();
  const databasePath = path.join(data, 'recorder.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      committed_chunk_count INTEGER NOT NULL DEFAULT 0,
      committed_bytes INTEGER NOT NULL DEFAULT 0,
      next_chunk_sequence INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    PRAGMA user_version = 2;
  `);
  const configuration = JSON.stringify({ layout: 'pip', resolution: '720p', fps: 30, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined' });
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)')
    .run(id, 'V2 session', 'idle', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', configuration);
  legacy.close();
  const store = await openMetadata(data);
  assert.equal(store.findSession(id)?.title, 'V2 session');
  assert.deepEqual(store.listChunks(), []);
  store.close();
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 4);
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM recording_chunks').get()?.count, 0);
  reopened.close();
}));

test('migrates schema v3 by adding nullable finalization metadata without changing chunks', () => fixture(async (_root, data) => {
  await mkdir(data);
  const id = randomUUID();
  const databasePath = path.join(data, 'recorder.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, configuration_json TEXT NOT NULL,
      committed_chunk_count INTEGER NOT NULL DEFAULT 0, committed_bytes INTEGER NOT NULL DEFAULT 0,
      next_chunk_sequence INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE recording_chunks (
      session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, byte_length INTEGER NOT NULL,
      sha256 TEXT NOT NULL, client_timestamp TEXT NOT NULL, mime_type TEXT NOT NULL, committed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    ) STRICT;
    PRAGMA user_version = 3;
  `);
  const configuration = JSON.stringify({ layout: 'screen', resolution: '720p', fps: 30, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' });
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)')
    .run(id, 'V3 session', 'idle', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', configuration);
  legacy.close();
  const store = await openMetadata(data);
  assert.equal(store.findSession(id)?.output, null);
  store.close();
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 4);
  const migrated = reopened.prepare('SELECT expected_chunk_count, finalization_json FROM sessions WHERE id = ?').get(id);
  assert.equal(migrated?.expected_chunk_count, null);
  assert.equal(migrated?.finalization_json, null);
  reopened.close();
}));

test('invalid legacy rows roll back migration without replacing schema v1', () => fixture(async (_root, data) => {
  await mkdir(data);
  const databasePath = path.join(data, 'recorder.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    PRAGMA user_version = 1;
  `);
  const id = randomUUID();
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'idle', 'not-an-iso-timestamp', 'not-an-iso-timestamp');
  legacy.close();
  await assert.rejects(openMetadata(data));
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(reopened.prepare('SELECT created_at FROM sessions WHERE id = ?').get(id)?.created_at, 'not-an-iso-timestamp');
  assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sessions_v1'").get()?.count, 0);
  reopened.close();
}));

test('database trigger permits only declared lifecycle transitions', () => fixture(async (_root, data) => {
  const store = await openMetadata(data);
  const id = randomUUID();
  store.insertSession({
    schemaVersion: 1, id, title: 'Lifecycle fixture', status: 'idle',
    createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    configuration: { layout: 'screen', resolution: '720p', fps: 30, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'microphone' },
    chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 },
    output: null,
  });
  store.close();
  const db = new DatabaseSync(path.join(data, 'recorder.sqlite'));
  db.prepare("UPDATE sessions SET status = 'preview' WHERE id = ?").run(id);
  assert.throws(() => db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(id), /invalid session lifecycle transition/);
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id = ?').get(id)?.status, 'preview');
  db.close();
}));

test('finalization metadata commits only through guarded lifecycle transitions and remains idempotent', () => fixture(async (_root, data) => {
  const store = await openMetadata(data);
  const id = randomUUID();
  store.insertSession({
    schemaVersion: 1, id, title: 'Finalize metadata fixture', status: 'idle',
    createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    configuration: { layout: 'screen', resolution: '720p', fps: 30, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' },
    chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 }, output: null,
  });
  store.commitChunk({
    schemaVersion: 1, sessionId: id, sequence: 0, byteLength: 4, sha256: 'a'.repeat(64),
    timestamp: '2026-11-11T00:00:01.000Z', mimeType: 'video/webm', committedAt: '2026-11-11T00:00:02.000Z',
  });
  assert.equal(store.beginFinalization(id, 1, '2026-11-11T00:00:03.000Z').status, 'finalizing');
  const output = {
    schemaVersion: 1 as const, sessionId: id, expectedChunkCount: 1, byteLength: 4, sha256: 'b'.repeat(64),
    mimeType: 'video/webm' as const, finalizedAt: '2026-11-11T00:00:04.000Z',
    probe: { formatName: 'matroska,webm', durationMs: 1000, video: { codec: 'vp8', width: 1280, height: 720 }, audio: null },
  };
  assert.equal(store.completeFinalization(output).status, 'completed');
  assert.deepEqual(store.completeFinalization(output).output, output);
  assert.throws(() => store.beginFinalization(id, 2, '2026-11-11T00:00:05.000Z'), /conflicts/);
  store.close();
}));

test('session paths accept opaque UUIDs and reject traversal, absolute paths, alternate streams and encoded inputs', () => fixture(async (_root, data) => {
  const store = await openMetadata(data); store.close();
  const id = randomUUID();
  assert.equal(await sessionDirectory(data, id), path.join(data, 'sessions', id));
  for (const bad of ['../outside', '..\\outside', '/tmp/outside', 'C:\\outside', '%2e%2e%2f', id + ':stream', id + '/..', id.toUpperCase(), 'CON', '']) {
    await assert.rejects(sessionDirectory(data, bad));
  }
}));

test('rejects linked data directories, session directories and changed sessions roots', () => fixture(async (root, data) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const linked = path.join(root, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openMetadata(linked), /real directories/);
  const store = await openMetadata(data); store.close();
  const id = randomUUID();
  await symlink(outside, path.join(data, 'sessions', id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(sessionDirectory(data, id), /real directories/);
  await rm(path.join(data, 'sessions'), { recursive: true });
  await symlink(outside, path.join(data, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(sessionDirectory(data, randomUUID()), /real directories/);
  assert.deepEqual(await readdir(outside), []);
}));

test('rejects invalid database files without overwriting them', () => fixture(async (_root, data) => {
  await mkdir(data);
  const databasePath = path.join(data, 'recorder.sqlite');
  await writeFile(databasePath, 'not a database');
  await assert.rejects(openMetadata(data));
  assert.equal(await readFile(databasePath, 'utf8'), 'not a database');
}));

test('rejects newer schema versions without resetting them', () => fixture(async (_root, data) => {
  await mkdir(data);
  const databasePath = path.join(data, 'recorder.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA user_version = 99; CREATE TABLE keep_me (value TEXT); INSERT INTO keep_me VALUES (\'retained\');'); db.close();
  await assert.rejects(openMetadata(data), /Unsupported metadata schema/);
  const reopened = new DatabaseSync(databasePath);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 99);
  assert.equal(reopened.prepare('SELECT value FROM keep_me').get()?.value, 'retained'); reopened.close();
}));

test('rejects hard-linked metadata and sidecar files without altering their targets', () => fixture(async (root, data) => {
  await mkdir(data);
  const original = path.join(root, 'preserve.txt');
  await writeFile(original, 'preserve external bytes');
  const target = path.join(data, 'recorder.sqlite');
  await link(original, target);
  await assert.rejects(openMetadata(data), /Unsafe metadata file/);
  await rm(target);
  const store = await openMetadata(data); store.close();
  await link(original, target + '-wal');
  await assert.rejects(openMetadata(data), /Unsafe metadata file/);
  assert.equal(await readFile(original, 'utf8'), 'preserve external bytes');
}));

test('versioned but incomplete schema fails startup without replacing the database', () => fixture(async (_root, data) => {
  await mkdir(data);
  const db = new DatabaseSync(path.join(data, 'recorder.sqlite'));
  db.exec('PRAGMA user_version = 1; CREATE TABLE keep_me (value TEXT);'); db.close();
  await assert.rejects(openMetadata(data), /no such table/);
  const reopened = new DatabaseSync(path.join(data, 'recorder.sqlite'));
  assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'keep_me'").get()?.count, 1);
  reopened.close();
}));

test('startup errors preserve existing storage and release resources', () => fixture(async (_root, data) => {
  await writeFile(data, 'do not replace');
  await assert.rejects(openMetadata(data), /real directories/);
  assert.equal(await readFile(data, 'utf8'), 'do not replace');
}));

test('port collisions fail without preventing a subsequent clean launch', () => fixture(async (root, data) => {
  const first = await startServer({ port: 0, dataDirectory: data });
  const port = Number(new URL(first.origin).port);
  try {
    await assert.rejects(startServer({ port, dataDirectory: path.join(root, 'second') }), { code: 'EADDRINUSE' });
    const next = await startServer({ port: 0, dataDirectory: path.join(root, 'second') });
    await next.close(); await next.close();
  } finally { await first.close(); }
}));

test('invalid port configuration is rejected before storage is touched', () => fixture(async (root, data) => {
  for (const port of [-1, 65536, NaN, 1.5]) await assert.rejects(startServer({ port, dataDirectory: data }), /Invalid port/);
  assert.deepEqual(await readdir(root), []);
}));
