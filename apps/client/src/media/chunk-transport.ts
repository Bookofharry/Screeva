import {
  durableChunkAckSchema,
  errorEnvelopeSchema,
  responseSchema,
  sessionIdSchema,
  writeTokenSchema,
  type DurableChunkAck,
} from '../../../../packages/shared/src/index.js';
import {
  RecordingChunkPipeline,
  type ChunkPipelineOptions,
  type QueuedRecordingChunk,
} from './chunk-pipeline.js';

export type ChunkTransportStatus = 'idle' | 'uploading' | 'retrying' | 'failed' | 'disposed';
export type BackpressureReason = 'high-water' | 'capacity-exceeded' | 'transport-failed';

export interface ChunkTransportSnapshot {
  readonly status: ChunkTransportStatus;
  readonly queuedItems: number;
  readonly outstandingBytes: number;
  readonly pendingItems: number;
  readonly pendingBytes: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly attempts: number;
  readonly totalAttempts: number;
  readonly acknowledgedChunks: number;
  readonly activeSequence: number | null;
  readonly retryDelayMs: number;
  readonly backpressured: boolean;
  readonly error: string;
}

export interface BackpressureSignal {
  readonly reason: BackpressureReason;
  readonly snapshot: ChunkTransportSnapshot;
}

export interface ChunkTransportOptions {
  readonly sessionId: string;
  readonly writeToken: string;
  readonly queue?: ChunkPipelineOptions;
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly jitterRatio?: number;
  readonly highWaterItems?: number;
  readonly highWaterBytes?: number;
  readonly onBackpressure?: (signal: BackpressureSignal) => void;
}

export interface ChunkTransportRuntime {
  fetch(input: string, init: RequestInit): Promise<Response>;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(handle: number): void;
  random(): number;
}

const browserRuntime: ChunkTransportRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimer: handle => window.clearTimeout(handle),
  random: () => Math.random(),
};

class UploadFailure extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function safeErrorMessage(value: unknown, fallback: string): string {
  const parsed = errorEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.error.message : fallback;
}

/**
 * Sends one immutable queue head at a time. It owns only its queue, requests,
 * retry timers and retained Blobs; it never receives or stops media tracks.
 */
export class RecordingChunkTransport {
  readonly sessionId: string;
  private readonly writeToken: string;
  private readonly pipeline: RecordingChunkPipeline;
  private readonly runtime: ChunkTransportRuntime;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly jitterRatio: number;
  private readonly highWaterItems: number;
  private readonly highWaterBytes: number;
  private readonly onBackpressure: ((signal: BackpressureSignal) => void) | undefined;
  private readonly listeners = new Set<(snapshot: ChunkTransportSnapshot) => void>();
  private status: ChunkTransportStatus = 'idle';
  private attempts = 0;
  private totalAttempts = 0;
  private acknowledgedChunks = 0;
  private activeSequence: number | null = null;
  private retryDelayMs = 0;
  private error = '';
  private backpressured = false;
  private backpressureSignalled = false;
  private started = false;
  private disposed = false;
  private generation = 0;
  private pumpPromise: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private retryTimer: number | null = null;
  private retryResolve: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;
  private readonly drainWaiters = new Set<{ resolve: (count: number) => void; reject: (error: Error) => void }>();

