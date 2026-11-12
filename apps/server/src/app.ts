import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { failure } from '../../../packages/shared/src/index.js';
import { apiRoutes } from './routes/api.js';
import { authenticatedWrites, createWriteToken, localOnly } from './security.js';
import type { ChunkIngestionService } from './services/chunks.js';
import type { FinalizationService } from './services/finalization.js';
import type { RecoveryService } from './services/recovery.js';
import type { SessionActivityRegistry } from './services/session-activity.js';
import type { MetadataStore } from './storage/database.js';

export interface AppOptions {
  expectedHost: () => string;
  store: MetadataStore;
  chunks?: ChunkIngestionService;
  finalization?: FinalizationService;
  recovery?: RecoveryService;
  activity?: SessionActivityRegistry;
  clientDirectory?: string;
}

export function createApp(options: AppOptions) {
  const app = express();
  const token = createWriteToken();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.use(localOnly(options.expectedHost));
  app.use(authenticatedWrites(options.expectedHost, token));
  const jsonParser = express.json({
    limit: '16kb', strict: true, inflate: false,
    verify: (_req, _res, buffer) => { if (buffer.length === 0) throw new Error('JSON body is required.'); },
  });
  app.use('/api', (req, res, next) => {
    // Keep the chunk endpoint a raw stream even when a caller declares the
    // wrong media type; its route must reject that declaration before parsing.
    if (req.method === 'PUT' && /^\/v1\/sessions\/[^/]+\/chunks\/[^/]+$/.test(req.path)) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });
  app.use('/api/v1', apiRoutes(options.store, token, options.chunks, options.finalization, options.recovery, options.activity, options.expectedHost));
  if (options.clientDirectory) {
    app.use(express.static(path.resolve(options.clientDirectory), { dotfiles: 'deny', etag: false, lastModified: false, redirect: false }));
  }
  app.use((_req, res) => res.status(404).json(failure('NOT_FOUND', 'Route not found.')));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const type = error instanceof Error && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') {
      res.status(413).json(failure('PAYLOAD_TOO_LARGE', 'Request exceeds the 16 KiB limit.'));
    } else if (type === 'entity.parse.failed' || type === 'entity.verify.failed' || type === 'request.size.invalid' || error instanceof URIError) {
      res.status(400).json(failure('INVALID_REQUEST', 'Malformed request.'));
    } else if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding.'));
    } else {
      res.status(500).json(failure('INTERNAL_ERROR', 'The local service could not complete the request.'));
    }
  };
  app.use(errorHandler);
  return app;
}
