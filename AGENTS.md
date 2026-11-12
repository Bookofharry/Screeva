# AGENTS.md — Instructions for AI coding agents

## Project
This repo will implement Local Creator Recorder, a local-first browser screen/webcam recorder with Node.js/Express, FFmpeg export, camera auto framing, and presentation focus tools.

## Read before editing
1. `PRD.md` — product scope, requirements, acceptance criteria.
2. `ARCHITECTURE.md` — components, boundaries, invariants.
3. `TASKS.md` — current milestone, small actionable tasks.
4. `DECISIONS.md` — architectural decisions and trade-offs.

## Core rules
- Treat docs as draft specifications, not evidence that features exist.
- Implement one focused task at a time; report touched files and verification.
- Prefer TypeScript with explicit types and input validation. Keep API services separate from routes and FFmpeg adapters.
- Never add cloud media upload or telemetry by default.
- Do not bypass browser permission prompts or silently capture screens.
- Do not invent system-wide mouse tracking capabilities in an ordinary webpage.
- Protect existing recordings and committed chunks; export should never destroy original data.
- Do not claim a test passed unless actually executed.
- Do not introduce new dependencies without stating purpose and security/licensing implications.
- Add or update regression tests for each behavior change.
- Never commit secrets, tokens, recordings, local databases or media fixtures containing private footage.

## Development procedure
1. Read relevant requirement and active task.
2. Identify architecture files and tests affected.
3. Describe a short change plan.
4. Implement narrowly; add tests.
5. Run available checks; note missing environment dependencies.
6. Update task state and decision log when appropriate.

## Commands
Node.js 24.13+ within 24.x is required. Inspect `package.json` before running commands.
- Install: `npm ci`
- Development: `npm run dev` (reload browser after client rebuilds)
- Build / run: `npm run build`, `npm start`
- Typecheck / lint: `npm run typecheck`, `npm run lint`
- Unit and API/storage integration tests: `npm test`
- Browser tests: `npx playwright install chromium` once, then `npm run test:e2e`
- Combined checks: `npm run check`
- Dependency license inventory: `npm run licenses`

## Definition of done
- Meets requirement acceptance criteria.
- Covers success, failure, cancellation, and device/permission errors as relevant.
- Does not break local-only security or recording durability.
- Tests run or a precise reason given why they could not.
- Relevant docs updated without claiming unimplemented functionality.
