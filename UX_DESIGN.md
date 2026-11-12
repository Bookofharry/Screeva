# UX_DESIGN.md — Local Creator Recorder Studio Redesign

- **Status:** Source-audited & Chromium-inspected design specification — **awaiting design review before screen/layout refactor**
- **Date:** 2026-11-11
- **Scope:** Source-backed UX audit (`apps/client/src/**`), live Chromium DOM/viewport inspection (`1440×900`, `1280×720`, `768×1024`, `375×812`), user journeys, navigation & information architecture, desktop/mobile wireframes, dark-first design system, complete application state matrix, engine/security invariants, and incremental migration backlog (`UX-0`–`UX-5`).

---

## 0. Evidence, Access, and Audit Confidence

This revision replaces the earlier provisional hypotheses with direct evidence from the working repository (`c:\Users\hp\Desktop\Projects\screen and video recorder`) and live Chromium rendering against an isolated loopback server.

### 0.1 Directly inspected & executed (confirmed evidence)
1. **Project specifications & ADRs:** Read [`AGENTS.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/AGENTS.md), [`PRD.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/PRD.md), [`ARCHITECTURE.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/ARCHITECTURE.md), [`TASKS.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/TASKS.md), [`DECISIONS.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/DECISIONS.md) (ADR-001 through ADR-023), and [`TASKS_UX_SECTION.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/TASKS_UX_SECTION.md).
2. **React components & client code (100% read):**
   - [`apps/client/src/main.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/main.tsx) (69 lines)
   - [`apps/client/src/components/DeviceSetupPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/DeviceSetupPanel.tsx) (68 lines)
   - [`apps/client/src/components/CapturePanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CapturePanel.tsx) (95 lines)
   - [`apps/client/src/components/StreamPreview.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/StreamPreview.tsx) (41 lines)
   - [`apps/client/src/components/CompositorPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CompositorPanel.tsx) (96 lines)
   - [`apps/client/src/components/AudioMixerPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AudioMixerPanel.tsx) (86 lines)
   - [`apps/client/src/components/AudioRouteControls.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AudioRouteControls.tsx) (19 lines)
   - [`apps/client/src/components/RecordingPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingPanel.tsx) (96 lines)
   - [`apps/client/src/components/RecoveryPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecoveryPanel.tsx) (58 lines)
   - [`apps/client/src/style.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/style.css) and [`apps/client/src/ui/tokens.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/tokens.css)
3. **Media/transport/recovery engines & backend services (100% read):**
   - [`device-setup.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/device-setup.ts), [`capture-manager.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/capture-manager.ts), [`compositor.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/compositor.ts), [`audio-mixer.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/audio-mixer.ts), [`recording-engine.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/recording-engine.ts), [`durable-recording-engine.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/durable-recording-engine.ts), [`chunk-pipeline.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/chunk-pipeline.ts), [`chunk-transport.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/chunk-transport.ts), [`recovery-client.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/media/recovery-client.ts), plus server routes/services in `apps/server/src/**` and shared schemas in [`packages/shared/src/index.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/packages/shared/src/index.ts).
4. **Live Chromium inspection & automated verification:**
   - Launched the compiled app in Chromium against an isolated temporary server with synthetic camera/microphone and an isolated generated lesson tab (never capturing the user's desktop or physical devices).
   - Captured full-page and above-the-fold screenshots and DOM bounding-box metrics across **4 viewports** (`1440×900` desktop, `1280×720` laptop, `768×1024` tablet, `375×812` mobile) and **4 workflow states** (initial load, active screen+camera+mic in PIP, durable recording in progress, durable Saved completion).
   - Executed `npm run check` (**228 passed**, 1 skipped real-FFprobe test) and `npm run test:e2e` (**34 passed** in Chromium).

### 0.2 Still unverified (hypotheses / external dependencies — do not claim as verified)
- **Human usability timing & task-success rate:** No moderated 5-participant study has been run yet.
- **Physical hardware & native OS permission dialogs:** Chromium tests use synthetic media streams and tab auto-selection for isolated fixtures; manual Windows camera/mic/display prompts, hardware hot-unplug, and Windows shared-system audio remain unverified.
- **Real FFprobe/FFmpeg binary on this machine:** Neither `ffprobe` nor `ffmpeg` is installed in `PATH` or configured via `FFPROBE_PATH`; real multi-chunk WebM finalization/salvage media probing remains open (Phase 3 Task 5A acceptance item).
- **Screen-reader & assistive-technology walkthrough:** Automated WCAG contrast and markup semantics are tested, but manual NVDA/Narrator testing and an automated `axe-core` scan (not installed in `node_modules`) have not been executed in this session.

---

## 1. Product Outcome and UX Principles

**North-star workflow:** A first-time educator, developer, or presenter can **1. Choose sources → 2. Verify preview & layout → 3. Start recording** within one viewport, without reading technical documentation. After stopping, the user always understands whether the recording is actively uploading, validating, durably saved, interrupted, or recoverable.

### Core UX principles
1. **Preview-first studio:** The 16:9 composed `<canvas>` (`CanvasCompositor`) is the primary stage and remains visible before, during, and after recording. What appears on the stage is what `MediaRecorder` encodes.
2. **One primary action per state:** Only one prominent primary CTA is highlighted in the recording dock at any moment (`Start recording` when ready, `Stop` when recording, `Resume` when paused, `Start new recording` when completed).
3. **Progressive disclosure:** Everyday controls (Screen, Camera, Mic, Mute, 4 Layout presets, Title, Record/Pause/Stop) live on the main surface. Advanced controls (Resolution 720p/1080p, PIP numeric sliders, Split percentage slider, Audio gain 0–200%, Temporary preview mode, One-shot permission checks, Track settings, and Local API diagnostics) live inside collapsible `<details>` disclosures that keep children mounted.
4. **Truthful status & durability:** `Creating session`, `Recording`, `Paused`, `Stopping`, `Uploading`, `Retrying`, `Finalizing`, `Saved`, and `Failed` are distinct. `Saved` is rendered **only** when `DurableRecordingSnapshot.output` is non-null after server finalization and FFprobe validation.
5. **Explicit permissions:** Browser screen pickers and camera/mic prompts are triggered strictly from direct user clicks (`CaptureManager.start`). Denials and ended shares explain recovery in plain language.
6. **Safe destructive & recovery boundaries:** Recovery copy states clearly that only server-acknowledged chunks can be salvaged and browser-only queued data is not recoverable.
7. **Local-first trust:** Reinforce that media stays on `127.0.0.1` without cloud uploads or telemetry, and never persist launch write tokens to `localStorage`/`sessionStorage`.
8. **Accessible by default:** Semantic controls, 44×44 CSS px target minimum for primary studio controls, verified WCAG 2.2 AA color contrast, keyboard-operable layout/PIP controls, polite state announcements without per-second timer spam, and `prefers-reduced-motion` support.

### Measurable UX targets (for UX-5 validation)
- **Time to first recording:** New user starts first recording in **≤ 60 seconds** after permissions are granted in moderated sessions (report prompt time separately).
- **Task completion:** **≥ 4 of 5** representative users complete *choose sources → verify preview → record → stop → locate status* without facilitator intervention.
- **Zero false-save comprehension errors:** **100%** of participants in degraded/failed/interrupted scenarios accurately identify whether their recording is finalized or needs recovery.
- **Viewport ergonomics:** Primary studio preview + recording dock simultaneously visible at `1440×900`, `1280×720`, and `375×812` with **0 px** horizontal overflow.

---

## 2. Source-Grounded UX Audit (Confirmed Findings vs. Hypotheses)

### 2.1 Measured viewport & DOM metrics (Chromium inspection, 2026-11-11)
All measurements below were captured from the compiled application with active Screen + Camera + Microphone streams and Picture-in-Picture layout selected:

| Metric | Desktop (`1440×900`) | Laptop (`1280×720`) | Tablet (`768×1024`) | Mobile (`375×812`) |
|---|---|---|---|---|
| Total document `scrollHeight` (initial / active) | `5,852 px` / `6,119 px` | `5,852 px` / `6,119 px` | `5,984 px` (active) | `7,023 px` / `7,541 px` |
| Horizontal overflow (`scrollWidth > innerWidth`) | `false` (`1440 px`) | `false` (`1280 px`) | `false` (`768 px`) | `false` (`375 px`) |
| `main` content column max-width (`.shell > main`) | `760 px` (`53%` of width) | `760 px` (`59%` of width) | `672 px` | `331 px` |
| Y-offset of `#setup-title` ("Set up your inputs") | `530 px` | `530 px` | `510 px` | `482 px` |
| Y-offset of `#capture-title` ("Live capture") | `1,240 px` (below fold) | `1,240 px` (below fold) | `1,219 px` (below fold) | `1,735 px` (2.1× fold) |
| Y-offset of `#compositor-title` & `<canvas>` | `3,218 px` / `3,418 px` | `3,218 px` / `3,418 px` | `3,311 px` | `3,646 px` / `4,017 px` |
| Composed `<canvas>` rendered size | `694 × 390 px` | `694 × 390 px` | `606 × 341 px` | `289 × 163 px` |
| Y-offset of `#audio-mixer-title` ("Audio mixer") | `4,156 px` | `4,156 px` | `4,021 px` | `4,685 px` |
| Y-offset of `Start recording` button | `5,061 px` (**5.6 screens**) | `5,061 px` (**7.0 screens**) | `4,926 px` (**4.8 screens**) | `6,185 px` (**7.6 screens**) |
| Distance between `<canvas>` preview and `Start recording` | **`1,643 px`** | **`1,643 px`** | **`1,615 px`** | **`2,168 px`** |
| Composed preview visible while `RecordingPanel` is in view | **`false`** | **`false`** | **`false`** | **`false`** |
| Total buttons / `[role="status"]` regions in DOM | `17` buttons / `15+` statuses | `17` buttons / `15+` statuses | `17` buttons / `15+` statuses | `17` buttons / `15+` statuses |

### 2.2 Current component & DOM hierarchy (source-verified)
```text
App (apps/client/src/main.tsx)
├── <header> Brand + "Local development" badge
└── <main> (max-width: 760px; margin: 72px auto)
    ├── Hero: "PHASE 03 / DURABLE RECORDING", <h1> "A local home for your next recording.", intro paragraph
    ├── DeviceSetupPanel (apps/client/src/components/DeviceSetupPanel.tsx) — owns DeviceSetup instance
    │   ├── Panel 1: "Set up your inputs" (Camera/Mic <select>, "Check camera/microphone access", "Refresh devices")
    │   └── CapturePanel (apps/client/src/components/CapturePanel.tsx) — owns CaptureManager instance
    │       ├── Panel 2: "Live capture" (Screen/Camera/Mic cards, 2× full-width <video> StreamPreview, track settings, "Stop all capture")
    │       ├── Panel 3: CompositorPanel (CompositorPanel.tsx) — owns CanvasCompositor instance + <canvas> + PIP sliders
    │       ├── Panel 4: AudioMixerPanel (AudioMixerPanel.tsx) — owns AudioMixer instance + 2× AudioRouteControls (<meter>, gain, mute)
    │       ├── Panel 5: RecordingPanel (RecordingPanel.tsx) — owns RecordingEngine + DurableRecordingEngine instances
    │       └── Panel 6: RecoveryPanel (RecoveryPanel.tsx) — owns RecoveryClient instance
    └── Panel 7: "Your local workspace" (capabilities <dl>, "Foundation build" badge, "Check local access ↗" button)
```

### 2.3 Prioritized audit findings (confirmed defects vs. hypotheses)

Severity levels:
- **Critical (P0):** Can cause accidental data loss, blind recording, or blocks core workflow comprehension.
- **High (P1):** Major usability friction, split task flow, or accessibility target/hierarchy violation.
- **Medium (P2):** Jargon, visual clutter, or secondary ergonomic issues.

| ID | Area | Evidence Status | Finding & Source Location | Severity | Design Resolution |
|---|---|---|---|---|---|
| **A-01** | Preview & Recording Separation | **Confirmed** (`CapturePanel.tsx`, Chromium DOM audit) | **Blind recording:** The composed preview `<canvas>` is at `y=3418px` (`1440×900`) while `Start recording` / `Pause` / `Stop` are at `y=5061px` (`1,643px` lower; `2,168px` lower on `375px` mobile). Users cannot see their composed scene, PIP framing, or source-loss visual fallback while starting, pausing, or stopping a recording. | **Critical (P0)** | Unified Studio layout with central 16:9 stage and sticky bottom recording dock; preview and recording controls are simultaneously in view at all viewports. |
| **A-02** | Recording Mode Default | **Confirmed** ([`RecordingPanel.tsx:24`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingPanel.tsx#L24)) | **Fragile default mode:** `useState<'durable' \| 'temporary'>('temporary')` defaults every session to in-memory browser preview (128 MiB cap, lost on tab reload/close/crash). Beginners clicking `Start recording` without toggling the radio button risk losing their recording. | **Critical (P0)** | Default to **Durable local session ("Save to this computer")** whenever the local service is reachable; place Quick/Temporary browser preview clearly as an explicit secondary option. |
| **A-03** | Active Recording Indicator & Tab Guard | **Confirmed** ([`RecordingPanel.tsx:63`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingPanel.tsx#L63), `main.tsx`) | **Weak recording indicator & no unload warning:** PRD `REC-01` requires a prominent active indicator. Currently only a small `.badge.recording-active` inside Panel 5 (`y=4718px`) indicates recording; nothing appears in the header, stage, or `document.title`, and no `beforeunload` listener warns before closing/reloading a tab during `recording`/`uploading`/`finalizing`. | **Critical (P0)** | Add a prominent topbar/dock `● REC` pill, stage recording frame, `document.title` prefix, and a `beforeunload` guard while recording or draining/finalizing chunks. |
| **A-04** | Split Setup vs. Capture Workflow | **Confirmed** ([`DeviceSetupPanel.tsx:36-66`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/DeviceSetupPanel.tsx#L36-L66), [`CapturePanel.tsx:53-82`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CapturePanel.tsx#L53-L82)) | **Two separate panels for the same devices:** Camera/microphone `<select>` dropdowns and one-shot `Check camera/microphone access` buttons live in Panel 1 (`y=530px`), while `Start camera`, `Start microphone`, and `Share screen` live `710px` lower in Panel 2 (`y=1240px`). Furthermore, once live capture starts, `Check camera/microphone access` disables itself with a warning ("Stop this input's live capture before running a temporary access check"). | **High (P1)** | Consolidate device selection and `Start`/`Switch`/`Stop` into compact **Source Cards** in the Studio setup rail; move one-shot permission probes (`Check camera/microphone access`) and `Refresh devices` into an **Advanced / Troubleshoot devices** disclosure. |
| **A-05** | Triple Video Surfaces | **Confirmed** ([`CapturePanel.tsx:66`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CapturePanel.tsx#L66), [`CompositorPanel.tsx:82`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CompositorPanel.tsx#L82)) | **Three stacked 16:9 previews:** Screen (`652×367px` at `y=1495px`), Camera (`652×367px` at `y=2207px`), and Composed Canvas (`694×390px` at `y=3418px`) are all rendered full-width in a single column, adding `>1,100px` of duplicate video height and pushing the compositor and recorder far down the page. | **High (P1)** | Make the composed `<canvas>` the primary 16:9 stage. Keep `StreamPreview` `<video>` elements mounted in a compact/collapsible source diagnostic area (preserving E2E selectors `Screen preview` and `Camera preview`) rather than full-width stacked panels. |
| **A-06** | Marketing Hero Above Studio | **Confirmed** ([`main.tsx:41-45`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/main.tsx#L41-L45)) | **First screen is marketing copy, not a studio:** A `100px` header, `72px` top margin, eyebrow `PHASE 03 / DURABLE RECORDING`, `62px` `<h1>` ("A local home for your next recording."), and intro paragraph consume the top `530px` of every viewport. At `1280×720` and `1440×900`, not a single capture or preview control is visible above the fold. | **High (P1)** | Replace the landing-page hero with a compact `56px` studio top bar (`Brand`, `Studio / Recordings / Recovery / Settings` navigation, and service readiness pill) so the 16:9 preview and source rail appear immediately above the fold. |
| **A-07** | Audio Meters Disconnected from Mic Source | **Confirmed** ([`CapturePanel.tsx:67`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CapturePanel.tsx#L67), [`AudioMixerPanel.tsx:72-85`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AudioMixerPanel.tsx#L72-L85)) | **Mic status and mic level are `1,900px` apart:** Panel 2 shows a static box `"Microphone is active"`, while the live level `<meter>`, mute checkbox, and `"Enable audio processing"` button are at `y=4156px` in Panel 4. If `AudioContext` starts `"suspended"`, the user may not notice in Panel 2 that mixed audio is paused (`video-only recording`). | **High (P1)** | Surface live Microphone & Display audio level meters, mute toggles, and the `"Enable audio processing"` prompt directly alongside the source controls in the Studio rail, with 0–200% gain sliders in an expandable Audio drawer/disclosure. |
| **A-08** | Inverted Action Hierarchy While Recording | **Confirmed** ([`RecordingPanel.tsx:80-85`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingPanel.tsx#L80-L85), screenshots) | **Disabled `Start recording` outshines live `Pause`/`Stop`:** During active recording, `Start recording` remains the filled green primary button (at 50% opacity), while `Pause` and `Stop` use `.secondary` outlined styling. | **High (P1)** | State-driven recording dock: when idle/ready, highlight `Start recording`; when recording, give `Stop` the prominent recording-stop style and `Pause` clear secondary styling; when paused, make `Resume` primary. |
| **A-09** | Touch Target Sizes Below 44×44 px | **Confirmed** (Chromium DOM bounding-box audit) | **Sub-44px interactive controls:** `.pip-resize` button is `30×30px` (`style.css:67`); range inputs (`Microphone gain`, `Display audio gain`, PIP X/Y/W/H, split proportion) are `16px` tall; mute checkboxes and mode radios are `13×13px` inside ~`20px`-tall labels. | **High (P1)** | Increase `.pip-resize` hit area to `44×44px`, give checkbox/radio labels `min-height: 44px` with flex alignment, and style range inputs with `min-height: 36–44px` hit areas. |
| **A-10** | Jargon & Raw Telemetry in Primary UI | **Confirmed** (`RecordingPanel.tsx:72-90`, `CapturePanel.tsx:20-26`, `RecoveryPanel.tsx:49`) | **Internal terminology exposed by default:** Primary views display `"Browser queue: 0 B in 0 chunk(s). Acknowledged: 2. Upload attempts: 2."`, `"Session a2302b2f-..."`, `"valid-incomplete"`, raw MIME strings (`video/webm;codecs=vp9,opus`), and per-track `echoCancellation`/`noiseSuppression` strings. | **Medium (P2)** | Translate primary status badges and messages into clear creator language while preserving exact chunk/byte/MIME/UUID details inside expandable `Details` disclosures (and preserving accessible labels required by E2E tests). |
| **A-11** | Passive Recovery & Unsurfaced Session Library | **Confirmed** ([`RecoveryPanel.tsx:25-32`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecoveryPanel.tsx#L25-L32), `api.ts`) | **Recovery is buried at `y=5194px` and only fetches on mount:** If a durable recording fails mid-session, `RecoveryPanel` does not auto-refresh; on launch, unfinished sessions at the bottom of the page are invisible above the fold. Additionally, `GET /api/v1/sessions` is implemented on the backend (`apps/server/src/routes/api.ts:45`), but **no UI component calls it** to list completed recordings. | **High (P1)** | Surface a top notification banner/badge when recoverable sessions exist, auto-refresh recovery after durable failures, and add a **Recordings** view backed by `GET /api/v1/sessions` (truthfully showing metadata without inventing unimplemented playback/delete endpoints). |
| **A-12** | FFprobe Availability Not Preflighted in UI | **Confirmed** (`capabilities.ts`, `ffprobe.ts`) | **`GET /api/v1/capabilities` reports `recording: true` even when `ffprobe` is missing:** On a machine without FFprobe, a user can record a long durable session only to have `POST /api/v1/sessions/:id/finalize` fail at the very end. (Chunks remain safe on disk for later recovery, per ADR-021/ADR-023.) | **High (P1)** | Document this limitation clearly in UI copy ("Saved requires local media validation; acknowledged chunks remain recoverable if finalization fails") and track a separate backend capability enhancement (`B-01`) to report FFprobe preflight status. |
| **A-13** | 15+ Simultaneous `role="status"` Live Regions | **Confirmed** (Chromium DOM audit) | **Screen-reader live-region noise:** 15 elements carry `role="status"` simultaneously, including rapidly updating track/routing labels. | **Medium (P2)** | Preserve the existing `aria-label` status elements required by tests, keep rapid meters as `role="meter"` (never live regions), and ensure state transitions update cleanly without per-second announcements. |
| **A-14** | Narrow-Width Layout Wrapping (`375px`) | **Confirmed** (`narrow-recording-fold.png`, `style.css:95-100`) | **Ragged button wrapping & 7,541px scroll height:** While `overflowX` is `false` at `375px`, `Start recording` + `Pause` + `Stop` wrap onto two uneven rows and the user must scroll `7.6` screen heights to reach the recorder. | **Medium (P2)** | Responsive studio shell: sticky preview + compact source cards + sticky bottom recording dock at `<768px`. |
| **A-15** | Developer Scaffolding in Footer/Workspace Panel | **Confirmed** ([`main.tsx:41-64`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/main.tsx#L41-L45)) | **Dev badges in main flow:** `"Local development"`, `"Foundation build"`, and `"Check local access ↗"` occupy a full panel in the main flow. | **Medium (P2)** | Move workspace diagnostics (`Local service`, `Metadata storage`, `Check local access`) into the **Settings / Diagnostics** view or collapsible footer panel while keeping all elements mounted for foundation E2E tests. |
| **A-16** | Undefined `var(--muted)` & Unloaded `Inter` Font | **Confirmed & Fixed in UX-1** (`style.css`, `tokens.css`) | `.recovery-list li span` referenced undefined `var(--muted)` and `:root` declared `Inter` (which cannot load from external CDNs under CSP). Both were resolved in the token/primitive foundation landed in `apps/client/src/ui/tokens.css` and `apps/client/src/style.css`. | **Resolved** | Verified by [`tests/design-tokens.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/design-tokens.test.ts). |

---

## 3. Users, Jobs, and End-to-End Journeys

### Primary personas
- **First-time Educator / Tutor:** Shares slides or browser tab + microphone; needs immediate visual confirmation that the mic is working and that the recording is safely saved to disk.
- **Developer / Technical Instructor:** Shares VS Code or terminal + PIP webcam; drags/resizes the webcam overlay and switches layouts mid-lesson.
- **Classroom Presenter (Long Session):** Records up to 2 hours with pauses; relies on bounded memory (`RecordingChunkPipeline` 64 chunks / 32 MiB) and crash recovery (`RecoveryService`) if the browser or server is interrupted.

### Journey A — First Recording (3-Step Happy Path: Choose Sources → Verify Preview → Start Recording)
1. **Launch:** User opens `http://127.0.0.1:4317`. Top bar shows `● Local service connected`. If any unfinished sessions exist from a prior run, a top banner offers `Review 1 unfinished recording`.
2. **Step 1 — Choose sources:** In the left/right Studio rail, the user clicks **Share screen** (triggers browser picker directly from click), selects Camera from the inline dropdown and clicks **Start camera**, and selects Microphone and clicks **Start microphone**.
3. **Step 2 — Verify preview & layout:** The central 16:9 `<canvas>` immediately renders the live scene. The user clicks the **Picture in picture** preset card, drags the webcam overlay on the canvas, and sees the **Microphone live level** bar moving. If Web Audio started suspended, an inline **Enable audio processing** button is right above the meters.
4. **Step 3 — Start recording:** In the bottom recording dock, **Durable local session** ("Save to this computer") is selected, with an editable **Session title**. The user clicks **Start recording**.
5. **Active recording:** The dock shows `● Recording`, the active timer (`00:02`), prominent **Pause** and **Stop** buttons, and live save health (`All chunks saved` or `Uploading…`). The 16:9 preview remains in full view above the dock.
6. **Stop & finalize:** User clicks **Stop**. The dock transitions truthfully through `Stopping` → `Uploading` (draining remaining chunks) → `Finalizing` (server concatenation + FFprobe validation) → `Saved` (`Saved locally` with session title, chunk count, and verified byte size).

### Journey B — Permission Denied or Source Ended Mid-Recording
1. **Denied on request:** User clicks `Start camera` and blocks the browser prompt. The Camera source card shows a clear alert (`Camera permission was denied...`), leaves Screen and Microphone untouched, and keeps `Start camera` available for a manual retry after the user updates site permissions.
2. **Screen share stopped mid-recording:** User clicks Chrome's native "Stop sharing" bar while recording in PIP mode. `CaptureManager` marks `display` ended; `CanvasCompositor` automatically falls back to rendering the live camera track so the recording stream does not crash; the Screen card shows an alert and offers `Share screen` again.

### Journey C — Degraded Upload, Retry, or Backpressure Safety Stop
1. **Transient retry:** While recording in durable mode, a chunk PUT times out or returns 5xx. `RecordingChunkTransport` retries with exponential backoff (up to 5 attempts). The dock badge shows `Retrying` with the queued chunk count and advises keeping the tab open.
2. **Sustained backpressure / hard cap:** If the 64-chunk / 32 MiB queue stays above high-water (80%) for the 2-second grace period or hits capacity, `DurableRecordingEngine` stops encoding safely without stopping borrowed capture/compositor/mixer tracks, transitions to `Failed`, explains that previously acknowledged chunks are still on disk, and offers a direct action to inspect **Recovery**.

### Journey D — Interrupted Session Recovery
1. **After browser reload or server restart:** Unfinished sessions with `committedCount > 0` are marked `interrupted` when the 10-second heartbeat lease expires or on server startup reconciliation.
2. **Inspection & explicit salvage:** In the **Recovery** view (or top banner), each unfinished session shows its title, condition (`Ready to recover` / `valid-incomplete`, `Damaged` / `corrupt`, `Nothing saved yet` / `empty`, or `Active` / `active`), verified contiguous chunks (`contiguousChunkCount / committedChunkCount`), and verified byte size.
3. **Salvage:** Clicking **Salvage acknowledged chunks** calls `POST /api/v1/sessions/:id/recovery/salvage`. Only after server concatenation and FFprobe validation succeed does the session move to `completed` (`Saved`).

---

## 4. Navigation and Information Architecture

### 4.1 Critical React mounting invariant (preserving tracks & E2E contracts)
Per `ARCHITECTURE.md` and `DECISIONS.md`:
- `CaptureManager`, `CanvasCompositor` (and its `<canvas>`), `AudioMixer`, `RecordingEngine`, `DurableRecordingEngine`, `DeviceSetup`, and `RecoveryClient` **must stay mounted for the lifetime of the page**.
- **Never conditionally unmount** the studio panels when switching navigation tabs (`Studio`, `Recordings`, `Recovery`, `Settings`) or across responsive breakpoints. Unmounting `CompositorPanel` or `CapturePanel` would invoke `dispose()` and kill live `MediaStreamTrack`s mid-recording!
- **Implementation rule:** Use CSS layout/visibility (`hidden` / `.is-hidden` or a persistent two-column + drawer shell) so every engine and its DOM controls remain mounted and reachable while visual focus shifts cleanly between views.

### 4.2 Top-level navigation structure
```text
AppShell
├── TopBar (sticky, 56px)
│   ├── Brand: "Local Creator Recorder" + local-only privacy indicator
│   ├── View Switcher (tabs/pills): [ Studio ]  [ Recordings ]  [ Recovery (badge) ]  [ Settings & Diagnostics ]
│   └── Status Cluster: Service status ("Connected" / "Unavailable") + active REC pill ("● REC 00:12")
│
├── Main Workspace (Studio view — default, fits 100vh on desktop without scrolling to record)
│   ├── Left / Center Stage Column (65–70% width on desktop; sticky top on mobile)
│   │   ├── Stage Header: Active layout summary + resolution badge ("720p · 30 fps") + canvas status
│   │   ├── 16:9 Composed Canvas Stage (`CanvasCompositor` + interactive PIP move/resize overlay)
│   │   └── Step 2 — Layout Preset Bar (4 visual preset buttons + conditional Split / PIP fine controls)
│   │
│   ├── Right Setup Rail (30–35% width on desktop, 340–400px; stacked below stage on <1024px)
│   │   ├── Step 1 — Sources ("Choose sources")
│   │   │   ├── Screen Source Card (`Share screen` / `Change shared source` / `Stop display`, shared-audio indicator)
│   │   │   ├── Camera Source Card (Device `<select>`, `Start camera` / `Switch camera` / `Stop camera`, status)
│   │   │   ├── Microphone Source Card (Device `<select>`, `Start microphone` / `Switch microphone` / `Stop microphone`, status)
│   │   │   └── `Stop all capture` action
│   │   ├── Audio Mixer Section ("Verify audio")
│   │   │   ├── Audio Mix Mode badge + conditional `Enable audio processing` button
│   │   │   ├── Microphone Route: live `<meter>`, `Mute microphone`, and gain slider (0–200%)
│   │   │   └── Display Audio Route: live `<meter>`, `Mute display audio`, and gain slider (0–200%)
│   │   └── Progressive Disclosures (`<details class="ui-disclosure">`, contents always mounted)
│   │       ├── ▸ Source Previews & Track Details (`Screen preview` `<video>`, `Camera preview` `<video>`, actual track settings lists)
│   │       └── ▸ Troubleshoot Devices & Permissions (`Check camera access`, `Check microphone access`, `Cancel access check`, `Refresh devices`)
│   │
│   └── Step 3 — Bottom Recording Dock (sticky bottom bar across studio)
│       ├── Session Title input + Storage Mode selector (`Durable local session` default vs. `Temporary browser preview`)
│       ├── Readiness pills (`Canvas video: ready`, `Mixed audio: ready`) + Save/Queue telemetry
│       ├── Primary Transport Controls: `Start recording` / `Start new recording`, `Pause` / `Resume`, `Stop`, `Clear status`
│       ├── Monospace tabular timer (`00:00`) + Recording status badge (`Ready`, `Recording`, `Uploading`, `Finalizing`, `Saved`, `Failed`)
│       └── Inline Completion / Error tray (`Saved locally` summary or temporary `<video>` preview + `Download WebM`)
│
├── Recordings View (drawer/section — lists persistent sessions from `GET /api/v1/sessions`)
│   └── Session cards: Title, created timestamp, status badge, resolution/layout, verified duration & byte size when `completed` (no fake play/delete buttons until backend routes exist)
│
├── Recovery View (drawer/section — wraps `RecoveryPanel` / `RecoveryClient`)
│   └── Unfinished durable sessions list, verified chunk/byte counts, condition explanation, `Salvage acknowledged chunks`, `Refresh`
│
└── Settings & Diagnostics View (drawer/section — wraps workspace health & preferences)
    └── Local service & SQLite status (`Connected`, `Ready · SQLite`), `Check local access`, keyboard-shortcut toggle, and local-only privacy notice
```

---

## 5. Desktop and Narrow-Screen Wireframes

### 5.1 Desktop Studio (`≥ 1200px`, target `1440×900` and `1280×720` — zero scroll needed to preview & record)
```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◉ Local Creator Recorder     [Studio ●] [Recordings] [Recovery (1)] [Diagnostics]    ● Connected     │
├───────────────────────────────────────────────────────────────┬──────────────────────────────────────┤
│ STEP 2 · LIVE PREVIEW & LAYOUT     Canvas output ready · 30fps│ STEP 1 · SOURCES      2 active · Idle│
│ ┌───────────────────────────────────────────────────────────┐ │ ┌──────────────────────────────────┐ │
│ │                                                           │ │ │ 🖥 Screen                        │ │
│ │                                                           │ │ │ Active · live capture (audio ✓)  │ │
│ │                  16:9 COMPOSED CANVAS                     │ │ │ [Change shared source] [Stop]    │ │
│ │                                                           │ │ └──────────────────────────────────┘ │
│ │                                      ┌─────────────────┐  │ │ ┌──────────────────────────────────┐ │
│ │                                      │  Move webcam    │  │ │ │ 📷 Camera   [HD Webcam        ▾] │ │
│ │                                      │              [↘]│  │ │ │ Active · live capture            │ │
│ │                                      └─────────────────┘  │ │ │ [Switch camera] [Stop camera]    │ │
│ └───────────────────────────────────────────────────────────┘ │ └──────────────────────────────────┘ │
│ Layout: [▣ Screen only] [◙ Camera only] [▣◘ PiP ✓] [▥ Split] │ ┌──────────────────────────────────┐ │
│ Resolution: [720p · 1280×720 ▾]   ▸ Webcam overlay geometry   │ │ 🎙 Microphone [Default Mic    ▾] │ │
│                                                               │ │ Active · live capture            │ │
│                                                               │ │ [Switch mic] [Stop microphone]   │ │
│                                                               │ └──────────────────────────────────┘ │
│                                                               │ AUDIO MIXER       Mic + display audio│
│                                                               │ Mic     ▮▮▮▮▮▮▯▯▯▯ [Mute] Gain 100%  │
│                                                               │ Display ▮▮▮▯▯▯▯▯▯▯ [Mute] Gain 100%  │
│                                                               │ ▸ Source previews & track details    │
│                                                               │ ▸ Troubleshoot devices & permissions │
├───────────────────────────────────────────────────────────────┴──────────────────────────────────────┤
│ STEP 3 · RECORD   Title: [Untitled recording      ]  Mode: (●) Durable local  ( ) Temporary preview  │
│ [Canvas video: ready] [Mixed audio: ready]          00:00   [ ● Start recording ] [Resume] [Stop]    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Desktop Studio — Active Recording & Uploading State
```text
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ● REC   Title: Lesson 01 — Arrays (Durable local session)     Browser queue: 0 B · Acknowledged: 14  │
│ Status: [● Recording]                               02:18   [ ❚❚ Pause ]  [ ■ Stop ]                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Narrow / Mobile Viewport (`375×812` — Sticky Preview + Sticky Recording Dock)
```text
┌─────────────────────────────────────┐
│ ◉ Local Creator Recorder   ● Ready  │  Top bar (48px)
│ [Studio ●] [Recordings] [Recovery]  │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │  Sticky top stage container:
│ │                                 │ │  16:9 Composed Canvas (331×186px)
│ │      16:9 COMPOSED PREVIEW      │ │  remains visible while scrolling
│ │                         ┌─────┐ │ │  sources or operating the dock!
│ │                         │ Cam │ │ │
│ └─────────────────────────┴─────┴─┘ │
│ [Screen] [Camera] [PiP ✓] [Split]   │  44px-tall layout preset pills
├─────────────────────────────────────┤
│ STEP 1 · SOURCES                    │  Scrollable middle pane:
│ ┌─────────────────────────────────┐ │
│ │ Screen · Active                 │ │
│ │ [Change shared source] [Stop]   │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Camera · [System default     ▾] │ │
│ │ [Start camera]  [Stop camera]   │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Microphone · [System default ▾] │ │
│ │ [Start microphone] [Stop mic]   │ │
│ │ Mic level ▮▮▮▮▮▯▯▯  [ ] Mute    │ │
│ └─────────────────────────────────┘ │
│ ▸ Audio gain & display audio        │
│ ▸ PIP / Split geometry & resolution │
│ ▸ Source previews & track settings  │
│ ▸ Troubleshoot permissions          │
│                                     │
│ Title: [Untitled recording       ]  │
│ Mode: (●) Durable  ( ) Temporary    │
├─────────────────────────────────────┤
│ [● Ready]  00:00  [● Start] [Stop]  │  Sticky bottom dock (64–76px)
└─────────────────────────────────────┘
```

### 5.4 Breakpoints and responsive rules
- **`≥ 1200px` (Desktop / Laptop):** Two-column studio grid (`minmax(0, 1.65fr) minmax(340px, 1fr)`) with sticky top bar and sticky bottom recording dock. Both the 16:9 preview and the recording dock fit comfortably inside a `720px`-tall laptop viewport.
- **`768px–1199px` (Tablet / Compact Window):** Single-column grid where the 16:9 preview stage sits at the top, followed by a 2-column source/audio grid, with the sticky recording dock at the bottom.
- **`< 768px` (`375px` Mobile):** Compact header, sticky top 16:9 preview (`max-height: 32vh`), scrollable source/audio cards, collapsible disclosures for secondary controls, and a sticky bottom recording dock (`padding-bottom: env(safe-area-inset-bottom)`).
- **Capability honesty on mobile:** If `navigator.mediaDevices.getDisplayMedia` is absent on a mobile browser, `CaptureManager` already sets `display.supported = false` and disables `Share screen` with `"Screen capture is not supported in this browser."` The UI must preserve this truthful state.

---

## 6. Dark-First Visual Design System and Reusable Primitives

### 6.1 Implemented & verified CSS design tokens ([`apps/client/src/ui/tokens.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/tokens.css))
Every foreground/background pair below is automatically verified against WCAG 2.2 AA contrast thresholds (`≥ 4.5:1` for normal text, `≥ 3.0:1` for UI boundaries and large bold labels) in [`tests/design-tokens.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/design-tokens.test.ts):

| Token Category | CSS Custom Property | Hex / Value | Verified Contrast vs. `--bg` / `--surface-1` / `--surface-2` | Usage |
|---|---|---|---|---|
| **Surfaces** | `--bg` | `#0e1513` | Base | App background, form controls |
| | `--surface-1` | `#151f1c` | Base | Primary panels, top bar, recording dock |
| | `--surface-2` | `#1c2925` | Base | Source cards, disclosures, banners |
| | `--surface-stage` | `#050908` | Base | Letterbox & empty-preview stage backdrop |
| | `--warning-surface` | `#221f18` | Base | Warning callout background |
| **Borders** | `--border` | `#2c3b35` | Decorative hairline | Section dividers |
| | `--border-strong` | `#46564f` | Card border | Card & panel outlines |
| | `--border-input` | `#657b70` | **`≥ 3.1:1`** on all surfaces | Form inputs & secondary button boundaries (WCAG 1.4.11) |
| | `--accent-border` | `#568f73` | **`≥ 3.1:1`** | Ready/saved status borders |
| **Text** | `--text` | `#e8efeb` | **`≥ 13.5:1`** | Primary text & headings |
| | `--text-soft` | `#c8d5ce` | **`≥ 9.8:1`** | Field labels & secondary actions |
| | `--text-muted` | `#a3b5ac` | **`≥ 6.4:1`** | Help copy, metadata, captions |
| | `--warning-text` | `#e9d9b9` | **`≥ 10.6:1`** on `--warning-surface` | Warning callout body copy |
| **Brand / Accent** | `--accent` | `#8ee6bc` | **`≥ 10.2:1`** (`--on-accent` `#0f2219` on `--accent` is **`9.9:1`**) | Primary CTA fill, active/ready text |
| | `--accent-strong` | `#b3f7d5` | **`≥ 12.4:1`** | Hover fill & `3px` `:focus-visible` ring |
| | `--accent-soft` | `#c8e6d6` | **`≥ 10.5:1`** | Secondary button label |
| **Semantic Status** | `--live` / `--live-border` | `#caff7b` / `#88ad55` | **`≥ 12.6:1`** | Active capture badge |
| | `--record` | `#ff4d57` | **`≥ 4.1:1`** | Pulsing REC dot & active recording border |
| | `--record-text` | `#ffb0b4` | **`≥ 8.6:1`** | Recording status pill text |
| | `--record-button` | `#c62834` | `--text` on `--record-button` is **`5.26:1`** | Filled record/stop button background |
| | `--warning` | `#ffc46b` | **`≥ 9.5:1`** | Degraded upload / retry / paused indicator |
| | `--danger` | `#ffb3a3` | **`≥ 8.8:1`** | Error alerts & destructive borders |
| | `--info` | `#8fc8ff` | **`≥ 8.7:1`** | Informational notices |
| **Spacing & Radius** | `--space-1` .. `--space-8` | `4, 8, 12, 16, 24, 32, 48, 64px` | — | 4-pt layout rhythm |
| | `--radius-s / m / l` | `6px / 10px / 14px` | — | Buttons & inputs / cards / stage |
| **Typography** | `--font-sans` | `system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | — | Local-only UI typography (no remote fonts) |
| | `--font-mono` | `ui-monospace, "Cascadia Mono", SFMono-Regular, Consolas, monospace` | — | Tabular-numeral recording clock & byte counters |
| **Motion** | `--duration-fast / base` | `120ms / 200ms` (`0ms` under `prefers-reduced-motion: reduce`) | — | Hover/disclosure transitions |

### 6.2 Reusable UI primitive inventory
The following 7 foundational primitives are already implemented in `apps/client/src/ui/` and unit-tested in [`tests/ui-primitives.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/ui-primitives.test.ts); the studio layout components below build on top of them in `UX-1`–`UX-4`:

| Primitive | Status | Responsibility & Accessibility Contract |
|---|---|---|
| [`Icon.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/Icon.tsx) | **Implemented (UX-1 foundation)** | 14 inline 24×24 stroke SVGs (`screen`, `camera`, `mic`, `mic-off`, `speaker`, `record`, `pause`, `stop`, `check`, `warning`, `error`, `library`, `recover`, `chevron`). `aria-hidden="true"` by default; exposes `role="img"` + `<title>` only when `title` is passed. Zero external assets. |
| [`Button.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/Button.tsx) | **Implemented (UX-1 foundation)** | Variants: `primary`, `secondary`, `ghost`, `danger`, `record`; sizes `md` (`min-height: 44px`), `lg` (`min-height: 56px`); `busy` spinner sets `aria-busy="true"` and `disabled` while keeping the text label visible. |
| [`StatusPill.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/StatusPill.tsx) | **Implemented (UX-1 foundation)** | Tones: `neutral`, `ok`, `warning`, `danger`, `recording`. Always renders visible text alongside any status dot; exposes `role="status"` + `aria-label` when `statusLabel` is provided. |
| [`Banner.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/Banner.tsx) | **Implemented (UX-1 foundation)** | Tones: `info`, `warning`, `danger`. Danger banners default to `role="alert"`; persistent info/warning banners omit live roles unless `announce={true}` so they do not chatter. |
| [`Disclosure.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/Disclosure.tsx) | **Implemented (UX-1 foundation)** | Native `<details class="ui-disclosure">` with `min-height: 44px` `<summary>`. Keeps children mounted when collapsed so media elements/engines inside never unmount. |
| [`ProgressBar.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/ProgressBar.tsx) | **Implemented (UX-1 foundation)** | Native `<progress>`: determinate (`value` clamped to `[0, 1]`, `NaN`/`Infinity` safe) for known chunk counts; indeterminate (no `value` attribute) for `stopping` and `finalizing` where percentage is unknown. |
| [`LevelMeter.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/LevelMeter.tsx) | **Implemented (UX-1 foundation)** | 10-segment visual bar (`role="meter"`, `aria-valuenow`, `aria-valuetext` with `Muted` / `No input` states). Never a live region. |
| `AppShell` & `TopBar` | **Planned (`UX-1`)** | Persistent studio header, navigation switcher (`Studio`, `Recordings`, `Recovery`, `Diagnostics`), service status pill, and active `● REC` indicator. |
| `SourceCard` | **Planned (`UX-2`)** | Unified card per source (`Screen`, `Camera`, `Microphone`) combining device `<select>`, primary `Start`/`Switch`/`Share` button, `Stop` button, status line, and inline error alert. |
| `LayoutPresetPicker` | **Planned (`UX-2`)** | Visual 4-preset selector (`Screen only`, `Camera only`, `Picture in picture`, `Split screen`) backed by native accessible controls plus keeping the `<select aria-label="Layout">` contract intact. |
| `RecordingDock` | **Planned (`UX-3`)** | Sticky bottom control bar housing `Session title`, storage mode radios, readiness pills, `Start recording` / `Pause` / `Resume` / `Stop`, duration `<time>`, upload/finalization progress, and completion tray. |
| `SessionLibraryPanel` | **Planned (`UX-4`)** | Read-only session history list powered by `GET /api/v1/sessions` with cursor pagination and truthful status/size/duration badges. |
| `ConfirmDialog` | **Planned (`UX-4`)** | Native `<dialog>` modal with focus restoration and `Escape` handling for explicit salvage confirmation or future destructive actions. |

---

## 7. Detailed Application State Matrix

Every UI state below maps 1-to-1 to existing engine snapshots (`CaptureState`, `AudioMixerState`, `RecordingSnapshot`, `DurableRecordingSnapshot`, `RecoveryInspection`, and `Capabilities`) without inventing a parallel recording state machine:

| UI State | Engine / API Condition | Stage & TopBar Presentation | Dock Primary & Secondary Actions | Visible Telemetry & Copy | Safety / Invariant Guard |
|---|---|---|---|---|---|
| **1. Initial / No Video Source** | `composedVideo` has no live video track (`videoReady === false`), `status === 'idle'` | Stage shows empty-state prompt on canvas + guidance to share screen or start camera | `Start recording` (`disabled`); helper copy explains: *"Share your screen or start a camera to enable recording."* | `Canvas video: unavailable` · `Mixed audio: unavailable (video-only recording)` | Never auto-open `getDisplayMedia` or `getUserMedia` on page load or on `Start recording` click. |
| **2. Requesting Permission** | Any `state[kind].pending === true` or `DeviceSetup.pending !== null` | Source card shows `"Respond to the browser prompt..."` | `Cancel {kind} request` enabled on that source card | Explains that `Cancel` abandons the app request but cannot close the browser's native permission dialog | Generation guard in `CaptureManager` / `DeviceSetup` immediately stops any late stream arriving after cancel. |
| **3. Ready to Record** | `videoReady === true`, recorder `status === 'idle'` | Live 16:9 composed `<canvas>`; active layout preset highlighted; PIP handles active when `layout === 'pip'` & `camera` active | Primary: **`Start recording`** (enabled when `mode === 'temporary'` or `title.trim().length > 0`) | `Canvas video: ready`; `Mixed audio: ready` (or warning if suspended/muted); selected mode (`Durable local session` default) | If `AudioContext` is `suspended`, show `Enable audio processing` button prominently while still allowing explicit video-only recording. |
| **4. Creating Session** | Durable `status === 'creating'` | Live preview continues; inputs locked (`anyActive === true`) | All transport buttons disabled (`Creating session…`) | Status badge: `Creating session` | Bootstraps in-memory write token (`GET /api/v1/bootstrap`), creates session (`POST /api/v1/sessions`), and sends initial heartbeat before `MediaRecorder.start()`. |
| **5. Recording** | `recorderStatus === 'recording'`, durable `status === 'recording'` (or `'uploading'` while active) | Stage shows subtle recording border; TopBar shows `● REC 00:12`; `document.title` prefixes `● REC`; `beforeunload` active | Primary: **`Stop`**; Secondary: **`Pause`**; `Start recording` disabled | Monospace timer (`MM:SS`), format (`video/webm;codecs=...`), durable queue (`Browser queue: X B in Y chunk(s). Acknowledged: Z.`) or temporary memory (`X / 128 MiB`) | Layout presets and PIP drag/resize remain interactive; resolution and storage mode are locked for the session. |
| **6. Paused** | `recorderStatus === 'paused'` | Stage badge shows `Paused`; timer frozen (paused wall-clock time excluded by `RecordingEngine`) | Primary: **`Resume`**; Secondary: **`Stop`** | Status badge: `Paused`; chunk queue continues draining in background if durable | Audio and video clocks stay aligned; heartbeat lease continues refreshing every 4s while paused. |
| **7. Stopping / Uploading Drain** | `recorderStatus === 'stopping'` or durable `status === 'uploading'` after stop | Stage remains live; dock shows determinate `ProgressBar` (`acknowledgedChunks / (acknowledgedChunks + queuedChunks)`) | Transport buttons disabled; `beforeunload` guard remains active | Status badge: `Stopping` or `Uploading`; *"Saving remaining chunks to this computer—keep this tab open."* | Waits for final `dataavailable` blob, Web Crypto SHA-256 digest queue, and `RecordingChunkTransport.drain()` ACKs. |
| **8. Retrying Upload** | Durable `status === 'retrying'` | Warning banner in dock (`tone="warning"`) | Transport buttons disabled; `beforeunload` guard active | Status badge: `Retrying`; shows `Upload attempts: N` and *"Reconnecting to local service…"* | `RecordingChunkTransport` retries identical head chunk with exponential backoff + jitter (up to 5 attempts); never re-sequences or drops chunks. |
| **9. Finalizing** | Durable `status === 'finalizing'` | Indeterminate `ProgressBar` in dock | Transport buttons disabled; `beforeunload` guard active | Status badge: `Finalizing`; *"Assembling and validating WebM with FFprobe…"* | Calls `POST /api/v1/sessions/:id/finalize` with exact `expectedChunkCount` (up to 3 transient retries). **Never claims Saved during this phase.** |
| **10. Completed / Saved** | Durable `status === 'completed'` and `output !== null` (or temporary `status === 'completed'` and `resultUrl !== ''`) | `beforeunload` cleared; `document.title` restored | Primary: **`Start new recording`**; Secondary: **`Clear status`** (plus `Download WebM` link & `<video>` preview in temporary mode) | Durable: **`Saved locally`** card with `Session <id> · <N> chunks · <size>`; Temporary: playable `<video>` preview + size | Durable `Saved` is gated strictly on `finalizedRecordingSchema`-validated server output. Borrowed capture/compositor/mixer tracks remain live for another take. |
| **11. Failed** | `status === 'failed'` (`state.error !== ''`) | Error alert (`role="alert"`) in dock | Primary: **`Start new recording`**; Secondary: **`Clear status`** + link to **Recovery** when `acknowledgedChunks > 0` | Shows `state.error` plus safe-data reassurance: if `acknowledgedChunks > 0`, states how many chunks were acknowledged to disk | Failure never stops borrowed capture/compositor/mixer tracks and never displays `Saved locally`. Triggers `RecoveryPanel` refresh. |
| **12. Recoverable / Interrupted** | `GET /api/v1/recovery` returns items with `condition: 'valid-incomplete' \| 'finalizing' \| 'corrupt' \| 'empty' \| 'active'` | Topbar `Recovery (N)` badge + launch notification banner when `recoverable === true` | **`Salvage acknowledged chunks`** (enabled only when `item.recoverable && !item.activeOperation && !busy`) + **`Refresh`** | Shows session title, condition, `contiguousChunkCount/committedChunkCount chunks verified · <bytes>`, and server message | Salvage requires explicit click, seals session `recoverable`, runs full FFprobe finalization, and preserves original chunk files. |
| **13. Service Offline** | `loadCapabilities()` fails (`error !== ''` in `main.tsx`) | Top warning banner: `Cannot reach the local service...` | **`Retry connection`** button; temporary browser preview remains usable offline | Local service: `Unavailable`; Metadata storage: `Not verified` | Never offer durable local session as ready when the backend service is unreachable. |

---

## 8. Technical Migration & Invariant Guardrails

1. **Zero changes to media/storage/transport engines for layout work:** `CaptureManager`, `CanvasCompositor`, `AudioMixer`, `RecordingEngine`, `DurableRecordingEngine`, `RecordingChunkPipeline`, `RecordingChunkTransport`, `RecoveryClient`, and all `apps/server/**` services keep their existing state machines and public interfaces.
2. **Preserve all 34 Chromium E2E accessible-name contracts:**
   Every existing accessible query used across `tests/e2e/*.spec.ts` and `tests/acceptance/five-minute-recording.spec.ts` **must remain mounted and queryable with the exact same role and accessible name**, including:
   - Headings & landmarks: `heading[level=1]`, `Screen`, `Camera`, `Microphone`
   - Buttons: `Share screen`, `Change shared source`, `Stop display`, `Cancel display request`, `Start camera`, `Switch camera`, `Stop camera`, `Start microphone`, `Switch microphone`, `Stop microphone`, `Stop all capture`, `Check camera access`, `Check microphone access`, `Cancel access check`, `Refresh devices`, `Enable audio processing`, `Move webcam overlay`, `Resize webcam overlay`, `Start recording`, `Start new recording`, `Pause`, `Resume`, `Stop`, `Clear status`, `Salvage acknowledged chunks`, `Refresh`, `Check local access`, `Retry connection`, `Retry screen preview`, `Retry camera preview`
   - Form controls: `Camera device`, `Microphone device`, `Layout`, `Resolution`, `Screen proportion`, `Webcam horizontal position`, `Webcam vertical position`, `Webcam overlay width`, `Webcam overlay height`, `Mute microphone`, `Microphone gain`, `Mute display audio`, `Display audio gain`, `Durable local session`, `Temporary browser preview`, `Session title`
   - Media & meters: `Screen preview`, `Camera preview`, `Composed video preview`, `Recorded WebM preview`, `Microphone live level`, `Display audio live level`
   - Statuses & lists: `Camera permission`, `Microphone permission`, `Camera check`, `Microphone check`, `Capture activity`, `Screen capture status`, `Camera capture status`, `Microphone capture status`, `Screen actual track settings`, `Microphone actual track settings`, `Canvas output status`, `Audio mix mode`, `Mixed audio output status`, `Recording status`, `Recording format`, `Local access check`, `Canvas video: ready`, `Mixed audio: ready`, `Mixed audio: unavailable (video-only recording)`, `Saved locally`, `Connected`, `Ready · SQLite`, `Not implemented`
3. **Keep `<details>` disclosures mounted:** Placing secondary panels (`StreamPreview` raw source videos, track settings lists, one-shot `DeviceSetup` access checks, PIP geometry sliders, workspace diagnostics) inside `<details class="ui-disclosure" open>` (or toggling `open` via responsive state while keeping DOM nodes mounted) reduces visual clutter without unmounting elements or breaking E2E locators.
4. **No persistent credentials or external network requests:** Keep `writeToken` strictly in closure/instance memory (`api.ts`, `DurableRecordingEngine`, `RecoveryClient`). Maintain `default-src 'self'` CSP with inline SVGs and system fonts only.

---

## 9. Incremental Implementation Plan and Testable UX Backlog

This plan aligns with [`TASKS_UX_SECTION.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/TASKS_UX_SECTION.md) (`UX-0` through `UX-5` + `UX safety acceptance gate`) and merges the already-verified token/primitive foundation (`UX-1A`):

### `UX-0` — Baseline Audit, Live Chromium Inspection, and Plan Review (**Completed 2026-11-11 — Stopped for Review**)
- **Deliverables:**
  - Direct inspection of `AGENTS.md`, `PRD.md`, `ARCHITECTURE.md`, `TASKS.md`, `DECISIONS.md`, `UX_DESIGN.md`, `TASKS_UX_SECTION.md`, and all React/TypeScript sources.
  - Live Chromium inspection and screenshot capture at `1440×900`, `1280×720`, `768×1024`, and `375×812` across initial, active PIP capture, durable recording, and Saved states.
  - Complete control bounding-box and live-region inventory (`17` buttons, `15+` status regions, `6,119px` desktop height, `1,643px` gap between preview and Record).
  - Updated `UX_DESIGN.md` and merged non-duplicated UX tasks into `TASKS.md`.
- **Gate:** **Stop here for design review before refactoring application screens (`UX-1B`–`UX-5`).**

### `UX-1` — Design System Foundation, Unified Navigation, and Studio Shell
- **`UX-1A` — Design tokens, inline SVG icons, and accessible UI primitives (**Completed & Verified 2026-11-11**):**
  - Landed `apps/client/src/ui/tokens.css`, `apps/client/src/ui/{Icon,Button,StatusPill,Banner,Disclosure,ProgressBar,LevelMeter}.tsx`, and tokenized `apps/client/src/style.css` (fixing undefined `var(--muted)` and unloaded `Inter` font).
  - Verified by [`tests/design-tokens.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/design-tokens.test.ts) (WCAG 2.2 AA contrast ratios across all surface/text/border pairs) and [`tests/ui-primitives.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/ui-primitives.test.ts), plus all 34 Chromium E2E tests.
- **`UX-1B` — Unified Studio shell & persistent view navigation (**Completed & Verified 2026-11-11 — Stopped for Review**):**
  - Implemented [`AppShell.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AppShell.tsx), [`shell-status.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/shell-status.ts), [`RecordingsPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingsPanel.tsx), [`SettingsPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/SettingsPanel.tsx), and `loadSessions` in [`api.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/api.ts), replacing the single-column root in [`main.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/main.tsx).
  - Compact branded `<header className="app-header">` with `Local service status` pill (`Connecting…` / `Connected` / `Unavailable`), derived `Studio activity status` pill (`Studio idle`, `N source(s) active`, `Creating session…`, `Recording · MM:SS`, `Paused · MM:SS`, `Stopping…`, `Uploading`, `Retrying upload…`, `Finalizing WebM…`, `Session saved`, `Preview ready`, `Recording error`), and `<nav aria-label="Studio navigation">` for `Studio`, `Recordings`, `Recovery` (with unfinished count badge), and `Settings`.
  - Synchronized view state with `window.location.hash` (`#studio`, `#recordings`, `#recovery`, `#settings`), `history.pushState`, `popstate`, and `hashchange` without adding a router dependency. Added keyboard `ArrowLeft`/`ArrowRight`/`Home`/`End` navigation and `aria-current="page"`.
  - Kept the `Studio` media tree (`DeviceSetupPanel` → `CapturePanel` → `CompositorPanel` → `AudioMixerPanel` → `RecordingPanel`) permanently mounted (`hidden={activeView !== 'studio'}`) so switching views never stops tracks, disposes recordings, drops queued chunks, or duplicates compositor/mixer/recorder instances.
  - Verified by [`tests/shell-status.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/shell-status.test.ts) (`233` passing unit/API/storage/UI tests, `1` skipped real-FFprobe test) and **36 passing Chromium E2E tests** in [`tests/e2e/foundation.spec.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/e2e/foundation.spec.ts) and [`tests/e2e/recording.spec.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/e2e/recording.spec.ts).

### `UX-2` — Preview-First Recording Studio & Two-Column Broadcast Layout (**Completed & Verified 2026-11-11**)
- **Deliverables:**
  - Replaced the single-column `6,119px` stacked `Studio` layout with a modern **two-column broadcast studio grid** (`.studio-grid` in [`CapturePanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CapturePanel.tsx) and [`style.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/style.css)):
    - **Left / Main Stage Column (`.studio-stage-column`):** Top 16:9 [`CompositorPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/CompositorPanel.tsx) stage (`Composed video preview` `<canvas>`) with four visual composition preset buttons (`PIP`, `Split`, `Screen`, `Camera` in `role="group" aria-label="Scene composition presets"`), a `44×44px` circular `.pip-resize` corner handle, and a compact scene toolbar, paired directly above the docked [`RecordingPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/RecordingPanel.tsx) transport bar (`00:00` clock, `Start recording`, `Pause`/`Resume`/`Stop`, storage mode radio group, `Session title`, and readiness chips).
    - **Right / Control Rail Column (`.studio-rail-column`):** Compact horizontal `Live capture` source rows (`Screen`, `Camera`, `Microphone`) with `96×54px` 16:9 mini [`StreamPreview.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/StreamPreview.tsx) monitors and `Stop all capture` in the header, followed by the compact 2-channel [`AudioMixerPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AudioMixerPanel.tsx) (`Microphone` and `Display audio` meters, mute, gain) and compact 2-column [`DeviceSetupPanel.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/DeviceSetupPanel.tsx) (`Camera device` and `Microphone device` selectors, access checks, and `Refresh devices`).
  - Removed redundant walls of instructional paragraphs across Studio panels while preserving all ARIA labels, live status regions, and media engine ownership invariants.
- **Verified viewport metrics (Chromium inspection, 2026-11-11):**
  - `1440×900` desktop: total `scrollHeight` reduced from `6,119px` to `1,304px` (**-78.7%**); `.compositor-stage canvas` (`top: 169px, bottom: 610px`) and `Start recording` (`top: 799px, bottom: 836px`) are both completely above the fold (`<= 900px`).
  - `1280×720` laptop: total `scrollHeight` reduced from `6,119px` to `1,220px`; `.compositor-stage canvas` (`top: 143px, bottom: 496px`) and `Start recording` (`top: 655px, bottom: 692px`) are both completely above the fold (`<= 720px`).
  - `375×812` mobile: responsive single-column collapse (`scrollHeight: 3,004px` vs. `7,541px` previously) with `0px` horizontal overflow.
- **Acceptance tests:** Verified by [`tests/e2e/compositor.spec.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/e2e/compositor.spec.ts) (`two-column studio keeps composed preview, layout presets, 44px PIP handle and Start recording above the fold`) and all **37 passing Chromium E2E tests**.

### `COLOR-0`–`COLOR-3` — Electric Violet Dark-Theme Visual Redesign (**Completed & Verified 2026-11-12**)
- **Deliverables ([`ELECTRIC_VIOLET_UX_REDESIGN.md`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/ELECTRIC_VIOLET_UX_REDESIGN.md), [`tokens.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/ui/tokens.css), [`style.css`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/style.css), [`AppShell.tsx`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/apps/client/src/components/AppShell.tsx)):**
  - Defined Electric Violet semantic dark-theme tokens (`--color-bg: #0c0a16`, `--color-surface: #191529`, `--color-surface-raised: #241d38`, `--color-surface-hover: #302644`, `--color-primary: #9b5cff`, `--color-primary-hover: #b79aff`, `--color-on-primary: #0c0a16`, `--color-accent: #00e5c3`, `--color-focus: #00e5c3`, `--color-text: #f6f2ff`, `--color-text-muted: #a9a4bb`, `--color-success: #3fd0a8`, `--color-warning: #ffb259`, `--color-danger: #ff6678`, `--color-recording: #ff445e`, `--color-disabled-bg: #302b3b`, `--color-disabled-text: #8b849b`) alongside compatibility aliases.
  - Enforced dark ink (`#0C0A16`) on filled violet primary buttons (`5.01:1` normal-text contrast, `8.48:1` on hover), reserved red strictly for active recording and errors, amber for warnings/retries/recovery, and mint/green for verified completion and connected health check.
  - Applied across `AppShell` (connectivity dot shown only when `serviceState === 'connected'`), Studio preview stage, layout presets, `44×44px` PIP corner handle, live source/audio rails, recording dock, banners, and recovery views without touching media or persistence services.
- **Acceptance tests:** Verified by [`tests/design-tokens.test.ts`](file:///c:/Users/hp/Desktop/Projects/screen%20and%20video%20recorder/tests/design-tokens.test.ts) (`94 passed`, including alpha-composited backdrop contrast checks) and all **37 passing Chromium E2E tests**. Optional light mode (`COLOR-4`) remains deferred.

### `UX-3` — State-Driven Recording Dock & Truthful Saving Feedback
- **Deliverables:**
  - Sticky bottom recording dock with `Durable local session` selected by default when the local service is connected (while keeping `Temporary browser preview` selectable).
  - State-aware primary button styling (`Start recording` when ready, `Stop` primary + `Pause` secondary when recording, `Resume` primary when paused, `Start new recording` when completed/failed).
  - Prominent active recording indicator in TopBar/dock, `document.title` recording status prefix, optional skippable 3-second countdown (encoding starts only after countdown finishes), and `beforeunload` warning while `recording`, `paused`, `stopping`, `uploading`, `retrying`, or `finalizing`.
  - Determinate upload drain `ProgressBar` during `uploading`, indeterminate `ProgressBar` during `stopping`/`finalizing`, clear retry warning banner during `retrying`, and truthful `Saved locally` card only when `output !== null`.
- **Acceptance tests:** Unit tests for derived dock states; E2E tests verifying no false `Saved locally` on failed/interrupted finalization, `beforeunload` registration only during active states, and both durable and temporary E2E recording tests passing.

### `UX-4` — Session Library & Interrupted Recovery Experience
- **Deliverables:**
  - Add client API helper for `GET /api/v1/sessions` and render the `Recordings` view showing persisted sessions (title, created time, layout/resolution, lifecycle badge, chunk count, and verified output size/duration when `completed`) without inventing unimplemented playback/delete/export buttons.
  - Enhance `RecoveryPanel` with human-readable condition badges alongside existing verified chunk/byte counts, surface a top banner/badge when unfinished sessions exist on launch, and automatically refresh recovery state after any durable recording failure in the current tab.
- **Acceptance tests:** E2E test verifying newly created/completed sessions appear in `Recordings`, durable failure auto-refreshes recovery, and `Salvage acknowledged chunks` completes idempotently only after probe validation.

### `UX-5` — Accessibility, Responsive Ergonomics, and Usability Validation
- **Deliverables:**
  - Keyboard shortcuts (`R` record/stop, `P` pause/resume, `Escape` cancel countdown) guarded per WCAG 2.2 SC 2.1.4 (toggleable off switch, disabled inside `input`/`select`/`textarea`/slider/PIP drag, ignored when Ctrl/Alt/Meta are held).
  - Full keyboard-only navigation pass, `prefers-reduced-motion` verification, `375px` / `768px` / `1280px` / `1440px` layout verification, and documented protocol/log for 5-user moderated usability sessions and Windows screen-reader checks.
- **Acceptance tests:** Unit + E2E tests for shortcut guards, contrast/primitive suites, and zero horizontal overflow across all four viewports.

---

## 10. Open Decisions & Sign-Off Checklist for Design Review

### Decisions previously confirmed by user (2026-11-11)
1. **Default recording mode:** Default to **Durable local session** ("Save to this computer"), with **Temporary browser preview** still available for quick tests and for existing E2E specs.
2. **Pre-record countdown:** Support an optional **3-second skippable countdown** (with an instant "Skip / Start now" action and a toggle so automated E2E tests and repeat takes can start immediately without delay).
3. **Mid-recording layout switching:** Allow switching layout presets (`Screen`, `Camera`, `PIP`, `Split`) and moving/resizing the PIP overlay while recording; lock resolution (`720p`/`1080p`) and recording mode once a session starts.
4. **Session library scope:** Ship a truthful read-only **Recordings** list backed by the existing `GET /api/v1/sessions` endpoint now; defer Play/Download/Delete buttons until their backend routes are implemented in Phase 5.
5. **Keyboard shortcuts:** Single-key shortcuts (`R`, `P`, `Escape`) with a user-visible on/off switch and focus/modifier guards (WCAG 2.1.4).

### Review sign-off checklist (confirm to proceed to `UX-2`–`UX-5` implementation)
- [x] Latest source files and live Chromium screenshots (`1440×900`, `1280×720`, `768×1024`, `375×812`) inspected; provisional hypotheses replaced with measured DOM/code findings (§2).
- [x] Design tokens and accessible primitive components verified with automated contrast and markup tests (`UX-1A`).
- [x] Unified navigation and persistent Studio shell (`UX-1B`) implemented and verified across all 4 views (`Studio`, `Recordings`, `Recovery`, `Settings`), viewports (`1440×900`, `1280×720`, `768×1024`, `375×812`), and active capture/recording/upload/retry/finalization flows.
- [ ] Review `UX-1B` before proceeding to `UX-2` (preview-first studio panel reorganization and progressive disclosure).
