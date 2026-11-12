import {
  chunkMimeTypeSchema,
  durableChunkAckSchema,
  isoTimestampSchema,
  recordingChunkMetadataSchema,
  sessionIdSchema,
  type DurableChunkAck,
  type RecordingChunkMetadata,
} from '../../../../packages/shared/src/index.js';

export const DEFAULT_CHUNK_QUEUE_MAX_ITEMS = 64;
export const DEFAULT_CHUNK_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

export interface QueuedRecordingChunk {
  readonly metadata: Readonly<RecordingChunkMetadata>;
  readonly blob: Blob;
}

export interface ChunkQueueSnapshot {
  readonly queuedItems: number;
  readonly queuedBytes: number;
  readonly pendingItems: number;
  readonly pendingBytes: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly nextSequence: number;
  readonly disposed: boolean;
}

export interface ChunkPipelineOptions {
  maxItems?: number;
  maxBytes?: number;
}

export interface ChunkPipelineRuntime {
  digest(bytes: ArrayBuffer): Promise<ArrayBuffer>;
  now(): Date;
}

const browserRuntime: ChunkPipelineRuntime = {
  digest: bytes => crypto.subtle.digest('SHA-256', bytes),
  now: () => new Date(),
};

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function sameAckIdentity(left: Pick<DurableChunkAck, 'sessionId' | 'sequence' | 'byteLength' | 'sha256'>,
  right: Pick<DurableChunkAck, 'sessionId' | 'sequence' | 'byteLength' | 'sha256'>): boolean {
  return left.sessionId === right.sessionId && left.sequence === right.sequence &&
    left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

/**
 * Holds unhashed/hash-verified MediaRecorder blobs in memory for a future uploader.
 * It does not request media, mutate tracks, perform network I/O, or claim durability.
 */
export class RecordingChunkPipeline {
  readonly sessionId: string;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly runtime: ChunkPipelineRuntime;
  private queue: QueuedRecordingChunk[] = [];
  private queuedBytes = 0;
  private pendingItems = 0;
  private pendingBytes = 0;
  private nextSequence = 0;
  private generation = 0;
  private disposed = false;
  private hashTail: Promise<void> = Promise.resolve();
  private lastAcknowledged: DurableChunkAck | null = null;

  constructor(sessionId: string, options: ChunkPipelineOptions = {}, runtime: ChunkPipelineRuntime = browserRuntime) {
    this.sessionId = sessionIdSchema.parse(sessionId);
    this.maxItems = positiveSafeInteger(options.maxItems ?? DEFAULT_CHUNK_QUEUE_MAX_ITEMS, 'Chunk queue item capacity');
    this.maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_CHUNK_QUEUE_MAX_BYTES, 'Chunk queue byte capacity');
    this.runtime = runtime;
  }

  getSnapshot(): ChunkQueueSnapshot {
    return {
      queuedItems: this.queue.length,
      queuedBytes: this.queuedBytes,
      pendingItems: this.pendingItems,
      pendingBytes: this.pendingBytes,
      maxItems: this.maxItems,
      maxBytes: this.maxBytes,
      nextSequence: this.nextSequence,
      disposed: this.disposed,
    };
  }

  peek(): QueuedRecordingChunk | null {
    return this.queue[0] ?? null;
  }

  enqueue(blob: Blob): Promise<QueuedRecordingChunk> {
    if (this.disposed) return Promise.reject(new Error('Chunk pipeline is disposed.'));
    if (!(blob instanceof Blob)) return Promise.reject(new Error('Chunk must be a Blob.'));
    if (!Number.isSafeInteger(blob.size) || blob.size <= 0) return Promise.reject(new Error('Chunk Blob must contain bytes.'));
    const mimeType = chunkMimeTypeSchema.safeParse(blob.type);
    if (!mimeType.success) return Promise.reject(new Error('Chunk Blob must have a valid MIME type.'));
    if (this.queue.length + this.pendingItems >= this.maxItems) return Promise.reject(new Error('Chunk queue item capacity exceeded.'));
    if (this.queuedBytes + this.pendingBytes + blob.size > this.maxBytes) return Promise.reject(new Error('Chunk queue byte capacity exceeded.'));

    const timestamp = this.runtime.now().toISOString();
    if (!isoTimestampSchema.safeParse(timestamp).success) return Promise.reject(new Error('Chunk timestamp is invalid.'));
    const generation = this.generation;
    this.pendingItems++;
    this.pendingBytes += blob.size;
    const operation = this.hashTail.then(async () => {
      const checksum = hex(await this.runtime.digest(await blob.arrayBuffer()));
      if (this.disposed) throw new Error('Chunk pipeline is disposed.');
      if (generation !== this.generation) throw new Error('Chunk enqueue was cancelled by queue reset.');
      const metadata = Object.freeze(recordingChunkMetadataSchema.parse({
        schemaVersion: 1,
        sessionId: this.sessionId,
        sequence: this.nextSequence,
        byteLength: blob.size,
        sha256: checksum,
        timestamp,
        mimeType: mimeType.data,
      }));
      const item = Object.freeze({ metadata, blob });
      this.nextSequence++;
      this.queue.push(item);
      this.queuedBytes += blob.size;
      return item;
    }).finally(() => {
      this.pendingItems--;
      this.pendingBytes -= blob.size;
    });
    this.hashTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  acknowledge(candidate: DurableChunkAck): boolean {
    if (this.disposed) throw new Error('Chunk pipeline is disposed.');
    const ack = durableChunkAckSchema.parse(candidate);
    if (ack.sessionId !== this.sessionId) throw new Error('ACK belongs to a different session.');
    if (this.lastAcknowledged && ack.sequence === this.lastAcknowledged.sequence) {
      if (!sameAckIdentity(ack, this.lastAcknowledged)) throw new Error('Conflicting duplicate ACK.');
      return false;
    }
    if (this.lastAcknowledged && ack.sequence < this.lastAcknowledged.sequence) throw new Error('Stale ACK sequence.');
    const head = this.peek();
    if (!head) throw new Error('ACK does not match a queued chunk.');
    if (ack.sequence !== head.metadata.sequence) throw new Error('ACK sequence is out of order.');
    if (ack.byteLength !== head.metadata.byteLength || ack.sha256 !== head.metadata.sha256) throw new Error('ACK conflicts with queued chunk metadata.');
    this.queue.shift();
    this.queuedBytes -= head.metadata.byteLength;
    this.lastAcknowledged = ack;
    return true;
  }

  async reset(): Promise<void> {
    if (this.disposed) return;
    this.generation++;
    this.queue = [];
    this.queuedBytes = 0;
    await this.hashTail;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.hashTail;
    this.disposed = true;
    this.generation++;
    this.queue = [];
    this.queuedBytes = 0;
    this.lastAcknowledged = null;
    await this.hashTail;
  }
}
