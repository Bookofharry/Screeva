export type CaptureKind = 'display' | 'camera' | 'microphone';
export type CaptureStatus = 'idle' | 'requesting' | 'active' | 'ended' | 'error' | 'cancelled' | 'unsupported';
export interface TrackDetails {
  id: string;
  kind: string;
  label: string;
  muted: boolean;
  settings: MediaTrackSettings;
}
export interface CaptureSource {
  supported: boolean;
  status: CaptureStatus;
  pending: boolean;
  stream: MediaStream | null;
  tracks: TrackDetails[];
  message: string;
}
export type CaptureState = Record<CaptureKind, CaptureSource>;
export interface CaptureEnvironment {
  secure: boolean;
  getDisplayMedia: ((options: DisplayMediaStreamOptions) => Promise<MediaStream>) | undefined;
  getUserMedia: ((options: MediaStreamConstraints) => Promise<MediaStream>) | undefined;
  devices: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'> | undefined;
}
interface OwnedSource {
  stream: MediaStream;
  tracks: Set<MediaStreamTrack>;
  selectedId: string;
  cleanup: (() => void)[];
}
const kinds: CaptureKind[] = ['display', 'camera', 'microphone'];

export function initialCaptureState(environment: CaptureEnvironment): CaptureState {
  const source = (available: boolean): CaptureSource => ({
    supported: environment.secure && available,
    status: environment.secure && available ? 'idle' : 'unsupported',
    pending: false, stream: null, tracks: [],
    message: environment.secure && available ? '' : 'Capture is unavailable. Use Chrome or Edge at the local server address.',
  });
  return { display: source(!!environment.getDisplayMedia), camera: source(!!environment.getUserMedia), microphone: source(!!environment.getUserMedia) };
}

export function captureError(error: unknown, kind: CaptureKind): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError': case 'SecurityError':
      return kind === 'display' ? 'Sharing was cancelled or denied. Click Share screen to choose a source again; check browser permissions if it stays blocked.' : 'Capture was not allowed. Review this site’s browser permissions and Windows privacy settings, then try again.';
    case 'NotFoundError': return 'No live source was available. Connect the input or choose another source and try again.';
    case 'NotReadableError': return 'The source could not be opened. Close other apps using it and check OS capture/privacy settings.';
    case 'OverconstrainedError': return 'The selected device is unavailable. Refresh devices and select another input.';
    case 'InvalidStateError': return 'Use the capture button in this active tab to open the browser picker.';
    case 'NotSupportedError': return 'This browser cannot open that capture source. Try current desktop Chrome or Edge at the local address.';
    case 'AbortError': return 'Capture was interrupted before it started. Try again when the source is ready.';
    default: return 'Capture failed. Check your device and browser settings, then try again.';
  }
}

export function browserCaptureEnvironment(): CaptureEnvironment {
  const media = navigator.mediaDevices;
  return {
    secure: window.isSecureContext,
    getDisplayMedia: typeof media?.getDisplayMedia === 'function' ? options => media.getDisplayMedia(options) : undefined,
    getUserMedia: typeof media?.getUserMedia === 'function' ? options => media.getUserMedia(options) : undefined,
    devices: typeof media?.enumerateDevices === 'function' ? media : undefined,
  };
}

/** Sole owner of sustained streams. Never receives permission-check streams. */
export class CaptureManager {
  private state: CaptureState;
  private disposed = false;
  private readonly owned = new Map<CaptureKind, OwnedSource>();
  private readonly generations: Record<CaptureKind, number> = { display: 0, camera: 0, microphone: 0 };
  private readonly requestedDevices: Record<CaptureKind, string> = { display: '', camera: '', microphone: '' };
  private deviceRevision = 0;
  private readonly onDevices = () => { void this.checkDevices(); };

  constructor(private readonly environment: CaptureEnvironment, private readonly publish: (state: CaptureState) => void) {
    this.state = initialCaptureState(environment);
    environment.devices?.addEventListener('devicechange', this.onDevices);
  }

  getSnapshot(): CaptureState { return this.state; }

  private update(kind: CaptureKind, patch: Partial<CaptureSource>): void {
    if (this.disposed) return;
    this.state = { ...this.state, [kind]: { ...this.state[kind], ...patch } };
    this.publish(this.state);
  }

  private release(kind: CaptureKind): void {
    const owned = this.owned.get(kind);
    if (!owned) return;
    this.owned.delete(kind);
    for (const cleanup of owned.cleanup) cleanup();
    // Include removed tracks and tracks added since the last event.
    for (const track of new Set([...owned.tracks, ...owned.stream.getTracks()])) track.stop();
  }

