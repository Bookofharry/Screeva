# Local Creator Recorder — Product Requirements Document

> Status: Draft product specification. Phase 1 and Phase 2 input setup, sustained capture/preview, canvas composition, audio mixing/meters and bounded in-memory WebM recording are implemented; Phase 3 durable chunked recording, finalization and acknowledged-chunk recovery are implemented, with real-FFprobe acceptance and failure-injection tests still open. See TASKS.md for verified progress and synthetic versus hardware verification limits. Version 0.1 — updated 2026-11-11.  
> Working name: Local Creator Recorder (rename before release).  
> Audience: Developers, educators, tutors, creators.  
> Platform: Windows first, Chrome and Edge; browser UI with a local Node.js server.

## 1. Vision
Build a free, open-source, privacy-first recorder for coding tutorials and classes. Capture screen, webcam, microphone and browser/OS-supported shared audio; compose professional layouts; keep a presenter framed; focus attention on code; store recoverable recordings locally; and export MP4 without cloud uploads.

### Principles
- Local-first: no account, cloud processing, or telemetry by default.
- Reliable recording before intelligent effects.
- Browser permission flows are explicit; never secretly capture media.
- Design as a standalone recorder with optional future Frame Studio interoperability.
- Keep the original media if an MP4 export fails.

## 2. Personas and workflows
### Developer educator
Select VS Code/window, webcam and microphone; use picture-in-picture; focus a function or terminal; record and export an MP4 for a course.
### Classroom instructor
Capture slides or lesson screen and narration for up to two hours; resume after pauses; recover acknowledged data if the browser crashes.
### Technical creator
Switch between full-screen, webcam, split, and picture-in-picture layouts; highlight a region; export a video for editing or posting.

## 3. Success criteria
- First successful local 5-minute recording with screen + webcam + mixed audio.
- 720p/30 baseline; target 1080p/30 on capable hardware, measured rather than assumed.
- Two-hour session soak test with bounded browser memory and local disk ingestion.
- Previously committed chunks remain recoverable after simulated process/browser crash.
- Valid playable H.264/AAC MP4 with matching audio/video duration.
- No external network calls for media or inference after one-time dependency installation.

## 4. P0: required MVP functionality
| ID | Requirement | Acceptance criteria |
|---|---|---|
| CAP-01 | Screen/window/tab share | Initiated by user gesture; permission failures explained; preview available |
| CAP-02 | Webcam capture | Select camera, toggle on/off, camera-only mode |
| CAP-03 | Microphone capture | Select mic, meter, mute, device disconnect state |
| CAP-04 | System/tab audio | Include when provided by getDisplayMedia; explicitly say when unavailable |
| COM-01 | Scene layouts | Screen, camera, split, and draggable/resizable picture-in-picture |
| COM-02 | Resolution and FPS | 720p/30 baseline and selectable 1080p/30 target |
| CAM-01 | Manual webcam crop | Position and digital zoom; bounded source crop |
| CAM-02 | Presenter auto framing | Local face detection, smoothed centered crop, off switch, lost-face fallback |
| FOC-01 | Focus zoom | Select region on local preview, apply smoothed focus and reset |
| FOC-02 | Focus presets | Save region presets for code, terminal, browser and full frame |
| AUD-01 | Audio mixing | Mix mic + available shared-screen audio; independent gain/mute |
| REC-01 | Recorder controls | Start, pause, resume, stop, prominent active indicator and timer |
| REC-02 | Chunked persistence | Bounded upload queue; idempotent chunk writes; server acknowledgment |
| REC-03 | Session recovery | Detect interrupted session, identify committed media, offer salvage |
| EXP-01 | MP4 export | FFmpeg export to H.264/AAC with progress, retry, cancellation |
| UX-01 | Session library | List/preview/download/delete sessions with confirmation |
| SEC-01 | Local API protection | Loopback binding, origin/host checks, authenticated writes, safe paths |

