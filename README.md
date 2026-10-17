# FloatNote

A lightweight floating desktop notepad that stays out of your way — until you need it.

FloatNote is a productivity scratchpad with notes, checklists, habit tracking, and a fully configurable dashboard — designed for fast thoughts and daily discipline without breaking your flow. Built with Electron as a single-file app.

---

## Features

**Cross-Device Sync** (v1.4)
- Firebase Realtime Database sync via passphrase
- Bidirectional merge with conflict resolution (timestamps, soft deletes)
- Anonymous authentication — no account required

**Configurable Dashboard** (v1.3)
- 20 widget options — 16 stat blocks + 4 full-width panels
- Toggle widgets on/off via gear menu
- Drag-and-drop reordering of any widget
- Stats: completed/pending/priority counts, today's tasks, overdue, habit streaks, XP level, daily averages
- Full-width: stoic quote card, productivity chart, 28-day habit heatmap, per-habit weekly bars
- Layout persists across sessions

**Habit Tracker** (v1.3)
- Dedicated tab with Tracker and Input & Performance views
- Weekly check-off grid with drag-and-drop slot reordering
- Custom schedules — daily or specific days of the week
- Streak tracking — per-habit and overall day streaks
- XP & leveling — gamified progression based on completions
- 28-day heatmap and per-habit weekly completion bars
- Archive habits without losing history

**Rich Text Editor** (v1.2)
- **Inline formatting** — Bold (`Ctrl+B`), Italic (`Ctrl+I`), Underline (`Ctrl+U`), Strikethrough (`Ctrl+Shift+S`)
- **Headings** — Type `# `, `## `, `### ` for title/heading/subheading, or select text and press `Ctrl+H`
- **Bullet lists** — Type `- ` or press `Ctrl+L` (works on multi-line selections)
- **Numbered lists** — Type `1. ` to start; Enter auto-increments, empty Enter exits
- **Checklists** — Type `[] ` to start, or `Ctrl+Shift+L` to toggle; click checkboxes for strikethrough
- **Tab indent** — `Tab` / `Shift+Tab` to indent/outdent any list item (up to 3 levels)
- **Inline code** — Wrap text in backticks: `` `code` ``
- **Smart paste** — Pastes as plain text by default; `Ctrl+Shift+V` for rich paste
- **Full undo/redo** — `Ctrl+Z` / `Ctrl+Y` works across all formatting operations
- **Search** — `Ctrl+F` to search sections within notes

**Checklist Tab** (v1.1)
- Per-task priority flags (high/medium/low)
- Deadline assignment with calendar picker and overdue alerts
- Sort by date added or priority
- Drag-and-drop reordering
- Clean list button to clear completed tasks

**Core**
- Floating always-on-top window
- Two categories: Professional and Personal (notes + checklist)
- Light and dark themes (paperwhite toggle)
- Right-click context menu for formatting
- Elastic overscroll with smooth bounce effect on all scrollable panels
- Custom themed scrollbars
- Stoic & existentialist quote rotation (55+ quotes)
- Onboarding with name and accent colour (purple, blue, green, pink, gold)
- Persistent storage across sessions

---

## Drop folder (v2)

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

---

## Getting Started

```bash
git clone https://github.com/danieljpuusitalo/FloatNote.git
cd FloatNote
npm install
npm start
```

Build the Windows installer:

```bash
npm run build
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+U` | Underline |
| `Ctrl+Shift+S` | Strikethrough |
| `Ctrl+H` | Heading from selection |
| `Ctrl+L` | Toggle bullet list |
| `Ctrl+Shift+L` | Toggle checklist |
| `Tab` / `Shift+Tab` | Indent / outdent list item |
| `Ctrl+F` | Search sections in notes |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |

| Typing shortcut | Result |
|---|---|
| `# ` | Title |
| `## ` | Heading |
| `### ` | Subheading |
| `- ` | Bullet point |
| `1. ` | Numbered list |
| `[] ` | Checklist item |
| `` `text` `` | Inline code |

---

## Version History

### v1.4.0 — Cross-Device Sync & Audit
- Firebase Realtime Database sync with passphrase-based pairing
- Bidirectional merge with timestamp-based conflict resolution
- Anonymous authentication — no sign-up required
- Paperwhite (light) theme toggle
- Right-click context menu for formatting (bold, italic, bullets, headings, code, etc.)
- Notes search (`Ctrl+F`) for jumping between sections
- Codebase audit: fixed heatmap date calculation bug, removed dead CSS, consolidated dashboard styles

### v1.3.1 — App Icon
- Added app icon to installer and window title bar

### v1.3 — Habit Tracker & Configurable Dashboard
- Full habit tracking system with weekly grid, custom schedules, streaks, XP leveling, heatmap, and bar charts
- Configurable dashboard with 20 toggleable widgets and drag-and-drop reordering
- New stat widgets: priority counts, today/overdue tasks, habit metrics, XP, daily averages
- New full-width widgets: 28-day habit heatmap, per-habit weekly completion bars
- Elastic overscroll with smooth bounce on all scrollable panels
- Custom themed scrollbars
- Codebase cleanup: removed dead CSS/JS, optimised calculations

### v1.2 — Rich Text Editor
- Apple Notes-style rich text editing with full inline formatting
- Markdown-style auto-detect shortcuts for headings, lists, checklists, and code
- Numbered lists with auto-increment and renumbering
- Checklist items with checkbox toggle inside the notes editor
- Tab indent/outdent for all list types (3 levels)
- Plain text paste by default, rich paste with Ctrl+Shift+V
- Custom undo/redo stack for consistent Ctrl+Z across all operations
- Multi-line Ctrl+L bullet toggle

### v1.1 — Sort, Deadlines & Quotes
- Checklist sort by date added or priority
- Per-task deadline assignment with calendar picker
- Overdue deadline badges (red highlight)
- 19 additional quotes from Nietzsche, Kierkegaard, and Sartre

### v1.0.0 — Initial Release
- Floating desktop notepad with notes and checklist tabs
- Professional/Personal category toggle
- Dashboard with completion stats and productivity chart
- Onboarding overlay with name and accent colour personalization
- Section headings and bullet points in notes
- Checklist with priority flags, clean list, and date badges
- Stoic quote rotation
- Windows installer via electron-builder

---

## Philosophy

FloatNote is intentionally simple. One HTML file. No frameworks. No dependencies beyond Electron and Firebase. If it starts to feel like a full note-taking platform, something has gone wrong.

---

## Contributing

Pull requests are welcome. Keep it lightweight and focused.

---

## License

MIT License
