import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const client = fileURLToPath(new URL('../apps/client', import.meta.url));
const children = new Set();
let stopping = false;
function launch(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
const build = launch([vite, 'build'], client);
build.once('error', () => stop(1));
build.once('exit', code => {
  if (stopping) return;
  if (code !== 0) { stop(code ?? 1); return; }
  console.log('Development mode: reload the browser after client rebuilds.');
  const watch = launch([vite, 'build', '--watch'], client);
  const server = launch([tsx, 'watch', 'apps/server/src/index.ts'], root);
  for (const child of [watch, server]) {
    child.once('error', () => stop(1));
    child.once('exit', code => { if (!stopping) stop(code ?? 1); });
  }
});
