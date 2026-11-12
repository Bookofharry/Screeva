# Screeva

> **screeva.** — *Your Screen. Your Studio.*

A modern, local-first screen and webcam recording studio for creators, developers, and educators (**under development**). This checkout implements Phase 1, Phase 2 and most of Phase 3: permission checks, device selectors, sustained screen/camera/microphone capture, live previews/cleanup, canvas composition, local microphone/display-audio mixing, short in-memory WebM recording, durable chunked WebM recording to the local server with FFprobe-validated finalization, and best-effort recovery of server-acknowledged chunks after an interruption. Finalization and salvage require a trusted FFprobe binary. MP4 export, face tracking and focus zoom are not implemented. See TASKS.md for exactly what has been verified. **Screeva** is the working brand name (formerly *Local Creator Recorder*; internal workspace package and API capability names remain unchanged for stability, and trademark/domain clearance is not claimed).

## Windows setup

Install Node.js **24.13 or later within the 24.x line**, including npm. From PowerShell in this checkout:

```powershell
npm ci
npm run build
npm start
```

Open the printed address, normally **http://127.0.0.1:4317**. Use this exact address; `localhost`, other Host headers, proxies, and LAN access are intentionally rejected. To choose another port, set `$env:PORT = '4319'` before starting. No account or external service is needed. Camera, microphone and screen access are requested only when you click a capture control. Stop with Ctrl+C.

**FFprobe for durable recordings:** finishing a durable recording or salvaging an interrupted one requires a trusted `ffprobe` executable (part of FFmpeg). The server runs `ffprobe` from `PATH`, or the absolute path in `$env:FFPROBE_PATH` if set (relative paths are rejected). Without it, chunks are still durably stored, but finalization fails and the session is never marked complete. Temporary in-browser recording does not need FFprobe.

The UI shows input setup, local service and SQLite status. **Check local access** exercises the authenticated API boundary without modifying recordings. Page load and device selection never open camera/microphone streams. Dependencies and the optional test browser need network access for installation; the built application uses only local resources.

## Input setup (first Phase 2 task)

Choose a camera or microphone from the labeled selector, or keep **System default**. Device names/list entries can remain hidden until the browser permits access. **Refresh devices** updates the list; device-change and tab-visibility events also refresh it. A missing selected device resets to system default with a visible notice. Selections and device identifiers are held in tab memory, not saved or sent to the API.

**Check camera access** and **Check microphone access** request only that input through the browser's permission flow. A successful check immediately stops every returned track; no preview, playback, recording, or upload occurs. Permission status is reported separately from successful device opening. Unsupported permission queries show an unknown status while still allowing a click-initiated check. Denial, unavailable/busy hardware and device changes have recovery guidance.

**Cancel access check** abandons the result but cannot dismiss the browser's prompt: respond to that prompt yourself. Further checks wait until it settles, and a stream granted afterward is immediately stopped. A result arriving after component cleanup is also released. Temporary checks are disabled for an input while its sustained capture is active or pending, and never own sustained streams.

## Live capture (Phase 2 Task 2)

**Share screen** opens the browser's screen/window/tab picker directly from your click. A successful selection stays active and appears in the muted screen preview until stopped. **Start camera** and **Start microphone** independently open the devices chosen above (or system default). Camera has a muted live preview; microphone has an active indicator. Microphone audio is never routed to speakers. Display audio is requested as an optional browser hint: the UI reports whether an actual live audio track was returned. Available audio can be mixed into a temporary local recording.

Change a selector, then click **Switch camera/microphone** to use that selection. **Change shared source** opens a new screen picker. Switching releases the old source first; if the new request fails or is cancelled, that source stays off. There is no silent fallback or automatic restart. Stop controls are independent; **Stop all capture** releases everything. Pending requests can be abandoned, but the native picker/prompt must still be dismissed by the user before another request for that source can start. Late results are always stopped.

