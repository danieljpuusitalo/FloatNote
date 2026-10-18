// The FloatNote server on Cloudflare: one Worker in front of one Durable Object,
// which holds every record in its SQLite storage. The logic is server-core.js at
// the repo root, shared with the tests; this file only adapts it to the platform:
// requests in, SQLite as the store, WebSockets out.
//
// Sockets use the hibernation API, so an idle connection costs nothing; the
// client's 'ping' is answered with 'pong' without waking the object. Each socket
// is tagged with its device id, so revoking a device closes its sockets.
import { DurableObject } from 'cloudflare:workers';
import core from '../server-core.js';

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, headers) });

export class FloatNoteDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.store = core.sqlStore((q, ...params) => sql.exec(q, ...params).toArray());
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    const now = Date.now();

    if (url.pathname === '/api/ws') {
      if (headers.upgrade !== 'websocket') return json(426, { error: 'expected a websocket' });
      const device = await core.authenticate(this.store, core.socketToken(headers), now);
      if (!device) return json(401, { error: 'unauthorized' });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [device.id]);
      // A browser drops the connection unless one offered protocol is chosen.
      return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'floatnote' } });
    }

    let body;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { return json(400, { error: 'body is not JSON' }); }
    }
    const res = await core.handle(
      { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body },
      { store: this.store, now, setupKey: this.env.SETUP_KEY, transaction: fn => this.ctx.storage.transactionSync(fn) }
    );
    if (res.broadcast) {
      const m = core.frame(res.broadcast);
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(m); } catch (e) { /* closing */ } }
    }
    if (res.closeDevice) {
      for (const ws of this.ctx.getWebSockets(res.closeDevice)) { try { ws.close(4001, 'revoked'); } catch (e) { /* closed */ } }
    }
    return json(res.status, res.json);
  }

  webSocketMessage() { /* devices only ping, and that is answered without us */ }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) { /* already closed */ }
  }

  webSocketError() { /* webSocketClose follows */ }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return env.FLOATNOTE.get(env.FLOATNOTE.idFromName('floatnote')).fetch(request);
    }
    return json(404, { error: 'not found' });
  }
};
