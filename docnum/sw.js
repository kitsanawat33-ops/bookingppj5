/* Service worker: เก็บเปลือกแอปไว้ในเครื่อง ให้เปิดได้เร็วและแสดงหน้าออฟไลน์ได้
 * ข้อมูลจริงมาจาก Apps Script ผ่านอินเทอร์เน็ตเสมอ (ไม่แคช) */
const CACHE = 'docnum-shell-v2';
const SHELL = [
  './', './index.html', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png',
  './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // network-first: ได้ไฟล์ใหม่เมื่อออนไลน์ ใช้แคชเมื่อออฟไลน์
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
