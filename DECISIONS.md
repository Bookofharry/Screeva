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

## ADR-027 — Engine-derived recording UX with connected-default durable mode
**Status:** Accepted.

**Date:** 2026-11-13.

**Context:** The recording engines already exposed truthful lifecycle snapshots, but the dock defaulted to volatile temporary mode and did not protect active work from tab closure or distinguish upload/finalization progress. UX improvements must not duplicate media state in React, claim completion early, or acquire ownership of borrowed tracks.

**Decision:** Keep recording state authoritative in RecordingEngine and DurableRecordingEngine. Derive dock actions, unload risk, progress and document title through pure UI helpers. Pass only a read-only durable-availability flag through the permanently mounted Studio tree; select durable by default when connected unless the user has explicitly chosen a mode. Keep the three-second countdown optional and disabled by default, with explicit skip/cancel; it starts no session or encoder until completion. Register `beforeunload` only for recording, paused, stopping, uploading, retrying and finalizing. Render determinate upload progress only from acknowledged and queued chunk counts, and render Saved only from non-null validated final output.

**Alternatives:** Keep temporary mode as the default; infer state from button clicks; start encoding behind the countdown immediately; show synthetic percentages for FFprobe finalization; persist the mode or credential in browser storage; let React stop media tracks during unload.

**Consequences:** Beginners with a connected local service receive crash-safer durable recording by default, while temporary preview remains an explicit offline-compatible option. UI timers and listeners clean up independently of media engines, false completion remains impossible, and queue/memory/security boundaries are unchanged. Browser-native unload dialogs control their own wording. The optional countdown is session-local and resets on reload; keyboard shortcuts remain UX-5 scope.

## ADR-028 — Authoritative recovery attention with bounded lease follow-up
**Status:** Accepted.

**Date:** 2026-11-14.

**Context:** UX-4 must identify interrupted durable sessions at launch and after current-tab failures without calling an active upload interrupted, bypassing the server lease, promising recovery of browser-only data, or inventing Phase 5 library actions. An immediate inspection after a finalization failure can still report `active` until the existing ten-second heartbeat lease expires.

**Decision:** Derive all recovery attention from authenticated, schema-validated server inspections through a pure presentation helper. Exclude `active` from badges and interruption notices; label every condition and display exact verified/contiguous/committed evidence. On initial launch or a durable completion/failure refresh trigger, allow `RecoveryPanel` to follow an active result once per second for at most twelve seconds, suppress stale generations, then stop. Keep salvage explicit and route it through the existing recovery/finalization service. Keep the session library read-only and visibly defer playback, download, MP4 export and deletion until corresponding APIs exist.

**Alternatives:** Treat every unfinished session as recoverable; clear or ignore the activity lease in the UI; refresh only once and require a manual reload after failure; auto-salvage on launch; infer recovery from the session-list status alone; render disabled or nonfunctional Phase 5 actions.

**Consequences:** Launch and post-failure attention reflects authoritative server evidence without racing active work. A failed recording can become visible after its lease naturally expires, while corrupt, empty, unavailable and browser-only evidence is never advertised as restorable. The bounded timer and request are cleaned on unmount, and no media ownership, token persistence, queue limits, storage schema or security middleware changes are introduced.

## ADR-029 — State-derived single-key shortcuts and contained modal focus
**Status:** Accepted.

**Date:** 2026-11-14.

**Context:** UX-5 adds convenient single-character recording controls, but WCAG 2.2 SC 2.1.4 requires a way to disable them and they must not fire while a user types, adjusts a slider, operates a modal or drags the composition. React rerenders must not leave duplicate/stale listeners. The existing custom dialogs also need predictable keyboard entry, containment and focus restoration.

**Decision:** Keep shortcut resolution in a pure UI helper and derive action availability from the existing recorder dock state. Install one lifetime listener in RecordingPanel backed by current refs. Ignore repeats, Ctrl/Alt/Meta, editable/form targets, sliders, open dialogs and a transient compositor-drag marker. Provide a visible, session-memory off switch in Recording options; do not persist it or introduce global settings storage. Route accepted keys through the same start/stop/pause/resume/countdown functions used by buttons. Share a small `useModalFocus` hook between Recording and Scene dialogs to move focus in, wrap Tab/Shift+Tab and restore the exact opener.

