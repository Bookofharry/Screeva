import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureManager, captureError, type CaptureEnvironment, type CaptureKind } from '../apps/client/src/media/capture-manager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Track extends EventTarget {
  id = Math.random().toString(36);
  label = 'Synthetic source';
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  stops = 0;
  constructor(public kind: string, public settings: MediaTrackSettings = {}) { super(); }
  getSettings() { return this.settings; }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class Stream extends EventTarget {
  constructor(public tracks: Track[]) { super(); }
  getTracks() { return this.tracks; }
  removeTrack(track: Track) { this.tracks = this.tracks.filter(item => item !== track); this.dispatchEvent(new Event('removetrack')); }
  asMedia() { return this as unknown as MediaStream; }
}
class Devices extends EventTarget {
  list = [
    { deviceId: 'camera-1', kind: 'videoinput' }, { deviceId: 'camera-2', kind: 'videoinput' },
    { deviceId: 'mic-1', kind: 'audioinput' },
  ];
  enumerateDevices = async () => this.list as MediaDeviceInfo[];
}
function fixture() {
  const devices = new Devices();
  const calls: { kind: string; options: MediaStreamConstraints | DisplayMediaStreamOptions }[] = [];
  const camera = new Stream([new Track('video', { deviceId: 'camera-1', width: 640, height: 480, frameRate: 30 })]);
  const microphone = new Stream([new Track('audio', { deviceId: 'mic-1', sampleRate: 48000, channelCount: 1 })]);
  const display = new Stream([new Track('video', { width: 1280, height: 720, displaySurface: 'window' }), new Track('audio')]);
  const environment: CaptureEnvironment = {
    secure: true, devices,
    getUserMedia: async options => { calls.push({ kind: options.video ? 'camera' : 'microphone', options }); return (options.video ? camera : microphone).asMedia(); },
    getDisplayMedia: async options => { calls.push({ kind: 'display', options }); return display.asMedia(); },
  };
  const manager = new CaptureManager(environment, () => {});
  return { manager, environment, devices, calls, camera, microphone, display, get state() { return manager.getSnapshot(); } };
}

test('construction never captures; each API is called synchronously from start with selected constraints', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); assert.equal(f.calls.length, 0);
  const screen = f.manager.start('display');
  assert.deepEqual(f.calls[0], { kind: 'display', options: { video: true, audio: true } });
  await screen; await f.manager.start('camera', 'camera-1'); await f.manager.start('microphone', 'mic-1');
  assert.deepEqual(f.calls[1]?.options, { video: { deviceId: { exact: 'camera-1' } }, audio: false });
  assert.deepEqual(f.calls[2]?.options, { audio: { deviceId: { exact: 'mic-1' } }, video: false });
  for (const kind of ['display', 'camera', 'microphone'] as const) assert.equal(f.state[kind].status, 'active');
  assert.equal(f.camera.tracks[0]?.stops, 0); assert.equal(f.microphone.tracks[0]?.stops, 0);
  assert.equal(f.state.camera.tracks[0]?.settings.width, 640);
  assert.equal(f.state.microphone.tracks[0]?.settings.sampleRate, 48000);
});

test('stopping sources is independent, releases all display audio/video, and repeated stops are safe', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.start('display'); await f.manager.start('camera'); await f.manager.start('microphone');
  f.manager.stop('display'); f.manager.stop('display');
  assert.ok(f.display.tracks.every(track => track.stops === 1));
  assert.equal(f.state.display.stream, null); assert.equal(f.state.camera.status, 'active');
  f.manager.stopAll(); assert.equal(f.camera.tracks[0]?.stops, 1); assert.equal(f.microphone.tracks[0]?.stops, 1);
});

test('switching releases the old device before opening its replacement; stale ended events cannot stop the new source', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('camera', 'camera-1');
  const next = new Stream([new Track('video', { deviceId: 'camera-2', width: 1920 })]);
  f.environment.getUserMedia = async options => {
    assert.equal(f.camera.tracks[0]?.stops, 1);
    assert.deepEqual(options, { video: { deviceId: { exact: 'camera-2' } }, audio: false });
    return next.asMedia();
  };
  await f.manager.start('camera', 'camera-2'); f.camera.tracks[0]?.end();
  assert.equal(f.state.camera.stream, next.asMedia()); assert.equal(next.tracks[0]?.stops, 0);
  f.manager.stop('camera'); assert.equal(next.tracks[0]?.stops, 1);
});

