import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFFmpegAdapter, type FFmpegAdapter, type FFmpegProcessRunner } from '../apps/server/src/media/ffmpeg.js';
import { createExportService } from '../apps/server/src/services/exports.js';
import { openMetadata, type MetadataStore } from '../apps/server/src/storage/database.js';
import { startServer } from '../apps/server/src/server.js';
import { exportJobSchema, responseSchema } from '../packages/shared/src/index.js';

const configuration = {
  layout: 'screen' as const,
  resolution: '720p' as const,
  fps: 30 as const,
  videoBitsPerSecond: 1_000_000,
  audioBitsPerSecond: 96_000,
  audioMode: 'combined' as const,
};

async function fixture(run: (root: string, data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-export-'));
  let failure: unknown;
  try { await run(root, path.join(root, 'data')); }
  catch (error) { failure = error; }
  try { await rm(root, { recursive: true, force: true }); }
  catch (error) { if (!failure) throw error; }
  if (failure) throw failure;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the export worker.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function completedSession(data: string, bytes: Uint8Array): Promise<{ store: MetadataStore; id: string; source: string }> {
  const store = await openMetadata(data);
  const id = randomUUID();
  const createdAt = '2026-11-16T10:00:00.000Z';
  store.insertSession({
    schemaVersion: 1,
    id,
    title: 'Export fixture',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    configuration,
    chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 },
    output: null,
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  store.commitChunk({
    schemaVersion: 1,
    sessionId: id,
    sequence: 0,
    byteLength: bytes.byteLength,
    sha256,
    timestamp: '2026-11-16T10:00:01.000Z',
    mimeType: 'video/webm',
    committedAt: '2026-11-16T10:00:02.000Z',
  });
  store.beginFinalization(id, 1, '2026-11-16T10:00:03.000Z');
  const finalized = {
    schemaVersion: 1,
    sessionId: id,
    expectedChunkCount: 1,
    byteLength: bytes.byteLength,
    sha256,
    mimeType: 'video/webm',
    finalizedAt: '2026-11-16T10:00:04.000Z',
    probe: {
      formatName: 'matroska,webm',
      durationMs: 1000,
      video: { codec: 'vp9', width: 320, height: 180 },
      audio: { codec: 'opus' },
    },
  } as const;
  store.completeFinalization(finalized);
  const final = path.join(data, 'sessions', id, 'final');
  await mkdir(final, { recursive: true });
  const source = path.join(final, 'recording.webm');
  await writeFile(source, bytes);
  await writeFile(path.join(final, 'recording.commit.json'), JSON.stringify(finalized));
  return { store, id, source };
}

test('FFmpeg adapter uses a fixed non-shell argument vector and rejects unsafe configuration', async () => {
  let invocation: { executable: string; args: readonly string[]; timeoutMs: number } | undefined;
  let reportedProgress = 0;
  const runner: FFmpegProcessRunner = async (executable, args, timeoutMs, _signal, onTime) => {
    invocation = { executable, args, timeoutMs };
    onTime?.(500);
    return { exitCode: 0, stderr: '' };
  };
  const executable = path.resolve('trusted-ffmpeg.exe');
  const adapter = createFFmpegAdapter(executable, runner);
  const input = path.resolve('recording with spaces.webm');
  const output = path.resolve('recording.mp4');
  await adapter.transcodeWebmToMp4(input, output, 100_000_000, { durationMs: 1000, onProgress: value => { reportedProgress = value; } });
  assert.equal(invocation?.executable, executable);
  assert.deepEqual(invocation?.args.slice(0, 7), ['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:2']);
  assert.deepEqual(invocation?.args.slice(invocation.args.indexOf('-i'), invocation.args.indexOf('-i') + 2), ['-i', input]);
  assert.ok(invocation?.args.includes('libx264'));
  assert.ok(invocation?.args.includes('aac'));
  assert.deepEqual(invocation?.args.slice(invocation.args.indexOf('-threads'), invocation.args.indexOf('-threads') + 2), ['-threads', '4']);
  assert.deepEqual(invocation?.args.slice(invocation.args.indexOf('-fs'), invocation.args.indexOf('-fs') + 2), ['-fs', '100000000']);
  assert.equal(invocation?.args.at(-1), output);
  assert.equal(invocation?.timeoutMs, 3 * 60 * 60 * 1000);
  assert.equal(reportedProgress, 50);
  assert.throws(() => createFFmpegAdapter('relative/ffmpeg'));
  await assert.rejects(adapter.transcodeWebmToMp4(input, input, 100_000_000));
  await assert.rejects(adapter.transcodeWebmToMp4(input, output, 0));
  const failed = createFFmpegAdapter(executable, async () => ({ exitCode: 1, stderr: 'private path' }));
  await assert.rejects(failed.transcodeWebmToMp4(input, output, 100_000_000), /could not export/);
});

test('export worker publishes one MP4 atomically and preserves the immutable WebM source', () => fixture(async (_root, data) => {
  const sourceBytes = Buffer.from('synthetic finalized webm');
  const prepared = await completedSession(data, sourceBytes);
  const converted = Buffer.from('synthetic mp4 bytes');
  let inputPath = '';
  let outputPath = '';
  const ffmpeg: FFmpegAdapter = {
    transcodeWebmToMp4: async (input, output) => {
      inputPath = input;
      outputPath = output;
      await writeFile(output, converted);
    },
  };
  const service = createExportService(prepared.store, data, ffmpeg);
  const queued = service.enqueue(prepared.id);
  assert.equal(queued.status, 'queued');
  assert.equal(service.enqueue(prepared.id).id, queued.id);
  await service.whenIdle();
  const completed = service.getJob(queued.id);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.output?.byteLength, converted.length);
  assert.equal(completed?.output?.sha256, createHash('sha256').update(converted).digest('hex'));
  assert.equal(inputPath, prepared.source);
  assert.match(path.basename(outputPath), /^\.export-[0-9a-f-]+\.tmp\.mp4$/);
  assert.deepEqual(await readFile(prepared.source), sourceBytes);
  assert.deepEqual(await readFile(path.join(path.dirname(prepared.source), 'recording.mp4')), converted);
  assert.deepEqual((await readdir(path.dirname(prepared.source))).filter(name => name.startsWith('.export-')), []);
  await service.close();
  assert.throws(() => service.enqueue(prepared.id), /closing/);
  prepared.store.close();
}));

test('export failures remove temporary output, report failure, and retain the source', () => fixture(async (_root, data) => {
  const sourceBytes = Buffer.from('preserve me');
  const prepared = await completedSession(data, sourceBytes);
  const ffmpeg: FFmpegAdapter = {
    transcodeWebmToMp4: async (_input, output) => {
      await writeFile(output, Buffer.from('partial'));
      throw new Error('synthetic converter failure with private details');
    },
  };
  const service = createExportService(prepared.store, data, ffmpeg);
  const job = service.enqueue(prepared.id);
  await service.whenIdle();
  assert.deepEqual(service.getJob(job.id), {
    ...job,
    status: 'failed',
    progress: 1,
    updatedAt: service.getJob(job.id)?.updatedAt,
    error: 'The MP4 export could not be completed safely.',
  });
  assert.deepEqual(await readFile(prepared.source), sourceBytes);
  assert.equal(existsSync(path.join(path.dirname(prepared.source), 'recording.mp4')), false);
  assert.deepEqual((await readdir(path.dirname(prepared.source))).filter(name => name.startsWith('.export-')), []);
  await service.close();
  prepared.store.close();
}));

test('export worker runs at most one conversion at a time', () => fixture(async (_root, data) => {
  const first = await completedSession(data, Buffer.from('first source'));
  // completedSession opens the same database independently, so close it before
  // preparing the second fixture and use the final shared store for the worker.
  first.store.close();
  const second = await completedSession(data, Buffer.from('second source'));
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const ffmpeg: FFmpegAdapter = {
    transcodeWebmToMp4: async (_input, output) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      await writeFile(output, Buffer.from('mp4'));
      active -= 1;
    },
  };
  const service = createExportService(second.store, data, ffmpeg);
  const firstJob = service.enqueue(first.id);
  const secondJob = service.enqueue(second.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getJob(firstJob.id)?.status, 'running');
  assert.equal(service.getJob(secondJob.id)?.status, 'queued');
  await waitFor(() => releases.length === 1);
  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  assert.equal(service.getJob(secondJob.id)?.status, 'running');
  releases.shift()?.();
  await service.whenIdle();
  assert.equal(maximumActive, 1);
  assert.equal(service.getJob(firstJob.id)?.status, 'completed');
  assert.equal(service.getJob(secondJob.id)?.status, 'completed');
  await service.close();
  second.store.close();
}));

test('running export can be cancelled, cleans partial output, and retries with the same durable job identity', () => fixture(async (_root, data) => {
  const prepared = await completedSession(data, Buffer.from('cancel source'));
  let failUntilCancelled = true;
  const ffmpeg: FFmpegAdapter = {
    transcodeWebmToMp4: async (_input, output, _limit, options) => {
      if (!failUntilCancelled) { await writeFile(output, Buffer.from('retry mp4')); return; }
      await writeFile(output, Buffer.from('partial mp4'));
      if (options?.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    },
  };
  const service = createExportService(prepared.store, data, ffmpeg);
  const job = service.enqueue(prepared.id);
  await waitFor(() => service.getJob(job.id)?.status === 'running');
  assert.equal(service.cancel(job.id).status, 'cancelled');
  failUntilCancelled = false;
  const retried = await service.retry(job.id);
  assert.equal(retried.id, job.id);
  assert.equal(retried.attempts, 2);
  await service.whenIdle();
  assert.equal(service.getJob(job.id)?.status, 'completed');
  assert.deepEqual(await readFile(prepared.source), Buffer.from('cancel source'));
  await service.close();
  prepared.store.close();
}));

test('restart reconciliation removes stale export artifacts and resumes an interrupted durable job', () => fixture(async (_root, data) => {
  const prepared = await completedSession(data, Buffer.from('restart source'));
  const timestamp = '2026-11-16T12:00:00.000Z';
  const id = randomUUID();
  prepared.store.insertExportJob({
    schemaVersion: 1, id, sessionId: prepared.id, status: 'running', progress: 47, attempts: 1,
    createdAt: timestamp, updatedAt: timestamp, output: null, error: null,
  });
  const final = path.dirname(prepared.source);
  await writeFile(path.join(final, `.export-${randomUUID()}.tmp.mp4`), 'stale');
  await writeFile(path.join(final, 'recording.mp4'), 'orphan');
  prepared.store.close();
  const store = await openMetadata(data);
  const service = createExportService(store, data, {
    transcodeWebmToMp4: async (_input, output, _limit, options) => {
      options?.onProgress?.(65);
      await writeFile(output, Buffer.from('resumed mp4'));
    },
  });
  await service.reconcile();
  await service.whenIdle();
  const completed = service.getJob(id);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.attempts, 2);
  assert.equal(completed?.progress, 100);
  assert.deepEqual((await readdir(final)).filter(name => name.startsWith('.export-')), []);
  assert.deepEqual(await readFile(prepared.source), Buffer.from('restart source'));
  await service.close();
  store.close();
}));

test('authenticated export API queues, reports and downloads only verified completed MP4 output', () => fixture(async (_root, data) => {
  const prepared = await completedSession(data, Buffer.from('api source'));
  const sessionId = prepared.id;
  prepared.store.close();
  const running = await startServer({
    port: 0,
    dataDirectory: data,
    ffmpeg: { transcodeWebmToMp4: async (_input, output, _limit, options) => {
      options?.onProgress?.(55);
      await writeFile(output, Buffer.from('api mp4'));
    } },
  });
  try {
    const bootstrap = await fetch(`${running.origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
    const writeToken = (await bootstrap.json() as { data: { writeToken: string } }).data.writeToken;
    const writeHeaders = { Origin: running.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': writeToken, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${running.origin}/api/v1/sessions/${sessionId}/exports`, { method: 'POST', headers: { ...writeHeaders, 'X-Recorder-Token': '' }, body: '{}' })).status, 401);
    const queuedResponse = await fetch(`${running.origin}/api/v1/sessions/${sessionId}/exports`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(queuedResponse.status, 202);
    const queued = responseSchema(exportJobSchema).parse(await queuedResponse.json());
    assert.ok(queued.ok);
    await running.exportService.whenIdle();
    assert.equal((await fetch(`${running.origin}/api/v1/exports/${queued.data.id}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
    const readHeaders = { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': writeToken };
    const statusResponse = await fetch(`${running.origin}/api/v1/exports/${queued.data.id}`, { headers: readHeaders });
    const status = responseSchema(exportJobSchema).parse(await statusResponse.json());
    assert.ok(status.ok);
    assert.equal(status.data.status, 'completed');
    assert.equal(status.data.progress, 100);
    const repeated = await fetch(`${running.origin}/api/v1/sessions/${sessionId}/exports`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal((await repeated.json() as { data: { id: string } }).data.id, queued.data.id);
    const download = await fetch(`${running.origin}/api/v1/exports/${queued.data.id}/file`, { headers: readHeaders });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from('api mp4'));
  } finally { await running.close(); }
}));

const ffmpegExecutable = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeExecutable = process.env.FFPROBE_PATH || 'ffprobe';
const realToolsAvailable = spawnSync(ffmpegExecutable, ['-version'], { windowsHide: true }).status === 0 &&
  spawnSync(ffprobeExecutable, ['-version'], { windowsHide: true }).status === 0;

test('real FFmpeg export produces probed H.264/AAC MP4 and leaves WebM unchanged', {
  skip: realToolsAvailable ? false : 'Trusted FFmpeg and FFprobe are unavailable; real export acceptance was not executed.',
}, () => fixture(async (root, data) => {
  const generated = path.join(root, 'generated.webm');
  const generation = spawnSync(ffmpegExecutable, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'webm', generated,
  ], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generation.status, 0, generation.stderr);
  const webm = await readFile(generated);
  const originalHash = createHash('sha256').update(webm).digest('hex');
  const prepared = await completedSession(data, webm);
  const service = createExportService(prepared.store, data, createFFmpegAdapter(ffmpegExecutable));
  const job = service.enqueue(prepared.id);
  await service.whenIdle();
  assert.equal(service.getJob(job.id)?.status, 'completed');
  const mp4 = path.join(path.dirname(prepared.source), 'recording.mp4');
  const probe = spawnSync(ffprobeExecutable, [
    '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height', '-of', 'json', mp4,
  ], { windowsHide: true, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const parsed = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string }>; format: { format_name: string; duration: string } };
  assert.equal(parsed.streams.find(stream => stream.codec_type === 'video')?.codec_name, 'h264');
  assert.equal(parsed.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.match(parsed.format.format_name, /mp4/);
  assert.ok(Number(parsed.format.duration) > 0.8 && Number(parsed.format.duration) < 1.3);
  assert.equal(createHash('sha256').update(await readFile(prepared.source)).digest('hex'), originalHash);
  await service.close();
  prepared.store.close();
}));
