import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  committedRecordingChunkSchema,
  finalizedRecordingSchema,
  type CommittedRecordingChunk,
  type ErrorCode,
  type FinalizedRecording,
} from '../../../../packages/shared/src/index.js';
import type { FFprobeAdapter } from '../media/ffprobe.js';
import type { MetadataStore } from '../storage/database.js';
import { assertDirectoryChain, ensureDirectory, sessionDirectory } from '../storage/paths.js';
import { SessionOperationLock } from './session-operation-lock.js';

const SEQUENCE_WIDTH = 12;
const FINAL_MEDIA_NAME = 'recording.webm';
const FINAL_SIDECAR_NAME = 'recording.commit.json';

export class FinalizationError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, readonly publicMessage: string) {
    super(publicMessage);
  }
}

export interface FinalizationHooks {
  afterOutputPublished?(output: FinalizedRecording): void | Promise<void>;
  afterSidecarPublished?(output: FinalizedRecording): void | Promise<void>;
  beforeDatabaseCommit?(output: FinalizedRecording): void | Promise<void>;
}

export interface FinalizationService {
  finalize(sessionId: string, expectedChunkCount: number): Promise<FinalizedRecording>;
  reconcile(): Promise<void>;
}

function chunkFiles(capture: string, sequence: number) {
  const stem = sequence.toString().padStart(SEQUENCE_WIDTH, '0');
  return { media: path.join(capture, `${stem}.webm.part`), sidecar: path.join(capture, `${stem}.commit.json`) };
}

