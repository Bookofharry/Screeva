import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import {
  RecordingChunkPipeline,
  type ChunkPipelineRuntime,
  type QueuedRecordingChunk,
} from '../apps/client/src/media/chunk-pipeline.js';
import { durableChunkAckSchema, recordingChunkMetadataSchema, type DurableChunkAck } from '../packages/shared/src/index.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const MIME = 'video/webm;codecs=vp9,opus';

function ack(item: QueuedRecordingChunk, patch: Partial<DurableChunkAck> = {}): DurableChunkAck {
  return {
    schemaVersion: 1,
    sessionId: item.metadata.sessionId,
    sequence: item.metadata.sequence,
    byteLength: item.metadata.byteLength,
    sha256: item.metadata.sha256,
    committed: true,
    committedAt: '2026-11-11T12:00:00.000Z',
    ...patch,
  };
}

test('assigns ordered metadata and hashes exact raw Blob bytes with Web Crypto', async () => {
  const pipeline = new RecordingChunkPipeline(SESSION_ID, {}, { digest: bytes => webcrypto.subtle.digest('SHA-256', bytes), now: () => new Date('2026-11-11T10:00:00.000Z') });
  const first = await pipeline.enqueue(new Blob(['abc'], { type: MIME }));
  const second = await pipeline.enqueue(new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'video/webm' }));
  assert.equal(first.metadata.sequence, 0);
  assert.equal(second.metadata.sequence, 1);
  assert.equal(first.metadata.byteLength, 3);
  assert.equal(first.metadata.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(second.metadata.sha256, '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56');
  assert.equal(first.metadata.timestamp, '2026-11-11T10:00:00.000Z');
  assert.equal(first.metadata.mimeType, MIME);
  assert.equal(recordingChunkMetadataSchema.safeParse(first.metadata).success, true);
  assert.deepEqual(pipeline.getSnapshot(), {
    queuedItems: 2, queuedBytes: 7, pendingItems: 0, pendingBytes: 0,
    maxItems: 64, maxBytes: 32 * 1024 * 1024, nextSequence: 2, disposed: false,
  });
});

test('serializes concurrent hashing so completion and sequences preserve enqueue-call order', async () => {
  const starts: string[] = [];
  const runtime: ChunkPipelineRuntime = {
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    digest: async bytes => {
      const value = new TextDecoder().decode(bytes);
      starts.push(value);
      if (value === 'first') await new Promise(resolve => setTimeout(resolve, 20));
      return webcrypto.subtle.digest('SHA-256', bytes);
    },
  };
  const pipeline = new RecordingChunkPipeline(SESSION_ID, {}, runtime);
  const firstPromise = pipeline.enqueue(new Blob(['first'], { type: 'video/webm' }));
  const secondPromise = pipeline.enqueue(new Blob(['second'], { type: 'video/webm' }));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(starts, ['first', 'second']);
  assert.deepEqual([first.metadata.sequence, second.metadata.sequence], [0, 1]);
  assert.equal(pipeline.peek(), first);
});

test('bounds pending plus queued items and bytes without consuming sequence numbers on rejection', async () => {
  const pipeline = new RecordingChunkPipeline(SESSION_ID, { maxItems: 2, maxBytes: 5 });
  const first = await pipeline.enqueue(new Blob(['123'], { type: 'video/webm' }));
  await assert.rejects(pipeline.enqueue(new Blob(['456'], { type: 'video/webm' })), /byte capacity/);
  const second = await pipeline.enqueue(new Blob(['45'], { type: 'video/webm' }));
  await assert.rejects(pipeline.enqueue(new Blob(['x'], { type: 'video/webm' })), /item capacity/);
  assert.deepEqual([first.metadata.sequence, second.metadata.sequence], [0, 1]);
  assert.equal(pipeline.getSnapshot().queuedBytes, 5);
  assert.equal(pipeline.getSnapshot().nextSequence, 2);

  let releaseDigest: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseDigest = resolve; });
  const pendingPipeline = new RecordingChunkPipeline(SESSION_ID, { maxItems: 1, maxBytes: 3 }, {
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    digest: async bytes => { await gate; return webcrypto.subtle.digest('SHA-256', bytes); },
  });
  const pending = pendingPipeline.enqueue(new Blob(['12'], { type: 'video/webm' }));
  await assert.rejects(pendingPipeline.enqueue(new Blob(['3'], { type: 'video/webm' })), /item capacity/);
  assert.deepEqual(pendingPipeline.getSnapshot(), {
    queuedItems: 0, queuedBytes: 0, pendingItems: 1, pendingBytes: 2,
    maxItems: 1, maxBytes: 3, nextSequence: 0, disposed: false,
  });
  releaseDigest?.();
  await pending;
});

