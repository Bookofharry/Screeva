import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createFFprobeAdapter } from '../apps/server/src/media/ffprobe.js';

test('FFprobe adapter uses fixed argv, parses WebM streams, and never builds a shell command', async () => {
  const file = path.resolve('synthetic final.webm');
  let observed: { executable: string; args: readonly string[]; timeout: number } | undefined;
  const adapter = createFFprobeAdapter('ffprobe', async (executable, args, timeout) => {
    observed = { executable, args, timeout };
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        format: { format_name: 'matroska,webm', duration: '1.234' },
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720 },
          { codec_type: 'audio', codec_name: 'opus' },
        ],
      }),
    };
  });
  assert.deepEqual(await adapter.probe(file), {
    formatName: 'matroska,webm', durationMs: 1234,
    video: { codec: 'vp9', width: 1280, height: 720 }, audio: { codec: 'opus' },
  });
  assert.equal(observed?.executable, 'ffprobe');
  assert.equal(observed?.args.at(-1), file);
  assert.equal(observed?.timeout, 20_000);
  assert.equal(observed?.args.includes(';'), false);
});

test('FFprobe adapter rejects failed probes, invalid media and untrusted relative executable configuration', async () => {
  assert.throws(() => createFFprobeAdapter('relative/tools/ffprobe'), /absolute path/);
  await assert.rejects(createFFprobeAdapter('ffprobe', async () => ({ exitCode: 1, stdout: '', stderr: 'private path' })).probe(path.resolve('x.webm')), /rejected/);
  await assert.rejects(createFFprobeAdapter('ffprobe', async () => ({
    exitCode: 0, stderr: '', stdout: JSON.stringify({ format: { format_name: 'mp4', duration: '1' }, streams: [] }),
  })).probe(path.resolve('x.webm')), /not WebM/);
});