Browser stop-sharing, ended/muted tracks and device removal update capture status. Screen-video loss also releases its optional audio; loss of optional display audio leaves screen video running. Actual reported resolution, frame rate, display surface and audio settings are shown locally, including unavailable values; no performance capability is inferred from requested settings. Settings refresh while active to reflect browser source changes. Playback errors show retry guidance while leaving stop controls available. Navigation/pagehide and unmount release streams; returning to the page does not restart capture.

Restart a previously running server and reload the page to apply the same-origin display-capture policy. Screen selection always remains a browser-controlled permission flow in the application.

## Scene compositor (Phase 2 Task 3)

The scene compositor combines the currently active screen and camera into one local canvas. Choose screen-only, camera-only, picture-in-picture or split-screen; move/resize the PIP overlay, adjust the split proportion, and select 720p or 1080p. Screen content is letterboxed when aspect ratios differ, while camera content uses a centered crop. If a source ends, the remaining source fills the canvas.

The canvas targets 30 fps and exposes a visual stream for the later recorder stage, but this phase does not record or save it. The compositor borrows capture streams and never requests permission or stops their tracks. Its synthetic browser tests verify output pixels and advancing frames; physical-device rendering and long-session performance still require manual acceptance.

## Audio mixer (Phase 2 Task 4)

The mixer borrows the active microphone and any audio track supplied with screen sharing. Each route has independent mute, 0–200% gain and a live post-gain meter. The mode indicator distinguishes microphone-only, display-only, combined and no-audio output. When a browser starts Web Audio suspended, click **Enable audio processing** before relying on meters.

Both routes feed one local destination stream for the recorder. Nothing is played through speakers, persisted or uploaded. Missing display audio simply leaves that route unavailable. Stopping, replacing or browser-muting a source updates the graph without giving the mixer ownership of capture tracks. Synthetic oscillator tests cover routing and meters; real microphones and Windows/browser shared audio still require hardware acceptance.

## Temporary recording (Phase 2 Task 5)

When the compositor output is ready, **Start recording** creates a local WebM using the composed canvas and the mixed audio destination when audio processing is running. Controls support pause, resume and stop; the displayed duration excludes paused time. Completed clips can be previewed or downloaded in the current tab. Unsupported WebM codecs, encoder failures and source loss are shown without stopping capture, compositor or mixer tracks.

Temporary recording data is bounded to 128 MiB in browser memory. Reaching that limit stops and discards the attempt. Reloading, closing or crashing the tab loses the clip, and object URLs are revoked on discard/unmount. Use temporary mode only for short local verification clips; use durable mode for anything you want to keep.

## Durable recording (Phase 3)

Durable mode saves the recording to the local server while you record. Before encoding starts, the browser creates a session (title, layout, resolution, bitrates, audio mode). Each MediaRecorder chunk is hashed with SHA-256 and uploaded in order, one at a time. The server writes the chunk to disk, flushes it and records it in SQLite before acknowledging it. Only then does the browser release that chunk from memory. The browser holds at most 64 chunks / 32 MiB awaiting acknowledgement. Transient network or server errors are retried with backoff. Sustained backpressure, exhausted retries, authorization errors or source loss stop encoding visibly without claiming success.

On stop, the browser waits for every chunk to be acknowledged, then asks the server to finalize. The server re-verifies every chunk, concatenates them in order into `final/recording.webm`, validates the result with FFprobe and only then marks the session completed. The UI shows **Saved** only after that response. Original chunks are always kept. Durable recordings are stored as WebM; MP4 export is not implemented yet.

## Interrupted-session recovery (Phase 3)

While durable recording is active, the browser sends a periodic heartbeat. If the tab is reloaded or closed, the browser crashes, or the server restarts, unfinished sessions that have acknowledged chunks are detected and shown in **Interrupted session recovery**. Each entry reports whether its stored chunks pass full verification (contiguous sequence, sizes and SHA-256). **Salvage acknowledged chunks** finalizes the verified chunks through the same FFprobe-validated path as a normal stop.

