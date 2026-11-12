import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioMixer, type AudioMixerRuntime } from '../apps/client/src/media/audio-mixer.js';

class Track extends EventTarget {
  readonly kind: 'audio' | 'video';
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  enabled = true;
  stops = 0;

  constructor(kind: 'audio' | 'video' = 'audio') { super(); this.kind = kind; }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  setMuted(muted: boolean) { this.muted = muted; this.dispatchEvent(new Event(muted ? 'mute' : 'unmute')); }
}

class Stream extends EventTarget {
  constructor(readonly tracks: Track[]) { super(); }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  add(track: Track) { this.tracks.push(track); this.dispatchEvent(new Event('addtrack')); }
  remove(track: Track) {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
    this.dispatchEvent(new Event('removetrack'));
  }
}

class NodeSurface {
  connections: NodeSurface[] = [];
  disconnects = 0;
  connect(destination: NodeSurface) { this.connections.push(destination); return destination; }
  disconnect() { this.disconnects++; this.connections = []; }
}
class GainSurface extends NodeSurface { gain = { value: 1 }; }
class AnalyserSurface extends NodeSurface {
  fftSize = 0;
  value = 128;
  getByteTimeDomainData(data: Uint8Array<ArrayBuffer>) { data.fill(this.value); }
}
class DestinationSurface extends NodeSurface {
  output = new Track();
  stream = new Stream([this.output]) as unknown as MediaStream;
}
class ContextSurface extends EventTarget {
  state = 'running';
  sources: NodeSurface[] = [];
  gains: GainSurface[] = [];
  analysers: AnalyserSurface[] = [];
  destination = new DestinationSurface();
  resumes = 0;
  closes = 0;

