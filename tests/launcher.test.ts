import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../apps/server/src/server.js';
import { openLocalStudio, probeLocalStudio, validateLaunchArguments, type LauncherRuntime, type StudioProbe } from '../apps/server/src/launcher/local-studio.js';
import { launcherDataDirectory, launcherProjectRoot } from '../apps/server/src/launcher/paths.js';
import { SCREEVA_PROTOCOL_KEY, windowsProtocolCommand, windowsProtocolRegistration } from '../apps/server/src/launcher/windows-protocol.js';

function harness(states: StudioProbe[]) {
  const calls: string[] = [];
  const runtime: LauncherRuntime = {
    probe: async () => { calls.push('probe'); return states.shift() ?? 'starting'; },
    start: async () => { calls.push('start'); return { close: async () => { calls.push('close'); } }; },
    openBrowser: async () => { calls.push('open'); },
    wait: async () => { calls.push('wait'); },
  };
  return { calls, runtime };
}

test('activation accepts only a direct launch or the fixed open URI', () => {
  for (const args of [[], ['screeva://open'], ['screeva://open/']]) assert.doesNotThrow(() => validateLaunchArguments(args));
  for (const args of [['screeva://open?command=delete'], ['screeva://open#capture'], ['screeva://record'], ['http://127.0.0.1:4317'], ['screeva://open', '--eval', 'malicious()'], ['screeva://open/../../'], ['screeva://open%22'], ['screeva://open\n'], ['--inspect']]) {
    assert.throws(() => validateLaunchArguments(args), /Unsupported launch request/);
  }
});

test('new launch waits for a valid service before opening and retains ownership', async () => {
  const { runtime, calls } = harness(['absent', 'starting', 'ready']);
  const owned = await openLocalStudio(runtime, new AbortController().signal);
  assert.ok(owned);
  assert.deepEqual(calls, ['probe', 'start', 'probe', 'wait', 'probe', 'open']);
  await owned.close();
  assert.equal(calls.at(-1), 'close');
});

test('existing service is reused without starting or closing it', async () => {
  const { runtime, calls } = harness(['ready']);
  assert.equal(await openLocalStudio(runtime, new AbortController().signal), null);
  assert.deepEqual(calls, ['probe', 'open']);
});

test('simultaneous launcher losing the port race waits for the winning service', async () => {
  const { runtime, calls } = harness(['absent', 'starting', 'ready']);
  runtime.start = async () => { throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); };
  assert.equal(await openLocalStudio(runtime, new AbortController().signal), null);
  assert.equal(calls.at(-1), 'open');
  assert.equal(calls.includes('close'), false);
});

test('foreign service, startup failure and readiness timeout never open a browser', async () => {
  const occupied = harness(['occupied']);
  await assert.rejects(openLocalStudio(occupied.runtime, new AbortController().signal), /Port 4317/);
  assert.deepEqual(occupied.calls, ['probe']);
  const failed = harness(['absent']);
  failed.runtime.start = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(openLocalStudio(failed.runtime, new AbortController().signal), /storage unavailable/);
  assert.equal(failed.calls.includes('open'), false);
  const timeout = harness(['absent']);
  await assert.rejects(openLocalStudio(timeout.runtime, new AbortController().signal), /ready in time/);
  assert.equal(timeout.calls.filter(call => call === 'wait').length, 30);
  assert.equal(timeout.calls.at(-1), 'close');
  assert.equal(timeout.calls.includes('open'), false);
});

test('cancellation cleans up only an owned service and does not trigger capture or browser launch', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const first = harness(['absent']);
  await assert.rejects(openLocalStudio(first.runtime, cancelled.signal));
  assert.deepEqual(first.calls, []);
  const later = new AbortController();
  const second = harness(['absent', 'starting']);
  second.runtime.wait = async () => { later.abort(); };
  await assert.rejects(openLocalStudio(second.runtime, later.signal));
  assert.equal(second.calls.at(-1), 'close');
  assert.equal(second.calls.includes('open'), false);
});

test('browser-opening failure closes a newly started service but never a reused service', async () => {
  for (const states of [['absent', 'ready'], ['ready']] as StudioProbe[][]) {
    const owns = states[0] === 'absent';
    const { runtime, calls } = harness(states);
    runtime.openBrowser = async () => { throw new Error('browser unavailable'); };
    await assert.rejects(openLocalStudio(runtime, new AbortController().signal), /browser unavailable/);
    assert.equal(calls.includes('close'), owns);
  }
});

