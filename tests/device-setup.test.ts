import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceSetup, accessError, deviceOptions, initialSetupState, type DeviceAccess, type DeviceInfo, type PermissionHandle } from '../apps/client/src/media/device-setup.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeStream(kind: 'audio' | 'video' = 'video') {
  const track = { kind, readyState: 'live' as MediaStreamTrackState, stops: 0, stop() { this.stops++; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track] };
}
class FakeMedia extends EventTarget implements DeviceAccess {
  devices: DeviceInfo[] = [
    { kind: 'videoinput', deviceId: 'camera-1', label: 'Camera One' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic One' },
  ];
  requests: MediaStreamConstraints[] = [];
  stream = fakeStream();
  enumerateDevices = async (): Promise<readonly DeviceInfo[]> => this.devices;
  open = async () => this.stream;
  getUserMedia(constraints: MediaStreamConstraints) { this.requests.push(constraints); return this.open(); }
}
class FakePermission extends EventTarget implements PermissionHandle {
  state: PermissionState = 'prompt';
}
function fixture(media = new FakeMedia()) {
  let state = initialSetupState(true);
  const camera = new FakePermission();
  const microphone = new FakePermission();
  const setup = new DeviceSetup({ secure: true, media, queryPermission: async kind => kind === 'camera' ? camera : microphone }, next => { state = next; });
  return { media, camera, microphone, setup, get state() { return state; } };
}

test('discovery and selection never request access, and names/IDs are safely normalized', async () => {
  const f = fixture(); await f.setup.start();
  assert.equal(f.state.camera.permission, 'prompt');
  f.setup.select('camera', 'camera-1');
  assert.equal(f.state.camera.selectedId, 'camera-1');
  f.setup.select('camera', 'unknown');
  assert.equal(f.state.camera.selectedId, 'camera-1');
  assert.equal(f.media.requests.length, 0);
  assert.deepEqual(deviceOptions([
    { kind: 'videoinput', deviceId: '', label: '' },
    { kind: 'videoinput', deviceId: 'hidden', label: '' },
    { kind: 'videoinput', deviceId: 'hidden', label: 'Duplicate' },
    { kind: 'videoinput', deviceId: 'obs-cam', label: 'OBS Virtual Camera' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
  ], 'camera'), [
    { id: 'hidden', label: 'Camera 1 (name hidden)' },
    { id: 'obs-cam', label: 'OBS Virtual Camera (Coming soon)', disabled: true, comingSoon: true },
  ]);
  f.media.devices.push({ kind: 'videoinput', deviceId: 'obs-cam', label: 'OBS Virtual Camera' });
  await f.setup.refresh();
  f.setup.select('camera', 'obs-cam');
  assert.equal(f.state.camera.selectedId, 'camera-1');
  f.setup.dispose();
});

test('access checks constrain only the selected input and release every returned track', async () => {
  const f = fixture(); await f.setup.start(); f.setup.select('camera', 'camera-1');
  const extra = fakeStream('audio');
  f.media.stream.getTracks = () => [f.media.stream.track, extra.track];
  await f.setup.check('camera');
  assert.deepEqual(f.media.requests[0], { video: { deviceId: { exact: 'camera-1' } }, audio: false });
  assert.equal(f.media.stream.track.stops, 1);
  assert.equal(extra.track.stops, 1);
  assert.match(f.state.camera.message, /Access check passed/);
  f.media.stream = fakeStream('audio');
  await f.setup.check('microphone');
  assert.deepEqual(f.media.requests[1], { audio: true, video: false });
  assert.equal(f.media.stream.track.stops, 1);
  assert.equal(f.state.pending, null); f.setup.dispose();
});

for (const [name, expected] of [
  ['NotAllowedError', /Access was not allowed/], ['SecurityError', /Access was not allowed/],
  ['NotFoundError', /No matching input/], ['NotReadableError', /could not be opened/],
  ['OverconstrainedError', /no longer available/], ['AbortError', /interrupted/], ['TypeError', /check failed/],
] as const) {
  test(`explains ${name} and allows retry without raw device/error disclosure`, async () => {
    const f = fixture(); await f.setup.start();
    f.media.open = async () => { throw new DOMException('private device details', name); };
    await f.setup.check('camera');
    assert.match(f.state.camera.message, expected);
    assert.equal(f.state.camera.message.includes('private'), false);
    assert.equal(f.state.pending, null);
    f.media.open = async () => f.media.stream;
    await f.setup.check('camera'); assert.equal(f.media.stream.track.stops, 1); f.setup.dispose();
  });
}

test('cancels a pending check, serializes prompts and stops a late successful stream', async () => {
  const f = fixture(); await f.setup.start();
  const pending = deferred<ReturnType<typeof fakeStream>>(); f.media.open = () => pending.promise;
  const request = f.setup.check('camera');
  f.setup.cancel();
  await f.setup.check('microphone');
  f.setup.select('camera', 'camera-1');
  assert.equal(f.state.camera.selectedId, '');
  assert.equal(f.media.requests.length, 1);
  assert.equal(f.state.pending, 'camera');
  pending.resolve(f.media.stream); await request;
  assert.equal(f.media.stream.track.stops, 1);
  assert.match(f.state.camera.message, /cancelled/);
  assert.equal(f.state.pending, null); f.setup.dispose();
});

test('unmount releases late streams and removes device and permission listeners', async () => {
  const f = fixture(); await f.setup.start();
  const pending = deferred<ReturnType<typeof fakeStream>>(); f.media.open = () => pending.promise;
  const request = f.setup.check('camera');
  const before = f.state; f.setup.dispose();
  f.camera.state = 'denied'; f.camera.dispatchEvent(new Event('change'));
  f.media.dispatchEvent(new Event('devicechange'));
  pending.resolve(f.media.stream); await request;
  assert.equal(f.media.stream.track.stops, 1);
  assert.equal(f.state, before);
});

test('empty or ended streams are not reported as successful', async () => {
  const f = fixture(); await f.setup.start(); f.media.stream.track.readyState = 'ended';
  await f.setup.check('camera');
  assert.match(f.state.camera.message, /No matching input/);
  assert.equal(f.media.stream.track.stops, 1); f.setup.dispose();
});

test('device removal resets selection explicitly, while refresh errors preserve it', async () => {
  const f = fixture(); await f.setup.start(); f.setup.select('camera', 'camera-1');
  f.media.enumerateDevices = async () => { throw new Error('private detail'); };
  await f.setup.refresh();
  assert.equal(f.state.camera.selectedId, 'camera-1'); assert.match(f.state.listError, /Could not refresh/);
  f.media.enumerateDevices = async () => [];
  f.media.dispatchEvent(new Event('devicechange'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.camera.selectedId, '');
  assert.match(f.state.camera.message, /no longer listed/); assert.equal(f.state.listError, ''); f.setup.dispose();
});

test('permission changes are observed without requesting access', async () => {
  const f = fixture(); await f.setup.start();
  f.camera.state = 'denied'; f.camera.dispatchEvent(new Event('change'));
  assert.equal(f.state.camera.permission, 'denied'); assert.equal(f.media.requests.length, 0); f.setup.dispose();
});

test('unsupported permission queries still permit explicit access checks', async () => {
  const media = new FakeMedia(); let state = initialSetupState(true);
  const setup = new DeviceSetup({ secure: true, media, queryPermission: async () => { throw new TypeError('unsupported'); } }, next => { state = next; });
  await setup.start(); assert.equal(state.camera.permission, 'unknown');
  await setup.check('camera'); assert.equal(media.stream.track.stops, 1); setup.dispose();
});

test('insecure contexts and absent media APIs never request or enumerate devices', async () => {
  for (const secure of [true, false]) {
    let state = initialSetupState(true); const media = new FakeMedia();
    media.enumerateDevices = async () => { assert.fail('Unexpected enumeration'); };
    const setup = new DeviceSetup({ secure, media: secure ? undefined : media, queryPermission: undefined }, next => { state = next; });
    await setup.start(); await setup.check('camera'); await setup.refresh();
    assert.equal(state.supported, false); assert.equal(media.requests.length, 0); setup.dispose();
  }
  assert.match(accessError(null), /failed/);
});

test('out-of-order enumeration cannot overwrite a newer list', async () => {
  const f = fixture(); await f.setup.start();
  const old = deferred<readonly DeviceInfo[]>(); const recent = deferred<readonly DeviceInfo[]>();
  f.media.enumerateDevices = () => old.promise; const first = f.setup.refresh();
  f.media.enumerateDevices = () => recent.promise; const second = f.setup.refresh();
  recent.resolve([]); await second; old.resolve(f.media.devices); await first;
  assert.deepEqual(f.state.camera.devices, []); assert.equal(f.state.refreshing, false); f.setup.dispose();
});
