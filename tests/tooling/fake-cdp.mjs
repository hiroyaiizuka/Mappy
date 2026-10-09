/**
 * A stand-in for an Obsidian's DevTools server, for testing scripts/e2e/cdp.mjs's `connect()` without Obsidian (LEV-327):
 * `GET /json/list` lists `targets`, and each target's WebSocket answers the few CDP calls `connect()` makes
 * (`Runtime.evaluate` of the vault, the language and the throttling; `Target.setDiscoverTargets`). `emit` sends an event
 * to every open socket. Text frames only, as CDP sends; the client's frames are masked, ours are not (RFC 6455).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function decode(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const masked = (buffer[1] & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, text: payload.toString('utf8'), size: offset + length };
}

function encode(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Starts the server; `vault` is what `app.vault.adapter.basePath` says. Resolves to its handle once it listens. */
export async function fakeCdp({ vault, targets = [{ id: 'main', type: 'page', url: 'app://obsidian.md/index.html' }] }) {
  const state = { targets: [...targets], requests: [], calls: [], sockets: new Set() };
  const server = createServer((request, response) => {
    state.requests.push(request.url);
    if (request.url === '/json/list') {
      const { port } = server.address();
      response.end(JSON.stringify(state.targets.map(target => ({ ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}` }))));
    } else if (request.url === '/json/version') response.end('{}');
    else { response.statusCode = 404; response.end(); }
  });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    state.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let frame = decode(buffer); frame; frame = decode(buffer)) {
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 8) { socket.end(); state.sockets.delete(socket); return; }
        if (frame.opcode !== 1) continue;
        const { id, method, params } = JSON.parse(frame.text);
        state.calls.push(method);
        let result = {};
        if (method === 'Runtime.evaluate') {
          const expression = params?.expression ?? '';
          const value = expression.includes('app.vault.adapter.basePath') ? vault
            : expression.includes('window.moment?.locale') ? ['ja', null, true] : true;
          result = { result: { type: typeof value, value } };
        }
        socket.write(encode(JSON.stringify({ id, result })));
      }
    });
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => state.sockets.delete(socket));
  });
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  return {
    port: String(server.address().port),
    state,
    /** A CDP event to every open connection. */
    emit: (method, params) => { for (const socket of state.sockets) socket.write(encode(JSON.stringify({ method, params }))); },
    close: () => new Promise(resolve => { for (const socket of state.sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
