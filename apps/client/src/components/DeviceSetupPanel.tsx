import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DeviceSetup, initialSetupState, type AccessState } from '../media/device-setup.js';
import type { CaptureSummary, RecordingStatusSummary, StudioViewId } from '../ui/shell-status.js';
import { CapturePanel, type BusyInputs } from './CapturePanel.js';

export interface DeviceSetupPanelProps {
  activeView?: StudioViewId | undefined;
  settingsPortal?: HTMLElement | null | undefined;
  onOpenSettings?: (() => void) | undefined;
  onCaptureSummaryChange?: ((summary: CaptureSummary) => void) | undefined;
  onRecordingStatusChange?: ((summary: RecordingStatusSummary) => void) | undefined;
}

const permissionLabels: Record<AccessState, string> = {
  unknown: 'Status unavailable — use Check access',
  prompt: 'Ask when checking access',
  granted: 'Allowed by browser',
  denied: 'Blocked — review site permissions',
};

export function DeviceSetupPanel({
  activeView = 'studio',
  settingsPortal = null,
  onOpenSettings,
  onCaptureSummaryChange,
  onRecordingStatusChange,
}: DeviceSetupPanelProps = {}) {
  const controller = useRef<DeviceSetup | null>(null);
  const [captureBusy, setCaptureBusy] = useState<BusyInputs>({ camera: false, microphone: false });
  const [state, setState] = useState(() => initialSetupState(window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof navigator.mediaDevices?.enumerateDevices === 'function'));

  useEffect(() => {
    const media = navigator.mediaDevices;
    const setup = new DeviceSetup({
      secure: window.isSecureContext,
      media: typeof media?.getUserMedia === 'function' && typeof media?.enumerateDevices === 'function' ? media : undefined,
      queryPermission: navigator.permissions?.query ? kind => navigator.permissions.query({ name: kind as PermissionName }) : undefined,
    }, setState);
    controller.current = setup;
    void setup.start();
    const refresh = () => { if (document.visibilityState === 'visible') void setup.refresh(); };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.current = null;
      document.removeEventListener('visibilitychange', refresh);
      setup.dispose();
    };
  }, []);

  const setupSection = (
    <section className="panel setup-panel" aria-labelledby="setup-title">
      <div className="panel-heading">
        <h2 id="setup-title">Set up your inputs</h2>
        <button
          className="secondary button-compact"
          disabled={!state.supported || state.refreshing}
          onClick={() => { void controller.current?.refresh(); }}
        >
          {state.refreshing ? 'Refreshing devices…' : 'Refresh devices'}
        </button>
      </div>
      {!state.supported && (
        <p role="alert" className="error">
          Media access is unavailable. Use Chrome or Edge at the local address printed by the server.
        </p>
      )}
      <div className="device-grid">
        {(['camera', 'microphone'] as const).map(kind => {
          const title = kind === 'camera' ? 'Camera' : 'Microphone';
          const input = state[kind];
          const checkMessage = state.pending === kind && !state.cancelled
            ? 'Waiting for the browser. Allow or dismiss its permission prompt.'
            : input.message;
          return (
            <div key={kind} className="device-input" role="group" aria-labelledby={`${kind}-setup-heading`}>
              <div className="device-input__top">
                <h3 id={`${kind}-setup-heading`}>{title}</h3>
                <p className="permission badge" role="status" aria-label={`${title} permission`}>
                  {permissionLabels[input.permission]}
                </p>
              </div>
              {activeView === 'settings' && (
                <div className="device-input__field">
                  <label htmlFor={`${kind}-device`}>{title} device</label>
                  <select
                    id={`${kind}-device`}
                    value={input.selectedId}
                    disabled={!state.supported || state.pending !== null}
                    onChange={event => controller.current?.select(kind, event.target.value)}
                  >
                    <option value="">System default</option>
                    {input.devices.map(device => (
                      <option key={device.id} value={device.id} disabled={Boolean(device.disabled)}>{device.label}</option>
                    ))}
                    {kind === 'camera' && !input.devices.some(device => Boolean(device.comingSoon)) && (
                      <option value="obs-virtual-camera" disabled>OBS Virtual Camera (Coming soon)</option>
                    )}
                  </select>
                </div>
              )}
              <div className="device-input__footer">
                <button
                  className="secondary button-compact"
                  disabled={!state.supported || state.pending !== null || captureBusy[kind]}
                  onClick={() => { void controller.current?.check(kind); }}
                >
                  Check {kind} access
                </button>
                <p className={checkMessage ? 'device-message' : 'device-message ui-visually-hidden'} role="status" aria-label={`${title} check`}>
                  {checkMessage}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {state.pending && (
        <div className="pending-check">
          <button className="secondary button-compact" disabled={state.cancelled} onClick={() => controller.current?.cancel()}>
            Cancel access check
          </button>
        </div>
      )}
      {state.listError && <p role="alert" className="error">{state.listError}</p>}
    </section>
  );

  return (
    <>
      {settingsPortal ? createPortal(setupSection, settingsPortal) : null}
      <CapturePanel
        cameraId={state.camera.selectedId}
        microphoneId={state.microphone.selectedId}
        cameraDevices={state.camera.devices}
        microphoneDevices={state.microphone.devices}
        devicesSupported={state.supported}
        checkPending={state.pending !== null}
        activeView={activeView}
        settingsPortal={settingsPortal}
        onOpenSettings={onOpenSettings}
        onSelectDevice={(kind, id) => controller.current?.select(kind, id)}
        onBusyChange={setCaptureBusy}
        onCaptureSummaryChange={onCaptureSummaryChange}
        onRecordingStatusChange={onRecordingStatusChange}
      />
    </>
  );
}
