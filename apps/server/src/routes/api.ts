import { Router } from 'express';
import { createSessionInputSchema, failure, finalizeSessionInputSchema, listSessionsQuerySchema, recoveryHeartbeatInputSchema, sessionIdSchema, success, writeCheckInputSchema } from '../../../../packages/shared/src/index.js';
import { authenticatedRead, bootstrapOnly } from '../security.js';
import { getCapabilities } from '../services/capabilities.js';
import { ChunkIngestionError, parseChunkUploadDeclaration, type ChunkIngestionService } from '../services/chunks.js';
import { createSession, getSession, listSessions } from '../services/sessions.js';
import { FinalizationError, type FinalizationService } from '../services/finalization.js';
import { RecoveryError, type RecoveryService } from '../services/recovery.js';
import type { SessionActivityRegistry } from '../services/session-activity.js';
import type { MetadataStore } from '../storage/database.js';

export function apiRoutes(store: MetadataStore, token: string, chunks?: ChunkIngestionService, finalization?: FinalizationService,
  recovery?: RecoveryService, activity?: SessionActivityRegistry, expectedHost: () => string = () => ''): Router {
  const router = Router();
  router.get('/capabilities', (_req, res) => {
    res.json(success(getCapabilities(store)));
  });
  router.get('/bootstrap', bootstrapOnly, (_req, res) => {
    res.json(success({ writeToken: token }));
  });
  // Exercises the write boundary without creating recordings or modifying user data.
  router.post('/diagnostics/write-check', (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'));
      return;
    }
    if (!writeCheckInputSchema.safeParse(req.body).success) {
      res.status(400).json(failure('INVALID_REQUEST', 'Expected an empty JSON object.'));
      return;
    }
    res.json(success({ authorized: true }));
  });
  router.post('/sessions', (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'));
      return;
    }
    const input = createSessionInputSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json(failure('INVALID_REQUEST', 'Invalid session title or recording configuration.'));
      return;
    }
    res.status(201).json(success(createSession(store, input.data)));
  });
  router.get('/sessions', (req, res) => {
    const query = listSessionsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json(failure('INVALID_REQUEST', 'Invalid session pagination query.'));
      return;
    }
    try {
      res.json(success(listSessions(store, query.data.limit, query.data.cursor)));
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid pagination cursor.') {
        res.status(400).json(failure('INVALID_REQUEST', 'Invalid session pagination cursor.'));
        return;
      }
      throw error;
    }
  });
  if (recovery) {
    const recoveryRead = authenticatedRead(expectedHost, token);
    router.get('/recovery', recoveryRead, async (_req, res, next) => {
      try { res.json(success({ items: await recovery.list() })); } catch (error) { next(error); }
    });
    router.get('/sessions/:id/recovery', recoveryRead, async (req, res, next) => {
      const id = sessionIdSchema.safeParse(req.params.id);
      if (!id.success) { res.status(400).json(failure('INVALID_REQUEST', 'Invalid session ID.')); return; }
      try { res.json(success(await recovery.inspect(id.data))); }
      catch (error) {
        if (error instanceof RecoveryError) { res.status(error.status).json(failure(error.code, error.publicMessage)); return; }
        next(error);
      }
    });
    router.post('/sessions/:id/recovery/salvage', async (req, res, next) => {
      const id = sessionIdSchema.safeParse(req.params.id);
      if (!req.is('application/json')) { res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.')); return; }
      if (!id.success || !recoveryHeartbeatInputSchema.safeParse(req.body).success) {
        res.status(400).json(failure('INVALID_REQUEST', 'Expected a valid session ID and empty JSON object.')); return;
      }
      try { res.json(success(await recovery.salvage(id.data))); }
      catch (error) {
        if (error instanceof RecoveryError || error instanceof FinalizationError) {
          res.status(error.status).json(failure(error.code, error.publicMessage)); return;
        }
        next(error);
      }
    });
  }
  if (activity) {
    router.post('/sessions/:id/heartbeat', (req, res) => {
      const id = sessionIdSchema.safeParse(req.params.id);
      if (!req.is('application/json')) { res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.')); return; }
      if (!id.success || !recoveryHeartbeatInputSchema.safeParse(req.body).success) {
        res.status(400).json(failure('INVALID_REQUEST', 'Expected a valid session ID and empty JSON object.')); return;
      }
      const session = store.findSession(id.data);
      if (!session) { res.status(404).json(failure('NOT_FOUND', 'Session not found.')); return; }
      if (!['idle', 'preview', 'recording', 'paused'].includes(session.status)) {
        res.status(409).json(failure('CONFLICT', 'Session lifecycle cannot be marked active.')); return;
      }
      res.json(success(activity.touch(id.data)));
    });
  }
  router.get('/sessions/:id', (req, res) => {
    const id = sessionIdSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json(failure('INVALID_REQUEST', 'Invalid session ID.'));
      return;
    }
    const session = getSession(store, id.data);
    if (!session) {
      res.status(404).json(failure('NOT_FOUND', 'Session not found.'));
      return;
    }
    res.json(success(session));
  });
  if (finalization) {
    router.post('/sessions/:id/finalize', async (req, res, next) => {
      if (!req.is('application/json')) {
        res.status(415).json(failure('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'));
        return;
      }
      const id = sessionIdSchema.safeParse(req.params.id);
      const input = finalizeSessionInputSchema.safeParse(req.body);
      if (!id.success || !input.success) {
        res.status(400).json(failure('INVALID_REQUEST', 'Invalid session ID or expected chunk count.'));
        return;
      }
      try {
        res.json(success(await finalization.finalize(id.data, input.data.expectedChunkCount)));
      } catch (error) {
        if (error instanceof FinalizationError) {
          res.status(error.status).json(failure(error.code, error.publicMessage));
          return;
        }
        next(error);
      }
    });
  }
  if (chunks) {
    router.put('/sessions/:id/chunks/:seq', async (req, res, next) => {
      try {
        const declaration = parseChunkUploadDeclaration(req);
        res.json(success(await chunks.ingest(req, declaration)));
      } catch (error) {
        if (error instanceof ChunkIngestionError) {
          res.status(error.status).json(failure(error.code, error.publicMessage));
          return;
        }
        next(error);
      }
    });
  }
  return router;
}
