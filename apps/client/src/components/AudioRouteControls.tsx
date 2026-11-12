import type { AudioMixerState, AudioSourceControl, AudioSourceKind } from '../media/audio-mixer.js';
import { Icon } from '../ui/Icon.js';

interface AudioRouteControlsProps {
  kind: AudioSourceKind;
  title: string;
  state: AudioMixerState[AudioSourceKind];
  onChange: (kind: AudioSourceKind, patch: Partial<AudioSourceControl>) => void;
}

export function AudioRouteControls({ kind, title, state, onChange }: AudioRouteControlsProps) {
  const status = !state.available ? 'Off' : state.trackMuted ? 'Muted by browser' : state.muted ? 'Muted' : 'Live';
  const isLive = state.available && !state.muted && !state.trackMuted;
  const idleHint = kind === 'microphone'
    ? 'Start microphone in Sources to adjust level & gain'
    : 'Share screen with tab or system audio to mix';

  return (
    <div className={state.available ? 'audio-route audio-route--active' : 'audio-route audio-route--inactive'} role="group" aria-label={title}>
      <div className="audio-route__header">
        <span className={isLive ? 'capture-source__icon capture-source__icon--live' : 'capture-source__icon'} aria-hidden="true">
          <Icon name={kind === 'microphone' ? 'mic' : 'speaker'} size={18} />
        </span>
        <div className="audio-route__body">
          <div className="audio-route__title">
            <strong>{title}</strong>
            <span
              className={!state.available ? 'ui-visually-hidden' : isLive ? 'capture-status' : 'setup-help'}
              role="status"
              aria-label={`${title} routing status`}
            >
              {status}
            </span>
          </div>
          {!state.available && <p className="capture-source__subtitle">{idleHint}</p>}
        </div>
        <label className="audio-mute" hidden={!state.available}>
          <input
            type="checkbox"
            aria-label={`Mute ${title.toLowerCase()}`}
            checked={state.muted}
            onChange={event => onChange(kind, { muted: event.target.checked })}
          />
          <span>{state.muted ? 'Muted' : 'Mute'}</span>
        </label>
      </div>
      <div className="audio-route__meters" hidden={!state.available}>
        <label>
          <span>Level</span>
          <meter aria-label={`${title} live level`} min={0} max={1} low={0.15} high={0.75} optimum={0.55} value={state.level} />
        </label>
        <label>
          <span>Gain</span>
          <output>{Math.round(state.gain * 100)}%</output>
          <input
            aria-label={`${title} gain`}
            type="range"
            min="0"
            max="200"
            value={Math.round(state.gain * 100)}
            onChange={event => onChange(kind, { gain: Number(event.target.value) / 100 })}
          />
        </label>
      </div>
    </div>
  );
}
