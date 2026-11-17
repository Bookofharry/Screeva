import { expect, test } from '@playwright/test';

test('foundation status and authenticated check work without external requests or capture', async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4318/')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const forbiddenCapture = () => { throw new Error('Unexpected media capture in foundation'); };
    navigator.mediaDevices.getUserMedia = forbiddenCapture;
    navigator.mediaDevices.getDisplayMedia = forbiddenCapture;
  });
  await page.goto('/');
  await expect(page).toHaveTitle('Screeva — Your Screen. Your Studio.');
  await expect(page.locator('.brand-wordmark')).toHaveText('screeva.');
  await expect(page.locator('.brand-mark')).toBeVisible();
  const faviconCheck = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const href = link?.getAttribute('href') ?? '';
    const response = await fetch(href);
    const body = await response.text();
    return { href, status: response.status, isFocusFrameSvg: body.includes('viewBox="0 0 32 32"') && body.includes('#9B5CFF') && body.includes('#00E5C3') };
  });
  expect(faviconCheck).toEqual({ href: '/icon.svg', status: 200, isFocusFrameSvg: true });
  expect(await page.locator('body').innerText()).not.toContain('Local Creator Recorder');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Studio navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Ready · SQLite')).toBeVisible();
  await expect(page.getByText('Temporary + durable WebM', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready · Local FFmpeg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check local access' }).click();
  await expect(page.getByRole('status', { name: 'Local access check' })).toContainText('Local access verified');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('HTML API fallback is reported offline without exposing a JSON parser error or enabling durable mode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/capabilities', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!DOCTYPE html><title>Static frontend fallback</title>',
  }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Local service status' })).toContainText('Unavailable');
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot reach the local service. Check that the server is running, then retry.' }).first()).toBeVisible();
  await expect(page.locator('.recording-panel')).toContainText('Browser recording');
  expect(errors.some(message => message.includes("Unexpected token '<'"))).toBe(false);
});

