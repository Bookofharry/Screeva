import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../apps/server/src/server.js';

const sandbox = await mkdtemp(path.join(tmpdir(), 'recorder-e2e-'));
const running = await startServer({
  port: 4318,
  dataDirectory: path.join(sandbox, 'data'),
  clientDirectory: path.resolve('apps/client/dist'),
  // Test-only probe boundary: exercises real browser WebM chunking, ingestion,
  // concatenation and completion without claiming external FFprobe acceptance.
  ffprobe: { probe: async () => ({ formatName: 'matroska,webm', durationMs: null, video: { codec: 'synthetic-test-probe', width: 1280, height: 720 }, audio: null }) },
});
console.log(`E2E server: ${running.origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void running.close().then(() => rm(sandbox, { recursive: true, force: true })).then(() => process.exit(0));
});