**Alternatives:** Bind listeners after every render; synthesize button clicks; let shortcuts run inside inputs/sliders; enable shortcuts without an off switch; persist preferences or credentials together; replace the current modal DOM with a new dependency during UX-5; claim automation as screen-reader/usability acceptance.

**Consequences:** Shortcut behavior cannot create an alternate recording state or acquire/stop tracks, and immediate post-dialog keys observe current state. Focus no longer remains in hidden dialogs. The off switch resets on reload by design and may become a persisted non-sensitive preference in a future settings milestone. Automated Chromium evidence covers logic, focus and layout, while Narrator/NVDA, physical-device, Edge and five-person acceptance remain explicitly open.

## ADR-030 — Self-host a pinned pre-telemetry MediaPipe face detector
**Status:** Accepted.

**Date:** 2026-11-15.

**Context:** Face analysis must remain local, work in ordinary Chromium, and never take ownership of `CaptureManager` streams. Native `FaceDetector` availability is platform-dependent. The current MediaPipe Tasks Vision 1.2.x privacy notice describes performance and utilization metrics sent to Google, which conflicts with Screeva's no-telemetry default. A reviewed older release and model still add supply-chain, redistribution, CSP and build-reproducibility obligations.

**Decision:** Retain the React-independent `FaceDetectorBackend` boundary and make exact `@mediapipe/tasks-vision` 0.10.21 the default ordinary-browser backend, with native Shape Detection as a defensive fallback. Load it dynamically only after explicit user enablement. Self-host its four WASM assets and the official BlazeFace short-range model under `/vision`; verify the model's 229,746-byte length and SHA-256 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` during install/build before publishing it. Allow `SCREEVA_FACE_MODEL_PATH` for an offline first build. Permit CSP `'wasm-unsafe-eval'` but not general `'unsafe-eval'`, retain `connect-src 'self'`, and make no runtime CDN or inference request. Keep detection off by default. Detector results remain observations until the separate crop/smoothing task consumes them.

**Alternatives:** Use current MediaPipe 1.2.x despite its documented metrics; rely only on the platform-dependent native API; fetch runtime/model assets from a CDN; add the legacy Face Detection package without exact asset verification; couple detector calls directly to React or the compositor.

**Consequences:** Ordinary Chromium has a reproducible local detector and normal inference has no external network dependency. The Apache-2.0 package and model require retained notices during distribution; the dependency adds about 20.5 MB unpacked plus a 229 KB model, while application JavaScript stays lazy-loaded. A first asset preparation needs either access to the hash-pinned official model URL or `SCREEVA_FACE_MODEL_PATH`. Exact pinning defers upstream security/features and therefore requires deliberate review before upgrades. Detection alone never changes recorded pixels; ADR-031 subsequently adds the separate stable crop/hold/recenter controller, while manual framing remains separate.

## ADR-031 — Normalized, time-based auto framing remains independent of detection and rendering
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** Face observations arrive at an adaptive 2–12 Hz, while the canvas renders at 30 fps and browser animation timing varies under load. Directly applying each detection would produce visible jitter and jumps, and putting tracking state in React or the detector would couple observation, presentation and stream ownership. Temporary missed detections must not immediately snap the presenter to full frame.

**Decision:** Introduce a standalone `AutoFrameController` that consumes normalized face boxes, selects the largest valid face as the primary presenter, and emits a normalized square source region. Target approximately 38% face occupancy with a 38% minimum crop. Apply 4.5% movement and 5% zoom dead zones, time-based exponential response (260 ms while tracking, 650 ms while recentering), a 1.5-second lost-face hold, then ease to the full frame. Own at most one animation callback and reset synchronously on disable, source replacement or disposal. Keep destination-aspect fitting in `CanvasCompositor.coverCropWithin`; React only wires snapshots and exposes status. Keep analysis/auto framing explicitly off until the user enables it.

