import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureManager, browserCaptureEnvironment, initialCaptureState, type CaptureKind, type TrackDetails } from '../media/capture-manager.js';
import type { DeviceOption, InputKind } from '../media/device-setup.js';
import { StreamPreview } from './StreamPreview.js';
import { CompositorPanel } from './CompositorPanel.js';
import { AudioMixerPanel } from './AudioMixerPanel.js';
import { RecordingPanel } from './RecordingPanel.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { DEFAULT_COMPOSITION, type CompositionLayout, type ResolutionPreset } from '../media/compositor.js';
import type { RecordingConfiguration } from '../../../../packages/shared/src/index.js';
import type { CaptureSummary, RecordingStatusSummary, StudioViewId } from '../ui/shell-status.js';

export interface BusyInputs { camera: boolean; microphone: boolean }
interface CapturePanelProps {
  cameraId: string;
  microphoneId: string;
  cameraDevices?: DeviceOption[] | undefined;
  microphoneDevices?: DeviceOption[] | undefined;
  devicesSupported?: boolean | undefined;
  checkPending: boolean;
  activeView?: StudioViewId | undefined;
  settingsPortal?: HTMLElement | null | undefined;
  onOpenSettings?: (() => void) | undefined;
  onSelectDevice?: ((kind: InputKind, id: string) => void) | undefined;
  onBusyChange: (inputs: BusyInputs) => void;
  onCaptureSummaryChange?: ((summary: CaptureSummary) => void) | undefined;
  onRecordingStatusChange?: ((summary: RecordingStatusSummary) => void) | undefined;
}
const titles: Record<CaptureKind, string> = { display: 'Screen', camera: 'Camera', microphone: 'Microphone' };
const sourceIcons: Record<CaptureKind, IconName> = { display: 'screen', camera: 'camera', microphone: 'mic' };

function describeSettings(track: TrackDetails): string {
  const s = track.settings;
  const values = track.kind === 'video'
    ? [s.width !== undefined && s.height !== undefined ? `${s.width} × ${s.height}` : null, s.frameRate !== undefined ? `${Math.round(s.frameRate * 100) / 100} fps` : null, s.displaySurface ? `Source: ${s.displaySurface}` : null]
    : [s.sampleRate !== undefined ? `${s.sampleRate} Hz` : null, s.channelCount !== undefined ? `${s.channelCount} channel(s)` : null, s.echoCancellation !== undefined ? `Echo cancellation: ${s.echoCancellation ? 'on' : 'off'}` : null, s.noiseSuppression !== undefined ? `Noise suppression: ${s.noiseSuppression ? 'on' : 'off'}` : null, s.autoGainControl !== undefined ? `Auto gain: ${s.autoGainControl ? 'on' : 'off'}` : null];
  return values.filter(Boolean).join(' · ') || 'Settings not reported by this browser.';
}

