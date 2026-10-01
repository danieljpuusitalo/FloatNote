// Tests for core.js. Every fixture here is invented; none of it is real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core');

// Thursday 1 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 1, 10, 0, 0);
const T = NOW.getTime();
const DAY = C.DAY_MS;

// ---------- capture parsing ----------

test('capture: plain text defaults to work / next', () => {
  assert.deepEqual(C.parseCapture('Buy printer paper', NOW), { text: 'Buy printer paper', ctx: 'work', list: 'next' });
});

test('capture: every token together', () => {
  assert.deepEqual(C.parseCapture('Send deck to @Anna fri #p !', NOW), {
    text: 'Send deck to Anna', ctx: 'personal', list: 'today', who: 'Anna', due: '2026-10-02'
  });
});

test('capture: ~ prefix means waiting, and beats !', () => {
  assert.deepEqual(C.parseCapture('~@Jens term sheet', NOW), { text: 'Jens term sheet', ctx: 'work', list: 'waiting', who: 'Jens' });
  assert.equal(C.parseCapture('~ @Jens reply !', NOW).list, 'waiting');
});

test('capture: a date word only counts as the last token', () => {
  const r = C.parseCapture('monday meeting prep', NOW);
  assert.equal(r.due, undefined);
  assert.equal(r.text, 'monday meeting prep');
});

test('capture: a lone date word is text, not an empty item', () => {
  assert.deepEqual(C.parseCapture('tmrw', NOW), { text: 'tmrw', ctx: 'work', list: 'next' });
});

test('capture: relative and weekday dates', () => {
  assert.equal(C.parseCapture('email accountant today', NOW).due, '2026-10-01');
  assert.equal(C.parseCapture('email accountant tmrw', NOW).due, '2026-10-02');
  assert.equal(C.parseCapture('email accountant tomorrow', NOW).due, '2026-10-02');
  assert.equal(C.parseCapture('call bank thu', NOW).due, '2026-10-01', 'the named weekday on that weekday is today');
  assert.equal(C.parseCapture('pay rent mon', NOW).due, '2026-10-05');
  assert.equal(C.parseCapture('pay rent Wednesday', NOW).due, '2026-10-07');
});

test('capture: European day/month, ISO, and roll-over', () => {
  assert.equal(C.parseCapture('renew passport 12/10', NOW).due, '2026-10-12');
  assert.equal(C.parseCapture('file taxes 5/1', NOW).due, '2027-01-05', 'a passed d/m means next year');
  assert.equal(C.parseCapture('file taxes 5/1/2028', NOW).due, '2028-01-05');
  assert.equal(C.parseCapture('board pack 2026-11-03', NOW).due, '2026-11-03');
});

test('capture: invalid dates stay in the text', () => {
  const r = C.parseCapture('check invoice 31/02', NOW);
  assert.equal(r.due, undefined);
  assert.equal(r.text, 'check invoice 31/02');
  assert.equal(C.parseCapture('ref 2026-02-30', NOW).due, undefined);
});

test('capture: @ with trailing punctuation keeps the punctuation in the text', () => {
  const r = C.parseCapture('call @Anna, then email', NOW);
  assert.equal(r.who, 'Anna');
  assert.equal(r.text, 'call Anna, then email');
});

test('capture: only tags is no item', () => {
  assert.equal(C.parseCapture('! #p', NOW), null);
  assert.equal(C.parseCapture('   ', NOW), null);
});

test('capture: #w overrides an earlier #p', () => {
  assert.equal(C.parseCapture('thing #p #w', NOW).ctx, 'work');
});

// ---------- migration ----------

