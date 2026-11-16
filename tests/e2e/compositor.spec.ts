import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

declare global {
  interface Window {
    compositorTest: { streams: MediaStream[]; output?: MediaStream; stopped(): string[] };
    realFaceTest: { stream: MediaStream | null };
  }
}

async function syntheticSources(page: Page) {
  await page.addInitScript(() => {
    class SyntheticFaceDetector {
      async detect(source: CanvasImageSource) {
        const video = source as HTMLVideoElement;
        return [{
          boundingBox: { x: video.videoWidth * 0.05, y: video.videoHeight * 0.25, width: video.videoWidth * 0.18, height: video.videoHeight * 0.25 },
          confidence: 0.95,
        }];
      }
    }
    (globalThis as typeof globalThis & { FaceDetector?: typeof SyntheticFaceDetector }).FaceDetector = SyntheticFaceDetector;
    const streams: MediaStream[] = [];
    const timers: number[] = [];
    const media = navigator.mediaDevices;
    media.enumerateDevices = async () => [
      { deviceId: 'camera-a', label: 'Green camera', kind: 'videoinput' },
      { deviceId: 'camera-b', label: 'Magenta camera', kind: 'videoinput' },
      { deviceId: 'mic-a', label: 'Synthetic microphone', kind: 'audioinput' },
    ] as MediaDeviceInfo[];

    function videoStream(kind: 'screen' | 'camera-a' | 'camera-b') {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const drawing = canvas.getContext('2d')!; let frame = 0;
      const paint = () => {
        if (kind === 'screen') {
          drawing.fillStyle = '#204c71'; drawing.fillRect(0, 0, 640, 480);
          drawing.fillStyle = '#d06a32'; drawing.fillRect(480, 0, 160, 480);
          drawing.fillStyle = '#ffffff'; drawing.fillRect((frame++ * 5) % 600, 40, 40, 40);
        } else if (kind === 'camera-a') {
          drawing.fillStyle = '#cc3333'; drawing.fillRect(0, 0, 640, 60);
          drawing.fillStyle = '#28674e'; drawing.fillRect(0, 60, 640, 360);
          drawing.fillStyle = '#304dcc'; drawing.fillRect(0, 420, 640, 60);
          drawing.fillStyle = '#d1972f'; drawing.fillRect(0, 60, 260, 360);
        } else {
          drawing.fillStyle = '#9b3fa8'; drawing.fillRect(0, 0, 640, 480);
        }
      };
      paint(); const timer = window.setInterval(paint, 33); timers.push(timer);
      const stream = canvas.captureStream(30); const track = stream.getVideoTracks()[0]!;
      const nativeStop = track.stop.bind(track); track.stop = () => { window.clearInterval(timer); nativeStop(); };
      const nativeSettings = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...nativeSettings(),
        ...(kind.startsWith('camera') ? { deviceId: kind } : {}),
        frameRate: 30,
      });
      streams.push(stream); return stream;
    }
    media.getDisplayMedia = async () => videoStream('screen');
    media.getUserMedia = async constraints => {
      if (!constraints?.video) throw new DOMException('Audio is not used in compositor tests', 'NotSupportedError');
      const raw = typeof constraints.video === 'object' ? constraints.video.deviceId : undefined;
      const exact = raw && typeof raw === 'object' && 'exact' in raw ? raw.exact : 'camera-a';
      return videoStream(exact === 'camera-b' ? 'camera-b' : 'camera-a');
    };
    window.compositorTest = {
      streams,
      stopped: () => streams.flatMap(stream => stream.getTracks()).map(track => track.readyState),
    };
    window.addEventListener('unload', () => timers.forEach(timer => window.clearInterval(timer)));
  });
}

