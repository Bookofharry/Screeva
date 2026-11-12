import type { Capabilities } from '../../../../packages/shared/src/index.js';
import type { MetadataStore } from '../storage/database.js';

export function getCapabilities(store: MetadataStore): Capabilities {
  if (!store.isReady()) throw new Error('Metadata store is unavailable.');
  return { name: 'Local Creator Recorder', milestone: 'reliability', storage: 'ready', recording: true, export: false };
}
