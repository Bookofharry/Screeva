import { expect, test } from '@playwright/test';

// Test-only picker automation selects this isolated, generated tab by exact title.
// Never auto-select the user's desktop or a real application window.
const fixtureTitle = 'Recorder synthetic display fixture';
// Full Chromium's new headless mode supports tab capture; headless-shell does not.
test.use({ channel: 'chromium', launchOptions: { args: [`--auto-select-tab-capture-source-by-title=${fixtureTitle}`] } });

test('native getDisplayMedia captures a generated tab and delivers sustained preview frames', async ({ page, context }, testInfo) => {
  const fixture = await context.newPage();
  await fixture.route('**/synthetic-display-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>${fixtureTitle}</title><style>body{margin:0;background:rgb(32,76,113);color:white;font:24px sans-serif}h1{padding:50px}div{width:70px;height:70px;background:white;animation:move 2s infinite alternate}@keyframes move{to{transform:translateX(400px)}}</style></head><body><h1>Synthetic display fixture</h1><div></div></body></html>` }));
  await fixture.goto('/synthetic-display-fixture');
  await page.addInitScript(() => {
    const native = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = []; Object.assign(window, { nativeDisplays: streams });
    navigator.mediaDevices.getDisplayMedia = async options => {
      try { const stream = await native(options); streams.push(stream); return stream; }
      catch (error) { console.error('Native synthetic-tab capture:', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'); throw error; }
    };
  });
  page.on('console', message => { if (message.type() === 'error') console.log(message.text()); });
  await page.goto('/'); await page.bringToFront();
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Screen capture status' })).toContainText('Active', { timeout: 15000 });
  const video = page.getByLabel('Screen preview', { exact: true });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth > 0 && node.readyState >= 2 && node.muted)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Screen actual track settings' })).toContainText('Source: browser');
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  const initial = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 10000 }).toBeGreaterThan(initial + 3);
  // Assert the decoded image is our generated blue tab, not a blank preview.
  const pixel = await video.evaluate((node: HTMLVideoElement) => {
    const canvas = document.createElement('canvas'); canvas.width = node.videoWidth; canvas.height = node.videoHeight;
    const drawing = canvas.getContext('2d')!; drawing.drawImage(node, 0, 0);
    return Array.from(drawing.getImageData(10, 10, 1, 1).data);
  });
  expect(pixel[2]).toBeGreaterThan(90); expect(pixel[0]).toBeLessThan(60);
  await video.screenshot({ path: testInfo.outputPath('synthetic-display-preview.png') });
  await page.getByRole('button', { name: 'Stop display', exact: true }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.srcObject === null)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { nativeDisplays: MediaStream[] }).nativeDisplays.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await fixture.close();
});
