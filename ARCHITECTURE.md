# ARCHITECTURE.md — Screeva (`screeva.`)

> Draft design, not a claim of implemented code. Update alongside implementation.

## Implemented foundation (2026-11-10)
- npm workspace scaffold: `apps/client`, `apps/server`, `packages/shared`, strict TypeScript.
- Vite builds the React status page; Express serves it and the v1 API on the exact `http://127.0.0.1:<port>` origin. Development uses file builds/watch rather than a second HTTP server.
- All routes validate Host, supplied Origin and Fetch Metadata. Writes additionally require exact Origin, same-origin Fetch Metadata and a random per-launch header token. A guarded bootstrap endpoint provides the token to the local UI. The diagnostic POST changes no stored data.
- SQLite uses Node 24's built-in `node:sqlite`, WAL and synchronous FULL. The original schema version 1 has been safely migrated through session metadata v2, the v3 chunk ledger and v4 final-output metadata. Directories and existing database files are checked for links.
- API routes call services and storage adapters; shared Zod schemas define the v1 envelope and implemented reliability capability fields. Recording is now reported available; MP4 export remains false.
- Static assets have a restrictive CSP. Phase 2 now permits same-origin camera, microphone and display capture, with local/blob media allowed for preview. No remote runtime assets or inference are present.
- Hostile websites are in scope; compromise by processes running as the same OS user, XSS, and concurrent local filesystem replacement are not solved by this baseline. See README for details.

## Implemented input setup (2026-11-10)
- `DeviceSetupPanel` renders accessible camera/microphone selectors, permission status, refresh, access-check and cancel controls.
- `media/device-setup.ts` owns device discovery, selected IDs in memory, permission/device-change listeners, stale refresh protection and disposal. UI calls this service rather than retaining streams itself.
- Discovery, permission queries and selection never call getUserMedia. A user-triggered check requests only one input, stops all tracks immediately, and never attaches media to a player or recorder.
- A cancelled getUserMedia prompt cannot be programmatically dismissed. Checks remain serialized until it settles; late streams are stopped even after cancellation or disposal. Browser permission status and device-open success are distinct.
- Device enumeration can be filtered before permission. Missing selections reset visibly to system default; unsupported permission queries remain unknown rather than inventing a grant.
- No new API routes, persisted device IDs, dependencies or recording-storage changes were introduced by input setup; later reliability work updates the capability contract below.

## Implemented sustained capture (2026-11-11)
- `CaptureManager` in `media/capture-manager.ts` is the sole owner of persistent display/camera/microphone streams. It never takes ownership of temporary `DeviceSetup` streams; the UI disables overlapping checks of an active/pending input.
- Each source has independent supported/status/pending/stream/track-settings state. `start` invokes the browser API synchronously from the click path, before awaiting the result. Display sharing always uses the native chooser. Only selected camera/microphone device IDs are constrained.
- Switching is stop-before-open: old tracks/listeners/timers are released first, and failure leaves that source off. Generations invalidate cancelled requests; late streams are stopped and cannot resurrect capture. A native request must settle before another request for that source starts.
- Track and stream events plus a one-second settings/ready-state refresh handle ended/muted sources and browser-driven surface changes. Losing primary video/audio stops that source and releases its remaining tracks. Optional display-audio loss keeps video live. Device-change checks use actual device IDs and ownership snapshots so stale enumeration cannot stop a replacement stream.
- `CapturePanel` exposes independent controls, aggregate activity, actual settings and error feedback. `StreamPreview` attaches `srcObject` to muted inline video elements, handles playback errors, and detaches on replacement/unmount without stopping manager-owned tracks. Microphone streams have no playback or Web Audio routing.
- `pagehide`, explicit stop/cancellation and disposal release active resources. Pending prompts are logically cancelled; their late results are stopped. Page restoration requires a fresh user action.
- Task 2 added no audio mixer/meter, MediaRecorder, recording persistence, FFmpeg or AI tracking; later implemented stages are documented separately below.