### P1: following MVP
- Optional distinct microphone and shared-audio files.
- Smoother scene transitions and keyboard shortcuts.
- Cursor/keystroke visualization through authorized integrations, not guessed system coordinates.
- Frame Studio import package after a documented interoperability contract exists.
- Automatic captions with an optional offline model.

### Non-goals
No livestreaming, cloud accounts, team collaboration, full timeline editor, unrestricted background capture, browser-based control of Windows Studio Effects, or promised universal system audio.

## 5. Core behavior and constraints
### Screen capture
Use `getDisplayMedia()` in a supported secure context, invoked from a click. The user chooses the source each time. Treat system-audio options as hints; inspect actual returned tracks. Source termination triggers safe stop/downgrade depending on active scene.
### Camera / face tracking
Use `getUserMedia()` and a local face detector (proposed: MediaPipe). Sample at adaptive ~10–15 Hz; smooth target crop with dead-zone and easing. If the face disappears briefly, hold crop; after a timeout, smoothly recenter. Manual crop overrides tracking until re-enabled. No promise of optical focus/zoom unless hardware capabilities expose it.
### Screen focus
Choose normalized crop rectangle `{x,y,width,height}` with values in [0,1]. Maintain canvas aspect ratio and clamp to source bounds. Smoothly interpolate zoom transitions. Allow presets; invalidate/remap them on source dimension change. Browser cannot generally access the operating system's global cursor position in a different app.
### Composition
One scene graph drives canvas preview and recorded video. Layout states: screen-only, camera-only, split, PIP. Prefer `canvas.captureStream(30)` with an explicit compositor clock; benchmark frame delivery under load. Recheck behavior when the captured screen freezes or becomes unavailable.
### Audio
Use Web Audio source nodes, gain controls, meters, and `MediaStreamAudioDestinationNode`. Do not route mic monitoring to speakers by default. Apply browser audio processing only when available. Ensure audio clock and visual timeline stay aligned on pause/resume.
### Encoding
Probe `MediaRecorder.isTypeSupported` and prefer supported WebM intermediate in Chromium. Output MP4 using server-side FFmpeg. Do not assume each `dataavailable` Blob is independently decodable. Preserve ordered chunks as a single logical recording stream; interrupted recovery is best effort and must be validated with FFprobe/FFmpeg.

## 6. Recording lifecycle
`idle -> preview -> recording <-> paused -> finalizing -> completed` with `failed`, `interrupted`, `recoverable` states. States and sequence metadata must persist to disk/SQLite.

### Durable storage protocol
1. Create session ID and manifest before recording.
2. Browser records bounded chunks, assigns monotonically increasing sequence IDs and checksums.
3. Browser sends a chunk with session authorization, sequence, and checksum.
4. Server validates limits and session ownership; streams to temporary file; flushes and atomically commits, then acknowledges.
5. Repeated upload with matching checksum is accepted; mismatching duplicate is rejected.
6. Client drops acknowledged chunks; retries transient errors with backoff; stops gracefully if queue is unsafe.
7. Finalize only after all expected chunks are committed; assemble bytes in order; probe media; retain raw intermediate; export separately.
8. Recover only contiguous committed data, validate decode, and communicate when salvage is partial.

**Important:** `MediaRecorder.start(timeslice)` intervals are approximate. Use media timestamps/probed duration, not timeslice times chunk count. Power-loss durability is subject to filesystem guarantees. Limitations must be visible in UI.

## 7. Local storage model
```text
data/
  recorder.sqlite
  sessions/<session-id>/
    manifest.json
    capture/000001.webm.part
    capture/000002.webm.part
    events.jsonl
    final/recording.webm
    final/recording.mp4
  exports/
  logs/
```
Use opaque IDs; never accept arbitrary client filesystem paths. SQLite contains status/metadata, not recording bytes. The local app owns data retention and deletion policy.

