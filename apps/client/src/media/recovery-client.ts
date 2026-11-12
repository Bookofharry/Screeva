import {
  bootstrapSchema,
  errorEnvelopeSchema,
  finalizedRecordingSchema,
  recoveryListSchema,
  responseSchema,
  type FinalizedRecording,
  type RecoveryInspection,
} from '../../../../packages/shared/src/index.js';

export interface RecoveryClientRuntime { fetch(input: string, init: RequestInit): Promise<Response> }

function errorMessage(value: unknown, fallback: string): string {
  const parsed = errorEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.error.message : fallback;
}

export class RecoveryClient {
  private token = '';
  private readonly runtime: RecoveryClientRuntime;

  constructor(runtime: RecoveryClientRuntime = { fetch: (input, init) => globalThis.fetch(input, init) }) {
    this.runtime = runtime;
  }

  async list(): Promise<RecoveryInspection[]> {
    const token = await this.authorize();
    const response = await this.runtime.fetch('/api/v1/recovery', {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'X-Recorder-Token': token },
    });
    const body = await response.json() as unknown;
    const parsed = responseSchema(recoveryListSchema).safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error(errorMessage(body, 'Recovery sessions could not be inspected.'));
    return parsed.data.data.items;
  }

  async salvage(sessionId: string): Promise<FinalizedRecording> {
    const token = await this.authorize();
    const response = await this.runtime.fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/recovery/salvage`, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': token }, body: '{}',
    });
    const body = await response.json() as unknown;
    const parsed = responseSchema(finalizedRecordingSchema).safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error(errorMessage(body, 'Best-effort salvage failed.'));
    return parsed.data.data;
  }

  private async authorize(): Promise<string> {
    if (this.token) return this.token;
    const response = await this.runtime.fetch('/api/v1/bootstrap', {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', headers: { 'X-Recorder-Bootstrap': '1' },
    });
    const body = await response.json() as unknown;
    const parsed = responseSchema(bootstrapSchema).safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error(errorMessage(body, 'Reload the application to authorize recovery.'));
    this.token = parsed.data.data.writeToken;
    return this.token;
  }
}
