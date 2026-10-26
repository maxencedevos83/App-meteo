// Hors ligne : l'interface est servie depuis le cache, les données toujours depuis le réseau si possible.
const CACHE = 'meteo-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/ensemble.js', 'js/sources.js', 'js/forecast.js', 'js/alerts.js', 'js/activities.js', 'js/scene.js', 'manifest.webmanifest', 'icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Réseau d'abord, cache en secours : la prévision la plus récente reste prioritaire.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
