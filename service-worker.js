/* StandCarvix PWA service worker.
   - Игра (index.html) кэшируется: сначала сеть, при отсутствии сети — кэш.
   - Firebase Auth / Firestore / WebSocket-сервер НЕ перехватываются.
   - Кэшируются только three.js (cdnjs), шрифты Google и скрипты Firebase SDK.
   Чтобы выпустить обновление, поменяйте номер версии в CACHE. */
const CACHE = 'standcarvix-v1';
const SHELL = ['index.html', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
const RUNTIME_HOSTS = [
  ['cdnjs.cloudflare.com', '/ajax/libs/three.js/'],
  ['fonts.googleapis.com', '/'],
  ['fonts.gstatic.com', '/'],
  ['www.gstatic.com', '/firebasejs/']
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/__/') === 0) return;               // служебные адреса Firebase Auth — не трогаем
    if (req.mode === 'navigate') {                                // страница игры: сеть → кэш
      e.respondWith(fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); }
        return res;
      }).catch(() => caches.match('index.html')));
      return;
    }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  /* чужие адреса: кэшируем только разрешённые библиотеки/шрифты, остальное (Google вход, Firestore, API) идёт напрямую */
  if (!RUNTIME_HOSTS.some(h => url.hostname === h[0] && url.pathname.indexOf(h[1]) === 0)) return;
  e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
