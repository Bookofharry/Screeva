# Local Creator Recorder — Electric Violet Color & UI Redesign

**Status:** Dark theme (`COLOR-0`–`COLOR-3`) implemented and verified (2026-11-12); optional light mode (`COLOR-4`) deferred. **Scope:** UI style, semantic color tokens, component visual treatment, tests and progressive rollout. **Out of scope:** changing recording engines, persistence, security, transport, or recovery services.

## 1. Creative direction

**Design personality:** expressive, cinematic, precise, calm in long recording sessions. The visual stage is the hero; interface chrome should recede. Use violet for interactive emphasis, mint sparingly for non-critical highlights, and a dedicated red for recording. Avoid all-neon surfaces, excessive gradients, and rainbow status icons.

**Brand anchors:** background `#0C0A16`, surface `#191529`, primary violet `#9B5CFF`, accent mint `#00E5C3`, text `#F6F2FF`.

**Accessibility correction:** White/light text `#F6F2FF` on violet `#9B5CFF` achieves ~3.55:1 and fails WCAG AA normal-text contrast. Use **dark ink `#0C0A16` on filled violet** (~5.01:1). Violet text on the default dark surface achieves ~4.55:1 (narrow margin); prefer main body text for long copy. For a light theme, use darker violet `#5B32A9` with white text (~8.49:1). Verify all actual token pairings in automated tests.

## 2. Semantic token specification

### Dark mode: default

| Token | Hex | Intent |
|---|---|---|
| `--color-bg` | `#0C0A16` | App frame |
| `--color-surface` | `#191529` | Default panels |
| `--color-surface-raised` | `#241D38` | Elevated panels / popovers |
| `--color-surface-hover` | `#302644` | Hovered neutral controls |
| `--color-border` | `#483C5E` | Subtle structural dividers; not sole focus signal |
| `--color-text` | `#F6F2FF` | Main text |
| `--color-text-muted` | `#A9A4BB` | Secondary text; ~7.38:1 on surface |
| `--color-primary` | `#9B5CFF` | Filled actions, active navigation |
| `--color-primary-hover` | `#B79AFF` | Hover on filled primary (dark text) |
| `--color-primary-pressed` | `#9B5CFF` | Pressed, with shape/motion feedback |
| `--color-on-primary` | `#0C0A16` | Normal text on primary (~5.01:1) |
| `--color-accent` | `#00E5C3` | Optional visual highlight, approved connected state |
| `--color-on-accent` | `#0C0A16` | Text on mint (~12.14:1) |
| `--color-focus` | `#00E5C3` | High-visibility keyboard focus outline, with 2px offset |
| `--color-success` | `#3FD0A8` | Confirmed saved/success |
| `--color-warning` | `#FFB259` | Retry, low disk, attention |
| `--color-danger` | `#FF6678` | Errors, destructive UI |
| `--color-recording` | `#FF445E` | Active REC live indicator; never use violet for this |
| `--color-disabled-bg` | `#302B3B` | Disabled control fill |
| `--color-disabled-text` | `#8B849B` | Disabled-only text; must remain visually identifiable; avoid conveying important information solely through disabled text |
| `--color-overlay` | `rgba(5, 4, 10, .76)` | Modal backdrop |

**Contrast notes:** `#F6F2FF` on `#191529` ~16.15:1; `#9B5CFF` on `#191529` ~4.55:1; `#FF6678` on `#191529` ~6.29:1; `#FFB259` on `#191529` ~9.96:1. Pure decorative dividers are exempt from text contrast; essential UI component boundaries need non-text contrast of 3:1 against adjacent colors. Test disabled affordances manually.

### Light mode: optional, planned after dark theme stabilization

