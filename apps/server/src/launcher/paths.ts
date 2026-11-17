import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function launcherProjectRoot(moduleUrl: string): string {
  const root = fileURLToPath(new URL('../../../../', moduleUrl)).replace(/[\\/]$/, '');
  return path.basename(root) === 'dist' ? path.dirname(root) : root;
}

export function launcherDataDirectory(root: string, platform: NodeJS.Platform, home: string): string {
  // Retain the old macOS bundle's data location; Windows portable bundles retain their data/.
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Screeva', 'data') : path.join(root, 'data');
}
