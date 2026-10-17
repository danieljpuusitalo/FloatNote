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

**Next in Phase 2: deploy staging** (`cd server && npx wrangler deploy --env staging`,
then `npx wrangler secret put SETUP_KEY --env staging`) and run the two-window check
against it, which is the first time the Durable Object adapter itself runs.
Blocked on Daniel: wrangler is not logged in (`! npx wrangler login`, once).

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

1. Finish Phase 2 (staging deploy, above), then Phases 3 to 6 of
   `bright-coalescing-pond.md`: phone, decisions relay, cutover (2.2.0), retire
   Firebase.
2. Watch keep rate per source in the run reports; Awaiting-their-reply is 0 of 3
   so far.
3. U12, U16, U18 and the reasoned sync items, when they bite.

## Open questions for Daniel

- More sources (received mail, calendar, transcripts) once the current ones earn
  their keep rate.
