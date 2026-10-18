# FloatNote checkpoint

**2.1.0 is released and installed on Daniel's machine (2026-10-17)**, on top of
2.0.0 (same day). `master`, tag `v2.1.0`. The arm64 build is installed per-user at
`%LOCALAPPDATA%\Programs\floatnote\FloatNote.exe`, with its own Desktop and Start
menu shortcuts. The old Desktop shortcut that ran `npx electron .` from this repo
is gone, and `launch.vbs` / `launch.bat` are deleted, so the checked-out branch no
longer decides what he runs.

On first launch it set his v1 data aside as `%APPDATA%\FloatNote\floatnote-data.v1.json`
(byte-identical to the original) and started empty, keeping name and theme. A copy
of the v1 files is also at `~/FloatNote-v1-backup-2026-10-17/`. Sync resumed on the
`<passphrase>-v2` node from his existing `floatnote-sync.json`.

**The plan is `~/.claude/plans/bright-coalescing-pond.md`** (one connected platform:
automations that report themselves, then a Cloudflare Worker + Durable Object
replacing Firebase, then the same `index.html` on the phone). Daniel keeps the
installed desktop app (2026-10-17: asked about a web-only desktop, chose to stay
with the Electron model). **Phase 1 is released in 2.1.0:**

- `run` entries in the drop folder (`core.recordRun`), counted from what the app
  took in, merged by id; `core.runStatus` gives one line: in the morning pick
  ("Claude checked sent mail and checkpoints at 07:15: 2 new."), and under Today
  only when something is wrong (errors, a run that never reported back, or a
  scheduled run missing on a weekday after 08:30).
- `sync.js`: a refused push now schedules a reconcile with backoff, and
  `retryNow` works from `error` mode (the reasoned "stays error" item, fixed).
- **The collector is scheduled**: task `FloatNoteCollector`, weekdays 07:15,
  `tools/collector/` (run.ps1 + install-task.ps1). `--permission-mode dontAsk`
  with an allowlist of three Gmail reads, Read/Glob/Grep and an `Edit()` rule
  for the inbox only; no shell; plugins off for the run (the Telegram plugin
  would start a second poller). The skill writes `.tmp`, the script renames it
  and adds its own `run` report (cost, errors, "wrote no findings").
- Skill: every collect writes a `run` entry; new checkpoint source (`kind:
  blocked`, from "blocked on Daniel" lines in registry `state` files, max 2 a run).

Verified: `npm test` 115/115 (mutation checks on the retry and the merge time).
CDP hand-check on invented data: the run line in the pick, the error and missing
lines under Today, a negative control, no exceptions (6/6). Plumbing on a scratch
data dir: a skill that stops early is reported as a problem. Probes: `list_labels`
refused, a write outside the inbox refused, Telegram not loaded. **First real
scheduled run, 2026-10-17 18:32**: task result 0, 84 s, $0.99, 2 checkpoint
suggestions, nothing refused. **2.1.0**: both installers built, the packaged arm64
build passed the same 6 checks, installed silently over 2.0.0 (items 3 before and
after). A task run after install (19:17, result 0, 96 s, $0.97) stored
`meta/lastRun` with sources and counts in the installed app's state.

**Phase 2 is built and verified locally, on branch `phase2-server`, not deployed.**
Nothing changes for Daniel: the installed app still syncs over Firebase.

- `server-core.js` (repo root, pure, not in the installer): records keyed by raw
  path, newest `t` wins, a tie keeps the stored copy, an older write is answered
  with the kept copy (`stale`), a purge removes tombstones only. Each accepted
  write gets a sequence number; `GET /api/sync?since=n` is the catch-up. Device
  tokens are stored as SHA-256, the first pairing needs the `SETUP_KEY` secret,
  revoking a device closes its sockets. A broadcast over 900 KiB goes out as a
  `changed` notice (Workers caps a socket message at 1 MiB).
- `sync.js` `httpBackend(url, token)`: HTTP writes in chunks of 1000, a WebSocket
  for changes (token in `Sec-WebSocket-Protocol`), catch-up on reconnect, on a new
  listener and on a sequence gap, ping every 30 s and dead after 75 s silent,
  reconnect backoff 1 s to 60 s. A network failure reads `offline`, not `error`,
  and coming back online with a refused push waiting reconciles at once.
- `server/`: `worker.js` (Worker + `FloatNoteDO`, SQLite storage, hibernating
  sockets, ping answered without waking), `wrangler.toml` (production `floatnote`
  and `--env staging`), its own `package.json` so wrangler stays out of the app.
  `server/dev-server.mjs` is a Node stand-in on `node:sqlite` + `ws`, because
  `wrangler dev` needs workerd, which has no Windows-on-Arm build.
- Desktop opt-in for dev runs: `FLOATNOTE_SYNC=server` reads
  `<data dir>/floatnote-server.json` (`{url, token}`, written by
  `tools/pair-device.mjs`; never print it).

