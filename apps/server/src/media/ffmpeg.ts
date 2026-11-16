import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_FFMPEG_ERROR_BYTES = 1024 * 1024;
const EXPORT_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export interface FFmpegAdapter {
  transcodeWebmToMp4(input: string, output: string, maximumOutputBytes: number): Promise<void>;
}

export interface FFmpegProcessResult {
  exitCode: number | null;
  stderr: string;
}

export type FFmpegProcessRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<FFmpegProcessResult>;

export const runFFmpegProcess: FFmpegProcessRunner = (executable, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: Buffer[] = [];
  let errorBytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: FFmpegProcessResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else if (result) resolve(result);
  };
  child.stderr.on('data', (value: Buffer) => {
    errorBytes += value.length;
    if (errorBytes > MAX_FFMPEG_ERROR_BYTES) {
      child.kill();
      finish(new Error('FFmpeg diagnostic output exceeded its limit.'));
      return;
    }
    stderr.push(value);
  });
  child.once('error', error => finish(error));
  child.once('close', exitCode => finish(undefined, {
    exitCode,
    stderr: Buffer.concat(stderr).toString('utf8'),
  }));
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('FFmpeg export timed out.'));
  }, timeoutMs);
  timer.unref();
});

export function createFFmpegAdapter(
  configuredExecutable = process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  runner: FFmpegProcessRunner = runFFmpegProcess,
): FFmpegAdapter {
  if (configuredExecutable !== 'ffmpeg' && !path.isAbsolute(configuredExecutable)) {
    throw new Error('FFMPEG_PATH must be an absolute path.');
  }
  if (configuredExecutable.includes('\0')) throw new Error('Invalid FFmpeg executable path.');
  return {
    async transcodeWebmToMp4(input, output, maximumOutputBytes) {
      const absoluteInput = path.resolve(input);
      const absoluteOutput = path.resolve(output);
      if (absoluteInput === absoluteOutput) throw new Error('FFmpeg input and output must differ.');
      if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) throw new Error('Invalid FFmpeg output limit.');
      const result = await runner(configuredExecutable, [
        '-nostdin',
        '-hide_banner',
        '-loglevel', 'error',
        '-n',
        '-i', absoluteInput,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        '-sn',
        '-dn',
        '-c:v', 'libx264',
        '-threads', '4',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-fs', String(maximumOutputBytes),
        '-movflags', '+faststart',
        '-f', 'mp4',
        absoluteOutput,
      ], EXPORT_TIMEOUT_MS);
      if (result.exitCode !== 0) throw new Error('FFmpeg could not export the recording.');
    },
  };
}
