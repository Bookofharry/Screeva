import { z } from 'zod';
import {
  bootstrapSchema,
  capabilitiesSchema,
  exportJobSchema,
  responseSchema,
  sessionListSchema,
  type SessionList,
  type ExportJob,
  writeCheckSchema,
} from '../../../packages/shared/src/index.js';
import { readJsonResponse } from './api-response.js';

async function request<T extends z.ZodType>(url: string, schema: T, init: RequestInit = {}): Promise<z.output<T>> {
  const response = await fetch(url, { ...init, cache: 'no-store', credentials: 'same-origin', signal: init.signal ?? AbortSignal.timeout(10_000) });
  const body = await readJsonResponse(response, 'The local service returned an invalid response.');
  const result = responseSchema(z.unknown()).parse(body);
  if (!result.ok) throw new Error(result.error.message);
  if (!response.ok) throw new Error('The local service returned an unexpected response.');
  return schema.parse(result.data);
}

export function isStaticBrowserHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return Boolean(host) && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1';
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

export async function authorizeExports(signal?: AbortSignal): Promise<string> {
  const result = await request('/api/v1/bootstrap', bootstrapSchema, {
    headers: { 'X-Recorder-Bootstrap': '1' },
    ...(signal ? { signal } : {}),
  });
  return result.writeToken;
}

function exportHeaders(token: string) {
  return { 'Content-Type': 'application/json', 'X-Recorder-Token': token };
}

export function queueExport(sessionId: string, token: string, signal?: AbortSignal): Promise<ExportJob> {
  return request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/exports`, exportJobSchema, {
    method: 'POST', headers: exportHeaders(token), body: '{}', ...(signal ? { signal } : {}),
  });
}

export function loadSessionExport(sessionId: string, token: string, signal?: AbortSignal): Promise<ExportJob> {
  return request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/export`, exportJobSchema, {
    headers: { 'X-Recorder-Token': token }, ...(signal ? { signal } : {}),
  });
}

export function loadExport(jobId: string, token: string, signal?: AbortSignal): Promise<ExportJob> {
  return request(`/api/v1/exports/${encodeURIComponent(jobId)}`, exportJobSchema, {
    headers: { 'X-Recorder-Token': token }, ...(signal ? { signal } : {}),
  });
}

export function cancelExport(jobId: string, token: string, signal?: AbortSignal): Promise<ExportJob> {
  return request(`/api/v1/exports/${encodeURIComponent(jobId)}/cancel`, exportJobSchema, {
    method: 'POST', headers: exportHeaders(token), body: '{}', ...(signal ? { signal } : {}),
  });
}

export function retryExport(jobId: string, token: string, signal?: AbortSignal): Promise<ExportJob> {
  return request(`/api/v1/exports/${encodeURIComponent(jobId)}/retry`, exportJobSchema, {
    method: 'POST', headers: exportHeaders(token), body: '{}', ...(signal ? { signal } : {}),
  });
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
