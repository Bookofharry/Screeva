import { z } from 'zod';
import {
  bootstrapSchema,
  capabilitiesSchema,
  responseSchema,
  sessionListSchema,
  type SessionList,
  writeCheckSchema,
} from '../../../packages/shared/src/index.js';

async function request<T extends z.ZodType>(url: string, schema: T, init: RequestInit = {}): Promise<z.output<T>> {
  const response = await fetch(url, { ...init, cache: 'no-store', credentials: 'same-origin', signal: init.signal ?? AbortSignal.timeout(10_000) });
  const result = responseSchema(z.unknown()).parse(await response.json());
  if (!result.ok) throw new Error(result.error.message);
  if (!response.ok) throw new Error('The local service returned an unexpected response.');
  return schema.parse(result.data);
}

export function loadCapabilities(signal?: AbortSignal) {
  return request('/api/v1/capabilities', capabilitiesSchema, signal ? { signal } : {});
}

export interface LoadSessionsOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export function loadSessions(options: LoadSessionsOptions = {}): Promise<SessionList> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  const url = query ? `/api/v1/sessions?${query}` : '/api/v1/sessions';
  return request(url, sessionListSchema, options.signal ? { signal: options.signal } : {});
}

export async function checkWriteAccess() {
  // Keep the per-launch credential in memory for this request, never browser storage.
  const { writeToken } = await request('/api/v1/bootstrap', bootstrapSchema, { headers: { 'X-Recorder-Bootstrap': '1' } });
  return request('/api/v1/diagnostics/write-check', writeCheckSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': writeToken },
    body: '{}',
  });
}
