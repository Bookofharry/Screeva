# Phase 2 Task 6 — five-minute synchronization report

Date: 2026-11-11  
Result: **PASS**  
Environment: Windows x64, Node.js 24.13.0, Chromium via Playwright 1.65.0  
Media tools: FFmpeg 6.1.1, FFprobe 4.0.2

## Reproduction

Provide trusted FFmpeg and FFprobe executables on `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`, then run:

```powershell
npm run test:recording:five-minute
```

The opt-in Playwright acceptance fixture builds the application, starts the isolated local test server, and drives the real CaptureManager → CanvasCompositor/AudioMixer → RecordingEngine UI path. Generated WebM, decoded RGB/PCM, and JSON/Markdown evidence remain under ignored `test-results/`; no media fixture is committed.

## Fixture

- Synthetic advancing 1280×720 screen and 640×360 camera at 30 fps; the normal 720p picture-in-picture compositor output is recorded.
- Separate synthetic microphone and display-audio oscillators pass through the normal `AudioMixer` into one destination stream. No route connects to speakers.
- RecordingEngine requests 2,000,000 bps VP9/VP8 video and 96,000 bps Opus audio. The theoretical five-minute payload at the requested aggregate bitrate is about 78.6 MB, below the 128 MiB retained-memory limit; the encoder may use fewer bits for simple content.
- Beginning, middle, and end marker windows are scheduled at 5, 150, and 295 seconds. Each has a distinct full-screen color plus distinct microphone/display frequencies.
- A separate short recording exercises two seconds recording, two seconds paused, and two seconds resumed.

## Measured output

| Measurement | Result | Tolerance |
| --- | ---: | ---: |
| Packet-timeline duration | 300.215 s | 300 s ± 3 s |
| Video duration | 300.213 s | — |
| Audio duration | 300.179 s | — |
| Video/audio duration difference | 34.0 ms | ≤ 250 ms |
| Codecs | VP9 + Opus | VP8/VP9 + Opus |
| Dimensions | 1280×720 | 1280×720 |
| File size | 10.89 MiB | < 128 MiB |
| Effective bitrate | 0.304 Mbps | within retained-memory bound |
| Decoded frames | 8,960 | — |
| Decoded frame rate | 29.845 fps | ≥ 27 fps |
| Maximum frame timestamp gap | 72.0 ms | ≤ 200 ms |
| Pause/resume wall time | 6.421 s | includes ≥ 1.5 s pause overhead |
| Pause/resume media time | 4.240 s | 3.5–5.5 s |

This Chrome WebM omitted `format.duration`; duration therefore uses FFprobe-decoded first/last packet timestamps, not chunk count. The first validation attempt correctly failed because it required container duration metadata. The fallback was added, typechecked/linted, and the full five-minute fixture was rerun successfully.

## Marker synchronization

| Marker | Scheduled | Video | Audio | A/V difference | Mic band amplitude | Display band amplitude |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Beginning | 5.000 s | 5.000 s | 5.086 s | 86.0 ms | 0.3097 | 0.3120 |
| Middle | 150.000 s | 150.000 s | 150.086 s | 86.0 ms | 0.3109 | 0.3125 |
| End | 295.000 s | 295.000 s | 295.086 s | 86.0 ms | 0.3112 | 0.3114 |

Every marker was required within ±750 ms of schedule, every A/V difference within 250 ms, and both expected route-frequency amplitudes at least 0.01.

## Memory and ownership

Retained-byte samples were monotonic: 0.0, 2.2, 4.4, 6.6, 8.7, and 10.9 MiB at 0/60/120/180/240/300 seconds. Chromium's reported JavaScript heap samples were 5.82, 5.38, 5.10, 4.80, 5.25, and 4.77 MiB; peak growth from the initial sample was 0 MiB, below the 64 MiB tolerance. Blob backing storage is not fully represented by JavaScript heap, so retained bytes and final file size are reported separately.

All four synthetic CaptureManager-owned tracks and both compositor/mixer output tracks remained live after completion and result replacement. `Stop all capture` ended only the four capture tracks; compositor and mixer outputs remained live until their owners unmount. RecordingEngine did not stop borrowed tracks.

## Limitations

This is deterministic synthetic Chromium acceptance on one Windows machine. It does not establish physical camera/microphone behavior, manually operated share-picker behavior, Edge compatibility, Windows system-audio availability, hardware encoder performance, Linux/remote CI behavior, crash recovery, persistence, MP4 export, or the two-hour soak target.
