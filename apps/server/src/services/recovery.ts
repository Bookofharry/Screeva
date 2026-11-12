import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  committedRecordingChunkSchema,
  recoveryInspectionSchema,
  type CommittedRecordingChunk,
  type ErrorCode,
  type FinalizedRecording,
  type RecordingSession,
  type RecoveryInspection,
} from '../../../../packages/shared/src/index.js';
import type { MetadataStore } from '../storage/database.js';
import { assertDirectoryChain, sessionDirectory } from '../storage/paths.js';
import type { FinalizationService } from './finalization.js';
import { SessionActivityRegistry } from './session-activity.js';
import { SessionOperationLock } from './session-operation-lock.js';

const SEQUENCE_WIDTH = 12;

export class RecoveryError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, readonly publicMessage: string) {
    super(publicMessage);
  }
}

export interface RecoveryService {
  reconcile(): Promise<void>;
  list(): Promise<RecoveryInspection[]>;
  inspect(sessionId: string): Promise<RecoveryInspection>;
  salvage(sessionId: string): Promise<FinalizedRecording>;
}

function filesFor(capture: string, sequence: number) {
  const stem = sequence.toString().padStart(SEQUENCE_WIDTH, '0');
  return { media: path.join(capture, `${stem}.webm.part`), sidecar: path.join(capture, `${stem}.commit.json`) };
}

async function regularFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe recovery storage file.');
  return info;
}

async function digestFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  const digest = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return digest.digest('hex');
}

function sameChunk(left: CommittedRecordingChunk, right: CommittedRecordingChunk): boolean {
  return left.sessionId === right.sessionId && left.sequence === right.sequence && left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 && left.timestamp === right.timestamp && left.mimeType === right.mimeType &&
    left.committedAt === right.committedAt;
}

function result(session: RecordingSession, values: Omit<RecoveryInspection, 'schemaVersion' | 'sessionId' | 'title' | 'lifecycleStatus' | 'output'>): RecoveryInspection {
  return recoveryInspectionSchema.parse({
    schemaVersion: 1,
    sessionId: session.id,
    title: session.title,
    lifecycleStatus: session.status,
    output: session.output,
    ...values,
  });
}

