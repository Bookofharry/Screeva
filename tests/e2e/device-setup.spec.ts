import { expect, test, type Page } from '@playwright/test';

// Synthetic inputs only; this test file never opens the machine's real devices.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

async function mockDevices(page: Page, mode: 'success' | 'denied' | 'pending' | 'unknown' = 'success') {
  await page.addInitScript(({ mode }) => {
    const handles = { camera: Object.assign(new EventTarget(), { state: 'prompt' }), microphone: Object.assign(new EventTarget(), { state: 'prompt' }) };
    Object.defineProperty(navigator.permissions, 'query', { configurable: true, value: async ({ name }: { name: 'camera' | 'microphone' }) => {
      if (mode === 'unknown') throw new TypeError('unsupported');
      return handles[name];
    } });
    let devices = [
      { kind: 'videoinput', deviceId: 'camera-a', label: 'Studio camera' },
      { kind: 'videoinput', deviceId: 'camera-b', label: '' },
      { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk microphone' },
    ];
    let failList = false;
    const requests: MediaStreamConstraints[] = [];
    let stops = 0;
    let complete: (() => void) | undefined;
    const media = navigator.mediaDevices;
    media.enumerateDevices = async () => {
      if (failList) throw new Error('device query failed');
      return devices as MediaDeviceInfo[];
    };
    media.getDisplayMedia = async () => { throw new Error('Unexpected screen capture'); };
    media.getUserMedia = async constraints => {
      requests.push(constraints ?? {});
      if (mode === 'denied') throw new DOMException('denied', 'NotAllowedError');
      if (mode === 'pending') await new Promise<void>(resolve => { complete = resolve; });
      const kind = constraints?.video ? 'video' : 'audio';
      const handle = handles[kind === 'video' ? 'camera' : 'microphone'];
      handle.state = 'granted'; handle.dispatchEvent(new Event('change'));
      return { getTracks: () => [{ kind, readyState: 'live', stop: () => { stops++; } }] } as unknown as MediaStream;
    };
    Object.assign(window, { setupTest: {
      requests, getStops: () => stops, complete: () => complete?.(),
      removeCamera: () => { devices = devices.filter(device => device.kind !== 'videoinput'); media.dispatchEvent(new Event('devicechange')); },
      failList: () => { failList = true; }, repairList: () => { failList = false; },
      revoke: () => { handles.camera.state = 'denied'; handles.camera.dispatchEvent(new Event('change')); },
    } });
  }, { mode });
}

declare global {
  interface Window {
    setupTest: {
      requests: MediaStreamConstraints[]; getStops(): number; complete(): void;
      removeCamera(): void; failList(): void; repairList(): void; revoke(): void;
    };
  }
}

test('selects devices without capture, checks one input on click, releases it and responds to permission changes', async ({ page }) => {
  await mockDevices(page); await page.goto('/#settings');
  await expect(page.getByLabel('Camera device')).toContainText('Camera 2 (name hidden)');
  await page.getByLabel('Camera device').selectOption('camera-a');
  await page.getByLabel('Microphone device').selectOption('mic-a');
  expect(await page.evaluate(() => window.setupTest.requests)).toEqual([]);
  await page.getByRole('button', { name: 'Check camera access' }).click();
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('Access check passed');
  expect(await page.evaluate(() => window.setupTest.requests)).toEqual([{ video: { deviceId: { exact: 'camera-a' } }, audio: false }]);
  expect(await page.evaluate(() => window.setupTest.getStops())).toBe(1);
  await page.getByRole('button', { name: 'Check microphone access' }).click();
  await expect(page.getByRole('status', { name: 'Microphone check', exact: true })).toContainText('Access check passed');
  expect(await page.evaluate(() => window.setupTest.getStops())).toBe(2);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.evaluate(() => window.setupTest.revoke());
  await expect(page.getByRole('status', { name: 'Camera permission' })).toContainText('Blocked');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('denied access explains settings and leaves retry available', async ({ page }) => {
  await mockDevices(page, 'denied'); await page.goto('/#settings');
  await page.getByRole('button', { name: 'Check camera access' }).click();
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('Access was not allowed');
  await expect(page.getByRole('button', { name: 'Check camera access' })).toBeEnabled();
});

test('cancels a pending browser response and releases its late stream', async ({ page }) => {
  await mockDevices(page, 'pending'); await page.goto('/#settings');
  await page.getByRole('button', { name: 'Check camera access' }).click();
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('Waiting for the browser');
  await page.getByRole('button', { name: 'Cancel access check' }).click();
  await expect(page.getByRole('button', { name: 'Check microphone access' })).toBeDisabled();
  await page.evaluate(() => window.setupTest.complete());
  await expect(page.getByRole('button', { name: 'Check microphone access' })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('cancelled');
  expect(await page.evaluate(() => window.setupTest.getStops())).toBe(1);
});

test('device disconnect and enumeration failure are visible and refresh can recover', async ({ page }) => {
  await mockDevices(page); await page.goto('/#settings');
  await page.getByLabel('Camera device').selectOption('camera-a');
  await page.evaluate(() => window.setupTest.removeCamera());
  await expect(page.getByLabel('Camera device')).toHaveValue('');
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('no longer listed');
  await page.evaluate(() => window.setupTest.failList());
  await page.getByRole('button', { name: 'Refresh devices' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not refresh devices');
  await page.evaluate(() => window.setupTest.repairList());
  await page.getByRole('button', { name: 'Refresh devices' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unsupported Permissions API queries still offer an explicit access check', async ({ page }) => {
  await mockDevices(page, 'unknown'); await page.goto('/#settings');
  await expect(page.getByRole('status', { name: 'Camera permission' })).toContainText('Status unavailable');
  await page.getByRole('button', { name: 'Check camera access' }).click();
  await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('Access check passed');
});

test('missing browser media APIs show guidance and disable checks', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }));
  await page.goto('/#settings');
  await expect(page.getByRole('alert')).toContainText('Media access is unavailable');
  await expect(page.getByRole('button', { name: 'Check camera access' })).toBeDisabled();
});

test.describe('real browser media API with synthetic devices', () => {
  test('same-origin policy permits user-triggered checks and both input tracks end', async ({ page }) => {
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const tracks: MediaStreamTrack[] = [];
      Object.assign(window, { checkedTracks: tracks });
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints); tracks.push(...stream.getTracks()); return stream;
      };
    });
    await page.goto('/#settings');
    await page.getByRole('button', { name: 'Check camera access' }).click();
    await expect(page.getByRole('status', { name: 'Camera check', exact: true })).toContainText('Access check passed');
    await page.getByRole('button', { name: 'Check microphone access' }).click();
    await expect(page.getByRole('status', { name: 'Microphone check', exact: true })).toContainText('Access check passed');
    expect(await page.evaluate(() => (window as unknown as { checkedTracks: MediaStreamTrack[] }).checkedTracks.map(track => track.readyState))).toEqual(['ended', 'ended']);
  });
});
