// Tests for server/build-public.mjs: the phone's copy of index.html. Every edit
// must land exactly once, and the desktop file must keep its strict CSP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repo = path.join(__dirname, '..');
const desktop = fs.readFileSync(path.join(repo, 'index.html'), 'utf-8');
const load = () => import('../server/build-public.mjs');

test('webPage: the phone copy talks to its own server and loads the browser api', async () => {
  const { webPage } = await load();
  const page = webPage(desktop);
  assert.match(page, /<html lang="en" class="web">/);
  assert.match(page, /connect-src 'self'/);
  assert.doesNotMatch(page, /connect-src 'none'/);
  assert.match(page, /viewport-fit=cover/);
  assert.match(page, /<link rel="manifest" href="manifest.json">/);
  // web-api.js must come after core.js and sync.js, which it reads at load.
  const core = page.indexOf('<script src="core.js">');
  const sync = page.indexOf('<script src="sync.js">');
  const api = page.indexOf('<script src="web-api.js">');
  assert.ok(core > 0 && core < sync && sync < api, 'script order core, sync, web-api');
});

test('webPage: the desktop file keeps connect-src none and no browser api', () => {
  assert.match(desktop, /connect-src 'none'/);
  assert.doesNotMatch(desktop, /<script src="(sync|web-api)\.js">/);
  assert.doesNotMatch(desktop, /<html[^>]*class="web"/);
});

test('negative control: a page missing an anchor fails the build instead of shipping', async () => {
  const { webPage } = await load();
  assert.doesNotThrow(() => webPage(desktop));
  assert.throws(() => webPage(desktop.replace('<script src="core.js"></script>', '')), /expected one/);
  assert.throws(() => webPage(desktop.replace('</head>', '</head></head>')), /found 2/);
});

test('build: public/ holds the page, the shared logic and the PWA files', async () => {
  const { build } = await load();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-public-'));
  try {
    build(out);
    for (const f of ['index.html', 'core.js', 'sync.js', 'web-api.js', 'sw.js', 'manifest.json', '_headers', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    assert.equal(fs.readFileSync(path.join(out, 'core.js'), 'utf-8'), fs.readFileSync(path.join(repo, 'core.js'), 'utf-8'));
    // Everything the service worker caches must exist, or install() rejects and
    // the phone never works offline.
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf-8');
    const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    for (const f of shell) if (f !== './') assert.ok(fs.existsSync(path.join(out, f)), 'sw shell: ' + f);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
