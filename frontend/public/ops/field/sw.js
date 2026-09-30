// PKB Field — keeps the page usable without signal: the page, the field manual and the
// Supabase library are cached; the reports themselves wait in the phone's outbox (IndexedDB).
const CACHE = 'pkb-field-v1';
const SHELL = ['/ops/field/', '/ops/field/manual.json', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const shell = (u.origin === location.origin && u.pathname.startsWith('/ops/field/')) || u.hostname === 'cdn.jsdelivr.net' || u.hostname.endsWith('fonts.googleapis.com') || u.hostname.endsWith('fonts.gstatic.com');
  if (!shell) return;   // Supabase API / storage: always the network
  // network first (fresh page when online), cache when offline
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/ops/field/'))));
});