test('releases a failed hash reservation and assigns the next successful chunk sequence zero', async () => {
  let attempts = 0;
  const pipeline = new RecordingChunkPipeline(SESSION_ID, { maxItems: 1, maxBytes: 4 }, {
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    digest: async bytes => {
      attempts++;
      if (attempts === 1) throw new Error('synthetic digest failure');
      return webcrypto.subtle.digest('SHA-256', bytes);
    },
  });
  await assert.rejects(pipeline.enqueue(new Blob(['bad'], { type: 'video/webm' })), /synthetic digest failure/);
  assert.equal(pipeline.getSnapshot().pendingItems, 0);
  assert.equal(pipeline.getSnapshot().pendingBytes, 0);
  const recovered = await pipeline.enqueue(new Blob(['good'], { type: 'video/webm' }));
  assert.equal(recovered.metadata.sequence, 0);
});

test('peek preserves retry identity and ACKs are ordered, idempotent and conflict checked', async () => {
  const pipeline = new RecordingChunkPipeline(SESSION_ID);
  const first = await pipeline.enqueue(new Blob(['first'], { type: 'video/webm' }));
  const second = await pipeline.enqueue(new Blob(['second'], { type: 'video/webm' }));
  assert.equal(pipeline.peek(), first);
  assert.equal(pipeline.peek(), first);
  assert.throws(() => pipeline.acknowledge(ack(second)), /out of order/);
  assert.throws(() => pipeline.acknowledge(ack(first, { sha256: '0'.repeat(64) })), /conflicts/);
  const firstAck = ack(first);
  assert.equal(pipeline.acknowledge(firstAck), true);
  assert.equal(pipeline.peek(), second);
  assert.equal(pipeline.acknowledge(firstAck), false);
  assert.throws(() => pipeline.acknowledge(ack(first, { byteLength: first.metadata.byteLength + 1 })), /Conflicting duplicate/);
  assert.equal(pipeline.acknowledge(ack(second)), true);
  assert.equal(pipeline.peek(), null);
  assert.equal(pipeline.getSnapshot().queuedBytes, 0);
});

test('reset cancels late hashes, releases queued blobs and never reuses assigned identities', async () => {
  let releaseDigest: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseDigest = resolve; });
  const runtime: ChunkPipelineRuntime = {
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    digest: async bytes => { await gate; return webcrypto.subtle.digest('SHA-256', bytes); },
  };
  const pipeline = new RecordingChunkPipeline(SESSION_ID, {}, runtime);
  const pending = pipeline.enqueue(new Blob(['late'], { type: 'video/webm' }));
  const reset = pipeline.reset();
  releaseDigest?.();
  await assert.rejects(pending, /cancelled by queue reset/);
  await reset;
  assert.equal(pipeline.peek(), null);
  assert.equal(pipeline.getSnapshot().pendingItems, 0);
  const item = await pipeline.enqueue(new Blob(['kept'], { type: 'video/webm' }));
  assert.equal(item.metadata.sequence, 0);
  await pipeline.reset();
  assert.equal(pipeline.peek(), null);
  const afterReset = await pipeline.enqueue(new Blob(['next'], { type: 'video/webm' }));
  assert.equal(afterReset.metadata.sequence, 1);
});

test('dispose cancels pending work, releases references and rejects further operations', async () => {
  let releaseDigest: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseDigest = resolve; });
  const pipeline = new RecordingChunkPipeline(SESSION_ID, {}, {
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    digest: async bytes => { await gate; return webcrypto.subtle.digest('SHA-256', bytes); },
  });
  const pending = pipeline.enqueue(new Blob(['pending'], { type: 'video/webm' }));
  const dispose = pipeline.dispose();
  releaseDigest?.();
  await assert.rejects(pending, /disposed/);
  await dispose;
  assert.equal(pipeline.peek(), null);
  assert.equal(pipeline.getSnapshot().disposed, true);
  await assert.rejects(pipeline.enqueue(new Blob(['later'], { type: 'video/webm' })), /disposed/);
  assert.throws(() => pipeline.acknowledge({} as DurableChunkAck));
});

test('rejects invalid construction, blobs, MIME types, metadata and ACK contracts', async () => {
  assert.throws(() => new RecordingChunkPipeline('not-a-session'), /Invalid/);
  assert.throws(() => new RecordingChunkPipeline(SESSION_ID, { maxItems: 0 }), /item capacity/);
  assert.throws(() => new RecordingChunkPipeline(SESSION_ID, { maxBytes: Number.NaN }), /byte capacity/);
  const pipeline = new RecordingChunkPipeline(SESSION_ID);
  await assert.rejects(pipeline.enqueue(new Blob([], { type: 'video/webm' })), /contain bytes/);
  await assert.rejects(pipeline.enqueue(new Blob(['x'])), /valid MIME/);
  await assert.rejects(pipeline.enqueue(new Blob(['x'], { type: 'not valid' })), /valid MIME/);
  assert.equal(recordingChunkMetadataSchema.safeParse({}).success, false);
  assert.equal(durableChunkAckSchema.safeParse({ schemaVersion: 1, sessionId: SESSION_ID, sequence: 0, byteLength: 1, sha256: 'A'.repeat(64), committed: true, committedAt: 'bad' }).success, false);
  assert.throws(() => pipeline.acknowledge({ schemaVersion: 1, sessionId: SESSION_ID, sequence: 0, byteLength: 1, sha256: '0'.repeat(64), committed: true, committedAt: '2026-11-11T12:00:00.000Z', extra: true } as DurableChunkAck));
});
