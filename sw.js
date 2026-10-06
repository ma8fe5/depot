// Hintergrund-Dienst der Depot-App: empfängt die Morgen-Mitteilung und öffnet beim Antippen die App.
// Die Mitteilung enthält keine Depotdaten.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
