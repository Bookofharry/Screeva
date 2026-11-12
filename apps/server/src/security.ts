import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { failure, writeTokenSchema } from '../../../packages/shared/src/index.js';

export function createWriteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function localOnly(expectedHost: () => string): RequestHandler {
  return (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    });
    const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'host').length;
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    if (hostCount !== 1 || req.get('host') !== expectedHost() ||
        (origin !== undefined && origin !== `http://${expectedHost()}`) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      res.status(403).json(failure('FORBIDDEN', 'Only the local application origin is allowed.'));
      return;
    }
    next();
  };
}

export function authenticatedWrites(expectedHost: () => string, token: string): RequestHandler {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    if (req.get('origin') !== `http://${expectedHost()}` || req.get('sec-fetch-site') !== 'same-origin') {
      res.status(403).json(failure('FORBIDDEN', 'Writes require a same-origin browser request.'));
      return;
    }
    const candidate = writeTokenSchema.safeParse(req.get('x-recorder-token'));
    if (!candidate.success || !timingSafeEqual(Buffer.from(candidate.data), Buffer.from(token))) {
      res.status(401).json(failure('UNAUTHORIZED', 'Reload the application to authorize this request.'));
      return;
    }
    next();
  };
}

export function authenticatedRead(expectedHost: () => string, token: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if ((origin !== undefined && origin !== `http://${expectedHost()}`) || req.get('sec-fetch-site') !== 'same-origin') {
      res.status(403).json(failure('FORBIDDEN', 'Recovery inspection requires the local application origin.'));
      return;
    }
    const candidate = writeTokenSchema.safeParse(req.get('x-recorder-token'));
    if (!candidate.success || !timingSafeEqual(Buffer.from(candidate.data), Buffer.from(token))) {
      res.status(401).json(failure('UNAUTHORIZED', 'Reload the application to authorize this request.'));
      return;
    }
    next();
  };
}

export const bootstrapOnly: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' || req.get('sec-fetch-site') !== 'same-origin' || req.get('x-recorder-bootstrap') !== '1') {
    res.status(403).json(failure('FORBIDDEN', 'Open the local application to initialize authorization.'));
    return;
  }
  next();
};