  constructor(options: ChunkTransportOptions, runtime: ChunkTransportRuntime = browserRuntime) {
    this.sessionId = sessionIdSchema.parse(options.sessionId);
    this.writeToken = writeTokenSchema.parse(options.writeToken);
    this.pipeline = new RecordingChunkPipeline(this.sessionId, options.queue);
    this.runtime = runtime;
    this.maxAttempts = positiveSafeInteger(options.maxAttempts ?? 5, 'Maximum upload attempts');
    this.requestTimeoutMs = positiveSafeInteger(options.requestTimeoutMs ?? 10_000, 'Upload timeout');
    this.baseRetryDelayMs = positiveSafeInteger(options.baseRetryDelayMs ?? 250, 'Base retry delay');
    this.maxRetryDelayMs = positiveSafeInteger(options.maxRetryDelayMs ?? 5_000, 'Maximum retry delay');
    if (this.maxRetryDelayMs < this.baseRetryDelayMs) throw new Error('Maximum retry delay must not be below the base retry delay.');
    this.jitterRatio = options.jitterRatio ?? 0.2;
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) throw new Error('Retry jitter ratio must be between zero and one.');
    const queue = this.pipeline.getSnapshot();
    this.highWaterItems = positiveSafeInteger(options.highWaterItems ?? Math.max(1, Math.ceil(queue.maxItems * 0.8)), 'Item high-water mark');
    this.highWaterBytes = positiveSafeInteger(options.highWaterBytes ?? Math.max(1, Math.ceil(queue.maxBytes * 0.8)), 'Byte high-water mark');
    if (this.highWaterItems > queue.maxItems || this.highWaterBytes > queue.maxBytes) throw new Error('Backpressure high-water marks must fit within queue capacity.');
    this.onBackpressure = options.onBackpressure;
  }

  subscribe(listener: (snapshot: ChunkTransportSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ChunkTransportSnapshot {
    const queue = this.pipeline.getSnapshot();
    return {
      status: this.status,
      queuedItems: queue.queuedItems,
      outstandingBytes: queue.queuedBytes + queue.pendingBytes,
      pendingItems: queue.pendingItems,
      pendingBytes: queue.pendingBytes,
      maxItems: queue.maxItems,
      maxBytes: queue.maxBytes,
      attempts: this.attempts,
      totalAttempts: this.totalAttempts,
      acknowledgedChunks: this.acknowledgedChunks,
      activeSequence: this.activeSequence,
      retryDelayMs: this.retryDelayMs,
      backpressured: this.backpressured,
      error: this.error,
    };
  }

  start(): boolean {
    if (this.disposed || this.started || this.status === 'failed') return false;
    this.started = true;
    this.ensurePump();
    return true;
  }

  async enqueue(blob: Blob): Promise<QueuedRecordingChunk> {
    if (this.disposed) throw new Error('Chunk transport is disposed.');
    if (this.status === 'failed') throw new Error('Chunk transport has failed and cannot accept more chunks.');
    let operation: Promise<QueuedRecordingChunk>;
    try {
      operation = this.pipeline.enqueue(blob);
    } catch (error) {
      this.refreshBackpressure();
      this.handleEnqueueFailure(error);
      this.publish();
      throw error;
    }
    this.refreshBackpressure();
    this.publish();
    try {
      const item = await operation;
      if (this.disposed) throw new Error('Chunk transport is disposed.');
      this.refreshBackpressure();
      this.publish();
      if (this.started) this.ensurePump();
      return item;
    } catch (error) {
      this.refreshBackpressure();
      this.handleEnqueueFailure(error);
      this.publish();
      throw error;
    }
  }

  drain(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('Chunk transport is disposed.'));
    if (this.status === 'failed') return Promise.reject(new Error(this.error || 'Chunk transport failed.'));
    this.start();
    const snapshot = this.getSnapshot();
    if (snapshot.queuedItems === 0 && snapshot.pendingItems === 0 && !this.pumpPromise) {
      return Promise.resolve(snapshot.acknowledgedChunks);
    }
    return new Promise<number>((resolve, reject) => {
      this.drainWaiters.add({ resolve, reject });
      this.checkDrainWaiters();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.disposed = true;
      this.started = false;
      this.generation++;
      this.activeController?.abort();
      this.activeController = null;
      this.cancelRetryTimer();
      this.status = 'disposed';
      this.activeSequence = null;
      this.retryDelayMs = 0;
      this.publish();
      this.rejectDrainWaiters(new Error('Chunk transport was disposed before uploads drained.'));
      await this.pipeline.dispose();
      await this.pumpPromise;
      this.listeners.clear();
    })();
    return this.disposePromise;
  }

  private ensurePump(): void {
    if (!this.started || this.disposed || this.status === 'failed' || this.pumpPromise) return;
    const generation = this.generation;
    this.pumpPromise = this.pump(generation).finally(() => {
      this.pumpPromise = null;
      if (generation === this.generation && this.started && !this.disposed && this.status !== 'failed' && this.pipeline.peek()) this.ensurePump();
    });
  }

  private async pump(generation: number): Promise<void> {
    for (;;) {
      if (!this.isCurrent(generation)) return;
      const item = this.pipeline.peek();
      if (!item) {
        this.status = 'idle';
        this.attempts = 0;
        this.activeSequence = null;
        this.retryDelayMs = 0;
        this.error = '';
        this.refreshBackpressure();
        this.publish();
        return;
      }
      this.activeSequence = item.metadata.sequence;
      this.attempts = 0;
      for (;;) {
        if (!this.isCurrent(generation)) return;
        this.attempts++;
        this.totalAttempts++;
        this.status = 'uploading';
        this.retryDelayMs = 0;
        this.error = '';
        this.publish();
        try {
          const ack = await this.upload(item, generation);
          if (!this.isCurrent(generation)) return;
          if (this.pipeline.peek() !== item) throw new UploadFailure('Chunk queue changed while an upload was active.', false);
          try { this.pipeline.acknowledge(ack); }
          catch { throw new UploadFailure('The local service returned a conflicting durable ACK.', false); }
          this.acknowledgedChunks++;
          this.attempts = 0;
          this.activeSequence = null;
          this.error = '';
          this.refreshBackpressure();
          this.publish();
          break;
        } catch (error) {
          if (!this.isCurrent(generation)) return;
          const failure = error instanceof UploadFailure
            ? error
            : new UploadFailure('The local service could not be reached.', true);
          if (!failure.transient || this.attempts >= this.maxAttempts) {
            this.fail(failure.transient ? `Chunk upload failed after ${this.attempts} attempts.` : failure.message);
            return;
          }
          const delay = this.retryDelay(this.attempts);
          this.status = 'retrying';
          this.retryDelayMs = delay;
          this.error = failure.message;
          this.publish();
          await this.waitForRetry(delay);
        }
      }
    }
  }

  private async upload(item: QueuedRecordingChunk, generation: number): Promise<DurableChunkAck> {
    const controller = new AbortController();
    this.activeController = controller;
    let timedOut = false;
    const timeout = this.runtime.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const metadata = item.metadata;
      let response: Response;
      try {
        response = await this.runtime.fetch(`/api/v1/sessions/${metadata.sessionId}/chunks/${metadata.sequence}`, {
          method: 'PUT',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': metadata.mimeType,
            'X-Recorder-Token': this.writeToken,
            'X-Recorder-Chunk-SHA256': metadata.sha256,
            'X-Recorder-Chunk-Timestamp': metadata.timestamp,
          },
          body: item.blob,
          signal: controller.signal,
        });
      } catch {
        if (!this.isCurrent(generation)) throw new UploadFailure('Chunk upload was cancelled.', false);
        throw new UploadFailure(timedOut ? 'Chunk upload timed out.' : 'The local service could not be reached.', true);
      }
      if (timedOut) throw new UploadFailure('Chunk upload timed out.', true);
      let body: unknown;
      try { body = await response.json(); }
      catch {
        throw new UploadFailure(response.ok ? 'The local service returned an invalid durable ACK.' : 'The local service returned an invalid error response.', transientStatus(response.status));
      }
      if (timedOut) throw new UploadFailure('Chunk upload timed out.', true);
      if (!response.ok) {
        throw new UploadFailure(safeErrorMessage(body, `Chunk upload failed with HTTP ${response.status}.`), transientStatus(response.status));
      }
      const parsed = responseSchema(durableChunkAckSchema).safeParse(body);
      if (!parsed.success || !parsed.data.ok) throw new UploadFailure('The local service returned an invalid durable ACK.', false);
      return parsed.data.data;
    } finally {
      this.runtime.clearTimer(timeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private retryDelay(failedAttempts: number): number {
    const exponential = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** Math.max(0, failedAttempts - 1)));
    const random = Math.min(1, Math.max(0, this.runtime.random()));
    const factor = 1 + ((random * 2) - 1) * this.jitterRatio;
    return Math.min(this.maxRetryDelayMs, Math.max(0, Math.round(exponential * factor)));
  }

  private waitForRetry(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      this.retryResolve = resolve;
      this.retryTimer = this.runtime.setTimer(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, milliseconds);
    });
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== null) this.runtime.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const resolve = this.retryResolve;
    this.retryResolve = null;
    resolve?.();
  }

  private refreshBackpressure(): void {
    const queue = this.pipeline.getSnapshot();
    const active = queue.queuedItems + queue.pendingItems >= this.highWaterItems || queue.queuedBytes + queue.pendingBytes >= this.highWaterBytes;
    this.backpressured = active;
    if (!active) this.backpressureSignalled = false;
    if (active && !this.backpressureSignalled) {
      this.backpressureSignalled = true;
      this.signalBackpressure('high-water');
    }
  }

  private handleEnqueueFailure(error: unknown): void {
    if (!(error instanceof Error) || !/capacity exceeded/.test(error.message)) return;
    this.backpressured = true;
    this.error = error.message;
    this.signalBackpressure('capacity-exceeded');
  }

  private fail(message: string): void {
    this.status = 'failed';
    this.error = message;
    this.retryDelayMs = 0;
    this.backpressured = true;
    this.publish();
    this.rejectDrainWaiters(new Error(message));
    this.signalBackpressure('transport-failed');
  }

  private signalBackpressure(reason: BackpressureReason): void {
    if (!this.onBackpressure) return;
    try { this.onBackpressure({ reason, snapshot: this.getSnapshot() }); }
    catch { /* a future recorder callback must not break transport cleanup */ }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.disposed;
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers do not own transport lifecycle */ }
    }
    this.checkDrainWaiters();
  }

  private checkDrainWaiters(): void {
    if (!this.drainWaiters.size || this.disposed || this.status === 'failed') return;
    const queue = this.pipeline.getSnapshot();
    if (queue.queuedItems !== 0 || queue.pendingItems !== 0 || this.activeSequence !== null) return;
    for (const waiter of this.drainWaiters) waiter.resolve(this.acknowledgedChunks);
    this.drainWaiters.clear();
  }

  private rejectDrainWaiters(error: Error): void {
    for (const waiter of this.drainWaiters) waiter.reject(error);
    this.drainWaiters.clear();
  }
}