**Alternatives:** Jump directly to every detection; smooth in React state or inside MediaPipe; use frame-count-dependent interpolation; immediately recenter on one missed sample; mutate camera track constraints; render a separate preview path; choose an arbitrary first detection without a primary-face policy.

**Consequences:** Detection cadence and render cadence are decoupled, camera-only/PIP/split layouts share bounded source geometry, and preview pixels are the same pixels exposed to recording. Brief misses are stable and sustained loss returns safely to full frame. Repeated faces of similar size may still change primary selection without identity tracking, and physical-camera tuning under motion remains an external acceptance item. ADR-032 subsequently adds independent manual framing and mode override; no track ownership or dependency changes were introduced.

## ADR-032 — Manual framing is independent session state and overrides analysis
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** CAM-01 requires user-controlled camera position and digital zoom, while CAM-02 requires an explicit auto-framing off switch. A manual adjustment must override tracking without losing the user's chosen frame, requesting media again, mutating track constraints or implying unsupported optical camera control. Automatic crops are transient and should not overwrite a deliberate manual composition.

**Decision:** Represent manual framing as normalized `{zoom, panX, panY}` session state in a pure `camera-framing.ts` module. Bound digital zoom to 1.0×–2.6× and each pan axis to `[0,1]`, producing a square contained source crop for the existing compositor. Default to Manual/full frame with no analysis. Keep manual and automatic crops independent: selecting Automatic starts the local detector/framer and renders its crop; selecting Manual stops analysis and immediately restores the saved manual crop. Any manual adjustment selects Manual, and Reset restores `{zoom:1, panX:0.5, panY:0.5}`. Keep final destination-aspect fitting in the compositor and controls disabled without a camera.

**Alternatives:** Apply `MediaStreamTrack.applyConstraints()` zoom/pan; claim optical zoom/focus; copy the current automatic crop into manual state; discard manual state whenever auto mode starts; keep detecting while Manual is selected; store camera framing persistently or per-device in this task; implement separate renderer paths per mode.

**Consequences:** Manual composition is deterministic, bounded, private by default and survives temporary mode changes or camera replacement within the mounted Studio session. Preview and recording use identical pixels, while CaptureManager ownership and permission behavior are unchanged. The chosen 2.6× ceiling limits severe quality loss but remains digital cropping; no hardware PTZ capability is promised. Settings are not persisted across reload, and physical-device image-quality acceptance remains external.

## ADR-033 — Screen focus is a source crop selected only from the borrowed local preview
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** FOC-01 needs a user-selected screen region, while the compositor already has a normalized screen rectangle that means destination placement on the stage. Reusing that rectangle would conflate moving/resizing the scene with choosing source pixels. A crop chosen for one shared tab/window/monitor is unsafe to retain after display-source replacement, and an ordinary webpage cannot provide system-wide pointer tracking.

**Decision:** Add a distinct normalized `screenCrop` to `CanvasCompositor` and keep selection math in pure `screen-focus.ts`. Preserve contain/letterbox rendering for the full source; cover-fit a custom source crop to the current screen destination so pixels are not stretched. Perform selection against a temporary full-source `<video>` that borrows the existing CaptureManager stream, accepts pointer input only within the local stage overlay, preserves destination aspect and commits atomically on a valid drag. Cancel leaves the active crop unchanged; Reset restores full frame. Detach selector resources without stopping tracks and reset/close whenever display-stream identity changes. Apply the crop immediately in this task; defer saved presets and smoothed transitions to Phase 4 Task 5.

**Alternatives:** Reuse the destination `screen` rectangle; crop the selector's already-focused canvas output; request display capture again; apply track constraints; retain a crop across unrelated display sources; claim global mouse tracking; implement presets and animation in the selection task.

