import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

declare global {
  interface Window {
    recordingTest: {
      canvasOutputs: MediaStream[];
      audioOutputs: MediaStream[];
      sources: MediaStream[];
      blobs: Array<{ type: string; size: number }>;
      states(): MediaStreamTrackState[];
    };
  }
}

async function installRecordingSources(page: Page) {
  await page.addInitScript(() => {
    const canvasOutputs: MediaStream[] = [];
    const audioOutputs: MediaStream[] = [];
    const sources: MediaStream[] = [];
    const blobs: Array<{ type: string; size: number }> = [];
    const contexts: AudioContext[] = [];
    const timers: number[] = [];
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

    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'recording-mic', groupId: 'recording', kind: 'audioinput', label: 'Recording tone microphone', toJSON: () => ({}) },
    ];

    function microphoneStream() {
      const context = new AudioContext(); contexts.push(context);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.35;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      const track = destination.stream.getAudioTracks()[0]!;
      const nativeStop = track.stop.bind(track);
      track.stop = () => {
        try { oscillator.stop(); } catch { /* already stopped */ }
        nativeStop();
        void context.close();
      };
      const stream = new MediaStream([track]);
      sources.push(stream);
      return stream;
    }

    function displayStream() {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      const drawing = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        drawing.fillStyle = '#204c71'; drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = '#ffffff'; drawing.fillRect((frame++ * 7) % 580, 40, 60, 60);
      };
      paint(); timers.push(window.setInterval(paint, 33));
      const stream = canvas.captureStream(30);
      sources.push(stream);
      return stream;
    }

    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints?.audio) throw new DOMException('Only microphone audio is provided', 'NotSupportedError');
      return microphoneStream();
    };
    navigator.mediaDevices.getDisplayMedia = async () => displayStream();
    window.recordingTest = {
      canvasOutputs,
      audioOutputs,
      sources,
      blobs,
      states: () => sources.flatMap(stream => stream.getTracks()).map(track => track.readyState),
    };
    window.addEventListener('unload', () => {
      timers.forEach(timer => window.clearInterval(timer));
      contexts.forEach(context => { void context.close(); });
    });
  });
}

async function enableAudioIfNeeded(page: Page) {
  const button = page.getByRole('button', { name: 'Enable audio processing' });
  if (await button.isVisible()) await button.click();
}

