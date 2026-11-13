# DECISIONS.md — Architecture Decision Log

> Proposed decisions; confirm as implementation progresses. Use one entry per meaningful trade-off.

## ADR-001 — Local browser + Node.js backend
**Status:** Proposed (user-selected deployment).  
**Decision:** Serve a React browser UI from local Express and process stored recordings through local FFmpeg.  
**Reason:** Browser provides capture and flexible interface; local server handles durable files and conversion.  
**Trade-off:** Requires installation and local service lifecycle management.

## ADR-002 — Browser capture, server export
**Status:** Proposed.  
**Decision:** Use getDisplayMedia/getUserMedia, Canvas, Web Audio, MediaRecorder, then FFmpeg for MP4.  
**Reason:** No need to ship a native capture binary for the MVP.  
**Trade-off:** OS/browser-dependent capture restrictions and intermediate codecs.

## ADR-003 — Durable chunk ledger
**Status:** Proposed.  
**Decision:** Server streams sequenced chunks to disk with acknowledged commits and SQLite status.  
**Reason:** Reduce lecture loss on crashes and keep browser memory bounded.  
**Trade-off:** Additional complexity and best-effort recovery of incomplete containers.

## ADR-004 — Local face auto framing
**Status:** Proposed.  
**Decision:** Use local lightweight face detector with stable crop logic, not remote inference or mandatory Windows Studio Effects.  
**Reason:** Works offline and can degrade gracefully without supported NPUs.  
**Trade-off:** Extra CPU use and digital zoom quality loss.

## ADR-005 — Standalone recorder, optional Frame Studio integration
**Status:** Proposed.  
**Decision:** First export ordinary MP4; design a versioned optional import manifest later.  
**Reason:** Separate product responsibilities and independent release cycles.  
**Trade-off:** Early users import files manually.

## ADR-006 — Foundation implementation and same-origin development
**Status:** Accepted.  
**Date:** 2026-11-10.  
**Context:** Phase 1 needs a runnable local scaffold with the same security rules in development and production.  
**Decision:** Use npm workspaces, strict TypeScript, Vite/React builds served by Express on `127.0.0.1`, Zod v1 envelopes, and a guarded bootstrap for random per-launch write capabilities. Development watches disk builds without a second Vite HTTP listener. Use a harmless authenticated diagnostic endpoint to verify the write boundary until session routes exist.  
**Alternatives:** Separate Vite dev server plus CORS/proxy; cookie-based authorization.  
**Consequences:** Manual browser reload after client rebuilds; fewer origin exceptions. Native HTTP callers can forge browser headers, so this protects against hostile websites rather than malicious programs running as the user. Token rotation requires fresh bootstrap after restart. Capture permissions remain disabled until Phase 2.

## ADR-007 — Built-in SQLite metadata foundation
**Status:** Accepted.  
**Date:** 2026-11-10.  
**Context:** Windows-first setup should not require a native npm database addon for initial metadata.  
**Decision:** Target Node 24.13+ within major 24 and use `node:sqlite`, WAL, full synchronous writes and transactional schema initialization. Fail on unknown future versions; preserve existing records. Keep database operations behind a storage adapter.  
**Alternatives:** A separately compiled SQLite addon or JSON-only metadata.  
**Consequences:** SQLite is experimental in the tested Node 24.13 runtime. Synchronous access is limited to small metadata operations; future ingestion must avoid blocking on media work. Schema version 1 is only an empty sessions-table foundation, not the durable ledger in ADR-003. Reject storage links; concurrent hostile filesystem replacement by the same OS user remains out of scope.

## ADR-008 — Working name and source license
**Status:** Accepted for development; release name remains provisional.  
**Date:** 2026-11-10.  
**Decision:** Keep Local Creator Recorder as the working name and license project source under MIT. Document direct dependency purposes and declared licenses in DEPENDENCIES.md; retain the npm lockfile and inventory its transitive license declarations.  
**Consequences:** No product-name/trademark clearance is claimed. Future FFmpeg/model distribution requires its own license review. No source media is included in tests.

