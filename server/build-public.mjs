// Builds server/public/: the phone's copy of the app, which the Worker serves as
// static assets (wrangler.toml [assets]) and dev-server.mjs serves locally.
//
//   node server/build-public.mjs        (npm run deploy runs it first)
//
// The same index.html, core.js and sync.js as the desktop, plus web/ (web-api.js,
// the service worker, manifest, icons). index.html gets the edits a browser
// needs and nothing else; the desktop file on disk is never changed. public/ is
// generated and gitignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

const HEAD = [
  '<link rel="manifest" href="manifest.json">',
  '<meta name="theme-color" content="#0f0f1a">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">'
].map(l => '  ' + l + '\n').join('');

// Each edit must match exactly once, so a change to index.html that moves one of
// these fails the build instead of shipping a page without its api.
const EDITS = [
  ['<html lang="en">', '<html lang="en" class="web">'],
  // The desktop page talks to nothing; the browser's talks to its own server.
  ["connect-src 'none'", "connect-src 'self'"],
  ['content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"'],
  ['<script src="core.js"></script>', '<script src="core.js"></script>\n  <script src="sync.js"></script>\n  <script src="web-api.js"></script>'],
  ['</head>', HEAD + '</head>']
];

export function webPage(html) {
  for (const [from, to] of EDITS) {
    const n = html.split(from).length - 1;
    if (n !== 1) throw new Error('index.html: expected one ' + JSON.stringify(from) + ', found ' + n);
    html = html.replace(from, () => to);
  }
  return html;
}

export function build(out = path.join(here, 'public')) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), webPage(fs.readFileSync(path.join(repo, 'index.html'), 'utf-8')));
  for (const f of ['core.js', 'sync.js']) fs.copyFileSync(path.join(repo, f), path.join(out, f));
  for (const f of ['web-api.js', 'sw.js', 'manifest.json', '_headers']) fs.copyFileSync(path.join(repo, 'web', f), path.join(out, f));
  for (const f of fs.readdirSync(path.join(repo, 'web', 'icons'))) fs.copyFileSync(path.join(repo, 'web', 'icons', f), path.join(out, 'icons', f));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('built ' + build());
}
