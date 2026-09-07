const CACHE = 'stagedrums-v5';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './drums.js', './parser.js', './sync.js', './midi.js', './mixer.js', './mixer-ui.js', './gate-worklet.js', './manifest.json', './icon.svg', './songs/index.json', './version.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol.startsWith('ws')) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('version.json')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
