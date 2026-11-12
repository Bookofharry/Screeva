import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { startServer } from './server.js';

// Both source and emitted entrypoints locate the checkout without depending on cwd.
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const projectRoot = path.basename(sourceRoot.replace(/[\\/]$/, '')) === 'dist' ? path.dirname(sourceRoot.replace(/[\\/]$/, '')) : sourceRoot;
const portText = process.env.PORT ?? '4317';
const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
const clientDirectory = path.join(projectRoot, 'apps/client/dist');

try {
  if (!existsSync(path.join(clientDirectory, 'index.html'))) throw new Error('Client build missing. Run npm run build first.');
  const running = await startServer({ port, dataDirectory: path.join(projectRoot, 'data'), clientDirectory });
  console.log(`Local Creator Recorder: ${running.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  }
} catch (error) {
  // Never log requests, headers, tokens, or media paths.
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'STARTUP_FAILED';
  console.error(`Local Creator Recorder could not start (${code}). Check Node version, build, port, and data-folder permissions. Existing data was retained.`);
  process.exitCode = 1;
}
