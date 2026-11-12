import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Capabilities } from '../../../../packages/shared/src/index.js';
import { checkWriteAccess, loadCapabilities } from '../api.js';
import { Banner } from '../ui/Banner.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import {
  DEFAULT_STUDIO_VIEW,
  STUDIO_VIEWS,
  deriveGlobalShellStatus,
  initialCaptureSummary,
  initialRecordingStatusSummary,
  parseViewFromHash,
  viewToHash,
  type RecordingStatusSummary,
  type StudioViewId,
} from '../ui/shell-status.js';
import { DeviceSetupPanel } from './DeviceSetupPanel.js';
import { GuidesPanel } from './GuidesPanel.js';
import { RecordingsPanel } from './RecordingsPanel.js';
import { RecoveryPanel } from './RecoveryPanel.js';
import { SettingsPanel } from './SettingsPanel.js';

const NAV_VIEWS = STUDIO_VIEWS.filter(view => view.id !== 'recovery');

export function AppShell() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [activeView, setActiveView] = useState<StudioViewId>(() => parseViewFromHash(window.location.hash));
  const [captureSummary, setCaptureSummary] = useState(initialCaptureSummary);
  const [recordingStatus, setRecordingStatus] = useState(initialRecordingStatusSummary);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [recordingsRefresh, setRecordingsRefresh] = useState(0);
  const [recoveryRefresh, setRecoveryRefresh] = useState(0);
  const [settingsPortal, setSettingsPortal] = useState<HTMLElement | null>(null);
  const prevDurableStatusRef = useRef(recordingStatus.durable.status);
  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void loadCapabilities(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(setCapabilities)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Cannot reach the local service. Check that the server is running, then retry.');
        }
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const syncFromLocation = () => {
      const next = parseViewFromHash(window.location.hash);
      setActiveView(next);
      if (next === 'recordings') setRecordingsRefresh(count => count + 1);
      if (next === 'recovery') setRecoveryRefresh(count => count + 1);
    };
    window.addEventListener('popstate', syncFromLocation);
    window.addEventListener('hashchange', syncFromLocation);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
      window.removeEventListener('hashchange', syncFromLocation);
    };
  }, []);

  const handleRecordingStatusChange = useCallback((next: RecordingStatusSummary) => {
    setRecordingStatus(next);
    const prevDurable = prevDurableStatusRef.current;
    prevDurableStatusRef.current = next.durable.status;
    if (prevDurable !== next.durable.status && (next.durable.status === 'completed' || next.durable.status === 'failed')) {
      setRecordingsRefresh(count => count + 1);
      setRecoveryRefresh(count => count + 1);
    }
  }, []);

  function selectView(next: StudioViewId) {
    const targetHash = viewToHash(next);
    if (window.location.hash !== targetHash) {
      window.history.pushState({ view: next }, '', targetHash);
    }
    setActiveView(next);
    if (next === 'recordings') setRecordingsRefresh(count => count + 1);
    if (next === 'recovery') setRecoveryRefresh(count => count + 1);
  }

  function handleNavKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      targetIndex = (index + 1) % NAV_VIEWS.length;
    } else if (event.key === 'ArrowLeft') {
      targetIndex = (index - 1 + NAV_VIEWS.length) % NAV_VIEWS.length;
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = NAV_VIEWS.length - 1;
    }
    if (targetIndex !== null) {
      event.preventDefault();
      const targetView = NAV_VIEWS[targetIndex];
      if (targetView) {
        selectView(targetView.id);
        navRefs.current[targetIndex]?.focus();
      }
    }
  }

  async function runCheck() {
    setChecking(true);
    setCheckResult('Checking local access…');
    try {
      await checkWriteAccess();
      setCheckResult('Local access verified. Authenticated requests are working.');
    } catch {
      setCheckResult('Local access check failed. Check the server and try again.');
    } finally {
      setChecking(false);
    }
  }

  function retryConnection() {
    setAttempt(value => value + 1);
    setRecordingsRefresh(count => count + 1);
    setRecoveryRefresh(count => count + 1);
  }

  const shellStatus = deriveGlobalShellStatus({
    capabilities,
    serviceError: error,
    capture: captureSummary,
    recording: recordingStatus,
    activeView,
  });

  const currentView = STUDIO_VIEWS.find(view => view.id === activeView) ?? DEFAULT_STUDIO_VIEW;

  return (
    <div className="shell app-shell">
      <header className="app-header">
        <div className="app-header__top">
          <a
            className="brand"
            href="#studio"
            onClick={event => {
              event.preventDefault();
              selectView('studio');
            }}
          >
            <span className="record-mark" aria-hidden="true" />
            <span>Local Creator Recorder</span>
          </a>
          <div className="app-header__status" role="group" aria-label="Global studio status">
            <StatusPill
              tone={shellStatus.serviceTone}
              dot={shellStatus.serviceState === 'connected'}
              statusLabel="Local service status"
            >
              {shellStatus.serviceLabel}
            </StatusPill>
            <StatusPill
              tone={shellStatus.activityTone}
              dot={shellStatus.activityState === 'recording'}
              statusLabel="Studio activity status"
            >
              {shellStatus.activityLabel}
            </StatusPill>
          </div>
        </div>
        <nav className="app-nav" aria-label="Studio navigation">
          {NAV_VIEWS.map((view, index) => {
            const isActive = activeView === view.id || (view.id === 'recordings' && activeView === 'recovery');
            const showStudioLiveDot = view.id === 'studio' && shellStatus.hasLiveSession && !isActive;
            const showRecoveryBadge = view.id === 'recordings' && recoveryCount > 0;
            return (
              <button
                key={view.id}
                ref={element => {
                  navRefs.current[index] = element;
                }}
                type="button"
                className={isActive ? 'app-nav__item app-nav__item--active' : 'app-nav__item'}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => selectView(view.id)}
                onKeyDown={event => handleNavKeyDown(event, index)}
              >
                <Icon name={view.icon} />
                <span>{view.label}</span>
                {showStudioLiveDot && (
                  <span
                    className={shellStatus.isRecordingOrSaving ? 'app-nav__live-dot app-nav__live-dot--recording' : 'app-nav__live-dot'}
                    aria-hidden="true"
                  />
                )}
                {showRecoveryBadge && (
                  <span
                    className="app-nav__badge"
                    aria-label={`${recoveryCount} unfinished session${recoveryCount === 1 ? '' : 's'}`}
                  >
                    {recoveryCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>
      <main id="main-content" className="main--studio">
        <div className={activeView === 'studio' ? 'view-intro ui-visually-hidden' : 'view-intro view-intro--studio'}>
          <h1>{currentView.heading}</h1>
        </div>
        {error && activeView !== 'settings' && (
          <div className="shell-alert">
            <Banner
              tone="danger"
              title="Local service unavailable"
              action={<button type="button" onClick={retryConnection}>Retry connection</button>}
            >
              {error}
            </Banner>
          </div>
        )}
        {shellStatus.backgroundBanner && (
          <div className="shell-alert">
            <Banner
              tone={shellStatus.backgroundBanner.tone}
              announce
              statusLabel="Background studio activity"
              title={shellStatus.backgroundBanner.title}
              action={
                <button type="button" className="secondary" onClick={() => selectView('studio')}>
                  Return to Studio
                </button>
              }
            >
              {shellStatus.backgroundBanner.detail}
            </Banner>
          </div>
        )}
        <div
          id="view-studio"
          className="view-section"
          role="region"
          aria-label="Studio workspace"
          hidden={activeView !== 'studio'}
        >
          <DeviceSetupPanel
            activeView={activeView}
            settingsPortal={settingsPortal}
            onOpenSettings={() => selectView('settings')}
            onCaptureSummaryChange={setCaptureSummary}
            onRecordingStatusChange={handleRecordingStatusChange}
          />
        </div>
        <div
          id="view-recordings"
          className="view-section"
          role="region"
          aria-label="Recordings workspace"
          hidden={activeView !== 'recordings'}
        >
          {activeView === 'recordings' && (
            <RecordingsPanel
              refreshTrigger={recordingsRefresh}
              recoveryCount={recoveryCount}
              onOpenStudio={() => selectView('studio')}
              onOpenRecovery={() => selectView('recovery')}
            />
          )}
        </div>
        <div
          id="view-recovery"
          className="view-section"
          role="region"
          aria-label="Recovery workspace"
          hidden={activeView !== 'recovery'}
        >
          <RecoveryPanel
            refreshTrigger={recoveryRefresh}
            onItemsChange={items => setRecoveryCount(items.length)}
            onSalvaged={() => setRecordingsRefresh(count => count + 1)}
          />
        </div>
        <div
          id="view-guides"
          className="view-section"
          role="region"
          aria-label="Guides workspace"
          hidden={activeView !== 'guides'}
        >
          {activeView === 'guides' && <GuidesPanel onSelectView={selectView} />}
        </div>
        <div
          id="view-settings"
          className="view-section"
          role="region"
          aria-label="Settings workspace"
          hidden={activeView !== 'settings'}
        >
          <div className="settings-grid">
            <div ref={setSettingsPortal} className="settings-grid__studio" />
            <div className="settings-grid__system">
              <SettingsPanel
                capabilities={capabilities}
                error={error}
                checking={checking}
                checkResult={checkResult}
                onRetryConnection={retryConnection}
                onRunWriteCheck={() => { void runCheck(); }}
              />
            </div>
          </div>
        </div>
        <p className="privacy">
          <span aria-hidden="true">●</span> Runs on this computer. No account, media uploads, or telemetry.
        </p>
      </main>
      <footer>
        <span>Built for a private creative workflow.</span>
        <span>Working title · v0.1</span>
      </footer>
    </div>
  );
}