  async start(kind: CaptureKind, selectedId = ''): Promise<void> {
    if (this.disposed || !this.state[kind].supported || this.state[kind].pending) return;
    const generation = ++this.generations[kind];
    this.requestedDevices[kind] = selectedId;
    this.release(kind);
    this.update(kind, { status: 'requesting', pending: true, stream: null, tracks: [], message: kind === 'display' ? 'Choose a screen, window or tab in the browser picker.' : 'Waiting for the browser to open your selected input.' });
    let candidate: MediaStream | undefined;
    try {
      const device = selectedId ? { deviceId: { exact: selectedId } } : true;
      // No await before invoking the API: preserve the click's transient activation.
      candidate = await (kind === 'display'
        ? this.environment.getDisplayMedia!({ video: true, audio: true })
        : this.environment.getUserMedia!(kind === 'camera' ? { video: device, audio: false } : { audio: device, video: false }));
      if (this.disposed || generation !== this.generations[kind]) return;
      const required = kind === 'microphone' ? 'audio' : 'video';
      if (!candidate.getTracks().some(track => track.kind === required && track.readyState === 'live')) throw new DOMException('No live source', 'NotFoundError');
      // Reject and release unexpected input types. Display audio is optional and owned.
      if (kind !== 'display') {
        for (const track of candidate.getTracks()) if (track.kind !== required) { track.stop(); candidate.removeTrack(track); }
      }
      const owned: OwnedSource = { stream: candidate, tracks: new Set(), selectedId, cleanup: [] };
      this.owned.set(kind, owned);
      this.observe(kind, owned);
      candidate = undefined; // Ownership transferred; finally only disposes unaccepted results.
      this.update(kind, { status: 'active', stream: owned.stream, message: '' });
      this.refresh(kind);
    } catch (error) {
      if (!this.disposed && generation === this.generations[kind]) {
        this.release(kind);
        this.update(kind, { status: 'error', stream: null, tracks: [], message: captureError(error, kind) });
      }
    } finally {
      if (candidate) for (const track of candidate.getTracks()) track.stop();
      // New requests for this source remain blocked until this native prompt settles.
      this.update(kind, { pending: false });
    }
  }

  private observe(kind: CaptureKind, owned: OwnedSource): void {
    const bind = (track: MediaStreamTrack) => {
      if (owned.tracks.has(track)) return;
      owned.tracks.add(track);
      const changed = () => { if (this.owned.get(kind) === owned) this.refresh(kind); };
      for (const event of ['ended', 'mute', 'unmute']) {
        track.addEventListener(event, changed);
        owned.cleanup.push(() => track.removeEventListener(event, changed));
      }
    };
    for (const track of owned.stream.getTracks()) bind(track);
    const changed = () => {
      if (this.owned.get(kind) !== owned) return;
      for (const track of owned.stream.getTracks()) bind(track);
      for (const track of owned.tracks) if (!owned.stream.getTracks().includes(track)) track.stop();
      this.refresh(kind);
    };
    for (const event of ['addtrack', 'removetrack', 'inactive']) {
      owned.stream.addEventListener(event, changed);
      owned.cleanup.push(() => owned.stream.removeEventListener(event, changed));
    }
    // Browser surface switches/resizes can change settings without replacing the track.
    const timer = setInterval(() => { if (this.owned.get(kind) === owned) this.refresh(kind); }, 1000);
    owned.cleanup.push(() => clearInterval(timer));
  }

  refresh(kind: CaptureKind): void {
    const owned = this.owned.get(kind);
    if (this.disposed || !owned) return;
    const live = owned.stream.getTracks().filter(track => track.readyState === 'live');
    if (!live.some(track => track.kind === (kind === 'microphone' ? 'audio' : 'video'))) {
      this.finish(kind, 'ended', kind === 'display' ? 'Screen sharing ended in the browser or the source became unavailable.' : 'The input ended or disconnected. Choose an available device and start it again.');
      return;
    }
    const tracks = live.map(track => ({ id: track.id, kind: track.kind, label: track.label, muted: track.muted, settings: { ...track.getSettings() } }));
    if (JSON.stringify(tracks) !== JSON.stringify(this.state[kind].tracks)) this.update(kind, { tracks });
  }

  private finish(kind: CaptureKind, status: CaptureStatus, message: string): void {
    ++this.generations[kind];
    this.release(kind);
    this.update(kind, { status, stream: null, tracks: [], message });
  }

  stop(kind: CaptureKind): void {
    if (this.disposed || !this.state[kind].supported) return;
    const pending = this.state[kind].pending;
    this.finish(kind, pending ? 'cancelled' : 'idle', pending
      ? 'Request cancelled. Dismiss the browser prompt; any source granted later will be stopped immediately.'
      : 'Capture stopped. All source tracks released.');
  }

  stopAll(): void { for (const kind of kinds) this.stop(kind); }

  async checkDevices(): Promise<void> {
    if (this.disposed || !this.environment.devices) return;
    const revision = ++this.deviceRevision;
    const before = new Map(this.owned);
    const requests = { ...this.generations };
    try {
      const devices = await this.environment.devices.enumerateDevices();
      if (this.disposed || revision !== this.deviceRevision) return;
      for (const kind of ['camera', 'microphone'] as const) {
        const available = devices.filter(device => device.kind === (kind === 'camera' ? 'videoinput' : 'audioinput'));
        if (this.state[kind].status === 'requesting' && requests[kind] === this.generations[kind] && this.requestedDevices[kind] && !available.some(device => device.deviceId === this.requestedDevices[kind])) {
          this.finish(kind, 'cancelled', 'The requested device disappeared. Dismiss the browser prompt; any late result will be stopped.');
        }
        const owned = before.get(kind);
        if (!owned || this.owned.get(kind) !== owned) continue;
        const deviceId = owned.stream.getTracks()[0]?.getSettings().deviceId || owned.selectedId;
        if (deviceId && !available.some(device => device.deviceId === deviceId)) {
          this.finish(kind, 'ended', 'The active device is no longer available. Capture stopped; select a device and start again.');
        }
      }
    } catch {
      if (this.disposed || revision !== this.deviceRevision) return;
      for (const [kind, owned] of before) if (kind !== 'display' && this.owned.get(kind) === owned) {
        this.update(kind, { message: 'Could not verify connected devices. Capture remains active; refresh the device list or stop it manually.' });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.environment.devices?.removeEventListener('devicechange', this.onDevices);
    for (const kind of kinds) { ++this.generations[kind]; this.release(kind); }
  }
}