export function CapturePanel({
  cameraId,
  microphoneId,
  cameraDevices = [],
  microphoneDevices = [],
  devicesSupported = true,
  checkPending,
  activeView = 'studio',
  settingsPortal = null,
  onOpenSettings,
  onSelectDevice,
  onBusyChange,
  onCaptureSummaryChange,
  onRecordingStatusChange,
}: CapturePanelProps) {
  const manager = useRef<CaptureManager | null>(null);
  const onBusyChangeRef = useRef(onBusyChange);
  const onCaptureSummaryChangeRef = useRef(onCaptureSummaryChange);
  onBusyChangeRef.current = onBusyChange;
  onCaptureSummaryChangeRef.current = onCaptureSummaryChange;
  const [state, setState] = useState(() => initialCaptureState(browserCaptureEnvironment()));
  const [composedVideo, setComposedVideo] = useState<MediaStream | null>(null);
  const [mixedAudio, setMixedAudio] = useState<MediaStream | null>(null);
  const [composition, setComposition] = useState<{ layout: CompositionLayout; resolution: ResolutionPreset }>({ layout: DEFAULT_COMPOSITION.layout, resolution: DEFAULT_COMPOSITION.preset });
  const [audioMode, setAudioMode] = useState<RecordingConfiguration['audioMode']>('none');
  const [sceneModalSlot, setSceneModalSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const capture = new CaptureManager(browserCaptureEnvironment(), next => {
      setState(next);
      onBusyChangeRef.current({ camera: !!next.camera.stream || next.camera.pending, microphone: !!next.microphone.stream || next.microphone.pending });
      const sources = Object.values(next);
      onCaptureSummaryChangeRef.current?.({
        activeCount: sources.filter(source => !!source.stream).length,
        pendingCount: sources.filter(source => source.pending).length,
      });
    });
    manager.current = capture;
    setState(capture.getSnapshot());
    const leave = () => capture.stopAll();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      capture.dispose();
      manager.current = null;
    };
  }, []);

  const active = Object.values(state).filter(source => source.stream).length;
  const hasAnyTracks = Object.values(state).some(source => source.tracks.length > 0);
  const showTrackDiagnostics = hasAnyTracks || Boolean(state.display.stream);

  const trackDiagnosticsSection = showTrackDiagnostics ? (
    <section className="panel track-diagnostics-panel" aria-labelledby="track-diagnostics-title">
      <div className="panel-heading">
        <h2 id="track-diagnostics-title">Active stream inspector</h2>
        <span className="badge capture-active">{active} active stream(s)</span>
      </div>
      {state.display.stream && (
        <p className="setup-help">
          {state.display.tracks.some(track => track.kind === 'audio')
            ? 'Shared audio track provided and available to the mixer; speaker playback is off.'
            : 'Shared audio unavailable: this source or browser did not provide a live audio track.'}
        </p>
      )}
      {(['display', 'camera', 'microphone'] as const).map(kind => {
        const source = state[kind];
        const title = titles[kind];
        if (!source.tracks.length) return null;
        return (
          <div key={kind} className="track-diagnostics-group">
            <h3>{title}</h3>
            <ul className="track-settings" aria-label={`${title} actual track settings`}>
              {source.tracks.map(track => (
                <li key={track.id}>
                  <strong>{track.label || `${title} ${track.kind} track`}</strong>
                  <span>{describeSettings(track)}{track.muted ? ' · Temporarily muted' : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  ) : null;

  return (
    <>
      {settingsPortal ? createPortal(trackDiagnosticsSection, settingsPortal) : null}
      <div className="studio-grid">
        <div className="studio-stage-column">
          <CompositorPanel
            screen={state.display.stream}
            camera={state.camera.stream}
            readinessSlotRef={setSceneModalSlot}
            onOutputChange={setComposedVideo}
            onConfigChange={setComposition}
          />
          <RecordingPanel
            video={composedVideo}
            audio={mixedAudio}
            activeView={activeView}
            settingsPortal={sceneModalSlot}
            onOpenSettings={onOpenSettings}
            onStatusChange={onRecordingStatusChange}
            configuration={{
              layout: composition.layout,
              resolution: composition.resolution,
              fps: 30,
              videoBitsPerSecond: 2_000_000,
              audioBitsPerSecond: 96_000,
              audioMode,
            }}
          />
        </div>
        <div className="studio-rail-column">
          <section className="panel capture-panel" aria-labelledby="capture-title">
            <div className="panel-heading">
              <h2 id="capture-title">Sources</h2>
              <div className="capture-panel__header-actions">
                <span className={active ? 'badge capture-active' : 'badge'} role="status" aria-label="Capture activity">
                  {active ? `${active} source(s) active` : 'No active capture'}
                </span>
                {(active > 0 || Object.values(state).some(source => source.pending)) && (
                  <button
                    className="secondary button-compact"
                    onClick={() => manager.current?.stopAll()}
                  >
                    Stop all capture
                  </button>
                )}
              </div>
            </div>
            <div className="capture-grid">
              {(['display', 'camera', 'microphone'] as const).map(kind => {
                const source = state[kind];
                const title = titles[kind];
                const primary = source.tracks.find(track => track.kind === (kind === 'microphone' ? 'audio' : 'video'));
                const startLabel = source.stream ? (kind === 'display' ? 'Change shared source' : `Switch ${kind}`) : (kind === 'display' ? 'Share screen' : `Start ${kind}`);
                const deviceOptions = kind === 'camera' ? cameraDevices : kind === 'microphone' ? microphoneDevices : [];
                const selectedDeviceId = kind === 'camera' ? cameraId : kind === 'microphone' ? microphoneId : '';
                const canStopOrCancel = Boolean(source.stream) || (source.pending && source.status !== 'cancelled');
                const isLive = Boolean(source.stream);
                return (
                  <section key={kind} className={isLive ? 'capture-source capture-source--live' : 'capture-source'} aria-labelledby={`${kind}-capture-title`}>
                    <div className="capture-source__row">
                      <div className="capture-source__media">
                        {kind !== 'microphone' && <StreamPreview stream={source.stream} label={`${title} preview`} />}
                        {(kind === 'microphone' || !source.stream) && (
                          <span className={isLive ? 'capture-source__icon capture-source__icon--live' : 'capture-source__icon'} aria-hidden="true">
                            <Icon name={sourceIcons[kind]} size={18} />
                          </span>
                        )}
                      </div>
                      <div className="capture-source__body">
                        <div className="capture-source__top">
                          <h3 id={`${kind}-capture-title`}>{title}</h3>
                          {kind === 'camera' && (
                            <span className="badge badge--coming-soon" aria-disabled="true">
                              OBS Virtual Camera · Coming soon
                            </span>
                          )}
                          <p
                            role="status"
                            aria-label={`${title} capture status`}
                            className={source.status === 'idle' ? 'capture-status ui-visually-hidden' : 'capture-status'}
                          >
                            {source.status === 'active'
                              ? (primary?.muted ? 'Active · source temporarily muted by browser' : 'Active · live capture')
                              : source.status}
                          </p>
                          {kind === 'microphone' && source.stream && (
                            <span className="mic-live-pill">Microphone is active</span>
                          )}
                        </div>
                        {kind === 'display' && !source.stream && (
                          <p className="capture-source__subtitle">Entire screen, window, or browser tab</p>
                        )}
                        {kind !== 'display' && activeView === 'studio' && (
                          <div className="capture-source__device">
                            <label htmlFor={`studio-${kind}-device`} className="ui-visually-hidden">{title} device</label>
                            <select
                              id={`studio-${kind}-device`}
                              value={selectedDeviceId}
                              disabled={!devicesSupported || checkPending}
                              onChange={event => onSelectDevice?.(kind, event.target.value)}
                            >
                              <option value="">System default</option>
                              {deviceOptions.map(device => (
                                <option key={device.id} value={device.id} disabled={Boolean(device.disabled)}>{device.label}</option>
                              ))}
                              {kind === 'camera' && !deviceOptions.some(device => Boolean(device.comingSoon)) && (
                                <option value="obs-virtual-camera" disabled>OBS Virtual Camera (Coming soon)</option>
                              )}
                            </select>
                          </div>
                        )}
                      </div>
                      <div className="capture-actions">
                        <button
                          className={isLive ? 'secondary button-compact' : 'button-compact'}
                          disabled={!source.supported || source.pending || (kind !== 'display' && checkPending)}
                          onClick={() => {
                            void manager.current?.start(kind, kind === 'camera' ? cameraId : kind === 'microphone' ? microphoneId : '');
                          }}
                        >
                          {startLabel}
                        </button>
                        {canStopOrCancel && (
                          <button
                            className="secondary button-compact"
                            onClick={() => manager.current?.stop(kind)}
                          >
                            {source.pending ? `Cancel ${kind} request` : `Stop ${kind}`}
                          </button>
                        )}
                      </div>
                    </div>
                    {source.message && (
                      <p
                        className={source.status === 'error' ? 'error' : 'setup-help'}
                        role={source.status === 'error' ? 'alert' : 'status'}
                        aria-label={`${title} capture feedback`}
                      >
                        {source.message}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </section>
          <AudioMixerPanel
            microphone={state.microphone.stream}
            display={state.display.stream}
            onOutputChange={setMixedAudio}
            onModeChange={setAudioMode}
          />
        </div>
      </div>
    </>
  );
}