function v1Fixture() {
  return {
    notes: { professional: '<div>Pipeline review</div>', personal: '<div>Groceries</div>' },
    _notesLastEdit: { professional: 1, personal: 2 },
    checklist: {
      professional: [
        { text: 'Draft memo for Acme Robotics', done: false, priority: 'high', addedAt: '2026-08-01' },
        { text: 'Intro Ben to Carla', done: false, priority: 'none', addedAt: '2026-09-28', updatedAt: 5 },
        { text: 'Send portfolio update', done: true, priority: 'none', addedAt: '2026-07-01', doneAt: T - DAY },
        // Stale doneAt on an item that was unticked: must not count as done.
        { text: 'Book offsite venue', done: false, priority: 'medium', addedAt: '2026-09-01', doneAt: T - 10 * DAY }
      ],
      personal: [
        { text: 'Dentist', done: false, priority: 'none', addedAt: '2026-09-20', deadline: '2026-10-15' },
        { text: 'Dentist', done: false, priority: 'none', addedAt: '2026-09-20' }
      ]
    },
    _deletedChecklist: ['Old thing|2026-01-01'],
    completionLog: [
      { date: '2026-09-29', category: 'professional' },
      { date: '2026-09-30', category: 'personal' },
      { date: 'garbage', category: 'personal' }
    ],
    preferences: { name: 'Test User', color: 'blue', theme: 'dark' },
    habits: [{ id: 'h_1', name: 'Run', frequency: 'daily', createdAt: '2026-01-01', archived: false }],
    _deletedHabits: [],
    habitLog: { 'h_1:2026-09-30': true, 'move:h_1:2026-09-28:2': 4 },
    dashboardConfig: ['x']
  };
}

test('migration: carries every item, maps context, keeps notes/habits', () => {
  const s = C.migrateV1(v1Fixture(), T);
  const items = Object.values(s.items);
  assert.equal(items.length, 6);
  assert.equal(items.filter(i => !C.isDone(i)).length, 5, 'open count preserved');
  assert.equal(items.filter(i => i.ctx === 'work').length, 4);
  assert.equal(items.filter(i => i.ctx === 'personal').length, 2);
  assert.ok(items.every(i => i.list === 'next'));
  assert.equal(s.notes.professional, '<div>Pipeline review</div>');
  assert.equal(s.notes.personal, '<div>Groceries</div>');
  assert.deepEqual(s.habits, v1Fixture().habits);
  assert.deepEqual(s.habitLog, v1Fixture().habitLog);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.dashboardConfig, undefined);
  assert.equal(s._deletedChecklist, undefined);
  assert.equal(s.preferences.name, 'Test User');
  assert.equal(s.preferences.todayCap, 3);
});

test('migration: done only when done === true; deadline becomes due', () => {
  const items = Object.values(C.migrateV1(v1Fixture(), T).items);
  const sent = items.find(i => i.text === 'Send portfolio update');
  assert.equal(sent.doneAt, T - DAY);
  assert.equal(items.find(i => i.text === 'Book offsite venue').doneAt, undefined);
  assert.equal(items.find(i => i.due).due, '2026-10-15');
});

test('migration: ids are deterministic, and duplicates stay distinct', () => {
  const a = Object.keys(C.migrateV1(v1Fixture(), T).items).sort();
  const b = Object.keys(C.migrateV1(v1Fixture(), T + 99999).items).sort();
  assert.deepEqual(a, b, 'two devices migrating the same data agree on ids');
  assert.equal(new Set(a).size, 6);
});

test('migration: touchedAt is the add date, so an old backlog is stale', () => {
  const s = C.migrateV1(v1Fixture(), T);
  const memo = Object.values(s.items).find(i => i.text.startsWith('Draft memo'));
  assert.equal(memo.touchedAt, new Date(2026, 7, 1).getTime());
  assert.ok(C.isStale(memo, T));
  const intro = Object.values(s.items).find(i => i.text.startsWith('Intro'));
  assert.ok(!C.isStale(intro, T));
});

test('migration: completion log becomes completion records, junk dropped', () => {
  const s = C.migrateV1(v1Fixture(), T);
  assert.equal(Object.keys(s.completions).length, 2);
  assert.equal(C.doneOn(s, '2026-09-30'), 1);
});

test('migration: very old array format keeps its items', () => {
  const s = C.migrateV1([{ text: 'Legacy task', done: false, addedAt: '2026-01-02' }], T);
  assert.equal(Object.keys(s.items).length, 1);
  assert.equal(Object.values(s.items)[0].ctx, 'work');
});

test('isV1 recognises both shapes', () => {
  assert.ok(C.isV1(v1Fixture()));
  assert.ok(C.isV1([]));
  assert.ok(!C.isV1(C.emptyState()));
});

// ---------- lists, staleness, triage ----------

function stateWith(items) {
  const s = C.emptyState();
  for (const i of items) s.items[i.id] = i;
  return s;
}

