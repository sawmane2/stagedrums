const CACHE = 'stagedrums-v15';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './drums.js', './parser.js', './sync.js', './midi.js', './instruments.js', './mixer.js', './mixer-ui.js', './gate-worklet.js', './effects.js', './pitch.js', './keyshift-worker.js', './vendor/soundtouch.js', './manifest.json', './icon.svg', './songs/index.json', './version.json', './kits/index.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ASSETS);
    try { const kit = await (await fetch('./kits/rock/kit.json')).json(); const files = ['./kits/rock/kit.json'];
      for (const i of Object.values(kit.instruments)) for (const l of i.layers) for (const f of l.files) files.push('./kits/rock/' + f);
      await c.addAll(files); } catch {}
  }).then(() => self.skipWaiting()));
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
