# Phase 3 Task 7 — fault-injection and resilience report

Date: 2026-11-13  
Environment: Windows, Node.js 24.13.x, Chromium through Playwright 1.65  
Scope: Screeva Phase 3 durable WebM recording, ingestion, finalization, reconciliation and recovery

## External media acceptance

The initial check found no trusted `ffmpeg`, `ffprobe`, `FFMPEG_PATH` or `FFPROBE_PATH`, and the conditional test correctly skipped. The Gyan FFmpeg Essentials 9.0.1 archive was subsequently downloaded from the exact Winget-manifested release URL and verified against Winget SHA-256 `fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9` before extraction. The verified build was installed outside the repository at `%LOCALAPPDATA%\Programs\ScreevaTools\ffmpeg-9.0.1`, with absolute user-level `FFPROBE_PATH` and `FFMPEG_PATH`. The actual Chromium-generated multi-chunk WebM finalization test passed against real FFprobe in 1.7 seconds (1 passed, 0 skipped). This closes the Phase 3 external media gate; no synthetic adapter result is counted as that acceptance. The GPL-3.0 external tool is not an npm/runtime dependency and does not alter the repository's MIT source license.

## Reproduction

```text
npm run test:faults
npm run check
npm run test:e2e
```

The external acceptance can be rerun with a trusted FFprobe on `PATH`, or by setting `FFPROBE_PATH` to a trusted absolute executable path:

```text
node --import tsx --test --test-name-pattern="actual browser-produced multi-chunk WebM" tests/finalization.test.ts
```

## Deterministic fault matrix

| Fault | Injection boundary | Verified outcome |
|---|---|---|
| Server/request interruption during upload | Destroyed request while a streaming upload temporary exists | No ledger advance or ACK; temporary removed; clean retry remains possible |
| Lost ACK after durable commit | First transport response is lost after the server accepts the identity | Retry preserves Blob, sequence, size, timestamp and hash; identical durable ACK releases bytes once |
| Disk full / filesystem publication failure | `ENOSPC` injected after media rename and before sidecar publication | HTTP 500, no ACK or ledger advance; acknowledged prefix preserved; restart removes only uncommitted media |
| SQLite commit failure | Commit throws after flushed media and sidecar publication | No ACK; restart reconciliation promotes only the complete sidecar pair; identical retry is idempotent |
| Browser reload/disposal | Durable controller disposed with acknowledged data and with a delayed session response | Server-acknowledged bytes remain incomplete/recoverable; no completion claim, transport resurrection or borrowed-track stop |
| Device/source loss | Ended borrowed video and encoder failure paths | Recorder fails once, never reports Saved and never stops capture/compositor/mixer-owned tracks |
| Stale launch token | Old token reused after server restart | 401 before upload mutation; fresh token required; no late session resurrection |
| Missing/corrupt chunks and sidecars | Deleted media/sidecar and malformed or checksum-conflicting evidence | Session is corrupt and unsalvageable; unrelated valid sessions remain inspectable/finalizable |
| Upload/finalization/heartbeat/salvage concurrency | Upload held after sidecar publication with competing requests | No early ACK; heartbeat and salvage conflict; inspection reports active; finalization waits behind commit |
| Malformed WebM | Deterministic probe rejection after verified chunk assembly | 500, no output metadata and no `completed` lifecycle; original chunks remain unchanged |
| Repeated reconciliation | Multiple clean restarts after partial and committed publication windows | Idempotent counters/files; no duplicate rows, overwritten bytes or resurrected partials |
| Queue saturation | Item/byte hard bounds and sustained high-water injection | Encoding stops safely before unbounded growth; retained evidence and borrowed tracks remain intact |
| Retry exhaustion | Repeated timeout/transient HTTP failures through final attempt | Terminal failure retains the queue head; no false ACK, dequeue or Saved state |

The filesystem, SQLite, network and probe failures above are deterministic simulations at explicit service/runtime boundaries. They are not claims of real disk exhaustion, process kill timing, sudden power loss, physical-device failure or hardware codec behavior.

## Defect found and fixed

Heartbeat previously updated the activity lease outside the shared per-session operation lock. It could therefore overlap upload/finalization/recovery lifecycle work. Heartbeat now uses non-blocking acquisition of the same lock and returns 409 while another operation owns the session. Recovery inspection and salvage recheck activity after acquiring the lock, closing the check/acquire race. Periodic client heartbeat treats this specific busy conflict as transient and schedules the next lease attempt, while the mandatory initial heartbeat still fails closed. The held-upload and periodic-lease tests verify the complete ordering.

No other production defect was exposed. The remaining additions are acceptance tests and the reproducible `test:faults` command.

## Results

- `npm run test:faults` with real FFprobe: 82 passed, 0 skipped, 0 failed.
- `npm run check` with real FFprobe: typecheck, lint, 284 passed regression tests, 0 skipped, and production build passed.
- `npm run test:e2e`: 37 Chromium tests passed, including real browser MediaRecorder/capture behavior. Durable completion E2E still uses the explicitly injected test probe and is not real-media probe acceptance.

## Remaining limitations

- Real FFprobe accepted the browser-generated multi-chunk finalization path used by normal completion and salvage. The recovery UI's separate browser-flow test still uses an injected deterministic probe, while server salvage delegates to this same accepted finalizer.
- No physical camera/microphone/system-audio, Edge, remote CI, actual disk-full volume, OS process kill, sudden-power-loss or two-hour soak validation was performed.
- Browser queue persistence remains intentionally unimplemented; only server-acknowledged bytes are recoverable.
