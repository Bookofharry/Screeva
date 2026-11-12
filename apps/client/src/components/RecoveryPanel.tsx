import { useEffect, useRef, useState } from 'react';
import type { RecoveryInspection } from '../../../../packages/shared/src/index.js';
import { RecoveryClient } from '../media/recovery-client.js';
import { formatBytes } from '../media/recording-engine.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';

export interface RecoveryPanelProps {
  refreshTrigger?: number | undefined;
  onItemsChange?: ((items: RecoveryInspection[]) => void) | undefined;
  onSalvaged?: (() => void) | undefined;
}

export function RecoveryPanel({ refreshTrigger = 0, onItemsChange, onSalvaged }: RecoveryPanelProps = {}) {
  const client = useRef<RecoveryClient | null>(null);
  const mounted = useRef(false);
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  const [items, setItems] = useState<RecoveryInspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function refresh(current = client.current): Promise<void> {
    if (!current) return;
    setLoading(true); setError('');
    try {
      const next = await current.list();
      if (mounted.current) {
        setItems(next);
        onItemsChangeRef.current?.(next);
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Recovery inspection failed.');
    } finally { if (mounted.current) setLoading(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const recovery = new RecoveryClient({ fetch: (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }) });
    client.current = recovery;
    void refresh(recovery);
    return () => { mounted.current = false; controller.abort(); client.current = null; };
  }, []);

  useEffect(() => {
    if (refreshTrigger > 0 && client.current) {
      void refresh(client.current);
    }
  }, [refreshTrigger]);

  async function salvage(item: RecoveryInspection): Promise<void> {
    if (!client.current || busy) return;
    setBusy(item.sessionId); setError('');
    try {
      await client.current.salvage(item.sessionId);
      await refresh();
      onSalvaged?.();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Best-effort salvage failed.'); }
    finally { if (mounted.current) setBusy(''); }
  }

  return (
    <section className="panel recovery-panel" aria-labelledby="recovery-title">
      <div className="panel-heading">
        <div>
          <h2 id="recovery-title">Restore unfinished videos</h2>
          <p className="setup-help">
            If your browser closed or lost power while recording with <strong>Save to computer</strong>, your auto-saved video pieces can be stitched back together here.
          </p>
        </div>
        <button className="secondary button-compact" disabled={loading || !!busy} onClick={() => { void refresh(); }}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {loading && <p className="setup-help" role="status">Checking for interrupted recordings…</p>}
      {!loading && !items.length && (
        <div className="empty-state" role="status">
          <span className="empty-state__icon empty-state__icon--ok" aria-hidden="true">
            <Icon name="check" size={22} />
          </span>
          <h3>All your videos are safe</h3>
          <p className="setup-help">
            You have no interrupted recordings waiting to be restored.
          </p>
          <ol className="how-it-works-grid" aria-label="How auto-save recovery works">
            <li>
              <span className="how-it-works-grid__step">1</span>
              <strong>Auto-saved every second</strong>
              <span>While recording in Save to computer mode, pieces of your video are saved continuously.</span>
            </li>
            <li>
              <span className="how-it-works-grid__step">2</span>
              <strong>Protected from crashes</strong>
              <span>If your browser closes or battery dies before you click Stop, those pieces stay on your drive.</span>
            </li>
            <li>
              <span className="how-it-works-grid__step">3</span>
              <strong>One-click restore</strong>
              <span>Come here anytime after a crash to stitch those pieces into a finished video in Recordings.</span>
            </li>
          </ol>
        </div>
      )}
      {!!items.length && (
        <ul className="recovery-list">
          {items.map(item => (
            <li key={item.sessionId} className="recovery-card">
              <div className="recovery-card__header">
                <div className="session-card__title-group">
                  <span className="session-card__icon" aria-hidden="true">
                    <Icon name="recover" size={18} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {formatBytes(item.verifiedBytes)} auto-saved ({item.contiguousChunkCount} of {item.committedChunkCount} piece{item.committedChunkCount === 1 ? '' : 's'} ready)
                      <small className="ui-visually-hidden"> · {item.condition}</small>
                    </span>
                  </div>
                </div>
                <StatusPill tone={item.recoverable ? 'warning' : 'danger'}>
                  {item.recoverable ? 'Ready to restore' : 'Nothing saved yet'}
                </StatusPill>
              </div>
              <div className="recovery-card__footer">
                <p>
                  {item.recoverable
                    ? 'This recording stopped before finishing. Click Restore video to save the recovered WebM to your Recordings page.'
                    : item.message}
                </p>
                <button
                  aria-label="Salvage acknowledged chunks"
                  disabled={!item.recoverable || item.activeOperation || !!busy}
                  onClick={() => { void salvage(item); }}
                >
                  {busy === item.sessionId ? 'Restoring…' : 'Restore video'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