async function officialPortraitBase64(): Promise<string> {
  const response = await fetch('https://storage.googleapis.com/mediapipe-assets/portrait.jpg');
  if (!response.ok) throw new Error(`Unable to fetch the pinned MediaPipe portrait fixture (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  expect(hash).toBe('a6f11efaa834706db23f275b6115058fa87fc7f14362681e6abe14e82749de3e');
  return bytes.toString('base64');
}

async function realMediaPipePortraitSource(page: Page): Promise<void> {
  const portraitBase64 = await officialPortraitBase64();
  await page.addInitScript(async ({ portrait }) => {
    const media = navigator.mediaDevices;
    media.enumerateDevices = async () => [
      { deviceId: 'portrait-camera', label: 'Pinned MediaPipe portrait', kind: 'videoinput' },
    ] as MediaDeviceInfo[];
    window.realFaceTest = { stream: null };
    media.getUserMedia = async constraints => {
      if (!constraints?.video) throw new DOMException('Only video is available.', 'NotSupportedError');
      const binary = atob(portrait);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      const draw = () => context.drawImage(image, 0, 0);
      const stream = canvas.captureStream(12);
      draw();
      const timer = window.setInterval(draw, 80);
      const track = stream.getVideoTracks()[0]!;
      const stop = track.stop.bind(track);
      track.stop = () => { window.clearInterval(timer); stop(); };
      window.realFaceTest.stream = stream;
      return stream;
    };
  }, { portrait: portraitBase64 });
}

test('local auto framing smooths the camera crop and does not own camera tracks', async ({ page }) => {
  await syntheticSources(page);
  await page.route('**/vision/wasm/**', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Auto frame off' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await waitForPixel(page, 640, 360, [40, 103, 78, 255]);
  await page.getByRole('button', { name: 'Auto frame off' }).click();
  await expect(page.getByRole('button', { name: 'Auto frame on' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('1 face detected; framing is following the primary presenter.')).toBeVisible();
  await expect(page.getByLabel('Face detector performance')).toContainText('12 Hz');
  await expect(page.getByLabel('Face detector performance')).toContainText('tracking');
  await waitForPixel(page, 640, 360, [209, 151, 47, 255]);
  const cameraStateBeforeDisable = await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState);
  expect(cameraStateBeforeDisable).toBe('live');
  await page.getByLabel('Manual', { exact: true }).check();
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');
  await expect(page.getByText('Manual framing at 1.0×. Camera frames are not analyzed.')).toBeVisible();
  await waitForPixel(page, 640, 360, [40, 103, 78, 255]);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('self-hosted MediaPipe detects a real portrait without runtime network egress', async ({ page }) => {
  test.setTimeout(45_000);
  await realMediaPipePortraitSource(page);
  const requested: string[] = [];
  page.on('request', request => requested.push(request.url()));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('button', { name: 'Auto frame off' }).click();
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('1 face detected; framing is following the primary presenter.')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByLabel('Face detector performance')).toContainText('Faces1');
  expect(requested.some(url => url.includes('/vision/wasm/vision_wasm_internal'))).toBe(true);
  expect(requested.some(url => url.endsWith('/vision/models/blaze_face_short_range.tflite'))).toBe(true);
  expect(requested.filter(url => !url.startsWith('http://127.0.0.1:4318/'))).toEqual([]);
  await page.getByLabel('Manual', { exact: true }).check();
  expect(await page.evaluate(() => window.realFaceTest.stream?.getVideoTracks()[0]?.readyState)).toBe('live');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('manual camera zoom and pan override auto framing and are restored without stopping the camera', async ({ page }) => {
  await syntheticSources(page);
  await page.route('**/vision/wasm/**', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByRole('slider', { name: 'Camera zoom' })).toBeDisabled();
  await expect(page.getByLabel('Automatic', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByLabel('Manual', { exact: true })).toBeChecked();
  await waitForPixel(page, 100, 360, [209, 151, 47, 255]);

  await page.getByRole('slider', { name: 'Camera zoom' }).fill('200');
  await page.getByRole('slider', { name: 'Camera horizontal position' }).fill('100');
  await page.getByRole('slider', { name: 'Camera vertical position' }).fill('50');
  await expect(page.getByText('Manual framing at 2.0×. Camera frames are not analyzed.')).toBeVisible();
  await waitForPixel(page, 100, 360, [40, 103, 78, 255]);
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');

  await page.getByLabel('Automatic', { exact: true }).check();
  await expect(page.getByText('1 face detected; framing is following the primary presenter.')).toBeVisible();
  await waitForPixel(page, 100, 360, [209, 151, 47, 255]);

  await page.getByLabel('Manual', { exact: true }).check();
  await expect(page.getByRole('slider', { name: 'Camera zoom' })).toHaveValue('200');
  await expect(page.getByRole('slider', { name: 'Camera horizontal position' })).toHaveValue('100');
  await waitForPixel(page, 100, 360, [40, 103, 78, 255]);

  await page.getByRole('button', { name: 'Reset manual framing' }).click();
  await expect(page.getByRole('slider', { name: 'Camera zoom' })).toHaveValue('100');
  await waitForPixel(page, 100, 360, [209, 151, 47, 255]);
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.getByLabel('Composed video preview').evaluate((canvas: HTMLCanvasElement, point) => {
    return Array.from(canvas.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

async function waitForPixel(page: Page, x: number, y: number, expected: number[]) {
  await expect.poll(async () => {
    const actual = await pixel(page, x, y);
    return expected.every((value, index) => Math.abs((actual[index] ?? 0) - value) <= 10);
  }, { timeout: 10000 }).toBe(true);
}

test('renders all layouts with preserved aspect ratios, normalized PIP and adjustable split', async ({ page }) => {
  await syntheticSources(page); await page.goto('/');
  await expect(page.getByRole('status', { name: 'Canvas output status' })).toContainText('ready');
  await page.getByLabel('Camera device').selectOption('camera-a');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);
  await waitForPixel(page, 1050, 550, [40, 103, 78, 255]);

  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await page.getByLabel('Layout').selectOption('screen');
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);
  await waitForPixel(page, 30, 360, [8, 14, 12, 255]); // 4:3 screen letterboxed into 16:9.

  await page.getByLabel('Layout').selectOption('camera');
  await waitForPixel(page, 640, 5, [40, 103, 78, 255]); // Center crop removes colored 60px top/bottom bands.
  await waitForPixel(page, 640, 715, [40, 103, 78, 255]);

  await page.getByLabel('Layout').selectOption('split');
  await waitForPixel(page, 300, 360, [32, 76, 113, 255]);
  await waitForPixel(page, 1100, 360, [40, 103, 78, 255]);
  await page.getByRole('slider', { name: 'Screen proportion' }).fill('40');
  await waitForPixel(page, 900, 360, [40, 103, 78, 255]);

  await page.getByLabel('Layout').selectOption('pip');
  await waitForPixel(page, 1050, 550, [40, 103, 78, 255]);
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);

  await page.getByLabel('Resolution').selectOption('1080p');
  await expect(page.getByLabel('Composed video preview')).toHaveJSProperty('width', 1920);
  await expect(page.getByLabel('Composed video preview')).toHaveJSProperty('height', 1080);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('selects, resets and invalidates an aspect-preserving screen focus without stopping borrowed tracks', async ({ page }) => {
  await syntheticSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByRole('button', { name: 'Select focus area' })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('Full shared screen is visible.')).toBeVisible();
  await page.getByRole('button', { name: 'Select focus area' }).click();
  const selector = page.getByRole('region', { name: 'Select screen focus area' });
  const sourcePreview = page.getByLabel('Full shared screen for focus selection');
  await expect(selector).toBeVisible();
  await expect.poll(() => sourcePreview.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);

  await page.keyboard.press('Escape');
  await expect(selector).toBeHidden();
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);

  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await page.getByRole('button', { name: 'Select focus area' }).click();
  const box = await selector.boundingBox();
  if (!box) throw new Error('Screen focus selector is missing');
  const contentHeight = box.height;
  const contentWidth = contentHeight * 4 / 3;
  const contentLeft = box.x + (box.width - contentWidth) / 2;
  await page.mouse.move(contentLeft + contentWidth * 0.75, box.y + contentHeight * 0.35);
  await page.mouse.down();
  await page.mouse.move(contentLeft + contentWidth * 0.98, box.y + contentHeight * 0.65);
  await page.mouse.up();
  await expect(selector).toBeHidden();
  await waitForPixel(page, 640, 360, [208, 106, 50, 255]);
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');

  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText(/Custom source region selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Save current focus as Code preset' }).click();
  await expect(page.getByRole('button', { name: 'Apply Code focus preset' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply Code focus preset' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reset screen focus' }).click();
  await expect(page.getByText(/Smoothly transitioning/)).toBeVisible();
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);
  await page.getByRole('button', { name: 'Apply Code focus preset' }).click();
  await expect(page.getByText(/Smoothly transitioning/)).toBeVisible();
  await waitForPixel(page, 640, 360, [208, 106, 50, 255]);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await page.getByRole('button', { name: 'Change shared source', exact: true }).click();
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('ended');
  expect(await page.evaluate(() => window.compositorTest.streams[1]?.getVideoTracks()[0]?.readyState)).toBe('live');
  await page.getByRole('button', { name: 'Scene & output settings' }).click();
  await expect(page.getByText('Full shared screen is visible.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply Code focus preset' })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('PIP and screen view can be moved and resized by pointer without escaping normalized bounds', async ({ page }) => {
  await syntheticSources(page); await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  const pipEditor = page.locator('.pip-editor');
  const getRectPercentages = async (selector: string) => page.locator(selector).evaluate((el: HTMLElement) => ({
    x: parseFloat(el.style.left),
    y: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  }));

  const beforePip = await getRectPercentages('.pip-editor');
  const move = page.getByRole('button', { name: 'Move webcam overlay' }); await move.scrollIntoViewIfNeeded(); const moveBox = await move.boundingBox();
  if (!moveBox) throw new Error('Move handle missing');
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down(); await page.mouse.move(moveBox.x + moveBox.width / 2 - 80, moveBox.y + moveBox.height / 2 - 35); await page.mouse.up();
  const movedPip = await getRectPercentages('.pip-editor');
  expect(movedPip.x).toBeLessThan(beforePip.x);

  const resize = page.getByRole('button', { name: 'Resize webcam overlay' }); await resize.scrollIntoViewIfNeeded(); const resizeBox = await resize.boundingBox();
  if (!resizeBox) throw new Error('Resize handle missing');
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down(); await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 60, resizeBox.y + resizeBox.height / 2 + 25); await page.mouse.up();
  const resizedPip = await getRectPercentages('.pip-editor');
  expect(resizedPip.width).toBeGreaterThan(movedPip.width);
  expect(resizedPip.x + resizedPip.width).toBeLessThanOrEqual(100.01);
  await expect(pipEditor).toBeVisible();

  const initialScreen = await getRectPercentages('.screen-editor');
  expect(initialScreen.width).toBe(100);
  await page.getByRole('button', { name: 'Decrease screen view' }).click();
  await expect(page.getByRole('button', { name: 'Move screen view' })).toContainText('90%');
  await page.getByRole('button', { name: 'Increase screen view' }).click();
  await expect(page.getByRole('button', { name: 'Move screen view' })).toContainText('100%');

  const resizeScreen = page.getByRole('button', { name: 'Resize screen view' });
  await resizeScreen.scrollIntoViewIfNeeded();
  const resizeScreenBox = await resizeScreen.boundingBox();
  if (!resizeScreenBox) throw new Error('Screen resize handle missing');
  await page.mouse.move(resizeScreenBox.x + resizeScreenBox.width / 2, resizeScreenBox.y + resizeScreenBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeScreenBox.x + resizeScreenBox.width / 2 - 140, resizeScreenBox.y + resizeScreenBox.height / 2 - 90);
  await page.mouse.up();
  const resizedScreen = await getRectPercentages('.screen-editor');
  expect(resizedScreen.width).toBeLessThan(100);

  const moveScreen = page.getByRole('button', { name: 'Move screen view' });
  const moveScreenBox = await moveScreen.boundingBox();
  if (!moveScreenBox) throw new Error('Screen move handle missing');
  await page.mouse.move(moveScreenBox.x + moveScreenBox.width / 2, moveScreenBox.y + moveScreenBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveScreenBox.x + moveScreenBox.width / 2 + 40, moveScreenBox.y + moveScreenBox.height / 2 + 25);
  await page.mouse.up();
  const movedScreen = await getRectPercentages('.screen-editor');
  expect(movedScreen.x).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Reset screen view' }).click();
  const resetScreen = await getRectPercentages('.screen-editor');
  expect(resetScreen.width).toBe(100);
  expect(resetScreen.x).toBe(0);

  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('source loss, stop and replacement update the composition without mutating surviving tracks', async ({ page }) => {
  await syntheticSources(page); await page.goto('/');
  await page.getByLabel('Camera device').selectOption('camera-a');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('group', { name: 'Scene composition presets' }).getByRole('button', { name: 'Split', exact: true }).click();
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await waitForPixel(page, 640, 360, [32, 76, 113, 255]);
  expect(await page.evaluate(() => window.compositorTest.streams[0]?.getVideoTracks()[0]?.readyState)).toBe('live');

  await page.getByLabel('Camera device').selectOption('camera-b');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await waitForPixel(page, 1100, 360, [155, 63, 168, 255]);
  await page.getByRole('button', { name: 'Stop display', exact: true }).click();
  await waitForPixel(page, 640, 360, [155, 63, 168, 255]);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await waitForPixel(page, 640, 360, [23, 34, 31, 255]);
  expect(await page.evaluate(() => window.compositorTest.stopped().every(state => state === 'ended'))).toBe(true);
});

test('canvas output stream delivers advancing frames at the selected resolution', async ({ page }) => {
  await syntheticSources(page); await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  const result = await page.getByLabel('Composed video preview').evaluate(async (canvas: HTMLCanvasElement) => {
    const stream = canvas.captureStream(30); window.compositorTest.output = stream;
    const video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play();
    const start = video.currentTime;
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const check = () => video.currentTime > start + 0.5 ? resolve() : performance.now() > deadline ? reject(new Error('Canvas output did not advance')) : requestAnimationFrame(check);
      check();
    });
    const track = stream.getVideoTracks()[0]!; const settings = track.getSettings();
    const answer = {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      currentTime: video.currentTime,
      readyState: track.readyState,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
    };
    video.pause(); video.srcObject = null; track.stop(); return answer;
  });
  expect(result.currentTime).toBeGreaterThan(0.5); expect(result.readyState).toBe('live');
  expect(result.canvasWidth).toBe(1280); expect(result.canvasHeight).toBe(720);
  if (result.width !== undefined) expect(result.width).toBe(1280);
  if (result.height !== undefined) expect(result.height).toBe(720);
  if (result.frameRate !== undefined) expect(result.frameRate).toBeLessThanOrEqual(30);
  expect(await page.evaluate(() => window.compositorTest.output?.getVideoTracks()[0]?.readyState)).toBe('ended');
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('mobile controls remain usable and composed pixels are opaque', async ({ page }) => {
  await syntheticSources(page); await page.setViewportSize({ width: 375, height: 812 }); await page.goto('/');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('group', { name: 'Scene composition presets' }).getByRole('button', { name: 'Camera', exact: true }).click();
  await expect.poll(async () => pixel(page, 640, 360)).not.toEqual([23, 34, 31, 255]);
  const center = await pixel(page, 640, 360); expect(center[3]).toBe(255);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('two-column studio keeps composed preview, layout presets, 44px PIP handle and Start recording above the fold', async ({ page }) => {
  await syntheticSources(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.compositor-stage canvas')!.getBoundingClientRect();
    const recordButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Start recording')!.getBoundingClientRect();
    const capturePanel = document.querySelector<HTMLElement>('.capture-panel')!.getBoundingClientRect();
    const resize = document.querySelector<HTMLButtonElement>('.pip-resize')!.getBoundingClientRect();
    return {
      canvasInViewport: canvas.top >= 0 && canvas.bottom <= window.innerHeight,
      recordInViewport: recordButton.top >= 0 && recordButton.bottom <= window.innerHeight,
      twoColumnSideBySide: capturePanel.left >= canvas.right,
      resizeWidth: Math.round(resize.width),
      resizeHeight: Math.round(resize.height),
    };
  });

  expect(metrics.canvasInViewport).toBe(true);
  expect(metrics.recordInViewport).toBe(true);
  expect(metrics.twoColumnSideBySide).toBe(true);
  expect(metrics.resizeWidth).toBeGreaterThanOrEqual(44);
  expect(metrics.resizeHeight).toBeGreaterThanOrEqual(44);

  const sceneTrigger = page.getByRole('button', { name: 'Scene & output settings' });
  await sceneTrigger.click();
  await expect(page.getByRole('button', { name: 'Close scene settings' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close scene settings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Scene & output settings' })).toBeHidden();
  await expect(sceneTrigger).toBeFocused();

  const presets = page.getByRole('group', { name: 'Scene composition presets' });
  await presets.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(presets.getByRole('button', { name: 'Split', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Layout')).toHaveValue('split');

  for (const viewport of [
    { width: 1280, height: 800 }, // MacBook Air 13" / Nest Hub Max
    { width: 1280, height: 720 }, // 720p laptop
    { width: 1024, height: 600 }, // Nest Hub
  ]) {
    await page.setViewportSize(viewport);
    const compactDesktop = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.compositor-stage canvas')!.getBoundingClientRect();
      const recordButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Start recording')!.getBoundingClientRect();
      const capturePanel = document.querySelector<HTMLElement>('.capture-panel')!.getBoundingClientRect();
      return {
        aboveFold: canvas.top >= 0 && recordButton.bottom <= window.innerHeight,
        twoColumnSideBySide: capturePanel.left >= canvas.right,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(compactDesktop.twoColumnSideBySide, `${viewport.width}x${viewport.height} should stay 2-column side-by-side`).toBe(true);
    expect(compactDesktop.aboveFold, `${viewport.width}x${viewport.height} should keep stage and Start recording above the fold`).toBe(true);
    expect(compactDesktop.noOverflow, `${viewport.width}x${viewport.height} should not overflow horizontally`).toBe(true);
  }

  await page.getByRole('button', { name: 'Stop all capture' }).click();
});
