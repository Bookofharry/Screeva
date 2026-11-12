import type { Capabilities } from '../../../../packages/shared/src/index.js';

export interface SettingsPanelProps {
  capabilities: Capabilities | null;
  error: string;
  checking: boolean;
  checkResult: string;
  onRetryConnection: () => void;
  onRunWriteCheck: () => void;
}

export function SettingsPanel({
  capabilities,
  error,
  checking,
  checkResult,
  onRetryConnection,
  onRunWriteCheck,
}: SettingsPanelProps) {
  return (
    <section className="panel settings-panel" aria-labelledby="status-title">
      <div className="panel-heading">
        <h2 id="status-title">Your local workspace</h2>
        <span className="badge">{error ? 'Service offline' : capabilities ? 'Service ready' : 'Connecting…'}</span>
      </div>
      <dl className="workspace-metrics">
        <div className="workspace-metric">
          <dt>Local service</dt>
          <dd>{error ? 'Offline · Check server' : capabilities ? 'Online · Loopback' : 'Connecting to loopback…'}</dd>
        </div>
        <div className="workspace-metric">
          <dt>Metadata storage</dt>
          <dd>{capabilities ? 'Ready · SQLite' : 'Not verified'}</dd>
        </div>
        <div className="workspace-metric">
          <dt>Recording</dt>
          <dd>Temporary + durable WebM</dd>
        </div>
        <div className="workspace-metric">
          <dt>MP4 export</dt>
          <dd className="muted">Not implemented</dd>
        </div>
      </dl>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="workspace-verify">
        <div className="actions">
          {error ? (
            <button onClick={onRetryConnection}>Retry connection</button>
          ) : (
            <button className="secondary button-compact" disabled={!capabilities || checking} onClick={onRunWriteCheck}>
              {checking ? 'Checking…' : 'Check local access'}
            </button>
          )}
          <p className="result" role="status" aria-label="Local access check">
            {checkResult || 'Verifies authenticated local storage without capturing media.'}
          </p>
        </div>
      </div>
      <details className="ui-disclosure settings-disclosure">
        <summary id="privacy-boundaries-title">Local-only security &amp; storage boundaries</summary>
        <div className="ui-disclosure__content">
          <dl className="security-boundaries-list">
            <div>
              <dt>Network boundary</dt>
              <dd>127.0.0.1 / ::1 loopback only</dd>
            </div>
            <div>
              <dt>Write authorization</dt>
              <dd>In-memory per-launch token (never saved in browser storage)</dd>
            </div>
            <div>
              <dt>Media permissions</dt>
              <dd>Explicit user action only · zero silent capture</dd>
            </div>
            <div>
              <dt>Cloud upload &amp; telemetry</dt>
              <dd className="muted">Disabled by design</dd>
            </div>
          </dl>
        </div>
      </details>
    </section>
  );
}