  createMediaStreamSource(_stream: MediaStream) { const node = new NodeSurface(); this.sources.push(node); return node; }
  createGain() { const node = new GainSurface(); this.gains.push(node); return node; }
  createAnalyser() { const node = new AnalyserSurface(); this.analysers.push(node); return node; }
  createMediaStreamDestination() { return this.destination; }
  async resume() { this.resumes++; this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
  async close() { this.closes++; this.state = 'closed'; }
}

function fixture(context = new ContextSurface()) {
  let nextFrame = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const runtime: AudioMixerRuntime = {
    createContext: () => context,
    requestFrame: callback => { const id = ++nextFrame; callbacks.set(id, callback); return id; },
    cancelFrame: handle => { cancelled.push(handle); callbacks.delete(handle); },
  };
  const mixer = new AudioMixer(runtime);
  return { mixer, context, callbacks, cancelled };
}

const media = (stream: Stream) => stream as unknown as MediaStream;

test('creates two isolated routes into one destination without speaker monitoring', () => {
  const f = fixture();
  assert.equal(f.context.gains.length, 2);
  assert.equal(f.context.analysers.length, 2);
  assert.equal(f.context.gains[0]?.connections[0], f.context.analysers[0]);
  assert.equal(f.context.gains[1]?.connections[0], f.context.analysers[1]);
  assert.equal(f.context.analysers.every(node => node.connections[0] === f.context.destination), true);
  assert.equal(f.mixer.getOutputStream(), f.context.destination.stream);
  assert.equal(f.mixer.getOutputStream().getAudioTracks().length, 1);
  f.mixer.dispose();
});

test('routes microphone-only, display-only, combined and no-audio modes with isolated controls', () => {
  const f = fixture(); const microphone = new Stream([new Track()]); const display = new Stream([new Track()]);
  f.mixer.setSources({ microphone: media(microphone), display: null });
  assert.equal(f.mixer.getSnapshot().mode, 'microphone');
  f.mixer.setSources({ microphone: null, display: media(display) });
  assert.equal(f.mixer.getSnapshot().mode, 'display');
  f.mixer.setSources({ microphone: media(microphone), display: media(display) });
  assert.equal(f.mixer.getSnapshot().mode, 'combined');
  f.mixer.setControl('microphone', { muted: true, gain: 1.5 });
  assert.equal(f.mixer.getSnapshot().mode, 'display');
  assert.equal(f.context.gains[0]?.gain.value, 0);
  assert.equal(f.context.gains[1]?.gain.value, 1);
  f.mixer.setControl('display', { muted: true });
  assert.equal(f.mixer.getSnapshot().mode, 'none');
  f.mixer.setControl('microphone', { muted: false, gain: 3 });
  assert.equal(f.mixer.getSnapshot().microphone.gain, 2);
  assert.equal(f.context.gains[0]?.gain.value, 2);
  f.mixer.dispose();
});

test('missing, muted, ended, added and removed audio tracks update routing truthfully', () => {
  const f = fixture(); const microphoneTrack = new Track(); const microphone = new Stream([microphoneTrack]);
  const videoOnly = new Stream([new Track('video')]);
  f.mixer.setSources({ microphone: media(microphone), display: media(videoOnly) });
  assert.equal(f.mixer.getSnapshot().mode, 'microphone');
  assert.equal(f.mixer.getSnapshot().display.available, false);
  microphoneTrack.setMuted(true);
  assert.equal(f.mixer.getSnapshot().mode, 'none');
  microphoneTrack.setMuted(false);
  assert.equal(f.mixer.getSnapshot().mode, 'microphone');
  const displayTrack = new Track(); videoOnly.add(displayTrack);
  assert.equal(f.mixer.getSnapshot().mode, 'combined');
  videoOnly.remove(displayTrack);
  assert.equal(f.mixer.getSnapshot().mode, 'microphone');
  microphoneTrack.end();
  assert.equal(f.mixer.getSnapshot().mode, 'none');
  f.mixer.dispose();
});

test('replacement disconnects the old node, avoids duplicates and never stops borrowed tracks', () => {
  const f = fixture(); const firstTrack = new Track(); const secondTrack = new Track();
  const first = new Stream([firstTrack]); const second = new Stream([secondTrack]);
  f.mixer.setSources({ microphone: media(first), display: null });
  const oldNode = f.context.sources[0]!;
  f.mixer.setSources({ microphone: media(first), display: null });
  assert.equal(f.context.sources.length, 1);
  f.mixer.setSources({ microphone: media(second), display: null });
  assert.equal(oldNode.disconnects, 1);
  assert.equal(f.context.sources.length, 2);
  assert.equal(firstTrack.stops, 0);
  secondTrack.setMuted(true);
  assert.equal(f.mixer.getSnapshot().microphone.trackMuted, true);
  f.mixer.dispose();
  assert.equal(firstTrack.stops, 0);
  assert.equal(secondTrack.stops, 0);
});

test('meter sampling reflects analysers and independently zeros muted or suspended routes', async () => {
  const context = new ContextSurface(); const f = fixture(context);
  const microphone = new Stream([new Track()]); const display = new Stream([new Track()]);
  f.mixer.setSources({ microphone: media(microphone), display: media(display) });
  context.analysers[0]!.value = 192;
  context.analysers[1]!.value = 128;
  f.mixer.sampleMeters();
  assert.ok(f.mixer.getSnapshot().microphone.level > 0.7);
  assert.equal(f.mixer.getSnapshot().display.level, 0);
  f.mixer.setControl('microphone', { muted: true });
  f.mixer.sampleMeters();
  assert.equal(f.mixer.getSnapshot().microphone.level, 0);
  f.mixer.setControl('microphone', { muted: false });
  context.state = 'suspended';
  f.mixer.sampleMeters();
  assert.equal(f.mixer.getSnapshot().microphone.level, 0);
  await f.mixer.resume();
  f.mixer.sampleMeters();
  assert.ok(f.mixer.getSnapshot().microphone.level > 0.7);
  assert.equal(context.resumes, 1);
  f.mixer.dispose();
});

test('meter loop is idempotent and cleanup cancels it, closes context and stops only output', async () => {
  const f = fixture(); const sourceTrack = new Track(); const source = new Stream([sourceTrack]);
  f.mixer.setSources({ microphone: media(source), display: null });
  f.mixer.start(); f.mixer.start();
  assert.equal(f.callbacks.size, 1);
  const frame = [...f.callbacks.entries()][0]!; f.callbacks.delete(frame[0]); frame[1](100);
  assert.equal(f.callbacks.size, 1);
  const output = f.context.destination.output;
  f.mixer.dispose(); f.mixer.dispose();
  await Promise.resolve();
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.context.closes, 1);
  assert.equal(output.stops, 1);
  assert.equal(sourceTrack.stops, 0);
  assert.throws(() => f.mixer.getOutputStream(), /disposed/);
});