Verified: `npm test` 141/141, 26 in `test/server.test.js` (server unit, SQLite vs
in-memory parity with a negative control, auth, and `createSync` + `httpBackend`
end to end over a fake network: offline, dropped and silent sockets, a lost
broadcast, a slow clock, a revoked device, oversized changes, chunking). Mutations
of the gap catch-up, the stale delivery, the notice and the `t 0` rule each fail
their test. `node tools/check-server-sync.mjs`: two real Electron windows through
the dev server, two passes of add, edit, tick, untick, delete, then the server
stopped, both edit (offline, not error; nothing crosses), restarted: both converge
with identical item records; no page exceptions. That check caught a real bug the
unit tests had missed: `core.recoverClock` stamps unknown-age records `t 0`, which
the server refused, so a recovered device could never push.
`wrangler deploy --dry-run` bundles (14.6 KiB, the DO binding present).

**Staging is deployed (2026-10-17)**: `https://floatnote-staging.daniel-jpuusitalo.workers.dev`,
Cloudflare account daniel.jpuusitalo@gmail.com, version `e50687b6`. Deploy with
`cd server && npm run deploy:staging` (local wrangler; the global one under
`%APPDATA%
pm` is broken and unused). Its SETUP_KEY is in
`~/.floatnote-staging-setup-key`, outside every repo; never print it. Both hand-checks
take `FLOATNOTE_CHECK_URL` + `FLOATNOTE_SETUP_KEY` to run against it: the
two-window check passed both passes (the offline part is skipped, a deployed
server cannot be stopped), and the phone check 50/50, twice.

**The staging run found a real sync bug** the local runs could not (the dev
server starts empty, staging keeps everything): two devices whose records are
both `t 0` (clocks recovered, no clock file) with different copies never
converged. The server kept its copy on a tie and said nothing; the device never
adopts an equal `t`. Fixed: a tie now goes to the server's copy
(`core.applyRemote`), and the server answers a tie with different content with
the kept copy (`server-core.applyWrites`). New e2e test, and each half of the fix
mutated back fails it.

**Phase 3 (the phone is the same app) is built and verified locally, on branch
`phase3-phone` (from `phase2-server`), not deployed.** Nothing changes for Daniel yet.

- The Worker serves the app as static assets (`[assets]` in `wrangler.toml`,
  `server/public/`, gitignored). `server/build-public.mjs` builds it from this
  repo's `index.html`, `core.js`, `sync.js` plus `web/` (`web-api.js`, `sw.js`,
  manifest with a share target, icons, `_headers`). Its page edits are
  exact-match and throw if an anchor moves. This replaced the plan's HTMLRewriter
  idea, so a wrong page fails the build, not the phone.
- `web/web-api.js` is `window.api` for a browser: state and clock in IndexedDB,
  `sync.js` in the page over `httpBackend`, pairing with the setup key (used once,
  never stored), flush on `visibilitychange` / `pagehide`. **Fresh-device guard:** a
  browser that never synced stamps nothing until its first sync, so an empty phone
  cannot wipe the desktop. `core.commitSave` is the save path main and the browser
  now share (tested).
- `index.html` phone layout: `:root.web` hides the titlebar and the desktop-only
  settings (hotkey, login, keyboard); `@media (hover: none)` / `TOUCH` makes the
  first tap select a row and show its actions (Today/Next/Wait/Later, Due, drop)
  and the second tap edit; a Due button with the native date input over it;
  touch-sized targets; inputs at 16px; a tap on an empty habit day moves the
  nearest open slot there; the custom Notes menu is off on touch; shared text
  lands in the capture box to check, not straight on a list.

Verified: `npm test` 147/147 (148 with the tie fix), 10 full runs in a row green (`test/web.test.js` is
new: the page edits, the desktop file keeping `connect-src 'none'`, a negative
control where a missing or doubled anchor throws, and every service-worker shell
file existing). A flaky e2e helper was fixed: `settle()` counted event-loop turns
while waiting on a threadpool hash, and lost under the parallel run about 1 run in
3. `node tools/check-phone.mjs`: all 50 checks pass. Real desktop window plus
headless Edge at 390px with touch; pairing through Settings; every list action by
real touch events, each reaching the desktop; capture; share; notes; habit tap;
the desktop page keeping hover and its settings. Negative control: after a fresh
phone joins, the desktop's records are byte-identical and the phone holds the
same. It caught the Due input sitting 1px inside the button's border.

**Proven on staging:** the Durable Object serving the page and syncing it (above).
**Not yet proven: a real phone.** Daniel opens the staging URL on his phone, adds it
to the home screen, pairs in Settings with the key from
`~/.floatnote-staging-setup-key`, and runs the list by hand. Staging holds only
invented test data (each phone-check run clears its `Invented` items).

