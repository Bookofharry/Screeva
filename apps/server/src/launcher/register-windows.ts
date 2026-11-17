import { execFileSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { launcherProjectRoot } from './paths.js';
import { windowsProtocolCommand, windowsProtocolRegistration } from './windows-protocol.js';

try {
  if (process.platform !== 'win32' || process.argv.length !== 2) throw new Error('Run the Windows setup shortcut directly.');
  const root = launcherProjectRoot(import.meta.url);
  const entry = path.join(root, 'dist', 'apps', 'server', 'src', 'launcher', 'entry.js');
  accessSync(entry);
  const command = windowsProtocolCommand(process.execPath, entry);
  for (const args of windowsProtocolRegistration(command)) execFileSync('reg.exe', args, { windowsHide: true, stdio: 'pipe' });
  console.log('Screeva links are enabled for your Windows account. Keep this extracted folder in place. Return to the website and choose Open local studio.');
} catch {
  console.error('Screeva links could not be enabled. Extract the complete bundle to a permanent folder, then run setup again. You can still use Start Screeva.cmd.');
  process.exitCode = 1;
}
