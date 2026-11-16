# Dependency review

Phase 1 uses exact direct dependency versions and a committed npm lockfile. Runtime dependencies are currently managed at the workspace root. This inventory is based on installed package metadata; package licenses and notices remain authoritative. It is not a substitute for reviewing licenses when distributing a release.

| Dependency | Purpose | Declared license | Security/distribution considerations |
| --- | --- | --- | --- |
| React, React DOM | Local status page | MIT | Bundled locally; retain license notices; no CDN runtime |
| @mediapipe/tasks-vision 0.10.21 + BlazeFace short-range model | Explicitly enabled, local browser face detection | Apache-2.0 | Exact pre-telemetry package pin; WASM/model are self-hosted, the model's length and SHA-256 are verified during preparation, and normal runtime has no external request. Retain upstream license/model notices in distributions and review deliberately before upgrading; current 1.2.x was not selected because its published privacy notice describes metrics sent to Google. |
| Express | Loopback HTTP/static/API routing | MIT | Exposed to untrusted HTTP; explicit Host/Origin/token/body checks remain necessary |
| Zod | Shared input and response validation | MIT | Strict schemas; no network or filesystem access required |
| TypeScript | Compile and check TypeScript | Apache-2.0 | Development only; preserve applicable notices when redistributed |
| Vite | Build and watch the React client | MIT | Development toolchain; no Vite HTTP listener in this application; native build components are supply-chain inputs |
| @rolldown/binding-wasm32-wasi | Supported bundler fallback where the native binding cannot load | MIT | Development only; version must match Vite's resolved Rolldown version; adds download size without changing OS security settings |
| tsx | Execute TypeScript tests and watch server source | MIT | Development only; production runs compiled JavaScript |
| ESLint, @eslint/js, typescript-eslint | Static checks | MIT | Development only; lint configuration executes locally |
| @types/node, @types/express, @types/react, @types/react-dom | Library typings | MIT | Development only |
| @playwright/test | Chromium regression tests | Apache-2.0 | Development only; browser downloaded separately; downloaded browser has its own third-party notices |
| Node.js built-in SQLite | Local metadata | Node.js/SQLite bundled notices | No extra npm native database dependency; use the pinned Node major; Node SQLite API is experimental in the tested 24.13 runtime |

Chosen source license: MIT, using the working brand Screeva (formerly Local Creator Recorder). No trademark search or release-name clearance has been performed. Generated vision assets are ignored from source control and prepared from the exact dependency plus the hash-pinned official model; release packaging must retain applicable Apache-2.0 and model notices. No FFmpeg binary, codec package, recording, or private test footage is included.

`npm run licenses` reports all declared lockfile licenses, including optional platform packages. Review `package-lock.json` and installed package notices before distribution. `npm audit` checks registry advisories at execution time; a clean result does not establish that dependencies are free of vulnerabilities. Initial verified results belong in TASKS.md.

Transitive build tooling includes Lightning CSS and its optional platform binaries under MPL-2.0. They are build tools, not imported runtime application modules; redistribution of those tools must preserve their notices and applicable MPL source obligations. Other declared transitive licenses include 0BSD, BSD-2-Clause, BSD-3-Clause, ISC and BlueOak-1.0.0 alongside MIT and Apache-2.0.

The linter dependency tree overrides `minimatch` to 11.0.5 to address GHSA-g3hv-75wg-m249 (glob-pattern denial of service affecting versions 7 through 11.0.0). This is a development dependency, remains BlueOak-1.0.0 licensed, and must be rechecked with lint and npm audit after upgrades. Remove the override once upstream constraints accept a patched version. Advisory: https://github.com/advisories/GHSA-g3hv-75wg-m249
