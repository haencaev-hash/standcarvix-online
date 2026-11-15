'use strict';
/* ============================================================================
   sc-accounts.js — аккаунты, прогресс и роли StandCarvix (Node.js, Render)
   Подключается к СУЩЕСТВУЮЩЕМУ серверу, мультиплеер не заменяет.
   Зависимость: npm i firebase-admin
   Переменные окружения (Render → Environment):
     FIREBASE_SERVICE_ACCOUNT  — весь JSON сервисного ключа (или он же в base64)
     OWNER_EMAIL               — Google-почта владельца (получит роль owner)
     OWNER_UID                 — (необязательно) uid владельца вместо почты
   Если FIREBASE_SERVICE_ACCOUNT не задан — аккаунты выключены, все игроки гости,
   а мультиплеер работает как раньше.
   ============================================================================ */

let admin = null, db = null, FV = null;
const BYUID = new Map();                       // uid -> ws (один вход на аккаунт)
const OWNER_UID = process.env.OWNER_UID || '';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();

/* ---- настройки наград (меняйте под себя) ---- */
const REWARDS = {
  kill:     { gold: 10, xp: 25 },
  headshot: { gold: 0,  xp: 10 },
  match:    { gold: 20, xp: 50 },
  win:      { gold: 50, xp: 100 }
};
const CAPS = { goldPerHour: 3000, xpPerHour: 6000 };   // защита от накрутки
const SHOP = {
  /* 'id_скина': цена_в_золоте,  например:  'ak_gold': 500  */
};
const STAT_KEYS = ['kills', 'deaths', 'hs', 'shots', 'hits', 'matches', 'wins'];

/* ---- уровни: 1-й уровень = 360 XP, каждый следующий на 15% дороже ---- */
function levelInfo(xp) {
  let level = 1, rem = Math.max(0, xp | 0), need = 360;
  while (rem >= need && level < 200) { rem -= need; level++; need = Math.round(need * 1.15); }
  return { level, cur: rem, need };
}
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

function init() {
  if (db) return true;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.warn('[accounts] FIREBASE_SERVICE_ACCOUNT не задан — аккаунты отключены'); return false; }
  try {
    if (raw.trim()[0] !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');
    const c = JSON.parse(raw);
    if (c.private_key) c.private_key = c.private_key.replace(/\\n/g, '\n');
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(c) });
    db = admin.firestore(); FV = admin.firestore.FieldValue;
    setInterval(() => flushAll().catch(() => {}), 60000);
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => flushAll().finally(() => process.exit(0)));
    console.log('[accounts] Firebase Admin подключён');
    return true;
  } catch (e) { console.error('[accounts] ошибка инициализации:', e.message); db = null; return false; }
}

function publicProfile(a) {
  return { pid: a.pid, name: a.name, role: a.role, verified: a.verified, gold: a.gold, xp: a.xp,
           level: levelInfo(a.xp), skins: a.skins, stats: a.stats };
}

/* Проверка Firebase ID Token. Возвращает профиль или null (= гость). */
function authenticate(ws, token) {
  ws.authP = (async () => {
    if (!db || typeof token !== 'string' || !token || token.length > 4096) return null;
    let dec;
    try { dec = await admin.auth().verifyIdToken(token); } catch (e) { return null; }
    const uid = dec.uid, ref = db.collection('users').doc(uid);
    const isOwner = (OWNER_UID && uid === OWNER_UID) ||
      (OWNER_EMAIL && dec.email_verified && String(dec.email || '').toLowerCase() === OWNER_EMAIL);
    const prof = await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) return null;                     // профиль создаёт клиент (транзакция с ID)
      const d = s.data(), patch = {};
      if (typeof d.gold !== 'number') patch.gold = 0;
      if (typeof d.xp !== 'number') patch.xp = 0;
      if (typeof d.level !== 'number') patch.level = 1;
      if (!Array.isArray(d.skins)) patch.skins = [];
      if (typeof d.verified !== 'boolean') patch.verified = false;
      if (!d.stats || typeof d.stats !== 'object') patch.stats = {};
      if (isOwner && (d.role !== 'owner' || !d.verified)) { patch.role = 'owner'; patch.verified = true; }
      if (Object.keys(patch).length) tx.update(ref, patch);
      return Object.assign({}, d, patch);
    });
    if (!prof) return null;
    const old = BYUID.get(uid);
    if (old && old !== ws) { try { old.send(JSON.stringify({ t: 'err', msg: 'Вход с другого устройства' })); old.close(); } catch (e) {} }
    BYUID.set(uid, ws);
    ws.acc = { uid, pid: prof.pid, name: String(prof.name || 'Игрок').slice(0, 16), role: prof.role || 'player',
      verified: !!prof.verified, gold: prof.gold | 0, xp: prof.xp | 0, skins: prof.skins || [], stats: prof.stats || {},
      pend: { gold: 0, xp: 0, stats: {} }, hour: { t: Date.now(), gold: 0, xp: 0 } };
    return publicProfile(ws.acc);
  })().catch(e => { console.error('[accounts] auth error', e.message); return null; });
  return ws.authP;
}
/* вызывайте в начале обработчика сообщений, чтобы create/join не обгоняли проверку токена */
const ready = ws => ws.authP || Promise.resolve(null);

