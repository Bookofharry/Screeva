import {
  bootstrapSchema,
  createSessionInputSchema,
  errorEnvelopeSchema,
  finalizedRecordingSchema,
  recoveryHeartbeatSchema,
  recordingSessionSchema,
  responseSchema,
  type FinalizedRecording,
  type RecordingConfiguration,
} from '../../../../packages/shared/src/index.js';
import { RecordingChunkTransport, type BackpressureSignal, type ChunkTransportSnapshot } from './chunk-transport.js';
import { RecordingEngine, initialRecordingSnapshot, type RecordingSnapshot, type RecordingStatus } from './recording-engine.js';

export type DurableRecordingStatus = 'idle' | 'creating' | 'recording' | 'paused' | 'stopping' | 'uploading' | 'retrying' | 'finalizing' | 'completed' | 'failed';

export interface DurableRecordingSnapshot {
  readonly status: DurableRecordingStatus;
  readonly recorderStatus: RecordingStatus;
  readonly sessionId: string;
  readonly durationMs: number;
  readonly mimeType: string;
  readonly hasAudio: boolean;
  readonly encodedBytes: number;
  readonly outstandingBytes: number;
  readonly queuedChunks: number;
  readonly acknowledgedChunks: number;
  readonly uploadAttempts: number;
  readonly error: string;
  readonly output: FinalizedRecording | null;
}

