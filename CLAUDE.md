# FloatNote: standing instructions

Electron floating desktop notepad — checklist, habit tracker, configurable
dashboard, cross-device sync via Firebase. Distributed as local Windows installers;
nothing is deployed and there is no store listing. Dormant since April 2026.

A separate macOS port lives at `~/FloatNote-mac` and a Firebase-backed web port at
`~/FloatNote-web`. They are independent codebases, not build targets of this one.

## Verify

**There is none.** No test script, no tests, no lint, no CI. The only check is
running it: `npm start`.

Any claim about this repo is a hand-check, not a verification. Say so.

## Where state lives

`README.md` (real and detailed, unlike most dormant repos here). No changelog, no
checkpoint. Version lives in `package.json`.

## Hard rules

1. **Releases ship BOTH architectures.** `npm run build` chains
   `electron-builder --win --x64 && electron-builder --win --arm64`, producing
   `FloatNote Setup <version>-{x64,arm64}.exe`. Shipping one arch is the recurring
   mistake. `build:x64` and `build:arm64` exist for iteration only — never for a
   release.
2. **`index.html` is the entire application** — a single 176 KB file holding all UI
   and logic. This is deliberate. Do not split it into modules, add a bundler, or
   introduce a build step for the renderer as an unprompted improvement.
3. `build.files` is an allowlist: `main.js`, `preload.js`, `index.html`,
   `package.json`, `build/**`. A new runtime file that is not added there is simply
   absent from the installer, with no error.

## Stop-points

- Changing the Firebase project, database rules, or auth mode. Sync is the one part
  that can break other people's installs.
- Cutting a release. Version bump, both installers, and Daniel's hand — not a
  session's call.

## Traps

- **`dist/` is gitignored, so installers are never committed**, and the newest built
  installer on disk is `1.3.1` for both arches even though the repo is at a later
  version. Do not infer the shipped version from `dist/`, and do not assume the
  current version has ever been built.
- **Firebase config is hardcoded and committed** in `main.js` (`apiKey`,
  `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId`,
  `appId`) for project `floatnote-app`, europe-west1 RTDB, anonymous auth. There is
  no `.env` and no `process.env` usage anywhere. These are client-side Firebase
  identifiers rather than secrets, but treat the database *rules* as the actual
  security boundary.
- Electron 40 with electron-builder 25. NSIS one-click, per-user install
  (`perMachine: false`), no directory choice.
