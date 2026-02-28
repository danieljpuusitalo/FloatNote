# FloatNote

A lightweight floating desktop notepad that stays out of your way — until you need it.

FloatNote is a productivity scratchpad with notes, checklists, habit tracking, and a fully configurable dashboard — designed for fast thoughts and daily discipline without breaking your flow. Built with Electron as a single-file app.

---

## Features

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

**Checklist Tab** (v1.1)
- Per-task priority flags (high/medium/low)
- Deadline assignment with calendar picker and overdue alerts
- Sort by date added or priority
- Clean list button to clear completed tasks

**Core**
- Floating always-on-top window
- Two categories: Professional and Personal (notes + checklist)
- Elastic overscroll with smooth bounce effect on all scrollable panels
- Custom themed scrollbars
- Stoic & existentialist quote rotation (60+ quotes)
- Onboarding with name and accent colour (purple, blue, green, pink, gold)
- Persistent storage across sessions

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

FloatNote is intentionally simple. One HTML file. No frameworks. No dependencies beyond Electron. If it starts to feel like a full note-taking platform, something has gone wrong.

---

## Contributing

Pull requests are welcome. Keep it lightweight and focused.

---

## License

MIT License