test('next ordering: dated soonest first, then undated newest first', () => {
  const s = stateWith([
    C.makeItem({ id: 'a', text: 'a' }, T - 3 * DAY),
    C.makeItem({ id: 'b', text: 'b', due: '2026-10-09' }, T),
    C.makeItem({ id: 'c', text: 'c' }, T - DAY),
    C.makeItem({ id: 'd', text: 'd', due: '2026-10-03' }, T)
  ]);
  assert.deepEqual(C.listItems(s, 'next', { today: '2026-10-01' }).map(i => i.id), ['d', 'b', 'c', 'a']);
});

test('done today stays visible, done yesterday is hidden', () => {
  const s = stateWith([
    C.makeItem({ id: 'x', text: 'x', list: 'today' }, T),
    C.makeItem({ id: 'y', text: 'y', list: 'today' }, T)
  ]);
  C.completeItem(s, 'x', T);
  C.completeItem(s, 'y', T - DAY);
  assert.deepEqual(C.listItems(s, 'today', { today: '2026-10-01' }).map(i => i.id), ['x']);
});

test('context filter', () => {
  const s = stateWith([
    C.makeItem({ id: 'w', text: 'w', ctx: 'work' }, T),
    C.makeItem({ id: 'p', text: 'p', ctx: 'personal' }, T)
  ]);
  assert.deepEqual(C.listItems(s, 'next', { today: '2026-10-01', ctx: 'personal' }).map(i => i.id), ['p']);
});

test('staleness: 14 days untouched in Next; moving touches it', () => {
  const old = C.makeItem({ id: 'o', text: 'o' }, T - 14 * DAY);
  const fresh = C.makeItem({ id: 'f', text: 'f' }, T - 13 * DAY);
  assert.ok(C.isStale(old, T));
  assert.ok(!C.isStale(fresh, T));
  C.moveItem(old, 'later', T);
  assert.ok(!C.isStale(old, T), 'Later is never stale');
  C.moveItem(old, 'next', T);
  assert.ok(!C.isStale(old, T), 'moving refreshes touchedAt');
  const sug = C.makeItem({ id: 's', text: 's', suggested: true }, T - 30 * DAY);
  assert.ok(!C.isStale(sug, T), 'suggestions are not stale');
});

test('triage card appears at 5 stale items, not 4', () => {
  const items = [];
  for (let n = 0; n < 4; n++) items.push(C.makeItem({ id: 's' + n, text: 's' + n }, T - 20 * DAY));
  const s = stateWith(items);
  assert.ok(!C.needsTriage(s, T));
  s.items.s4 = C.makeItem({ id: 's4', text: 's4' }, T - 20 * DAY);
  assert.ok(C.needsTriage(s, T));
  assert.equal(C.staleItems(s, T).length, 5);
});

test('moving out of Today resets carriedDays', () => {
  const it = C.makeItem({ id: 'i', text: 'i', list: 'today' }, T);
  it.carriedDays = 3;
  C.moveItem(it, 'next', T);
  assert.equal(it.carriedDays, 0);
});

// ---------- completions and streak ----------

test('complete and uncomplete keep the completion record in step', () => {
  const s = stateWith([C.makeItem({ id: 'i', text: 'i', ctx: 'personal', suggested: true }, T)]);
  C.completeItem(s, 'i', T);
  assert.deepEqual(s.completions.c_i, { date: '2026-10-01', ctx: 'personal', text: 'i' });
  assert.equal(s.items.i.suggested, undefined, 'finishing a suggestion accepts it');
  assert.equal(C.doneOn(s, '2026-10-01'), 1);
  C.uncompleteItem(s, 'i', T);
  assert.equal(s.completions.c_i, undefined);
  assert.equal(s.items.i.doneAt, undefined);
});

test('streak counts back from today, or from yesterday when today is empty', () => {
  const s = C.emptyState();
  s.completions = { a: { date: '2026-09-29' }, b: { date: '2026-09-30' }, c: { date: '2026-09-30' } };
  assert.equal(C.streak(s, '2026-10-01'), 2, 'today not done yet: streak still alive');
  s.completions.d = { date: '2026-10-01' };
  assert.equal(C.streak(s, '2026-10-01'), 3);
  assert.equal(C.streak(s, '2026-10-03'), 0, 'a missed day breaks it');
  s.completions = { a: { date: '2026-09-27' }, b: { date: '2026-10-01' } };
  assert.equal(C.streak(s, '2026-10-01'), 1);
});

// ---------- day boundary ----------

