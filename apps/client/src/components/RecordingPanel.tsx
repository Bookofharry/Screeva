import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecordingConfiguration } from '../../../../packages/shared/src/index.js';
import { DurableRecordingEngine, initialDurableRecordingSnapshot, type DurableRecordingStatus } from '../media/durable-recording-engine.js';
import { RecordingEngine, formatBytes, initialRecordingSnapshot, type RecordingStatus } from '../media/recording-engine.js';
import { Icon } from '../ui/Icon.js';
import type { RecordingStatusSummary, StudioViewId } from '../ui/shell-status.js';

interface RecordingPanelProps {
  video: MediaStream | null;
  audio: MediaStream | null;
  configuration: RecordingConfiguration;
  activeView?: StudioViewId | undefined;
  settingsPortal?: HTMLElement | null | undefined;
  onOpenSettings?: (() => void) | undefined;
  onStatusChange?: ((summary: RecordingStatusSummary) => void) | undefined;
}

const temporaryLabels: Record<RecordingStatus, string> = {
  idle: 'Ready', starting: 'Starting', recording: 'Recording', paused: 'Paused', stopping: 'Stopping', completed: 'Completed', failed: 'Failed',
};
const durableLabels: Record<DurableRecordingStatus, string> = {
  idle: 'Ready', creating: 'Creating session', recording: 'Recording', paused: 'Paused', stopping: 'Stopping',
  uploading: 'Uploading', retrying: 'Retrying', finalizing: 'Finalizing', completed: 'Saved', failed: 'Failed',
};

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function RecordingPanel({
  video,
  audio,
  configuration,
  settingsPortal = null,
  onStatusChange,
}: RecordingPanelProps) {
  const temporary = useRef<RecordingEngine | null>(null);
  const durable = useRef<DurableRecordingEngine | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const [mode, setMode] = useState<'durable' | 'temporary'>('temporary');
  const [title, setTitle] = useState('Untitled recording');
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [temporaryState, setTemporaryState] = useState(() => initialRecordingSnapshot());
  const [durableState, setDurableState] = useState(() => initialDurableRecordingSnapshot());

  useEffect(() => {
    if (!optionsModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOptionsModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [optionsModalOpen]);

  useEffect(() => {
    const temporaryRecorder = new RecordingEngine();
    const durableRecorder = new DurableRecordingEngine();
    temporary.current = temporaryRecorder; durable.current = durableRecorder;
    const unsubscribeTemporary = temporaryRecorder.subscribe(setTemporaryState);
    const unsubscribeDurable = durableRecorder.subscribe(setDurableState);
    return () => {
      unsubscribeTemporary(); unsubscribeDurable(); temporaryRecorder.dispose(); void durableRecorder.dispose();
      temporary.current = null; durable.current = null;
    };
  }, []);

  useEffect(() => {
    onStatusChangeRef.current?.({ mode, temporary: temporaryState, durable: durableState });
  }, [mode, temporaryState, durableState]);

  const selectedStatus = mode === 'durable' ? durableState.status : temporaryState.status;
  const recorderStatus = mode === 'durable' ? durableState.recorderStatus : temporaryState.status;
  const active = mode === 'durable'
    ? ['creating', 'recording', 'paused', 'stopping', 'uploading', 'retrying', 'finalizing'].includes(selectedStatus)
    : ['starting', 'recording', 'paused', 'stopping'].includes(selectedStatus);
  const anyActive = active || ['starting', 'recording', 'paused', 'stopping'].includes(temporaryState.status) ||
    ['creating', 'recording', 'paused', 'stopping', 'uploading', 'retrying', 'finalizing'].includes(durableState.status);
  const videoReady = !!video?.getVideoTracks().some(track => track.readyState === 'live');
  const audioReady = !!audio?.getAudioTracks().some(track => track.readyState === 'live');
  const state = mode === 'durable' ? durableState : temporaryState;

  function start() {
    if (mode === 'durable') void durable.current?.start(video, audio, title, configuration);
    else temporary.current?.start(video, audio);
  }
  function pause() { if (mode === 'durable') durable.current?.pause(); else temporary.current?.pause(); }
  function resume() { if (mode === 'durable') durable.current?.resume(); else temporary.current?.resume(); }
  function stop() { if (mode === 'durable') durable.current?.stop(); else temporary.current?.stop(); }
  function reset() { if (mode === 'durable') void durable.current?.reset(); else temporary.current?.reset(); }

  const showQueueTelemetry = mode === 'durable'
    ? (durableState.queuedChunks > 0 || durableState.acknowledgedChunks > 0 || durableState.status !== 'idle')
    : (temporaryState.bytes > 0 || temporaryState.status !== 'idle');

  const recordingDiagnosticsSection = (
    <div className="recorder-readiness-strip" role="region" aria-label="Pipeline readiness">
      <div className="recording-readiness" aria-label="Recorder input readiness">
        <span className={videoReady ? 'ready' : ''}>Canvas video: {videoReady ? 'ready' : 'unavailable'}</span>
        <span className={audioReady ? 'ready' : ''}>Mixed audio: {audioReady ? 'ready' : 'unavailable (video-only recording)'}</span>
        {state.mimeType && (
          <span role="status" aria-label="Recording format">
            Format: {state.mimeType}{state.hasAudio ? ' · video + mixed audio' : ' · video only'}
          </span>
        )}
      </div>
      {showQueueTelemetry && (
        <p className="setup-help">
          {mode === 'durable'
            ? `Queue: ${formatBytes(durableState.outstandingBytes)} in ${durableState.queuedChunks} chunk(s) · Acknowledged: ${durableState.acknowledgedChunks}`
            : `Memory used: ${formatBytes(temporaryState.bytes)} / ${formatBytes(temporaryState.maxBytes)}`}
        </p>
      )}
    </div>
  );

  return (
    <>
      {settingsPortal ? createPortal(recordingDiagnosticsSection, settingsPortal) : null}
      <section className="panel recording-panel" aria-labelledby="recording-title">
        <div className="recording-dock__primary">
          <div className="recording-dock__status">
            <h2 id="recording-title">Recorder</h2>
            <span className={recorderStatus === 'recording' ? 'badge recording-active' : 'badge'} role="status" aria-label="Recording status">
              {mode === 'durable' ? durableLabels[durableState.status] : temporaryLabels[temporaryState.status]}
            </span>
            <div className="recording-clock"><span className="ui-visually-hidden">Duration</span><time dateTime={`PT${Math.round(state.durationMs / 1000)}S`}>{formatDuration(state.durationMs)}</time></div>
          </div>
          <div className="recording-actions">
            <button
              type="button"
              className="secondary button-compact stage-settings-pill"
              aria-label="Recording options"
              aria-haspopup="dialog"
              aria-expanded={optionsModalOpen}
              onClick={() => setOptionsModalOpen(open => !open)}
            >
              <Icon name="sliders" size={14} />
              <span>{mode === 'durable' ? 'Save to computer' : 'Quick browser test'}</span>
            </button>
            <button className="record-trigger" disabled={!videoReady || anyActive || (mode === 'durable' && !title.trim())} onClick={start}>
              {selectedStatus === 'completed' || selectedStatus === 'failed' ? 'Start new recording' : 'Start recording'}
            </button>
            {['starting', 'recording', 'paused'].includes(recorderStatus) && (
              <>
                {recorderStatus === 'recording'
                  ? <button className="secondary" onClick={pause}>Pause</button>
                  : <button className="secondary" disabled={recorderStatus !== 'paused'} onClick={resume}>Resume</button>}
                <button className="secondary" onClick={stop}>Stop</button>
              </>
            )}
            {(selectedStatus === 'completed' || selectedStatus === 'failed') && <button className="secondary" onClick={reset}>Clear status</button>}
          </div>
        </div>
        <div
          className="scene-modal-backdrop"
          hidden={!optionsModalOpen}
          onClick={event => {
            if (event.target === event.currentTarget) setOptionsModalOpen(false);
          }}
        >
          <div className="panel scene-modal" role="dialog" aria-modal="true" aria-labelledby="recording-options-title">
            <div className="panel-heading scene-modal__header">
              <div className="scene-modal__title-group">
                <h2 id="recording-options-title">Recording options</h2>
                <span className="badge">{mode === 'durable' ? 'Save to computer' : 'Quick browser test'}</span>
              </div>
              <button
                type="button"
                className="secondary button-compact scene-modal__close"
                aria-label="Close recording options"
                onClick={() => setOptionsModalOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="recording-modal-body">
              <div className="recording-mode recording-mode--modal" role="radiogroup" aria-label="Save mode">
                <label className={mode === 'durable' ? 'mode-option mode-option--active' : 'mode-option'}>
                  <input
                    type="radio"
                    name="recording-mode"
                    aria-label="Durable local session"
                    checked={mode === 'durable'}
                    disabled={anyActive}
                    onChange={() => setMode('durable')}
                  />
                  <span>
                    <strong>Save to computer</strong>
                    <small>Crash-safe local session saved in Recordings</small>
                  </span>
                </label>
                <label className={mode === 'temporary' ? 'mode-option mode-option--active' : 'mode-option'}>
                  <input
                    type="radio"
                    name="recording-mode"
                    aria-label="Temporary browser preview"
                    checked={mode === 'temporary'}
                    disabled={anyActive}
                    onChange={() => setMode('temporary')}
                  />
                  <span>
                    <strong>Quick browser test</strong>
                    <small>Instant in-browser preview &amp; WebM download</small>
                  </span>
                </label>
              </div>
              {mode === 'durable' && (
                <label className="recording-title-input recording-title-input--modal">
                  <span>Recording name</span>
                  <input placeholder="Untitled recording" maxLength={120} value={title} disabled={active} onChange={event => setTitle(event.target.value)} />
                </label>
              )}
            </div>
            <div className="scene-modal__footer">
              <button type="button" onClick={() => setOptionsModalOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
        {state.error && <p className="error" role="alert">{state.error}</p>}
        {mode === 'durable' && durableState.output && <div className="recording-saved" role="status"><strong>Saved locally</strong><span>Session {durableState.sessionId} · {durableState.acknowledgedChunks} chunks · {formatBytes(durableState.output.byteLength)}</span></div>}
        {mode === 'temporary' && temporaryState.resultUrl && <div className="recording-result">
          <video aria-label="Recorded WebM preview" controls playsInline preload="metadata" src={temporaryState.resultUrl} />
          <div className="recording-result-actions"><a className="download-button" href={temporaryState.resultUrl} download="local-creator-recording.webm">Download WebM</a><span>{formatBytes(temporaryState.resultSize)} · local browser object URL</span></div>
        </div>}
      </section>
    </>
  );
}