**Consequences:** Screen placement and source focus remain independently testable normalized contracts, and preview/recording consume identical composed pixels. Selection needs no new permission, dependency, storage or track ownership. Source replacement safely loses the session crop by design. At this Task 4 decision boundary the immediate crop change could be visually abrupt; ADR-034 subsequently adds the named presets and safe transitions. Physical multi-monitor/DPI/touch ergonomics remain external acceptance work.

## ADR-034 — Focus presets are volatile normalized targets behind one cancellable transition controller
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** FOC-01 requires smooth focus changes and FOC-02 names Code, Terminal, Browser and Full frame presets. Animation inside React or the compositor would mix lifecycle/state ownership with rendering, while persistent presets would require a settings schema and rules for potentially sensitive shared-screen geometry. Rapid preset/reset actions and reduced-motion preference must not create overlapping loops or unsafe intermediate crops.

**Decision:** Keep a standalone `ScreenFocusTransitionController` as the sole owner of current/target crop animation. Use a 420 ms time-based cubic ease-in/out, normalized interpolation, exact endpoints and one cancellable animation callback. Retarget from the currently rendered crop; ignore duplicate in-flight targets; reset immediately on display-source replacement; and finish immediately whenever reduced motion is requested. Store Code, Terminal and Browser slots only in mounted Studio session memory, with Full frame as a built-in target. Clone/normalize saved rectangles, apply every target through the controller and clear named slots on display-stream identity change. Allow normalized slots to remap automatically through layout and output-resolution changes.

**Alternatives:** Animate in CSS, React effects or `CanvasCompositor`; jump between crops; start one loop per action; use frame-count-dependent timing; ignore reduced motion; persist presets in localStorage/SQLite; retain presets across unrelated shared sources; store source pixels instead of normalized geometry.

**Consequences:** Selection, presets and reset share one deterministic transition path and recorded pixels match the preview throughout. Rapid actions remain bounded and cleanup cannot leave a late animation. No permission, track, API, storage schema or dependency changes are introduced. Presets intentionally disappear on reload or source replacement; persistent user presets would need a later explicit privacy/settings decision. Deterministic and synthetic-browser checks do not establish physical multi-monitor, touch, Edge or sustained-load smoothness.

## ADR-035 — Durable recording availability requires a validated JSON capability response
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** A static-preview convenience path returned fabricated recording and write capabilities on every non-loopback hostname. The UI therefore offered durable recording without a verified local API. Starting requested the relative bootstrap path from the static frontend; an HTML SPA fallback began with `<!DOCTYPE` and leaked a raw JSON parser error. A 200 response or same-origin URL alone is not evidence that the loopback recording service exists.

**Decision:** Remove fabricated capability, session-list and write-check success. Derive connected/durable availability only from a schema-valid v1 JSON capability response. Decode service bodies through a shared guarded reader for initial capabilities and durable bootstrap/session/heartbeat/finalization boundaries. Treat HTML, empty or malformed bodies as service failures with loopback and Quick browser test guidance. Fail before creating a session or recorder and retain temporary browser recording as the offline fallback.

**Alternatives:** Keep demo capabilities but disable only Start; detect `<!DOCTYPE` strings at one call site; trust HTTP 200 or `Content-Type` without schema validation; proxy automatically to a guessed localhost port; permit durable mode to continue after an unverified bootstrap response.

**Consequences:** Static deployments and misconfigured proxies no longer claim durable persistence, and raw parser exceptions are not shown to users. A working same-origin loopback server remains unchanged and continues to pass authenticated end-to-end recording. Hosted previews visibly report the local service unavailable and offer temporary recording; connecting a separately hosted frontend to localhost would require a future explicit, security-reviewed origin/transport design rather than a fabricated capability.

## ADR-036 — Baseline MP4 export is a single internal worker over an immutable finalized source
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** Phase 5 needs FFmpeg export without weakening the durability boundary established by chunk finalization. FFmpeg is an external process, output can be large or malformed, user-controlled command construction would create injection risk, and concurrent encodes could exhaust a local machine. Task 1 does not yet include authenticated routes, progress, cancellation, retry, cleanup policy or library actions, so advertising public export would be a false capability.

