import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { exportJobIdSchema, exportJobSchema, sessionIdSchema, type ErrorCode, type ExportJob } from '../../../../packages/shared/src/index.js';
import type { FFmpegAdapter } from '../media/ffmpeg.js';
import type { MetadataStore } from '../storage/database.js';
import { assertDirectoryChain, sessionDirectory } from '../storage/paths.js';

const SOURCE_NAME = 'recording.webm';
const OUTPUT_NAME = 'recording.mp4';
const EXPORT_OVERHEAD_BYTES = 64 * 1024 * 1024;
type ExportJobOutput = NonNullable<ExportJob['output']>;

export class ExportError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, readonly publicMessage: string) { super(publicMessage); }
}

export interface ExportOutputFile { path: string; byteLength: number; fileName: typeof OUTPUT_NAME }
export interface ExportService {
  reconcile(): Promise<void>;
  enqueue(sessionId: string): ExportJob;
  getJob(jobId: string): ExportJob | null;
  retry(jobId: string): Promise<ExportJob>;
  cancel(jobId: string): ExportJob;
  getOutput(jobId: string): Promise<ExportOutputFile>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
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

async function removeRegularFile(file: string): Promise<void> { if (await regularFileOrNull(file)) await rm(file); }

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  catch (error) {
    if (!(process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  } finally { await handle.close(); }
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
  } finally { await handle.close(); }
  return { byteLength, sha256: hash.digest('hex') };
}

async function flushFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

const now = () => new Date().toISOString();

export function createExportService(store: MetadataStore, dataDirectory: string, ffmpeg: FFmpegAdapter): ExportService {
  const queue: string[] = [];
  const queued = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const idleWaiters = new Set<() => void>();
  let running = false;
  let scheduled = false;
  let accepting = true;

  async function locations(sessionId: string) {
    const sessionPath = await sessionDirectory(dataDirectory, sessionId);
    await assertDirectoryChain(sessionPath);
    const final = path.join(sessionPath, 'final');
    await assertDirectoryChain(final);
    return { final, source: path.join(final, SOURCE_NAME), destination: path.join(final, OUTPUT_NAME) };
  }

  async function cleanupTemporaries(final: string): Promise<void> {
    for (const entry of await readdir(final, { withFileTypes: true })) {
      if (/^\.export-[0-9a-f-]+\.tmp\.mp4$/.test(entry.name)) await removeRegularFile(path.join(final, entry.name));
    }
  }

  function update(job: ExportJob): ExportJob {
    const parsed = exportJobSchema.parse(job);
    store.updateExportJob(parsed);
    return parsed;
  }

  function queueJob(id: string): void {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
    schedule();
  }

  function resolveIdle(): void {
    if (running || queue.length > 0 || scheduled) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  async function exportRecording(job: ExportJob, controller: AbortController): Promise<ExportJobOutput> {
    const session = store.findSession(job.sessionId);
    if (!session || session.status !== 'completed' || !session.output) throw new Error('Only completed recordings can be exported.');
    const place = await locations(job.sessionId);
    await cleanupTemporaries(place.final);
    if (await regularFileOrNull(place.destination)) throw new Error('An MP4 export already exists.');
    const expected = { byteLength: session.output.byteLength, sha256: session.output.sha256 };
    const sourceBefore = await inspectAndHash(place.source);
    if (sourceBefore.byteLength !== expected.byteLength || sourceBefore.sha256 !== expected.sha256) throw new Error('Finalized recording integrity validation failed.');
    const maximumOutputBytes = Math.min(Number.MAX_SAFE_INTEGER, expected.byteLength * 4 + EXPORT_OVERHEAD_BYTES);
    const temporary = path.join(place.final, `.export-${randomUUID()}.tmp.mp4`);
    try {
      await ffmpeg.transcodeWebmToMp4(place.source, temporary, maximumOutputBytes, {
        ...(session.output.probe.durationMs === null ? {} : { durationMs: session.output.probe.durationMs }),
        signal: controller.signal,
        onProgress: progress => {
          const current = store.findExportJob(job.id);
          if (!current || current.status !== 'running' || progress <= current.progress) return;
          update({ ...current, progress, updatedAt: now() });
        },
      });
      controller.signal.throwIfAborted();
      const output = await inspectAndHash(temporary);
      if (output.byteLength <= 0 || output.byteLength >= maximumOutputBytes) throw new Error('Export output size is invalid.');
      const sourceAfter = await inspectAndHash(place.source);
      if (sourceAfter.byteLength !== expected.byteLength || sourceAfter.sha256 !== expected.sha256) throw new Error('Finalized recording changed during export.');
      controller.signal.throwIfAborted();
      await flushFile(temporary);
      if (await regularFileOrNull(place.destination)) throw new Error('An MP4 export already exists.');
      await rename(temporary, place.destination);
      await syncDirectory(place.final);
      return { fileName: OUTPUT_NAME, mimeType: 'video/mp4' as const, byteLength: output.byteLength, sha256: output.sha256, completedAt: now() };
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
        queued.delete(jobId);
        const job = store.findExportJob(jobId);
        if (!job || job.status !== 'queued') continue;
        const controller = new AbortController();
        controllers.set(jobId, controller);
        update({ ...job, status: 'running', progress: Math.max(1, job.progress), updatedAt: now(), error: null });
        try {
          const output = await exportRecording(job, controller);
          const current = store.findExportJob(jobId);
          if (!current || current.status !== 'running' || current.attempts !== job.attempts) {
            const place = await locations(job.sessionId);
            await removeRegularFile(place.destination).catch(() => undefined);
          } else {
            update({ ...current, status: 'completed', progress: 100, output, error: null, updatedAt: output.completedAt });
          }
        } catch (error) {
          const current = store.findExportJob(jobId);
          if (current && current.status !== 'cancelled' && current.attempts === job.attempts) {
            update({ ...current, status: 'failed', error: 'The MP4 export could not be completed safely.', updatedAt: now() });
          }
          if (error instanceof Error && error.name === 'AbortError') {
            const place = await locations(job.sessionId).catch(() => null);
            if (place) await removeRegularFile(place.destination).catch(() => undefined);
          }
        } finally { controllers.delete(jobId); }
      }
    } finally {
      running = false;
      resolveIdle();
    }
  }

  function schedule(): void {
    if (scheduled || running) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void work(); });
  }

  return {
    async reconcile() {
      for (const job of store.listExportJobs()) {
        const place = await locations(job.sessionId);
        await cleanupTemporaries(place.final);
        if (job.status === 'completed' && job.output) {
          try {
            const output = await inspectAndHash(place.destination);
            if (output.byteLength !== job.output.byteLength || output.sha256 !== job.output.sha256) throw new Error('Export metadata mismatch.');
          } catch {
            update({ ...job, status: 'failed', progress: 0, output: null, error: 'The saved MP4 failed integrity validation.', updatedAt: now() });
          }
          continue;
        }
        await removeRegularFile(place.destination).catch(() => undefined);
        if (job.status === 'queued' || job.status === 'running') {
          const resumed = update({ ...job, status: 'queued', progress: 0, attempts: Math.min(100, job.attempts + (job.status === 'running' ? 1 : 0)), error: null, updatedAt: now() });
          queueJob(resumed.id);
        }
      }
    },
    enqueue(sessionId) {
      if (!accepting) throw new ExportError(503, 'INTERNAL_ERROR', 'The export worker is closing.');
      const parsedId = sessionIdSchema.parse(sessionId);
      const session = store.findSession(parsedId);
      if (!session) throw new ExportError(404, 'NOT_FOUND', 'Session not found.');
      if (session.status !== 'completed' || !session.output) throw new ExportError(409, 'CONFLICT', 'Only completed recordings can be exported.');
      const existing = store.findExportJobBySession(parsedId);
      if (existing) return existing;
      const timestamp = now();
      const job = exportJobSchema.parse({ schemaVersion: 1, id: randomUUID(), sessionId: parsedId, status: 'queued', progress: 0, attempts: 1, createdAt: timestamp, updatedAt: timestamp, output: null, error: null });
      store.insertExportJob(job);
      queueJob(job.id);
      return job;
    },
    getJob(jobId) {
      const parsed = exportJobIdSchema.safeParse(jobId);
      return parsed.success ? store.findExportJob(parsed.data) : null;
    },
    async retry(jobId) {
      const parsedId = exportJobIdSchema.parse(jobId);
      const job = store.findExportJob(parsedId);
      if (!job) throw new ExportError(404, 'NOT_FOUND', 'Export job not found.');
      if (job.status !== 'failed' && job.status !== 'cancelled') throw new ExportError(409, 'CONFLICT', 'Only failed or cancelled exports can be retried.');
      if (job.attempts >= 100) throw new ExportError(409, 'CONFLICT', 'The export retry limit has been reached.');
      const place = await locations(job.sessionId);
      await cleanupTemporaries(place.final);
      await removeRegularFile(place.destination).catch(() => undefined);
      const retried = update({ ...job, status: 'queued', progress: 0, attempts: job.attempts + 1, output: null, error: null, updatedAt: now() });
      queueJob(retried.id);
      return retried;
    },
    cancel(jobId) {
      const parsedId = exportJobIdSchema.parse(jobId);
      const job = store.findExportJob(parsedId);
      if (!job) throw new ExportError(404, 'NOT_FOUND', 'Export job not found.');
      if (job.status === 'cancelled') return job;
      if (job.status === 'completed' || job.status === 'failed') throw new ExportError(409, 'CONFLICT', 'This export is no longer cancellable.');
      const cancelled = update({ ...job, status: 'cancelled', error: 'Export cancelled.', updatedAt: now() });
      controllers.get(job.id)?.abort();
      return cancelled;
    },
    async getOutput(jobId) {
      const parsedId = exportJobIdSchema.parse(jobId);
      const job = store.findExportJob(parsedId);
      if (!job) throw new ExportError(404, 'NOT_FOUND', 'Export job not found.');
      if (job.status !== 'completed' || !job.output) throw new ExportError(409, 'CONFLICT', 'The MP4 export is not complete.');
      const place = await locations(job.sessionId);
      const output = await inspectAndHash(place.destination).catch(() => null);
      if (!output || output.byteLength !== job.output.byteLength || output.sha256 !== job.output.sha256) throw new ExportError(500, 'INTERNAL_ERROR', 'The saved MP4 failed integrity validation.');
      return { path: place.destination, byteLength: output.byteLength, fileName: OUTPUT_NAME };
    },
    whenIdle() {
      if (!running && queue.length === 0 && !scheduled) return Promise.resolve();
      return new Promise<void>(resolve => idleWaiters.add(resolve));
    },
    async close() { accepting = false; await this.whenIdle(); },
  };
}
