// 3UK Philippines customer app: installable website. Pages are always loaded fresh
// (network first); a saved copy is shown only when offline. Admin, API and webhooks are never touched.
const CACHE = "3ukph-site-v1";
const SHELL = ["/", "/chat", "/logo.png", "/favicon.png", "/app/icon-192.png", "/app/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("3ukph-site-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/(admin|api|webhook|whatsapp|qr|data|check-data|usage)/.test(url.pathname)) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname === "/chat" ? "/chat" : "/", copy)).catch(() => {}); return r; })
      .catch(() => caches.match(url.pathname === "/chat" ? "/chat" : "/")));
    return;
  }
  if (/\.(png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return r; })));
  }
});
