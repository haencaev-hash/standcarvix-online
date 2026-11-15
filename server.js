// ============================================================================
// StandCarvix v10 — онлайн-сервер (свободный режим: комнаты, движение, урон, смерть, табло, чат)
// Запуск локально:  npm install   затем   npm start      (или: node server.js)
// На Render: Build Command = npm install, Start Command = npm start. Порт берётся из PORT.
// Протокол сообщений: см. ONLINE_PROTOCOL.md
// ============================================================================
const http = require('http');
const { WebSocketServer } = require('ws');
const Accounts = require('./sc-accounts');   // [accounts] Google-аккаунты, прогресс, роли
Accounts.init();                              // без FIREBASE_SERVICE_ACCOUNT аккаунты выключены, все игроки — гости

const PORT = process.env.PORT || 8080;

// --- настройки игры (совпадают с игрой) ---
const WEAPONS = ['ak', 'm4', 'awm', 'de', 'knife'];
const WD = { ak: 34, m4: 30, awm: 150, de: 55, knife: 300 };   // урон за попадание, в голову x3
const CD = { ak: 0.1, m4: 0.085, awm: 1.5, de: 0.3, knife: 0.55 }; // откат оружия, сек
const RANGE = { knife: 4 };                                      // дальность (остальное — 90 м)
const RESPAWN_MS = 3000;   // через сколько можно возродиться
const PROTECT_MS = 2000;   // защита от урона после входа/возрождения
const MAX_MSG_PER_SEC = 120; // антиспам: больше сообщений в секунду от одного игрока игнорируется

const lobbies = new Map();
let nextPid = 1, nextLid = 1;

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const all = l => [...l.pl.values()];
const bcast = (l, o) => all(l).forEach(c => send(c, o));
const listLobbies = () => [...lobbies.values()].map(l => ({ id: l.id, name: l.name, map: l.map, players: l.pl.size, max: l.max }));
const pub = ws => ({ id: ws.pid, name: ws.pname, skin: ws.skin, hp: ws.hp, k: ws.k, d: ws.d, ...ws.st });
const board = l => bcast(l, { t: 'board', p: all(l).map(o => ({ id: o.pid, name: o.pname, k: o.k, d: o.d, pg: o.pg, pn: o.acc ? o.acc.pid : 0, vf: o.acc && o.acc.verified ? 1 : 0, rl: o.acc ? o.acc.role : '' })) });

// HTTP нужен Render'у для проверки «сервер жив» (адрес https://твой-сервис.onrender.com/ покажет текст)
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('StandCarvix server OK. Lobbies: ' + lobbies.size);
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server, maxPayload: 4096 }); // Origin не проверяем: игра работает из iframe

function leave(ws) {
  const l = ws.lobby; if (!l) return;
  l.pl.delete(ws.pid); ws.lobby = null;
  bcast(l, { t: 'pl', id: ws.pid });
  if (!l.pl.size) lobbies.delete(l.id); else board(l);   // пустая комната удаляется
}

function enter(ws, l, m) {
  leave(ws);
  ws.pid = nextPid++;
  ws.pname = ws.acc ? ws.acc.name : String(m.name || 'Игрок').slice(0, 16);   // [accounts] ник из аккаунта
  ws.skin = m.skin === 't' ? 't' : 'c';
  ws.st = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, cr: 0, vy: 0, air: 0, w: 'ak' };
  Object.assign(ws, { hp: 100, dead: false, deadAt: 0, inv: Date.now() + PROTECT_MS, k: 0, d: 0, lastHit: 0, lastChat: 0, pg: 0 });
  const others = all(l).map(pub);
  l.pl.set(ws.pid, ws); ws.lobby = l;
  send(ws, { t: 'joined', id: ws.pid, lobby: { id: l.id, name: l.name, map: l.map, max: l.max }, players: others });
  for (const c of all(l)) if (c !== ws) send(c, { t: 'pj', p: pub(ws) });
  board(l);
}

// [accounts] награда за убийство (не чаще 3 раз за минуту за одну и ту же жертву — защита от буста)
function rewardKill(ws, v, hs, now) {
  if (v.acc) Accounts.onDeath(v);
  if (!ws.acc) return;
  ws.kv = (ws.kv || []).filter(e => now - e.t < 60000);
  if (ws.kv.filter(e => e.id === v.pid).length >= 3) return;
  ws.kv.push({ id: v.pid, t: now });
  Accounts.onKill(ws, { headshot: !!hs });
}

// Попадание: клиент сообщает, КТО попал; урон считает сервер по таблице оружия
function hit(ws, m) {
  const l = ws.lobby; if (!l || ws.dead) return;
  const v = l.pl.get(num(m.id)); if (!v || v === ws || v.dead) return;
  const w = WEAPONS.includes(m.w) ? m.w : ws.st.w, now = Date.now();
  if (now - ws.lastHit < CD[w] * 500) return; ws.lastHit = now;   // защита от скорострельности
  if (now < v.inv) return;                                         // у цели защита после возрождения
  if (Math.hypot(v.st.x - ws.st.x, v.st.z - ws.st.z) > (RANGE[w] || 90)) return; // слишком далеко
  const hs = m.hs ? 1 : 0, pm = Math.min(1, Math.max(0.2, num(m.pm, 1)));
  v.hp -= WD[w] * (hs ? 3 : 1) * pm;
  if (v.hp <= 0) {
    v.hp = 0; v.dead = true; v.deadAt = now; v.d++; ws.k++;
    rewardKill(ws, v, hs, now);   // [accounts] награда начисляется сервером
    bcast(l, { t: 'kill', by: ws.pid, id: v.pid, hs, w });
    board(l);
  } else {
    send(v, { t: 'hp', id: v.pid, hp: Math.ceil(v.hp), by: ws.pid, hs });
  }
}

