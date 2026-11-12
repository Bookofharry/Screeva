export type InputKind = 'camera' | 'microphone';
export type AccessState = PermissionState | 'unknown';
export interface DeviceOption {
  id: string;
  label: string;
  disabled?: boolean | undefined;
  comingSoon?: boolean | undefined;
}
interface InputState {
  permission: AccessState;
  devices: DeviceOption[];
  selectedId: string;
  message: string;
}
export interface SetupState {
  supported: boolean;
  refreshing: boolean;
  listError: string;
  pending: InputKind | null;
  cancelled: boolean;
  camera: InputState;
  microphone: InputState;
}
export interface DeviceInfo { deviceId: string; label: string; kind: MediaDeviceKind }
interface CheckStream { getTracks(): Pick<MediaStreamTrack, 'stop' | 'kind' | 'readyState'>[] }
export interface DeviceAccess extends EventTarget {
  enumerateDevices(): Promise<readonly DeviceInfo[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<CheckStream>;
}
export interface PermissionHandle extends EventTarget { readonly state: PermissionState }
export interface SetupEnvironment {
  secure: boolean;
  media: DeviceAccess | undefined;
  queryPermission: ((kind: InputKind) => Promise<PermissionHandle>) | undefined;
}

export function initialSetupState(supported: boolean): SetupState {
  const input = (): InputState => ({ permission: 'unknown', devices: [], selectedId: '', message: '' });
  return { supported, refreshing: false, listError: '', pending: null, cancelled: false, camera: input(), microphone: input() };
}

export function isComingSoonDevice(label: string, kind: InputKind): boolean {
  return kind === 'camera' && /obs\s*virtual\s*camera/i.test(label);
}

export function deviceOptions(devices: readonly DeviceInfo[], kind: InputKind): DeviceOption[] {
  const seen = new Set<string>();
  return devices.filter(device => {
    if (device.kind !== (kind === 'camera' ? 'videoinput' : 'audioinput') || !device.deviceId || seen.has(device.deviceId)) return false;
    seen.add(device.deviceId);
    return true;
  }).map((device, index) => {
    const baseLabel = device.label || `${kind === 'camera' ? 'Camera' : 'Microphone'} ${index + 1} (name hidden)`;
    if (isComingSoonDevice(baseLabel, kind)) {
      const label = /\bcoming soon\b/i.test(baseLabel) ? baseLabel : `${baseLabel} (Coming soon)`;
      return { id: device.deviceId, label, disabled: true, comingSoon: true };
    }
    return { id: device.deviceId, label: baseLabel };
  });
}

export function accessError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError': case 'SecurityError':
      return 'Access was not allowed. Review this site’s browser permissions and Windows camera or microphone privacy settings, then try again.';
    case 'NotFoundError':
      return 'No matching input is available. Connect a device, refresh the list, and try again.';
    case 'NotReadableError':
      return 'The device could not be opened. Close other apps using it and check Windows privacy settings.';
    case 'OverconstrainedError':
      return 'The selected device is no longer available. Refresh the list and choose another input.';
    case 'AbortError':
      return 'The access check was interrupted. Try again when the device is ready.';
    default:
      return 'The access check failed. Check your device and browser settings, then try again.';
  }
}

// No stream is retained: this controller only checks access and discovers inputs.
export class DeviceSetup {
  private state: SetupState;
  private disposed = false;
  private started = false;
  private refreshVersion = 0;
  private cleanups: (() => void)[] = [];

  constructor(private readonly environment: SetupEnvironment, private readonly publish: (state: SetupState) => void) {
    this.state = initialSetupState(environment.secure && !!environment.media);
  }

  private update(patch: Partial<SetupState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.publish(this.state);
  }

  private updateInput(kind: InputKind, patch: Partial<InputState>): void {
    this.update({ [kind]: { ...this.state[kind], ...patch } });
  }

