import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  committedRecordingChunkSchema,
  finalizedRecordingSchema,
  recordingConfigurationSchema,
  recordingSessionSchema,
  type CommittedRecordingChunk,
  type FinalizedRecording,
  type RecordingSession,
  type SessionList,
} from '../../../../packages/shared/src/index.js';
import { ensureDirectory } from './paths.js';

export interface MetadataStore {
  isReady(): boolean;
  insertSession(session: RecordingSession): void;
  findSession(id: string): RecordingSession | null;
  listSessionIds(): string[];
  listSessions(limit: number, cursor?: string): SessionList;
  findChunk(sessionId: string, sequence: number): CommittedRecordingChunk | null;
  listChunks(): CommittedRecordingChunk[];
  commitChunk(chunk: CommittedRecordingChunk): void;
  beginFinalization(sessionId: string, expectedChunkCount: number, updatedAt: string): RecordingSession;
  completeFinalization(output: FinalizedRecording): RecordingSession;
  markInterrupted(sessionId: string, updatedAt: string): RecordingSession;
  markRecoverable(sessionId: string, updatedAt: string): RecordingSession;
  close(): void;
}

const SCHEMA_VERSION = 4;
const migratedConfiguration = recordingConfigurationSchema.parse({
  layout: 'pip', resolution: '720p', fps: 30,
  videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined',
});

const createSessionsTable = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120 AND title = trim(title)),
    status TEXT NOT NULL CHECK (status IN ('idle', 'preview', 'recording', 'paused', 'finalizing', 'completed', 'interrupted', 'recoverable', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    committed_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (committed_chunk_count >= 0),
    committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
    next_chunk_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_sequence >= 0)
  ) STRICT;
  CREATE INDEX sessions_created_id ON sessions(created_at DESC, id DESC);
