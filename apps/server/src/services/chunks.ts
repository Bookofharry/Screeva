import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import {
  chunkSequenceSchema,
  committedRecordingChunkSchema,
  durableChunkAckSchema,
  isoTimestampSchema,
  recordingChunkContentTypeSchema,
  sessionIdSchema,
  sha256Schema,
  type CommittedRecordingChunk,
  type DurableChunkAck,
  type ErrorCode,
} from '../../../../packages/shared/src/index.js';
import type { MetadataStore } from '../storage/database.js';
import { assertDirectoryChain, ensureDirectory, sessionDirectory } from '../storage/paths.js';
import { SessionOperationLock } from './session-operation-lock.js';

export const MAX_RECORDING_CHUNK_BYTES = 32 * 1024 * 1024;
const SEQUENCE_WIDTH = 12;
const UPLOAD_HEADER = 'x-recorder-chunk-sha256';
const TIMESTAMP_HEADER = 'x-recorder-chunk-timestamp';

export class ChunkIngestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export interface ChunkUploadDeclaration {
  readonly sessionId: string;
  readonly sequence: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly timestamp: string;
  readonly mimeType: string;
}

export interface ChunkIngestionHooks {
  afterFilePublished?(chunk: CommittedRecordingChunk): void | Promise<void>;
  afterSidecarPublished?(chunk: CommittedRecordingChunk): void | Promise<void>;
  beforeDatabaseCommit?(chunk: CommittedRecordingChunk): void | Promise<void>;
}

export interface ChunkIngestionService {
  ingest(request: Request, declaration: ChunkUploadDeclaration): Promise<DurableChunkAck>;
  reconcile(): Promise<void>;
  reconciliationError(sessionId: string): string | null;
}

function countHeader(request: Request, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count++;
  }
  return count;
}

function requiredSingleHeader(request: Request, name: string): string {
  if (countHeader(request, name) !== 1) throw new ChunkIngestionError(400, 'INVALID_REQUEST', `Exactly one ${name} header is required.`);
  const value = request.get(name);
  if (value === undefined) throw new ChunkIngestionError(400, 'INVALID_REQUEST', `Missing ${name} header.`);
  return value;
}

export function parseChunkUploadDeclaration(request: Request): ChunkUploadDeclaration {
  const sessionId = sessionIdSchema.safeParse(request.params.id);
  const sequenceText = request.params.seq;
  const sequence = typeof sequenceText === 'string' && /^(0|[1-9]\d*)$/.test(sequenceText)
    ? chunkSequenceSchema.safeParse(Number(sequenceText))
    : { success: false as const };
  if (!sessionId.success || !sequence.success) throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Invalid session ID or chunk sequence.');
  if (request.get('transfer-encoding') !== undefined || request.get('content-encoding') !== undefined) {
    throw new ChunkIngestionError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Chunk uploads must be unencoded with a declared Content-Length.');
  }
  const lengthText = requiredSingleHeader(request, 'content-length');
  if (!/^[1-9]\d*$/.test(lengthText)) throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Invalid chunk byte length.');
  const byteLength = Number(lengthText);
  if (!Number.isSafeInteger(byteLength)) throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Invalid chunk byte length.');
  if (byteLength > MAX_RECORDING_CHUNK_BYTES) {
    throw new ChunkIngestionError(413, 'PAYLOAD_TOO_LARGE', `Chunk exceeds the ${MAX_RECORDING_CHUNK_BYTES} byte limit.`);
  }
  const mimeType = recordingChunkContentTypeSchema.safeParse(requiredSingleHeader(request, 'content-type'));
  if (!mimeType.success) throw new ChunkIngestionError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use a valid video/webm content type.');
  const checksum = sha256Schema.safeParse(requiredSingleHeader(request, UPLOAD_HEADER));
  const timestamp = isoTimestampSchema.safeParse(requiredSingleHeader(request, TIMESTAMP_HEADER));
  if (!checksum.success || !timestamp.success) throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Invalid chunk checksum or timestamp.');
  return {
    sessionId: sessionId.data,
    sequence: sequence.data,
    byteLength,
    sha256: checksum.data,
    timestamp: timestamp.data,
    mimeType: mimeType.data,
  };
}