## Implemented canvas compositor (2026-11-11)
- `CanvasCompositor` in `media/compositor.ts` is independent of React and capture permissions. It borrows CaptureManager streams, attaches them to private muted video elements, and never stops or mutates source tracks.
- Pure geometry functions keep PIP and split settings normalized. Screen rendering uses contain/letterboxing; camera rendering uses centered cover crop. Screen-only, camera-only, PIP and adjustable split layouts share the same render path and fall back safely when a source is missing or ended.
- A single idempotent animation loop targets 30 fps on fixed 720p/1080p canvases. The cached `canvas.captureStream(30)` output is compositor-owned and stopped on disposal; private videos, pointer listeners and the animation handle are also released.
- `CompositorPanel` owns only layout controls and normalized PIP state. It does not request media access. Synthetic browser tests validate actual output pixels and advancing output frames; physical-device and long-session performance remain unverified.

## Implemented audio mixer (2026-11-11)
- `AudioMixer` in `media/audio-mixer.ts` is independent of React, capture permissions and the canvas compositor. It borrows CaptureManager microphone/display streams and owns only its Web Audio nodes, meter loop and destination stream.
- Microphone and available display audio use separate source→gain→analyser routes into one `MediaStreamAudioDestinationNode`. The graph never connects to the speaker destination. Independent gain/mute controls and post-gain meters support microphone-only, display-only, combined and silent modes.
- Track/stream events rebuild only an affected route on add/remove/end/replacement and reflect browser mute/unmute without changing source tracks. Source-node connections are deduplicated; absent display audio is reported rather than fabricated.
- `AudioMixerPanel` owns only controls and subscribed display state. Suspended contexts require explicit user resume. Cleanup cancels the meter loop, disconnects nodes/listeners, closes the context and stops only the mixer-owned output track. Synthetic oscillator tests validate analyser movement and routing; physical hardware/system-audio behavior remains unverified.

## Implemented ephemeral recording engine (2026-11-11)
- `RecordingEngine` in `media/recording-engine.ts` is independent of React, capture permissions, composition and audio routing. It borrows the compositor's live video track and optional running mixer-destination audio track through a wrapper stream and never stops or mutates those tracks.
- MIME negotiation prefers supported VP9/Opus, VP8/Opus and generic WebM configurations. The engine owns MediaRecorder listeners/timers and its explicit state machine serializes start, pause, resume, stop, source loss, encoder failure and disposal. Temporary mode owns bounded Blob chunks and result object URLs; streaming mode forwards each non-empty emitted Blob without retaining it.
- The temporary 128 MiB memory ceiling still stops and discards an oversized temporary attempt. A completed short temporary clip can be previewed or downloaded from a local Blob URL. Durable mode does not apply this whole-recording cap; its independent 64-item/32 MiB queue is the retained-memory boundary.
- React publishes compositor/mixer outputs to the recording panel but does not own encoder state. A suspended audio context is excluded, yielding explicit video-only recording until audio processing is enabled. Cleanup stops only MediaRecorder encoding and revokes recorder-owned URLs.

