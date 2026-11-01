// School Defender — servidor de salas multiplayer (sem dependências, só Node 16+)
// Uso:  node server.js      (porta padrão 3000, ou defina PORT=xxxx)
// Serve o jogo (index.html) e retransmite mensagens entre os jogadores de cada sala.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000, MAX_PLAYERS = 4, MAX_ROOMS = 300, MAX_MSG = 256 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, b) => {
      if (e) { res.writeHead(500); return res.end('index.html não encontrado ao lado do server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(b);
    });
  } else if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  } else { res.writeHead(404); res.end('Not found'); }
});

// ---------- WebSocket mínimo (RFC 6455) ----------
function frame(op, payload) {
  const n = payload.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, payload]);
}
function send(c, obj) { if (c.sock.destroyed || !c.sock.writable) return; c.sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); }

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), room: null, id: 0, alive: true, frag: [] };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > MAX_MSG * 2) return sock.destroy();
    let f; while ((f = parse(c))) {
      if (f.op === 8) { sock.end(frame(8, Buffer.alloc(0))); return; }
      if (f.op === 9) { sock.write(frame(10, f.data)); continue; }
      if (f.op === 10) { c.alive = true; continue; }
      if (f.op === 1 || f.op === 0) {
        c.frag.push(f.data);
        if (f.fin) { const s = Buffer.concat(c.frag).toString('utf8'); c.frag = []; onMsg(c, s); }
      }
    }
  });
  sock.on('close', () => leave(c));
  sock.on('error', () => sock.destroy());
});

function parse(c) {
  const b = c.buf; if (b.length < 2) return null;
  const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80); let n = b[1] & 127, o = 2;
  if (n === 126) { if (b.length < 4) return null; n = b.readUInt16BE(2); o = 4; }
  else if (n === 127) { if (b.length < 10) return null; n = Number(b.readBigUInt64BE(2)); o = 10; }
  if (n > MAX_MSG) { c.sock.destroy(); return null; }
  const need = o + (masked ? 4 : 0) + n; if (b.length < need) return null;
  let data = b.subarray(o + (masked ? 4 : 0), need);
  if (masked) { const m = b.subarray(o, o + 4); data = Buffer.from(data); for (let i = 0; i < n; i++) data[i] ^= m[i & 3]; }
  c.buf = b.subarray(need);
  return { fin, op, data };
}

// ---------- Salas ----------
function code() { let s; do { s = ''; for (let i = 0; i < 4; i++) s += ABC[crypto.randomInt(ABC.length)]; } while (rooms.has(s)); return s; }
function onMsg(c, s) {
  let m; try { m = JSON.parse(s); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'create' && !c.room) {
    if (rooms.size >= MAX_ROOMS) return send(c, { t: 'err', m: 'Servidor cheio, tente mais tarde' });
    const r = { code: code(), host: 1, next: 2, members: new Map() };
    c.id = 1; c.room = r; r.members.set(1, c); rooms.set(r.code, r);
    send(c, { t: 'hi', room: r.code, id: 1, host: 1, ids: [1] });
    console.log('[sala]', r.code, 'criada');
  } else if (m.t === 'join' && !c.room) {
    const r = rooms.get(String(m.room || '').toUpperCase().trim());
    if (!r) return send(c, { t: 'err', m: 'Sala não encontrada' });
    if (r.members.size >= MAX_PLAYERS) return send(c, { t: 'err', m: 'Sala cheia (máx. ' + MAX_PLAYERS + ')' });
    c.id = r.next++; c.room = r; r.members.set(c.id, c);
    send(c, { t: 'hi', room: r.code, id: c.id, host: r.host, ids: [...r.members.keys()] });
    r.members.forEach(o => { if (o !== c) send(o, { t: 'in', id: c.id }); });
    console.log('[sala]', r.code, 'jogador', c.id, 'entrou (' + r.members.size + ')');
  } else if (m.t === 'to' && c.room) {
    const r = c.room, out = { t: 'm', from: c.id, d: m.d };
    if (m.to === 'all') r.members.forEach(o => { if (o !== c) send(o, out); });
    else { const o = r.members.get(m.to === 'host' ? r.host : +m.to); if (o) send(o, out); }
  }
}
function leave(c) {
  const r = c.room; if (!r) return; c.room = null;
  r.members.delete(c.id);
  if (c.id === r.host) {
    r.members.forEach(o => { send(o, { t: 'closed' }); o.room = null; });
    rooms.delete(r.code); console.log('[sala]', r.code, 'encerrada');
  } else r.members.forEach(o => send(o, { t: 'out', id: c.id }));
}
// keep-alive (túneis/hospedagens derrubam conexões ociosas)
const clients = () => { const a = []; rooms.forEach(r => r.members.forEach(c => a.push(c))); return a; };
setInterval(() => clients().forEach(c => { if (!c.alive) return c.sock.destroy(); c.alive = false; if (c.sock.writable) c.sock.write(frame(9, Buffer.alloc(0))); }), 25000);

server.listen(PORT, '0.0.0.0', () => {
  const ifs = require('os').networkInterfaces(), ips = [];
  Object.values(ifs).forEach(l => l.forEach(i => { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); }));
  console.log('\n  School Defender — servidor multiplayer rodando!\n');
  console.log('  Neste PC:        http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Rede/VPN:        http://' + ip + ':' + PORT));
  console.log('\n  Ctrl+C para parar.\n');
});
