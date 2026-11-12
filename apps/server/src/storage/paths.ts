import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sessionIdSchema } from '../../../../packages/shared/src/index.js';

export async function assertDirectoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent !== absolute) await assertDirectoryChain(parent);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Storage directories must be real directories, not links.');
}

export async function ensureDirectory(directory: string): Promise<void> {
  const parent = path.dirname(path.resolve(directory));
  await assertDirectoryChain(parent);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  await assertDirectoryChain(directory);
}

export async function sessionDirectory(root: string, id: string): Promise<string> {
  const parsedId = sessionIdSchema.parse(id);
  const sessions = path.resolve(root, 'sessions');
  await assertDirectoryChain(sessions);
  const destination = path.resolve(sessions, parsedId);
  if (path.dirname(destination) !== sessions) throw new Error('Invalid session path.');
  try {
    await assertDirectoryChain(destination);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return destination;
}