interface DurableTransport {
  start(): boolean;
  enqueue(blob: Blob): Promise<unknown>;
  drain(): Promise<number>;
  getSnapshot(): ChunkTransportSnapshot;
  subscribe(listener: (snapshot: ChunkTransportSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

export interface DurableRecordingRuntime {
  fetch(input: string, init: RequestInit): Promise<Response>;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(handle: number): void;
}

export interface DurableRecordingOptions {
  readonly engine?: RecordingEngine;
  readonly runtime?: DurableRecordingRuntime;
  readonly backpressureGraceMs?: number;
  readonly createTransport?: (sessionId: string, writeToken: string, onBackpressure: (signal: BackpressureSignal) => void) => DurableTransport;
}

const browserRuntime: DurableRecordingRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimer: handle => window.clearTimeout(handle),
};

const emptyTransportSnapshot: ChunkTransportSnapshot = {
  status: 'idle', queuedItems: 0, outstandingBytes: 0, pendingItems: 0, pendingBytes: 0,
  maxItems: 64, maxBytes: 32 * 1024 * 1024, attempts: 0, totalAttempts: 0,
  acknowledgedChunks: 0, activeSequence: null, retryDelayMs: 0, backpressured: false, error: '',
};

export function initialDurableRecordingSnapshot(): DurableRecordingSnapshot {
  return {
    status: 'idle', recorderStatus: 'idle', sessionId: '', durationMs: 0, mimeType: '', hasAudio: false,
    encodedBytes: 0, outstandingBytes: 0, queuedChunks: 0, acknowledgedChunks: 0,
    uploadAttempts: 0, error: '', output: null,
  };
}

function messageFromErrorBody(value: unknown, fallback: string): string {
  const parsed = errorEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.error.message : fallback;
}

/** Owns durable session/network state, never capture/compositor/mixer tracks. */
export class DurableRecordingEngine {
  private readonly engine: RecordingEngine;
  private readonly runtime: DurableRecordingRuntime;
  private readonly backpressureGraceMs: number;
  private readonly createTransport: NonNullable<DurableRecordingOptions['createTransport']>;
  private readonly listeners = new Set<(snapshot: DurableRecordingSnapshot) => void>();
  private recorderState: RecordingSnapshot;
  private transportState = emptyTransportSnapshot;
  private transport: DurableTransport | null = null;
  private transportUnsubscribe: (() => void) | null = null;
  private phase: 'idle' | 'creating' | 'active' | 'draining' | 'finalizing' | 'completed' | 'failed' = 'idle';
  private sessionId = '';
  private writeToken = '';
  private error = '';
  private output: FinalizedRecording | null = null;
  private pendingEnqueues = new Set<Promise<void>>();
  private backpressureTimer: number | null = null;
  private readonly delayTimers = new Map<number, () => void>();
  private generation = 0;
  private disposed = false;
  private activeController: AbortController | null = null;
  private heartbeatController: AbortController | null = null;
  private heartbeatTimer: number | null = null;

  constructor(options: DurableRecordingOptions = {}) {
    this.engine = options.engine ?? new RecordingEngine();
    this.runtime = options.runtime ?? browserRuntime;
    this.backpressureGraceMs = options.backpressureGraceMs ?? 2_000;
    if (!Number.isSafeInteger(this.backpressureGraceMs) || this.backpressureGraceMs <= 0) throw new Error('Backpressure grace must be a positive safe integer.');
    this.createTransport = options.createTransport ?? ((sessionId, writeToken, onBackpressure) => new RecordingChunkTransport({ sessionId, writeToken, onBackpressure }));
    this.recorderState = initialRecordingSnapshot();
    this.engine.subscribe(state => {
      this.recorderState = state;
      this.publish();
    });
  }

  subscribe(listener: (snapshot: DurableRecordingSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): DurableRecordingSnapshot {
    return {
      status: this.visibleStatus(),
      recorderStatus: this.recorderState.status,
      sessionId: this.sessionId,
      durationMs: this.recorderState.durationMs,
      mimeType: this.recorderState.mimeType,
      hasAudio: this.recorderState.hasAudio,
      encodedBytes: this.recorderState.bytes,
      outstandingBytes: this.transportState.outstandingBytes,
      queuedChunks: this.transportState.queuedItems + this.transportState.pendingItems,
      acknowledgedChunks: this.transportState.acknowledgedChunks,
      uploadAttempts: this.transportState.totalAttempts,
      error: this.error,
      output: this.output,
    };
  }

  async start(video: MediaStream | null, audio: MediaStream | null, title: string, configuration: RecordingConfiguration): Promise<boolean> {
    if (this.disposed || !['idle', 'completed', 'failed'].includes(this.phase)) return false;
    const generation = ++this.generation;
    this.phase = 'creating';
    this.sessionId = '';
    this.writeToken = '';
    this.error = '';
    this.output = null;
    this.transportState = emptyTransportSnapshot;
    this.pendingEnqueues.clear();
    this.publish();
    await this.releaseTransport();
    if (!this.isCurrent(generation)) return false;
    this.engine.reset();
    const input = createSessionInputSchema.safeParse({ title, configuration });
    if (!input.success) return this.fail('Recording title or configuration is invalid.');
    try {
      const bootstrapResponse = await this.request('/api/v1/bootstrap', {
        method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        headers: { 'X-Recorder-Bootstrap': '1' },
      });
      const bootstrapBody = await bootstrapResponse.json() as unknown;
      const bootstrap = responseSchema(bootstrapSchema).safeParse(bootstrapBody);
      if (!bootstrapResponse.ok || !bootstrap.success || !bootstrap.data.ok) throw new Error(messageFromErrorBody(bootstrapBody, 'The local service did not authorize durable recording.'));
      if (!this.isCurrent(generation)) return false;
      this.writeToken = bootstrap.data.data.writeToken;
      const sessionResponse = await this.request('/api/v1/sessions', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': this.writeToken },
        body: JSON.stringify(input.data),
      });
      const sessionBody = await sessionResponse.json() as unknown;
      const session = responseSchema(recordingSessionSchema).safeParse(sessionBody);
      if (!sessionResponse.ok || !session.success || !session.data.ok) throw new Error(messageFromErrorBody(sessionBody, 'The durable recording session could not be created.'));
      if (!this.isCurrent(generation)) return false;
      this.sessionId = session.data.data.id;
      await this.sendHeartbeat(generation);
      if (!this.isCurrent(generation)) return false;
      this.scheduleHeartbeat(generation);
      this.transport = this.createTransport(this.sessionId, this.writeToken, signal => this.onBackpressure(signal));
      this.transportUnsubscribe = this.transport.subscribe(state => this.onTransportState(state));
      this.transport.start();
      this.phase = 'active';
      const started = this.engine.startStreaming(video, audio, {
        onChunk: blob => this.acceptChunk(blob, generation),
        onComplete: () => { void this.finish(generation); },
        onFailure: message => { this.fail(message); },
      });
      if (!started) return this.fail(this.engine.getSnapshot().error || 'The browser recorder could not start.');
      this.publish();
      return true;
    } catch (error) {
      if (!this.isCurrent(generation)) return false;
      return this.fail(error instanceof Error ? error.message : 'The durable recording session could not start.');
    }
  }

  pause(): boolean { return this.phase === 'active' && this.engine.pause(); }
  resume(): boolean { return this.phase === 'active' && this.engine.resume(); }
  stop(): boolean { return this.phase === 'active' && this.engine.stop(); }

  async reset(): Promise<boolean> {
    if (this.disposed || ['creating', 'active', 'draining', 'finalizing'].includes(this.phase)) return false;
    ++this.generation;
    this.clearBackpressureTimer();
    this.clearHeartbeat();
    this.clearDelayTimers();
    await this.releaseTransport();
    this.engine.reset();
    this.phase = 'idle';
    this.sessionId = '';
    this.writeToken = '';
    this.error = '';
    this.output = null;
    this.transportState = emptyTransportSnapshot;
    this.pendingEnqueues.clear();
    this.publish();
    return true;
  }

  private acceptChunk(blob: Blob, generation: number): void {
    const transport = this.transport;
    if (!transport || !this.isCurrent(generation) || this.phase !== 'active') return;
    const task: Promise<void> = transport.enqueue(blob).then(() => undefined).catch(error => {
      if (this.isCurrent(generation)) {
        const message = error instanceof Error ? error.message : 'The durable chunk queue rejected encoded data.';
        this.fail(message);
        this.engine.abort(message);
      }
    }).finally(() => {
      this.pendingEnqueues.delete(task);
    });
    this.pendingEnqueues.add(task);
  }

  private async finish(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.phase !== 'active') return;
    this.phase = 'draining';
    this.clearHeartbeat();
    this.publish();
    await Promise.all([...this.pendingEnqueues]);
    if (!this.isCurrent(generation) || this.hasFailed()) return;
    const transport = this.transport;
    if (!transport) { this.fail('The durable upload transport is unavailable.'); return; }
    try {
      const expectedChunkCount = await transport.drain();
      if (!this.isCurrent(generation) || this.hasFailed()) return;
      if (expectedChunkCount <= 0) { this.fail('No encoded chunks were durably acknowledged.'); return; }
      this.phase = 'finalizing';
      this.publish();
      const output = await this.finalizeWithRetry(expectedChunkCount, generation);
      if (!this.isCurrent(generation) || this.hasFailed()) return;
      this.output = output;
      this.phase = 'completed';
      this.error = '';
      this.publish();
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error instanceof Error ? error.message : 'The recording could not be finalized.');
    }
  }