Recovery is best effort. Only chunks the server acknowledged before the interruption can be recovered; anything still queued or unsent in the browser is lost because the browser queue is not persisted. Corrupt sessions are reported but cannot be salvaged. Sudden power loss is not guaranteed to be survivable, especially on Windows, where directory flushes are unavailable.

Node's built-in SQLite API can emit an experimental-feature warning on Node 24.13. This is expected; that version is covered by local tests. The metadata database is at schema version 4 and older versions are migrated in place without resetting data.

The development dependencies include Rolldown's supported WebAssembly fallback for machines where its native binding cannot load (as observed with Windows Application Control here). No security policy change is required. Keep the fallback version aligned with the locked Rolldown version when updating Vite.

## Development and checks

| Command | Purpose |
| --- | --- |
| `npm ci` | Install exact locked dependencies |
| `npm run dev` | Build the UI, watch client/server source, serve through loopback Express |
| `npm run build` | Build the Vite UI and compile server/shared TypeScript |
| `npm start` | Run the compiled local application |
| `npm run typecheck` | Check client, server, shared code and tests |
| `npm run lint` | Run ESLint |
| `npm test` | Run recorder/audio/compositor/capture lifecycle, device setup, chunk pipeline/transport, ingestion, finalization, recovery, schema, API security and storage regression tests. The real-FFprobe acceptance test is skipped unless FFprobe is available |
| `npm run check` | Typecheck, lint, unit/integration tests and build |
| `npx playwright install chromium` | One-time browser installation for E2E tests |
| `npm run test:e2e` | Build and test temporary and durable WebM recording, recovery UI, audio mixing/meters, canvas composition, live capture/cleanup, input setup, authorization, errors/retry, mobile layout and local-only requests in Chromium. The E2E server uses a synthetic FFprobe stand-in, so it does not validate real media |
| `npm run licenses` | Inventory declared licenses from the lockfile; fail for missing declarations |
| `npm audit` | Check installed dependency versions against registry advisories; requires internet |

Development uses Vite's build watcher, **not a separate network-facing Vite server**. Reload the browser after a client rebuild; server edits restart the server and rotate authorization. Both modes enforce the same origin policy. Browser tests launch an isolated server on port 4318 with a temporary database. They never use `data/`. GitHub Actions is configured for Windows and Linux; a workflow file is not evidence of a completed CI run.

Device/capture tests use mocked browser responses, generated moving-video fixtures and Chromium fake camera/microphone devices. The native display test uses full Chromium (`channel: chromium`, rather than headless-shell) to capture an isolated generated tab; a test-only flag selects that tab by title. It checks decoded pixels and advancing playback time, not just API resolution. These test flags are never used by the application. Tests do not capture the user's desktop or real devices. Windows privacy dialogs, manually operated share pickers, real hardware disconnects and physical-device performance still require hardware acceptance testing.

## Structure

```text
apps/client/src/         React UI and validated API client
  components/           Setup, capture, compositor, mixer, recording and recovery panels
  media/                Device/capture, compositor, audio mixer, recorder, chunk pipeline/transport,
                        durable recording coordinator and recovery client
  ui/                   Design tokens and reusable UI primitives (see UX_DESIGN.md)
apps/server/src/         Express composition, security middleware and loopback lifecycle
  routes/               HTTP handlers
  services/             Capabilities, sessions, chunk ingestion, finalization, recovery,
                        activity leases and per-session locks
  media/                Fixed-argument FFprobe adapter
  storage/              SQLite metadata/migrations and safe session paths
packages/shared/src/    Zod schemas and v1 API envelopes
tests/                  Unit, API, storage, ingestion, finalization and recovery tests
tests/e2e/              Chromium foundation, capture, composition, audio, recording and recovery checks
tests/acceptance/       Opt-in five-minute synchronized recording fixture (needs FFmpeg/FFprobe)
data/                   Ignored runtime metadata, sessions, exports and logs
```

## API and security boundary

All responses use `{ apiVersion: "v1", ok: true, data }` or `{ apiVersion: "v1", ok: false, error: { code, message } }`.