test('startDay: carries unfinished Today items once per day', () => {
  const s = stateWith([
    C.makeItem({ id: 't1', text: 't1', list: 'today' }, T - DAY),
    C.makeItem({ id: 't2', text: 't2', list: 'today' }, T - DAY),
    C.makeItem({ id: 'n1', text: 'n1', list: 'next' }, T - DAY)
  ]);
  C.completeItem(s, 't2', T - DAY);
  assert.equal(C.startDay(s, new Date(T - DAY)), true, 'first ever day just records the date');
  assert.equal(s.items.t1.carriedDays, 0);
  assert.equal(C.startDay(s, NOW), true);
  assert.equal(s.items.t1.carriedDays, 1);
  assert.equal(s.items.t2.carriedDays, 0, 'done items are not carried');
  assert.equal(s.items.n1.carriedDays, 0);
  assert.equal(C.startDay(s, NOW), false, 'idempotent within a day');
  assert.equal(s.items.t1.carriedDays, 1);
  assert.deepEqual(C.carryOvers(s).map(i => i.id), ['t1']);
});

test('startDay: removes long-done items but the streak survives', () => {
  const s = stateWith([C.makeItem({ id: 'old', text: 'old' }, T - 40 * DAY)]);
  C.completeItem(s, 'old', T - 31 * DAY);
  s.meta.lastDay = '2026-09-30';
  C.startDay(s, NOW);
  assert.equal(s.items.old, undefined);
  assert.equal(Object.keys(s.completions).length, 1);
});

test('needsPick follows meta.lastPick', () => {
  const s = C.emptyState();
  assert.ok(C.needsPick(s, NOW));
  s.meta.lastPick = '2026-10-01';
  assert.ok(!C.needsPick(s, NOW));
});

// ---------- suggestions ----------

test('suggestions: valid entries land as suggested, junk is skipped', () => {
  const s = stateWith([C.makeItem({ id: 'e', text: 'Already here' }, T)]);
  const added = C.ingestSuggestions(s, [
    { text: 'Send Q3 numbers to Dana', who: 'Dana', due: '2026-10-05', ctx: 'work', list: 'next',
      source: { url: 'https://mail.example.com/thread/1', label: 'Re: Q3' } },
    { text: 'Chase signed SAFE', list: 'waiting', source: { url: 'javascript:alert(1)' } },
    { text: 'Wrong list', list: 'today', due: 'next week' },
    { text: 'already HERE' },
    { text: '' },
    null,
    { nope: true }
  ], T);
  assert.equal(added.length, 3);
  const items = added.map(id => s.items[id]);
  assert.ok(items.every(i => i.suggested));
  assert.equal(items[0].who, 'Dana');
  assert.equal(items[0].due, '2026-10-05');
  assert.equal(items[0].source.label, 'Re: Q3');
  assert.equal(items[1].list, 'waiting');
  assert.equal(items[1].source, undefined, 'non-http links are dropped');
  assert.equal(items[2].list, 'next', 'suggestions never jump straight into Today');
  assert.equal(items[2].due, undefined);
});

test('suggestions: accepts { items: [...] } too', () => {
  const s = C.emptyState();
  assert.equal(C.ingestSuggestions(s, { items: [{ text: 'a' }] }, T).length, 1);
});

// ---------- records and stamping ----------

test('records round-trip through applyPatch', () => {
  const s = C.migrateV1(v1Fixture(), T);
  s.meta.lastPick = '2026-10-01';
  const rebuilt = C.emptyState();
  const recs = C.toRecords(s);
  C.applyPatch(rebuilt, recs);
  assert.deepEqual(C.toRecords(rebuilt), recs);
});

test('stamp: idempotent when nothing changed', () => {
  const s = C.migrateV1(v1Fixture(), T);
  const clock = {};
  const first = C.stamp(clock, C.toRecords(s), T);
  assert.ok(first.length > 0);
  assert.deepEqual(C.stamp(clock, C.toRecords(s), T + 1000), []);
});

