import { expect, test, type Page } from '@playwright/test';

// All media here is synthetic. No real display, webcam or microphone is opened.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

interface CaptureHarness {
  streams: MediaStream[];
  requests: { kind: string; constraints: MediaStreamConstraints | DisplayMediaStreamOptions | undefined; activated: boolean }[];
  mode: 'success' | 'pending' | 'denied';
  resolve(): void;
  end(index: number, kind?: string): void;
  removeCamera(): void;
  denyPlayback: boolean;
  deferNextPlay: boolean;
  rejectPlay(): void;
}
declare global { interface Window { captureTest: CaptureHarness } }

async function syntheticCapture(page: Page) {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const originalUserMedia = media.getUserMedia.bind(media);
    let devices = [
      { deviceId: 'camera-a', label: 'Synthetic camera A', kind: 'videoinput' },
      { deviceId: 'camera-b', label: 'Synthetic camera B', kind: 'videoinput' },
      { deviceId: 'mic-a', label: 'Synthetic microphone', kind: 'audioinput' },
    ];
    media.enumerateDevices = async () => devices as MediaDeviceInfo[];
    let resolve: (() => void) | undefined;
    let rejectPlay: ((error: Error) => void) | undefined;
    const harness: CaptureHarness = {
      streams: [], requests: [], mode: 'success', denyPlayback: false, deferNextPlay: false,
      rejectPlay: () => rejectPlay?.(new Error('Synthetic stale playback failure')),
      resolve: () => resolve?.(),
      end: (index, kind = 'video') => {
        const track = harness.streams[index]?.getTracks().find(track => track.kind === kind);
        track?.stop(); track?.dispatchEvent(new Event('ended'));
      },
      removeCamera: () => { devices = devices.filter(device => device.deviceId !== 'camera-a'); media.dispatchEvent(new Event('devicechange')); },
    };
    window.captureTest = harness;
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (harness.deferNextPlay) { harness.deferNextPlay = false; return new Promise<void>((_resolve, reject) => { rejectPlay = reject; }); }
      if (harness.denyPlayback) return Promise.reject(new DOMException('Synthetic autoplay rejection', 'NotAllowedError'));
      return nativePlay.call(this);
    };
    async function open(kind: 'display' | 'camera' | 'microphone', constraints: MediaStreamConstraints | DisplayMediaStreamOptions | undefined): Promise<MediaStream> {
      harness.requests.push({ kind, constraints, activated: navigator.userActivation.isActive });
      if (harness.mode === 'denied') throw new DOMException('Synthetic denial', 'NotAllowedError');
      if (harness.mode === 'pending') await new Promise<void>(done => { resolve = done; });
      let stream: MediaStream;
      if (kind === 'microphone') {
        stream = await originalUserMedia({ audio: true });
      } else {
        // Test fixture only: a moving canvas is the synthetic screen/camera source.
        // Application code has no canvas/compositor.
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d')!; let frame = 0;
        const draw = () => { context.fillStyle = kind === 'display' ? '#204c71' : '#28674e'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#ffffff'; context.fillRect((frame++ * 4) % 600, 100, 40, 40); };
        draw(); const timer = setInterval(draw, 33); stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0]!; const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      }
      const track = stream.getTracks()[0]!;
      const actual = track.getSettings.bind(track);
      const raw = kind === 'camera' ? (constraints as MediaStreamConstraints)?.video : (constraints as MediaStreamConstraints)?.audio;
      const requested = typeof raw === 'object' && raw.deviceId && typeof raw.deviceId === 'object' && 'exact' in raw.deviceId ? raw.deviceId.exact : undefined;
      track.getSettings = () => ({ ...actual(), ...(kind === 'display' ? { displaySurface: 'browser' } : { deviceId: typeof requested === 'string' ? requested : kind === 'camera' ? 'camera-a' : 'mic-a' }) });
      harness.streams.push(stream);
      return stream;
    }
    media.getUserMedia = options => open(options?.video ? 'camera' : 'microphone', options);
    media.getDisplayMedia = options => open('display', options);
  });
}

async function assertLivePreview(page: Page, label: string) {
  const video = page.getByLabel(label, { exact: true });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && node.videoWidth > 0 && !node.paused && node.muted)).toBe(true);
  const before = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 5000 }).toBeGreaterThan(before + 0.5);
}