export function createRecoveryService(
  store: MetadataStore,
  dataDirectory: string,
  finalization: FinalizationService,
  locks: SessionOperationLock,
  activity: SessionActivityRegistry,
): RecoveryService {
  const salvageTasks = new Map<string, Promise<FinalizedRecording>>();
  async function verify(session: RecordingSession): Promise<{ count: number; bytes: number; error?: string; unavailable?: boolean }> {
    const chunks = store.listChunks().filter(chunk => chunk.sessionId === session.id).sort((a, b) => a.sequence - b.sequence);
    let count = 0;
    let bytes = 0;
    try {
      if (chunks.length !== session.chunks.committedCount || session.chunks.nextSequence !== chunks.length ||
          session.chunks.committedBytes !== chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)) {
        return { count, bytes, error: 'Durable ledger counters do not agree.' };
      }
      if (chunks.length === 0) return { count, bytes };
      const sessionPath = await sessionDirectory(dataDirectory, session.id);
      const capture = path.resolve(sessionPath, 'capture');
      if (path.dirname(capture) !== sessionPath) throw new Error('Invalid recovery path.');
      await assertDirectoryChain(capture);
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.sequence !== index) return { count, bytes, error: 'Committed chunk sequence is not contiguous from zero.' };
        const files = filesFor(capture, index);
        const media = await regularFile(files.media);
        if (media.size !== chunk.byteLength) return { count, bytes, error: 'A committed chunk is missing or has the wrong length.' };
        const sidecarInfo = await regularFile(files.sidecar);
        if (sidecarInfo.size > 4096) return { count, bytes, error: 'A committed chunk sidecar is invalid.' };
        const sidecar = committedRecordingChunkSchema.safeParse(JSON.parse(await readFile(files.sidecar, 'utf8')) as unknown);
        if (!sidecar.success || !sameChunk(sidecar.data, chunk)) return { count, bytes, error: 'A committed chunk sidecar conflicts with the ledger.' };
        if (await digestFile(files.media) !== chunk.sha256) return { count, bytes, error: 'A committed chunk checksum is invalid.' };
        count++;
        bytes += chunk.byteLength;
      }
      return { count, bytes };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code)) return { count, bytes, error: 'Committed recovery files are missing or unsafe.' };
      return { count, bytes, error: 'Recovery storage could not be inspected.', unavailable: true };
    }
  }

  async function inspectLocked(sessionId: string): Promise<RecoveryInspection> {
    let session = store.findSession(sessionId);
    if (!session) throw new RecoveryError(404, 'NOT_FOUND', 'Session not found.');
    if (session.status === 'completed' && session.output) {
      return result(session, { condition: 'completed', committedChunkCount: session.chunks.committedCount,
        contiguousChunkCount: session.chunks.committedCount, verifiedBytes: session.chunks.committedBytes,
        activeOperation: false, recoverable: false, message: 'This recording is already finalized.' });
    }
    const checked = await verify(session);
    if (checked.error) {
      return result(session, { condition: checked.unavailable ? 'unavailable' : 'corrupt', committedChunkCount: session.chunks.committedCount,
        contiguousChunkCount: checked.count, verifiedBytes: checked.bytes, activeOperation: false, recoverable: false,
        message: checked.error });
    }
    if (checked.count === 0) {
      return result(session, { condition: 'empty', committedChunkCount: 0, contiguousChunkCount: 0, verifiedBytes: 0,
        activeOperation: false, recoverable: false, message: 'No server-acknowledged recording chunks are available.' });
    }
    if (['idle', 'preview', 'recording', 'paused'].includes(session.status)) {
      session = store.markInterrupted(session.id, new Date().toISOString());
    }
    const finalizing = session.status === 'finalizing';
    return result(session, { condition: finalizing ? 'finalizing' : 'valid-incomplete', committedChunkCount: session.chunks.committedCount,
      contiguousChunkCount: checked.count, verifiedBytes: checked.bytes, activeOperation: false, recoverable: true,
      message: finalizing ? 'A previous finalization did not complete; verified chunks can be retried.' :
        'All server-acknowledged chunks are intact and can be salvaged best-effort.' });
  }

  async function inspect(sessionId: string): Promise<RecoveryInspection> {
    const session = store.findSession(sessionId);
    if (!session) throw new RecoveryError(404, 'NOT_FOUND', 'Session not found.');
    if (activity.isActive(sessionId) || locks.isBusy(sessionId)) {
      return result(session, { condition: 'active', committedChunkCount: session.chunks.committedCount,
        contiguousChunkCount: 0, verifiedBytes: 0, activeOperation: true, recoverable: false,
        message: 'Recording, upload, or finalization activity is still active.' });
    }
    const attempt = await locks.tryRun(sessionId, () => inspectLocked(sessionId));
    if (attempt.acquired) return attempt.value;
    const current = store.findSession(sessionId) ?? session;
    return result(current, { condition: 'active', committedChunkCount: current.chunks.committedCount,
      contiguousChunkCount: 0, verifiedBytes: 0, activeOperation: true, recoverable: false,
      message: 'Recording, upload, or finalization activity is still active.' });
  }

  return {
    reconcile: async () => {
      for (const sessionId of store.listSessionIds()) {
        const session = store.findSession(sessionId);
        if (session && session.chunks.committedCount > 0 && ['idle', 'preview', 'recording', 'paused'].includes(session.status)) {
          await locks.run(sessionId, async () => { store.markInterrupted(sessionId, new Date().toISOString()); });
        }
      }
    },
    list: async () => {
      const items: RecoveryInspection[] = [];
      for (const sessionId of store.listSessionIds()) {
        const session = store.findSession(sessionId);
        if (session?.status !== 'completed') items.push(await inspect(sessionId));
      }
      return items;
    },
    inspect,
    salvage: async sessionId => {
      const existingTask = salvageTasks.get(sessionId);
      if (existingTask) return existingTask;
      const task = (async () => {
      if (activity.isActive(sessionId)) throw new RecoveryError(409, 'CONFLICT', 'The session is still active. Stop recording before recovery.');
      const attempt = await locks.tryRun(sessionId, async () => {
        const inspection = await inspectLocked(sessionId);
        if (inspection.condition === 'completed' && inspection.output) return { completed: inspection.output } as const;
        if (!inspection.recoverable || inspection.contiguousChunkCount === 0) {
          throw new RecoveryError(409, 'CONFLICT', inspection.message);
        }
        const session = store.findSession(sessionId);
        if (!session) throw new RecoveryError(404, 'NOT_FOUND', 'Session not found.');
        if (session.status !== 'finalizing') store.markRecoverable(sessionId, new Date().toISOString());
        return { expectedChunkCount: inspection.contiguousChunkCount } as const;
      });
      if (!attempt.acquired) throw new RecoveryError(409, 'CONFLICT', 'The session has an active upload or finalization operation.');
      if ('completed' in attempt.value) return attempt.value.completed;
      try {
        return await finalization.finalize(sessionId, attempt.value.expectedChunkCount);
      } catch (error) {
        if (error instanceof RecoveryError) throw error;
        throw error;
      }
      })();
      salvageTasks.set(sessionId, task);
      try { return await task; }
      finally { if (salvageTasks.get(sessionId) === task) salvageTasks.delete(sessionId); }
    },
  };
}