  private async finalizeWithRetry(expectedChunkCount: number, generation: number): Promise<FinalizedRecording> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response;
      try {
        response = await this.request(`/api/v1/sessions/${this.sessionId}/finalize`, {
          method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': this.writeToken },
          body: JSON.stringify({ expectedChunkCount }),
        });
      } catch {
        if (attempt >= 3) throw new Error('The local service could not be reached to finalize the recording.');
        await this.delay(250 * (2 ** (attempt - 1)), generation);
        continue;
      }
      let body: unknown;
      try { body = await response.json() as unknown; }
      catch { throw new Error('The local service returned an invalid finalization response.'); }
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        if (transient && attempt < 3) { await this.delay(250 * (2 ** (attempt - 1)), generation); continue; }
        throw new Error(messageFromErrorBody(body, `Finalization failed with HTTP ${response.status}.`));
      }
      const parsed = responseSchema(finalizedRecordingSchema).safeParse(body);
      if (!parsed.success || !parsed.data.ok || parsed.data.data.sessionId !== this.sessionId || parsed.data.data.expectedChunkCount !== expectedChunkCount) {
        throw new Error('The local service returned invalid finalization metadata.');
      }
      return parsed.data.data;
    }
    throw new Error('Finalization failed after three attempts.');
  }

  private delay(milliseconds: number, generation: number): Promise<void> {
    return new Promise(resolve => {
      let timer = 0;
      const finish = () => { this.delayTimers.delete(timer); resolve(); };
      timer = this.runtime.setTimer(finish, milliseconds);
      this.delayTimers.set(timer, finish);
      if (!this.isCurrent(generation)) { this.runtime.clearTimer(timer); finish(); }
    });
  }

  private onTransportState(state: ChunkTransportSnapshot): void {
    this.transportState = state;
    if (!state.backpressured) this.clearBackpressureTimer();
    if (state.status === 'failed' && this.phase === 'active') {
      this.fail(state.error || 'Durable chunk upload failed.');
      this.engine.abort(state.error || 'Durable chunk upload failed.');
    }
    this.publish();
  }

  private onBackpressure(signal: BackpressureSignal): void {
    if (this.phase !== 'active') return;
    if (signal.reason !== 'high-water') {
      const message = signal.reason === 'capacity-exceeded'
        ? 'The durable upload queue reached its memory limit.'
        : signal.snapshot.error || 'Durable chunk delivery failed.';
      this.fail(message);
      this.engine.abort(message);
      return;
    }
    if (this.backpressureTimer !== null) return;
    this.backpressureTimer = this.runtime.setTimer(() => {
      this.backpressureTimer = null;
      if (this.phase === 'active' && this.transport?.getSnapshot().backpressured) {
        const message = 'Chunk uploads remained backpressured, so recording stopped before browser memory became unsafe.';
        this.fail(message);
        this.engine.abort(message);
      }
    }, this.backpressureGraceMs);
  }

  private visibleStatus(): DurableRecordingStatus {
    if (this.phase === 'idle') return 'idle';
    if (this.phase === 'creating') return 'creating';
    if (this.phase === 'completed') return 'completed';
    if (this.phase === 'failed') return 'failed';
    if (this.phase === 'finalizing') return 'finalizing';
    if (this.transportState.status === 'retrying') return 'retrying';
    if (this.transportState.status === 'uploading' || this.phase === 'draining') return 'uploading';
    if (this.recorderState.status === 'paused') return 'paused';
    if (this.recorderState.status === 'stopping') return 'stopping';
    return 'recording';
  }

  private fail(message: string): false {
    if (this.phase === 'completed' || this.phase === 'failed') return false;
    this.phase = 'failed';
    this.error = message || 'Durable recording failed.';
    this.clearBackpressureTimer();
    this.clearHeartbeat();
    this.publish();
    return false;
  }

  private clearBackpressureTimer(): void {
    if (this.backpressureTimer !== null) this.runtime.clearTimer(this.backpressureTimer);
    this.backpressureTimer = null;
  }

  private clearDelayTimers(): void {
    for (const [timer, resolve] of this.delayTimers) { this.runtime.clearTimer(timer); resolve(); }
    this.delayTimers.clear();
  }

  private async sendHeartbeat(generation: number, allowBusy = false): Promise<void> {
    const controller = new AbortController();
    this.heartbeatController?.abort();
    this.heartbeatController = controller;
    try {
      const response = await this.runtime.fetch(`/api/v1/sessions/${this.sessionId}/heartbeat`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-Recorder-Token': this.writeToken }, body: '{}', signal: controller.signal,
      });
      const body = await response.json() as unknown;
      const busy = errorEnvelopeSchema.safeParse(body);
      if (allowBusy && response.status === 409 && busy.success && busy.data.error.code === 'CONFLICT') return;
      const parsed = responseSchema(recoveryHeartbeatSchema).safeParse(body);
      if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error(messageFromErrorBody(body, 'The local service could not maintain the recording activity lease.'));
    } finally {
      if (this.heartbeatController === controller) this.heartbeatController = null;
      if (!this.isCurrent(generation)) controller.abort();
    }
  }

  private scheduleHeartbeat(generation: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = this.runtime.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(generation) || this.phase !== 'active') return;
      void this.sendHeartbeat(generation, true).then(() => {
        if (this.isCurrent(generation) && this.phase === 'active') this.scheduleHeartbeat(generation);
      }).catch(error => {
        if (!this.isCurrent(generation) || this.phase !== 'active') return;
        const message = error instanceof Error ? error.message : 'The recording activity lease failed.';
        this.fail(message);
        this.engine.abort(message);
      });
    }, 3_000);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) this.runtime.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.heartbeatController?.abort();
    this.heartbeatController = null;
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.activeController = controller;
    let timedOut = false;
    const timer = this.runtime.setTimer(() => { timedOut = true; controller.abort(); }, 10_000);
    try {
      return await this.runtime.fetch(input, { ...init, signal: controller.signal });
    } catch {
      throw new Error(timedOut ? 'The local service request timed out.' : 'The local service could not be reached.');
    } finally {
      this.runtime.clearTimer(timer);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private async releaseTransport(): Promise<void> {
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.dispose();
  }

  private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private hasFailed(): boolean { return this.phase === 'failed'; }

  private publish(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers do not own lifecycle */ }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.activeController?.abort();
    this.activeController = null;
    this.clearBackpressureTimer();
    this.clearHeartbeat();
    this.clearDelayTimers();
    this.engine.dispose();
    await this.releaseTransport();
    this.pendingEnqueues.clear();
    this.listeners.clear();
  }
}
