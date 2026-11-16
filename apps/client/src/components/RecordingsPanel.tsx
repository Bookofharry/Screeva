import { useEffect, useRef, useState } from 'react';
import type { RecordingConfiguration, RecordingSession, SessionStatus } from '../../../../packages/shared/src/index.js';
import { loadSessions } from '../api.js';
import { formatBytes } from '../media/recording-engine.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill, type StatusTone } from '../ui/StatusPill.js';
import { formatClockDuration } from '../ui/shell-status.js';

export interface RecordingsPanelProps {
  refreshTrigger?: number | undefined;
  recoveryAttentionCount?: number | undefined;
  onOpenStudio?: (() => void) | undefined;
  onOpenRecovery?: (() => void) | undefined;
}

const layoutLabels: Record<RecordingConfiguration['layout'], string> = {
  screen: 'Screen only',
  camera: 'Camera only',
  pip: 'Picture-in-picture',
  split: 'Side-by-side',
};

const audioLabels: Record<RecordingConfiguration['audioMode'], string> = {
  none: 'No audio',
  microphone: 'Microphone',
  display: 'Shared audio',
  combined: 'Mic + shared audio',
};

const statusLabels: Record<SessionStatus, string> = {
  idle: 'Idle',
  preview: 'Preview',
  recording: 'Recording',
  paused: 'Paused',
  finalizing: 'Finalizing',
  completed: 'Saved WebM',
  interrupted: 'Interrupted',
  recoverable: 'Recoverable',
  failed: 'Failed',
};