## Implemented durable chunk ingestion (2026-11-11)
- `RecordingChunkPipeline` remains a standalone, in-memory client service. DurableRecordingEngine now feeds it MediaRecorder Blobs through the transport, while the transport remains its only network owner. It assigns ordered per-session identities and Web Crypto SHA-256 metadata under 64-item/32 MiB queue bounds.
- `PUT /api/v1/sessions/:id/chunks/:seq` accepts only authenticated same-origin raw `video/webm` requests with one declared `Content-Length`, lowercase SHA-256 and ISO client timestamp. A single chunk is limited to 32 MiB. The server streams directly to a server-named temporary file, hashes while writing, rejects length/checksum/sequence/lifecycle conflicts and serializes ingestion per session.
- Each successful new chunk is committed in this order: fsync the temporary media file; atomically rename it to the server-derived sequence path; fsync and atomically publish a strict commit sidecar; transactionally insert the unique SQLite v3 ledger row and advance the session counters; only then return the versioned durable ACK. Exact retries are re-read and re-hashed, then return the original ACK. Conflicting, stale, skipped or concurrent duplicate identities cannot overwrite committed bytes.
- Startup reconciliation removes only recognized safe temporary or media-only partial files, promotes a validated media+sidecar pair left before a failed SQLite commit, and verifies every acknowledged file, sidecar, checksum, contiguous sequence and aggregate session counter before listening. Missing/corrupt acknowledged storage fails startup without rewriting it.
- Paths derive only from validated opaque session IDs and numeric sequences. Session/capture directories and recognized files reject links and non-regular or multiply linked files. Interrupted requests remove their temporary file; storage/database errors return a generic envelope without an ACK.
- SQLite uses WAL plus `synchronous=FULL`. Media and sidecar file handles are explicitly synced. POSIX directory handles are synced after rename; Node on Windows returns `EPERM` for directory fsync, so Windows relies on flushed files plus atomic rename and retains the PRD's best-effort sudden-power-loss limitation.

## Implemented ordered client chunk transport (2026-11-11)
- `RecordingChunkTransport` is independent of React and media ownership. One instance owns one session pipeline, one in-memory write token, at most one same-origin PUT, its retry/timeout timers and retained Blob references. It neither bootstraps credentials nor receives/stops media tracks.
- Only the immutable queue head is uploaded. The transport sends the Blob with MIME, SHA-256 and client timestamp headers to its session/sequence path, uses same-origin credentials, rejects redirects, and releases the head only after the strict shared envelope and durable ACK schemas pass plus pipeline identity acknowledgement succeeds.
- Network failures, request timeout, 408/425/429 and 5xx retry with capped exponential backoff and jitter. Default policy is five total attempts, 10-second request timeout, 250 ms base delay, 5-second maximum and ±20% jitter. All other HTTP failures and invalid/conflicting ACKs stop transport terminally with bytes retained for explicit later handling.
- The queue's 64-item/32 MiB bounds remain authoritative and below RecordingEngine's unchanged 128 MiB attempt cap. Default 80% item/byte high-water, hard-cap rejection and terminal transport failure invoke a guarded callback for later graceful recorder stop. Snapshots expose status, outstanding/pending bytes and items, attempt counts, active sequence, retry delay, ACK count, backpressure and errors.
- `drain()` resolves only after pending hashes and all queue heads receive validated durable ACKs; terminal delivery failure rejects without releasing retained evidence. Disposal aborts the active fetch, cancels timeout/backoff work, invalidates late responses and disposes the pipeline. Queue/transport state remains volatile across reloads; there is no persistent client recovery ledger.

## Implemented secure WebM finalization (2026-11-11)
- Authenticated `POST /api/v1/sessions/:id/finalize` accepts only a strict expected chunk count. A shared per-session operation lock serializes finalization against chunk ingestion. The service requires the SQLite ledger and session counters to contain exactly that many contiguous sequences beginning at zero, then revalidates every immutable chunk sidecar, length and SHA-256 before and while concatenating.
- Finalization performs raw byte concatenation because MediaRecorder chunks are parts of one logical WebM, not independent files. It writes a server-named temporary output, hashes and flushes it, invokes a dedicated FFprobe adapter with a fixed argument array and `shell: false`, and requires WebM/Matroska plus a valid video stream. Client input never supplies an executable or filesystem path; an optional configured FFprobe path must be absolute.
- A successful probe produces strict versioned output metadata. The service atomically publishes `final/recording.webm`, then a flushed commit sidecar, then transactionally moves SQLite schema-v4 session metadata from `finalizing` to `completed`. The original committed chunk media and sidecars are never removed or rewritten. Exact retries return the stored output; a different expected count conflicts.
- Startup reconciliation removes only recognized finalization temporaries or a media-only interrupted publish, promotes a valid media+sidecar pair left before SQLite completion, and fails closed if completed metadata, sidecar, output length or output hash disagree. Probe, disk and database failures cannot mark the session completed; a later retry can resume from the persisted `finalizing` intent.
- File and directory chains reject links; recognized output files must be single-link regular files. Media and sidecar handles are flushed before rename. POSIX directory handles are fsynced; Node 24 on Windows returns `EPERM` for directory fsync, so Windows relies on file flushes plus atomic rename and does not claim sudden-power-loss immunity.
- The adapter and state/reconciliation behavior are covered by synthetic/failure-injection tests. FFprobe/FFmpeg were not installed in the 2026-11-11 Task 5A environment, so the conditional actual browser-produced multi-chunk WebM probe test was skipped and real-media validation is not claimed.

