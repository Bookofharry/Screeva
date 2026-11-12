import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/acceptance',
  fullyParallel: false,
  workers: 1,
  timeout: 420_000,
  reporter: 'list',
  outputDir: 'test-results/five-minute-recording',
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-precise-memory-info'],
    },
  },
  webServer: {
    command: 'node --import tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:4318/api/v1/capabilities',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
