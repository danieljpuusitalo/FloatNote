# FloatNote: standing instructions

Electron always-on-top window, being rebuilt (branch `v2`) from a notepad with a
checklist into a to-do system: four lists (Today / Next / Waiting / Later), a
morning pick, global-hotkey capture, per-record Firebase sync, and a drop folder
Claude writes suggestions into. Notes and Habits stay as secondary tabs.
Distributed as local Windows installers; nothing is deployed, no store listing.

The plan this branch follows: `~/.claude/plans/stateful-nibbling-minsky.md`.

A separate macOS port lives at `~/FloatNote-mac` (v1, out of scope) and a
Firebase-backed web/PWA port at `~/FloatNote-web`. They are independent codebases,
not build targets of this one.

## Verify

**`npm test`** — `node --test` over `test/`, covering `core.js`: capture parsing,
v1→v2 migration, records/stamp/merge (with negative controls), carry-over,
staleness, streak, suggestion intake.

It covers the logic, not the UI. Anything about `index.html` or the window is a
hand-check (`npm start`, see the data-dir trap below). Say which one a claim is.

## Where state lives

`README.md` for features; version in `package.json`. No checkpoint file yet.

## Hard rules

1. **Releases ship BOTH architectures.** `npm run build` chains
   `electron-builder --win --x64 && electron-builder --win --arm64`, producing
   `FloatNote Setup <version>-{x64,arm64}.exe`. Shipping one arch is the recurring
   mistake. `build:x64` and `build:arm64` exist for iteration only.
2. **`index.html` is the entire UI.** Do not split it into modules, add a bundler,
   or add a renderer build step as an unprompted improvement.
   **The one deliberate exception is `core.js`**: the pure logic (no DOM, no
   Electron), loaded by `index.html` via `<script src>` as `window.FNCore` and by
   `main.js` via `require`. It exists so the logic is testable. Logic that can be
   tested goes there; UI stays in `index.html`.
3. `build.files` is an allowlist: `main.js`, `preload.js`, `index.html`, `core.js`,
   `package.json`, `build/**`. A new runtime file not added there is simply absent
   from the installer, with no error.
4. Test fixtures are invented data. Never paste real to-dos into `test/`.

## Stop-points

- Changing the Firebase project, database rules, or auth mode. Sync is the one part
  that can break other installs.
- Cutting a release. Version bump, both installers, and Daniel's hand.

## Traps

- **`npm start` uses the REAL data directory.** In dev, `userData` resolves to
  `%APPDATA%/floatnote`, which on Windows is the same folder as the installed app's
  `%APPDATA%/FloatNote`. A v2 build migrates whatever it loads. For any dev run,
  set `FLOATNOTE_DATA_DIR` to a scratch copy. Migration does write
  `floatnote-data.v1.json` first, but do not rely on it.
- Data files in the data dir: `floatnote-data.json` (state, `schemaVersion: 2`),
  `floatnote-clock.json` (per-record sync timestamps and tombstones; deleting it
  makes every record look new), `floatnote-window.json`, `floatnote-sync.json`
  (passphrase; never print it), `backups/` (one per day, 14 kept).
- **`dist/` is gitignored, so installers are never committed**, and the newest built
  installer on disk is `1.3.1`. Do not infer the shipped version from `dist/`.
- **Firebase config is hardcoded and committed** (project `floatnote-app`,
  europe-west1 RTDB, anonymous auth). Client identifiers, not secrets; the database
  *rules* are the security boundary, and they live only in the Firebase console.
- v1 clients `set()` the whole of `sync/<passphrase>`, wiping anything nested under
  it. v2 therefore syncs to the sibling `sync/<passphrase>-v2`, never inside it.
- Electron 40 with electron-builder 25. NSIS one-click, per-user install.
