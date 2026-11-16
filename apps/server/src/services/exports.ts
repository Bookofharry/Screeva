import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { sessionIdSchema } from '../../../../packages/shared/src/index.js';
import type { FFmpegAdapter } from '../media/ffmpeg.js';
import type { MetadataStore } from '../storage/database.js';
import { assertDirectoryChain, sessionDirectory } from '../storage/paths.js';

const SOURCE_NAME = 'recording.webm';
const OUTPUT_NAME = 'recording.mp4';
const MAX_RETAINED_JOBS = 1_000;
const EXPORT_OVERHEAD_BYTES = 64 * 1024 * 1024;

export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExportJobOutput {
  fileName: typeof OUTPUT_NAME;
  mimeType: 'video/mp4';
  byteLength: number;
  sha256: string;
  completedAt: string;
}

export interface ExportJobSnapshot {
  id: string;
  sessionId: string;
  status: ExportJobStatus;
  createdAt: string;
  updatedAt: string;
  output: ExportJobOutput | null;
  error: string | null;
}

export interface ExportService {
  enqueue(sessionId: string): ExportJobSnapshot;
  getJob(jobId: string): ExportJobSnapshot | null;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

interface ExportJob extends ExportJobSnapshot {
  output: ExportJobOutput | null;
}

function snapshot(job: ExportJob): ExportJobSnapshot {
  return { ...job, output: job.output ? { ...job.output } : null };
}

async function regularFileOrNull(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe export storage file.');
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
    // Node cannot FlushFileBuffers for directories on Windows. Export files
    // themselves are flushed before rename; POSIX also receives this fsync.
    if (!(process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

async function inspectAndHash(file: string): Promise<{ byteLength: number; sha256: string }> {
  const before = await regularFileOrNull(file);
  if (!before) throw new Error('Recording file is missing.');
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) throw new Error('Recording file changed while opening.');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || byteLength !== before.size) throw new Error('Recording file changed while reading.');
  } finally {
    await handle.close();
  }
  return { byteLength, sha256: hash.digest('hex') };
}

async function flushFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export function createExportService(
  store: MetadataStore,
  dataDirectory: string,
  ffmpeg: FFmpegAdapter,
): ExportService {
  const jobs = new Map<string, ExportJob>();
  const sessionJobs = new Map<string, string>();
  const queue: string[] = [];
  const idleWaiters = new Set<() => void>();
  let running = false;
  let scheduled = false;
  let accepting = true;

  function resolveIdle(): void {
    if (running || queue.length > 0 || scheduled) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  async function exportRecording(job: ExportJob): Promise<ExportJobOutput> {
    const session = store.findSession(job.sessionId);
    if (!session || session.status !== 'completed' || !session.output) throw new Error('Only completed recordings can be exported.');
    const sessionPath = await sessionDirectory(dataDirectory, job.sessionId);
    await assertDirectoryChain(sessionPath);
    const finalDirectory = path.join(sessionPath, 'final');
    await assertDirectoryChain(finalDirectory);
    const source = path.join(finalDirectory, SOURCE_NAME);
    const destination = path.join(finalDirectory, OUTPUT_NAME);
    const temporary = path.join(finalDirectory, `.export-${randomUUID()}.tmp.mp4`);
    for (const entry of await readdir(finalDirectory, { withFileTypes: true })) {
      if (/^\.export-[0-9a-f-]+\.tmp\.mp4$/.test(entry.name)) await removeRegularFile(path.join(finalDirectory, entry.name));
    }
    if (await regularFileOrNull(destination)) throw new Error('An MP4 export already exists.');
    const expected = { byteLength: session.output.byteLength, sha256: session.output.sha256 };
    const sourceBefore = await inspectAndHash(source);
    if (sourceBefore.byteLength !== expected.byteLength || sourceBefore.sha256 !== expected.sha256) {
      throw new Error('Finalized recording integrity validation failed.');
    }
    const maximumOutputBytes = Math.min(Number.MAX_SAFE_INTEGER, expected.byteLength * 4 + EXPORT_OVERHEAD_BYTES);
    try {
      await ffmpeg.transcodeWebmToMp4(source, temporary, maximumOutputBytes);
      const output = await inspectAndHash(temporary);
      if (output.byteLength <= 0 || output.byteLength >= maximumOutputBytes) throw new Error('Export output size is invalid.');
      const sourceAfter = await inspectAndHash(source);
      if (sourceAfter.byteLength !== expected.byteLength || sourceAfter.sha256 !== expected.sha256) {
        throw new Error('Finalized recording changed during export.');
      }
      await flushFile(temporary);
      if (await regularFileOrNull(destination)) throw new Error('An MP4 export already exists.');
      await rename(temporary, destination);
      await syncDirectory(finalDirectory);
      return {
        fileName: OUTPUT_NAME,
        mimeType: 'video/mp4',
        byteLength: output.byteLength,
        sha256: output.sha256,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      await removeRegularFile(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function work(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const jobId = queue.shift();
        if (!jobId) break;
        const job = jobs.get(jobId);
        if (!job || job.status !== 'queued') continue;
        job.status = 'running';
        job.updatedAt = new Date().toISOString();
        try {
          job.output = await exportRecording(job);
          job.status = 'completed';
        } catch {
          job.status = 'failed';
          job.error = 'The MP4 export could not be completed safely.';
        }
        job.updatedAt = new Date().toISOString();
      }
    } finally {
      running = false;
      resolveIdle();
    }
  }

  function schedule(): void {
    if (scheduled || running) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void work();
    });
  }

  return {
    enqueue(sessionId) {
      if (!accepting) throw new Error('The export worker is closing.');
      const parsedId = sessionIdSchema.parse(sessionId);
      const existingId = sessionJobs.get(parsedId);
      const existing = existingId ? jobs.get(existingId) : undefined;
      if (existing) return snapshot(existing);
      if (jobs.size >= MAX_RETAINED_JOBS) throw new Error('The export job limit has been reached.');
      const now = new Date().toISOString();
      const job: ExportJob = {
        id: randomUUID(),
        sessionId: parsedId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        output: null,
        error: null,
      };
      jobs.set(job.id, job);
      sessionJobs.set(parsedId, job.id);
      queue.push(job.id);
      schedule();
      return snapshot(job);
    },
    getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? snapshot(job) : null;
    },
    whenIdle() {
      if (!running && queue.length === 0 && !scheduled) return Promise.resolve();
      return new Promise<void>(resolve => idleWaiters.add(resolve));
    },
    async close() {
      accepting = false;
      await this.whenIdle();
    },
  };
}
