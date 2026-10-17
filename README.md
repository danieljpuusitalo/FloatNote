# FloatNote

A small always-on-top window that holds today's to-dos, and the few things that
come after them.

FloatNote 2 is a to-do system built around one rule: Today holds three things
(you can set 1 to 5). Everything else waits in Next, Waiting or Later until a
morning pick brings it forward. Capture is one line from anywhere, sync is
per-record across machines, and anything that can write a file, Claude included,
can suggest to-dos. Notes and Habits stay as secondary tabs.

Windows only, built with Electron. The UI is a single `index.html`.

---

## The four lists

| List | What it holds |
|---|---|
| **Today** | What you will do today. Capped (3 by default, 1 to 5 in Settings). |
| **Next** | Everything you mean to do. Dated items first, soonest first, then the newest. |
| **Waiting** | Things someone else owes you. After a week the person's badge turns yellow: worth a nudge. |
| **Later** | Someday. Out of sight, not deleted. |

- A ticked item stays visible, struck through, for the rest of the day, below the
  open ones. After 30 days it is removed; the streak and the done-today count keep
  its record.
- The Work / Personal filter at the top narrows every list. A to-do's dot shows
  which one it is.
- **Compact mode** (the green dot in the title bar) shrinks the window to just Today.

## The morning pick

On the first launch or focus of each day:

1. **Carry-overs.** Each unfinished Today item from yesterday comes up one at a
   time: **Carry** it into today, send it back **To Next**, or **Drop** it. A
   carried item wears a "2nd day", "3rd day" badge.
2. **Pick for today.** Next is listed, due items first. Pick until Today is full
   (keys 1 to 9), then **Start day**.

**Not now** skips it. "Pick from Next" under Today opens it again at any time.

If 5 or more Next items have gone untouched for 14 days, a **Still doing this?**
card walks through them: Keep, Later, or Drop.

## Capture

Type into **Add a to-do** at the top, or press **Ctrl+Alt+Space** anywhere in
Windows for the capture popup. If that key is taken, FloatNote falls back to
Ctrl+Alt+N, then Ctrl+Shift+Alt+Space, and says so in Settings, where the hotkey
can be changed.

One line, with a few markers anywhere in it:

| Type | Means |
|---|---|
| `@Anna` | Who it is with. The name stays in the text. |
| `fri`, `tomorrow`, `12/10` | Due date, as the last word (an `@name` after it is fine). A weekday means the next one, today included. Day/month, year optional. |
| `#p` | Personal (`#w` for work). |
| `!` | Straight onto Today, if there is room. |
| `~` | Waiting on someone. |

`Send deck to @Anna fri !` → Today, due Friday, with Anna. `Review Friday notes`
keeps its Friday, because the date only counts at the end. A hint under the box
shows where the line will land before you press Enter.

## Keyboard

The to-do list works without the mouse. Press `?` on the list to see this.

| On the list | |
|---|---|
| `↑` `↓` | Select a to-do |
| `Space` or `X` | Tick or untick |
| `Enter` or `E` | Edit. On a suggestion, Keep |
| `T` / `W` / `L` | Move to Today / Waiting / Later, or back to Next |
| `P` | Switch work and personal |
| `D` | Set the due date |
| `Del` | Drop |
| `Ctrl+Z` | Undo a drop |
| `Esc` | Clear the selection |
| `N` or `/` | New to-do |
| `K` `L` `D` | Keep, Later, Drop on the "Still doing this?" card, when nothing is selected |
| `Ctrl+,` | Settings |

After a tick or a move, the selection goes to the next open to-do, so `Space`
`Space` `Space` works straight down Today.

## Sync

Settings → **Sync**: enter a passphrase, and every copy of FloatNote that uses the
same one stays in step. Each to-do, note and habit syncs as its own record, so an
edit on one machine never overwrites a different edit on another, and a change
arriving while you type does not undo what you are typing.

Firebase Realtime Database with anonymous sign-in; no account. Anyone who knows the
passphrase can read the data, so make it long. v2 syncs to its own location, so a
v1 copy on the same passphrase is left alone.

## Drop folder

