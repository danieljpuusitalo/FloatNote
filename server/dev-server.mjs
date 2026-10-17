// A local stand-in for worker.js: the same server-core.js over node:sqlite, with
// sockets from `ws`. It exists because `wrangler dev` needs workerd, which has no
// Windows-on-Arm build. Use it for two-instance hand-checks on scratch data; it is
// not how FloatNote is hosted.
//
//   SETUP_KEY=<throwaway key> node server/dev-server.mjs [port] [db file]
//
// Stopping and restarting it is how a hand-check takes the network away.
import http from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const core = createRequire(import.meta.url)('../server-core.js');
const port = Number(process.argv[2] || 8787);
const db = new DatabaseSync(process.argv[3] || ':memory:');
const store = core.sqlStore((sql, ...params) => {
  const st = db.prepare(sql);
  return /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []);
});
const transaction = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

const sockets = new Set();    // { ws, device }
const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('floatnote') ? 'floatnote' : false) });

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'not found' });
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (e) { return reply(res, 400, { error: 'body is not JSON' }); }
  }
  const r = await core.handle(
    { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body },
    { store, now: Date.now(), setupKey: process.env.SETUP_KEY, transaction }
  );
  if (r.broadcast) {
    const m = core.frame(r.broadcast);
    for (const s of sockets) s.ws.send(m);
  }
  if (r.closeDevice) for (const s of sockets) if (s.device === r.closeDevice) s.ws.close(4001, 'revoked');
  reply(res, r.status, r.json);
});

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const device = url.pathname === '/api/ws' && (await core.authenticate(store, core.socketToken(req.headers), Date.now()));
  if (!device) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const s = { ws, device: device.id };
    sockets.add(s);
    ws.on('message', (data) => { if (String(data) === 'ping') ws.send('pong'); });
    ws.on('close', () => sockets.delete(s));
  });
});

server.listen(port, '127.0.0.1', () => console.log('FloatNote dev server on http://127.0.0.1:' + port));
