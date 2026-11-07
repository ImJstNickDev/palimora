/* Public application shell and Web Push. Private API data is never cached. */
self.addEventListener('push', event => {
  let language = 'it';
  try { if (event.data?.json().language === 'en') language = 'en'; } catch {}
  event.waitUntil(self.registration.showNotification('Palimora', {
    body: language === 'en' ? 'New notifications' : 'Nuove notifiche', tag: 'palimora-notifications',
    data: {url: '/notifications'}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows => {
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
    if(existing){await existing.navigate('/notifications');return existing.focus();}
    return self.clients.openWindow('/notifications');
  }));
});

// Build replaces these constants with the exact public application assets.
const APP_VERSION = '__PALIMORA_BUILD__';
const APP_FILES = /* PALIMORA_FILES */ [];
const APP_CACHE = 'palimora-shell-' + APP_VERSION;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(APP_FILES.map(url => new Request(url, {credentials:'omit', cache:'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = (await caches.keys()).filter(name=>name.startsWith('palimora-shell-'));
    // Retain the immediately previous shell while other tabs finish reloading.
    for (const name of names.filter(name=>name!==APP_CACHE).slice(0,-1)) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(APP_CACHE).then(cache=>cache.match('/index.html')).then(response=>response || fetch(event.request)));
  } else if (!url.search && APP_FILES.includes(url.pathname)) {
    event.respondWith(caches.open(APP_CACHE).then(cache=>cache.match(url.pathname)).then(response=>response || fetch(event.request)));
  }
});
