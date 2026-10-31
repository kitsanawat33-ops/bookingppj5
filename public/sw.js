// Service Worker — ระบบยื่นคำร้องแก้ไขผลการเรียน
// หลักการ: ไฟล์หน้าเว็บของเราใช้ "network-first" (ได้เวอร์ชันล่าสุดทุกครั้งที่ออนไลน์ ออฟไลน์จึงใช้สำเนา)
// ไม่แคชข้อมูล Firestore / Apps Script / การเข้าสู่ระบบ (ข้อมูลต้องสดและเป็นส่วนตัว)
const VERSION = 'v4';
const SHELL = 'gf-shell-' + VERSION;
const LIBS = 'gf-libs-' + VERSION;
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/app.js', '/fb.js', '/config.js', '/pp6.js',
  '/manifest.webmanifest', '/icons/icon-192-v3.png', '/icons/icon-512-v3.png', '/offline.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== LIBS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ไฟล์ของเว็บนี้ (ยกเว้นระบบเข้าสู่ระบบของ Firebase /__/)
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/__/')) return;
    if (url.pathname.startsWith('/vendor/')) { e.respondWith(cacheFirst(req, LIBS)); return; }   // pdf.js ขนาดใหญ่ ไม่เปลี่ยนบ่อย
    e.respondWith(networkFirst(req));
    return;
  }
  // Firebase SDK (ระบุเวอร์ชันใน URL) และฟอนต์ → เก็บไว้ใช้ซ้ำ
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) { e.respondWith(cacheFirst(req, LIBS)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(cacheFirst(req, LIBS)); return; }
  // อย่างอื่น (Firestore, Google Sign-in, Apps Script) ปล่อยผ่านตามปกติ
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res.ok && res.type === 'basic') cache.put(stripQuery(req), res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(stripQuery(req));
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('/')) || (await cache.match('/offline.html'));
    throw err;
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

// หน้าแรกเปิดได้ทั้ง /?source=pwa และ /#... → ใช้สำเนาเดียวกัน
function stripQuery(req) {
  const u = new URL(req.url);
  if (req.mode === 'navigate') return new Request(u.origin + '/');
  u.search = '';
  return new Request(u.href);
}