test('failed replacement leaves no old stream or misleading active state', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('camera');
  f.environment.getUserMedia = async () => { throw new DOMException('device busy', 'NotReadableError'); };
  await f.manager.start('camera', 'camera-2');
  assert.equal(f.camera.tracks[0]?.stops, 1); assert.equal(f.state.camera.status, 'error'); assert.equal(f.state.camera.stream, null);
});

test('microphone replacement uses the new selected input and releases the old microphone', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('microphone', 'mic-1');
  const next = new Stream([new Track('audio', { deviceId: 'mic-2', sampleRate: 44100 })]);
  f.environment.getUserMedia = async options => {
    assert.equal(f.microphone.tracks[0]?.stops, 1);
    assert.deepEqual(options, { audio: { deviceId: { exact: 'mic-2' } }, video: false });
    return next.asMedia();
  };
  await f.manager.start('microphone', 'mic-2');
  assert.equal(f.state.microphone.tracks[0]?.settings.sampleRate, 44100);
  f.manager.stop('microphone'); assert.equal(next.tracks[0]?.stops, 1);
});

for (const kind of ['display', 'camera', 'microphone'] as const) {
  test(`${kind} cancellation blocks overlapping prompts and releases late successful results`, async t => {
    const f = fixture(); t.after(() => f.manager.dispose());
    const late = deferred<MediaStream>(); let count = 0;
    const open = () => { count++; return late.promise; };
    f.environment.getDisplayMedia = open; f.environment.getUserMedia = open;
    const request = f.manager.start(kind); f.manager.stop(kind);
    await f.manager.start(kind); assert.equal(count, 1);
    assert.equal(f.state[kind].status, 'cancelled'); assert.equal(f.state[kind].pending, true);
    const stream = kind === 'display' ? f.display : kind === 'camera' ? f.camera : f.microphone;
    late.resolve(stream.asMedia()); await request;
    assert.ok(stream.tracks.every(track => track.stops === 1)); assert.equal(f.state[kind].stream, null);
    assert.equal(f.state[kind].pending, false); assert.equal(f.state[kind].status, 'cancelled');
  });
}

test('late rejection after cancellation does not replace the cancellation message', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const late = deferred<MediaStream>();
  f.environment.getDisplayMedia = () => late.promise;
  const request = f.manager.start('display'); f.manager.stop('display');
  late.reject(new DOMException('blocked', 'NotAllowedError')); await request;
  assert.equal(f.state.display.status, 'cancelled'); assert.match(f.state.display.message, /cancelled/);
});

test('unmount stops active tracks, detaches listeners/timers and releases all late results without publishing', async () => {
  const f = fixture(); await f.manager.start('camera'); const late = deferred<MediaStream>();
  f.environment.getDisplayMedia = () => late.promise;
  const request = f.manager.start('display'); const before = f.state;
  f.manager.dispose(); f.manager.dispose();
  late.resolve(f.display.asMedia()); await request;
  f.devices.dispatchEvent(new Event('devicechange')); f.camera.tracks[0]?.end();
  assert.equal(f.state, before); assert.equal(f.camera.tracks[0]?.stops, 1);
  assert.ok(f.display.tracks.every(track => track.stops === 1));
});

test('browser stop-sharing ends video and releases accompanying audio; optional audio loss preserves video', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('display');
  f.display.tracks[1]?.end(); assert.equal(f.state.display.status, 'active');
  assert.equal(f.state.display.tracks.length, 1);
  f.display.tracks[0]?.end(); assert.equal(f.state.display.status, 'ended');
  assert.equal(f.display.tracks[1]?.stops, 1); assert.equal(f.state.display.stream, null);
});

test('track mute/unmute and browser settings changes update actual state without reopening capture', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('display');
  const track = f.display.tracks[0]!; track.muted = true; track.dispatchEvent(new Event('mute'));
  assert.equal(f.state.display.tracks[0]?.muted, true);
  track.muted = false; track.settings.width = 1600; track.label = 'Switched window'; track.dispatchEvent(new Event('unmute'));
  assert.equal(f.state.display.tracks[0]?.muted, false); assert.equal(f.state.display.tracks[0]?.settings.width, 1600);
  assert.equal(f.state.display.tracks[0]?.label, 'Switched window'); assert.equal(f.calls.length, 1);
});

test('removed and newly added tracks are owned and released', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('display');
  const audio = f.display.tracks[1]!; f.display.removeTrack(audio); assert.equal(audio.readyState, 'ended');
  const added = new Track('audio'); f.display.tracks.push(added); f.display.dispatchEvent(new Event('addtrack'));
  assert.equal(f.state.display.tracks.length, 2); f.manager.stop('display'); assert.equal(added.readyState, 'ended');
});