test('sustained screen/camera preview and microphone stay active; independent stop clears previews and releases tracks', async ({ page }) => {
  await syntheticCapture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const external: string[] = []; page.on('request', req => { if (!req.url().startsWith('http://127.0.0.1:4318/')) external.push(req.url()); });
  await page.goto('/'); expect(await page.evaluate(() => window.captureTest.requests)).toEqual([]);
  await page.getByLabel('Camera device').selectOption('camera-a'); await page.getByLabel('Microphone device').selectOption('mic-a');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await assertLivePreview(page, 'Screen preview');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await assertLivePreview(page, 'Camera preview');
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await expect(page.getByText('Microphone is active', { exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Capture activity' })).toContainText('3 source(s) active');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText(/Shared audio unavailable:/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Screen actual track settings' })).toContainText('640 × 360');
  await expect(page.getByRole('button', { name: 'Check camera access' })).toBeDisabled();
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  expect(await page.evaluate(() => window.captureTest.requests.every(request => request.activated))).toBe(true);
  // Demonstrate sustained progression over 3 seconds, not just stream acquisition.
  const time = await page.getByLabel('Screen preview', { exact: true }).evaluate((video: HTMLVideoElement) => video.currentTime);
  await expect.poll(() => page.getByLabel('Screen preview', { exact: true }).evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 10000 }).toBeGreaterThan(time + 3);
  expect(await page.evaluate(() => window.captureTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'live')))).toBe(true);
  await page.getByRole('button', { name: 'Stop display', exact: true }).click();
  await expect.poll(() => page.getByLabel('Screen preview', { exact: true }).evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
  await expect(page.getByRole('status', { name: 'Camera capture status' })).toContainText('Active');
  await page.getByRole('button', { name: 'Stop all capture' }).click();
  expect(await page.evaluate(() => window.captureTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await expect(page.getByRole('status', { name: 'Capture activity' })).toContainText('No active capture');
  expect(external).toEqual([]); expect(errors).toEqual([]);
});

test('device switching is explicit and uses the selected ID, releasing the old stream', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/');
  await page.getByLabel('Camera device').selectOption('camera-a');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click(); await assertLivePreview(page, 'Camera preview');
  await page.getByLabel('Camera device').selectOption('camera-b');
  expect(await page.evaluate(() => window.captureTest.requests.length)).toBe(1);
  await page.getByRole('button', { name: 'Switch camera', exact: true }).click(); await assertLivePreview(page, 'Camera preview');
  expect(await page.evaluate(() => window.captureTest.requests[1]?.constraints)).toEqual({ video: { deviceId: { exact: 'camera-b' } }, audio: false });
  expect(await page.evaluate(() => window.captureTest.streams[0]?.getTracks()[0]?.readyState)).toBe('ended');
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('browser stop-sharing and device removal update state and stop affected streams', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await assertLivePreview(page, 'Screen preview');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click(); await assertLivePreview(page, 'Camera preview');
  await page.evaluate(() => window.captureTest.end(0));
  await expect(page.getByRole('status', { name: 'Screen capture status' })).toHaveText('ended');
  await page.evaluate(() => window.captureTest.removeCamera());
  await expect(page.getByRole('status', { name: 'Camera capture status' })).toHaveText('ended');
  expect(await page.evaluate(() => window.captureTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('cancelled share-picker result cannot reactivate capture', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/'); await page.evaluate(() => { window.captureTest.mode = 'pending'; });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel display request' }).click();
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeDisabled();
  await page.evaluate(() => window.captureTest.resolve());
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Screen capture status' })).toHaveText('cancelled');
  expect(await page.evaluate(() => window.captureTest.streams[0]?.getTracks()[0]?.readyState)).toBe('ended');
});

test('denial and playback failure explain recovery without concealing an active capture', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/'); await page.evaluate(() => { window.captureTest.mode = 'denied'; });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Screen capture feedback' })).toContainText('cancelled or denied');
  await page.evaluate(() => { window.captureTest.mode = 'success'; window.captureTest.denyPlayback = true; });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(page.getByText(/Preview playback was blocked/)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Screen capture status' })).toContainText('Active');
  await page.evaluate(() => { window.captureTest.denyPlayback = false; });
  await page.getByRole('button', { name: 'Retry screen preview' }).click(); await assertLivePreview(page, 'Screen preview');
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('pagehide stops active sources and abandons pending requests without restarting on return', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click(); await assertLivePreview(page, 'Camera preview');
  await page.evaluate(() => { window.captureTest.mode = 'pending'; });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.evaluate(() => window.captureTest.resolve());
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.captureTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await expect.poll(() => page.getByLabel('Camera preview', { exact: true }).evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByRole('status', { name: 'Capture activity' })).toHaveText('No active capture');
});

test('a late preview retry failure cannot replace the new source preview state', async ({ page }) => {
  await syntheticCapture(page); await page.goto('/');
  await page.evaluate(() => { window.captureTest.denyPlayback = true; });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByText(/Preview playback was blocked/)).toBeVisible();
  await page.evaluate(() => { window.captureTest.denyPlayback = false; window.captureTest.deferNextPlay = true; });
  await page.getByRole('button', { name: 'Retry camera preview' }).click();
  await page.getByRole('button', { name: 'Switch camera', exact: true }).click();
  await assertLivePreview(page, 'Camera preview');
  await page.evaluate(async () => { window.captureTest.rejectPlay(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('unsupported display API disables only display capture', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined }); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Screen capture status' })).toHaveText('unsupported');
});

test('native Chromium camera/microphone remain live until stopped with actual settings and no monitoring', async ({ page }) => {
  // Uses Chromium fake hardware through the native getUserMedia implementation.
  await page.addInitScript(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = []; Object.assign(window, { nativeCaptures: streams });
    navigator.mediaDevices.getUserMedia = async options => { const stream = await native(options); streams.push(stream); return stream; };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click(); await assertLivePreview(page, 'Camera preview');
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await expect(page.getByText('Microphone is active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Microphone actual track settings' })).toContainText('Hz');
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  expect(await page.locator('audio').count()).toBe(0);
  await page.getByRole('button', { name: 'Stop all capture' }).click();
  expect(await page.evaluate(() => (window as unknown as { nativeCaptures: MediaStream[] }).nativeCaptures.flatMap(stream => stream.getTracks()).every(track => track.readyState === 'ended'))).toBe(true);
});