| Token | Hex | Intent |
|---|---|---|
| `--color-bg` | `#F7F5FC` | Main backdrop |
| `--color-surface` | `#FFFFFF` | Panels |
| `--color-surface-raised` | `#F1EBFC` | Controls, selected subpanels |
| `--color-surface-hover` | `#EAE2F8` | Hover |
| `--color-border` | `#B4A9C7` | Borders (check component non-text contrast) |
| `--color-text` | `#271E3C` | Main text; ~14.52:1 on bg |
| `--color-text-muted` | `#5B5270` | Secondary text; ~6.73:1 on bg |
| `--color-primary` | `#5B32A9` | Text, links, filled CTAs |
| `--color-primary-hover` | `#48228F` | Hover |
| `--color-on-primary` | `#FFFFFF` | Filled button text; ~8.49:1 |
| `--color-accent` | `#087968` | Mint-family accessible text/icons, not original bright mint on white |
| `--color-focus` | `#5B32A9` | Focus outline |
| `--color-success` | `#167653` | Success text/icon |
| `--color-warning` | `#8B4B00` | Caution text/icon |
| `--color-danger` | `#B42343` | Error text/icon |
| `--color-recording` | `#C91E40` | Active recording |

**Note:** Color definitions are candidate tokens; run actual pairing checks including border against adjacent surfaces, input states and overlays before approving light mode. Do not flip the whole UI merely because `prefers-color-scheme` changes while someone is recording; theme changes must be presentation-only.

## 3. Accessible state colors

| State | Visual rule | Text copy |
|---|---|---|
| Idle | Neutral border and label | Ready to record |
| Capturing | Red pulsing **only if reduced motion allows**, solid REC dot, top-level timer | Recording · 00:01:28 |
| Paused | Amber status pill, still-visible controls | Paused |
| Uploading | Violet bar and neutral explanatory label | Saving to this computer… |
| Retrying | Amber, spinning icon only if motion allowed | Reconnecting to local service… |
| Finalizing | Violet/neutral progress; no green success yet | Finalizing recording… |
| Saved | Mint/green check **after validated completion** | Saved to this computer |
| Failed | Error red, next action and retained-data statement | Couldn't finish saving |
| Recoverable | Amber plus explicitly scoped text | Recover acknowledged footage |
| Corrupt | Error with separate diagnostic action | Recording needs attention |
| Service unavailable | Warning with retry | Local service offline |

Use icon + text + status for every color-coded state. Avoid “Saved” merely because MediaRecorder stopped or HTTP returned without validated finalization.

## 4. Component application and layout

**AppShell:** deep ink background, elevated sidebar/nav, active item indicated with violet-tinted surface plus left line, label and `aria-current`. Tiny mint connectivity dot **only** after real service health check. A persistent global recording badge should never disappear on route changes.

**Studio:** large 16:9 preview inside a raised frame; violet 1px selected border and subtle violet shadow (not a neon glow). Keep preview and control dock in the same viewport wherever possible at typical desktop heights. Use black/near-black canvas letterbox bars. Never recolor actual captured footage.

**Recording dock:** use a solid **red** Record/Stop distinction; stop is the high-salience active control. Pause/Resume have prominent secondary treatment. On disabled Start, make it visibly neutral rather than filled violet.

**Source panel:** selected screen/camera/mic rows show a modest violet selected rail; functioning audio meter may use mint with amber/red threshold segments, labels accessible to screen readers; browser permission errors use warm error messaging with actions.

**Layout presets:** four picture-in-picture thumbnails with violet outline for the selected layout; camera crop handles at least 44×44 CSS pixel hit target; a visible focus ring for keyboard users. Sliders should have 44px touch zones despite smaller visible tracks.

**Recordings & Recovery:** use understated cards, precise verified states, local-time timestamps, and truthful actions supported by the backend. Do not invent Play, Open file, Delete, Export or direct filesystem actions.

**Settings:** advanced appearance selector (Dark / Light / System; only Dark functional in first pass), output quality, and optional preference storage. Never store tokens, permissions or private footage in localStorage.

**Toast / Banner:** status-specific semantic colors, readable action, nonintrusive announcements. High-severity destructive confirmations require explicit action.

