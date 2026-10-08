// Hintergrund-Dienst der Depot-App
// 1. Sofortstart & offline: Die App-Dateien kommen aus dem Speicher des iPhones, im Hintergrund wird
//    geprüft, ob es eine neuere Version gibt. Ist eine da, bekommt die App Bescheid.
// 2. Morgen-Mitteilung: empfängt den Push und öffnet beim Antippen die App (ohne Depotdaten).

const SPEICHER = 'depot-app-v1';
const DATEIEN = ['index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SPEICHER).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SPEICHER) await caches.delete(name);
    await self.clients.claim();
  })());
});

// Nur eigene Dateien zwischenspeichern; Kurse, Vermittler und CoinGecko laufen immer übers Netz
self.addEventListener('fetch', (event) => {
  const anfrage = event.request;
  const url = new URL(anfrage.url);
  if (anfrage.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  const schluessel = anfrage.mode === 'navigate' ? 'index.html' : anfrage;

  event.respondWith((async () => {
    const speicher = await caches.open(SPEICHER);
    const vorhanden = await speicher.match(schluessel);
    const netz = fetch(anfrage, { cache: 'no-cache' }).then(async (antwort) => {
      if (antwort.ok) {
        const alt = vorhanden && vorhanden.headers.get('etag');
        const neu = antwort.headers.get('etag');
        await speicher.put(schluessel, antwort.clone());
        // neue Version der App liegt bereit -> offene Fenster informieren
        if (vorhanden && alt && neu && alt !== neu && schluessel === 'index.html') {
          for (const f of await self.clients.matchAll({ type: 'window' })) f.postMessage({ typ: 'neue-version' });
        }
      }
      return antwort;
    }).catch(() => null);
    if (vorhanden) {
      event.waitUntil(netz);
      return vorhanden;
    }
    return (await netz) || new Response('Offline', { status: 503 });
  })());
});

self.addEventListener('push', (event) => {
  let nachricht = { titel: 'Depot', text: 'Deine Tagesbilanz ist da.' };
  try {
    if (event.data) nachricht = event.data.json();
  } catch (e) {
    // unlesbare Nachricht: Standardtext zeigen
  }
  event.waitUntil(self.registration.showNotification(nachricht.titel, {
    body: nachricht.text,
    icon: 'icon-180.png',
    tag: 'depot-morgen',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => {
    for (const f of fenster) if ('focus' in f) return f.focus();
    return self.clients.openWindow('./');
  }));
});
