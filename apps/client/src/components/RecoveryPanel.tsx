import { useEffect, useRef, useState } from 'react';
import type { RecoveryInspection } from '../../../../packages/shared/src/index.js';
import { isStaticBrowserHost } from '../api.js';
import { RecoveryClient } from '../media/recovery-client.js';
import { formatBytes } from '../media/recording-engine.js';
import { Icon } from '../ui/Icon.js';
import { describeRecoveryCondition } from '../ui/recovery-ui.js';
import { StatusPill } from '../ui/StatusPill.js';

export interface RecoveryPanelProps {
  refreshTrigger?: number | undefined;
  onItemsChange?: ((items: RecoveryInspection[]) => void) | undefined;
  onSalvaged?: (() => void) | undefined;
}

export function RecoveryPanel({ refreshTrigger = 0, onItemsChange, onSalvaged }: RecoveryPanelProps = {}) {
  const client = useRef<RecoveryClient | null>(null);
  const mounted = useRef(false);
  const activeRefreshTimer = useRef<number | null>(null);
  const followActiveUntil = useRef(0);
  const refreshGeneration = useRef(0);
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  const [items, setItems] = useState<RecoveryInspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function refresh(current = client.current): Promise<void> {
    const generation = ++refreshGeneration.current;
    if (activeRefreshTimer.current !== null) window.clearTimeout(activeRefreshTimer.current);
    activeRefreshTimer.current = null;
    if (isStaticBrowserHost()) {
      if (mounted.current && generation === refreshGeneration.current) {
        setItems([]);
        onItemsChangeRef.current?.([]);
        setLoading(false);
      }
      return;
    }
    if (!current) return;
    setLoading(true); setError('');
    try {
      const next = await current.list();
      if (mounted.current && generation === refreshGeneration.current) {
        setItems(next);
        onItemsChangeRef.current?.(next);
        if (next.some(item => item.condition === 'active') && Date.now() < followActiveUntil.current) {
          activeRefreshTimer.current = window.setTimeout(() => { void refresh(current); }, 1_000);
        } else if (!next.some(item => item.condition === 'active')) {
          followActiveUntil.current = 0;
        }
      }
    } catch (reason) {
      if (mounted.current && generation === refreshGeneration.current) setError(reason instanceof Error ? reason.message : 'Recovery inspection failed.');
    } finally { if (mounted.current && generation === refreshGeneration.current) setLoading(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const recovery = new RecoveryClient({ fetch: (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }) });
    client.current = recovery;
    followActiveUntil.current = Date.now() + 12_000;
    void refresh(recovery);
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      controller.abort();
      if (activeRefreshTimer.current !== null) window.clearTimeout(activeRefreshTimer.current);
      activeRefreshTimer.current = null;
      followActiveUntil.current = 0;
      client.current = null;
    };
  }, []);

  useEffect(() => {
    if (refreshTrigger > 0 && client.current) {
      followActiveUntil.current = Date.now() + 12_000;
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
            Recovery can salvage only contiguous chunks already acknowledged and independently verified by the local server. Data that remained only in browser memory was never received and cannot be recovered.
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
          <h3>No unfinished server sessions found</h3>
          <p className="setup-help">
            The local service currently reports no incomplete durable sessions. This cannot detect recording data that never reached the server.
          </p>
          <ol className="how-it-works-grid" aria-label="How auto-save recovery works">
            <li>
              <span className="how-it-works-grid__step">1</span>
              <strong>Acknowledged chunks only</strong>
              <span>During Save to computer recording, the browser releases a chunk only after the local server durably acknowledges it.</span>
            </li>
            <li>
              <span className="how-it-works-grid__step">2</span>
              <strong>Browser-only data can be lost</strong>
              <span>If the browser closes, queued or still-encoding data that was never acknowledged is not recoverable.</span>
            </li>
            <li>
              <span className="how-it-works-grid__step">3</span>
              <strong>Best-effort salvage</strong>
              <span>Explicit salvage rechecks every acknowledged chunk and requires a successful media probe before completion.</span>
            </li>
          </ol>
        </div>
      )}
      {!!items.length && (
        <ul className="recovery-list">
          {items.map(item => {
            const condition = describeRecoveryCondition(item.condition);
            return <li key={item.sessionId} className="recovery-card">
              <div className="recovery-card__header">
                <div className="session-card__title-group">
                  <span className="session-card__icon" aria-hidden="true">
                    <Icon name="recover" size={18} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {formatBytes(item.verifiedBytes)} verified · {item.contiguousChunkCount} contiguous of {item.committedChunkCount} committed chunk{item.committedChunkCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
                <StatusPill tone={condition.tone} statusLabel={`${item.title} recovery condition`}>
                  {condition.label}
                </StatusPill>
              </div>
              <div className="recovery-card__footer">
                <p>
                  <strong>{condition.detail}</strong>{' '}
                  {item.message}
                  {item.recoverable ? ' Salvage remains best-effort and is complete only after FFprobe accepts the assembled WebM.' : ''}
                </p>
                <button
                  aria-label="Salvage acknowledged chunks"
                  disabled={!item.recoverable || item.activeOperation || !!busy}
                  onClick={() => { void salvage(item); }}
                >
                  {busy === item.sessionId ? 'Salvaging…' : 'Salvage acknowledged chunks'}
                </button>
              </div>
            </li>;
          })}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