## Implemented durable recording integration (2026-11-11)
- `DurableRecordingEngine` is a React-independent coordinator around the existing RecordingEngine and RecordingChunkTransport. Before encoding it bootstraps the per-launch token and creates a validated persistent session using the active layout, resolution, bitrates and audio mode. It never receives ownership of capture, compositor or mixer tracks.
- RecordingEngine streaming mode hands each non-empty MediaRecorder Blob directly to the bounded transport. It does not append that Blob to the temporary result array or create an object URL. The pipeline hashes the original Blob, preserves call order and retains one reference until the server ACK; the transport keeps at most one upload in flight and releases the head only after ACK validation.
- Stop waits for the browser's final `dataavailable`, all pending hashes and all durable ACKs, then calls idempotent finalization with the exact acknowledged count. Finalization network failures/timeouts retry three times. The UI exposes creating, recording, paused, stopping, uploading, retrying, finalizing, failed and Saved states; Saved is rendered only from validated server completion metadata.
- Terminal authentication/protocol failures, source loss, hard queue rejection and transport exhaustion stop encoding without stopping borrowed tracks or claiming success. A high-water condition must remain active for a grace interval before it stops the recorder. Reload/unmount aborts client work and can leave an incomplete server session containing only already acknowledged chunks; browser queue persistence remains future work, while acknowledged-chunk recovery is implemented below.
- Temporary mode remains available and retains its 128 MiB cap and local preview/download behavior. Durable mode uses the existing 64-item/32 MiB queue bound instead of retaining the whole recording. Capability metadata now reports the reliability milestone and recording available, while export remains unavailable.
- Chromium E2E generated real advancing canvas video and mixed audio, emitted at least two MediaRecorder WebM chunks, passed them through real session/chunk/finalization routes, and reached Saved with matching server counts. The E2E server used an explicitly injected synthetic probe adapter because trusted FFprobe/FFmpeg were unavailable; this does not close the Task 5A real-probe acceptance item.

## Implemented interrupted-session recovery (2026-11-11)
- `SessionActivityRegistry` holds only a short per-process lease. Durable recording sends an authenticated heartbeat immediately before MediaRecorder starts and periodically while active. Upload/finalization operations use the same per-session lock; inspection cannot race a currently held operation. A restart intentionally clears leases and marks acknowledged unfinished `idle`/`preview`/`recording`/`paused` sessions `interrupted` through guarded SQLite transitions.
- Authenticated recovery list/detail routes report strict versioned inspection results. Reads require exact local Host, valid supplied Origin, same-origin Fetch Metadata and the current launch token. The inspector derives every path from the UUID, rejects linked/non-regular files, requires ledger/counter continuity from zero, and rechecks sidecar identity, length and SHA-256. Corrupt sessions remain available for diagnosis rather than preventing unrelated sessions from starting, but cannot ingest, finalize or salvage.
- Explicit salvage marks verified interrupted sessions `recoverable` and calls the existing finalizer with the exact contiguous count. Concurrent duplicate salvage shares one task; completed retries return the same metadata. Active sessions conflict. Original media/sidecars are preserved, and successful FFprobe validation remains mandatory before `completed`.
- The React-independent recovery client obtains only an in-memory launch token. `RecoveryPanel` lists unfinished sessions and explains that unacknowledged browser queue data is irretrievably outside the server recovery boundary. The browser queue itself is not persisted.

