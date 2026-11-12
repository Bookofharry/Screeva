import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { finalizedRecordingProbeSchema, type FinalizedRecording } from '../../../../packages/shared/src/index.js';

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const probeJsonSchema = z.object({
  format: z.object({
    format_name: z.string(),
    duration: z.union([z.string(), z.number()]).optional(),
  }),
  streams: z.array(z.object({
    codec_type: z.string(),
    codec_name: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })),
});

export interface FFprobeAdapter {
  probe(file: string): Promise<FinalizedRecording['probe']>;
}

export interface ProbeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ProbeProcessRunner = (executable: string, args: readonly string[], timeoutMs: number) => Promise<ProbeProcessResult>;

export const runProbeProcess: ProbeProcessRunner = (executable, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: ProbeProcessResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else if (result) resolve(result);
  };
  const collect = (destination: Buffer[], value: Buffer) => {
    outputBytes += value.length;
    if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
      child.kill();
      finish(new Error('FFprobe output exceeded its limit.'));
      return;
    }
    destination.push(value);
  };
  child.stdout.on('data', (value: Buffer) => collect(stdout, value));
  child.stderr.on('data', (value: Buffer) => collect(stderr, value));
  child.once('error', error => finish(error));
  child.once('close', exitCode => finish(undefined, {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }));
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('FFprobe timed out.'));
  }, timeoutMs);
  timer.unref();
});

export function createFFprobeAdapter(
  configuredExecutable = process.env.FFPROBE_PATH?.trim() || 'ffprobe',
  runner: ProbeProcessRunner = runProbeProcess,
): FFprobeAdapter {
  if (configuredExecutable !== 'ffprobe' && !path.isAbsolute(configuredExecutable)) {
    throw new Error('FFPROBE_PATH must be an absolute path.');
  }
  if (configuredExecutable.includes('\0')) throw new Error('Invalid FFprobe executable path.');
  return {
    async probe(file) {
      const absoluteFile = path.resolve(file);
      const result = await runner(configuredExecutable, [
        '-v', 'error',
        '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height',
        '-of', 'json',
        absoluteFile,
      ], 20_000);
      if (result.exitCode !== 0) throw new Error('FFprobe rejected the finalized media.');
      let decoded: unknown;
      try { decoded = JSON.parse(result.stdout) as unknown; }
      catch { throw new Error('FFprobe returned invalid JSON.'); }
      const parsed = probeJsonSchema.parse(decoded);
      if (!parsed.format.format_name.toLowerCase().split(',').some(name => name.trim() === 'webm' || name.trim() === 'matroska')) {
        throw new Error('Finalized media is not WebM/Matroska.');
      }
      const video = parsed.streams.find(stream => stream.codec_type === 'video');
      if (!video?.codec_name || !video.width || !video.height) throw new Error('Finalized WebM has no valid video stream.');
      const audio = parsed.streams.find(stream => stream.codec_type === 'audio');
      const seconds = Number(parsed.format.duration);
      return finalizedRecordingProbeSchema.parse({
        formatName: parsed.format.format_name,
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
        video: { codec: video.codec_name, width: video.width, height: video.height },
        audio: audio?.codec_name ? { codec: audio.codec_name } : null,
      });
    },
  };
}
