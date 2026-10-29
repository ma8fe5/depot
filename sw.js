// Hintergrund-Dienst der Depot-App
// 1. Sofortstart & offline: Die App-Dateien kommen aus dem Speicher des iPhones und werden im
//    Hintergrund aktualisiert. Ob eine neue Version bereitliegt, prüft die App selbst über version.json.
// 2. Morgen-Mitteilung: empfängt den Push, rechnet die Tagesbilanz auf dem iPhone und öffnet beim Antippen die App.

const SPEICHER = 'depot-app-v5'; // v5: Icons unter neuem Namen, Startbild
const DATEIEN = ['index.html', 'manifest.webmanifest', 'icon-mf-180.png', 'icon-mf-192.png', 'icon-mf-512.png', 'icon-mf.svg'];

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
  if (anfrage.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/version.json')) return; // immer frisch aus dem Netz
  const schluessel = anfrage.mode === 'navigate' ? 'index.html' : anfrage;

  event.respondWith((async () => {
    const speicher = await caches.open(SPEICHER);
    const vorhanden = await speicher.match(schluessel);
    // Seitenaufrufe (mode "navigate") lassen sich nicht mit Optionen weiterreichen -> per Adresse neu anfragen
    const netz = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(async (antwort) => {
      if (antwort.ok) await speicher.put(schluessel, antwort.clone());
      return antwort;
    }).catch(() => null);
    if (vorhanden) {
      event.waitUntil(netz);
      return vorhanden;
    }
    return (await netz) || new Response('Offline', { status: 503 });
  })());
});

// ---------- Tagesbilanz mit echten Zahlen ----------
// Der Vermittler schickt nur ein Wecksignal (Titel „Depot“). Das iPhone holt die Kurse und rechnet mit der
// Bestandskopie, die die App verschlüsselt in IndexedDB ablegt (eigener Schlüssel, ohne Face ID nutzbar).
// Klappt etwas nicht, erscheint der neutrale Text aus dem Wecksignal.

function idb(aktion) {
  return new Promise((ok, fehler) => {
    const r = indexedDB.open('depot-mitteilung', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => fehler(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', 'readonly');
      const anfrage = aktion(tx.objectStore('kv'));
      anfrage.onsuccess = () => ok(anfrage.result);
      anfrage.onerror = () => fehler(anfrage.error);
    };
  });
}

async function bestandLesen() {
  const schluessel = await idb((s) => s.get('schluessel'));
  const stand = await idb((s) => s.get('stand'));
  if (!schluessel || !stand) throw new Error('keine Bestandskopie');
  const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const klar = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stand.iv) }, schluessel, unb64(stand.daten));
  return JSON.parse(new TextDecoder().decode(klar));
}

async function tagesbilanz() {
  const b = await bestandLesen();
  const r = await fetch(`${b.vermittler.replace(/\/$/, '')}/quotes?s=${b.symbole.join(',')}`,
    b.token ? { headers: { 'X-Depot-Token': b.token } } : undefined);
  if (!r.ok) throw new Error(`Vermittler ${r.status}`);
  const kurse = (await r.json()).kurse || {};
  let wert = 0, aend = 0, vorherWert = 0;
  const zeilen = [];
  for (const p of b.positionen) {
    let eur, vorher = null;
    if (p.quelle === 'coingecko') {
      try {
        const j = (await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${p.symbol}&vs_currencies=eur&include_24hr_change=true`)).json())[p.symbol];
        eur = j.eur;
        if (j.eur_24h_change != null) vorher = j.eur / (1 + j.eur_24h_change / 100);
      } catch { continue; }
    } else {
      const k = kurse[p.symbol];
      if (!k || k.fehler || k.schluss == null) continue;
      let f = 1;
      if (p.waehrung && p.waehrung !== 'EUR') {
        const fx = kurse[`EUR${p.waehrung}.FOREX`];
        if (!fx || fx.fehler) continue;
        f = 1 / fx.schluss; // Vortag mit demselben Wechselkurs, wie in der App
      }
      eur = k.schluss * f;
      if (k.vorher != null) vorher = k.vorher * f;
    }
    wert += p.stueck * eur;
    if (vorher) {
      aend += p.stueck * (eur - vorher);
      vorherWert += p.stueck * vorher;
      zeilen.push({ name: p.name, pct: (eur / vorher - 1) * 100 });
    }
  }
  if (!zeilen.length) throw new Error('keine Kurse');
  const geld = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const geldRund = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const zahl = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const vz = (n) => (n > 0 ? '+' : '');
  const prozent = (n) => `${vz(n)}${zahl.format(n)}%`;
  const zeile1 = `${vz(aend)}${geld.format(aend)} ggü. Vortag (${prozent(vorherWert ? (aend / vorherWert) * 100 : 0)})`;
  const zeile2 = `Gesamt: ${geldRund.format(wert + (b.tagesgeld || 0))}`;
  return `${zeile1}\n${zeile2}`;
}

const mitFrist = (versprechen, ms) => Promise.race([versprechen, new Promise((_, nein) => setTimeout(() => nein(new Error('Zeit')), ms))]);

self.addEventListener('push', (event) => {
  let nachricht = { titel: 'Depot', text: 'Deine Tagesbilanz ist da.' };
  try {
    if (event.data) nachricht = event.data.json();
  } catch (e) {
    // unlesbare Nachricht: Standardtext zeigen
  }
  event.waitUntil((async () => {
    let text = nachricht.text;
    // „Depot“ = Tagesbilanz (auch der Test aus den Einstellungen); Termine haben eigene Titel und kommen unverändert
    if (nachricht.titel === 'Depot') {
      try { text = await mitFrist(tagesbilanz(), 20000); } catch (e) { /* neutraler Text bleibt */ }
    }
    // iOS zeigt den App-Namen „DEPOT“ schon im Kopf – als Titel daher nicht noch einmal „Depot“
    await self.registration.showNotification(nachricht.titel === 'Depot' ? 'Tagesbilanz' : nachricht.titel, {
      body: text,
      icon: 'icon-mf-180.png',
      tag: nachricht.titel === 'Depot' ? 'depot-morgen' : `depot-${nachricht.titel}`,
      data: nachricht.titel === 'Depot' ? { ziel: 'tops' } : {},
    });
  })());
});

// Antippen der Tagesbilanz springt zu Tops & Lows (offene App per Nachricht, sonst per ?ziel=)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ziel = (event.notification.data || {}).ziel;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => {
    for (const f of fenster) {
      if (!('focus' in f)) continue;
      if (ziel) f.postMessage({ ziel });
      return f.focus();
    }
    return self.clients.openWindow(ziel ? `./?ziel=${ziel}` : './');
  }));
});