## 8. API draft
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/capabilities` | Backend and encoder capabilities |
| POST | `/api/v1/sessions` | Start session manifest |
| GET | `/api/v1/sessions` | List sessions |
| GET | `/api/v1/sessions/:id` | Session status |
| PUT | `/api/v1/sessions/:id/chunks/:seq` | Idempotent chunk write |
| POST | `/api/v1/sessions/:id/finalize` | Assemble and verify stream |
| GET | `/api/v1/sessions/:id/recovery` | Recovery readiness |
| POST | `/api/v1/sessions/:id/exports` | Queue MP4 conversion |
| GET | `/api/v1/exports/:id` | Export progress |
| POST | `/api/v1/exports/:id/cancel` | Cancel export |
| GET | `/api/v1/exports/:id/file` | Download exported MP4 |

## 9. UX / screen map
- **Home:** New recording, recent sessions, storage usage.
- **Setup:** Screen source prompt, camera/mic selectors, test meter, resolution, layout preset.
- **Recording studio:** Unified preview, movable webcam, face tracking toggle, focus region controls, elapsed time, pause/stop, loss warnings.
- **Recovery:** Interrupted sessions, last committed chunk, probe results, attempt recovery.
- **Library:** Status, duration, preview, export, delete.
- **Export:** Quality, destination, progress, retry, preserve source.

## 10. Security and privacy
- Bind server to `127.0.0.1`; same-origin UI/API. No wildcard CORS.
- Protect mutating API calls with unpredictable per-launch capability token and Origin/Host/Fetch Metadata checks; test malicious cross-origin requests and DNS rebinding cases.
- Validate payloads; enforce size, resource and file quotas; validate path containment and symlink handling.
- Spawn FFmpeg with argument arrays, no shell interpolation; apply CPU/time/memory/disk constraints to untrusted media.
- Do not include private tokens in exported metadata, logs, or project files.
- No externally hosted ML models/scripts in offline mode. Supply local artifacts with appropriate licenses.

## 11. Test plan
- Pure logic: crop math, transition easing, session-state transitions, chunk sequencing, checksum deduplication.
- API integration: invalid origins, rejected MIME/oversize chunks, idempotent retries, missing sequences, invalid paths, export cancellation.
- Browser E2E: permissions errors, device disconnect, preview layout, pause/resume, lost screen share.
- Media tests: generated fixtures, FFprobe output metadata, frame and audio synchronization, 720p/1080p exports.
- Failure injection: restart backend mid-session, kill browser, kill FFmpeg, full disk simulation, missing chunk, corrupted bytes.
- Soak: 2-hour class with bounded RAM, disk rate, dropped frames, A/V drift tracked.

## 12. Implementation phases
| Phase | Deliverable | Done when |
|---|---|---|
| 1. Foundation | TypeScript monorepo, React, Express, SQLite, security baseline | Local boot + CI + API checks |
| 2. Capture | Screen/camera/mic, layouts, mixer, MediaRecorder | 5-min synchronized output |
| 3. Resilience | Chunk commits, manifest, interrupted sessions, salvage | Crash recovery test passes |
| 4. Presentation | Face auto frame, manual zoom, region focus and presets | Stable tracking under load |
| 5. Export | FFmpeg pipeline, MP4, progress/cancel, library | Verified playable MP4 |
| 6. Release | Soak/security/packaging/docs | Clean Windows setup + 2-hour test |

## 13. Open questions / decisions to make
- Product name and trademark availability.
- MIT vs Apache-2.0 or another license after checking dependencies.
- Local installation: Node scripts versus bundled desktop runtime later.
- Whether the rendered output alone is sufficient for MVP or separate source tracks should be captured from day one.
- Session retention defaults, automatic clean-up, low-disk thresholds.
- Local model package size, optional tracking download versus bundled offline model.
- Frame Studio import contract version and discoverability.

## 14. Source references
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream
- https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode
- https://ffmpeg.org/ffmpeg.html

## 15. Project documentation
Read `AGENTS.md` first for coding-agent instructions, `ARCHITECTURE.md` for technical boundaries, `TASKS.md` for the next unit of work, and `DECISIONS.md` for decisions and trade-offs. Keep these files aligned with implemented behavior.
