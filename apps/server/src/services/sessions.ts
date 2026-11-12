import { randomUUID } from 'node:crypto';
import {
  createSessionInputSchema,
  recordingSessionSchema,
  sessionListSchema,
  type CreateSessionInput,
  type RecordingSession,
  type SessionList,
  type SessionStatus,
} from '../../../../packages/shared/src/index.js';
import type { MetadataStore } from '../storage/database.js';

export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['preview', 'failed'],
  preview: ['idle', 'recording', 'failed'],
  recording: ['paused', 'finalizing', 'interrupted', 'failed'],
  paused: ['recording', 'finalizing', 'interrupted', 'failed'],
  finalizing: ['completed', 'recoverable', 'failed'],
  completed: [],
  interrupted: ['recoverable', 'failed'],
  recoverable: ['finalizing', 'failed'],
  failed: ['recoverable'],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to);
}

export function createSession(store: MetadataStore, input: CreateSessionInput, now = new Date()): RecordingSession {
  const parsed = createSessionInputSchema.parse(input);
  const timestamp = now.toISOString();
  const session = recordingSessionSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    title: parsed.title,
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    configuration: parsed.configuration,
    chunks: { committedCount: 0, committedBytes: 0, nextSequence: 0 },
    output: null,
  });
  store.insertSession(session);
  return session;
}

export function getSession(store: MetadataStore, id: string): RecordingSession | null {
  const session = store.findSession(id);
  return session ? recordingSessionSchema.parse(session) : null;
}

export function listSessions(store: MetadataStore, limit: number, cursor?: string): SessionList {
  return sessionListSchema.parse(store.listSessions(limit, cursor));
}
