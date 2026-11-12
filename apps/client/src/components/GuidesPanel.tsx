import { useState } from 'react';
import { Icon } from '../ui/Icon.js';
import type { StudioViewId } from '../ui/shell-status.js';

interface GuidesPanelProps {
  onSelectView?: ((view: StudioViewId) => void) | undefined;
}

interface GuideTopic {
  id: string;
  group: 'Getting started' | 'Studio & recording' | 'Architecture';
  title: string;
  summary: string;
}

const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'guide-quickstart',
    group: 'Getting started',
    title: 'Quick start',
    summary: 'Record your first screen and camera session in four steps.',
  },
  {
    id: 'guide-sources',
    group: 'Getting started',
    title: 'Sources & audio mixer',
    summary: 'Connect screen, webcam, and microphone inputs with independent gain controls.',
  },
  {
    id: 'guide-compositor',
    group: 'Studio & recording',
    title: 'Scene compositor & layouts',
    summary: 'Switch between PIP, Split, Screen, and Camera views and tune output resolution.',
  },
  {
    id: 'guide-recording',
    group: 'Studio & recording',
    title: 'Save modes & recorder',
    summary: 'Compare crash-safe local sessions with quick in-browser test recordings.',
  },
  {
    id: 'guide-recovery',
    group: 'Studio & recording',
    title: 'Crash recovery & salvage',
    summary: 'Restore playable WebM files from interrupted recordings without losing chunks.',
  },
  {
    id: 'guide-privacy',
    group: 'Architecture',
    title: 'Local privacy & boundaries',
    summary: 'How loopback isolation, write tokens, and local storage keep footage private.',
  },
] as const;

const GROUPS: ReadonlyArray<GuideTopic['group']> = [
  'Getting started',
  'Studio & recording',
  'Architecture',
];