test('empty, wrong-kind and already-ended streams are rejected and fully released', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  for (const tracks of [[], [new Track('audio')], [Object.assign(new Track('video'), { readyState: 'ended' as const })]]) {
    const stream = new Stream(tracks); f.environment.getDisplayMedia = async () => stream.asMedia();
    await f.manager.start('display'); assert.equal(f.state.display.status, 'error'); assert.equal(f.state.display.stream, null);
    assert.ok(tracks.every(track => track.stops === 1));
  }
});

test('unexpected microphone/camera tracks are stopped instead of silently retained', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const extra = new Track('audio'); f.camera.tracks.push(extra);
  await f.manager.start('camera'); assert.equal(extra.stops, 1); assert.equal(f.state.camera.tracks.length, 1);
});

for (const name of ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'InvalidStateError', 'NotSupportedError', 'AbortError', 'TypeError']) {
  test(`reports ${name} safely and permits a new user-initiated attempt`, async t => {
    const f = fixture(); t.after(() => f.manager.dispose());
    f.environment.getDisplayMedia = () => { throw new DOMException('private source details', name); };
    await f.manager.start('display'); assert.equal(f.state.display.status, 'error'); assert.equal(f.state.display.pending, false);
    assert.equal(f.state.display.message.includes('private'), false);
    f.environment.getDisplayMedia = async () => f.display.asMedia(); await f.manager.start('display'); assert.equal(f.state.display.status, 'active');
  });
}

test('secure-context and API availability are checked independently for each source', async () => {
  for (const secure of [true, false]) {
    const environment: CaptureEnvironment = { secure, devices: undefined, getDisplayMedia: undefined, getUserMedia: undefined };
    const manager = new CaptureManager(environment, () => {});
    for (const kind of ['display', 'camera', 'microphone'] as const) { await manager.start(kind); assert.equal(manager.getSnapshot()[kind].status, 'unsupported'); }
    manager.dispose();
  }
  assert.match(captureError(null, 'camera'), /failed/);
});

test('device removal stops only the affected source and never silently chooses another device', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.start('camera'); await f.manager.start('microphone'); await f.manager.start('display');
  f.devices.list = f.devices.list.filter(device => device.deviceId !== 'camera-1');
  f.devices.dispatchEvent(new Event('devicechange')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.camera.status, 'ended'); assert.equal(f.camera.tracks[0]?.stops, 1);
  assert.equal(f.state.microphone.status, 'active'); assert.equal(f.state.display.status, 'active'); assert.equal(f.calls.length, 3);
});

test('stale device enumeration cannot stop a newly switched stream', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('camera');
  const late = deferred<MediaDeviceInfo[]>(); f.devices.enumerateDevices = () => late.promise;
  const check = f.manager.checkDevices();
  const next = new Stream([new Track('video', { deviceId: 'camera-2' })]); f.environment.getUserMedia = async () => next.asMedia();
  await f.manager.start('camera', 'camera-2'); late.resolve([]); await check;
  assert.equal(f.state.camera.status, 'active'); assert.equal(next.tracks[0]?.stops, 0);
});

test('enumeration failure leaves live capture intact and explains the verification failure', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.start('microphone');
  f.devices.enumerateDevices = async () => { throw new Error('private driver details'); };
  await f.manager.checkDevices(); assert.equal(f.state.microphone.status, 'active');
  assert.match(f.state.microphone.message, /Could not verify/); assert.equal(f.microphone.tracks[0]?.stops, 0);
});

test('device removal during a pending request invalidates and releases the late stream', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const late = deferred<MediaStream>();
  f.environment.getUserMedia = () => late.promise;
  const request = f.manager.start('camera', 'camera-1');
  f.devices.list = []; await f.manager.checkDevices();
  assert.equal(f.state.camera.status, 'cancelled');
  late.resolve(f.camera.asMedia()); await request;
  assert.equal(f.camera.tracks[0]?.stops, 1); assert.equal(f.state.camera.stream, null);
});

test('polling catches stopped tracks even when the browser emits no ended event', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  t.mock.timers.enable({ apis: ['setInterval'] }); await f.manager.start('camera');
  f.camera.tracks[0]?.stop(); t.mock.timers.tick(1000);
  assert.equal(f.state.camera.status, 'ended'); assert.equal(f.state.camera.stream, null);
});

// Compile-time check that tests cover the three independent source names.
const sourceNames: CaptureKind[] = ['display', 'camera', 'microphone'];
test('stop before start is harmless for every source', t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  for (const kind of sourceNames) f.manager.stop(kind);
  assert.equal(f.calls.length, 0);
});