test('records playable WebM video with mixed audio, codec metadata, duration and pause/resume', async ({ page }) => {
  await installRecordingSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await enableAudioIfNeeded(page);
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('Canvas video: ready')).toBeVisible();
  await expect(page.getByText('Mixed audio: ready')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Recording');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Paused');
  const pausedDuration = await page.locator('.recording-clock time').textContent();
  await page.waitForTimeout(800);
  expect(await page.locator('.recording-clock time').textContent()).toBe(pausedDuration);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Completed');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByRole('status', { name: 'Recording format' })).toContainText('video/webm');
  await expect(page.getByRole('status', { name: 'Recording format' })).toContainText('video + mixed audio');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const download = page.getByRole('link', { name: 'Download WebM' });
  await expect(download).toHaveAttribute('href', /^blob:/);

  const playback = await page.getByLabel('Recorded WebM preview').evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('Recorded WebM metadata failed')), { once: true });
    });
    await video.play();
    const initialTime = video.currentTime;
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const check = () => video.currentTime > initialTime + 0.5 ? resolve() : performance.now() > deadline ? reject(new Error('Recorded WebM did not play')) : requestAnimationFrame(check);
      check();
    });
    const capture = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(capture);
    const analyser = context.createAnalyser();
    const sink = context.createMediaStreamDestination();
    analyser.fftSize = 256;
    source.connect(analyser).connect(sink);
    const samples = new Float32Array(analyser.fftSize);
    let audioLevel = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(samples);
      audioLevel = Math.max(audioLevel, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
    }
    source.disconnect(); analyser.disconnect();
    await context.close();
    video.pause();
    return {
      advanced: video.currentTime - initialTime,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      audioTracks: capture.getAudioTracks().length,
      videoTracks: capture.getVideoTracks().length,
      audioLevel,
      blobType: window.recordingTest.blobs.at(-1)?.type ?? '',
      blobSize: window.recordingTest.blobs.at(-1)?.size ?? 0,
    };
  });
  expect(playback.advanced).toBeGreaterThan(0.5);
  expect(playback.duration).toBeGreaterThan(1.5);
  expect(playback.duration).toBeLessThan(3.5);
  expect(playback.width).toBe(1280); expect(playback.height).toBe(720);
  expect(playback.audioTracks).toBe(1); expect(playback.videoTracks).toBe(1);
  expect(playback.audioLevel).toBeGreaterThan(0.005);
  expect(playback.blobType).toContain('video/webm');
  expect(playback.blobType).toMatch(/vp8|vp9/);
  expect(playback.blobType).toContain('opus');
  expect(playback.blobSize).toBeGreaterThan(1000);
  expect(await page.evaluate(() => window.recordingTest.states().every(state => state === 'live'))).toBe(true);
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('durable mode creates a session, delivers multiple real MediaRecorder chunks and shows Saved only after finalization', async ({ page }) => {
  await installRecordingSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await enableAudioIfNeeded(page);
  await page.getByRole('button', { name: 'Recording options' }).click();
  await page.getByRole('radio', { name: 'Durable local session' }).check();
  await page.getByLabel('Recording name').fill('Durable browser fixture');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Recording');
  await page.waitForTimeout(2300);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Saved', { timeout: 15_000 });
  await expect(page.getByText('Saved locally')).toBeVisible();

  const stored = await page.evaluate(async () => {
    const response = await fetch('/api/v1/sessions?limit=1');
    const body = await response.json() as { data?: { items?: Array<{ title: string; status: string; chunks: { committedCount: number }; output: { expectedChunkCount: number; byteLength: number } | null }> } };
    return body.data?.items?.[0] ?? null;
  });
  expect(stored?.title).toBe('Durable browser fixture');
  expect(stored?.status).toBe('completed');
  expect(stored?.chunks.committedCount).toBeGreaterThanOrEqual(2);
  expect(stored?.output?.expectedChunkCount).toBe(stored?.chunks.committedCount);
  expect(stored?.output?.byteLength).toBeGreaterThan(1000);
  expect(await page.evaluate(() => window.recordingTest.blobs.length)).toBe(0);
  expect(await page.evaluate(() => window.recordingTest.states().every(state => state === 'live'))).toBe(true);
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('recovery UI inspects and salvages only server-acknowledged interrupted chunks', async ({ page }) => {
  await page.goto('/');
  const sessionId = await page.evaluate(async () => {
    const bootstrap = await fetch('/api/v1/bootstrap', { headers: { 'X-Recorder-Bootstrap': '1' } });
    const token = (await bootstrap.json() as { data: { writeToken: string } }).data.writeToken;
    const common = { 'Content-Type': 'application/json', 'X-Recorder-Token': token };
    const created = await fetch('/api/v1/sessions', { method: 'POST', headers: common, body: JSON.stringify({
      title: 'Browser recovery fixture', configuration: { layout: 'screen', resolution: '720p', fps: 30,
        videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000, audioMode: 'none' },
    }) });
    const id = (await created.json() as { data: { id: string } }).data.id;
    const bytes = new TextEncoder().encode('server acknowledged browser recovery bytes');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    const uploaded = await fetch(`/api/v1/sessions/${id}/chunks/0`, { method: 'PUT', headers: {
      'Content-Type': 'video/webm;codecs=vp8', 'Content-Length': String(bytes.length), 'X-Recorder-Token': token,
      'X-Recorder-Chunk-Sha256': digest, 'X-Recorder-Chunk-Timestamp': new Date().toISOString(),
    }, body: bytes });
    if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.status}`);
    return id;
  });
  await page.goto('/#recovery');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Browser recovery fixture')).toBeVisible();
  await expect(page.getByText(/valid-incomplete/)).toBeVisible();
  await page.locator('.recovery-list li').filter({ hasText: 'Browser recovery fixture' }).getByRole('button', { name: 'Salvage acknowledged chunks' }).click();
  await expect(page.getByText('Browser recovery fixture')).toHaveCount(0);
  const completed = await page.evaluate(async id => {
    const response = await fetch(`/api/v1/sessions/${id}`);
    return (await response.json() as { data: { status: string; output: unknown } }).data;
  }, sessionId);
  expect(completed.status).toBe('completed');
  expect(completed.output).not.toBeNull();
});

test('switching Studio, Recordings, Recovery, and Settings views during capture, recording, upload, retry, and finalization preserves engines and tracks', async ({ page }) => {
  let failedFirstChunk = false;
  await page.route('**/api/v1/sessions/*/chunks/0', async route => {
    if (!failedFirstChunk) {
      failedFirstChunk = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ apiVersion: 'v1', ok: false, error: { code: 'INTERNAL_ERROR', message: 'Simulated transient chunk failure.' } }),
      });
      return;
    }
    await route.continue();
  });

  await installRecordingSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await enableAudioIfNeeded(page);
  await expect(page.getByRole('status', { name: 'Studio activity status' })).toHaveText('2 sources active');

  const initialOutputs = await page.evaluate(() => ({
    canvasOutputs: window.recordingTest.canvasOutputs.length,
    audioOutputs: window.recordingTest.audioOutputs.length,
  }));

  await page.getByRole('button', { name: /^Recordings/ }).click();
  await expect(page.getByRole('status', { name: 'Background studio activity' })).toContainText('2 live capture sources are running in Studio');
  await page.getByRole('button', { name: 'Return to Studio' }).click();
  await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Recording options' }).click();
  await page.getByLabel('Durable local session').check();
  await page.getByLabel('Recording name').fill('Cross-view durable fixture');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText(/Recording|Retrying/);

  await page.getByRole('button', { name: /^Recordings/ }).click();
  await expect(page.getByRole('status', { name: 'Background studio activity' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#recovery'; });
  await expect(page.getByRole('status', { name: 'Background studio activity' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Background studio activity' })).toBeVisible();

  await page.waitForTimeout(2300);
  await page.getByRole('button', { name: 'Return to Studio' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  await page.getByRole('button', { name: /^Recordings/ }).click();
  await expect(page.getByRole('status', { name: 'Studio activity status' })).toHaveText('Session saved', { timeout: 15_000 });
  const sessionCard = page.locator('.session-card').filter({ hasText: 'Cross-view durable fixture' });
  await expect(sessionCard).toBeVisible();
  await expect(sessionCard).toContainText('Saved WebM');
  await expect(sessionCard).toContainText('Finalized WebM verified');

  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Saved');
  await expect(page.getByText('Saved locally')).toBeVisible();

  const finalOutputs = await page.evaluate(() => ({
    canvasOutputs: window.recordingTest.canvasOutputs.length,
    audioOutputs: window.recordingTest.audioOutputs.length,
    allLive: window.recordingTest.states().every(state => state === 'live'),
  }));
  expect(finalOutputs).toEqual({
    canvasOutputs: initialOutputs.canvasOutputs,
    audioOutputs: initialOutputs.audioOutputs,
    allLive: true,
  });

  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('recorder fails safely when a borrowed compositor output ends and leaves mixer output live', async ({ page }) => {
  await installRecordingSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('Mixed audio: unavailable (video-only recording)')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Recording');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.recordingTest.canvasOutputs[0]?.getVideoTracks()[0]?.stop());
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Failed');
  await expect(page.getByRole('alert')).toContainText('Canvas video output ended');
  await expect(page.getByLabel('Recorded WebM preview')).toHaveCount(0);
  expect(await page.evaluate(() => window.recordingTest.audioOutputs[0]?.getAudioTracks()[0]?.readyState)).toBe('live');
});

test('unsupported MediaRecorder configuration reports an actionable failure', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(MediaRecorder, 'isTypeSupported', { configurable: true, value: () => false });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Recording status' })).toHaveText('Failed');
  await expect(page.getByRole('alert')).toContainText('does not support the required WebM');
  await expect(page.getByRole('button', { name: 'Start new recording' })).toBeEnabled();
});