export function GuidesPanel({ onSelectView }: GuidesPanelProps) {
  const [activeTopic, setActiveTopic] = useState<string>(GUIDE_TOPICS[0]!.id);

  function jumpToTopic(id: string) {
    setActiveTopic(id);
    const element = document.getElementById(id);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="guides-layout">
      <aside className="panel guides-sidebar" aria-label="Documentation table of contents">
        <div className="guides-sidebar__header">
          <span className="guides-eyebrow">DOCUMENTATION</span>
          <h2>Contents</h2>
        </div>
        <nav className="guides-toc" aria-label="Guide sections">
          {GROUPS.map(group => (
            <div key={group} className="guides-toc__group">
              <span className="guides-toc__group-label">{group}</span>
              <ul>
                {GUIDE_TOPICS.filter(topic => topic.group === group).map(topic => {
                  const isCurrent = activeTopic === topic.id;
                  return (
                    <li key={topic.id}>
                      <button
                        type="button"
                        className={isCurrent ? 'guides-toc__link guides-toc__link--active' : 'guides-toc__link'}
                        aria-current={isCurrent ? 'location' : undefined}
                        onClick={() => jumpToTopic(topic.id)}
                      >
                        {topic.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        {onSelectView && (
          <div className="guides-sidebar__cta">
            <span className="guides-toc__group-label">Quick jump</span>
            <div className="guides-sidebar__actions">
              <button type="button" className="button-compact" onClick={() => onSelectView('studio')}>
                Open Studio
              </button>
              <button type="button" className="secondary button-compact" onClick={() => onSelectView('recordings')}>
                View Recordings
              </button>
              <button type="button" className="secondary button-compact" onClick={() => onSelectView('recovery')}>
                Open Recovery
              </button>
            </div>
          </div>
        )}
      </aside>

      <article className="guides-article" aria-label="Application guide">
        <header className="panel guides-hero">
          <div className="guides-hero__top">
            <span className="badge">Screeva v0.1</span>
            <span className="badge">Your Screen. Your Studio.</span>
            <span className="badge">100% Local Loopback</span>
            <span className="badge">WebM VP8/VP9 + Opus</span>
          </div>
          <h2>How Screeva works</h2>
          <p className="panel-copy">
            Screeva is a modern, local-first screen and webcam recording studio for creators, developers, and educators.
            Every frame is composed on an HTML5 canvas, mixed through Web Audio, and either previewed in memory or streamed in SHA-256 verified chunks to local disk.
          </p>
        </header>

        <section id="guide-quickstart" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">01 · GETTING STARTED</span>
            <h2 id="heading-quickstart">Quick start in 4 steps</h2>
          </div>
          <p className="panel-copy">
            Follow this workflow in <strong>Studio</strong> whenever you are ready to record a presentation, walkthrough, or camera update.
          </p>
          <ol className="guides-steps">
            <li className="guides-step-card">
              <span className="guides-step-card__num">1</span>
              <div>
                <h3>Connect your sources</h3>
                <p>
                  In the right-hand <strong>Sources</strong> rail, click <strong>Share screen</strong>, <strong>Start camera</strong>, or <strong>Start microphone</strong>.
                  The app never captures media until you explicitly click a source action.
                </p>
              </div>
            </li>
            <li className="guides-step-card">
              <span className="guides-step-card__num">2</span>
              <div>
                <h3>Frame your scene</h3>
                <p>
                  Use the <strong>PIP</strong>, <strong>Split</strong>, <strong>Screen</strong>, or <strong>Camera</strong> buttons above the stage.
                  Click the floating sliders icon on the top-right of the canvas to open <strong>Scene &amp; output settings</strong> (<code>720p</code> or <code>1080p</code> at <code>30 fps</code>).
                </p>
              </div>
            </li>
            <li className="guides-step-card">
              <span className="guides-step-card__num">3</span>
              <div>
                <h3>Choose your save mode</h3>
                <p>
                  On the docked <strong>Recorder</strong> bar, click the <strong>Recording options</strong> button (<code>Save to computer</code> or <code>Quick browser test</code>) to choose how your recording is stored and give durable sessions a <strong>Recording name</strong>.
                </p>
              </div>
            </li>
            <li className="guides-step-card">
              <span className="guides-step-card__num">4</span>
              <div>
                <h3>Record, pause, and stop</h3>
                <p>
                  Click <strong>Start recording</strong>. You can navigate between <strong>Recordings</strong>, <strong>Recovery</strong>, <strong>Guides</strong>, and <strong>Settings</strong> while recording continues uninterrupted in the background.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section id="guide-sources" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">02 · INPUTS &amp; AUDIO</span>
            <h2 id="heading-sources">Sources &amp; audio mixer</h2>
          </div>
          <p className="panel-copy">
            Each input source runs on an isolated media lifecycle so stopping or switching one device never interrupts your other active tracks.
          </p>
          <div className="guides-feature-grid">
            <div className="guides-card">
              <div className="guides-card__title">
                <Icon name="screen" size={18} />
                <h3>Screen &amp; system audio</h3>
              </div>
              <p>
                Uses your browser&apos;s native screen picker (<code>getDisplayMedia</code>). If you enable tab or system audio in the browser prompt, the <strong>Display audio</strong> channel automatically activates in the mixer.
              </p>
            </div>
            <div className="guides-card">
              <div className="guides-card__title">
                <Icon name="camera" size={18} />
                <h3>Camera hot-swapping</h3>
              </div>
              <p>
                Select any connected webcam from the inline dropdown. Switching cameras while live cleanly releases the old hardware stream before opening the replacement camera.
              </p>
            </div>
            <div className="guides-card">
              <div className="guides-card__title">
                <Icon name="mic" size={18} />
                <h3>Audio levels &amp; gain</h3>
              </div>
              <p>
                Adjust <strong>Microphone</strong> and <strong>Display audio</strong> gain from <code>0%</code> to <code>200%</code> or mute either route independently without stopping the underlying capture track.
              </p>
            </div>
          </div>
          <div className="guides-callout">
            <strong>Why don&apos;t I hear my own microphone through my speakers?</strong>
            <p>
              The Web Audio mixer routes audio strictly into the recorder destination stream—never to your computer speakers—so you never experience echo or acoustic feedback loops during recording.
            </p>
          </div>
        </section>

        <section id="guide-compositor" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">03 · SCENE STAGE</span>
            <h2 id="heading-compositor">Scene compositor &amp; layouts</h2>
          </div>
          <p className="panel-copy">
            The live stage composites your active video streams onto a single fixed-resolution canvas at <code>30 fps</code> while preserving every source&apos;s native aspect ratio (<code>letterbox</code> / <code>pillarbox</code>).
          </p>
          <dl className="guides-dl">
            <div>
              <dt>PIP (Picture-in-Picture)</dt>
              <dd>Draws your screen across the full stage with a movable, resizable camera overlay. Drag inside the green frame to reposition, or drag the bottom-right corner handle to resize.</dd>
            </div>
            <div>
              <dt>Split (Side-by-Side)</dt>
              <dd>Places your screen and camera side-by-side. Open <strong>Scene &amp; output settings</strong> via the floating sliders icon on the canvas to adjust the <strong>Split ratio</strong> (<code>25%</code>–<code>75%</code>).</dd>
            </div>
            <div>
              <dt>Screen / Camera solo views</dt>
              <dd>Focuses 100% of the canvas on either your shared screen or your camera feed while keeping other connected sources warm in the background.</dd>
            </div>
          </dl>
        </section>

        <section id="guide-recording" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">04 · RECORDER MODES</span>
            <h2 id="heading-recording">Save modes &amp; recording options</h2>
          </div>
          <p className="panel-copy">
            Click the <strong>Recording options</strong> button on the docked <strong>Recorder</strong> bar to switch between the two recording engines before starting a session.
          </p>
          <div className="guides-compare-grid">
            <div className="guides-card guides-card--accent">
              <div className="guides-card__header">
                <h3>Save to computer</h3>
                <span className="badge">Durable session</span>
              </div>
              <p>
                Streams sequential WebM chunks to the local service as you record. Each chunk is hashed with <code>SHA-256</code>, written to disk, and recorded in SQLite before acknowledgment.
              </p>
              <ul className="guides-list">
                <li>Crash-safe: acknowledged chunks survive browser refreshes or crashes.</li>
                <li>Shows <strong>Saved</strong> only after the server verifies and finalizes the <code>.webm</code> file.</li>
                <li>Appears in the <strong>Recordings</strong> library with byte size and chunk count metadata.</li>
              </ul>
            </div>
            <div className="guides-card">
              <div className="guides-card__header">
                <h3>Quick browser test</h3>
                <span className="badge">In-memory preview</span>
              </div>
              <p>
                Records directly into browser memory (<code>256 MiB</code> safety cap) without creating a database session on disk—ideal for quick mic/camera checks or short clips.
              </p>
              <ul className="guides-list">
                <li>Immediate in-browser <code>&lt;video&gt;</code> playback as soon as you click <strong>Stop</strong>.</li>
                <li>One-click <strong>Download WebM</strong> link from a local browser <code>blob:</code> URL.</li>
                <li>Cleared automatically when you close or reload the browser tab.</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="guide-recovery" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">05 · DURABILITY</span>
            <h2 id="heading-recovery">Crash recovery &amp; salvage</h2>
          </div>
          <p className="panel-copy">
            If a durable recording is interrupted by a browser crash, power loss, or accidental tab closure, open the <strong>Recovery</strong> tab in the top navigation bar.
          </p>
          <div className="guides-callout">
            <strong>Non-destructive chunk salvage</strong>
            <p>
              The recovery inspector verifies every committed chunk on disk in order (<code>0..N</code>). When a contiguous prefix of valid chunks exists, clicking <strong>Restore video</strong> assembles a playable WebM file while leaving the original chunk files untouched.
            </p>
          </div>
        </section>

        <section id="guide-privacy" className="panel guides-section">
          <div className="guides-section__header">
            <span className="guides-section__step">06 · ARCHITECTURE &amp; PRIVACY</span>
            <h2 id="heading-privacy">Local privacy &amp; capability boundaries</h2>
          </div>
          <p className="panel-copy">
            Screeva is architected so your audio, video, and session metadata never leave your machine. You can verify live service health anytime in <strong>Settings</strong>.
          </p>
          <dl className="guides-dl">
            <div>
              <dt>Loopback-only network boundary</dt>
              <dd>The local Node.js server binds strictly to <code>127.0.0.1</code> / <code>::1</code> and rejects cross-origin requests.</dd>
            </div>
            <div>
              <dt>Per-launch write authorization</dt>
              <dd>Mutating API requests require an in-memory per-launch token (<code>X-Recorder-Token</code>) that rotates on every server restart and is never persisted in browser storage.</dd>
            </div>
            <div>
              <dt>Current milestone scope</dt>
              <dd>Durable WebM recording, live scene composition, Web Audio mixing, and crash recovery are active today. In-browser library playback, FFmpeg MP4 export, and session deletion are planned for upcoming milestones.</dd>
            </div>
          </dl>
        </section>
      </article>
    </div>
  );
}