async function regularFileOrNull(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe recording storage file.');
    return info;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeRegularFile(file: string): Promise<void> {
  if (await regularFileOrNull(file)) await rm(file);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory FlushFileBuffers through Node. Files
    // are individually flushed before rename; POSIX additionally fsyncs dirs.
    if (!(process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

async function hashFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function sameChunk(left: CommittedRecordingChunk, right: CommittedRecordingChunk): boolean {
  return left.sessionId === right.sessionId && left.sequence === right.sequence && left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 && left.timestamp === right.timestamp && left.mimeType === right.mimeType &&
    left.committedAt === right.committedAt;
}

async function readChunkSidecar(file: string): Promise<CommittedRecordingChunk> {
  const info = await regularFileOrNull(file);
  if (!info || info.size > 4096) throw new Error('Invalid committed chunk sidecar.');
  return committedRecordingChunkSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

async function readFinalSidecar(file: string): Promise<FinalizedRecording> {
  const info = await regularFileOrNull(file);
  if (!info || info.size > 64 * 1024) throw new Error('Invalid finalization sidecar.');
  return finalizedRecordingSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

async function writeSidecarAtomic(directory: string, destination: string, output: FinalizedRecording): Promise<void> {
  const temporary = path.join(directory, `.commit-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(output));
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await regularFileOrNull(destination)) throw new Error('Finalization sidecar already exists.');
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeRegularFile(temporary).catch(() => undefined);
    throw error;
  }
}

export function createFinalizationService(
  store: MetadataStore,
  dataDirectory: string,
  probe: FFprobeAdapter,
  hooks: FinalizationHooks = {},
  locks = new SessionOperationLock(),
): FinalizationService {
  async function directories(sessionId: string, createFinal: boolean) {
    const session = await sessionDirectory(dataDirectory, sessionId);
    if (createFinal) await ensureDirectory(session);
    else await assertDirectoryChain(session);
    const capture = path.join(session, 'capture');
    await assertDirectoryChain(capture);
    const final = path.join(session, 'final');
    if (createFinal) await ensureDirectory(final);
    else await assertDirectoryChain(final);
    return { capture, final };
  }

  function orderedChunks(sessionId: string, expectedChunkCount: number): CommittedRecordingChunk[] {
    const session = store.findSession(sessionId);
    if (!session) throw new FinalizationError(404, 'NOT_FOUND', 'Session not found.');
    const chunks = store.listChunks().filter(chunk => chunk.sessionId === sessionId);
    if (session.chunks.committedCount !== expectedChunkCount || session.chunks.nextSequence !== expectedChunkCount || chunks.length !== expectedChunkCount) {
      throw new FinalizationError(409, 'CONFLICT', 'Expected chunk count does not match the durable ledger.');
    }
    chunks.forEach((chunk, index) => {
      if (chunk.sequence !== index) throw new FinalizationError(409, 'CONFLICT', 'Durable chunk sequence is not contiguous from zero.');
    });
    return chunks;
  }

  async function validateChunk(capture: string, chunk: CommittedRecordingChunk): Promise<void> {
    const files = chunkFiles(capture, chunk.sequence);
    const media = await regularFileOrNull(files.media);
    if (!media || media.size !== chunk.byteLength) throw new Error('Committed chunk has a missing or invalid media file.');
    const sidecar = await readChunkSidecar(files.sidecar);
    if (!sameChunk(sidecar, chunk)) throw new Error('Committed chunk sidecar conflicts with the ledger.');
    if (await hashFile(files.media) !== chunk.sha256) throw new Error('Committed chunk checksum mismatch.');
  }

  async function validatePublishedOutput(final: string, output: FinalizedRecording): Promise<void> {
    const mediaPath = path.join(final, FINAL_MEDIA_NAME);
    const media = await regularFileOrNull(mediaPath);
    if (!media || media.size !== output.byteLength) throw new Error('Finalized media is missing or has the wrong length.');
    if (await hashFile(mediaPath) !== output.sha256) throw new Error('Finalized media checksum mismatch.');
  }

  async function reconcileSession(sessionId: string): Promise<void> {
    const session = store.findSession(sessionId);
    if (!session) return;
    const sessionPath = await sessionDirectory(dataDirectory, sessionId);
    let final: string;
    try {
      await assertDirectoryChain(sessionPath);
      final = path.join(sessionPath, 'final');
      await assertDirectoryChain(final);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (session.status === 'completed') throw new Error('Completed session finalization files are missing.', { cause: error });
        return;
      }
      throw error;
    }
    for (const entry of await readdir(final, { withFileTypes: true })) {
      if (/^\.(?:finalize|commit)-.+\.tmp$/.test(entry.name)) await removeRegularFile(path.join(final, entry.name));
    }
    const mediaPath = path.join(final, FINAL_MEDIA_NAME);
    const sidecarPath = path.join(final, FINAL_SIDECAR_NAME);
    const media = await regularFileOrNull(mediaPath);
    const sidecar = await regularFileOrNull(sidecarPath);
    if (!media || !sidecar) {
      if (session.status === 'completed') throw new Error('Completed session finalization files are incomplete.');
      if (media) await removeRegularFile(mediaPath);
      if (sidecar) await removeRegularFile(sidecarPath);
      return;
    }
    const output = await readFinalSidecar(sidecarPath);
    if (output.sessionId !== sessionId) throw new Error('Finalization sidecar path identity mismatch.');
    await validatePublishedOutput(final, output);
    if (session.status === 'completed') {
      if (JSON.stringify(session.output) !== JSON.stringify(output)) throw new Error('Completed session metadata conflicts with its finalization sidecar.');
      return;
    }
    if (session.status !== 'finalizing') throw new Error('Published finalization belongs to an invalid session lifecycle.');
    await hooks.beforeDatabaseCommit?.(output);
    store.completeFinalization(output);
  }

  async function concatenate(capture: string, final: string, chunks: readonly CommittedRecordingChunk[]) {
    const temporary = path.join(final, `.finalize-${randomUUID()}.tmp`);
    const destination = path.join(final, FINAL_MEDIA_NAME);
    const outputHash = createHash('sha256');
    let total = 0;
    let outputHandle;
    try {
      outputHandle = await open(temporary, 'wx', 0o600);
      for (const chunk of chunks) {
        const sourcePath = chunkFiles(capture, chunk.sequence).media;
        const sourceInfo = await regularFileOrNull(sourcePath);
        if (!sourceInfo || sourceInfo.size !== chunk.byteLength) throw new Error('Committed chunk changed before finalization.');
        const source = await open(sourcePath, 'r');
        const chunkHash = createHash('sha256');
        let chunkBytes = 0;
        try {
          const openedInfo = await source.stat();
          if (!openedInfo.isFile() || openedInfo.nlink !== 1 || openedInfo.size !== chunk.byteLength) {
            throw new Error('Unsafe committed chunk file.');
          }
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            const bytes = buffer.subarray(0, bytesRead);
            chunkHash.update(bytes);
            outputHash.update(bytes);
            chunkBytes += bytesRead;
            total += bytesRead;
            let offset = 0;
            while (offset < bytesRead) {
              const written = await outputHandle.write(bytes, offset, bytesRead - offset, null);
              if (written.bytesWritten === 0) throw new Error('Final output write made no progress.');
              offset += written.bytesWritten;
            }
          }
        } finally {
          await source.close();
        }
        if (chunkBytes !== chunk.byteLength || chunkHash.digest('hex') !== chunk.sha256) throw new Error('Committed chunk changed during finalization.');
      }
      await outputHandle.sync();
      await outputHandle.close();
      outputHandle = undefined;
      return { temporary, destination, byteLength: total, sha256: outputHash.digest('hex') };
    } catch (error) {
      await outputHandle?.close().catch(() => undefined);
      await removeRegularFile(temporary).catch(() => undefined);
      throw error;
    }
  }

  return {
    finalize: (sessionId, expectedChunkCount) => locks.run(sessionId, async () => {
      if (!Number.isInteger(expectedChunkCount) || expectedChunkCount <= 0 || expectedChunkCount > 1_000_000) {
        throw new FinalizationError(400, 'INVALID_REQUEST', 'Invalid expected chunk count.');
      }
      await reconcileSession(sessionId);
      const existing = store.findSession(sessionId);
      if (!existing) throw new FinalizationError(404, 'NOT_FOUND', 'Session not found.');
      if (existing.status === 'completed') {
        if (!existing.output || existing.output.expectedChunkCount !== expectedChunkCount) {
          throw new FinalizationError(409, 'CONFLICT', 'Finalization request conflicts with the completed session.');
        }
        return existing.output;
      }
      const chunks = orderedChunks(sessionId, expectedChunkCount);
      let locations;
      try { locations = await directories(sessionId, true); }
      catch { throw new FinalizationError(500, 'INTERNAL_ERROR', 'Committed chunk storage is unavailable.'); }
      try {
        for (const chunk of chunks) await validateChunk(locations.capture, chunk);
      } catch {
        throw new FinalizationError(500, 'INTERNAL_ERROR', 'A committed chunk failed integrity validation.');
      }
      try {
        store.beginFinalization(sessionId, expectedChunkCount, new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && /count|lifecycle|conflict/i.test(error.message)) {
          throw new FinalizationError(409, 'CONFLICT', 'Session cannot be finalized in its current state.');
        }
        throw error;
      }
      let assembled: Awaited<ReturnType<typeof concatenate>> | undefined;
      try {
        assembled = await concatenate(locations.capture, locations.final, chunks);
        const probeResult = await probe.probe(assembled.temporary);
        const output = finalizedRecordingSchema.parse({
          schemaVersion: 1,
          sessionId,
          expectedChunkCount,
          byteLength: assembled.byteLength,
          sha256: assembled.sha256,
          mimeType: 'video/webm',
          finalizedAt: new Date().toISOString(),
          probe: probeResult,
        });
        if (await regularFileOrNull(assembled.destination)) throw new Error('Finalized media already exists without a valid commit.');
        await rename(assembled.temporary, assembled.destination);
        await syncDirectory(locations.final);
        await hooks.afterOutputPublished?.(output);
        await writeSidecarAtomic(locations.final, path.join(locations.final, FINAL_SIDECAR_NAME), output);
        await hooks.afterSidecarPublished?.(output);
        await hooks.beforeDatabaseCommit?.(output);
        store.completeFinalization(output);
        return output;
      } catch (error) {
        if (assembled) await removeRegularFile(assembled.temporary).catch(() => undefined);
        if (error instanceof FinalizationError) throw error;
        throw new FinalizationError(500, 'INTERNAL_ERROR', 'The recording could not be finalized safely.');
      }
    }),
    reconcile: async () => {
      for (const sessionId of store.listSessionIds()) await locks.run(sessionId, () => reconcileSession(sessionId));
    },
  };
}