Accepted limits: two tabs of the app in one browser can overwrite each other's
IndexedDB copy; iOS may evict storage of a site not added to the home screen (the
server copy survives, the phone re-syncs); a fresh phone shows onboarding before
it can pair (its answers are replaced by the desktop's on the first sync).

**Cleanup pass (2026-10-18), branch `cleanup` (from `phase3-phone`), pushed, not
merged.** Dead code out (unused CSS, the `api.quit` chain, test-only `needsTriage`
/ `ingestSuggestions`, mac build config, `create-shortcut.js`, six orphan
screenshots); the Notes keyboard and right-click toggles merged into one
`toggleBullets` / `toggleChecklist`, which fixes Ctrl+Shift+L turning a heading into
a checklist line; `.gitattributes` makes every file LF. New hand-check
`tools/check-notes.mjs` (17 checks; against the old `index.html` the heading case
fails, the rest pass). Verified: `npm test` 148/148, `check-phone` 50/50,
`check-notes` 17/17. **Branch chain to land, in order:** `phase2-server` →
`phase3-phone` → `cleanup`, none merged to `master`. Merge when the real-phone test
passes; nothing here reaches Daniel before a release.

**Real-phone test (2026-10-18), on staging:** Daniel paired his iPhone and a Chrome tab
on his PC; sync works both ways. His finding: Chrome on a computer "feels buggy". Fixed on
`cleanup`: (1) the page stretched across the whole screen, buttons far from the text; it
is now a 640px centred column in a wide browser; (2) **a click that ends an edit was
lost** (the due badge, a row button, another row's tick): the blur rebuilt the list
between press and release. This was in the Electron app too. The rebuild now waits for
the release (`afterPress`). (3) Settings said "this phone" in any browser; now
"this device". New `tools/check-browser.mjs` (12 checks; the pre-fix page fails 4).
Verified: `npm test` 148/148, `check-phone` all passed, `check-notes` 17/17.

**The direction is `docs/INTAKE.md`**: how to-dos flow in, and what earns a place.
Read it before changing the pick, the drop folder or the skill.

The plan this branch followed is `~/.claude/plans/stateful-nibbling-minsky.md`
(outside the repo). All six phases are done.

## What 2.0.0 is

- Four lists, capped Today, keyboard-first list, hotkey capture, per-record sync,
  settings (including "keep above other windows"), compact mode, Notes, Habits.
- Intake (INTAKE.md "App changes this needs", all built):
  - the morning pick is carry, then "New from Claude" (Keep/Today/Drop/Decide
    later), then pick. It never takes keys while a field has focus, a modifier is
    held, on auto-repeat, or in its first 500ms, and it fits compact mode;
  - suggestions expire after 3 days (`core.expireSuggestions`), Next items
    untouched for 30 days slide to Later (`core.slideToLater`), and the first pick
    of the week says how many slid;
  - drop-folder `replied` entries bring a Waiting item back to Next, badged;
  - `decisions.log` in the data dir: keep, drop, done, expired, notyet, one JSON
    line each, 120 days kept. The latest line per id wins (an undone drop is
    followed by a later decision on the same id).
- Hardening: a CSP; notes HTML sanitised on every way in (load, sync, undo, paste);
  atomic save with a unique temp name and fsync; a flush on Windows session end.
- Skill: capture and collect (sent mail + Awaiting-their-reply, read-only; writes
  without a chat review because the pick is the review). Installed with
  `npm run install-skill`.

Verified: `npm test` 107/107. A CDP hand-check on invented data (57 checks: v1 set
aside, the full pick, every decisions-log path, expiry, slide, replied via a real
inbox file, the key guards, compact fit, U fixes, the sanitizer, the on-top toggle,
no CSP or page errors). The packaged arm64 build smoke-tested the same way before
install. Scripts were in the session scratchpad, not the repo.

## Still open

From the 2026-10-17 audit (fixed: C1 to C5, U1 to U11, U13 to U15, U17, U19,
shutdown flush, atomic write):
- **U12:** Notes Ctrl+Z ignores plain typing.
- **U16:** the capture popup can lose text.
- **U18:** the filter is clipped at 300px.
- Reasoned, not proven: `carriedDays` goes up once per run, not once per day; completion ids depend on
  list position.
- Known and accepted: an edit box blurred while the window is unfocused stays open,
  and the list waits for it, until he comes back.

Reality findings:
- The phone PWA (FloatNote-web) reads the `-v2` node but serves an older `core.js`
  and a lighter UI. The plan retires it: the phone gets this `index.html`.
- On this machine the hotkey resolves to Ctrl+Alt+N, because Claude desktop holds
  Ctrl+Alt+Space.
- "Start with Windows" is on (set 2026-10-17).

## Next

1. Daniel re-tries Chrome on staging after the fixes and lists anything else rough.
   Then land the branch chain, cutover (2.2.0: the desktop app joins the server), then
   Phases 4 and 6 of `bright-coalescing-pond.md` (decisions relay, retire Firebase).
   Daniel's goal, stated 2026-10-18: the installed desktop app stays primary and
   syncs with Chrome and the phone through the server.
2. Watch keep rate per source in the run reports; Awaiting-their-reply is 0 of 3
   so far.
3. U12, U16, U18 and the reasoned sync items, when they bite.

## Open questions for Daniel

- More sources (received mail, calendar, transcripts) once the current ones earn
  their keep rate.