**Typography:** recommended installed/system stack: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`; don't rely on remotely loaded fonts under the app CSP. Prefer 14–16px controls, 16px standard content, semibold section titles; reserve decorative large type for branding, not primary studio space.

**Motion:** 120–180ms transitions for hover/selection, no flicker on recording controls; honor `prefers-reduced-motion: reduce` by removing pulsing/glow/spring motions. No animation in canvas output from decorative UI.

## 5. Wireframe / hierarchy

Desktop >= 1100px:
```text
┌──────────────────────────────────────────────────────────────────┐
│ LOCAL CREATOR     Studio   Recordings   Recovery   Settings   ●REC │
├───────────────┬──────────────────────────────────────────────────┤
│ SOURCES       │ LIVE PREVIEW (16:9)                          ⚙   │
│ Screen   ✓    │                                                  │
│ Camera   ✓    │             actual composited canvas             │
│ Mic     ▰▰▰  │                                                  │
│               ├──────────────────────────────────────────────────┤
│ LAYOUT        │  ● Record    Pause     Stop     00:00:00         │
│ PIP   selected│  Saving: synchronized state / retry / finalizing │
│ Split         │                                                  │
│ ▸ Advanced    │                                                  │
└───────────────┴──────────────────────────────────────────────────┘
```

375px mobile/narrow:
```text
┌────────────────────────┐
│ Creator   ●REC   ☰     │
├────────────────────────┤
│ LIVE PREVIEW 16:9      │
├────────────────────────┤
│ ● Record  Pause   Stop │
│ 00:00:00 · save status │
├────────────────────────┤
│ Sources ▾              │
│ Layout ▾               │
│ Advanced ▸             │
└────────────────────────┘
```

The recorder is primarily a desktop capture product. The responsive mobile layout must never imply mobile `getDisplayMedia` support where absent.

## 6. CSS token starter (examples, not direct project edits)

```css
:root, [data-theme="dark"] {
  color-scheme: dark;
  --color-bg: #0C0A16;
  --color-surface: #191529;
  --color-surface-raised: #241D38;
  --color-surface-hover: #302644;
  --color-border: #483C5E;
  --color-text: #F6F2FF;
  --color-text-muted: #A9A4BB;
  --color-primary: #9B5CFF;
  --color-primary-hover: #B79AFF;
  --color-on-primary: #0C0A16;
  --color-accent: #00E5C3;
  --color-focus: #00E5C3;
  --color-success: #3FD0A8;
  --color-warning: #FFB259;
  --color-danger: #FF6678;
  --color-recording: #FF445E;
  --color-disabled-bg: #302B3B;
  --color-disabled-text: #8B849B;
}
[data-theme="light"] {
  color-scheme: light;
  --color-bg: #F7F5FC;
  --color-surface: #FFFFFF;
  --color-surface-raised: #F1EBFC;
  --color-surface-hover: #EAE2F8;
  --color-border: #B4A9C7;
  --color-text: #271E3C;
  --color-text-muted: #5B5270;
  --color-primary: #5B32A9;
  --color-primary-hover: #48228F;
  --color-on-primary: #FFFFFF;
  --color-accent: #087968;
  --color-focus: #5B32A9;
  --color-success: #167653;
  --color-warning: #8B4B00;
  --color-danger: #B42343;
  --color-recording: #C91E40;
}
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

Avoid blind find/replace of old hexes. Preserve prior tokens with a documented compatibility alias layer while migrating components. Verify light theme non-text indicators and all overlay text before enabling it.

## 7. Test requirements / acceptance criteria

**Programmatic:** WCAG 2.2 AA normal text >= 4.5:1 and large text >= 3:1; essential UI graphical objects and boundaries >= 3:1; visible focus; no unresolved CSS custom properties; no opaque text over translucent surfaces with unknown backdrop; CSS snapshot and dark/light contrasts on *used* pairs, not merely isolated values. Validate colors after hover, focus, active, disabled, selected, error and recording states. Verify opacity compositing rather than testing only source hex values.

**Functional:** existing unit/Chromium suites pass; no mode or persistence behavior changes; Saved displayed only after actual server-validated completion; route switching doesn't unmount active recording; no extra permission requests; keyboard can reach every control. Test at 1440×900, 1280×720, 768×1024, 375×812. Screenshots at idle, recording, paused, uploading, retrying, completed, failed, recovery, offline. Visual review on dark and later light.

**Manual:** Windows High Contrast / forced colors, 200% zoom, screen reader announcements, color blindness simulation, actual webcam/microphone/share picker, no reflows covering recording dock, status meaning without color, system dark/light theme updates; test if recording appearance switch leaves capture unaffected.