function handle(ws, m) {
  switch (m.t) {
    case 'hello': break;
    case 'list': send(ws, { t: 'lobbies', list: listLobbies() }); break;
    case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
    case 'create': {
      const l = {
        id: String(nextLid++), name: String(m.lname || 'Лобби').slice(0, 24),
        map: ['d', 's', 'z'].includes(m.map) ? m.map : 'd',
        max: Math.min(16, Math.max(2, num(m.max, 10))), pl: new Map()
      };
      lobbies.set(l.id, l); enter(ws, l, m); break;
    }
    case 'join': {
      const l = lobbies.get(String(m.lobby));
      if (!l) return send(ws, { t: 'err', msg: 'Лобби не найдено' });
      if (l.pl.size >= l.max) return send(ws, { t: 'err', msg: 'Лобби заполнено' });
      enter(ws, l, m); break;
    }
    case 's': if (ws.lobby) {                      // позиция игрока ~20 раз/сек
      const s = ws.st;
      s.x = num(m.x); s.y = num(m.y); s.z = num(m.z); s.yaw = num(m.yaw); s.pitch = num(m.pitch);
      s.cr = Math.min(1, Math.max(0, num(m.cr))); s.vy = num(m.vy); s.air = m.air ? 1 : 0;
      s.w = WEAPONS.includes(m.w) ? m.w : 'ak';
      ws.pg = Math.min(999, Math.max(0, num(m.pg)));
    } break;
    case 'shoot': if (ws.lobby && !ws.dead) for (const c of all(ws.lobby)) if (c !== ws) send(c, { t: 'sh', id: ws.pid }); break;
    case 'hit': hit(ws, m); break;
    case 'resp': if (ws.lobby && ws.dead && Date.now() - ws.deadAt >= RESPAWN_MS) {
      ws.hp = 100; ws.dead = false; ws.inv = Date.now() + PROTECT_MS;
      bcast(ws.lobby, { t: 'resp', id: ws.pid });
    } break;
    case 'chat': if (ws.lobby && Date.now() - ws.lastChat > 700) {
      const txt = String(m.m || '').trim().slice(0, 80); if (!txt) break;
      ws.lastChat = Date.now();
      bcast(ws.lobby, { t: 'chat', id: ws.pid, name: ws.pname, m: txt });
    } break;
    case 'leave': leave(ws); break;
    case 'buy': Accounts.buy(ws, m.item).then(r => send(ws, { t: 'buy', ok: r.ok, err: r.err, p: r.p })).catch(() => {}); break;   // [accounts]
    case 'adm': Accounts.adminSet(ws, m.pid, { verified: m.verified, gold: m.gold, xp: m.xp }).then(r => send(ws, { t: 'adm', ok: r.ok, err: r.err })).catch(() => {}); break;   // [accounts] только owner
  }
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.cnt = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    if (++ws.cnt > MAX_MSG_PER_SEC) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const run = () => { try { handle(ws, m); } catch (e) { console.error('handler error:', e); } }; // одна ошибка не роняет сервер
    // [accounts] hello с токеном: проверяем Firebase ID Token; следующие сообщения ждут в очереди (порядок сохраняется)
    if (m.t === 'hello' && typeof m.token === 'string' && m.token) {
      ws.pendingAuth = true;
      const auth = Promise.race([Accounts.authenticate(ws, m.token), new Promise(r => setTimeout(() => r(null), 8000))])
        .then(p => { if (p) send(ws, { t: 'profile', p }); }).catch(() => {})
        .then(() => { ws.pendingAuth = false; });
      ws.q = auth; return;
    }
    if (ws.pendingAuth) ws.q = ws.q.then(run); else run();
  });
  ws.on('close', () => { leave(ws); Accounts.release(ws).catch(() => {}); });   // [accounts] сохранить прогресс
  ws.on('error', () => { leave(ws); Accounts.release(ws).catch(() => {}); });
});

// состояние игроков: каждому — все остальные, 20 раз/сек
setInterval(() => {
  for (const l of lobbies.values()) {
    const a = all(l);
    for (const c of a) send(c, { t: 'snap', p: a.filter(o => o !== c).map(o => ({ id: o.pid, hp: o.hp, ...o.st })) });
  }
}, 50);
setInterval(() => lobbies.forEach(board), 1000);                              // табло и пинги раз в секунду
setInterval(() => { (wss.clients || []).forEach(c => { c.cnt = 0; }); }, 1000); // сброс счётчика антиспама
setInterval(() => {                                                           // убираем «зависшие» соединения
  (wss.clients || []).forEach(c => {
    if (c.isAlive === false) { try { c.terminate(); } catch (e) {} return; }
    c.isAlive = false; try { c.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log('StandCarvix server запущен, порт ' + PORT));
