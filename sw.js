// Bump the number on EVERY change so phones pick up the new version.
const CACHE='pt-schedule-v15';
const SHELL=['./','./index.html','./manifest.webmanifest'];

self.addEventListener('install',e=>e.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())
));

self.addEventListener('activate',e=>e.waitUntil(
  caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));

// Network first, cache as offline fallback. Only same-origin GETs are cached,
// so Firebase/Google Fonts requests go straight to the network.
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'||new URL(req.url).origin!==location.origin)return;
  e.respondWith(
    fetch(req).then(r=>{
      if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(req,copy));}
      return r;
    }).catch(()=>caches.match(req).then(m=>m||caches.match('./index.html')))
  );
});