Everything below remains the target architecture unless explicitly identified above. Browser-queue persistence, vision and the export worker have not been implemented.

## Components
- **Client**: React + TypeScript + Vite. Permission prompts, source selection, preview, compositing, temporary recording and integrated bounded durable recording are implemented.
- **Vision**: Local face detector with adaptive sampling, smoothing, crop controller. Never use remote inference by default.
- **Audio**: Web Audio nodes for mic and available display audio, output to one destination stream.
- **Compositor**: Canvas-based rendering of screen/camera, PIP, split, focus region, recorded through `captureStream()`.
- **Recorder**: MediaRecorder MIME probing supports bounded temporary output and direct durable chunk streaming. Durable mode creates the session, maintains an activity lease, drains ordered/checksummed ACKs and finalizes before Saved. Browser queue persistence remains planned. Blob chunks are a byte stream, not independent video files.
- **API**: Express bound to loopback with same-origin safeguards and token on mutations and recovery inspection; session CRUD, strict raw chunk PUT, authenticated finalization and recovery are implemented.
- **Persistence**: SQLite v4 stores session/chunk/final-output metadata while chunk bytes, final WebM and commit sidecars remain in server-controlled session paths. Flushed file publication and SQLite transactions precede every chunk ACK and completed-finalization response.
- **Export worker**: FFmpeg invoked with argument arrays, preserves original intermediate, reports progress.

## Target end-to-end flow
```text
screen + webcam -> compositor canvas -> canvas.captureStream --+ 
mic + display audio -> Web Audio mix --------------------------+-> MediaRecorder -> chunk queue
                                                                        |
                                                             localhost Express API
                                                                        |
                                                       durable chunks + SQLite metadata
                                                                        |
                                                           finalizer -> FFprobe -> FFmpeg
                                                                        |
                                                                  MP4 in local library
```

## Dependency direction
`client UI -> client services -> browser media APIs`; `routes -> domain services -> storage/FFmpeg adapters`. Shared validation schemas must not depend on UI code.

## Invariants
1. Browser does not automatically bypass media permissions.
2. All backend file paths are derived from server-controlled session IDs.
3. A chunk is ACKed only after durable commitment.
4. Existing acknowledged bytes are never overwritten by an incompatible retry.
5. MP4 export failure does not delete original recording.
6. Only supported source audio tracks are mixed; absent system audio is not fabricated.
7. The UI never claims a recording is complete until finalization succeeds.
8. Browser source capture can end asynchronously and must transition safely.

## Important pitfalls
- `getDisplayMedia()` always requires interactive permission and browser-controlled selection.
- Browser cannot reliably read other applications' global cursor coordinates.
- Windows Studio Effects can already be applied by an OS camera pipeline but are not assumed programmatically controllable by web code.
- A MediaRecorder chunk is not necessarily independently playable.
- FFmpeg and browser canvas may not produce identical colors or timing on all machines.
- Recovery from sudden power failure is best effort, not a guarantee.

## Proposed interfaces
```ts
type RecordingState = 'idle'|'preview'|'recording'|'paused'|'finalizing'|'completed'|'interrupted'|'recoverable'|'failed';
type Region = { x:number; y:number; width:number; height:number }; // normalized [0,1]
type Layout = 'screen'|'camera'|'pip'|'split';
type ChunkAck = { schemaVersion:1; sessionId:string; sequence:number; byteLength:number; sha256:string; committed:true; committedAt:string };
```

## Security boundaries
Browser UI is not inherently trusted just because traffic uses localhost. Validate Host, Origin, Fetch Metadata, session capability, request body, chunk sequence, filesystem containment, and media types on the server.

## Future integration
Recorder exports MP4. An optional later Frame Studio import manifest must use a versioned schema and relative media paths. Do not assume Frame Studio already supports this endpoint.