function statusTone(status: SessionStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'recording':
      return 'recording';
    case 'paused':
    case 'finalizing':
    case 'interrupted':
    case 'recoverable':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function RecordingsPanel({ refreshTrigger = 0, recoveryAttentionCount = 0, onOpenStudio, onOpenRecovery }: RecordingsPanelProps) {
  const mounted = useRef(false);
  const [items, setItems] = useState<RecordingSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  async function refresh(signal?: AbortSignal): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const page = await loadSessions({ limit: 20, ...(signal ? { signal } : {}) });
      if (mounted.current) {
        setItems(page.items);
        setNextCursor(page.nextCursor);
      }
    } catch (reason) {
      if (signal?.aborted) return;
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : 'Unable to load local recording sessions.');
      }
    } finally {
      if (mounted.current && !signal?.aborted) setLoading(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await loadSessions({ limit: 20, cursor: nextCursor });
      if (mounted.current) {
        setItems(current => {
          const seen = new Set(current.map(item => item.id));
          return [...current, ...page.items.filter(item => !seen.has(item.id))];
        });
        setNextCursor(page.nextCursor);
      }
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : 'Unable to load older sessions.');
      }
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refreshTrigger]);

  return (
    <section className="panel recordings-panel" aria-labelledby="recordings-title">
      <div className="panel-heading recordings-header">
        <div className="recordings-header__intro">
          <div className="compositor-header__title">
            <h2 id="recordings-title">Your local sessions</h2>
            <span className={items.length > 0 ? 'badge capture-active' : 'badge'} role="status" aria-label="Local sessions count">
              {loading ? 'Loading…' : `${items.length} session${items.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <p className="setup-help">
            Durable sessions stored by the local service are listed here, including unfinished attempts and independently verified WebM output metadata.
          </p>
        </div>
        <div className="compositor-header__actions">
          <button className="secondary button-compact" aria-label="Refresh sessions" disabled={loading || loadingMore} onClick={() => { void refresh(); }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {items.length > 0 && onOpenStudio && (
            <button className="button-compact" onClick={onOpenStudio}>
              Go to Studio
            </button>
          )}
        </div>
      </div>
      {recoveryAttentionCount > 0 && onOpenRecovery && (
        <div className="recovery-inline-callout" role="status">
          <div className="recovery-inline-callout__body">
            <strong>
              {recoveryAttentionCount} interrupted session{recoveryAttentionCount === 1 ? '' : 's'} need review
            </strong>
            <p>
              Recovery will distinguish verified salvageable chunks from empty, corrupt, unavailable, or still-active sessions.
            </p>
          </div>
          <button type="button" className="button-compact" onClick={onOpenRecovery}>
            Review Recovery
          </button>
        </div>
      )}
      <p className="recordings-scope-note">
        This library is read-only in the current milestone. Playback, file download, MP4 export, and deletion controls are not implemented yet.
      </p>
      {loading && <p className="setup-help" role="status">Loading local sessions…</p>}
      {error && (
        <div className="recordings-error" role="alert">
          <p className="error">{error}</p>
          <button className="secondary button-compact" disabled={loading || loadingMore} onClick={() => { void refresh(); }}>
            Retry loading sessions
          </button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="empty-state" role="status">
          <span className="empty-state__icon" aria-hidden="true">
            <Icon name="library" size={22} />
          </span>
          <h3>No local sessions yet</h3>
          <p className="setup-help">
            When the local service is connected, Screeva defaults to <strong>Save to computer</strong>. Follow these steps in <strong>Studio</strong> to create a durable local session:
          </p>
          <ol className="how-it-works-grid" aria-label="How to save a video to your computer">
            <li>
              <div className="how-it-works-grid__top">
                <span className="how-it-works-grid__step">1</span>
                <span className="how-it-works-grid__location">Sources &amp; Stage preview</span>
              </div>
              <strong>Connect your sources &amp; layout</strong>
              <span className="how-it-works-grid__chip">
                <Icon name="screen" size={13} />
                <span>Share screen · Camera · Mic</span>
              </span>
              <span>In Studio, start your screen, camera, or microphone and pick a stage layout (PIP, Split, Screen, or Camera).</span>
            </li>
            <li>
              <div className="how-it-works-grid__top">
                <span className="how-it-works-grid__step">2</span>
                <span className="how-it-works-grid__location">Recorder bar</span>
              </div>
              <strong>Confirm &ldquo;Save to computer&rdquo;</strong>
              <span className="how-it-works-grid__chip">
                <Icon name="sliders" size={13} />
                <span>Save to computer · Durable local session</span>
              </span>
              <span>Open Recording options to confirm <strong>Save to computer</strong> and name your video. Quick browser test remains an explicit temporary alternative.</span>
            </li>
            <li>
              <div className="how-it-works-grid__top">
                <span className="how-it-works-grid__step">3</span>
                <span className="how-it-works-grid__location">Recorder bar</span>
              </div>
              <strong>Record &amp; click Stop</strong>
              <span className="how-it-works-grid__chip how-it-works-grid__chip--record">
                <Icon name="record" size={13} />
                <span>Start recording → Stop</span>
              </span>
              <span>Click <strong>Start recording</strong>, then <strong>Stop</strong> when finished. Your verified WebM video is saved on your computer and appears here automatically.</span>
            </li>
          </ol>
          {onOpenStudio && (
            <button aria-label="Return to Studio" onClick={onOpenStudio}>
              Go to Studio
            </button>
          )}
        </div>
      )}
      {!!items.length && (
        <ul className="session-list" aria-label="Recorded local sessions">
          {items.map(item => (
            <li key={item.id} className="session-card">
              <div className="session-card__header">
                <div className="session-card__title-group">
                  <span className="session-card__icon" aria-hidden="true">
                    <Icon name="screen" size={18} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span className="session-card__meta">
                      <time dateTime={item.createdAt}>{item.createdAt.replace('T', ' ').slice(0, 16)}</time>
                      {' · '}
                      {layoutLabels[item.configuration.layout]}
                      {' · '}
                      {item.configuration.resolution} ({item.configuration.fps} fps)
                      {' · '}
                      {audioLabels[item.configuration.audioMode]}
                    </span>
                  </div>
                </div>
                <StatusPill tone={statusTone(item.status)} dot={item.status === 'recording'}>
                  {statusLabels[item.status]}
                </StatusPill>
              </div>
              {item.output ? (
                <div className="session-card__output">
                  <strong>
                    Saved on this computer
                    <span className="ui-visually-hidden"> · Finalized WebM verified</span>
                  </strong>
                  <span>
                    {formatBytes(item.output.byteLength)}
                    {item.output.probe.durationMs !== null ? ` · Duration ${formatClockDuration(item.output.probe.durationMs)}` : ''}
                    {' · '}
                    {item.output.probe.video.width} × {item.output.probe.video.height}
                    {item.output.probe.audio ? ' · Video + audio' : ' · Video only'}
                  </span>
                </div>
              ) : (
                (item.status === 'interrupted' || item.status === 'recoverable' || (item.status !== 'completed' && item.chunks.committedCount > 0)) && (
                  <div className="session-card__actions">
                    <span className="setup-help">
                      Unfinished — the server acknowledged {formatBytes(item.chunks.committedBytes)} in {item.chunks.committedCount} chunk{item.chunks.committedCount === 1 ? '' : 's'}.
                    </span>
                    {onOpenRecovery && (
                      <button className="secondary button-compact" aria-label="Inspect in Recovery" onClick={onOpenRecovery}>
                        Inspect recovery evidence
                      </button>
                    )}
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <div className="actions">
          <button className="secondary button-compact" disabled={loading || loadingMore} onClick={() => { void loadMore(); }}>
            {loadingMore ? 'Loading older sessions…' : 'Load older sessions'}
          </button>
        </div>
      )}
    </section>
  );
}