test('stamp: an edit stamps one path, a removal leaves a tombstone, re-adding revives', () => {
  const s = stateWith([C.makeItem({ id: 'a', text: 'a' }, T), C.makeItem({ id: 'b', text: 'b' }, T)]);
  const clock = {};
  C.stamp(clock, C.toRecords(s), T);
  s.items.a.text = 'a2';
  assert.deepEqual(C.stamp(clock, C.toRecords(s), T + 5), ['items/a']);
  assert.equal(clock['items/a'].t, T + 5);
  const b = s.items.b;
  delete s.items.b;
  assert.deepEqual(C.stamp(clock, C.toRecords(s), T + 6), ['items/b']);
  assert.equal(clock['items/b'].d, true);
  s.items.b = b;
  assert.deepEqual(C.stamp(clock, C.toRecords(s), T + 7), ['items/b']);
  assert.equal(clock['items/b'].d, undefined);
});

test('stamp: a new stamp always beats the last one, even under clock skew', () => {
  const s = stateWith([C.makeItem({ id: 'a', text: 'a' }, T)]);
  const clock = { 'items/a': { h: 'zzz', t: T + 60000 } };
  C.stamp(clock, C.toRecords(s), T);
  assert.equal(clock['items/a'].t, T + 60001);
});

test('wire: values survive as JSON text, including empty strings and arrays', () => {
  const clock = {};
  const recs = { 'notes/personal': { html: '' }, 'items/x': { id: 'x', tags: [] } };
  C.stamp(clock, recs, T);
  const other = {};
  for (const p of Object.keys(recs)) {
    const w = JSON.parse(JSON.stringify(C.toWire(clock, recs, p)));
    assert.deepEqual(C.applyRemote(other, p, w).value, recs[p]);
  }
});

test('applyRemote: only strictly newer wins; own echoes are no-ops', () => {
  const clock = { 'items/a': { h: C.hash({ v: 1 }), t: 100 } };
  assert.equal(C.applyRemote(clock, 'items/a', { j: '{"v":2}', t: 100 }), null);
  assert.equal(C.applyRemote(clock, 'items/a', { j: '{"v":2}', t: 99 }), null);
  assert.ok(C.localIsNewer(clock, 'items/a', { t: 99 }));
  assert.deepEqual(C.applyRemote(clock, 'items/a', { j: '{"v":2}', t: 101 }), { path: 'items/a', value: { v: 2 } });
  assert.deepEqual(C.applyRemote(clock, 'items/a', { t: 102, d: true }), { path: 'items/a', value: null });
  assert.equal(C.applyRemote(clock, 'items/a', { j: 'not json', t: 200 }), null);
});

test('purgeTombstones drops only old tombstones', () => {
  const clock = { a: { t: T - 61 * DAY, d: true }, b: { t: T - 10 * DAY, d: true }, c: { h: 'x', t: T - 90 * DAY } };
  assert.deepEqual(C.purgeTombstones(clock, T), ['a']);
  assert.deepEqual(Object.keys(clock).sort(), ['b', 'c']);
});

