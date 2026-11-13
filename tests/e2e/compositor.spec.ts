import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

declare global {
  interface Window {
    compositorTest: { streams: MediaStream[]; output?: MediaStream; stopped(): string[] };
  }
}

async function syntheticSources(page: Page) {
  await page.addInitScript(() => {
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
          drawing.fillStyle = '#ffffff'; drawing.fillRect((frame++ * 5) % 600, 40, 40, 40);
        } else if (kind === 'camera-a') {
          drawing.fillStyle = '#cc3333'; drawing.fillRect(0, 0, 640, 60);
          drawing.fillStyle = '#28674e'; drawing.fillRect(0, 60, 640, 360);
          drawing.fillStyle = '#304dcc'; drawing.fillRect(0, 420, 640, 60);
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
  await waitForPixel(page, 700, 360, [40, 103, 78, 255]);

  await page.getByLabel('Layout').selectOption('pip');
  await page.getByLabel('Webcam horizontal position').fill('10');
  await page.getByLabel('Webcam vertical position').fill('10');
  await page.getByLabel('Webcam overlay width').fill('20');
  await page.getByLabel('Webcam overlay height').fill('20');
  await waitForPixel(page, 200, 120, [40, 103, 78, 255]);
  await waitForPixel(page, 800, 360, [32, 76, 113, 255]);

  await page.getByLabel('Resolution').selectOption('1080p');
  await expect(page.getByLabel('Composed video preview')).toHaveJSProperty('width', 1920);
  await expect(page.getByLabel('Composed video preview')).toHaveJSProperty('height', 1080);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all capture' }).click();
});

test('PIP can be moved and resized by pointer without escaping normalized bounds', async ({ page }) => {
  await syntheticSources(page); await page.goto('/');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  const x = page.getByLabel('Webcam horizontal position'); const width = page.getByLabel('Webcam overlay width');
  const beforeX = Number(await x.inputValue());
  const move = page.getByRole('button', { name: 'Move webcam overlay' }); await move.scrollIntoViewIfNeeded(); const moveBox = await move.boundingBox();
  if (!moveBox) throw new Error('Move handle missing');
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down(); await page.mouse.move(moveBox.x + moveBox.width / 2 - 80, moveBox.y + moveBox.height / 2 - 35); await page.mouse.up();
  expect(Number(await x.inputValue())).toBeLessThan(beforeX);
  const beforeWidth = Number(await width.inputValue());
  const resize = page.getByRole('button', { name: 'Resize webcam overlay' }); await resize.scrollIntoViewIfNeeded(); const resizeBox = await resize.boundingBox();
  if (!resizeBox) throw new Error('Resize handle missing');
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down(); await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 60, resizeBox.y + resizeBox.height / 2 + 25); await page.mouse.up();
  expect(Number(await width.inputValue())).toBeGreaterThan(beforeWidth);
  expect(Number(await x.inputValue()) + Number(await width.inputValue())).toBeLessThanOrEqual(100);

  const screenWidth = page.getByLabel('Screen view width');
  const screenX = page.getByLabel('Screen horizontal position');
  expect(Number(await screenWidth.inputValue())).toBe(100);
  const resizeScreen = page.getByRole('button', { name: 'Resize screen view' });
  await resizeScreen.scrollIntoViewIfNeeded();
  const resizeScreenBox = await resizeScreen.boundingBox();
  if (!resizeScreenBox) throw new Error('Screen resize handle missing');
  await page.mouse.move(resizeScreenBox.x + resizeScreenBox.width / 2, resizeScreenBox.y + resizeScreenBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeScreenBox.x + resizeScreenBox.width / 2 - 140, resizeScreenBox.y + resizeScreenBox.height / 2 - 90);
  await page.mouse.up();
  expect(Number(await screenWidth.inputValue())).toBeLessThan(100);

  const moveScreen = page.getByRole('button', { name: 'Move screen view' });
  const moveScreenBox = await moveScreen.boundingBox();
  if (!moveScreenBox) throw new Error('Screen move handle missing');
  await page.mouse.move(moveScreenBox.x + moveScreenBox.width / 2, moveScreenBox.y + moveScreenBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveScreenBox.x + moveScreenBox.width / 2 + 60, moveScreenBox.y + moveScreenBox.height / 2 + 30);
  await page.mouse.up();
  expect(Number(await screenX.inputValue())).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Reset screen view' }).click();
  expect(Number(await screenWidth.inputValue())).toBe(100);
  expect(Number(await screenX.inputValue())).toBe(0);

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
