/* Service worker do BodyEvo: guarda o app no aparelho para abrir offline e recebe as notificações.
   A cada mudança em qualquer arquivo do app, aumente a VERSAO para o celular baixar a versão nova. */
const VERSAO = 'bodyevo-v6';

const ARQUIVOS = [
  './',
  './index.html',
  './style.css',
  './regras.js',
  './app.js',
  './manifest.json',
  './vendor/supabase.min.js',
  './vendor/xlsx.full.min.js',
  './fonts/plus-jakarta-sans-latin-wght-normal.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSAO)
      .then((cache) => cache.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Só cuida de GETs do próprio app. Supabase e api/ (outros domínios) nunca vão para o cache.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Abrir o app: tenta a rede (para pegar atualizações) e cai no cache se estiver offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .then((res) => {
          // Uma resposta de erro nunca pode substituir o app guardado para uso offline.
          if (res.ok) {
            const copia = res.clone();
            caches.open(VERSAO).then((c) => c.put('./index.html', copia));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Demais arquivos: rede primeiro (o GitHub Pages guarda cache HTTP por 10 min), cache se offline.
  event.respondWith(
    fetch(req.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.tipo === 'versao' && event.source) {
    event.source.postMessage({ tipo: 'versao', versao: VERSAO });
  }
});

/* ---------- Notificações (enviadas pela api/ com pywebpush) ---------- */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'BodyEvo', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'rumo',
    data: { url: d.url || './#hoje', abrir: d.abrir || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const dados = event.notification.data || {};
  const url = new URL(dados.url || './#hoje', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if ('focus' in c) {
          if (dados.abrir) c.postMessage({ tipo: 'abrir', abrir: dados.abrir });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
