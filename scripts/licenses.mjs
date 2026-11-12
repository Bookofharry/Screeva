import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const counts = new Map();
let missing = false;
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location.includes('node_modules/') || pkg.link) continue;
  const license = pkg.license ?? 'UNDECLARED';
  counts.set(license, (counts.get(license) ?? 0) + 1);
  if (license === 'UNDECLARED') { console.error(`Review license: ${location}`); missing = true; }
}
for (const [license, count] of [...counts].sort()) console.log(`${license}: ${count}`);
if (missing) process.exitCode = 1;
