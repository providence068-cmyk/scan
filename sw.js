// オフラインでも開けるように、アプリ本体と部品（数式表示・PDF・オフライン読み取り）をiPhoneに保存しておく
const APP = 'scan-app-v2';
const SHELL = ['./', './index.html', './detector.js', './detect-worker.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== 'scan-cdn').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname === 'api.anthropic.com') return; // Claudeへの通信はそのまま
  if (u.origin === location.origin){
    // アプリ本体：ネット優先（更新をすぐ反映）、つながらなければ保存分
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(APP).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
    return;
  }
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|tessdata/.test(u.hostname + u.pathname)){
    // 部品：一度取得したら保存分を使う
    e.respondWith(caches.open('scan-cdn').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
  }
});
