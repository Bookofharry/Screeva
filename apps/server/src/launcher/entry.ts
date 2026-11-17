import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { startServer } from '../server.js';
import { LOCAL_STUDIO_ORIGIN, openLocalStudio, probeLocalStudio, validateLaunchArguments, type LaunchedStudio } from './local-studio.js';
import { launcherDataDirectory, launcherProjectRoot } from './paths.js';

const execute = promisify(execFile);
const controller = new AbortController();
let running: LaunchedStudio | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    controller.abort();
    if (running) void running.close().then(() => { process.exitCode = 0; });
  });
}

try {
  validateLaunchArguments(process.argv.slice(2));
  const root = launcherProjectRoot(import.meta.url);
  const clientDirectory = path.join(root, 'apps', 'client', 'dist');
  await access(path.join(clientDirectory, 'index.html'));
  process.title = 'Screeva local studio';
  console.log('Opening Screeva. Keep this window open while recording. Stop recording before pressing Ctrl+C to close the local service.');
  running = await openLocalStudio({
    probe: () => probeLocalStudio(),
    start: () => startServer({ port: 4317, clientDirectory, dataDirectory: launcherDataDirectory(root, process.platform, homedir()) }),
    wait: async signal => { await wait(500, undefined, { signal }); },
    openBrowser: async () => {
      if (process.platform === 'win32') {
        // The script and URL are constant, never taken from the protocol argument.
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${LOCAL_STUDIO_ORIGIN}'`], { windowsHide: true });
      } else if (process.platform === 'darwin') {
        await execute('/usr/bin/open', [LOCAL_STUDIO_ORIGIN]);
      } else {
        await execute('xdg-open', [LOCAL_STUDIO_ORIGIN]);
      }
    },
  }, controller.signal);
  console.log(`Screeva ready: ${LOCAL_STUDIO_ORIGIN}`);
} catch (error) {
  if (!controller.signal.aborted) {
    // Never echo an untrusted activation URL, local paths or capability tokens.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'LAUNCH_FAILED';
    console.error(`Screeva could not open (${code}). Check that the app is extracted, port 4317 is available, and its data folder is writable. Existing recordings were retained.`);
    process.exitCode = 1;
  }
}
