# UX-5 accessibility and usability acceptance

Date: 2026-11-14  
Scope: Screeva UX-5 only

## Current evidence status

| Evidence | Status | Notes |
|---|---|---|
| Guarded single-key shortcuts | Automated locally | `R` start/stop, `P` pause/resume and `Escape` countdown cancellation use recorder-derived availability. The in-memory off switch is visible in Recording options. |
| Shortcut safety guards | Automated locally | Repeats, Ctrl/Alt/Meta, form fields, contenteditable targets, sliders, open dialogs and active compositor drags are ignored. |
| Modal keyboard focus | Automated locally | Recording and Scene dialogs receive initial focus, wrap Tab/Shift+Tab, close with Escape and restore focus to their opening trigger. |
| Reduced motion | Automated locally | Design-token and Chromium checks set transition durations to zero under `prefers-reduced-motion: reduce`. |
| Responsive horizontal overflow | Automated locally | Studio, Recordings, Guides, Settings and Recovery are checked at 375Ã—812, 768Ã—1024, 1280Ã—720 and 1440Ã—900. |
| Windows Narrator/NVDA | **Pending manual acceptance** | No assistive-technology session has been performed by this coding run. |
| Physical camera/microphone/share picker | **Pending manual acceptance** | Synthetic/native Chromium fixtures do not replace real-device and browser-prompt validation. |
| Five representative participants | **Pending external acceptance** | No people were recruited or observed by this coding run. |
| Edge and remote CI | **Pending external acceptance** | Chromium was exercised locally; Edge and configured remote CI remain separate. |

Automated run on 2026-11-14:

- `npm run check` with configured trusted FFprobe: **295 passed, 0 failed, 0 skipped**; typecheck, lint, real browser-WebM probe and production build passed.
- `npm run test:e2e`: **40 passed, 0 failed** in local Chromium.
- Strengthened shortcut/off-switch focused rerun after the full suite: **1 passed, 0 failed**.
- Built-app browser inspection at `127.0.0.1:4317`: meaningful Studio content, shortcut switch present, zero framework overlays, no captured console errors, and focus restored to Recording options after Escape.

UX-5 must remain open until the pending manual/external evidence is recorded. Automated checks must not be described as screen-reader or participant acceptance.

## Windows screen-reader protocol

Run once with Windows Narrator and once with a current NVDA release. Record browser/version, assistive-technology version, input/output devices, date, tester and failures.

1. Launch Screeva at the printed loopback URL and confirm the page title, product landmark, service status and Studio navigation are announced once and meaningfully.
2. Navigate Studio, Recordings, Guides, Settings and Recovery using only keyboard input. Confirm current-view state, heading hierarchy, region names and visible focus.
3. Open Scene settings and Recording options. Confirm focus enters the dialog, Tab and Shift+Tab remain inside, Escape closes it, and focus returns to the exact trigger.
4. Review every input and range control. Confirm accessible name, current value/state, disabled state and instructions are announced without relying on color.
5. With synthetic or consented non-private sources, start capture and a short temporary recording. Confirm `REC`, duration, paused/resumed, stopping, completed and errors are understandable without excessive repeated announcements.
6. Enable shortcuts and verify `R`, `P` and Escape. Focus the recording-name input and every relevant slider and confirm letters are typed/adjusted rather than treated as recorder commands. Disable shortcuts and verify all three stop acting globally.
7. Inspect an interrupted fixture. Confirm condition, verified byte/chunk evidence, browser-only loss warning and salvage action are announced without implying guaranteed recovery.
8. Repeat with Windows reduced-motion enabled and 200% text scaling. Record clipping, hidden focus, unexpected scroll and announcement defects.

### Screen-reader result log

| AT / browser | Tester | Pass/fail | Severity and observation | Reproduction | Follow-up |
|---|---|---|---|---|---|
| Narrator / Edge | Pending | Pending | | | |
| NVDA / Chrome | Pending | Pending | | | |

## Five-participant moderated protocol

Recruit five consenting representatives across the intended developer, educator/tutor and creator audiences. Do not use private footage, credentials or production recordings. Use a disposable local data directory and synthetic/demo content.

Each session should attempt:

1. Identify whether recording data leaves the computer.
2. Select a screen source, camera and microphone; explain permission state.
3. Choose PIP, move/resize the webcam, and make a short temporary recording.
4. Repeat using Save to computer; pause/resume and locate the saved session.
5. Respond to an injected interrupted session and explain exactly what Recovery can and cannot salvage.
6. Discover, use and disable keyboard shortcuts.
7. Find local-service diagnostics and explain missing MP4/playback/delete functionality.

Capture task completion, time on task, assistance required, errors, confidence (1â€“5), perceived privacy (1â€“5), and verbatim observations with consent. Classify issues as blocker, high, medium or low. Do not store participant media or identifying data in the repository.

### Participant result log

| Participant | Persona | Tasks completed | Assistance | Key issue / severity | Confidence | Privacy clarity | Follow-up |
|---|---|---:|---:|---|---:|---:|---|
| P1 | Pending | | | | | | |
| P2 | Pending | | | | | | |
| P3 | Pending | | | | | | |
| P4 | Pending | | | | | | |
| P5 | Pending | | | | | | |

## Completion rule

Close UX-5 only after automated gates pass and both screen-reader rows plus all five participant rows contain real results. Any blocker/high issue must be fixed and regression-tested, or explicitly accepted with rationale in `DECISIONS.md`.
