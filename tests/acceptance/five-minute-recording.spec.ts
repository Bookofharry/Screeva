import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const execFileAsync = promisify(execFile);
const TARGET_SECONDS = 300;
const SAMPLE_RATE = 48_000;
const MEMORY_LIMIT = 128 * 1024 * 1024;
const MARKERS = [
  { name: 'beginning', at: 5, duration: 1.5, color: [237, 28, 36], microphoneHz: 440, displayHz: 880 },
  { name: 'middle', at: 150, duration: 1.5, color: [0, 200, 83], microphoneHz: 554, displayHz: 1108 },
  { name: 'end', at: 295, duration: 1.5, color: [41, 121, 255], microphoneHz: 659, displayHz: 1318 },
] as const;

interface MemorySample { elapsedSeconds: number; retainedBytes: number; usedJsHeapBytes: number | null }
interface MarkerMeasurement {
  name: string;
  expectedSeconds: number;
  videoSeconds: number;
  audioSeconds: number;
  alignmentMs: number;
  microphoneAmplitude: number;
  displayAmplitude: number;
}
interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  start_time?: string;
  duration?: string;
  avg_frame_rate?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}
interface ProbeDocument {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
}

declare global {
  interface Window {
    fiveMinuteTest: {
      canvasOutputs: MediaStream[];
      audioOutputs: MediaStream[];
      sources: MediaStream[];
      blobs: Array<{ type: string; size: number }>;
      sourceStates(): MediaStreamTrackState[];
      outputStates(): MediaStreamTrackState[];
    };
  }
}

