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

## Next

The quality pass (Daniel, 2026-10-17: "make it a very very good application"):
keyboard-first navigation of the lists, a README rewritten for v2 (it still
describes v1 apart from the drop-folder section), and fixes from hand-checks.
Then phase 6 is Daniel's.

## Open questions for Daniel

- Release timing, and whether v2 should migrate his real v1 data on first launch
  (it will; `floatnote-data.v1.json` is written first).
