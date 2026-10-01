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
  const TOMBSTONE_DAYS = 60;
  const DEFAULT_PREFS = { todayCap: 3, hotkey: 'Ctrl+Alt+Space', compact: false, launchAtLogin: false };

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
    for (const tok of s.split(/\s+/).filter(Boolean)) {
      const low = tok.toLowerCase();
      if (tok === '!') { toToday = true; continue; }
      if (low === '#p' || low === '#personal') { ctx = 'personal'; continue; }
      if (low === '#w' || low === '#work') { ctx = 'work'; continue; }
      const at = tok.match(/^@([^\s@]+?)([.,;:!?]*)$/);
      if (at && at[1]) {
        if (!who) who = at[1];
        words.push(at[1] + at[2]);
        continue;
      }
      words.push(tok);
    }
    if (words.length > 1) {
      const d = parseDateWord(words[words.length - 1], now);
      if (d) { due = d; words.pop(); }
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
    if (fields.suggested) item.suggested = true;
    return item;
  }

  function moveItem(item, list, now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (item.list !== list) {
      item.list = list;
      item.listAt = t;
      if (list !== 'today') item.carriedDays = 0;
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
    if (list === 'next' || list === 'later') items.sort(compareNext);
    else if (list === 'waiting') items.sort((a, b) => (a.listAt || 0) - (b.listAt || 0));
    else items.sort((a, b) => (isDone(a) - isDone(b)) || (a.listAt || 0) - (b.listAt || 0));
    return items;
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

  function ingestSuggestions(state, payload, now) {
    const arr = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.items) ? payload.items : []);
    const added = [];
    const existing = new Set(Object.values(state.items).filter(i => !isDone(i)).map(i => i.text.toLowerCase()));
    for (const raw of arr) {
      if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) continue;
      const text = raw.text.trim().slice(0, 500);
      if (existing.has(text.toLowerCase())) continue;
      const source = raw.source && typeof raw.source.url === 'string' && /^https?:\/\//.test(raw.source.url)
        ? { url: raw.source.url, label: typeof raw.source.label === 'string' ? raw.source.label : raw.source.url }
        : undefined;
      const item = makeItem({
        text,
        ctx: raw.ctx,
        list: raw.list === 'waiting' ? 'waiting' : 'next',
        due: raw.due,
        who: typeof raw.who === 'string' ? raw.who : undefined,
        note: typeof raw.note === 'string' ? raw.note : undefined,
        source,
        suggested: true
      }, now);
      state.items[item.id] = item;
      existing.add(text.toLowerCase());
      added.push(item.id);
    }
    return added;
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
    compareNext, listItems, openCount,
    completeItem, uncompleteItem, doneOn, streak,
    startDay, needsPick, carryOvers,
    ingestSuggestions,
    emptyState, normalizeState, isV1, migrateV1,
    toRecords, applyPath, applyPatch,
    stamp, toWire, wireValue, applyRemote, localIsNewer, newerThanRemote, purgeTombstones,
    encodeKey, decodeKey, pathToKey, keyToPath
  };
});
