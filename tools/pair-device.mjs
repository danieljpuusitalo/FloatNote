// Pair this computer with a FloatNote server, for FLOATNOTE_SYNC=server runs.
//
//   FLOATNOTE_SETUP_KEY=<key> node tools/pair-device.mjs <server url> [device name]
//
// The setup key is read from the environment so it never lands in shell history
// or output. The device token goes into <data dir>/floatnote-server.json and is
// never printed. The data dir is FLOATNOTE_DATA_DIR, else %APPDATA%\FloatNote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, name = os.hostname()] = process.argv.slice(2);
const key = process.env.FLOATNOTE_SETUP_KEY;
if (!url || !/^https?:\/\//.test(url) || !key) {
  console.error('usage: FLOATNOTE_SETUP_KEY=<key> node tools/pair-device.mjs <https://server> [device name]');
  process.exit(2);
}

const dir = process.env.FLOATNOTE_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'FloatNote');
const file = path.join(dir, 'floatnote-server.json');
const base = url.replace(/\/+$/, '');

const res = await fetch(base + '/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ setupKey: key, name })
});
const body = await res.json().catch(() => ({}));
if (res.status !== 201) {
  console.error('pairing refused: HTTP ' + res.status + (body.error ? ' (' + body.error + ')' : ''));
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
const replaced = fs.existsSync(file);
fs.writeFileSync(file + '.tmp', JSON.stringify({ url: base, token: body.token, id: body.id, name: body.name }, null, 2));
fs.renameSync(file + '.tmp', file);
console.log('paired "' + body.name + '" (device ' + body.id + ') with ' + base);
console.log((replaced ? 'replaced ' : 'wrote ') + file);
console.log('start with FLOATNOTE_SYNC=server to use it');