/* Начисление — ТОЛЬКО из серверной логики, никогда из чисел клиента. */
function award(ws, d) {
  const a = ws && ws.acc; if (!a) return;
  const now = Date.now(); if (now - a.hour.t > 3600e3) a.hour = { t: now, gold: 0, xp: 0 };
  const g = Math.min(int(d.gold, 1000), Math.max(0, CAPS.goldPerHour - a.hour.gold));
  const x = Math.min(int(d.xp, 1000), Math.max(0, CAPS.xpPerHour - a.hour.xp));
  a.hour.gold += g; a.hour.xp += x; a.pend.gold += g; a.pend.xp += x; a.gold += g; a.xp += x;
  for (const k of STAT_KEYS) if (d[k]) { const v = int(d[k], 100); a.pend.stats[k] = (a.pend.stats[k] || 0) + v; a.stats[k] = (a.stats[k] || 0) + v; }
}
const onKill = (ws, o) => { o = o || {}; const hs = !!o.headshot;
  award(ws, { kills: 1, hs: hs ? 1 : 0, gold: REWARDS.kill.gold + (hs ? REWARDS.headshot.gold : 0), xp: REWARDS.kill.xp + (hs ? REWARDS.headshot.xp : 0) }); };
const onDeath = ws => award(ws, { deaths: 1 });
const onMatchEnd = (ws, won) => award(ws, { matches: 1, wins: won ? 1 : 0,
  gold: REWARDS.match.gold + (won ? REWARDS.win.gold : 0), xp: REWARDS.match.xp + (won ? REWARDS.win.xp : 0) });

/* Запись накопленного в Firestore (поверх значений из базы). */
async function flush(ws) {
  const a = ws && ws.acc; if (!a || !db) return;
  const p = a.pend; if (!p.gold && !p.xp && !Object.keys(p.stats).length) return;
  a.pend = { gold: 0, xp: 0, stats: {} };
  try {
    const ref = db.collection('users').doc(a.uid);
    const res = await db.runTransaction(async tx => {
      const d = (await tx.get(ref)).data() || {};
      const gold = Math.max(0, (d.gold | 0) + p.gold), xp = Math.max(0, (d.xp | 0) + p.xp);
      const stats = Object.assign({}, d.stats || {});
      for (const k in p.stats) stats[k] = (stats[k] || 0) + p.stats[k];
      tx.update(ref, { gold, xp, level: levelInfo(xp).level, stats });
      return { gold, xp, stats };
    });
    a.gold = res.gold; a.xp = res.xp; a.stats = res.stats;
  } catch (e) {                                       // вернуть в очередь, повторим позже
    a.pend.gold += p.gold; a.pend.xp += p.xp;
    for (const k in p.stats) a.pend.stats[k] = (a.pend.stats[k] || 0) + p.stats[k];
    console.error('[accounts] flush error', e.message);
  }
}
const flushAll = () => Promise.all([...BYUID.values()].map(flush));
async function release(ws) { await flush(ws); const a = ws && ws.acc; if (a && BYUID.get(a.uid) === ws) BYUID.delete(a.uid); }

/* Покупка скина: цена берётся из SHOP на сервере, не от клиента. */
async function buy(ws, id) {
  const a = ws && ws.acc; if (!a || !db) return { ok: false, err: 'no-account' };
  id = String(id || '').slice(0, 40);
  const price = SHOP[id]; if (!(price >= 0)) return { ok: false, err: 'unknown-item' };
  await flush(ws);
  try {
    const ref = db.collection('users').doc(a.uid);
    const res = await db.runTransaction(async tx => {
      const d = (await tx.get(ref)).data() || {}, skins = d.skins || [];
      if (skins.includes(id)) throw new Error('owned');
      if ((d.gold | 0) < price) throw new Error('no-gold');
      tx.update(ref, { gold: (d.gold | 0) - price, skins: skins.concat(id) });
      return { gold: (d.gold | 0) - price, skins: skins.concat(id) };
    });
    a.gold = res.gold; a.skins = res.skins;
    return { ok: true, p: publicProfile(a) };
  } catch (e) { return { ok: false, err: e.message }; }
}

/* Команды владельца. Роль берётся из серверной памяти (из Firestore), не от клиента. */
async function adminSet(ws, targetPid, patch) {
  const a = ws && ws.acc; if (!a || a.role !== 'owner' || !db) return { ok: false, err: 'forbidden' };
  const q = await db.collection('users').where('pid', '==', int(targetPid, 1e9)).limit(1).get();
  if (q.empty) return { ok: false, err: 'not-found' };
  const u = {}; patch = patch || {};
  if (typeof patch.verified === 'boolean') u.verified = patch.verified;
  if (patch.gold !== undefined) u.gold = int(patch.gold, 1e9);
  if (patch.xp !== undefined) { u.xp = int(patch.xp, 1e9); u.level = levelInfo(u.xp).level; }
  if (!Object.keys(u).length) return { ok: false, err: 'empty' };
  await q.docs[0].ref.update(u);
  const w = BYUID.get(q.docs[0].id); if (w && w.acc) Object.assign(w.acc, u);
  return { ok: true };
}

module.exports = { init, authenticate, ready, award, onKill, onDeath, onMatchEnd, flush, flushAll, release, buy, adminSet, publicProfile, levelInfo, REWARDS, SHOP };
