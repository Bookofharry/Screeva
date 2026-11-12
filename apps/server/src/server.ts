import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createChunkIngestionService } from './services/chunks.js';
import { createFinalizationService } from './services/finalization.js';
import { SessionOperationLock } from './services/session-operation-lock.js';
import { SessionActivityRegistry } from './services/session-activity.js';
import { createRecoveryService } from './services/recovery.js';
import { createFFprobeAdapter, type FFprobeAdapter } from './media/ffprobe.js';
import { openMetadata } from './storage/database.js';

export interface ServerOptions {
  port: number;
  dataDirectory: string;
  clientDirectory?: string;
  ffprobe?: FFprobeAdapter;
}

export async function startServer(options: ServerOptions) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port.');
  const store = await openMetadata(options.dataDirectory);
  const locks = new SessionOperationLock();
  const activity = new SessionActivityRegistry();
  const chunks = createChunkIngestionService(store, options.dataDirectory, {}, locks);
  const finalization = createFinalizationService(store, options.dataDirectory, options.ffprobe ?? createFFprobeAdapter(), {}, locks);
  const recovery = createRecoveryService(store, options.dataDirectory, finalization, locks, activity);
  try {
    await chunks.reconcile();
    await finalization.reconcile();
    await recovery.reconcile();
  } catch (error) {
    store.close();
    throw error;
  }
  let host = '';
  const app = createApp({ store, chunks, finalization, recovery, activity, expectedHost: () => host, ...(options.clientDirectory ? { clientDirectory: options.clientDirectory } : {}) });
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, app);
  server.maxRequestsPerSocket = 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No listening address.')); return; }
        host = `127.0.0.1:${address.port}`;
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    origin: `http://${host}`,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          store.close();
          if (error) reject(error); else resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