async function runTool(binary: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, { encoding: 'utf8', maxBuffer, windowsHide: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Media validation command failed: ${binary} ${args.join(' ')}\n${detail}`, { cause: error });
  }
}

async function resolveMediaTools(): Promise<{ ffmpeg: string; ffprobe: string; ffmpegVersion: string; ffprobeVersion: string }> {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const [encoder, probe] = await Promise.all([runTool(ffmpeg, ['-version']), runTool(ffprobe, ['-version'])]);
    return {
      ffmpeg,
      ffprobe,
      ffmpegVersion: encoder.stdout.split(/\r?\n/, 1)[0] ?? 'unknown',
      ffprobeVersion: probe.stdout.split(/\r?\n/, 1)[0] ?? 'unknown',
    };
  } catch {
    throw new Error('Five-minute media validation requires FFmpeg and FFprobe. Put both on PATH or set FFMPEG_PATH and FFPROBE_PATH to trusted binaries.');
  }
}

async function installSyntheticSources(page: Page): Promise<void> {
  await page.addInitScript(({ markers }) => {
    const canvasOutputs: MediaStream[] = [];
    const audioOutputs: MediaStream[] = [];
    const sources: MediaStream[] = [];
    const blobs: Array<{ type: string; size: number }> = [];
    const contexts: AudioContext[] = [];
    const timers: number[] = [];
    const toneControls: Array<{ context: AudioContext; oscillator: OscillatorNode; gain: GainNode; route: 'microphone' | 'display' }> = [];
    let recordingStartedAt: number | null = null;

    const nativeCanvasCapture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (frameRate?: number) {
      const stream = nativeCanvasCapture.call(this, frameRate);
      canvasOutputs.push(stream);
      return stream;
    };
    const nativeDestination = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function () {
      const destination = nativeDestination.call(this);
      audioOutputs.push(destination.stream);
      return destination;
    };
    const nativeObjectUrl = URL.createObjectURL;
    URL.createObjectURL = blob => {
      if (blob instanceof Blob) blobs.push({ type: blob.type, size: blob.size });
      return nativeObjectUrl(blob);
    };
    const nativeRecorderStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (timeslice?: number) {
      recordingStartedAt = performance.now();
      for (const control of toneControls) {
        const now = control.context.currentTime;
        control.gain.gain.cancelScheduledValues(now);
        control.oscillator.frequency.cancelScheduledValues(now);
        control.gain.gain.setValueAtTime(0, now);
        markers.forEach(marker => {
          const frequency = control.route === 'microphone' ? marker.microphoneHz : marker.displayHz;
          control.oscillator.frequency.setValueAtTime(frequency, now + marker.at);
          control.gain.gain.setValueAtTime(0.22, now + marker.at);
          control.gain.gain.setValueAtTime(0, now + marker.at + marker.duration);
        });
      }
      nativeRecorderStart.call(this, timeslice);
    };

    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'fixture-camera', groupId: 'fixture', kind: 'videoinput', label: 'Synthetic advancing camera', toJSON: () => ({}) },
      { deviceId: 'fixture-microphone', groupId: 'fixture', kind: 'audioinput', label: 'Synthetic marker microphone', toJSON: () => ({}) },
    ];

    function toneStream(route: 'microphone' | 'display'): MediaStream {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = nativeDestination.call(context);
      gain.gain.value = 0;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      contexts.push(context);
      toneControls.push({ context, oscillator, gain, route });
      const track = destination.stream.getAudioTracks()[0]!;
      const nativeStop = track.stop.bind(track);
      track.stop = () => {
        try { oscillator.stop(); } catch { /* already stopped */ }
        nativeStop();
        void context.close();
      };
      return new MediaStream([track]);
    }

    function advancingCanvas(kind: 'screen' | 'camera'): MediaStream {
      const canvas = document.createElement('canvas');
      canvas.width = kind === 'screen' ? 1280 : 640;
      canvas.height = kind === 'screen' ? 720 : 360;
      const drawing = canvas.getContext('2d', { alpha: false })!;
      let frame = 0;
      const paint = () => {
        const elapsed = recordingStartedAt === null ? -1 : (performance.now() - recordingStartedAt) / 1000;
        const marker = markers.find(candidate => elapsed >= candidate.at && elapsed < candidate.at + candidate.duration);
        if (kind === 'screen' && marker) {
          drawing.fillStyle = `rgb(${marker.color.join(',')})`;
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = '#ffffff';
          drawing.font = 'bold 72px sans-serif';
          drawing.fillText(marker.name.toUpperCase(), 420, 390);
        } else {
          drawing.fillStyle = kind === 'screen' ? '#20262c' : '#5d2b7a';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = kind === 'screen' ? '#f2f6f4' : '#ffd54f';
          const block = kind === 'screen' ? 120 : 80;
          drawing.fillRect((frame * (kind === 'screen' ? 11 : 7)) % (canvas.width - block), kind === 'screen' ? 520 : 230, block, block);
          drawing.fillStyle = '#ffffff';
          drawing.font = kind === 'screen' ? '36px sans-serif' : '28px sans-serif';
          drawing.fillText(`${kind} frame ${frame}`, 32, 60);
        }
        frame++;
      };
      paint();
      timers.push(window.setInterval(paint, 33));
      return nativeCanvasCapture.call(canvas, 30);
    }

    function displayStream(): MediaStream {
      const video = advancingCanvas('screen');
      const audio = toneStream('display');
      const stream = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
      sources.push(stream);
      return stream;
    }
    function cameraStream(): MediaStream {
      const stream = advancingCanvas('camera');
      sources.push(stream);
      return stream;
    }
    function microphoneStream(): MediaStream {
      const stream = toneStream('microphone');
      sources.push(stream);
      return stream;
    }

    navigator.mediaDevices.getDisplayMedia = async () => displayStream();
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints?.video) return cameraStream();
      if (constraints?.audio) return microphoneStream();
      throw new DOMException('Synthetic fixture supports only camera or microphone requests.', 'NotSupportedError');
    };
    window.fiveMinuteTest = {
      canvasOutputs,
      audioOutputs,
      sources,
      blobs,
      sourceStates: () => sources.flatMap(stream => stream.getTracks()).map(track => track.readyState),
      outputStates: () => [...canvasOutputs, ...audioOutputs].flatMap(stream => stream.getTracks()).map(track => track.readyState),
    };
    window.addEventListener('unload', () => {
      timers.forEach(timer => window.clearInterval(timer));
      contexts.forEach(context => { void context.close(); });
    });
  }, { markers: MARKERS.map(marker => ({ ...marker, color: [...marker.color] })) });
}

function parseRetainedBytes(text: string): number {
  const match = /Memory used:\s*([\d.]+)\s*(B|KiB|MiB)/.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2];
  return value * (unit === 'MiB' ? 1024 * 1024 : unit === 'KiB' ? 1024 : 1);
}

async function sampleMemory(page: Page, elapsedSeconds: number): Promise<MemorySample> {
  const values = await page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      text: document.querySelector('.recording-panel .setup-help')?.textContent ?? '',
      usedJsHeapBytes: memory?.usedJSHeapSize ?? null,
    };
  });
  return { elapsedSeconds, retainedBytes: parseRetainedBytes(values.text), usedJsHeapBytes: values.usedJsHeapBytes };
}

function parseCsvNumbers(output: string): number[][] {
  return output.trim().split(/\r?\n/).map(line => line.split(',').map(Number)).filter(values => Number.isFinite(values[0]));
}

function goertzelAmplitude(samples: Float32Array, start: number, length: number, frequency: number): number {
  const safeStart = Math.max(0, Math.min(samples.length, start));
  const safeLength = Math.max(0, Math.min(length, samples.length - safeStart));
  if (!safeLength) return 0;
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / SAMPLE_RATE);
  let previous = 0;
  let beforePrevious = 0;
  for (let index = 0; index < safeLength; index++) {
    const current = samples[safeStart + index]! + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  const power = previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious;
  return 2 * Math.sqrt(Math.max(0, power)) / safeLength;
}

function findAudioOnset(samples: Float32Array, expected: number, audioStart: number): number {
  const windowLength = Math.round(SAMPLE_RATE * 0.01);
  const startWindow = Math.max(0, Math.floor((expected - audioStart - 2) * 100));
  const endWindow = Math.min(Math.floor(samples.length / windowLength), Math.ceil((expected - audioStart + 2) * 100));
  for (let windowIndex = startWindow; windowIndex < endWindow; windowIndex++) {
    let sum = 0;
    const offset = windowIndex * windowLength;
    for (let sample = 0; sample < windowLength; sample++) {
      const value = samples[offset + sample] ?? 0;
      sum += value * value;
    }
    if (Math.sqrt(sum / windowLength) > 0.01) return audioStart + windowIndex / 100;
  }
  return Number.NaN;
}

function findVideoMarker(raw: Buffer, color: readonly number[], expected: number, videoStart: number): number {
  const frames = Math.floor(raw.length / 3);
  const from = Math.max(0, Math.floor((expected - videoStart - 2) * 10));
  const to = Math.min(frames, Math.ceil((expected - videoStart + 3) * 10));
  for (let frame = from; frame < to; frame++) {
    const offset = frame * 3;
    const distance = Math.hypot(raw[offset]! - color[0]!, raw[offset + 1]! - color[1]!, raw[offset + 2]! - color[2]!);
    if (distance < 75) return videoStart + frame / 10;
  }
  return Number.NaN;
}

async function analyzeRecording(webmPath: string, testInfo: TestInfo, tools: Awaited<ReturnType<typeof resolveMediaTools>>) {
  const probeResult = await runTool(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', webmPath]);
  const probe = JSON.parse(probeResult.stdout) as ProbeDocument;
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error('FFprobe did not find both video and audio streams.');
  const videoFramesResult = await runTool(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time', '-of', 'csv=p=0', webmPath]);
  const audioPacketsResult = await runTool(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', webmPath]);
  const videoFrames = parseCsvNumbers(videoFramesResult.stdout);
  const audioPackets = parseCsvNumbers(audioPacketsResult.stdout);
  if (videoFrames.length < 2 || audioPackets.length < 2) throw new Error('FFprobe returned insufficient packet/frame timestamps.');

  const videoStart = videoFrames[0]![0]!;
  const videoEnd = videoFrames.at(-1)![0]! + (videoFrames.at(-1)![1] || 0);
  const audioStart = audioPackets[0]![0]!;
  const audioEnd = audioPackets.at(-1)![0]! + (audioPackets.at(-1)![1] || 0);
  const frameDeltas = videoFrames.slice(1).map((frame, index) => frame[0]! - videoFrames[index]![0]!).filter(delta => delta > 0);
  const maxFrameGap = Math.max(...frameDeltas);
  const videoDuration = videoEnd - videoStart;
  const audioDuration = audioEnd - audioStart;
  const timelineDuration = Math.max(videoEnd, audioEnd) - Math.min(videoStart, audioStart);
  const declaredDuration = Number(probe.format?.duration);
  const formatDuration = Number.isFinite(declaredDuration) ? declaredDuration : timelineDuration;
  const fileSize = Number(probe.format?.size);
  const declaredBitRate = Number(probe.format?.bit_rate);

  const rgbPath = testInfo.outputPath('marker-samples.rgb');
  const audioPath = testInfo.outputPath('mixed-audio.f32le');
  await runTool(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', webmPath, '-map', '0:v:0', '-vf', 'crop=240:180:0:0,fps=10,scale=1:1:flags=area,format=rgb24', '-an', '-f', 'rawvideo', rgbPath]);
  await runTool(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', webmPath, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', audioPath]);
  const rgb = await readFile(rgbPath);
  const audioBytes = await readFile(audioPath);
  const alignedAudio = audioBytes.byteOffset % 4 === 0
    ? new Float32Array(audioBytes.buffer, audioBytes.byteOffset, Math.floor(audioBytes.byteLength / 4))
    : new Float32Array(audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength));
  const markers: MarkerMeasurement[] = MARKERS.map(marker => {
    const videoSeconds = findVideoMarker(rgb, marker.color, marker.at, videoStart);
    const audioSeconds = findAudioOnset(alignedAudio, marker.at, audioStart);
    const toneOffset = Math.round((marker.at - audioStart + 0.35) * SAMPLE_RATE);
    const toneLength = Math.round(0.5 * SAMPLE_RATE);
    return {
      name: marker.name,
      expectedSeconds: marker.at,
      videoSeconds,
      audioSeconds,
      alignmentMs: Math.abs(videoSeconds - audioSeconds) * 1000,
      microphoneAmplitude: goertzelAmplitude(alignedAudio, toneOffset, toneLength, marker.microphoneHz),
      displayAmplitude: goertzelAmplitude(alignedAudio, toneOffset, toneLength, marker.displayHz),
    };
  });
  return {
    probe,
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    formatDuration,
    durationSource: Number.isFinite(declaredDuration) ? 'container metadata' : 'decoded packet timeline',
    fileSize,
    bitRate: Number.isFinite(declaredBitRate) ? declaredBitRate : fileSize * 8 / formatDuration,
    decodedFrames: videoFrames.length,
    decodedFps: videoFrames.length / videoDuration,
    maxFrameGapMs: maxFrameGap * 1000,
    videoDuration,
    audioDuration,
    durationDifferenceMs: Math.abs(videoDuration - audioDuration) * 1000,
    markers,
  };
}

async function probeTimelineDuration(ffprobe: string, mediaPath: string): Promise<number> {
  const packets = parseCsvNumbers((await runTool(ffprobe, ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', mediaPath])).stdout);
  if (!packets.length) return Number.NaN;
  const start = Math.min(...packets.map(packet => packet[0]!));
  const end = Math.max(...packets.map(packet => packet[0]! + (packet[1] || 0)));
  return end - start;
}

function markdownReport(report: Record<string, unknown>): string {
  const analysis = report.analysis as Awaited<ReturnType<typeof analyzeRecording>>;
  const memory = report.memorySamples as MemorySample[];
  const pause = report.pauseResume as { wallSeconds: number; mediaSeconds: number };
  const tolerances = report.tolerances as Record<string, string>;
  const violations = report.violations as string[];
  return `# Phase 2 Task 6 — five-minute synchronization report

- Result: **${violations.length ? 'FAIL' : 'PASS'}**
- Generated: ${String(report.generatedAt)}
- Platform: ${String(report.platform)}
- Browser: ${String(report.browser)}
- FFmpeg: ${String(report.ffmpegVersion)}
- FFprobe: ${String(report.ffprobeVersion)}
- Fixture: synthetic screen + webcam at 720p/30, microphone + display audio, RecordingEngine 2.0 Mbps video / 96 kbps audio.

## Measured output

- Container duration: ${analysis.formatDuration.toFixed(3)} s (${analysis.durationSource})
- Video/audio packet durations: ${analysis.videoDuration.toFixed(3)} s / ${analysis.audioDuration.toFixed(3)} s (${analysis.durationDifferenceMs.toFixed(1)} ms difference)
- Codecs: ${analysis.videoCodec} + ${analysis.audioCodec}; ${analysis.width}×${analysis.height}
- Size / effective bitrate: ${(analysis.fileSize / 1024 / 1024).toFixed(2)} MiB / ${(analysis.bitRate / 1_000_000).toFixed(3)} Mbps
- Frames: ${analysis.decodedFrames}; ${analysis.decodedFps.toFixed(3)} decoded fps; ${analysis.maxFrameGapMs.toFixed(1)} ms maximum timestamp gap
- Pause/resume control: ${pause.wallSeconds.toFixed(3)} s wall time produced ${pause.mediaSeconds.toFixed(3)} s media
- Retained-byte samples: ${memory.map(sample => `${sample.elapsedSeconds}s=${(sample.retainedBytes / 1024 / 1024).toFixed(1)} MiB`).join(', ')}
- JS-heap samples: ${memory.map(sample => sample.usedJsHeapBytes === null ? 'unavailable' : `${(sample.usedJsHeapBytes / 1024 / 1024).toFixed(1)} MiB`).join(', ')}

## Marker alignment

| Marker | Expected | Video | Audio | A/V difference | Mic band | Display band |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${analysis.markers.map(marker => `| ${marker.name} | ${marker.expectedSeconds.toFixed(3)} s | ${marker.videoSeconds.toFixed(3)} s | ${marker.audioSeconds.toFixed(3)} s | ${marker.alignmentMs.toFixed(1)} ms | ${marker.microphoneAmplitude.toFixed(4)} | ${marker.displayAmplitude.toFixed(4)} |`).join('\n')}

## Acceptance tolerances

${Object.entries(tolerances).map(([name, value]) => `- ${name}: ${value}`).join('\n')}

## Violations

${violations.length ? violations.map(value => `- ${value}`).join('\n') : '- None.'}

This is synthetic Chromium verification, not physical-device, Edge, OS shared-audio, crash-recovery, persistence, or two-hour soak acceptance. Generated WebM/PCM artifacts remain under ignored test-results and are not source fixtures.
`;
}

test('five-minute composed recording stays synchronized, continuous and within memory bounds', async ({ page, browserName }, testInfo) => {
  test.setTimeout(420_000);
  const tools = await resolveMediaTools();
  await installSyntheticSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  const enableAudio = page.getByRole('button', { name: 'Enable audio processing' });
  if (await enableAudio.isVisible()) await enableAudio.click();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone + display audio');
  await expect(page.getByText('Canvas video: ready')).toBeVisible();
  await expect(page.getByText('Mixed audio: ready')).toBeVisible();

  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Recording');
  const memorySamples: MemorySample[] = [await sampleMemory(page, 0)];
  for (let minute = 1; minute <= 5; minute++) {
    await page.waitForTimeout(60_000);
    memorySamples.push(await sampleMemory(page, minute * 60));
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Completed', { timeout: 15_000 });
  const liveDuringResult = await page.evaluate(() => ({ source: window.fiveMinuteTest.sourceStates(), output: window.fiveMinuteTest.outputStates() }));
  const fiveMinutePath = testInfo.outputPath('five-minute-recording.webm');
  const longDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download WebM' }).click();
  await (await longDownloadPromise).saveAs(fiveMinutePath);
  const analysis = await analyzeRecording(fiveMinutePath, testInfo, tools);

  const pauseWallStarted = performance.now();
  await page.getByRole('button', { name: 'Start new recording' }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Recording');
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Paused');
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Completed');
  const pauseWallSeconds = (performance.now() - pauseWallStarted) / 1000;
  const pausePath = testInfo.outputPath('pause-resume-recording.webm');
  const pauseDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download WebM' }).click();
  await (await pauseDownloadPromise).saveAs(pausePath);
  const pauseMediaSeconds = await probeTimelineDuration(tools.ffprobe, pausePath);
  const liveAfterReplacement = await page.evaluate(() => ({ source: window.fiveMinuteTest.sourceStates(), output: window.fiveMinuteTest.outputStates() }));

  await page.getByRole('button', { name: 'Stop all capture' }).click();
  const afterCaptureStop = await page.evaluate(() => ({ source: window.fiveMinuteTest.sourceStates(), output: window.fiveMinuteTest.outputStates() }));
  const heapValues = memorySamples.flatMap(sample => sample.usedJsHeapBytes === null ? [] : [sample.usedJsHeapBytes]);
  const heapGrowth = heapValues.length > 1 ? Math.max(...heapValues) - heapValues[0]! : 0;
  const retainedMonotonic = memorySamples.every((sample, index) => index === 0 || sample.retainedBytes >= memorySamples[index - 1]!.retainedBytes);
  const tolerances = {
    duration: '300 s ± 3 s',
    streamDurationDifference: '≤ 250 ms',
    markerPosition: 'each video/audio marker within ± 750 ms of its scheduled time',
    markerAlignment: 'each A/V marker difference ≤ 250 ms',
    continuity: 'decoded fps ≥ 27 and maximum video timestamp gap ≤ 200 ms',
    audioBands: 'both expected route frequencies ≥ 0.01 amplitude at every marker',
    memory: 'retained bytes monotonic and final file < 128 MiB; JS heap growth ≤ 64 MiB when exposed',
    pauseResume: '4 s active media between 3.5–5.5 s while wall time includes a 2 s pause',
  };
  const violations: string[] = [];
  if (!Number.isFinite(analysis.formatDuration) || Math.abs(analysis.formatDuration - TARGET_SECONDS) > 3) violations.push(`Container duration ${analysis.formatDuration.toFixed(3)} s is outside 297–303 s.`);
  if (analysis.durationDifferenceMs > 250) violations.push(`Audio/video duration difference ${analysis.durationDifferenceMs.toFixed(1)} ms exceeds 250 ms.`);
  if (analysis.decodedFps < 27) violations.push(`Decoded frame rate ${analysis.decodedFps.toFixed(3)} fps is below 27 fps.`);
  if (analysis.maxFrameGapMs > 200) violations.push(`Maximum frame gap ${analysis.maxFrameGapMs.toFixed(1)} ms exceeds 200 ms.`);
  if (analysis.fileSize >= MEMORY_LIMIT) violations.push(`Recording size ${analysis.fileSize} reached the 128 MiB limit.`);
  if (!retainedMonotonic) violations.push('Retained MediaRecorder bytes were not monotonic during the five-minute run.');
  if (heapValues.length > 1 && heapGrowth > 64 * 1024 * 1024) violations.push(`JS heap growth ${(heapGrowth / 1024 / 1024).toFixed(1)} MiB exceeds 64 MiB.`);
  if (!['vp8', 'vp9'].includes(analysis.videoCodec)) violations.push(`Unexpected video codec ${analysis.videoCodec}.`);
  if (analysis.audioCodec !== 'opus') violations.push(`Unexpected audio codec ${analysis.audioCodec}.`);
  if (analysis.width !== 1280 || analysis.height !== 720) violations.push(`Unexpected dimensions ${analysis.width}×${analysis.height}.`);
  for (const marker of analysis.markers) {
    if (!Number.isFinite(marker.videoSeconds) || Math.abs(marker.videoSeconds - marker.expectedSeconds) > 0.75) violations.push(`${marker.name} video marker was not within 750 ms of schedule.`);
    if (!Number.isFinite(marker.audioSeconds) || Math.abs(marker.audioSeconds - marker.expectedSeconds) > 0.75) violations.push(`${marker.name} audio marker was not within 750 ms of schedule.`);
    if (!Number.isFinite(marker.alignmentMs) || marker.alignmentMs > 250) violations.push(`${marker.name} marker alignment ${marker.alignmentMs.toFixed(1)} ms exceeds 250 ms.`);
    if (marker.microphoneAmplitude < 0.01 || marker.displayAmplitude < 0.01) violations.push(`${marker.name} did not retain both distinguishable audio bands.`);
  }
  if (!(pauseMediaSeconds >= 3.5 && pauseMediaSeconds <= 5.5)) violations.push(`Pause/resume media duration ${pauseMediaSeconds.toFixed(3)} s is outside 3.5–5.5 s.`);
  if (pauseWallSeconds < pauseMediaSeconds + 1.5) violations.push('Pause/resume wall time did not retain the expected paused interval.');
  if (![...liveDuringResult.source, ...liveDuringResult.output, ...liveAfterReplacement.source, ...liveAfterReplacement.output].every(state => state === 'live')) violations.push('Recording or result replacement stopped a borrowed source/output track.');
  if (!afterCaptureStop.source.every(state => state === 'ended')) violations.push('Stop all capture did not end every CaptureManager-owned synthetic track.');
  if (!afterCaptureStop.output.every(state => state === 'live')) violations.push('Stopping capture incorrectly stopped compositor/mixer-owned outputs before unmount.');

  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}; Node ${process.version}`,
    browser: browserName,
    ffmpegVersion: tools.ffmpegVersion,
    ffprobeVersion: tools.ffprobeVersion,
    configuredBitrate: { videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000 },
    tolerances,
    analysis,
    memorySamples,
    heapGrowthBytes: heapGrowth,
    retainedMonotonic,
    pauseResume: { wallSeconds: pauseWallSeconds, mediaSeconds: pauseMediaSeconds },
    ownership: { liveDuringResult, liveAfterReplacement, afterCaptureStop },
    violations,
  };
  const jsonPath = testInfo.outputPath('five-minute-report.json');
  const markdownPath = testInfo.outputPath('five-minute-report.md');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, markdownReport(report), 'utf8');
  await testInfo.attach('five-minute-report', { path: markdownPath, contentType: 'text/markdown' });
  await testInfo.attach('five-minute-measurements', { path: jsonPath, contentType: 'application/json' });
  expect(violations, violations.join('\n')).toEqual([]);
});
