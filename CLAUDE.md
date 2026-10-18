# FloatNote: standing instructions

Electron always-on-top window, rebuilt in 2.0.0 from a notepad with a
checklist into a to-do system: four lists (Today / Next / Waiting / Later), a
morning pick, global-hotkey capture, per-record Firebase sync, and a drop folder
Claude writes suggestions into. Notes and Habits stay as secondary tabs.
Distributed as local Windows installers; nothing is deployed, no store listing.

The design for how to-dos flow in is `docs/INTAKE.md`. The original v2 plan:
`~/.claude/plans/stateful-nibbling-minsky.md`.

A separate macOS port lives at `~/FloatNote-mac` (v1, out of scope) and a
Firebase-backed web/PWA port at `~/FloatNote-web`. They are independent codebases,
not build targets of this one. FloatNote-web is being retired: the phone now runs
this repo's own `index.html`, served by the sync server (Phase 3 of the plan below).

## Verify

**`npm test`** — `node --test` over `test/`. `core.test.js` covers `core.js`: capture
parsing, v1→v2 migration, records/stamp/merge, the patch window (a remote change
must not undo an unsaved or in-flight local edit), carry-over, staleness, streak,
drop-folder intake (suggestions, direct adds, done hints, dedupe). `sync.test.js` drives `sync.js` against an in-memory server:
convergence, deletes, unticks, reconnect catch-up, tombstone purge, errors.
`server.test.js` covers `server-core.js` (the sync server's logic, its SQLite store
against `node:sqlite`) and `sync.js` + `httpBackend` end to end against it over a
fake network. `web.test.js` covers `server/build-public.mjs`, the phone's copy of the
page. All four carry negative controls.

`node tools/check-server-sync.mjs` is the two-window hand-check for the server
backend: two real Electron instances on scratch data through `server/dev-server.mjs`,
including the server going away and coming back. Needs `cd server && npm install`.

`node tools/check-phone.mjs` is the phone hand-check: a real desktop window on
invented data plus headless Edge emulating a 390px touch phone, pairing through
Settings and working every list action by real touch events. It includes the
negative control that a fresh phone joining leaves the desktop's records
byte-identical, and it checks the desktop page kept its hover and settings.
Screenshots land in the scratch dir it prints. **Any change to `index.html` needs
this run as well as a desktop look**: the same file is both UIs now.

`node tools/check-browser.mjs` is the third shape of the same page: a computer's
browser, 1440px wide, mouse. It checks the page is a centred column and that a click
which ends an edit still lands (the due badge, a row button, another row's tick); its
negative control is the pre-fix page, which loses all three clicks. Run it with
`check-phone` after any change to `index.html`.

`node tools/check-cutover.mjs` is the 2.2.0 switch as Daniel will do it: a desktop on
Firebase with 40 invented to-dos, a synced clock and 8 deletes chooses "FloatNote
server" in Settings and pairs. Then a second computer pairs, both ways are tried live,
and the desktop unpairs and switches back. The server must hold exactly the desktop's
records, deletes included. `--negative` loses the clock first and must fail the delete
check. Pass a staging URL, with `FLOATNOTE_SETUP_KEY` set, to run it there; it
tombstones its records and revokes its devices afterwards. `FLOATNOTE_EXE` points it
at a packaged build (`dist/win-arm64-unpacked/FloatNote.exe`). Screenshots of the four
Settings states land in the scratch dir it prints.

`node tools/check-notes.mjs` drives the Notes editor's formatting (Ctrl+L,
Ctrl+Shift+L, Ctrl+H, the right-click menu, the markdown shortcuts) in a real window
on scratch data. Run it after any change to the Notes code.

The two sync hand-checks run against a deployed Worker with `FLOATNOTE_CHECK_URL` and
`FLOATNOTE_SETUP_KEY` set (staging's key is in `~/.floatnote-staging-setup-key`;
read it into the variable, never print it). Do run them there after a server
change: staging keeps every earlier run's records, which is how the `t 0` tie bug
showed up, and the empty dev server never shows that.

`npm test` covers the logic, not the UI. Anything about `index.html` or the window is a
hand-check (`npm start`, see the data-dir trap below). Say which one a claim is.

A hand-check can be driven without touching the real desktop: launch
`node_modules/electron/dist/electron.exe . --remote-debugging-port=9333` with
`FLOATNOTE_DATA_DIR` set to a scratch dir of invented data, then evaluate JS in the
page over the DevTools protocol (`http://127.0.0.1:9333/json` lists the targets;
skip the `#capture` one). Set `meta.lastPick` to today in the fixture, or the
morning pick covers the list.

## Where state lives

`CHECKPOINT.md`: where the v2 branch stands and what is next. `README.md` for
features and the drop-folder format; version in `package.json`.

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
   **The second is `web/web-api.js`**: `window.api` for a browser, the stand-in for
   `preload.js` + `main.js` (IndexedDB storage, `sync.js` in the page). No UI. The
   phone layout itself is in `index.html`, switched on by `:root.web` (browser) and
   `@media (hover: none)` / `TOUCH` (touch).
3. `build.files` is an allowlist: `main.js`, `preload.js`, `index.html`, `core.js`,
   `sync.js`, `package.json`, `build/**`. A new runtime file not added there is simply absent
   from the installer, with no error. `web/`, `server/` and `server-core.js` stay out
   of it on purpose: they are the phone and the server, not the desktop.