test('firebase keys: unsafe characters round-trip', () => {
  const k = 'a.b#c$d[e]f/g%h';
  assert.ok(!/[.#$\[\]\/]/.test(C.encodeKey(k)));
  assert.equal(C.decodeKey(C.encodeKey(k)), k);
  assert.equal(C.decodeKey(C.encodeKey('h_1:2026-09-30')), 'h_1:2026-09-30');
});

// ---------- sync convergence (a simulated server) ----------
//
// The server keeps the last write to arrive, per path — like Firebase update().
// Each device stamps its state, pushes what it changed, pulls everything, and
// re-pushes anything where it holds a newer copy than the server.

function correctDecide(clock, path, wire) {
  const r = C.applyRemote(clock, path, wire);
  if (r) return { apply: r };
  return { push: C.localIsNewer(clock, path, wire) };
}

// A broken merge for the negative control: whatever the server says, wins.
function naiveDecide(clock, path, wire) {
  const v = wire.d ? null : C.wireValue(wire);
  clock[path] = wire.d ? { h: null, t: wire.t, d: true } : { h: C.hash(v), t: wire.t };
  return { apply: { path, value: v } };
}

function device(state, decide) {
  return { state, clock: {}, decide: decide || correctDecide };
}

function save(dev, server, now) {
  const recs = C.toRecords(dev.state);
  for (const p of C.stamp(dev.clock, recs, now)) server[p] = C.toWire(dev.clock, recs, p);
}

function pull(dev, server) {
  for (const [p, w] of Object.entries(server)) {
    const d = dev.decide(dev.clock, p, w);
    if (d.apply) C.applyPath(dev.state, d.apply.path, d.apply.value);
    if (d.push) server[p] = C.toWire(dev.clock, C.toRecords(dev.state), p);
  }
}

function settle(devs, server) {
  for (let round = 0; round < 3; round++) for (const d of devs) pull(d, server);
}

function same(a, b) {
  return C.stableStringify(C.toRecords(a.state)) === C.stableStringify(C.toRecords(b.state));
}

function pair(decide) {
  const base = C.migrateV1(v1Fixture(), T);
  const server = {};
  const a = device(C.clone(base), decide);
  const b = device(C.clone(base), decide);
  save(a, server, T);
  pull(b, server);
  save(b, server, T);
  return { a, b, server };
}

test('sync: concurrent edits to different items both survive', () => {
  const { a, b, server } = pair();
  const ids = Object.keys(a.state.items).sort();
  a.state.items[ids[0]].text = 'edited on A';
  b.state.items[ids[1]].text = 'edited on B';
  save(a, server, T + 10);
  save(b, server, T + 11);
  settle([a, b], server);
  assert.ok(same(a, b));
  assert.equal(a.state.items[ids[0]].text, 'edited on A');
  assert.equal(a.state.items[ids[1]].text, 'edited on B');
});

test('sync: a delete made after an edit wins, and does not come back', () => {
  const { a, b, server } = pair();
  const id = Object.keys(a.state.items)[0];
  b.state.items[id].text = 'edit';
  save(b, server, T + 10);
  delete a.state.items[id];
  save(a, server, T + 20);
  settle([a, b], server);
  assert.ok(same(a, b));
  assert.equal(b.state.items[id], undefined);
  save(b, server, T + 30);
  settle([a, b], server);
  assert.equal(a.state.items[id], undefined, 'not resurrected by a later save');
});

test('sync: an edit made after a delete wins, even when it arrives first', () => {
  const { a, b, server } = pair();
  const id = Object.keys(a.state.items)[0];
  a.state.items[id].text = 'kept';
  save(a, server, T + 20);
  // B deleted earlier while offline; its stale write lands on the server last.
  delete b.state.items[id];
  const recs = C.toRecords(b.state);
  C.stamp(b.clock, recs, T + 10);
  server['items/' + id] = C.toWire(b.clock, recs, 'items/' + id);
  settle([a, b], server);
  assert.ok(same(a, b));
  assert.equal(b.state.items[id].text, 'kept');
});

test('sync: a habit untick propagates instead of reappearing', () => {
  const { a, b, server } = pair();
  a.state.habitLog['h_1:2026-10-01'] = true;
  save(a, server, T + 10);
  settle([a, b], server);
  assert.equal(b.state.habitLog['h_1:2026-10-01'], true);
  delete b.state.habitLog['h_1:2026-10-01'];
  save(b, server, T + 20);
  settle([a, b], server);
  assert.equal(a.state.habitLog['h_1:2026-10-01'], undefined);
  assert.ok(same(a, b));
});

test('sync: notes and completions travel', () => {
  const { a, b, server } = pair();
  a.state.notes.personal = '';
  const id = Object.keys(a.state.items).find(k => !C.isDone(a.state.items[k]));
  C.completeItem(a.state, id, T + 5);
  save(a, server, T + 10);
  settle([a, b], server);
  assert.equal(b.state.notes.personal, '', 'clearing a note syncs');
  assert.ok(C.isDone(b.state.items[id]));
  assert.ok(b.state.completions['c_' + id]);
});

// The renderer saves 300ms after an edit, so a remote change can reach main
// while an edit is unsaved or its save is in flight. Main sends each patch with
// the hashes it held before it (main.js onRemote), and both the renderer and
// main's replay of unseen patches apply a record only if it still matches.

function remoteEdit(state, id, text) {
  const item = C.clone(state.items[id]);
  item.text = text;
  return { ['items/' + id]: item };
}

// What main does on a remote patch: note the before-hashes, then apply.
function mainApplies(main, patch) {
  const before = C.recordHashes(main, Object.keys(patch));
  C.applyPatch(main, patch);
  return before;
}

test('patch window: a remote edit does not undo an unsaved local delete', () => {
  const main = C.migrateV1(v1Fixture(), T);
  const id = Object.keys(main.items)[0];
  const rendered = C.clone(main);
  delete rendered.items[id];
  const patch = remoteEdit(main, id, 'edited elsewhere');
  const before = mainApplies(main, patch);
  assert.deepEqual(C.applyPatchIfUnchanged(rendered, patch, before), []);
  assert.equal(rendered.items[id], undefined);
});

test('patch window: a remote edit does not undo an unsaved local edit', () => {
  const main = C.migrateV1(v1Fixture(), T);
  const id = Object.keys(main.items)[0];
  const rendered = C.clone(main);
  rendered.items[id].text = 'edited here';
  const patch = remoteEdit(main, id, 'edited elsewhere');
  C.applyPatchIfUnchanged(rendered, patch, mainApplies(main, patch));
  assert.equal(rendered.items[id].text, 'edited here');
});

test('patch window: untouched records take every patch in turn', () => {
  const main = C.migrateV1(v1Fixture(), T);
  const [id, other] = Object.keys(main.items);
  const rendered = C.clone(main);
  rendered.items[other].text = 'edited here';
  for (const text of ['one', 'two']) {
    const patch = remoteEdit(main, id, text);
    assert.deepEqual(C.applyPatchIfUnchanged(rendered, patch, mainApplies(main, patch)), ['items/' + id]);
  }
  assert.equal(rendered.items[id].text, 'two');
  const del = { ['items/' + id]: null };
  C.applyPatchIfUnchanged(rendered, del, mainApplies(main, del));
  assert.equal(rendered.items[id], undefined, 'a remote delete lands too');
  const add = { ['items/i_new']: C.makeItem({ id: 'i_new', text: 'added elsewhere' }, T) };
  C.applyPatchIfUnchanged(rendered, add, mainApplies(main, add));
  assert.equal(rendered.items.i_new.text, 'added elsewhere', 'and a remote add');
  assert.equal(rendered.items[other].text, 'edited here');
});

test('patch window: a delete whose save was in flight survives on both sides', () => {
  const main = C.migrateV1(v1Fixture(), T);
  const [id, other] = Object.keys(main.items);
  const rendered = C.clone(main);
  delete rendered.items[id];
  const saved = C.clone(rendered);                  // the save is in flight
  const patch = Object.assign(remoteEdit(main, id, 'edited elsewhere'), remoteEdit(main, other, 'also elsewhere'));
  const before = mainApplies(main, patch);          // main applies the patch first
  // main gets the save and replays the patch it had not seen
  const replayed = C.normalizeState(saved);
  C.applyPatchIfUnchanged(replayed, patch, before);
  assert.equal(replayed.items[id], undefined, 'main keeps the delete');
  assert.equal(replayed.items[other].text, 'also elsewhere', 'and replays the record it did not touch');
  // then the patch reaches the renderer, which has already saved the delete
  C.applyPatchIfUnchanged(rendered, patch, before);
  assert.equal(rendered.items[id], undefined, 'the renderer keeps it too');
  assert.equal(rendered.items[other].text, 'also elsewhere');
  assert.equal(C.stableStringify(C.toRecords(rendered)), C.stableStringify(C.toRecords(replayed)));
});

test('negative control: a plain patch apply resurrects the deleted item', () => {
  const main = C.migrateV1(v1Fixture(), T);
  const id = Object.keys(main.items)[0];
  const rendered = C.clone(main);
  delete rendered.items[id];
  C.applyPatch(rendered, remoteEdit(main, id, 'edited elsewhere'));
  assert.equal(rendered.items[id].text, 'edited elsewhere', 'so the patch-window tests above are discriminating');
});

// Negative controls: prove the convergence checks can fail.

test('negative control: a last-arrival-wins merge loses the newer edit', () => {
  const { a, b, server } = pair(naiveDecide);
  const id = Object.keys(a.state.items)[0];
  a.state.items[id].text = 'kept';
  save(a, server, T + 20);
  delete b.state.items[id];
  const recs = C.toRecords(b.state);
  C.stamp(b.clock, recs, T + 10);
  server['items/' + id] = C.toWire(b.clock, recs, 'items/' + id);
  settle([a, b], server);
  assert.equal(a.state.items[id], undefined, 'the broken merge drops the newer edit, so the real test above is discriminating');
});

test('negative control: same() notices a single diverged record', () => {
  const { a, b, server } = pair();
  settle([a, b], server);
  assert.ok(same(a, b));
  b.state.habitLog['h_1:2026-10-01'] = true;
  assert.ok(!same(a, b));
});
