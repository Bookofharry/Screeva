import { useEffect, useRef, useState } from 'react';
import { AudioMixer, initialAudioMixerState, type AudioMixerState, type AudioSourceControl, type AudioSourceKind } from '../media/audio-mixer.js';
import { AudioRouteControls } from './AudioRouteControls.js';

interface AudioMixerPanelProps {
  microphone: MediaStream | null;
  display: MediaStream | null;
  onOutputChange: (stream: MediaStream | null) => void;
  onModeChange?: ((mode: AudioMixerState['mode']) => void) | undefined;
}

const modeLabels: Record<AudioMixerState['mode'], string> = {
  none: 'No audio routed',
  microphone: 'Microphone only',
  display: 'Display audio only',
  combined: 'Microphone + display audio',
};

export function AudioMixerPanel({ microphone, display, onOutputChange, onModeChange }: AudioMixerPanelProps) {
  const engine = useRef<AudioMixer | null>(null);
  const [state, setState] = useState(() => initialAudioMixerState());
  const [error, setError] = useState('');
  const [outputReady, setOutputReady] = useState(false);

  useEffect(() => {
    try {
      const mixer = new AudioMixer();
      engine.current = mixer;
      const output = mixer.getOutputStream();
      const unsubscribe = mixer.subscribe(next => {
        setState(next);
        const ready = next.contextState === 'running' && output.getAudioTracks().some(track => track.readyState === 'live');
        onOutputChange(ready ? output : null);
        setOutputReady(ready);
      });
      mixer.start();
      return () => {
        unsubscribe();
        onOutputChange(null);
        mixer.dispose();
        engine.current = null;
      };
    } catch {
      onOutputChange(null);
      setError('Web Audio mixing is unavailable in this browser. Capture remains independently controllable.');
      setState(initialAudioMixerState());
      return;
    }
  }, [onOutputChange]);

  useEffect(() => { engine.current?.setSources({ microphone, display }); }, [microphone, display]);
  useEffect(() => { onModeChange?.(state.mode); }, [state.mode, onModeChange]);

  function changeControl(kind: AudioSourceKind, patch: Partial<AudioSourceControl>) {
    const mixer = engine.current;
    if (!mixer) return;
    mixer.setControl(kind, patch);
    void mixer.resume().catch(() => {
      if (engine.current === mixer) setError('Audio processing is paused. Click Enable audio processing and allow browser audio playback.');
    });
  }

  function resume() {
    setError('');
    const mixer = engine.current;
    if (!mixer) return;
    void mixer.resume().catch(() => {
      if (engine.current === mixer) setError('Audio processing could not start. Interact with this page and try again.');
    });
  }

  return <section className="panel audio-mixer-panel" aria-labelledby="audio-mixer-title">
    <div className="panel-heading">
      <h2 id="audio-mixer-title">Audio levels</h2>
      <span className={state.mode === 'none' ? 'badge' : 'badge capture-active'} role="status" aria-label="Audio mix mode">{modeLabels[state.mode]}</span>
    </div>
    <p className={outputReady ? 'ui-visually-hidden' : 'setup-help audio-mixer-status'} role="status" aria-label="Mixed audio output status">
      {outputReady
        ? 'Mixed output stream ready for the recorder.'
        : state.contextState === 'suspended'
          ? 'Audio processing is paused. Enable it before recording if you want audio.'
          : 'Mixed output stream unavailable.'}
    </p>
    {state.contextState !== 'running' && !error && (
      <div className="audio-resume">
        <button className="secondary button-compact" onClick={resume}>Enable audio processing</button>
      </div>
    )}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="audio-routes">
      <AudioRouteControls kind="microphone" title="Microphone" state={state.microphone} onChange={changeControl} />
      <AudioRouteControls kind="display" title="Display audio" state={state.display} onChange={changeControl} />
    </div>
  </section>;
}