Anything that can write a file can hand FloatNote to-dos. FloatNote watches
`%APPDATA%\FloatNote\inbox\`. Each `*.json` file there is read within a second (and
on the next launch if the app was closed), added, and deleted.

```json
{
  "items": [
    { "text": "Send Rui the revised cap table", "who": "Rui", "due": "2026-10-24",
      "note": "\"I'll send it over by Friday.\"",
      "source": { "url": "https://mail.google.com/mail/u/0/#all/abc", "label": "Re: cap table" } }
  ],
  "done": [
    { "done": "<item id>", "why": "You sent the cap table on 15 Oct" }
  ]
}
```

- **`items`** arrive under **Suggested**, in Next (or Waiting, with `"list": "waiting"`),
  and are kept with Enter or dropped with Delete. Other fields: `ctx` (`work` or
  `personal`), `who`, `due` (`YYYY-MM-DD`), `note`, `source` (`{url, label}`), and
  `key` (a stable id for dedupe). `"direct": true` means the person asked for this
  item themselves. It skips Suggested and may also use `later`, or `today` if Today
  has room.
- **`done`** entries put a "Looks done: ..." line on an open item, with **Done** and
  **Not yet**. Nothing is ticked without a click.
- A top-level array of entries also works.
- Write `name.json.tmp` and then rename it to `name.json`. Files ending in `.tmp` are
  ignored.
- Nothing comes back twice. `inbox-seen.json` remembers every suggestion for 180
  days, kept or dropped, by `key` or by source url plus text. Text that matches an
  open item is skipped.
- Every file leaves a line in `inbox/processed.log`, listing what was added and
  what was skipped and why. A file that is not valid JSON after 10 seconds, or is
  over 1 MB, moves to `inbox/rejected/` with a `.why.txt` beside it.

The Claude Code skill in `skills/floatnote/` writes these files. It has three modes:
capture ("add X to FloatNote"), an email sweep for promises and asks (shown for
confirmation, every item quoting its sentence), and close-out. Install it with
`npm run install-skill`.

## Notes and Habits

- **Notes**: a rich-text scratchpad in two categories, Professional and Personal.
  Markdown-style shortcuts (`# `, `- `, `1. `, `[] `, backticks), `Ctrl+B/I/U`,
  `Ctrl+H` heading, `Ctrl+L` bullets, `Ctrl+Shift+L` checklist, `Tab` indent,
  `Ctrl+F` to jump between sections, plain-text paste (`Ctrl+Shift+V` for rich).
- **Habits**: a weekly check-off grid with per-habit schedules, streaks, a 4-week
  heatmap, and archiving.

## Settings

The gear (or `Ctrl+,`): sync passphrase, how many things Today holds, the capture
hotkey, and starting with Windows. The moon toggles the light (paperwhite) theme.

## Your data

Everything lives in `%APPDATA%\FloatNote\`: `floatnote-data.json` holds the state,
`backups/` keeps one copy a day for 14 days, and `inbox/` is the drop folder. The
first v2 launch converts v1 data in place, writing the untouched v1 file to
`floatnote-data.v1.json` first.

---

## Development

```bash
git clone https://github.com/danieljpuusitalo/FloatNote.git
cd FloatNote
npm install
npm test
```

`npm test` covers the logic in `core.js` and `sync.js`. **`npm start` uses your real
data directory**, so for a dev run point it at a scratch copy:

```powershell
$env:FLOATNOTE_DATA_DIR = "$env:TEMP\floatnote-dev"; npm start
```

`npm run build` produces both Windows installers, x64 and arm64.

---

## Version history

### v2.0.0 (unreleased, branch `v2`)
- To-do system: Today / Next / Waiting / Later, a capped Today, the morning pick
  with carry-overs, the "Still doing this?" card for stale items, compact mode
- One-line capture with `@who`, dates, `#p`, `!`, `~`, and a global-hotkey popup
- Keyboard-first list: select, tick, move, edit, date, drop, undo
- Per-record sync, a settings screen, start with Windows
- The drop folder and the `floatnote` Claude skill: suggestions with their
  evidence, and "Looks done" hints
- Daily backups; v1 data migrates on first launch
- Removed: the configurable dashboard and the quote rotation

### v1.4.0: Cross-Device Sync & Audit
- Firebase Realtime Database sync with passphrase-based pairing
- Paperwhite (light) theme, right-click formatting menu, notes search (`Ctrl+F`)

### v1.3.1: App Icon

### v1.3: Habit Tracker & Configurable Dashboard

### v1.2: Rich Text Editor

### v1.1: Sort, Deadlines & Quotes

### v1.0.0: Initial Release

---

## Philosophy

FloatNote should stay small. The UI is one HTML file with no framework; the logic
worth testing lives beside it in `core.js`. If it starts to feel like a project
manager, something has gone wrong.

## License

MIT License
