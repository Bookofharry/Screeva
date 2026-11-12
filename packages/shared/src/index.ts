import { z } from 'zod';

export const API_VERSION = 'v1' as const;
export const sessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const writeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const errorCodeSchema = z.enum(['FORBIDDEN', 'UNAUTHORIZED', 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const capabilitiesSchema = z.strictObject({
  name: z.literal('Local Creator Recorder'),
  milestone: z.literal('reliability'),
  storage: z.literal('ready'),
  recording: z.literal(true),
  export: z.literal(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const bootstrapSchema = z.strictObject({ writeToken: writeTokenSchema });
export const writeCheckInputSchema = z.strictObject({});
export const writeCheckSchema = z.strictObject({ authorized: z.literal(true) });

export const sessionStatusSchema = z.enum(['idle', 'preview', 'recording', 'paused', 'finalizing', 'completed', 'interrupted', 'recoverable', 'failed']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export const recordingConfigurationSchema = z.strictObject({
  layout: z.enum(['screen', 'camera', 'pip', 'split']),
  resolution: z.enum(['720p', '1080p']),
  fps: z.literal(30),
  videoBitsPerSecond: z.number().int().min(100_000).max(20_000_000),
  audioBitsPerSecond: z.number().int().min(16_000).max(512_000),
  audioMode: z.enum(['none', 'microphone', 'display', 'combined']),
});
export type RecordingConfiguration = z.infer<typeof recordingConfigurationSchema>;
export const createSessionInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  configuration: recordingConfigurationSchema,
});
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export const sessionChunkMetadataSchema = z.strictObject({
  committedCount: z.number().int().nonnegative(),
  committedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextSequence: z.number().int().nonnegative(),
});
export const isoTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
export const finalizedRecordingProbeSchema = z.strictObject({
  formatName: z.string().min(1).max(160),
  durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  video: z.strictObject({
    codec: z.string().min(1).max(80),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }),
  audio: z.strictObject({ codec: z.string().min(1).max(80) }).nullable(),
});
export const finalizedRecordingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  expectedChunkCount: z.number().int().positive().max(1_000_000),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.literal('video/webm'),
  finalizedAt: isoTimestampSchema,
  probe: finalizedRecordingProbeSchema,
});
export type FinalizedRecording = z.infer<typeof finalizedRecordingSchema>;
export const finalizeSessionInputSchema = z.strictObject({
  expectedChunkCount: z.number().int().positive().max(1_000_000),
});
export type FinalizeSessionInput = z.infer<typeof finalizeSessionInputSchema>;
export const recordingSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: sessionIdSchema,
  title: z.string().min(1).max(120),
  status: sessionStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  configuration: recordingConfigurationSchema,
  chunks: sessionChunkMetadataSchema,
  output: finalizedRecordingSchema.nullable(),
});
export type RecordingSession = z.infer<typeof recordingSessionSchema>;
export const listSessionsQuerySchema = z.strictObject({
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).refine(value => value <= 100).optional().default(20),
  cursor: sessionIdSchema.optional(),
});
export const sessionListSchema = z.strictObject({
  items: z.array(recordingSessionSchema),
  nextCursor: sessionIdSchema.nullable(),
});
export type SessionList = z.infer<typeof sessionListSchema>;

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const chunkMimeTypeSchema = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+,-]+=[a-z0-9!#$&^_.+,-]+)*$/i);
export const recordingChunkContentTypeSchema = chunkMimeTypeSchema.refine(value => value.toLowerCase().split(';', 1)[0] === 'video/webm');
export const chunkSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recordingChunkMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  sequence: chunkSequenceSchema,
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  timestamp: isoTimestampSchema,
  mimeType: recordingChunkContentTypeSchema,
});
export type RecordingChunkMetadata = z.infer<typeof recordingChunkMetadataSchema>;
export const committedRecordingChunkSchema = recordingChunkMetadataSchema.extend({
  committedAt: isoTimestampSchema,
});
export type CommittedRecordingChunk = z.infer<typeof committedRecordingChunkSchema>;
export const durableChunkAckSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  sequence: chunkSequenceSchema,
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  committed: z.literal(true),
  committedAt: isoTimestampSchema,
});
export type DurableChunkAck = z.infer<typeof durableChunkAckSchema>;

export const recoveryConditionSchema = z.enum(['empty', 'active', 'valid-incomplete', 'corrupt', 'finalizing', 'completed', 'unavailable']);
export const recoveryInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  title: z.string().min(1).max(120),
  lifecycleStatus: sessionStatusSchema,
  condition: recoveryConditionSchema,
  committedChunkCount: z.number().int().nonnegative(),
  contiguousChunkCount: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeOperation: z.boolean(),
  recoverable: z.boolean(),
  message: z.string().min(1).max(300),
  output: finalizedRecordingSchema.nullable(),
});
export type RecoveryInspection = z.infer<typeof recoveryInspectionSchema>;
export const recoveryListSchema = z.strictObject({ items: z.array(recoveryInspectionSchema) });
export const recoveryHeartbeatInputSchema = z.strictObject({});
export const recoveryHeartbeatSchema = z.strictObject({ active: z.literal(true), expiresAt: isoTimestampSchema });

export const errorEnvelopeSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  ok: z.literal(false),
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});

export function responseSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ apiVersion: z.literal(API_VERSION), ok: z.literal(true), data }),
    errorEnvelopeSchema,
  ]);
}

export function success<T>(data: T) {
  return { apiVersion: API_VERSION, ok: true as const, data };
}

export function failure(code: ErrorCode, message: string) {
  return { apiVersion: API_VERSION, ok: false as const, error: { code, message } };
}
