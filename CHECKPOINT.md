# FloatNote checkpoint

Branch `v2`, not merged to `master`; the merge happens at release. Version in
`package.json` is still `1.4.0`. The installed app on Daniel's machine is v1.

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

## Next

Phase 6 is Daniel's: bump to 2.0.0, `npm run build` (both installers), install
over v1, then the skill's real-mail run. Small candidates if more polish is
wanted first: sort done items by `doneAt` within a list (Today keeps `listAt`).

## Open questions for Daniel

- Release timing, and whether v2 should migrate his real v1 data on first launch
  (it will; `floatnote-data.v1.json` is written first).