4. Test fixtures are invented data. Never paste real to-dos into `test/`.

## Stop-points

- Changing the Firebase project, database rules, or auth mode. Sync is the one part
  that can break other installs.
- Cutting a release. Version bump, both installers, and Daniel's hand.

## Traps

- **`npm start` uses the REAL data directory.** In dev, `userData` resolves to
  `%APPDATA%/floatnote`, which on Windows is the same folder as the installed app's
  `%APPDATA%/FloatNote`, the live data. For any dev run, set `FLOATNOTE_DATA_DIR`
  to a scratch copy. (v2 does not migrate v1: it sets a v1 file aside as
  `floatnote-data.v1.json` and starts empty, keeping only the preferences.
  `migrateV1` stays in `core.js`, tested, for a by-hand rescue.)
- `decisions.log` and `collector-preferences.md` in the data dir are the
  collector's feedback loop (`docs/INTAKE.md`). They hold Daniel's real to-do
  text: they never go into this public repo.
- Data files in the data dir: `floatnote-data.json` (state, `schemaVersion: 2`),
  `floatnote-clock.json` (per-record sync timestamps and tombstones; deleting it
  makes every record look new), `floatnote-window.json`, `floatnote-sync.json`
  (passphrase; never print it), `floatnote-server.json` (sync server url, device
  id and token, written by Settings > Pair; never print it), `floatnote-backend.json`
  (`{backend: 'server'|'firebase'}`, the Settings choice), `backups/` (one per day, 14 kept), `inbox/`
  (the drop folder, with `processed.log` and `rejected/`), `inbox-seen.json`
  (what was suggested before; deleting it lets old suggestions come back).
- **The drop folder is read by main, which then edits state itself.** That is the
  one place main changes state on its own, and it goes through the same patch path
  as a remote change (`sendPatch`), so an unsaved edit in the renderer wins. Do
  not add another way for main to change state that skips it.
- **The `floatnote` Claude skill's source is `skills/floatnote/SKILL.md` here.**
  `~/.claude/skills/` is not in the `~/.claude` repo's allowlist, so the copy there
  is unversioned. Edit the repo copy, then `npm run install-skill`. The skill
  checks `schemaVersion` and stops on v1 data, which never reads the drop folder.
- **Daniel runs the installed build** (`%LOCALAPPDATA%Programsloatnote`), not
  this repo. A code change reaches him only through a release and install.
- **`dist/` is gitignored, so installers are never committed**, and `dist/` holds whatever
  was built last, released or not. Do not infer the shipped version from it; the
  installed exe's version is the truth.
- **Firebase config is hardcoded and committed** (project `floatnote-app`,
  europe-west1 RTDB, anonymous auth). Client identifiers, not secrets; the database
  *rules* are the security boundary, and they live only in the Firebase console.
- v1 clients `set()` the whole of `sync/<passphrase>`, wiping anything nested under
  it. v2 therefore syncs to the sibling `sync/<passphrase>-v2`, never inside it.
  An existing v1 `floatnote-sync.json` starts v2 sync on the next launch.
- Sync runs in main only (`sync.js`); the renderer gets `remote-patch` messages.
  Two copies against real Firebase: run each with its own `FLOATNOTE_DATA_DIR` and
  a throwaway passphrase, and delete its `sync/<pass>-v2` node afterwards. Sync
  races only show up there and only some runs, so repeat a pass before trusting it.
- **The sync server (`server/`, logic in `server-core.js`) is replacing Firebase**
  (plan `~/.claude/plans/bright-coalescing-pond.md`). From 2.2.0, Settings > Sync
  chooses "FloatNote server" or "Firebase (old)" (`core.chooseBackend`): the
  `FLOATNOTE_SYNC` env var wins, then the saved choice, then a paired server, then
  an existing passphrase (so an upgrade stays on Firebase until Daniel pairs), and a
  fresh install defaults to the server. Pairing takes the server address
  (prefilled with the production Worker) and the setup key, which is used once and
  not kept. Switching keeps `floatnote-clock.json`, which is what makes the first run
  on the new backend push every record and tombstone. `tools/pair-device.mjs` still
  pairs a scratch data dir from the shell for dev runs.
  `server/` has its own `package.json` so wrangler never enters the app's
  dependencies, and neither it nor `server-core.js` is in `build.files`.
  `wrangler dev` cannot run here (no workerd build for Windows on Arm): test
  locally with `server/dev-server.mjs`, and test the Durable Object itself on the
  staging Worker (`npx wrangler deploy --env staging`). Do not use other
  projects' Cloudflare tokens.
- **The phone's page is built, not written.** `server/build-public.mjs` copies
  `index.html` into the gitignored `server/public/` with a few exact-match edits
  (`class="web"`, `connect-src 'self'`, the viewport, the extra scripts, the PWA
  head tags). Each anchor must match exactly once or the build throws, so moving
  the CSP meta, the `<script src="core.js">` tag or `</head>` in `index.html` breaks
  `npm run deploy` loudly, by design. `dev-server.mjs` and every deploy script run
  the build first. Bump `CACHE` in `web/sw.js` only if the shell file list changes;
  the worker is network-first, so new code reaches the phone without it.
- Electron 40 with electron-builder 25. NSIS one-click, per-user install.