**Preserve:** local-only Host/Origin/Fetch Metadata/write token controls; no stored secret tokens; media track ownership; 32 MiB chunk queue and 128 MiB temp mode caps; output unchanged; no false durability claims; FFprobe/physical-device/remote CI gaps remain clearly disclosed.

## 8. Rollout plan (separate from Phase 3 / UX tasks)

- **COLOR-0: Audit existing UX-1A styles.** Inventory all tokens, hardcoded CSS colors, status surfaces, icon paints and SVG, current contrast tests. Save screenshots. No UI edits.
- **COLOR-1: Introduce electric-violet semantic tokens.** Add dark theme variables, compatibility mappings, and contrast-test fixtures. No component DOM changes.
- **COLOR-2: Apply tokens incrementally.** AppShell first, then Studio, recording dock, sources, layouts, meters, status and recovery. Ensure preview priority and no false state meanings.
- **COLOR-3: State/accessibility polish.** Hover, pressed, disabled, focus, alerts, reduced motion, 44px targets, screenshot regressions and manual review.
- **COLOR-4: Optional light mode.** Do not introduce until dark theme is stable, tested and reviewed. Use separate accessible token palette, not inverted dark colors.

Task statuses must be checked only after executed evidence. This proposal does not change existing app files.

## 9. Implementation prompt for coding agent

> Act as a principal product designer and React/TypeScript frontend engineer. Implement the Electric Violet *visual layer* for Local Creator Recorder in small tested commits. First read `AGENTS.md`, `PRD.md`, `ARCHITECTURE.md`, `TASKS.md`, `DECISIONS.md`, latest `UX_DESIGN.md`, and this plan. Inspect actual `apps/client/src/ui/tokens.css`, `apps/client/src/style.css`, `AppShell`, existing UI primitives, studio/recording/recovery panels, and CSS before editing. The confirmed brand anchors are background `#0C0A16`, surface `#191529`, violet `#9B5CFF`, mint `#00E5C3`, and text `#F6F2FF`.
>
> First audit all current token consumers and hardcoded colors, note legacy compatibility needs and record baseline screenshots. Then define semantic dark-mode tokens and apply them to AppShell/navigation, studio stage, source controls, layout presets, recording dock, meters, banners, and recovery. Use dark ink `#0C0A16` for text on filled violet buttons because white on `#9B5CFF` fails AA normal text. Reserve red for actively recording, amber for pending/retrying, green/mint for verified saved, and never communicate status solely with color. Provide predictable hover, pressed, disabled, focus, selection, and error states; respect reduced motion; avoid remote fonts, unnecessary dependencies, distracting gradients or changes to actual recorded canvas pixels.
>
> Preserve all recording services and their lifecycle: `CaptureManager`, `CanvasCompositor`, `AudioMixer`, `RecordingEngine`, `DurableRecordingEngine`, `RecordingChunkPipeline`, `RecordingChunkTransport`, session/recovery APIs, SQLite, security, codec probing, saved-state invariants, and 32 MiB/128 MiB caps. Do not edit those engines or backend routes for cosmetic work. Do not add cloud features, fake library actions or new media permissions.
>
> Add/extend automatic WCAG 2.2 AA contrast checks for actual text/background and essential non-text element pairs, including composited hover/focus/disabled styles. Check min 4.5:1 normal text, 3:1 large text/non-text, and clear focus. Verify RTL if applicable, 200% zoom, 375/768/1280/1440 widths, keyboard nav, and dark theme screenshots in idle/recording/paused/saving/retry/failed/saved/recovery. Preserve existing regression tests and verify no visual changes to final recorded video. Report executed typecheck, lint, unit, browser tests, and build; document missing manual hardware acceptance rather than guessing.
>
> Stage work as COLOR-0 through COLOR-3; treat light mode as a separately approved COLOR-4. Update `UX_DESIGN.md`, `TASKS.md`, and `DECISIONS.md` only where materially needed. Stop after the dark Electric Violet pass and report files, tests, screenshots, contrast tables and unresolved items. Do not begin unrelated UX-2/UX-3 features or redesign application state management.
