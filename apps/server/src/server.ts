import { createServer, type RequestListener } from 'node:http';
import { createApp } from './app.js';
import { createChunkIngestionService } from './services/chunks.js';
import { createFinalizationService } from './services/finalization.js';
import { SessionOperationLock } from './services/session-operation-lock.js';
import { SessionActivityRegistry } from './services/session-activity.js';
import { createRecoveryService } from './services/recovery.js';
import { createFFprobeAdapter, type FFprobeAdapter } from './media/ffprobe.js';
import { createFFmpegAdapter, type FFmpegAdapter } from './media/ffmpeg.js';
import { openMetadata } from './storage/database.js';
import { createExportService } from './services/exports.js';

export interface ServerOptions {
  port: number;
  dataDirectory: string;
  clientDirectory?: string;
  ffprobe?: FFprobeAdapter;
  ffmpeg?: FFmpegAdapter;
}

export async function startServer(options: ServerOptions) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port.');
  let host = '';
  // Claim the port before opening or reconciling storage. A duplicate launcher
  // must not mutate a live recorder's data before discovering the port collision.
  let handler: RequestListener = (_request, response) => {
    response.writeHead(503, { 'Cache-Control': 'no-store', 'Connection': 'close' });
    response.end();
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => handler(request, response));
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
    server.close();
    throw error;
  }
  const store = await openMetadata(options.dataDirectory).catch(error => {
    server.close();
    server.closeAllConnections();
    throw error;
  });
  try {
    const locks = new SessionOperationLock();
    const activity = new SessionActivityRegistry();
    const chunks = createChunkIngestionService(store, options.dataDirectory, {}, locks);
    const finalization = createFinalizationService(store, options.dataDirectory, options.ffprobe ?? createFFprobeAdapter(), {}, locks);
    const recovery = createRecoveryService(store, options.dataDirectory, finalization, locks, activity);
    const exportService = createExportService(store, options.dataDirectory, options.ffmpeg ?? createFFmpegAdapter());
    await chunks.reconcile();
    await finalization.reconcile();
    await recovery.reconcile();
    await exportService.reconcile();
    handler = createApp({ store, chunks, finalization, recovery, exports: exportService, activity, locks, expectedHost: () => host, ...(options.clientDirectory ? { clientDirectory: options.clientDirectory } : {}) });
    let closing: Promise<void> | undefined;
    return {
      server,
      exportService,
      origin: `http://${host}`,
      close(): Promise<void> {
        closing ??= (async () => {
          let closeError: Error | undefined;
          await new Promise<void>(resolve => {
            server.close(error => {
              if (error) closeError = error;
              resolve();
            });
            server.closeAllConnections();
          });
          try { await exportService.close(); }
          finally { store.close(); }
          if (closeError) throw closeError;
        })();
        return closing;
      },
    };
  } catch (error) {
    store.close();
    server.close();
    server.closeAllConnections();
    throw error;
  }
}