**Decision:** Add a dedicated process adapter using `spawn` with `shell: false`, a fixed H.264/AAC argument vector, at most four encoding threads, an FFmpeg output-byte ceiling, bounded stderr and a three-hour ceiling. Accept only the literal `ffmpeg` from `PATH` or an absolute configured executable. Add a FIFO `ExportService` with one active conversion and at most 1,000 retained in-memory job records. Resolve sources and destinations exclusively from a validated session UUID; require a completed session; validate the finalized WebM length and SHA-256 before and after conversion; reject links and non-regular files; bound the output relative to source size; flush a randomized temporary MP4; and atomically rename it. Drain accepted jobs on orderly server shutdown. Keep the API capability false until authenticated orchestration exists.

**Alternatives:** Run FFmpeg directly in an Express route; interpolate a shell command; allow caller-supplied paths/codecs; export concurrently; overwrite or delete the WebM after success; store export jobs in SQLite before Task 2 defines retry/cancellation semantics; expose a route with no progress or recovery contract; treat an existing MP4 as an idempotent success without durable export metadata.

**Consequences:** The first export baseline is resource-bounded, injection-resistant and preserves recording evidence on both success and failure. Real FFmpeg/FFprobe acceptance establishes H.264/AAC playability, but jobs and success metadata do not survive restart and no user can invoke or observe them through the application yet. Task 2 must define authenticated API/UI lifecycle, progress, cancellation, retry and stale-temporary/output reconciliation before `export` becomes a public capability. Task 3 must define quality presets and codec probing. POSIX directory publication is fsynced; Windows relies on file flush plus atomic rename because Node returns `EPERM` for directory fsync, so sudden-power-loss durability remains unclaimed. FFmpeg/FFprobe remain separately installed GPL tools rather than npm dependencies, leaving the repository's MIT source license and dependency graph unchanged.

## ADR-037 — Export orchestration uses a durable one-job-per-session ledger and attempt generations
**Status:** Accepted.

**Date:** 2026-11-16.

**Context:** User-accessible export needs truthful progress, cancellation, retry and restart cleanup without allowing browser paths, exposing FFmpeg diagnostics, losing completed output state, or permitting a late cancelled process to overwrite a retry. In-memory Task 1 jobs cannot distinguish a successful prior export after restart. Client-visible downloads also require stronger protection than an unauthenticated local GET.

**Decision:** Add SQLite schema v5 with one strict export job per finalized session. Persist status, integer progress, attempt generation, timestamps, safe error and output length/SHA-256. Parse fixed FFmpeg progress output relative to trusted finalization duration and cap it at 99 until atomic publication succeeds. Cancellation persists before aborting the child; retry retains job identity and increments attempts. Every asynchronous completion checks the captured attempt generation and current running state. On startup remove only recognized temporaries/orphan MP4s, resume queued/interrupted work and revalidate completed MP4 metadata. Require same-origin per-launch token authorization for job inspection and streaming file delivery as well as mutations. Keep client tokens in memory and use one abortable polling timer. Do not buffer exported media into a browser Blob; defer bounded/native download UX to the library task.

**Alternatives:** Keep jobs in memory; create a new job ID for every retry; infer progress from output file size; mark completed when FFmpeg exits before file flush/rename; cancel without durable state; expose downloads as unauthenticated GETs; delete the WebM after MP4 success; place all export state in React; introduce quality presets during orchestration.

**Consequences:** Export state and verified output survive clean restart, cancellation/retry races are deterministic, corrupt/missing MP4s fail closed, and the original WebM/chunks remain protected. One job per session makes queue requests idempotent and keeps retry history as an attempt count rather than multiple ambiguous outputs. A cancelled or failed job can be retried up to 100 attempts. Progress may remain low or indeterminate-looking when source duration is unavailable, and Windows still cannot fsync directories through Node. Quality/codec probing is deliberately deferred to Task 3; preview, aggregate storage and deletion remain Task 4.

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
