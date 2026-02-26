# FloatNote

A lightweight floating desktop notepad that stays out of your way — until you need it.

FloatNote is a minimal scratchpad designed for fast thoughts, reminders, and fragments of ideas without breaking your flow. Built with Electron as a single-file app.

---

## Features

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
- Dashboard with completion stats and productivity chart (daily/cumulative)
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