test('hosted studio explains browser-only recording without requesting a remote API', async ({ page, request }) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const forbiddenCapture = () => { throw new Error('Unexpected media capture on hosted page'); };
    navigator.mediaDevices.getUserMedia = forbiddenCapture;
    navigator.mediaDevices.getDisplayMedia = forbiddenCapture;
  });
  // Serve the built UI under a hosted origin without contacting a public website.
  await page.route('https://studio.example/**', async route => {
    const url = new URL(route.request().url());
    const response = await request.get(`http://127.0.0.1:4318${url.pathname === '/Screeva/' ? '/' : url.pathname}`);
    await route.fulfill({ response });
  });
  await page.goto('https://studio.example/Screeva/#settings');
  const settings = page.getByRole('region', { name: 'Settings workspace' });
  await expect(page.getByRole('status', { name: 'Local service status' })).toHaveText('Web mode');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
  await expect(settings).toContainText('128 MiB');
  const launch = settings.getByRole('link', { name: 'Open local studio', exact: true });
  await expect(launch).toHaveAttribute('href', 'screeva://open');
  await expect(settings.getByRole('link', { name: 'Get Screeva for Windows or macOS' })).toHaveAttribute('href', 'https://github.com/Bookofharry/Screeva/releases');
  // Simulate declining a native launch prompt without activating an installed app.
  await page.evaluate(() => document.addEventListener('click', event => {
    if ((event.target as Element).closest('a[href="screeva://open"]')) event.preventDefault();
  }));
  await launch.click();
  await expect(settings.getByRole('status', { name: 'Local studio launch help' })).toContainText('may have cancelled');
  await expect(settings).toContainText('Enable Screeva links.cmd');
  await expect(settings.locator('details')).toHaveAttribute('open', '');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/hosted-launcher-setup.png', fullPage: true });
  await settings.getByRole('button', { name: 'Continue in browser' }).click();
  await expect(page.locator('.recording-panel')).toContainText('Browser recording');
  await expect(page.getByRole('button', { name: 'Recordings', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recording options' }).click();
  await expect(page.getByRole('radio', { name: 'Durable local session' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const view of ['recordings', 'recovery']) {
    await page.evaluate(next => { window.location.hash = '#' + next; }, view);
    await expect(page.locator('#view-' + view)).toContainText('Choose how to record');
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await expect(page.getByText('No unfinished server sessions found')).not.toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('same-origin browser can create, list and retrieve persistent session metadata', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const bootstrap = await fetch('/api/v1/bootstrap', { headers: { 'X-Recorder-Bootstrap': '1' } });
    const bootstrapBody = await bootstrap.json() as { ok: boolean; data?: { writeToken?: string } };
    const token = bootstrapBody.data?.writeToken ?? '';
    const createdResponse = await fetch('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': token },
      body: JSON.stringify({
        title: 'Browser session fixture',
        configuration: {
          layout: 'pip', resolution: '720p', fps: 30,
          videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000, audioMode: 'combined',
        },
      }),
    });
    const createdBody = await createdResponse.json() as { ok: boolean; data?: { id?: string; title?: string } };
    const id = createdBody.data?.id ?? '';
    const [listResponse, getResponse] = await Promise.all([
      fetch('/api/v1/sessions?limit=1'),
      fetch(`/api/v1/sessions/${id}`),
    ]);
    const listBody = await listResponse.json() as { ok: boolean; data?: { items?: Array<{ id?: string }> } };
    const getBody = await getResponse.json() as { ok: boolean; data?: { id?: string; title?: string } };
    return {
      bootstrapStatus: bootstrap.status,
      createStatus: createdResponse.status,
      listStatus: listResponse.status,
      getStatus: getResponse.status,
      created: createdBody,
      listedId: listBody.data?.items?.[0]?.id,
      retrieved: getBody,
    };
  });
  expect(result.bootstrapStatus).toBe(200);
  expect(result.createStatus).toBe(201);
  expect(result.listStatus).toBe(200);
  expect(result.getStatus).toBe(200);
  expect(result.created.ok).toBe(true);
  expect(result.created.data?.title).toBe('Browser session fixture');
  expect(result.listedId).toBe(result.created.data?.id);
  expect(result.retrieved.ok).toBe(true);
  expect(result.retrieved.data).toEqual(result.created.data);
});

test('connection failure is visible and retry recovers', async ({ page }) => {
  await page.route('**/api/v1/capabilities', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Cannot reach the local service');
  await expect(page.getByRole('alert')).toContainText('http://127.0.0.1:4317');
  await page.unroute('**/api/v1/capabilities');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
});

test('rejected write check is visible and can be retried', async ({ page }) => {
  await page.goto('/#settings');
  await page.route('**/api/v1/diagnostics/write-check', route => route.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 'v1', ok: false, error: { code: 'UNAUTHORIZED', message: 'Expired authorization.' } }),
  }));
  await page.getByRole('button', { name: 'Check local access' }).click();
  await expect(page.getByRole('status', { name: 'Local access check' })).toContainText('Local access check failed');
  await page.unroute('**/api/v1/diagnostics/write-check');
  await page.getByRole('button', { name: 'Check local access' }).click();
  await expect(page.getByRole('status', { name: 'Local access check' })).toContainText('Local access verified');
});