  async start(): Promise<void> {
    if (this.disposed || this.started) return;
    this.started = true;
    this.update({});
    if (!this.state.supported) return;
    const onDevices = () => { void this.refresh(); };
    this.environment.media?.addEventListener('devicechange', onDevices);
    this.cleanups.push(() => this.environment.media?.removeEventListener('devicechange', onDevices));
    await Promise.all([this.refresh(), this.watchPermission('camera'), this.watchPermission('microphone')]);
  }

  private async watchPermission(kind: InputKind): Promise<void> {
    try {
      const status = await this.environment.queryPermission?.(kind);
      if (!status || this.disposed) return;
      const onChange = () => {
        this.updateInput(kind, { permission: status.state, ...(this.state.cancelled && this.state.pending === kind ? {} : { message: '' }) });
        void this.refresh();
      };
      status.addEventListener('change', onChange);
      this.cleanups.push(() => status.removeEventListener('change', onChange));
      this.updateInput(kind, { permission: status.state });
    } catch {
      // Unsupported Permissions API queries must not disable explicit access checks.
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.state.supported || !this.environment.media) return;
    const version = ++this.refreshVersion;
    this.update({ refreshing: true, listError: '' });
    try {
      const devices = await this.environment.media.enumerateDevices();
      if (this.disposed || version !== this.refreshVersion) return;
      for (const kind of ['camera', 'microphone'] as const) {
        const options = deviceOptions(devices, kind);
        const current = options.find(device => device.id === this.state[kind].selectedId);
        const missing = this.state[kind].selectedId !== '' && (!current || Boolean(current.disabled));
        this.updateInput(kind, {
          devices: options,
          ...(missing ? { selectedId: '', message: 'Your selected input is no longer listed. System default is selected; check it before continuing.' } : {}),
        });
      }
    } catch {
      if (version === this.refreshVersion) this.update({ listError: 'Could not refresh devices. The previous list may be out of date. Check browser settings and retry.' });
    } finally {
      if (version === this.refreshVersion) this.update({ refreshing: false });
    }
  }

  select(kind: InputKind, id: string): void {
    const selected = this.state[kind].devices.find(device => device.id === id);
    if (this.disposed || this.state.pending || (id !== '' && (!selected || Boolean(selected.disabled)))) return;
    this.updateInput(kind, { selectedId: id, message: '' });
  }

  async check(kind: InputKind): Promise<void> {
    if (this.disposed || this.state.pending || !this.state.supported || !this.environment.media) return;
    this.update({ pending: kind, cancelled: false });
    this.updateInput(kind, { message: '' });
    const id = this.state[kind].selectedId;
    const constraints = id ? { deviceId: { exact: id } } : true;
    try {
      // Called directly from a click handler; no await before the browser request.
      const stream = await this.environment.media.getUserMedia(kind === 'camera' ? { video: constraints, audio: false } : { audio: constraints, video: false });
      let live = false;
      try {
        live = stream.getTracks().some(track => track.kind === (kind === 'camera' ? 'video' : 'audio') && track.readyState === 'live');
      } finally {
        // Also release results that arrive after cancellation, unmount or navigation.
        for (const track of stream.getTracks()) track.stop();
      }
      if (this.disposed || this.state.cancelled) return;
      if (!live) throw new DOMException('No live input', 'NotFoundError');
      this.updateInput(kind, { message: 'Access check passed. The input has been released; nothing is recording.' });
      void this.refresh();
    } catch (error) {
      if (!this.disposed && !this.state.cancelled) this.updateInput(kind, { message: accessError(error) });
    } finally {
      this.update({ pending: null });
    }
  }

  cancel(): void {
    if (!this.state.pending || this.disposed) return;
    this.updateInput(this.state.pending, { message: 'Check cancelled. Dismiss any browser prompt. If permission is granted later, the input will be released immediately.' });
    // getUserMedia has no abort API: keep requests serialized until it settles.
    this.update({ cancelled: true });
  }

  dispose(): void {
    this.disposed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }
}