## ADR-009 — Portable build fallback and advisory remediation
**Status:** Accepted.  
**Date:** 2026-11-10.  
**Context:** Windows Application Control blocked Rolldown's native addon during the initial Vite build; npm audit also reported a minimatch denial-of-service advisory in lint tooling.  
**Decision:** Include the official `@rolldown/binding-wasm32-wasi` fallback at exactly the resolved Rolldown version and override development-tree minimatch to 11.0.5. Leave OS security policy intact.  
**Consequences:** Larger development install; fallback/version alignment must be maintained. Clean installation, build, lint, tests and audit are required after dependency updates. Both changes were verified locally; audit reported zero vulnerabilities afterward.

## ADR-010 — Input setup uses brief, explicit access checks
**Status:** Accepted.  
**Date:** 2026-11-10.  
**Context:** Phase 2 begins with permission/status UI and device selectors, before sustained preview/capture is implemented. Device names may be hidden before browser permission.  
**Decision:** Discover devices without starting capture, observe available permission statuses, and request one chosen input only from its Check access button. Stop every returned track immediately. Permit same-origin camera/microphone through Permissions Policy, leaving screen capture disabled. Keep selected IDs in memory.  
**Alternatives:** Automatically opening devices on mount; holding streams to retain labels; implementing the whole recording pipeline in the setup task.  
**Consequences:** Browser prompts remain explicit. Labels can remain hidden when the browser restricts enumeration. Cancellation abandons results rather than dismissing the browser prompt; new checks wait until it settles and late tracks are stopped. Device-open success does not imply persistent permission. Browser tests use mocked/synthetic devices; physical hardware acceptance remains pending. No dependencies added.  
**References:** [Device enumeration](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices), [getUserMedia behavior](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [permission queries](https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query).

## ADR-011 — Separate sustained capture ownership and explicit switching
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 2 Task 2 needs long-lived streams without confusing them with short-lived permission checks or implementing recording/composition. Browser prompts cannot generally be aborted.  
**Decision:** A dedicated CaptureManager owns independent display, camera and microphone streams, event listeners and settings timers. UI previews borrow streams through srcObject and never stop them. Permission checks retain their separate service and are disabled for active/pending inputs. API calls remain directly in user-click paths. Source switching stops the previous source before opening its replacement. Generations reject stale results; cancelled requests remain serialized until the native promise settles.  
**Alternatives:** Keep old streams during replacement; let components own track lifetime; combine checks and capture in one service.  
**Consequences:** Switching can have a visible gap; failed/cancelled replacements leave that source off, with no automatic fallback. Late results after stop/unmount are released. Track/stream events, device-change checks with ownership guards, and one-second status/settings refresh keep state truthful. Screen-video termination releases optional display audio, whereas audio-only loss preserves video. Muted previews and a microphone activity indicator avoid speaker feedback without introducing audio mixing. No dependencies or persistent-media changes.

## ADR-012 — Same-origin display capture and synthetic native-API verification
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Decision:** Enable `display-capture=(self)` alongside existing camera/microphone policy; retain Host/Origin/write-token protections. Allow self/blob media in CSP for local preview. Validate lifecycle races with injected streams and live frame delivery with generated fixtures. Native camera/microphone tests use Chromium fake devices; native getDisplayMedia testing selects only an isolated generated tab using a test-only browser flag. Full Chromium's new headless mode is required because the default headless-shell returned NotSupportedError.  
**Consequences:** The application does not bypass user permission prompts or select sources automatically. Automated verification establishes stream ownership and live preview, not physical-hardware compatibility or manually operated OS pickers. A preview screenshot/pixel assertion contains only generated test content. Manual hardware validation remains pending.  
**References:** [getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [track ended behavior](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event), [srcObject](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/srcObject).

## ADR-013 — Borrowed source streams and normalized canvas composition
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 2 Task 3 needs one visual stream for later recording while CaptureManager remains the sole owner of permission-bearing source tracks. Layout controls must remain resolution-independent and source loss must not tear down the compositor.  
**Decision:** Use a standalone TypeScript `CanvasCompositor` that borrows screen/camera streams through private muted video elements. Keep layout geometry normalized, calculate contain/center-cover crops in pure functions, and render to a fixed 16:9 canvas at selectable 720p or 1080p with a 30 fps target. Maintain exactly one requestAnimationFrame loop and cache one `canvas.captureStream(30)` output. React owns only UI state and passes source/config replacements to the engine.  
**Alternatives:** Draw directly from React effects; mutate source constraints to match the canvas; create a fresh output stream per consumer; stop borrowed tracks during compositor cleanup.  
**Consequences:** Capture ownership stays unambiguous and layout changes scale across presets. Missing sources can fall back without permission prompts. Compositor disposal stops only its output stream and detaches its video elements, so CaptureManager retains source lifecycle authority. Center-cover camera rendering may crop edges by design; screen rendering may letterbox. The fixed canvas can consume meaningful CPU/GPU at 1080p, so long-session performance remains an acceptance item. Audio, recording and persistence remain separate future stages.

## ADR-014 — Borrowed audio tracks with isolated post-gain metering
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 2 Task 4 needs a stable mixed audio stream while CaptureManager remains the sole owner of permission-bearing microphone/display tracks. Controls and meters must be independent, and microphone monitoring must never reach speakers.  
**Decision:** Use a standalone `AudioMixer` with one source→gain→analyser route per microphone/display input, both feeding one `MediaStreamAudioDestinationNode`. Never connect the graph to `AudioContext.destination`. Borrow streams without changing track state; rebuild only the affected route on replacement/add/remove/end. Derive microphone-only, display-only, combined and no-audio modes from live, unmuted tracks and mixer controls. Meter post-gain signals on one idempotent animation loop and require an explicit user action when the context is suspended.  
**Alternatives:** Merge tracks directly into a `MediaStream` without gain/meter processing; connect an analyser in parallel before gain; monitor through speakers; recreate the whole graph for every source update.  
**Consequences:** The later recorder receives one stable mixed audio track, absent shared audio degrades to microphone-only, and independent mutes/gains cannot affect source ownership. Muted or unavailable routes remain silent rather than fabricated. Mixer cleanup stops only its destination track and closes its context. Browser audio policies may leave processing suspended until the user enables it. Synthetic oscillators validate routing/meters, while physical hardware, system-audio availability and long-session A/V alignment remain acceptance work.

## ADR-015 — Bounded ephemeral MediaRecorder output with borrowed tracks
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 2 Task 5 needs a playable recording before durable session/chunk ingestion exists. CaptureManager, CanvasCompositor and AudioMixer must retain exclusive ownership of their tracks, while browser codec support and encoder lifecycle are variable.  
**Decision:** Use a standalone `RecordingEngine` that constructs a wrapper `MediaStream` from one live compositor video track and an optional live mixer-destination audio track without stopping or mutating either. Probe `MediaRecorder.isTypeSupported` in explicit WebM preference order. Serialize the encoder through idle/starting/recording/paused/stopping/completed/failed states, treat source loss as failure, and own only recorder listeners/timers, accumulated Blob parts and result object URLs. Limit one temporary attempt to 128 MiB; stop and discard it if the cap would be exceeded. Exclude a suspended mixer output so video-only recording remains usable until audio processing is explicitly enabled.  
**Alternatives:** Give MediaRecorder the capture streams directly; clone tracks and treat clones as recorder-owned; buffer without a cap; begin server chunk ingestion in this task; report completed in-memory output as durable.  
**Consequences:** Short synthetic WebM clips can be paused, resumed, previewed and downloaded without changing source ownership or the backend security surface. Reload, tab closure, process failure and crashes lose the clip; there is no persisted sequence/checksum ledger or recovery. Blob parts are one logical recording and are not treated as independently playable. Physical codecs, real system audio, five-minute synchronization and long-session memory behavior remain acceptance work.

## ADR-016 — Packet-timeline synchronization acceptance with explicit recorder bitrates
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 2 completion needs a reproducible five-minute measurement through the integrated browser pipeline without adding persistence or mistaking MediaRecorder timeslices for media time. Browser-selected default bitrates make the 128 MiB memory boundary difficult to reason about, and Chrome WebM can omit container duration metadata.  
**Decision:** Request 2,000,000 bps video and 96,000 bps audio from MediaRecorder, retaining the existing 128 MiB hard cap. Keep the five-minute test opt-in and deterministic: advancing synthetic screen/camera, independent microphone/display tones, and color/frequency markers at the beginning, middle and end. Decode the complete logical WebM with FFprobe/FFmpeg. Measure duration from first/last decoded packet timestamps when container duration is absent; measure decoded frame continuity, route-frequency presence, marker alignment, retained bytes, exposed JS heap and borrowed-track state. Require 300 s ±3 s, ≤250 ms stream-duration and marker A/V differences, ≥27 decoded fps, ≤200 ms frame gap, and final bytes below 128 MiB.  
**Alternatives:** Rely on browser playback metadata; infer time from chunk count/timeslice; accept browser-default bitrates; commit generated media fixtures; include the five-minute run in every short regression suite.  
**Consequences:** Phase 2 has a repeatable synthetic Windows/Chromium baseline and exact measured tolerances without adding runtime dependencies or stored recordings. Simple synthetic content may encode far below the requested bitrate, so both requested and effective rates are reported. FFmpeg/FFprobe are explicit external acceptance prerequisites, and generated media stays ignored. This does not validate physical hardware, Edge, system-audio availability, crash recovery, persistent ingestion, export or the two-hour soak.

## ADR-017 — Versioned SQLite session metadata with server-generated identity
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Phase 3 begins by persisting session identity and recording intent before media ingestion exists. The API must not accept filesystem paths, lifecycle state or chunk claims from the browser, and existing schema-v1 databases must migrate without losing rows.  
**Decision:** Define a strict version-1 API session document backed by SQLite metadata schema version 2. Generate lowercase UUIDv4 IDs and timestamps on the server; create sessions only in `idle`. Persist a validated title, non-device recording configuration, and zeroed committed-count/bytes/next-sequence fields reserved for later chunk work. Protect POST with the existing per-launch write token plus exact Origin and same-origin Fetch Metadata; keep GETs behind the existing local Host/Origin boundary. Use parameterized SQL, output revalidation, and descending `(created_at, id)` keyset pagination. Migrate v1 rows transactionally with safe title/configuration/chunk defaults. Define allowed lifecycle transitions in TypeScript and enforce the same graph with a SQLite update trigger, without exposing a mutation endpoint yet.  
**Alternatives:** Client-generated IDs or paths; offset pagination; storing arbitrary JSON session bodies; adding status/chunk mutation routes before their workflows; resetting the v1 database.  
**Consequences:** Session metadata survives restart and can be safely listed/retrieved while token rotation remains launch-scoped. IDs reveal no filesystem location, device identifiers are not persisted, and future code cannot skip lifecycle states through direct SQL. Cursor lookup adds one indexed row read. Schema/API versions intentionally differ because the former tracks local migration shape and the latter tracks the public document. At this decision's boundary chunk bytes, ingestion and recorder integration were absent; ADR-019 through ADR-022 subsequently implement those layers, while recovery and export remain absent.

## ADR-018 — Ordered bounded client chunk identity before ingestion
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** Future durable ingestion needs stable per-session chunk identities, integrity metadata and bounded client memory, but Phase 3 Task 2 must not add upload behavior or couple the queue to React, MediaRecorder or media-track ownership. Asynchronous hashing can otherwise reorder concurrent enqueues, and retry/ACK ambiguity can remove the wrong bytes.  
**Decision:** Use one standalone in-memory pipeline per validated opaque session. Reserve pending work against configurable item and byte limits (default 64 items/32 MiB), serialize Web Crypto SHA-256 over exact Blob bytes, and assign a monotonically increasing sequence only when that ordered hash succeeds. Expose the head without replacing its immutable Blob/metadata identity. Accept only a strict version-1 durable ACK matching the head's session, sequence, byte length and checksum; make an exact replay of the latest accepted identity idempotent and reject conflicts, stale or out-of-order ACKs. Reset abandons queued/pending work and releases references without reusing already-issued sequence identities; disposal is terminal. Keep the shared ACK shape as a future server contract only.  
**Alternatives:** Hash enqueues concurrently and reorder by completion; sequence before hashing and leave gaps on failures; identify retries by Blob object identity; use unbounded memory; make reset restart sequence zero; add ingestion or wire MediaRecorder during this task.  
**Consequences:** Concurrent calls produce deterministic retry-safe identities, bad or late work cannot silently enter the queue, and bounded reservations prevent hashing from bypassing queue limits. The 32 MiB queue bound is separate from and below the unchanged 128 MiB temporary RecordingEngine cap. Queue state remains volatile and is neither an upload ledger nor crash recovery; server ingestion must later persist and verify bytes before emitting this ACK contract.

## ADR-019 — File-first durable chunk commit with a reconciliation sidecar
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** A filesystem rename and SQLite transaction cannot form one atomic cross-resource commit. The server must never ACK unflushed bytes, overwrite a conflicting retry or lose the ability to distinguish a crash before versus after durable metadata publication. Raw uploads must stay bounded and preserve the existing hostile-web/local-filesystem security boundary.  
**Decision:** Accept one authenticated raw `video/webm` PUT for the exact next per-session sequence, limited to 32 MiB and declared by strict length, SHA-256 and client timestamp headers. Serialize work per session; stream/hash into a server-named temporary file; fsync and atomically rename media; fsync and atomically rename a strict commit sidecar; then insert the unique SQLite v3 ledger row and advance session aggregates in one `BEGIN IMMEDIATE` transaction under WAL/`synchronous=FULL`. ACK only after that transaction commits. Re-stream and hash identical retries, returning the original ACK without rewriting bytes; reject conflicting duplicates and gaps. On startup, remove recognized incomplete temporaries, promote a valid media+sidecar pair missing only SQLite state, and fail closed if acknowledged files, sidecars, hashes, sequences or counters disagree.  
**Alternatives:** Commit SQLite before files; ACK after rename without a ledger; keep metadata only in filenames; buffer request bodies; overwrite duplicate paths; attempt a distributed transaction; delete every orphan without distinguishing a fully published sidecar.  
**Consequences:** An ACK means media, recovery metadata and the SQLite ledger all completed in the intended order, while an ACK-lost retry remains idempotent. The sidecar makes the file-complete/database-incomplete crash window recoverable without trusting request headers after restart. This adds one small file and startup hash verification per chunk. Media and sidecar files are explicitly synced; POSIX directories are synced after rename. Node 24 on Windows rejects directory fsync with `EPERM`, so Windows relies on flushed files and atomic rename and cannot claim immunity to sudden power loss. Client scheduling/backpressure and later finalization remain separate boundaries; finalization is now specified by ADR-021, while user-facing recovery remains future work.

## ADR-020 — Single-flight transport with terminal protocol failures and early backpressure
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** The volatile client queue must release bytes only after a trustworthy durable ACK, tolerate ambiguous network loss without changing identity, and warn a future recorder before its bounded memory is exhausted. Automatic credential recovery or broad retry classification could hide conflicts and repeatedly send invalid/private data.  
**Decision:** Give each session one React-independent transport that owns its pipeline and sends exactly one immutable head at a time to the fixed same-origin PUT path using a caller-supplied in-memory token. Validate the strict response envelope and ACK, then let the pipeline verify identity before releasing the Blob. Retry only network failures, timeouts, 408/425/429 and 5xx, defaulting to five attempts with 250 ms capped exponential delay, a 5-second maximum and ±20% jitter. Treat all other HTTP responses and malformed/conflicting ACKs as terminal with bytes retained. Signal guarded backpressure at 80% of either the existing 64-item/32 MiB queue bound, again on hard rejection or terminal failure. Dispose by aborting fetch, cancelling all timers, invalidating late results and releasing queue references.  
**Alternatives:** Parallel per-session PUTs; dequeue on any 2xx; retry every status indefinitely; refresh/bootstrap tokens inside transport; wait for hard-cap rejection before warning; connect MediaRecorder in the same task; persist queue state in browser storage.  
**Consequences:** Ordering matches the server's contiguous-sequence policy, lost ACKs safely reuse server idempotency, and protocol/auth conflicts stop without dropping evidence. Single-flight upload may limit throughput, while bounded retry can stop during a prolonged outage. ADR-022 now consumes the backpressure callback and drain contract. Queue state and credentials remain memory-only and reload loses unacknowledged Blobs. Server finalization is a separate boundary under ADR-021; user-facing recovery remains absent. The separate 128 MiB temporary-mode cap is unchanged.

## ADR-021 — File-first probed finalization with a recoverable commit sidecar
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** SQLite and the filesystem cannot atomically commit a completed recording together. MediaRecorder chunks are pieces of one logical WebM, so completion requires exact sequence/integrity validation and ordered byte concatenation. A crash after publishing output but before updating SQLite must be distinguishable from a successfully probed result, while original acknowledged chunks must remain recoverable evidence.  
**Decision:** Serialize ingestion and finalization with one per-session lock. Accept only an authenticated expected chunk count, require exact contiguous ledger sequences from zero, and recheck each immutable chunk's sidecar, size and SHA-256. Concatenate into a server-named temporary file while rehashing, flush it, and pass only its server-controlled absolute path to a dedicated FFprobe process adapter using fixed argument arrays with `shell: false`; require WebM/Matroska and a valid video stream. Publish the output, then a strict flushed finalization sidecar, then transactionally persist schema-v4 output metadata and the guarded `finalizing → completed` transition. Treat a matching completed retry as idempotent, reject a different expected count, preserve every chunk, and reconcile recognized temporary/media-only/output+sidecar crash windows before listening.  
**Alternatives:** Trust the ledger without rereading files; concatenate in memory; mark SQLite completed before publishing output; invoke a shell command; delete chunks after success; rerun FFprobe after every restart; combine MP4 export with finalization.  
**Consequences:** A completed response means ordered bytes, probe metadata, output sidecar and SQLite completion all succeeded. A file+sidecar/database-incomplete crash can be promoted without rerunning an unavailable tool because the sidecar is written only after a successful probe; mismatches fail closed. Finalization is I/O intensive because chunks are deliberately rehashed twice around the lifecycle boundary, and raw chunks remain on disk. POSIX directories are fsynced after rename; Node 24 on Windows returns `EPERM` for directory fsync, so Windows relies on individually flushed files and atomic rename and cannot claim sudden-power-loss immunity. FFprobe is an external prerequisite for new finalizations. It was unavailable in the Task 5A environment; the outstanding actual WebM acceptance subsequently passed on 2026-11-13 with a Winget-manifested, SHA-256-verified Gyan FFprobe 9.0.1 build.

## ADR-022 — Direct MediaRecorder-to-durable-transport integration with finalization-gated success
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** The recorder, bounded queue, authenticated transport and finalizer existed independently. Durable mode must not retain the complete recording in browser memory or copy Blobs between layers, and it must handle the final MediaRecorder event, ACK ambiguity, backpressure, reload and source loss without presenting an incomplete session as saved. Temporary preview behavior must remain available.  
**Decision:** Add a streaming sink to RecordingEngine that forwards each non-empty `dataavailable` Blob and never appends it to the temporary result array. Put session/token/network orchestration in a separate React-independent DurableRecordingEngine. It creates the session before encoder start, hands each original Blob to one RecordingChunkTransport, waits for all enqueue hashes and a new transport `drain()` contract after MediaRecorder's stop event, then finalizes with the exact durable ACK count. Retry idempotent finalization network/transient failures three times and display Saved only after strict server output validation. Keep one transport request in flight. Treat terminal authorization/protocol errors, source loss, hard queue rejection and exhausted retry as failure; require high-water backpressure to persist for a grace interval before stopping encoding. Preserve the existing temporary mode and 128 MiB cap; durable mode uses the 64-item/32 MiB queue as its browser-memory bound.  
**Alternatives:** Accumulate the complete WebM and upload it at stop; clone every Blob into a second queue; parallelize uploads; let React own protocol sequencing; finalize immediately on MediaRecorder stop; persist the queue in IndexedDB in this task; show completion before the server probe returns.  
**Consequences:** Long durable attempts release acknowledged Blob references instead of growing with total duration, while temporary mode still supports immediate local preview/download. The coordinator exposes recording/uploading/retrying/finalizing/failure truth and never stops borrowed capture/compositor/mixer tracks. Reload can abandon volatile unacknowledged Blobs but preserves server-acknowledged chunks in an incomplete session; ADR-023 subsequently adds acknowledged-chunk recovery, while browser queue persistence remains future work. Chromium E2E covers real multi-chunk MediaRecorder delivery through the server with an injected deterministic probe, and a separate production-finalizer test now covers actual browser WebM with real FFprobe.

## ADR-023 — Activity-leased, verified recovery of acknowledged chunks
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** A browser reload or process interruption can leave valid server-acknowledged chunks without final output. The server must distinguish this from a live paused/between-timeslice recording, refuse corrupt evidence, avoid racing ingestion/finalization and never imply that volatile browser-only data can be recreated.  
**Decision:** Maintain a short in-memory heartbeat lease for active durable recording and combine it with the shared per-session operation lock. On restart, mark acknowledged unfinished sessions interrupted through the existing lifecycle graph. Require current-token/same-origin authenticated recovery reads. Inspect SQLite counters and contiguous ledger sequences, strict sidecars, regular single-link files, exact lengths and SHA-256 before declaring server bytes recoverable. Explicit salvage seals a valid session as recoverable and delegates exact-count concatenation/probing/publication to ADR-021. Coalesce concurrent identical salvage, preserve source chunks and require a successful probe before completed. Quarantine corrupt-session reconciliation errors so unrelated sessions remain usable while all mutations on the corrupt session still fail closed.  
**Alternatives:** Infer interruption solely from lifecycle status; recover automatically at startup; persist a browser queue in this task; trust ledger rows without rereading files; allow salvage during active upload; mark concatenated bytes complete without a probe; delete chunks after salvage.  
**Consequences:** Reload/restart can salvage only the contiguous acknowledged prefix that still passes full integrity validation, with explicit user intent and idempotent completion. A heartbeat is volatile by design: process restart makes an old browser token invalid and exposes its acknowledged data for inspection. Lost, pending or never-uploaded browser Blobs remain unrecoverable. Repeated inspection is I/O intensive because it hashes all acknowledged chunks. FFprobe remains required for successful salvage. Recovery fault behavior uses deterministic probe injection, while the shared production finalizer's actual browser-WebM/real-FFprobe gate passed on 2026-11-13.

## ADR-024 — Persistent AppShell with URL-hash view state above permanently mounted Studio media engines
**Status:** Accepted.  
**Date:** 2026-11-11.  
**Context:** UX-1B introduces four top-level views (`Studio`, `Recordings`, `Recovery`, `Settings`) with a persistent header, service readiness badge, global recording/saving indicator and browser Back/Forward/reload support. Because `DeviceSetup`, `CaptureManager`, `CanvasCompositor`, `AudioMixer`, `RecordingEngine` and `DurableRecordingEngine` are owned by React component lifecycles and DOM `<canvas>`/`<video>` refs inside the Studio tree, conditionally unmounting the Studio view during navigation would dispose active streams, stop the compositor and mixer loops, abort in-flight chunk uploads and lose unacknowledged recording state.  
**Decision:** Keep the Studio workspace permanently mounted inside `AppShell` and toggle visibility with the native `hidden` attribute (`display: none`) when another view is active. Synchronize the active view (`#studio`, `#recordings`, `#recovery`, `#settings`) with `window.location.hash`, `history.pushState`, `popstate` and `hashchange` without adding a router dependency. Bubble read-only capture and recording status snapshots up to `AppShell` via stable ref-backed callbacks and derive global header status pills and a cross-view live activity banner through pure helpers in `shell-status.ts`. Render `RecordingsPanel` from validated `GET /api/v1/sessions` responses only while `Recordings` is active, and keep `RecoveryPanel` and `SettingsPanel` in their dedicated views with automatic refresh triggers when durable sessions complete or fail.  
**Alternatives:** Add `react-router-dom` and unmount inactive routes; hoist every media service and `<canvas>`/`<video>` element into a global singleton store in UX-1B; block view switching during capture or recording.  
**Consequences:** Users can inspect `Recordings`, `Recovery` and `Settings` (or use browser Back/Forward) during active capture, recording, chunk upload, retry and finalization without interrupting tracks, dropping chunks or duplicating compositor/mixer/recorder instances. No new runtime dependency is introduced. The hidden Studio DOM remains in memory while browsing other views, which is negligible for a single-window local studio and preserves all existing Phase 2–3 media ownership invariants.

## ADR-025 — Screeva working-brand identity and stable internal identifiers
**Status:** Accepted (working brand; trademark and domain clearance pending).  
**Date:** 2026-11-12.  
**Context:** Following the Electric Violet visual redesign (`COLOR-0`–`COLOR-3`), the product needed a cohesive user-facing brand identity to replace the initial *Local Creator Recorder* working title from ADR-008 without risking regressions across internal workspace packages, SQLite schemas, API contracts, or media/recovery services.  
**Decision:** Adopt **Screeva** as the official user-facing product name across the browser UI (`index.html`, `AppShell`, `GuidesPanel`, `RecordingsPanel`, `RecoveryPanel`, `shell-status.ts`), documentation (`README.md`, `PRD.md`, `UX_DESIGN.md`), and local SVG favicon/logo (`apps/client/public/icon.svg`), with display wordmark **`screeva.`**, tagline **`Your Screen. Your Studio.`**, description *"A modern, local-first screen and webcam recording studio for creators, developers, and educators"*, and the Electric Violet + Mint brand palette (`#0C0A16` background, `#191529` surface, `#9B5CFF` primary violet, `#00E5C3` mint accent, `#F6F2FF` primary text). Keep internal npm workspace names (`local-creator-recorder`, `@recorder/*`), backend services, SQLite schema/file paths (`data/recorder.sqlite`), HTTP headers (`X-Recorder-Token`, `X-Recorder-Bootstrap`), and the `Capabilities.name` wire literal unchanged.  
**Alternatives:** Keep *Local Creator Recorder* in user-facing UI; rename all internal packages, database files, headers, and API wire literals simultaneously.  
**Consequences:** User-facing surfaces present a unified `Screeva` / `screeva.` identity and minimal focus-frame SVG mark with zero external font or CDN dependencies, while all existing media engines, durable chunk pipelines, security boundaries, and API contracts remain 100% backwards-compatible. Historical ADR-008 remains preserved as the initial foundation record, and formal trademark/domain clearance remains pending before public commercial release.

## ADR-026 — Shared session exclusion for heartbeat and resilience acceptance gate
**Status:** Accepted.

**Date:** 2026-11-13.

**Context:** Fault injection showed that heartbeat updated the activity lease outside the shared session lock. It could overlap an upload, finalization or salvage lifecycle operation, creating a check/acquire race even though media mutations were otherwise serialized. Phase 3 also needed one reproducible command that distinguishes deterministic simulations from external media, hardware and power-loss acceptance.

**Decision:** Pass the shared `SessionOperationLock` through the server route boundary. Heartbeat uses non-blocking acquisition and returns conflict while the session is busy. Periodic client heartbeat treats this exact busy conflict as transient and schedules the next lease attempt, while the initial pre-recording heartbeat remains mandatory. Recovery inspection and salvage recheck the activity lease only after acquiring that same lock. Add `npm run test:faults` as the deterministic Phase 3 resilience gate and maintain a report mapping each injected boundary to its invariant. Keep the conditional real-FFprobe browser test separate and required for closing the external media gate.

**Alternatives:** Let heartbeat remain advisory and unlocked; clear leases during every mutation; queue heartbeat behind long disk operations; treat synthetic probe adapters as real-media acceptance; rely only on scattered historical tests without a dedicated gate.

**Consequences:** Upload, heartbeat, finalization and recovery now have an unambiguous exclusion order, and late activity cannot make an interrupted session appear active after recovery has begun. Busy heartbeat requests may return 409 and the durable controller will fail visibly rather than conceal uncertain server state. The deterministic suite verifies durability and ownership invariants but does not prove sudden-power-loss, real disk-full or physical-device behavior. The separate trusted real-media acceptance passed on 2026-11-13, completing the Phase 3 gate while leaving those external validations explicit.

## Template for a new decision
```md
## ADR-XXX — Title
**Status:** Proposed | Accepted | Superseded
**Date:** YYYY-MM-DD
**Context:** Why must we decide?
**Decision:** What will we do?
**Alternatives:** What else was considered?
**Consequences:** Benefits, costs, migration path.
```