test('readiness requires a bounded, schema-valid JSON response and never follows redirects', async () => {
  const valid = { apiVersion: 'v1', ok: true, data: { name: 'Local Creator Recorder', milestone: 'reliability', storage: 'ready', recording: true, export: true } };
  assert.equal(await probeLocalStudio(async (input, init) => {
    assert.equal(input, 'http://127.0.0.1:4317/api/v1/capabilities');
    assert.equal(init?.redirect, 'error');
    return Response.json(valid);
  }), 'ready');
  for (const response of [new Response('<html>'), Response.json({ ok: true }), new Response('x'.repeat(17_000), { headers: { 'content-type': 'application/json' } }), new Response('', { status: 302 })]) {
    assert.equal(await probeLocalStudio(async () => response), 'occupied');
  }
  assert.equal(await probeLocalStudio(async () => new Response('', { status: 503 })), 'starting');
  assert.equal(await probeLocalStudio(async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }), 'absent');
  assert.equal(await probeLocalStudio(async () => { throw new Error('unresponsive'); }), 'occupied');
});

test('Windows protocol registration quotes paths and uses a fixed per-user direct executable command', () => {
  const command = windowsProtocolCommand('C:\\Screeva app\\runtime\\node.exe', 'C:\\Screeva app\\dist\\launcher.js');
  assert.equal(command, '"C:\\Screeva app\\runtime\\node.exe" "C:\\Screeva app\\dist\\launcher.js" "%1"');
  const commands = windowsProtocolRegistration(command);
  assert.equal(commands.length, 3);
  assert.ok(commands.every(args => args[1]?.startsWith('HKCU\\Software\\Classes\\screeva')));
  assert.equal(commands[2]?.at(-2), command);
  for (const invalid of ['relative.exe', 'C:\\x"evil.exe', 'C:\\%TEMP%\\node.exe', 'C:\\x\nnode.exe']) assert.throws(() => windowsProtocolCommand(invalid, 'C:\\launcher.js'));
});

test('launcher locates source and built installations and preserves existing platform data paths', () => {
  const root = path.resolve('example-install');
  assert.equal(launcherProjectRoot(pathToFileURL(path.join(root, 'apps/server/src/launcher/entry.ts')).href), root);
  assert.equal(launcherProjectRoot(pathToFileURL(path.join(root, 'dist/apps/server/src/launcher/entry.js')).href), root);
  const home = path.resolve('example-home');
  assert.equal(launcherDataDirectory(root, 'win32', home), path.join(root, 'data'));
  assert.equal(launcherDataDirectory(root, 'darwin', home), path.join(home, 'Library/Application Support/Screeva/data'));
});

test('native Windows URI activation preserves quoting and forwards only the URI', { skip: process.platform !== 'win32' }, async () => {
  const scheme = `screeva-launch-test-${randomUUID()}`;
  const key = `HKCU\\Software\\Classes\\${scheme}`;
  const root = await mkdtemp(path.join(tmpdir(), 'screeva-protocol-'));
  const script = path.join(root, 'capture arguments.cjs');
  const output = path.join(root, 'arguments.json');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  const command = windowsProtocolCommand(process.execPath, script);
  try {
    for (const args of windowsProtocolRegistration(command)) {
      args[1] = args[1]!.replace(SCREEVA_PROTOCOL_KEY, key);
      execFileSync('reg.exe', args, { windowsHide: true, stdio: 'pipe' });
    }
    const stored = execFileSync('reg.exe', ['query', `${key}\\shell\\open\\command`, '/ve'], { encoding: 'utf8', windowsHide: true });
    assert.ok(stored.includes(command));
    // A unique disposable scheme never replaces the user's real Screeva association.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${scheme}://open' -WindowStyle Hidden`], { windowsHide: true, stdio: 'pipe' });
    let received: string | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { received = await readFile(output, 'utf8'); break; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        await delay(250);
      }
    }
    assert.ok(received, 'Windows must activate the registered handler');
    const args = JSON.parse(received) as string[];
    assert.equal(args.length, 1);
    // Windows may normalize an authority-only URI with a trailing slash.
    assert.ok(args[0] === `${scheme}://open` || args[0] === `${scheme}://open/`);
    validateLaunchArguments([args[0].replace(scheme, 'screeva')]);
  } finally {
    execFileSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});

test('port collision rejects before creating or reconciling any recording storage', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'screeva-launcher-'));
  const first = await startServer({ port: 0, dataDirectory: path.join(sandbox, 'first') });
  const secondDirectory = path.join(sandbox, 'must-not-exist');
  try {
    await assert.rejects(startServer({ port: Number(new URL(first.origin).port), dataDirectory: secondDirectory }), { code: 'EADDRINUSE' });
    await assert.rejects(stat(secondDirectory), { code: 'ENOENT' });
    assert.equal((await fetch(`${first.origin}/api/v1/capabilities`)).status, 200);
  } finally {
    await first.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