test('AppShell supports keyboard navigation, browser history, reload, and responsive viewports without overflow', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Studio navigation' });
  await expect(nav).toBeVisible();

  const studioButton = nav.getByRole('button', { name: 'Studio', exact: true });
  const recordingsButton = nav.getByRole('button', { name: /^Recordings/ });
  const guidesButton = nav.getByRole('button', { name: 'Guides', exact: true });
  const settingsButton = nav.getByRole('button', { name: 'Settings', exact: true });

  await studioButton.focus();
  await expect(studioButton).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(recordingsButton).toBeFocused();
  await expect(recordingsButton).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/#recordings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Recorded local sessions.' })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(guidesButton).toBeFocused();
  await expect(guidesButton).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/#guides$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Guides & reference documentation.' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'How Screeva works' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Quick start in 4 steps' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('Local Creator Recorder');

  await page.keyboard.press('End');
  await expect(settingsButton).toBeFocused();
  await expect(settingsButton).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace status and diagnostics.' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/#guides$/);
  await expect(guidesButton).toHaveAttribute('aria-current', 'page');

  await page.goForward();
  await expect(page).toHaveURL(/#settings$/);
  await expect(settingsButton).toHaveAttribute('aria-current', 'page');

  await page.reload();
  await expect(page).toHaveURL(/#settings$/);
  await expect(settingsButton).toHaveAttribute('aria-current', 'page');

  const dropdownStyles = await page.evaluate(() => {
    const selects = [...document.querySelectorAll<HTMLSelectElement>('select')];
    const options = [...document.querySelectorAll<HTMLOptionElement>('select option')];
    return {
      selectCount: selects.length,
      optionCount: options.length,
      allSelectsDarkScheme: selects.every(el => window.getComputedStyle(el).colorScheme === 'dark'),
      allOptionsStyled: options.every(el => {
        const style = window.getComputedStyle(el);
        return style.color !== 'rgb(0, 0, 0)' && style.backgroundColor !== 'rgb(255, 255, 255)';
      }),
    };
  });
  expect(dropdownStyles.selectCount).toBeGreaterThanOrEqual(4);
  expect(dropdownStyles.optionCount).toBeGreaterThanOrEqual(8);
  expect(dropdownStyles.allSelectsDarkScheme).toBe(true);
  expect(dropdownStyles.allOptionsStyled).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionDurations = await page.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    return {
      fast: rootStyle.getPropertyValue('--duration-fast').trim(),
      base: rootStyle.getPropertyValue('--duration-base').trim(),
    };
  });
  expect(reducedMotionDurations.fast).toMatch(/^0(m?s)?$/);
  expect(reducedMotionDurations.base).toMatch(/^0(m?s)?$/);

  await studioButton.click();
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  const shareScreenButton = page.getByRole('button', { name: 'Share screen', exact: true });
  const baseElectricViolet = await page.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    const panelStyle = window.getComputedStyle(document.querySelector<HTMLElement>('.compositor-panel')!);
    const primaryButton = document.querySelector<HTMLButtonElement>('.capture-actions button')!;
    const primaryStyle = window.getComputedStyle(primaryButton);
    const activeNav = document.querySelector<HTMLElement>('.app-nav__item--active')!;
    const activeNavStyle = window.getComputedStyle(activeNav);
    return {
      rootBg: rootStyle.backgroundColor,
      rootText: rootStyle.color,
      panelBg: panelStyle.backgroundColor,
      primaryBg: primaryStyle.backgroundColor,
      primaryText: primaryStyle.color,
      focusOutlineColor: activeNavStyle.outlineColor,
      activeNavBg: activeNavStyle.backgroundColor,
      activeNavColor: activeNavStyle.color,
    };
  });
  expect(baseElectricViolet.rootBg).toBe('rgb(12, 10, 22)');
  expect(baseElectricViolet.rootText).toBe('rgb(246, 242, 255)');
  expect(baseElectricViolet.panelBg).toBe('rgb(25, 21, 41)');
  expect(baseElectricViolet.primaryBg).toBe('rgb(155, 92, 255)');
  expect(baseElectricViolet.primaryText).toBe('rgb(12, 10, 22)');
  expect(baseElectricViolet.focusOutlineColor).toBe('rgb(0, 229, 195)');
  expect(baseElectricViolet.activeNavBg).toBe('rgb(36, 29, 56)');
  expect(baseElectricViolet.activeNavColor).toBe('rgb(183, 154, 255)');

  await shareScreenButton.hover();
  const hoveredPrimaryBg = await shareScreenButton.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(hoveredPrimaryBg).toBe('rgb(183, 154, 255)');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    const metrics = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('header.app-header')!;
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.app-nav__item')];
      window.scrollTo(0, 300);
      const topAfterScroll = Math.round(header.getBoundingClientRect().top);
      window.scrollTo(0, 0);
      return {
        position: window.getComputedStyle(header).position,
        topAfterScroll,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        minNavHeight: Math.min(...buttons.map(button => Math.round(button.getBoundingClientRect().height))),
      };
    });
    expect(metrics.position).toBe('fixed');
    expect(metrics.topAfterScroll).toBe(0);
    expect(metrics.noOverflow, `viewport ${viewport.width}x${viewport.height} should not overflow horizontally`).toBe(true);
    expect(metrics.minNavHeight, `viewport ${viewport.width}x${viewport.height} nav buttons should be >= 44px`).toBeGreaterThanOrEqual(44);

    for (const view of ['studio', 'recordings', 'guides', 'settings', 'recovery']) {
      await page.evaluate(nextView => { window.location.hash = `#${nextView}`; }, view);
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      const noViewOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(noViewOverflow, `${view} at ${viewport.width}x${viewport.height} should not overflow horizontally`).toBe(true);
    }
  }
});
