# FloatNote checkpoint

Branch `v2`, not merged to `master`; the merge happens at release. Version in
`package.json` is still `1.4.0`. **Nothing is installed on Daniel's machine.** The
Desktop `FloatNote.lnk` runs `launch.vbs`, which runs `npx electron .` from this
repo against the real data dir, so whatever branch is checked out is what he gets.
Retire that shortcut at release. His real data is v1, last written 2026-05-11.

**The direction since 2026-10-17 is `docs/INTAKE.md`**: how to-dos flow in, and
what earns a place. Read it before changing the pick, the Suggested section or the skill.

The plan this branch follows is `~/.claude/plans/stateful-nibbling-minsky.md`
(outside the repo). Its phases, and where each stands:

| Phase | What | State |
|---|---|---|
| 1 | `core.js` + tests: capture parsing, v1 migration, records, patch window | done |
| 2 | To-do UI: four lists, morning pick, triage card, compact mode | done |
| 3 | Global-hotkey capture popup | done |
| 4 | Per-record sync v2 + settings screen | done |
| 5 | Claude bridge: drop folder, `floatnote` skill, close-out hints | done, see below |
| 6 | Release 2.0.0, both installers | **Daniel's call, not started** |

## Phase 5, as built

- `main.js` watches `<data dir>/inbox/` (fs.watch plus a 60s poll, and once at
  startup) and feeds `core.ingestInbox`. Format and behaviour are in `README.md`
  under "Drop folder".
- Renderer: the Suggested section shows the item's `note` (the quoted evidence);
  open items show `closeHint` as "Looks done" with Done and Not yet; a toast
  reports each intake.
- Skill source is `skills/floatnote/SKILL.md`, installed with
  `npm run install-skill`.
- Hand-checked against a scratch data dir of invented data, driven over the
  DevTools protocol: intake, BOM, .tmp ignored, bad JSON moved to `rejected/`
  after 10s, re-drop deduped, Keep, Drop, Not yet, direct add to Today.
- **Not yet done:** the plan's "run the skill against real sent mail once, with
  Daniel". That needs a v2 build running against his real data, so it waits for
  the release, or for him to run a v2 copy against a copy of his data dir.

## Quality pass (2026-10-17), as built

Daniel: "make it a very very good application". Done:

- Keyboard-first list: arrows select, Space ticks, T/W/L move, E/Enter edit, D due,
  P ctx, Del drop, Ctrl+Z undo, N or / new, `?` opens a keys overlay. After a tick
  or move the selection goes to the next open row (`keepPlace`), so Space Space
  Space walks down Today. Hidden rows (compact mode) are not selectable.
- Done items sink below open ones in every list (`core.listItems`, tested).
- Capture: an `@name` after the date no longer hides it; a lone `~` anywhere
  means Waiting, like `!` (both tested, with negative controls).
- Waiting badge turns yellow after 7 days; notes expand on click; "Today is done.
  Pick more from Next" when Today is cleared; the manual pick says "Add to Today".
- First run: the morning pick on an empty list no longer toasts unprompted, and
  Today's empty note teaches the capture syntax instead of offering an empty pick.
- README rewritten for v2.

All UI items above are hand-checks over CDP against invented scratch data, not
tests. Not hand-checked: the capture popup *painted* (its DOM and hint were
checked; showing it takes focus on the real desktop).

## Adversarial audit (2026-10-17)

Four passes: data and day one, fit to his needs, core and sync, and UI. Verdict:
the engine is sound, but the app was not in use and could lose data.

**Fixed** in `bb06aec` (98 tests, each with a negative control):
- C1: a corrupt or missing data file restored from a backup no longer tombstones
  what the backup lacks.
- C2: a lost clock no longer out-dates remote edits.
- C3: a v1 file appearing again is not migrated a second time.
- C4: a failed sync start now retries.
- C5: a dormant device no longer brings deleted items back.

Still open in `index.html`, all proven over CDP unless marked reasoned. Line numbers
are as of `30663ed`.
- **U1:** a remote Notes patch is overwritten if the editor has focus (L3848, L1593).
- **U2:** the morning pick opens on focus and takes typed keys; `n`, `c` and `d` move
  or drop items (L3160, L3031, L3124). This goes away with the pick rebuild in INTAKE.md.
- **U3:** a focused suggestion row beats the arrow selection, so Delete drops the
  wrong item (L3007). This goes away when Suggested moves into the pick.
- **U4:** click then blur re-parses unchanged text (`fri` becomes a due date, `~`
  moves it to Waiting). The fix is to skip `applyEdit` when the text is unchanged (L2822).
- **U5:** an open, unchanged edit reverts a remote edit on blur (L2814). Same fix as U4.
- **U6:** `t` with Today full refuses the move but still advances the selection
  (L2695, L2716). `moveTo` should return whether it moved.
- **U7:** undo lasts 5s and any later toast clears it (L2859).
- **U8:** the pick doesn't fit compact mode (94px with an empty Today).
- **U9:** synced notes HTML runs as script, with `window.api` reachable. It needs a
  sanitizer and a CSP.
- **U10:** a selected row deleted remotely moves the selection to its neighbour.
- **Low (U11 to U19):**
  - keys work behind the onboarding screen;
  - Notes Ctrl+Z ignores plain typing;
  - Ctrl+, opens over the pick;
  - `pickKey` ignores modifiers;
  - the pick can move items another device has completed;
  - the capture popup can lose text;
  - the chase badge has 2.6:1 contrast in the paperwhite theme;
  - the filter is clipped at 300px;
  - a habit id from sync is not escaped, and `escapeHtml` throws on non-strings.
- **Reasoned:**
  - sync mode stays `error` after one failed push;
  - nothing is flushed on shutdown or session end;
  - `writeJsonAtomic` uses a fixed `.tmp` name and no fsync;
  - `carriedDays` goes up once per run, not once per day;
  - completion ids depend on list position.

Reality findings from the fit pass:
- The phone PWA (FloatNote-web) reads the v1 node and serves an older `core.js`.
  INTAKE.md proposes Telegram capture instead.
- On this machine the hotkey resolves to Ctrl+Alt+N, because Claude desktop holds
  Ctrl+Alt+Space.
- There is no always-on-top toggle, which matters for screen shares.

## Next

1. **App pass for INTAKE.md:**
   - start fresh: set v1 aside and do not migrate it;
   - move suggestions into a rebuilt morning pick, which also fixes U2, U3 and U8;
   - expire suggestions after 3 days, and slide Next items to Later after 30 days;
   - add a Waiting "replied" state;
   - add a decisions log;
   - fix U1 and U4 to U10.

   Put the logic in `core.js` with tests. The UI is hand-checked.
2. **Collector, version 1:** the skill reads sent mail and threads labelled
   Awaiting-their-reply, with the standing read-only approval in INTAKE.md. Run it by
   hand for a week, recording the cost per run and the keep rate.
3. Release 2.0.0 and install it; that is Daniel's call. Then retire the Desktop shortcut.

## Open questions for Daniel

- Release timing.
- After the hand-run week: schedule the collector, and whether to add more sources.