`;

const createTransitionTrigger = `
  CREATE TRIGGER sessions_guard_status_transition
  BEFORE UPDATE OF status ON sessions
  WHEN NEW.status <> OLD.status AND NOT (
    (OLD.status = 'idle' AND NEW.status IN ('preview', 'failed')) OR
    (OLD.status = 'preview' AND NEW.status IN ('idle', 'recording', 'failed')) OR
    (OLD.status = 'recording' AND NEW.status IN ('paused', 'finalizing', 'interrupted', 'failed')) OR
    (OLD.status = 'paused' AND NEW.status IN ('recording', 'finalizing', 'interrupted', 'failed')) OR
    (OLD.status = 'finalizing' AND NEW.status IN ('completed', 'recoverable', 'failed')) OR
    (OLD.status = 'interrupted' AND NEW.status IN ('recoverable', 'failed')) OR
    (OLD.status = 'recoverable' AND NEW.status IN ('finalizing', 'failed')) OR
    (OLD.status = 'failed' AND NEW.status = 'recoverable')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid session lifecycle transition');
  END;
`;

const createChunksTable = `
  CREATE TABLE recording_chunks (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
    client_timestamp TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
  ) STRICT;
`;

interface SessionRow {
  id: unknown; title: unknown; status: unknown; created_at: unknown; updated_at: unknown;
  configuration_json: unknown; committed_chunk_count: unknown; committed_bytes: unknown; next_chunk_sequence: unknown;
  expected_chunk_count: unknown; finalization_json: unknown;
}

interface ChunkRow {
  session_id: unknown; sequence: unknown; byte_length: unknown; sha256: unknown;
  client_timestamp: unknown; mime_type: unknown; committed_at: unknown;
}

function mapSession(row: SessionRow): RecordingSession {
  if (typeof row.configuration_json !== 'string') throw new Error('Invalid stored recording configuration.');
  if (row.finalization_json !== null && typeof row.finalization_json !== 'string') throw new Error('Invalid stored finalization metadata.');
  return recordingSessionSchema.parse({
    schemaVersion: 1,
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    configuration: JSON.parse(row.configuration_json) as unknown,
    chunks: {
      committedCount: row.committed_chunk_count,
      committedBytes: row.committed_bytes,
      nextSequence: row.next_chunk_sequence,
    },
    output: row.finalization_json === null ? null : JSON.parse(row.finalization_json) as unknown,
  });
}

function mapChunk(row: ChunkRow): CommittedRecordingChunk {
  return committedRecordingChunkSchema.parse({
    schemaVersion: 1,
    sessionId: row.session_id,
    sequence: row.sequence,
    byteLength: row.byte_length,
    sha256: row.sha256,
    timestamp: row.client_timestamp,
    mimeType: row.mime_type,
    committedAt: row.committed_at,
  });
}

async function rejectUnsafeFile(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe metadata file.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export async function openMetadata(root: string): Promise<MetadataStore> {
  await ensureDirectory(root);
  for (const directory of ['sessions', 'exports', 'logs']) await ensureDirectory(path.join(root, directory));
  const databasePath = path.join(root, 'recorder.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rejectUnsafeFile(databasePath + suffix);
  const db = new DatabaseSync(databasePath);
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version < 0 || version > SCHEMA_VERSION) throw new Error('Unsupported metadata schema version.');
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    let currentVersion = version;
    if (currentVersion === 0) {
      db.exec(`BEGIN IMMEDIATE; ${createSessionsTable} ${createTransitionTrigger} ${createChunksTable}
        ALTER TABLE sessions ADD COLUMN expected_chunk_count INTEGER CHECK (expected_chunk_count IS NULL OR expected_chunk_count > 0);
        ALTER TABLE sessions ADD COLUMN finalization_json TEXT;
        PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      currentVersion = SCHEMA_VERSION;
    } else if (currentVersion === 1) {
      // Validate the old table before entering a migration that replaces it.
      const rows = db.prepare('SELECT id, state, created_at, updated_at FROM sessions').all();
      db.exec(`BEGIN IMMEDIATE; ALTER TABLE sessions RENAME TO sessions_v1; ${createSessionsTable}`);
      try {
        const insert = db.prepare(`INSERT INTO sessions
          (id, title, status, created_at, updated_at, configuration_json, committed_chunk_count, committed_bytes, next_chunk_sequence)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`);
        for (const row of rows) {
          if (typeof row.id !== 'string' || typeof row.state !== 'string' || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
            throw new Error('Invalid legacy session metadata.');
          }
          const migrated = recordingSessionSchema.parse({
            schemaVersion: 1,
            id: row.id,
            title: 'Untitled recording',
            status: row.state,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            configuration: migratedConfiguration,
            chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 },
            output: null,
          });
          insert.run(migrated.id, migrated.title, migrated.status, migrated.createdAt, migrated.updatedAt, JSON.stringify(migrated.configuration));
        }
        db.exec(`DROP TABLE sessions_v1; ${createTransitionTrigger} PRAGMA user_version = 2; COMMIT;`);
        currentVersion = 2;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    }
    if (currentVersion === 2) {
      db.exec(`BEGIN IMMEDIATE; ${createChunksTable} PRAGMA user_version = 3; COMMIT;`);
      currentVersion = 3;
    }
    if (currentVersion === 3) {
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN expected_chunk_count INTEGER CHECK (expected_chunk_count IS NULL OR expected_chunk_count > 0);
        ALTER TABLE sessions ADD COLUMN finalization_json TEXT;
        PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      currentVersion = SCHEMA_VERSION;
    }
    // Fail startup for a versioned but incomplete/corrupt schema.
    db.prepare(`SELECT id, title, status, created_at, updated_at, configuration_json,
      committed_chunk_count, committed_bytes, next_chunk_sequence, expected_chunk_count, finalization_json FROM sessions LIMIT 0`).all();
    db.prepare(`SELECT session_id, sequence, byte_length, sha256, client_timestamp, mime_type, committed_at
      FROM recording_chunks LIMIT 0`).all();
  } catch (error) {
    db.close();
    throw error;
  }
  const selectColumns = `id, title, status, created_at, updated_at, configuration_json,
    committed_chunk_count, committed_bytes, next_chunk_sequence, expected_chunk_count, finalization_json`;
  const insert = db.prepare(`INSERT INTO sessions
    (id, title, status, created_at, updated_at, configuration_json, committed_chunk_count, committed_bytes, next_chunk_sequence,
     expected_chunk_count, finalization_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const find = db.prepare(`SELECT ${selectColumns} FROM sessions WHERE id = ?`);
  const firstPage = db.prepare(`SELECT ${selectColumns} FROM sessions ORDER BY created_at DESC, id DESC LIMIT ?`);
  const sessionIds = db.prepare('SELECT id FROM sessions ORDER BY id');
  const cursorPage = db.prepare(`SELECT ${selectColumns} FROM sessions
    WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?`);
  const chunkColumns = 'session_id, sequence, byte_length, sha256, client_timestamp, mime_type, committed_at';
  const findChunk = db.prepare(`SELECT ${chunkColumns} FROM recording_chunks WHERE session_id = ? AND sequence = ?`);
  const listChunks = db.prepare(`SELECT ${chunkColumns} FROM recording_chunks ORDER BY session_id, sequence`);
  const insertChunk = db.prepare(`INSERT INTO recording_chunks
    (session_id, sequence, byte_length, sha256, client_timestamp, mime_type, committed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const advanceSession = db.prepare(`UPDATE sessions SET
    committed_chunk_count = committed_chunk_count + 1,
    committed_bytes = committed_bytes + ?,
    next_chunk_sequence = next_chunk_sequence + 1,
    updated_at = ?
    WHERE id = ? AND next_chunk_sequence = ?`);
  const updateStatus = db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND status = ?');
  const setFinalizing = db.prepare(`UPDATE sessions SET status = 'finalizing', expected_chunk_count = ?, updated_at = ?
    WHERE id = ? AND status = ? AND committed_chunk_count = ? AND next_chunk_sequence = ?`);
  const setCompleted = db.prepare(`UPDATE sessions SET status = 'completed', finalization_json = ?, updated_at = ?
    WHERE id = ? AND status = 'finalizing' AND expected_chunk_count = ?`);
  return {
    isReady: () => db.prepare('SELECT 1 AS ready').get()?.ready === 1,
    insertSession: session => {
      const parsed = recordingSessionSchema.parse(session);
      if (parsed.output !== null) throw new Error('New sessions cannot contain finalization metadata.');
      insert.run(parsed.id, parsed.title, parsed.status, parsed.createdAt, parsed.updatedAt, JSON.stringify(parsed.configuration),
        parsed.chunks.committedCount, parsed.chunks.committedBytes, parsed.chunks.nextSequence, null, null);
    },
    findSession: id => {
      const row = find.get(id) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },
    listSessionIds: () => (sessionIds.all() as Array<{ id: unknown }>).map(row => {
      if (typeof row.id !== 'string') throw new Error('Invalid stored session ID.');
      return row.id;
    }),
    listSessions: (limit, cursor) => {
      let rows: SessionRow[];
      if (cursor) {
        const cursorRow = find.get(cursor) as SessionRow | undefined;
        if (!cursorRow || typeof cursorRow.created_at !== 'string') throw new Error('Invalid pagination cursor.');
        rows = cursorPage.all(cursorRow.created_at, cursorRow.created_at, cursor, limit + 1) as unknown as SessionRow[];
      } else {
        rows = firstPage.all(limit + 1) as unknown as SessionRow[];
      }
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapSession);
      return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
    },
    findChunk: (sessionId, sequence) => {
      const row = findChunk.get(sessionId, sequence) as ChunkRow | undefined;
      return row ? mapChunk(row) : null;
    },
    listChunks: () => (listChunks.all() as unknown as ChunkRow[]).map(mapChunk),
    commitChunk: chunk => {
      const parsed = committedRecordingChunkSchema.parse(chunk);
      db.exec('BEGIN IMMEDIATE;');
      try {
        insertChunk.run(parsed.sessionId, parsed.sequence, parsed.byteLength, parsed.sha256,
          parsed.timestamp, parsed.mimeType, parsed.committedAt);
        const result = advanceSession.run(parsed.byteLength, parsed.committedAt, parsed.sessionId, parsed.sequence);
        if (result.changes !== 1) throw new Error('Chunk is not the next sequence for this session.');
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    beginFinalization: (sessionId, expectedChunkCount, updatedAt) => {
      if (!Number.isInteger(expectedChunkCount) || expectedChunkCount <= 0 || expectedChunkCount > 1_000_000) {
        throw new Error('Invalid expected chunk count.');
      }
      db.exec('BEGIN IMMEDIATE;');
      try {
        let session = find.get(sessionId) as SessionRow | undefined;
        if (!session) throw new Error('Session not found.');
        if (session.finalization_json !== null || session.status === 'completed') {
          if (session.expected_chunk_count !== expectedChunkCount) throw new Error('Finalization chunk count conflicts with completed session.');
          db.exec('COMMIT;');
          return mapSession(session);
        }
        if (session.status === 'finalizing') {
          if (session.expected_chunk_count !== expectedChunkCount) throw new Error('Finalization chunk count conflict.');
          db.exec('COMMIT;');
          return mapSession(session);
        }
        if (session.committed_chunk_count !== expectedChunkCount || session.next_chunk_sequence !== expectedChunkCount) {
          throw new Error('Session chunk count does not match finalization request.');
        }
        if (typeof session.status !== 'string') throw new Error('Invalid stored session lifecycle.');
        let status = session.status;
        if (status === 'idle') {
          if (updateStatus.run('preview', updatedAt, sessionId, 'idle').changes !== 1) throw new Error('Could not advance session lifecycle.');
          status = 'preview';
        }
        if (status === 'preview') {
          if (updateStatus.run('recording', updatedAt, sessionId, 'preview').changes !== 1) throw new Error('Could not advance session lifecycle.');
          status = 'recording';
        }
        if (!['recording', 'paused', 'recoverable'].includes(String(status))) throw new Error('Session lifecycle cannot be finalized.');
        if (setFinalizing.run(expectedChunkCount, updatedAt, sessionId, status, expectedChunkCount, expectedChunkCount).changes !== 1) {
          throw new Error('Could not begin session finalization.');
        }
        db.exec('COMMIT;');
        session = find.get(sessionId) as unknown as SessionRow;
        return mapSession(session);
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    completeFinalization: output => {
      const parsed = finalizedRecordingSchema.parse(output);
      db.exec('BEGIN IMMEDIATE;');
      try {
        const current = find.get(parsed.sessionId) as SessionRow | undefined;
        if (!current) throw new Error('Session not found.');
        if (current.status === 'completed') {
          const completed = mapSession(current);
          if (JSON.stringify(completed.output) !== JSON.stringify(parsed)) throw new Error('Completed finalization metadata conflict.');
          db.exec('COMMIT;');
          return completed;
        }
        if (setCompleted.run(JSON.stringify(parsed), parsed.finalizedAt, parsed.sessionId, parsed.expectedChunkCount).changes !== 1) {
          throw new Error('Could not complete session finalization.');
        }
        db.exec('COMMIT;');
        return mapSession(find.get(parsed.sessionId) as unknown as SessionRow);
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    markInterrupted: (sessionId, updatedAt) => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        let row = find.get(sessionId) as SessionRow | undefined;
        if (!row) throw new Error('Session not found.');
        if (row.finalization_json !== null || ['completed', 'finalizing', 'interrupted', 'recoverable'].includes(String(row.status))) {
          db.exec('COMMIT;');
          return mapSession(row);
        }
        if (Number(row.committed_chunk_count) <= 0) throw new Error('Empty session cannot be marked interrupted.');
        let status = String(row.status);
        if (status === 'idle') {
          if (updateStatus.run('preview', updatedAt, sessionId, 'idle').changes !== 1) throw new Error('Could not advance interrupted session lifecycle.');
          status = 'preview';
        }
        if (status === 'preview') {
          if (updateStatus.run('recording', updatedAt, sessionId, 'preview').changes !== 1) throw new Error('Could not advance interrupted session lifecycle.');
          status = 'recording';
        }
        if (!['recording', 'paused'].includes(status) || updateStatus.run('interrupted', updatedAt, sessionId, status).changes !== 1) {
          throw new Error('Session lifecycle cannot be marked interrupted.');
        }
        db.exec('COMMIT;');
        row = find.get(sessionId) as unknown as SessionRow;
        return mapSession(row);
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    markRecoverable: (sessionId, updatedAt) => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        let row = find.get(sessionId) as SessionRow | undefined;
        if (!row) throw new Error('Session not found.');
        if (row.status === 'recoverable' || row.status === 'finalizing' || row.status === 'completed') {
          db.exec('COMMIT;');
          return mapSession(row);
        }
        if (row.status !== 'interrupted' || updateStatus.run('recoverable', updatedAt, sessionId, 'interrupted').changes !== 1) {
          throw new Error('Session lifecycle cannot be marked recoverable.');
        }
        db.exec('COMMIT;');
        row = find.get(sessionId) as unknown as SessionRow;
        return mapSession(row);
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