function sequenceStem(sequence: number): string {
  return sequence.toString().padStart(SEQUENCE_WIDTH, '0');
}

function chunkPaths(captureDirectory: string, sequence: number) {
  const stem = sequenceStem(sequence);
  return {
    media: path.join(captureDirectory, `${stem}.webm.part`),
    sidecar: path.join(captureDirectory, `${stem}.commit.json`),
  };
}

async function regularFileOrNull(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe chunk storage file.');
    return info;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Node/Windows cannot FlushFileBuffers on directory handles. The media and
    // sidecar files themselves are still fsynced before their atomic renames.
    if (!(process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  }
  finally { await handle.close(); }
}

async function removeRegularFile(file: string): Promise<void> {
  const info = await regularFileOrNull(file);
  if (info) await rm(file);
}

async function hashFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  const digest = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

function sameChunk(left: CommittedRecordingChunk, right: CommittedRecordingChunk): boolean {
  return left.sessionId === right.sessionId && left.sequence === right.sequence &&
    left.byteLength === right.byteLength && left.sha256 === right.sha256 &&
    left.timestamp === right.timestamp && left.mimeType === right.mimeType;
}

function matchesDeclaration(chunk: CommittedRecordingChunk, declaration: ChunkUploadDeclaration): boolean {
  return chunk.sessionId === declaration.sessionId && chunk.sequence === declaration.sequence &&
    chunk.byteLength === declaration.byteLength && chunk.sha256 === declaration.sha256 &&
    chunk.timestamp === declaration.timestamp && chunk.mimeType === declaration.mimeType;
}

function toAck(chunk: CommittedRecordingChunk): DurableChunkAck {
  return durableChunkAckSchema.parse({
    schemaVersion: 1,
    sessionId: chunk.sessionId,
    sequence: chunk.sequence,
    byteLength: chunk.byteLength,
    sha256: chunk.sha256,
    committed: true,
    committedAt: chunk.committedAt,
  });
}

async function readSidecar(file: string): Promise<CommittedRecordingChunk> {
  const info = await regularFileOrNull(file);
  if (!info || info.size > 4096) throw new Error('Invalid chunk commit sidecar.');
  return committedRecordingChunkSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

async function validatePublishedChunk(captureDirectory: string, chunk: CommittedRecordingChunk): Promise<void> {
  const files = chunkPaths(captureDirectory, chunk.sequence);
  const media = await regularFileOrNull(files.media);
  if (!media || media.size !== chunk.byteLength) throw new Error('Committed chunk media is missing or has the wrong size.');
  const sidecar = await readSidecar(files.sidecar);
  if (!sameChunk(sidecar, chunk)) throw new Error('Committed chunk sidecar conflicts with metadata.');
  if (await hashFile(files.media) !== chunk.sha256) throw new Error('Committed chunk checksum mismatch.');
}

async function writeSidecarAtomic(captureDirectory: string, destination: string, chunk: CommittedRecordingChunk): Promise<void> {
  const temporary = path.join(captureDirectory, `.commit-${sequenceStem(chunk.sequence)}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(chunk));
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await regularFileOrNull(destination)) throw new Error('Chunk commit sidecar already exists.');
    await rename(temporary, destination);
    await syncDirectory(captureDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeRegularFile(temporary).catch(() => undefined);
    throw error;
  }
}

export function createChunkIngestionService(
  store: MetadataStore,
  dataDirectory: string,
  hooks: ChunkIngestionHooks = {},
  locks = new SessionOperationLock(),
): ChunkIngestionService {
  const sessionsRoot = path.resolve(dataDirectory, 'sessions');
  const reconciliationErrors = new Map<string, string>();

  async function captureDirectory(sessionId: string, create: boolean): Promise<string | null> {
    const session = await sessionDirectory(dataDirectory, sessionId);
    if (!create) {
      try { await assertDirectoryChain(session); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    } else {
      await ensureDirectory(session);
    }
    const capture = path.resolve(session, 'capture');
    if (path.dirname(capture) !== session) throw new Error('Invalid capture path.');
    if (create) await ensureDirectory(capture);
    else {
      try { await assertDirectoryChain(capture); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    }
    return capture;
  }

  async function reconcileSession(sessionId: string): Promise<void> {
    const capture = await captureDirectory(sessionId, false);
    const databaseChunks = store.listChunks().filter(chunk => chunk.sessionId === sessionId);
    if (!capture) {
      if (databaseChunks.length > 0) throw new Error('Committed chunk directory is missing.');
      const session = store.findSession(sessionId);
      if (!session || session.chunks.committedCount !== 0 || session.chunks.committedBytes !== 0 || session.chunks.nextSequence !== 0) {
        throw new Error('Session chunk counters conflict with missing storage.');
      }
      return;
    }
    const entries = await readdir(capture, { withFileTypes: true });
    for (const entry of entries) {
      if (/^\.(?:upload|commit)-.+\.tmp$/.test(entry.name)) {
        await removeRegularFile(path.join(capture, entry.name));
      }
    }

    const sequences = new Set<number>(databaseChunks.map(chunk => chunk.sequence));
    for (const entry of entries) {
      const match = /^(\d+)\.commit\.json$/.exec(entry.name);
      if (match) sequences.add(Number(match[1]));
    }
    const ordered = [...sequences].filter(Number.isSafeInteger).sort((left, right) => left - right);
    for (const sequence of ordered) {
      const files = chunkPaths(capture, sequence);
      const stored = store.findChunk(sessionId, sequence);
      const media = await regularFileOrNull(files.media);
      const sidecarInfo = await regularFileOrNull(files.sidecar);
      if (!media || !sidecarInfo) {
        if (stored) throw new Error('Committed chunk files are incomplete.');
        if (media) await rm(files.media);
        if (sidecarInfo) await rm(files.sidecar);
        continue;
      }
      const sidecar = await readSidecar(files.sidecar);
      if (sidecar.sessionId !== sessionId || sidecar.sequence !== sequence) throw new Error('Chunk sidecar path identity mismatch.');
      await validatePublishedChunk(capture, sidecar);
      if (stored) {
        if (!sameChunk(stored, sidecar)) throw new Error('Chunk ledger conflicts with committed files.');
      } else {
        const session = store.findSession(sessionId);
        if (!session || session.chunks.nextSequence !== sequence) throw new Error('Orphan chunk is not the next session sequence.');
        store.commitChunk(sidecar);
      }
    }

    const refreshed = store.listChunks().filter(chunk => chunk.sessionId === sessionId);
    for (const chunk of refreshed) await validatePublishedChunk(capture, chunk);
    const session = store.findSession(sessionId);
    if (!session) throw new Error('Chunk ledger belongs to a missing session.');
    const committedBytes = refreshed.reduce((total, chunk, index) => {
      if (chunk.sequence !== index) throw new Error('Chunk ledger sequence is not contiguous.');
      return total + chunk.byteLength;
    }, 0);
    if (session.chunks.committedCount !== refreshed.length ||
        session.chunks.committedBytes !== committedBytes ||
        session.chunks.nextSequence !== refreshed.length) {
      throw new Error('Session chunk counters conflict with the durable ledger.');
    }

    const refreshedEntries = await readdir(capture, { withFileTypes: true });
    for (const entry of refreshedEntries) {
      const match = /^(\d+)\.webm\.part$/.exec(entry.name);
      if (!match) continue;
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || store.findChunk(sessionId, sequence)) continue;
      const files = chunkPaths(capture, sequence);
      if (!(await regularFileOrNull(files.sidecar))) await removeRegularFile(files.media);
    }
  }

  async function streamToTemporary(request: Request, capture: string, declaration: ChunkUploadDeclaration): Promise<{ path: string; checksum: string }> {
    const temporary = path.join(capture, `.upload-${sequenceStem(declaration.sequence)}-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    const digest = createHash('sha256');
    let received = 0;
    try {
      for await (const value of request) {
        if (request.aborted) throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Chunk upload was interrupted.');
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        received += bytes.length;
        if (received > declaration.byteLength || received > MAX_RECORDING_CHUNK_BYTES) {
          throw new ChunkIngestionError(413, 'PAYLOAD_TOO_LARGE', 'Chunk body exceeds its declared size or server limit.');
        }
        digest.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
          if (bytesWritten === 0) throw new Error('Chunk temporary file write made no progress.');
          offset += bytesWritten;
        }
      }
      if (!request.complete || received !== declaration.byteLength) {
        throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Chunk body length does not match Content-Length.');
      }
      await handle.sync();
      await handle.close();
      return { path: temporary, checksum: digest.digest('hex') };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await removeRegularFile(temporary).catch(() => undefined);
      throw error;
    }
  }

  return {
    ingest: (request, declaration) => locks.run(declaration.sessionId, async () => {
      if (!store.findSession(declaration.sessionId)) throw new ChunkIngestionError(404, 'NOT_FOUND', 'Session not found.');
      await reconcileSession(declaration.sessionId);
      const session = store.findSession(declaration.sessionId);
      if (!session) throw new ChunkIngestionError(404, 'NOT_FOUND', 'Session not found.');
      const existing = store.findChunk(declaration.sessionId, declaration.sequence);
      if (existing && !matchesDeclaration(existing, declaration)) {
        throw new ChunkIngestionError(409, 'CONFLICT', 'Chunk sequence is already committed with different metadata.');
      }
      if (!existing && !['idle', 'preview', 'recording', 'paused'].includes(session.status)) {
        throw new ChunkIngestionError(409, 'CONFLICT', 'Session lifecycle does not accept new chunks.');
      }
      if (!existing && declaration.sequence !== session.chunks.nextSequence) {
        throw new ChunkIngestionError(409, 'CONFLICT', 'Chunk sequence is not the next expected sequence.');
      }

      const capture = await captureDirectory(declaration.sessionId, true);
      if (!capture) throw new Error('Could not create chunk capture directory.');
      const streamed = await streamToTemporary(request, capture, declaration);
      try {
        if (streamed.checksum !== declaration.sha256) {
          throw new ChunkIngestionError(400, 'INVALID_REQUEST', 'Chunk checksum does not match the uploaded bytes.');
        }
        if (existing) return toAck(existing);

        const committed = committedRecordingChunkSchema.parse({
          schemaVersion: 1,
          ...declaration,
          committedAt: new Date().toISOString(),
        });
        const files = chunkPaths(capture, declaration.sequence);
        if (await regularFileOrNull(files.media) || await regularFileOrNull(files.sidecar)) {
          throw new Error('Unexpected chunk artifact already exists.');
        }
        await rename(streamed.path, files.media);
        await syncDirectory(capture);
        await hooks.afterFilePublished?.(committed);
        await writeSidecarAtomic(capture, files.sidecar, committed);
        await hooks.afterSidecarPublished?.(committed);
        await hooks.beforeDatabaseCommit?.(committed);
        store.commitChunk(committed);
        return toAck(committed);
      } finally {
        await removeRegularFile(streamed.path).catch(() => undefined);
      }
    }),
    reconcile: async () => {
      await assertDirectoryChain(sessionsRoot);
      const sessionIds = new Set(store.listSessionIds());
      for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (sessionIdSchema.safeParse(entry.name).success && store.findSession(entry.name)) sessionIds.add(entry.name);
      }
      for (const sessionId of sessionIds) {
        try {
          await locks.run(sessionId, () => reconcileSession(sessionId));
          reconciliationErrors.delete(sessionId);
        } catch {
          // Keep the server available so authenticated recovery inspection can
          // report the affected session. Ingestion still revalidates and fails.
          reconciliationErrors.set(sessionId, 'Committed chunk reconciliation failed.');
        }
      }
    },
    reconciliationError: sessionId => reconciliationErrors.get(sessionId) ?? null,
  };
}
