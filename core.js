// FloatNote core: the pure logic, with no DOM and no Electron.
//
// Loaded by index.html (<script src="core.js"> → window.FNCore) and by main.js
// (require('./core')). Everything here is deterministic given its inputs, which
// is what lets `npm test` cover it. The UI stays in index.html.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FNCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const LISTS = ['today', 'next', 'waiting', 'later'];
  const CTXS = ['work', 'personal'];
  const STALE_DAYS = 14;
  const TRIAGE_THRESHOLD = 5;
  const DONE_RETENTION_DAYS = 30;
  const TOMBSTONE_DAYS = 365;
  const DEFAULT_PREFS = { todayCap: 3, hotkey: 'Ctrl+Alt+Space', compact: false, launchAtLogin: false, onTop: true };
  // What earns a suggestion (docs/INTAKE.md). Anything else arrives without a kind.
  const KINDS = ['promise', 'ask', 'waiting', 'deadline', 'blocked'];
  const SUGGESTION_DAYS = 3;   // a suggestion not kept within this expires
  const SLIDE_DAYS = 30;       // a Next item untouched this long slides to Later

  // ---------- dates (local calendar days as YYYY-MM-DD) ----------

  function pad(n) { return String(n).padStart(2, '0'); }

  function dateStr(d) {
    d = d instanceof Date ? d : new Date(d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function parseDateStr(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Whole calendar days from a to b (b - a). UTC arithmetic so DST never adds an hour.
  function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
  }

  function addDays(s, n) {
    const d = parseDateStr(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  // ---------- ids and hashing ----------

  function newId(prefix) {
    return (prefix || 'i') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // JSON with sorted keys and undefined dropped, so equal values always hash equal.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => x === undefined ? 'null' : stableStringify(x)).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  // FNV-1a, 32-bit. Change detection only, not security.
  function hash(v) {
    const s = stableStringify(v);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // ---------- capture syntax ----------
  //
  //   Send deck to @Anna fri #p !
  //   ~@Jens term sheet
  //
  // @who sets the person (the name stays in the text, without the @). A date word
  // counts only as the LAST token, so "monday meeting prep" has no due date.
  // #p / #personal → personal, #w / #work → work (default). "!" → Today.
  // A leading "~" → Waiting.

  const WEEKDAYS = [
    ['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'wednesday'],
    ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday']
  ];

  function parseDateWord(word, now) {
    const w = word.toLowerCase().replace(/[.,;]$/, '');
    const today = dateStr(now);
    if (w === 'today' || w === 'tod') return today;
    if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr' || w === 'tom') return addDays(today, 1);
    for (let i = 0; i < 7; i++) {
      if (WEEKDAYS[i].includes(w)) {
        // The named day, today included: "fri" said on a Friday means today.
        return addDays(today, (i - now.getDay() + 7) % 7);
      }
    }
    if (isDateStr(w)) return w;
    // European day/month, optional year: 12/10, 12/10/2026, 12/10/26.
    const m = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
    if (m) {
      const day = Number(m[1]), month = Number(m[2]);
      let year = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getFullYear();
      let s = year + '-' + pad(month) + '-' + pad(day);
      if (!isDateStr(s)) return null;
      // No year given and the date has passed: it means next year's.
      if (!m[3] && s < today) {
        s = (year + 1) + '-' + pad(month) + '-' + pad(day);
        if (!isDateStr(s)) return null;
      }
      return s;
    }
    return null;
  }

  function parseCapture(input, now) {
    now = now || new Date();
    let s = String(input || '').trim();
    let list = 'next';
    let ctx = 'work';
    let who;
    let due;
    if (s.startsWith('~')) { list = 'waiting'; s = s.slice(1).trim(); }
    let toToday = false;
    const words = [];
    const mention = []; // words[i] came from an @name
    for (const tok of s.split(/\s+/).filter(Boolean)) {
      const low = tok.toLowerCase();
      if (tok === '!') { toToday = true; continue; }
      if (tok === '~') { list = 'waiting'; continue; } // anywhere, like "!"
      if (low === '#p' || low === '#personal') { ctx = 'personal'; continue; }
      if (low === '#w' || low === '#work') { ctx = 'work'; continue; }
      const at = tok.match(/^@([^\s@]+?)([.,;:!?]*)$/);
      if (at && at[1]) {
        if (!who) who = at[1];
        words.push(at[1] + at[2]);
        mention.push(true);
        continue;
      }
      words.push(tok);
      mention.push(false);
    }
    // The date is the last word, not counting @names after it ("send deck
    // fri @Rui"). Only the end: "Review Friday notes" keeps its Friday.
    let j = words.length - 1;
    while (j >= 0 && mention[j]) j--;
    if (j >= 0 && words.length > 1) {
      const d = parseDateWord(words[j], now);
      if (d) { due = d; words.splice(j, 1); }
    }
    const text = words.join(' ').trim();
    if (!text) return null;
    if (toToday && list !== 'waiting') list = 'today';
    const out = { text, ctx, list };
    if (who) out.who = who;
    if (due) out.due = due;
    return out;
  }

  // ---------- items ----------

  function makeItem(fields, now) {
    const t = typeof now === 'number' ? now : (now || new Date()).getTime();
    const item = {
      id: fields.id || newId('i'),
      text: String(fields.text || '').trim(),
      ctx: CTXS.includes(fields.ctx) ? fields.ctx : 'work',
      list: LISTS.includes(fields.list) ? fields.list : 'next',
      createdAt: t,
      touchedAt: t,
      listAt: t,
      carriedDays: 0
    };
    if (fields.due && isDateStr(fields.due)) item.due = fields.due;
    if (fields.who) item.who = String(fields.who);
    if (fields.note) item.note = String(fields.note);
    if (fields.source && fields.source.url) item.source = { url: String(fields.source.url), label: String(fields.source.label || fields.source.url) };
    if (KINDS.includes(fields.kind)) item.kind = fields.kind;
    if (fields.suggested) { item.suggested = true; item.origin = 'suggested'; }
    return item;
  }

  function moveItem(item, list, now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (item.list !== list) {
      item.list = list;
      item.listAt = t;
      if (list !== 'today') item.carriedDays = 0;
      delete item.replied;
    }
    item.touchedAt = t;
    return item;
  }

  function isDone(item) { return typeof item.doneAt === 'number'; }

  // Done items stay visible for the rest of the day they were finished on.
  function isVisible(item, today) {
    return !isDone(item) || dateStr(item.doneAt) === today;
  }

  function isStale(item, now, days) {
    const t = typeof now === 'number' ? now : now.getTime();
    return item.list === 'next' && !isDone(item) && !item.suggested &&
      t - (item.touchedAt || item.createdAt || 0) >= (days || STALE_DAYS) * DAY_MS;
  }

  function staleItems(state, now, days) {
    return Object.values(state.items).filter(i => isStale(i, now, days))
      .sort((a, b) => (a.touchedAt || 0) - (b.touchedAt || 0));
  }

  function needsTriage(state, now) {
    return staleItems(state, now).length >= TRIAGE_THRESHOLD;
  }

  // Next: dated first (soonest first), then undated, newest first.
  function compareNext(a, b) {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : (b.createdAt || 0) - (a.createdAt || 0);
    if (a.due) return -1;
    if (b.due) return 1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  }

  function listItems(state, list, opts) {
    opts = opts || {};
    const today = opts.today || dateStr(new Date());
    let items = Object.values(state.items).filter(i =>
      i.list === list && isVisible(i, today) && (!opts.ctx || i.ctx === opts.ctx) &&
      (opts.suggested === undefined || !!i.suggested === opts.suggested));
    // Every list sinks the items finished today below the open ones.
    const byList = (list === 'next' || list === 'later') ? compareNext
      : (a, b) => (a.listAt || 0) - (b.listAt || 0);
    items.sort((a, b) => (isDone(a) - isDone(b)) || byList(a, b));
    return items;
  }

  function todayCapOf(state) {
    const n = Math.round(Number(state.preferences && state.preferences.todayCap));
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : DEFAULT_PREFS.todayCap;
  }

  function openCount(state, list) {
    return Object.values(state.items).filter(i => i.list === list && !isDone(i)).length;
  }

  // ---------- completions, done-today, streak ----------

  function completeItem(state, id, now) {
    const item = state.items[id];
    if (!item || isDone(item)) return;
    const t = typeof now === 'number' ? now : Date.now();
    item.doneAt = t;
    item.touchedAt = t;
    delete item.suggested;
    delete item.closeHint;
    delete item.replied;
    state.completions['c_' + id] = { date: dateStr(t), ctx: item.ctx, text: item.text };
  }

  function uncompleteItem(state, id, now) {
    const item = state.items[id];
    if (!item || !isDone(item)) return;
    delete item.doneAt;
    item.touchedAt = typeof now === 'number' ? now : Date.now();
    delete state.completions['c_' + id];
  }

  function doneOn(state, date) {
    return Object.values(state.completions).filter(c => c.date === date).length;
  }

  // Consecutive days with at least one completion, ending today, or ending
  // yesterday when nothing is done yet today (the streak is not broken until
  // the day is over).
  function streak(state, today) {
    const days = new Set(Object.values(state.completions).map(c => c.date));
    let d = days.has(today) ? today : addDays(today, -1);
    let n = 0;
    while (days.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  // ---------- the day boundary ----------

  // Runs once per calendar day, on the first load or focus of that day.
  // Unfinished Today items gain a carried day, done items older than the
  // retention window are removed (their completion records stay, so the streak
  // survives). Returns true when anything changed.
  function startDay(state, now) {
    const today = dateStr(now);
    const last = state.meta.lastDay;
    if (last === today) return false;
    if (last) {
      for (const item of Object.values(state.items)) {
        if (item.list === 'today' && !isDone(item)) item.carriedDays = (item.carriedDays || 0) + 1;
      }
    }
    const cutoff = (typeof now === 'number' ? now : now.getTime()) - DONE_RETENTION_DAYS * DAY_MS;
    for (const id of Object.keys(state.items)) {
      if (isDone(state.items[id]) && state.items[id].doneAt < cutoff) delete state.items[id];
    }
    state.meta.lastDay = today;
    return true;
  }

  function needsPick(state, now) {
    return state.meta.lastPick !== dateStr(now);
  }

  function carryOvers(state) {
    return Object.values(state.items).filter(i => i.list === 'today' && !isDone(i))
      .sort((a, b) => (b.carriedDays || 0) - (a.carriedDays || 0));
  }

  // ---------- Claude drop-folder suggestions ----------
  //
  // Claude writes JSON files into <data dir>/inbox/; main reads each one with
  // ingestInbox. Three kinds of entry:
  //   { text, kind?, who?, due?, ctx?, list?: 'next'|'waiting', note?, source?: {url,label}, key? }
  //     → a suggested item, reviewed in the morning pick, kept or dropped.
  //   { done: '<item id>', why, source? }
  //     → a close hint on an open item ("looks done: <why>"), Done or Not yet.
  //   { replied: '<item id>', why, source? }
  //     → a Waiting item got its answer: it comes back to Next, marked replied.
  // The payload is an array of entries, or { items: [...], done: [...], replied: [...] }.
  //
  // seen (key → { t }) remembers every suggestion ever taken in, so a second
  // sweep of the same mail does not bring back what was already kept or dropped.

  function cleanSource(src) {
    return src && typeof src.url === 'string' && /^https?:\/\//i.test(src.url)
      ? { url: src.url.slice(0, 2000), label: (typeof src.label === 'string' && src.label.trim() ? src.label.trim() : src.url).slice(0, 200) }
      : undefined;
  }

  function normText(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' '); }

  function suggestionKey(raw) {
    if (typeof raw.key === 'string' && raw.key.trim()) return 'k:' + raw.key.trim().slice(0, 200);
    const src = cleanSource(raw.source);
    return (src ? src.url + '|' : '') + normText(raw.text);
  }

  function inboxEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const arr = k => Array.isArray(payload[k]) ? payload[k] : [];
    return [].concat(arr('items'), arr('done'), arr('replied'));
  }

  // A collector run reports itself with { run: {...} } next to its entries, so
  // a run that found nothing, or failed, still shows. Bounded and typed here;
  // anything else in it is dropped.
  function cleanRun(raw, t) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const str = (v, n) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined;
    const num = v => typeof v === 'number' && isFinite(v) && v >= 0 ? v : undefined;
    const at = typeof raw.at === 'number' ? raw.at : typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
    const run = { at: isFinite(at) ? at : t };
    if (str(raw.id, 60)) run.id = str(raw.id, 60);
    if (raw.scheduled === true) run.scheduled = true;
    if (Array.isArray(raw.sources)) {
      const s = raw.sources.map(v => str(v, 40)).filter(Boolean).slice(0, 10);
      if (s.length) run.sources = s;
    }
    for (const k of ['added', 'hints', 'replied']) if (num(raw[k]) !== undefined) run[k] = Math.floor(raw[k]);
    if (num(raw.costUsd) !== undefined) run.costUsd = Math.round(raw.costUsd * 10000) / 10000;
    if (Array.isArray(raw.errors)) {
      const e = raw.errors.map(v => str(v, 200)).filter(Boolean).slice(0, 5);
      if (e.length) run.errors = e;
    }
    return run;
  }

  // The same run can report twice: the skill with its findings, then the
  // scheduler with cost and exit code. Same id: merged, counts added up.
  // Otherwise the newer run wins. counts, when given, are what the app itself
  // took in from the run's file, and replace whatever the file claimed.
  function recordRun(state, raw, t, counts) {
    const run = cleanRun(raw, t);
    if (!run) return false;
    if (counts) Object.assign(run, counts);
    state.meta = state.meta || {};
    const prev = state.meta.lastRun;
    if (prev && run.id && prev.id === run.id) {
      // The earliest at: the scheduler's start time beats the skill's file time.
      const merged = Object.assign({}, prev, run, { at: Math.min(prev.at, run.at) });
      for (const k of ['added', 'hints', 'replied']) {
        if (prev[k] !== undefined || run[k] !== undefined) merged[k] = (prev[k] || 0) + (run[k] || 0);
      }
      const errors = (prev.errors || []).concat(run.errors || []).slice(0, 5);
      if (errors.length) merged.errors = errors;
      state.meta.lastRun = merged;
    } else if (!prev || !(prev.at > run.at)) state.meta.lastRun = run;
    else return false;
    return true;
  }

  const RUN_DUE_MINUTES = 8 * 60 + 30;   // a scheduled run not seen by 08:30 is missing

  function hhmm(ms) { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // One line about the collector, or null. 'warn' is shown wherever Daniel
  // looks; 'ok' only in the morning pick. "Missing" applies only once a
  // scheduled run has been seen in the last two weeks, on weekdays, after 08:30.
  function runStatus(state, now) {
    const run = state.meta && state.meta.lastRun;
    if (!run || typeof run.at !== 'number') return null;
    const d = now instanceof Date ? now : new Date(now);
    if (dateStr(run.at) === dateStr(d)) {
      if (run.errors && run.errors.length) {
        return { level: 'warn', text: 'Claude’s check at ' + hhmm(run.at) + ' had a problem: ' + run.errors[0] };
      }
      // The skill always names its sources. A run without them is the scheduler
      // reporting a run whose skill never wrote back: that is not "nothing new".
      if (!run.sources || !run.sources.length) {
        return { level: 'warn', text: 'Claude’s check at ' + hhmm(run.at) + ' did not report what it found. See collector-logs.' };
      }
      const parts = [];
      if (run.added) parts.push(run.added + ' new');
      if (run.hints) parts.push(run.hints + (run.hints === 1 ? ' looks done' : ' look done'));
      if (run.replied) parts.push(run.replied + ' replied');
      return { level: 'ok', text: 'Claude checked ' + run.sources.join(' and ') + ' at ' + hhmm(run.at) + ': ' + (parts.length ? parts.join(', ') : 'nothing new') + '.' };
    }
    const day = d.getDay();
    if (run.scheduled && day >= 1 && day <= 5 && d.getHours() * 60 + d.getMinutes() >= RUN_DUE_MINUTES &&
      d.getTime() - run.at < 14 * DAY_MS) {
      const last = new Date(run.at);
      return { level: 'warn', text: 'Claude’s morning check has not run today. Last run ' +
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][last.getDay()] + ' ' + last.getDate() + ' ' +
        ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][last.getMonth()] +
        ' at ' + hhmm(run.at) + '.' };
    }
    return null;
  }

  function ingestInbox(state, payload, now, seen) {
    const t = typeof now === 'number' ? now : (now || new Date()).getTime();
    seen = seen || {};
    const out = { added: [], direct: [], hinted: [], replied: [], skipped: [], run: false };
    const skip = (raw, reason) => out.skipped.push({ text: raw && typeof raw === 'object' ? String(raw.text || raw.done || raw.replied || '').slice(0, 80) : '', reason });
    const open = Object.values(state.items).filter(i => !isDone(i));
    const existing = new Set(open.map(i => normText(i.text)));
    for (const raw of inboxEntries(payload)) {
      if (!raw || typeof raw !== 'object') { skip(raw, 'not an object'); continue; }

      if (typeof raw.done === 'string') {
        const item = state.items[raw.done];
        const why = typeof raw.why === 'string' ? raw.why.trim().slice(0, 300) : '';
        if (!item || item.deleted) { skip(raw, 'no such item'); continue; }
        if (isDone(item)) { skip(raw, 'already done'); continue; }
        if (!why) { skip(raw, 'a done hint needs a why'); continue; }
        const source = cleanSource(raw.source);
        const key = 'done:' + raw.done + '|' + (source ? source.url : normText(why));
        if (seen[key]) { skip(raw, 'already hinted'); continue; }
        seen[key] = { t };
        item.closeHint = { why, at: t };
        if (source) item.closeHint.source = source;
        out.hinted.push(item.id);
        continue;
      }

      if (typeof raw.replied === 'string') {
        const item = state.items[raw.replied];
        const why = typeof raw.why === 'string' ? raw.why.trim().slice(0, 300) : '';
        if (!item) { skip(raw, 'no such item'); continue; }
        if (isDone(item)) { skip(raw, 'already done'); continue; }
        if (item.list !== 'waiting') { skip(raw, 'not waiting'); continue; }
        if (!why) { skip(raw, 'a reply needs a why'); continue; }
        const source = cleanSource(raw.source);
        const key = 'replied:' + raw.replied + '|' + (source ? source.url : normText(why));
        if (seen[key]) { skip(raw, 'already marked replied'); continue; }
        seen[key] = { t };
        moveItem(item, 'next', t);
        item.replied = { why, at: t };
        if (source) item.replied.source = source;
        out.replied.push(item.id);
        continue;
      }

      if (typeof raw.text !== 'string' || !raw.text.trim()) { skip(raw, 'no text'); continue; }
      const text = raw.text.trim().replace(/\s+/g, ' ').slice(0, 500);
      const key = suggestionKey(raw);
      if (seen[key]) { skip(raw, 'already suggested before'); continue; }
      if (existing.has(normText(text))) { skip(raw, 'already on a list'); seen[key] = { t }; continue; }
      // direct: Daniel asked for this item himself ("add X to FloatNote"), so it
      // goes straight onto its list. Anything Claude found on its own is a
      // suggestion, and only Next or Waiting. Today is honoured while it has room.
      const direct = raw.direct === true;
      const kind = KINDS.includes(raw.kind) ? raw.kind : undefined;
      let list = raw.list === 'waiting' || (raw.list === undefined && kind === 'waiting') ? 'waiting' : 'next';
      if (direct && raw.list === 'later') list = 'later';
      if (direct && raw.list === 'today' && openCount(state, 'today') < todayCapOf(state)) list = 'today';
      const item = makeItem({
        text,
        ctx: raw.ctx,
        list,
        due: raw.due,
        who: typeof raw.who === 'string' && raw.who.trim() ? raw.who.trim().slice(0, 80) : undefined,
        note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 1000) : undefined,
        source: cleanSource(raw.source),
        kind,
        suggested: !direct
      }, t);
      state.items[item.id] = item;
      existing.add(normText(text));
      seen[key] = { t };
      out.added.push(item.id);
      if (direct) out.direct.push(item.id);
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.run !== undefined) {
      const counts = { added: out.added.length - out.direct.length, hints: out.hinted.length, replied: out.replied.length };
      out.run = recordRun(state, payload.run, t, counts);
      if (!out.run) out.skipped.push({ text: '', reason: 'run: not an object, or older than the last one' });
    }
    return out;
  }

  // Forget suggestion keys older than this, so the seen file cannot grow forever.
  function pruneSeen(seen, now, days) {
    const cutoff = now - (days || 180) * DAY_MS;
    for (const k of Object.keys(seen)) if (!seen[k] || !(seen[k].t >= cutoff)) delete seen[k];
    return seen;
  }

  // The suggestions alone, with nothing remembered between calls.
  function ingestSuggestions(state, payload, now) {
    return ingestInbox(state, payload, now, {}).added;
  }

  // ---------- nothing rots (docs/INTAKE.md) ----------

  // Open suggestions, in the order they arrived (the collector writes best first).
  function pendingSuggestions(state) {
    return Object.values(state.items).filter(i => i.suggested && !isDone(i))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  // A suggestion not kept within SUGGESTION_DAYS goes. The seen file keeps it
  // from coming back. Returns copies of what expired, for the decisions log.
  function expireSuggestions(state, now, days) {
    const t = typeof now === 'number' ? now : now.getTime();
    const gone = [];
    for (const item of pendingSuggestions(state)) {
      if (t - (item.createdAt || 0) >= (days || SUGGESTION_DAYS) * DAY_MS) {
        gone.push(clone(item));
        delete state.items[item.id];
      }
    }
    return gone;
  }

  // A Next item untouched for SLIDE_DAYS slides to Later. meta.slid counts
  // them until the first pick of a new week reports the number.
  function slideToLater(state, now, days) {
    const t = typeof now === 'number' ? now : now.getTime();
    const moved = [];
    for (const item of Object.values(state.items)) {
      if (item.list !== 'next' || isDone(item) || item.suggested) continue;
      if (t - (item.touchedAt || item.createdAt || 0) < (days || SLIDE_DAYS) * DAY_MS) continue;
      moveItem(item, 'later', t);
      moved.push(item.id);
    }
    if (moved.length) state.meta.slid = (Number(state.meta.slid) || 0) + moved.length;
    return moved;
  }

  // The Monday on or before a YYYY-MM-DD.
  function weekStart(s) {
    const d = parseDateStr(s);
    return addDays(s, -((d.getDay() + 6) % 7));
  }

  // How many items slid to Later, to report in this pick: only in the first
  // pick of a week, so it reads as a weekly line rather than a daily nag.
  function slidToReport(state, now) {
    const n = Number(state.meta.slid) || 0;
    if (!n) return 0;
    const last = state.meta.lastPick;
    return !isDateStr(last) || weekStart(last) < weekStart(dateStr(now)) ? n : 0;
  }

  // ---------- the decisions log ----------
  //
  // One line per decision on something the collector brought in, appended to
  // <data dir>/decisions.log by main, read by the collector so it learns
  // (docs/INTAKE.md rule 6). d: keep | drop | done | expired | notyet.
  const DECISIONS = ['keep', 'drop', 'done', 'expired', 'notyet'];

  function fromCollector(item) {
    return !!item && (item.origin === 'suggested' || !!item.suggested);
  }

  function decisionEntry(item, d, now, extra) {
    const t = typeof now === 'number' ? now : now.getTime();
    const e = { t, date: dateStr(t), d, id: item.id, text: item.text, list: item.list };
    if (item.kind) e.kind = item.kind;
    if (item.who) e.who = item.who;
    if (item.source) e.source = clone(item.source);
    if (extra) Object.assign(e, extra);
    return e;
  }

  // ---------- state shape and migration ----------

  function emptyState() {
    return {
      schemaVersion: 2,
      items: {},
      completions: {},
      notes: { professional: '', personal: '' },
      habits: [],
      habitLog: {},
      meta: {},
      preferences: Object.assign({}, DEFAULT_PREFS)
    };
  }

  function normalizeState(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    const out = Object.assign(base, s);
    out.schemaVersion = 2;
    out.items = s.items && typeof s.items === 'object' ? s.items : {};
    out.completions = s.completions && typeof s.completions === 'object' ? s.completions : {};
    out.notes = Object.assign({ professional: '', personal: '' }, s.notes || {});
    out.habits = Array.isArray(s.habits) ? s.habits : [];
    out.habitLog = s.habitLog && typeof s.habitLog === 'object' ? s.habitLog : {};
    out.meta = s.meta && typeof s.meta === 'object' ? s.meta : {};
    out.preferences = Object.assign({}, DEFAULT_PREFS, s.preferences || {});
    return out;
  }

  // What a launch loads, and whether the clock that goes with it can be trusted.
  //   data    the parsed data file (undefined when unreadable)
  //   exists  whether the data file is on disk
  //   clock   parseClockFile of the clock file, or null when missing or corrupt
  //   v2Ran   v2 has run in this data dir (a clock file or the v1 copy is there)
  //   backup  () → the newest readable v2 backup, or undefined
  // source: read | setAside | fresh | recovered. setAside: a v1 file on the first
  // v2 launch; it is copied aside and v2 starts empty (docs/INTAKE.md, "Fresh
  // start"), keeping only its preferences. suspect means the state may be
  // older or smaller than what was last synced, so the clock must not stamp it
  // as new (see recoverClock). keepCopy: set the bad data file aside first.
  function planLoad(o) {
    const usable = o.data !== null && typeof o.data === 'object';
    const unreadable = o.exists && !usable;
    // A v1-shaped file after v2 has run is a restore or a v1 copy writing it;
    // migrating it again would wipe the v2 state on every device.
    const stale = usable && isV1(o.data) && o.v2Ran;
    const gone = !o.exists && o.v2Ran;
    if (unreadable || stale || gone) {
      return { source: 'recovered', raw: o.backup(), suspect: true, keepCopy: o.exists };
    }
    if (!usable) return { source: 'fresh', raw: undefined, suspect: false, keepCopy: false };
    if (isV1(o.data)) return { source: 'setAside', raw: freshFromV1(o.data), suspect: false, keepCopy: false };
    return { source: 'read', raw: o.data, suspect: !o.clock, keepCopy: false };
  }

  // An empty v2 state that keeps a v1 file's preferences (name, theme, Today
  // size) and nothing else. migrateV1 stays for bringing things back by hand.
  function freshFromV1(data) {
    const out = emptyState();
    const prefs = data && !Array.isArray(data) && data.preferences && typeof data.preferences === 'object' ? data.preferences : {};
    out.preferences = Object.assign({}, DEFAULT_PREFS, prefs);
    return out;
  }

  function isV1(data) {
    return !!data && (Array.isArray(data) || (typeof data === 'object' && data.schemaVersion !== 2));
  }

  function v1Time(addedAt, fallback) {
    if (isDateStr(addedAt)) return parseDateStr(addedAt).getTime();
    return fallback;
  }

  // v1 → v2. Item ids are derived from content, not random, so two devices
  // migrating the same synced v1 data produce the same ids and never duplicate.
  // touchedAt is the original add date, so an old backlog shows up as stale and
  // gets triaged on first run instead of silently becoming "Next".
  function migrateV1(data, now) {
    const t = typeof now === 'number' ? now : (now || new Date()).getTime();
    let v1 = data;
    if (Array.isArray(v1)) v1 = { checklist: { professional: v1, personal: [] } };
    v1 = v1 || {};
    const out = emptyState();

    const notes = v1.notes;
    if (typeof notes === 'string') out.notes.professional = notes;
    else if (notes && typeof notes === 'object') {
      out.notes.professional = typeof notes.professional === 'string' ? notes.professional : '';
      out.notes.personal = typeof notes.personal === 'string' ? notes.personal : '';
    }

    let checklist = v1.checklist || {};
    if (Array.isArray(checklist)) checklist = { professional: checklist, personal: [] };
    const seen = {};
    for (const cat of ['professional', 'personal']) {
      const arr = Array.isArray(checklist[cat]) ? checklist[cat] : [];
      for (const old of arr) {
        if (!old || typeof old.text !== 'string' || !old.text.trim()) continue;
        let id = 'm_' + hash([cat, old.text, old.addedAt || '']);
        seen[id] = (seen[id] || 0) + 1;
        if (seen[id] > 1) id += '_' + seen[id];
        const created = v1Time(old.addedAt, t);
        const item = {
          id,
          text: old.text.trim(),
          ctx: cat === 'personal' ? 'personal' : 'work',
          list: 'next',
          createdAt: created,
          touchedAt: created,
          listAt: created,
          carriedDays: 0
        };
        if (isDateStr(old.deadline)) item.due = old.deadline;
        if (old.done === true) item.doneAt = typeof old.doneAt === 'number' ? old.doneAt : t;
        out.items[id] = item;
      }
    }

    const log = Array.isArray(v1.completionLog) ? v1.completionLog : [];
    log.forEach((e, n) => {
      if (!e || !isDateStr(e.date)) return;
      out.completions['c_v1_' + n] = { date: e.date, ctx: e.category === 'personal' ? 'personal' : 'work' };
    });

    if (Array.isArray(v1.habits)) out.habits = clone(v1.habits);
    if (v1.habitLog && typeof v1.habitLog === 'object') out.habitLog = clone(v1.habitLog);
    out.preferences = Object.assign({}, DEFAULT_PREFS, v1.preferences || {});
    return out;
  }

  // ---------- records: the unit of sync ----------
  //
  // The whole synced state flattened into path → value. Preferences are local to
  // a device and are not records. Paths:
  //   items/<id>  completions/<id>  notes/<professional|personal>  habits/<id>
  //   habitLog/<key>  meta/<key>

  function toRecords(state) {
    const r = {};
    for (const [id, it] of Object.entries(state.items || {})) r['items/' + id] = it;
    for (const [id, c] of Object.entries(state.completions || {})) r['completions/' + id] = c;
    for (const cat of ['professional', 'personal']) r['notes/' + cat] = { html: (state.notes && state.notes[cat]) || '' };
    for (const h of state.habits || []) if (h && h.id) r['habits/' + h.id] = h;
    for (const [k, v] of Object.entries(state.habitLog || {})) r['habitLog/' + k] = { v };
    for (const [k, v] of Object.entries(state.meta || {})) if (v !== undefined) r['meta/' + k] = { v };
    return r;
  }

  function splitPath(path) {
    const i = path.indexOf('/');
    return [path.slice(0, i), path.slice(i + 1)];
  }

  function sortHabits(habits) {
    return habits.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  }

  // Set (value) or remove (value === null) one record in a state object.
  function applyPath(state, path, value) {
    const [kind, key] = splitPath(path);
    const del = value === null || value === undefined;
    switch (kind) {
      case 'items': case 'completions':
        if (del) delete state[kind][key]; else state[kind][key] = clone(value);
        break;
      case 'notes':
        state.notes[key] = del ? '' : (value.html || '');
        break;
      case 'habits': {
        const idx = state.habits.findIndex(h => h.id === key);
        if (del) { if (idx >= 0) state.habits.splice(idx, 1); }
        else if (idx >= 0) state.habits[idx] = clone(value);
        else { state.habits.push(clone(value)); sortHabits(state.habits); }
        break;
      }
      case 'habitLog': case 'meta':
        if (del) delete state[kind][key]; else state[kind][key] = value.v;
        break;
    }
    return state;
  }

  function applyPatch(state, patch) {
    for (const [path, value] of Object.entries(patch)) applyPath(state, path, value);
    return state;
  }

  // path → hash of each record in paths that exists in state.
  function recordHashes(state, paths) {
    const recs = toRecords(state);
    const out = {};
    for (const path of paths) if (path in recs) out[path] = hash(recs[path]);
    return out;
  }

  // Apply each record only if state still holds what main held before the
  // patch (before = recordHashes of main's state, absent = no record). The
  // renderer saves 300ms after an edit, so a remote change can reach main
  // while an edit is unsaved or its save is in flight. Such a record no
  // longer matches and is left alone: the edit is newer, and its save stamps
  // and pushes it. Returns the applied paths.
  function applyPatchIfUnchanged(state, patch, before) {
    const cur = toRecords(state);
    const applied = [];
    for (const [path, value] of Object.entries(patch)) {
      const local = path in cur ? hash(cur[path]) : null;
      const was = before && path in before ? before[path] : null;
      if (local !== was) continue;
      applyPath(state, path, value);
      applied.push(path);
    }
    return applied;
  }

  // One save from the page, in whatever holds the clock (main.js on the desktop,
  // web-api.js in the browser). unseen: [{ seq, patch, before }], the remote
  // patches sent to the page; seenSeq is the last one it had applied when it
  // saved. Any patch after that is re-applied first, so a save already in flight
  // when a remote change arrived cannot stamp the old value as newer and push it
  // back; only onto records the page left as they were before the patch, since
  // one it changed is a newer local edit. The caller stamps once the state is
  // stored. Returns { state, unseen }: the patches still newer than the page.
  function commitSave(data, seenSeq, unseen) {
    const state = normalizeState(data);
    let left = unseen || [];
    if (typeof seenSeq === 'number') {
      left = left.filter(e => e.seq > seenSeq);
      for (const e of left) applyPatchIfUnchanged(state, e.patch, e.before);
    }
    return { state, unseen: left };
  }

  // ---------- clock: per-record timestamps without touching the UI code ----------
  //
  // clock: { path → { h: hash, t: ms, d?: true } }. The renderer saves whole
  // state; stamp() works out which records changed since the last save and gives
  // them a new timestamp. A record that vanished becomes a tombstone, which is
  // how deletes and unticks propagate instead of being resurrected by a merge.
  // A new t is always greater than the previous t for that path, so a local edit
  // made after seeing a remote value beats that value even across clock skew.

  function stamp(clock, records, now) {
    const changed = [];
    for (const [path, value] of Object.entries(records)) {
      const h = hash(value);
      const prev = clock[path];
      if (!prev || prev.d || prev.h !== h) {
        clock[path] = { h, t: Math.max(now, prev ? prev.t + 1 : 0) };
        changed.push(path);
      }
    }
    for (const path of Object.keys(clock)) {
      if (!(path in records) && !clock[path].d) {
        clock[path] = { h: null, t: Math.max(now, clock[path].t + 1), d: true };
        changed.push(path);
      }
    }
    return changed;
  }

  // The clock for a state that is suspect (recovered from a backup or empty, or
  // loaded without its clock). Nothing is stamped as new and nothing becomes a
  // tombstone: a record the clock knows with the same content keeps its time, any
  // other gets t 0 so every remote version beats it (a local-only record is
  // still pushed, as the remote has none), and a clock entry for a record the
  // state lacks is dropped, so the remote copy comes back instead of being deleted.
  function recoverClock(clock, records) {
    for (const [path, value] of Object.entries(records)) {
      const prev = clock[path];
      const h = hash(value);
      if (prev && !prev.d && prev.h === h) continue;
      clock[path] = { h, t: 0 };
    }
    for (const path of Object.keys(clock)) {
      if (!(path in records) && !clock[path].d) delete clock[path];
    }
  }

  // The clock file holds the clock and the time of the last successful sync (it
  // decides whether this device is dormant, see adoptRemoteWhenDormant). The
  // first version was the bare clock, which has no "clock" key (paths hold a "/").
  function parseClockFile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.clock && typeof raw.clock === 'object') {
      return { clock: raw.clock, lastSync: typeof raw.lastSync === 'number' ? raw.lastSync : null };
    }
    return { clock: raw, lastSync: null };
  }

  function clockFile(clock, lastSync) {
    return { clock, lastSync: typeof lastSync === 'number' ? lastSync : null };
  }

  // A device that last synced longer ago than tombstones are kept cannot tell
  // "never reached the server" from "deleted, and the tombstone has been purged".
  // For the records it has not touched since that sync (t at or before it) the
  // server is right, so a record missing there is dropped locally instead of
  // being pushed back. Returns the dropped paths; the caller removes them from
  // its state. synced(path) limits it to the kinds this device syncs.
  function adoptRemoteWhenDormant(clock, remote, lastSync, now, synced) {
    if (typeof lastSync !== 'number' || now - lastSync <= TOMBSTONE_DAYS * DAY_MS) return [];
    const dropped = [];
    for (const [path, c] of Object.entries(clock)) {
      if (c.d || path in remote || c.t > lastSync || (synced && !synced(path))) continue;
      delete clock[path];
      dropped.push(path);
    }
    return dropped;
  }

  // The wire format for one record: { j: JSON text, t } or a tombstone
  // { t, d: true }. The value travels as a string because Firebase silently
  // drops empty strings and empty objects and turns arrays into maps.
  function toWire(clock, records, path) {
    const c = clock[path];
    if (!c) return null;
    if (c.d) return { t: c.t, d: true };
    if (!(path in records)) return null;
    return { j: JSON.stringify(records[path]), t: c.t };
  }

  function wireValue(wire) {
    if (!wire || typeof wire.j !== 'string') return undefined;
    try { return JSON.parse(wire.j); } catch (e) { return undefined; }
  }

  // Decide one incoming record. Returns { path, value } to apply (value null =
  // remove) or null when the local copy is as new or newer. Strictly-greater t
  // wins, so our own writes echoing back are no-ops.
  function applyRemote(clock, path, wire) {
    if (!wire || typeof wire.t !== 'number') return null;
    const local = clock[path];
    if (local && wire.t <= local.t) return null;
    if (wire.d) {
      clock[path] = { h: null, t: wire.t, d: true };
      return { path, value: null };
    }
    const v = wireValue(wire);
    if (v === undefined || v === null) return null;
    clock[path] = { h: hash(v), t: wire.t };
    return { path, value: v };
  }

  // The server keeps whichever write arrived last, not whichever is newest. So
  // when an incoming record is OLDER than ours, the caller re-pushes ours; that
  // is what makes the server converge on the newest value.
  function localIsNewer(clock, path, wire) {
    const local = clock[path];
    return !!local && (!wire || typeof wire.t !== 'number' || local.t > wire.t);
  }

  // Paths whose local copy is newer than what the remote snapshot holds.
  function newerThanRemote(clock, remote) {
    const out = [];
    for (const [path, c] of Object.entries(clock)) {
      const r = remote[path];
      if (!r || typeof r.t !== 'number' || c.t > r.t) out.push(path);
    }
    return out;
  }

  function purgeTombstones(clock, now, days) {
    const cutoff = now - (days || TOMBSTONE_DAYS) * DAY_MS;
    const purged = [];
    for (const [path, c] of Object.entries(clock)) {
      if (c.d && c.t < cutoff) { delete clock[path]; purged.push(path); }
    }
    return purged;
  }

  // Firebase keys may not contain . # $ [ ] / — percent-encode those (and %).
  function encodeKey(k) {
    return String(k).replace(/[%.#$\[\]\/]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }
  function decodeKey(k) {
    return String(k).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function pathToKey(path) {
    const [kind, key] = splitPath(path);
    return kind + '/' + encodeKey(key);
  }
  function keyToPath(kind, key) {
    return kind + '/' + decodeKey(key);
  }

  const RECORD_KINDS = ['items', 'completions', 'notes', 'habits', 'habitLog', 'meta'];

  return {
    DAY_MS, LISTS, CTXS, STALE_DAYS, TRIAGE_THRESHOLD, DEFAULT_PREFS, RECORD_KINDS,
    dateStr, isDateStr, parseDateStr, daysBetween, addDays,
    newId, stableStringify, hash, clone,
    parseDateWord, parseCapture,
    makeItem, moveItem, isDone, isVisible, isStale, staleItems, needsTriage,
    compareNext, listItems, openCount, todayCapOf,
    completeItem, uncompleteItem, doneOn, streak,
    startDay, needsPick, carryOvers,
    ingestSuggestions, ingestInbox, suggestionKey, pruneSeen, recordRun, runStatus,
    KINDS, SUGGESTION_DAYS, SLIDE_DAYS, DECISIONS,
    pendingSuggestions, expireSuggestions, slideToLater, weekStart, slidToReport, fromCollector, decisionEntry,
    emptyState, normalizeState, isV1, migrateV1, freshFromV1,
    toRecords, applyPath, applyPatch, recordHashes, applyPatchIfUnchanged, commitSave,
    planLoad, stamp, recoverClock, parseClockFile, clockFile, adoptRemoteWhenDormant, TOMBSTONE_DAYS, toWire, wireValue, applyRemote, localIsNewer, newerThanRemote, purgeTombstones,
    encodeKey, decodeKey, pathToKey, keyToPath
  };
});