| Route | Implemented behavior |
| --- | --- |
| `GET /api/v1/capabilities` | Checks SQLite availability; reports the reliability milestone with recording available and export unavailable |
| `GET /api/v1/bootstrap` | Returns a launch-scoped write token only for a same-origin fetch with `X-Recorder-Bootstrap: 1` |
| `POST /api/v1/diagnostics/write-check` | Accepts an empty JSON object after authorization; does not change stored data |
| `POST /api/v1/sessions` | Creates a session from a strict title/configuration body; the server assigns the ID, status and timestamps |
| `GET /api/v1/sessions` | Lists sessions newest first with `limit` (1–100) and opaque `cursor` pagination |
| `GET /api/v1/sessions/:id` | Returns one session's metadata, chunk counters and final output metadata if completed |
| `PUT /api/v1/sessions/:id/chunks/:seq` | Streams one raw `video/webm` chunk (max 32 MiB) with declared length, SHA-256 and client timestamp; returns a durable ACK only after commit. Exact retries are idempotent; conflicts return 409 |
| `POST /api/v1/sessions/:id/finalize` | Takes `{ expectedChunkCount }`, verifies and concatenates all chunks, validates with FFprobe and marks the session completed. Idempotent |
| `POST /api/v1/sessions/:id/heartbeat` | Refreshes the short in-memory activity lease for an active durable recording |
| `GET /api/v1/recovery` | Lists unfinished sessions with their verification results (token required) |
| `GET /api/v1/sessions/:id/recovery` | Inspects one session for recovery (token required). Inspecting an unfinished session with verified chunks marks it `interrupted` |
| `POST /api/v1/sessions/:id/recovery/salvage` | Finalizes the verified acknowledged chunks of an interrupted session through the FFprobe-validated path |

Writes require the exact Origin, `Sec-Fetch-Site: same-origin`, and `X-Recorder-Token`. Recovery reads additionally require `Sec-Fetch-Site: same-origin` and the token, because they reveal stored-session details. Tokens are random 256-bit capabilities, exist only in process/request memory, rotate on restart, and are never included in URLs or persisted by the client. Bootstrap and API responses are not cacheable. Host validation also covers static assets. No wildcard CORS, forwarded-host trust, request logging, external fonts, telemetry, or cloud media transfers are enabled. Permissions Policy permits camera, microphone and display capture only for this origin. Browser permissions are still required. CSP allows local/blob media for preview; no remote media hosts are allowed. Durable recordings are uploaded only to this loopback server and stored under `data/`; nothing leaves the computer.

This boundary defends against hostile websites and DNS rebinding. It does not isolate the app from malicious software already running as the same OS user, browser extensions, or XSS in the trusted application. Such processes can forge browser headers or race filesystem checks. All storage paths derive from server-generated session UUIDs and sequence numbers; client paths are never accepted. Symlinks/junctions, hard-linked files and non-regular files are rejected at the point of use. These checks do not promise protection against an attacker who can concurrently replace local files. FFprobe runs with a fixed argument array and no shell. Overall disk quotas and low-disk thresholds are not implemented yet.

SQLite metadata lives in `data/recorder.sqlite`, with WAL and full synchronous writes. It stores session metadata, the chunk ledger and final-output metadata; recording bytes live in `data/sessions/<session-id>/` (`capture/` chunks with commit sidecars, `final/recording.webm`). Migration does not reset existing data; unknown schema versions fail startup. On startup the server reconciles interrupted uploads and finalizations and refuses to start if acknowledged data is missing or corrupt, rather than overwriting it. Do not delete `data/` to troubleshoot a failure: preserve it and investigate build, port and filesystem permissions. Permission failure, corrupt metadata, or a port collision prevents startup without intentionally deleting data.

Read [AGENTS.md](AGENTS.md), [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TASKS.md](TASKS.md) and [DECISIONS.md](DECISIONS.md) before extending the project. See [DEPENDENCIES.md](DEPENDENCIES.md) for dependency purposes and license/security notes. Source is licensed under [MIT](LICENSE).
