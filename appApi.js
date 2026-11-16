// appApi.js
//
// API for the 3UK Philippines mobile app (Android, built from /mobile).
// Customers sign in with their email and a 6-digit code (no password), buy plans through PayMongo,
// and see every eSIM delivered to their email (QR / activation code, data left).
//
//   POST /api/app/login/start   { email }          -> emails a 6-digit code
//   POST /api/app/login/verify  { email, code }    -> { token, user }
//   GET  /api/app/me                               -> { user }
//   POST /api/app/me            { name }           -> { user }
//   POST /api/app/logout
//   POST /api/app/delete-account                   -> deletes the account (Google Play requires this)
//   POST /api/app/checkout      { planId }         -> { url }  PayMongo checkout page
//   GET  /api/app/orders                           -> recent app orders with status
//   GET  /api/app/esims                            -> eSIMs delivered to this email
// The app also uses the public /api/plans, /api/destinations, /api/popular and /api/data-check.
//
// Render settings (optional):
//   APP_REVIEW_EMAIL / APP_REVIEW_CODE : a fixed sign-in for Google Play's app reviewers (no email is sent).

const crypto = require("crypto");

const SESSION_DAYS = 180;
const APP_ORIGINS = new Set(["https://localhost", "http://localhost", "capacitor://localhost"]);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 120);
// One stable buyer id per email. The "web_" prefix makes the bot treat it like a website buyer:
// no chat messages, the eSIM is delivered by email (and shown in the app).
const buyerOf = (email) => "web_" + sha("app:" + normEmail(email)).slice(0, 24);

function install(app, deps) {
  const { redis, hasDb, mailer, esims, pm, getPlan, getRawPlan, reseller, publicUrl, pmSaveOrder, pmGetOrder, notifyAdmin, express } = deps;
  const mem = new Map(); // fallback store (tests / no database): key -> { v, exp }
  const db = {
    async get(k) { if (hasDb()) return redis(["GET", k]); const e = mem.get(k); if (!e || (e.exp && e.exp < Date.now())) { mem.delete(k); return null; } return e.v; },
    async set(k, v, sec) { if (hasDb()) return redis(sec ? ["SET", k, v, "EX", String(sec)] : ["SET", k, v]); mem.set(k, { v, exp: sec ? Date.now() + sec * 1000 : 0 }); },
    async del(...k) { if (hasDb()) return redis(["DEL", ...k]); k.forEach((x) => mem.delete(x)); },
    async incr(k, sec) {
      if (hasDb()) { const n = Number(await redis(["INCR", k])); if (n === 1) await redis(["EXPIRE", k, String(sec)]); return n; }
      const n = Number((await db.get(k)) || 0) + 1; const e = mem.get(k); mem.set(k, { v: String(n), exp: e && e.exp ? e.exp : Date.now() + sec * 1000 }); return n;
    },
    async lpush(k, v, max) { if (hasDb()) { await redis(["LPUSH", k, v]); await redis(["LTRIM", k, "0", String(max - 1)]); return; } const a = JSON.parse((await db.get(k)) || "[]"); a.unshift(v); mem.set(k, { v: JSON.stringify(a.slice(0, max)), exp: 0 }); },
    async lrange(k) { if (hasDb()) return (await redis(["LRANGE", k, "0", "-1"])) || []; return JSON.parse((await db.get(k)) || "[]"); },
    async sadd(k, v) { if (hasDb()) return redis(["SADD", k, v]); const a = new Set(JSON.parse((await db.get(k)) || "[]")); a.add(v); mem.set(k, { v: JSON.stringify([...a]), exp: 0 }); },
    async smembers(k) { if (hasDb()) return (await redis(["SMEMBERS", k])) || []; return JSON.parse((await db.get(k)) || "[]"); }
  };

  // CORS for the app (its pages load from https://localhost inside the Android WebView).
  app.use("/api", (req, res, next) => {
    const o = req.headers.origin;
    if (o && APP_ORIGINS.has(o)) {
      res.set("Access-Control-Allow-Origin", o);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Max-Age", "86400");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });
  const json = express.json({ limit: "10kb" });

  const ipHits = new Map();
  function ipLimited(req, max, windowMin) {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const now = Date.now(), key = ip + ":" + max;
    const hits = (ipHits.get(key) || []).filter((t) => now - t < windowMin * 60000);
    if (hits.length >= max) return true;
    hits.push(now); ipHits.set(key, hits);
    if (ipHits.size > 5000) ipHits.clear();
    return false;
  }

  async function getUser(email) {
    const v = await db.get(`app:user:${email}`);
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }
  async function saveUser(u) { await db.set(`app:user:${u.email}`, JSON.stringify(u)); return u; }
  const publicUser = (u) => ({ email: u.email, name: u.name || "", since: u.createdAt });

  async function auth(req, res, next) {
    try {
      const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      if (!/^[a-f0-9]{64}$/.test(t)) return res.status(401).json({ error: "Please sign in again." });
      const email = await db.get(`app:sess:${sha(t)}`);
      if (!email) return res.status(401).json({ error: "Please sign in again." });
      const user = await getUser(email);
      if (!user) return res.status(401).json({ error: "Please sign in again." });
      req.appUser = user; req.appToken = t;
      next();
    } catch (e) {
      console.error("[app] auth:", e.message);
      res.status(503).json({ error: "We couldn't reach our server. Please try again." });
    }
  }

  const REVIEW_EMAIL = normEmail(process.env.APP_REVIEW_EMAIL || "");
  const REVIEW_CODE = String(process.env.APP_REVIEW_CODE || "").trim();

  app.post("/api/app/login/start", json, async (req, res) => {
    try {
      const email = normEmail(req.body && req.body.email);
      if (!mailer.validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (REVIEW_EMAIL && email === REVIEW_EMAIL && /^\d{6}$/.test(REVIEW_CODE)) return res.json({ ok: true });
      if (ipLimited(req, 10, 10)) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes." });
      if ((await db.incr(`app:otprate:${email}`, 3600)) > 5) return res.status(429).json({ error: "Too many codes requested for this email. Please try again in an hour." });
      if (!mailer.configured()) return res.status(503).json({ error: "Sign-in is temporarily unavailable. Please message us on WhatsApp." });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      await db.set(`app:otp:${email}`, JSON.stringify({ h: sha(email + ":" + code), tries: 0 }), 600);
      await mailer.sendLoginCode(email, code);
      res.json({ ok: true });
    } catch (e) {
      console.error("[app] login start:", e.message);
      res.status(502).json({ error: "We couldn't send the code. Please check the email address and try again." });
    }
  });

  app.post("/api/app/login/verify", json, async (req, res) => {
    try {
      const email = normEmail(req.body && req.body.email);
      const code = String((req.body && req.body.code) || "").replace(/\D/g, "");
      if (!mailer.validEmail(email) || code.length !== 6) return res.status(400).json({ error: "Please enter the 6-digit code from your email." });
      if (ipLimited(req, 30, 10)) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes." });
      let ok = false;
      if (REVIEW_EMAIL && email === REVIEW_EMAIL && /^\d{6}$/.test(REVIEW_CODE)) ok = code === REVIEW_CODE;
      else {
        const v = await db.get(`app:otp:${email}`);
        let rec = null; try { rec = v ? JSON.parse(v) : null; } catch { rec = null; }
        if (!rec) return res.status(400).json({ error: "This code has expired. Please ask for a new one." });
        ok = crypto.timingSafeEqual(Buffer.from(rec.h), Buffer.from(sha(email + ":" + code)));
        if (!ok) {
          rec.tries = (rec.tries || 0) + 1;
          if (rec.tries >= 5) { await db.del(`app:otp:${email}`); return res.status(400).json({ error: "Too many wrong codes. Please ask for a new one." }); }
          await db.set(`app:otp:${email}`, JSON.stringify(rec), 600);
        } else await db.del(`app:otp:${email}`);
      }
      if (!ok) return res.status(400).json({ error: "That code isn't right. Please check your email and try again." });
      let user = await getUser(email);
      const isNew = !user;
      if (!user) user = await saveUser({ email, name: "", createdAt: new Date().toISOString(), buyer: buyerOf(email) });
      const token = crypto.randomBytes(32).toString("hex");
      await db.set(`app:sess:${sha(token)}`, email, SESSION_DAYS * 86400);
      await db.sadd(`app:sessions:${email}`, sha(token));
      if (isNew) notifyAdmin({ title: "New app account 📱", message: email, tags: "iphone" }).catch(() => {});
      res.json({ ok: true, token, user: publicUser(user), isNew });
    } catch (e) {
      console.error("[app] login verify:", e.message);
      res.status(503).json({ error: "We couldn't sign you in right now. Please try again." });
    }
  });

  app.get("/api/app/me", auth, (req, res) => res.json({ user: publicUser(req.appUser) }));
  app.post("/api/app/me", json, auth, async (req, res) => {
    const name = String((req.body && req.body.name) || "").replace(/[<>]/g, "").trim().slice(0, 60);
    const u = await saveUser({ ...req.appUser, name });
    res.json({ user: publicUser(u) });
  });
  app.post("/api/app/logout", auth, async (req, res) => { await db.del(`app:sess:${sha(req.appToken)}`); res.json({ ok: true }); });
  app.post("/api/app/delete-account", auth, async (req, res) => {
    try {
      const email = req.appUser.email;
      const sessions = await db.smembers(`app:sessions:${email}`);
      await db.del(`app:user:${email}`, `app:sessions:${email}`, `app:orders:${email}`, ...sessions.map((h) => `app:sess:${h}`));
      notifyAdmin({ title: "App account deleted", message: email, tags: "wastebasket" }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { res.status(503).json({ error: "Couldn't delete the account right now. Please try again." }); }
  });

  app.post("/api/app/checkout", json, auth, async (req, res) => {
    try {
      if (ipLimited(req, 12, 10)) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes." });
      const user = req.appUser;
      if (!pm.configured() || pm.isTest() || !publicUrl || !mailer.configured()) return res.status(503).json({ error: "Online payment is not available right now. Please message us on WhatsApp to order." });
      const plan = getPlan(String((req.body && req.body.planId) || ""));
      if (!plan || !(plan.pricePHP > 0)) return res.status(404).json({ error: "This plan is no longer available. Please choose another one." });
      if (esims.configured()) {
        const raw0 = getRawPlan(plan.planId);
        const pk0 = await esims.findPackage(plan.name, { retailUSD: raw0 && raw0.retailPrice, costUSD: reseller.costOf(raw0), packageId: raw0 && raw0.packageId }).catch(() => undefined);
        if (pk0 === null) return res.status(409).json({ error: "This exact plan is temporarily unavailable. Please choose another plan." });
      }
      const buyer = user.buyer || buyerOf(user.email);
      const name = user.name || user.email.split("@")[0];
      const now = Date.now();
      const ref = "3UK-A" + now.toString(36).toUpperCase();
      if (hasDb()) await redis(["SET", `web:buyer:${buyer}`, JSON.stringify({ name, email: user.email, partner: null, at: now, app: true }), "EX", String(400 * 86400)]);
      const planLabel = `${plan.name} (${plan.destination}, ${plan.data}, ${plan.validityDays} days${plan.callsAndTexts ? ", with calls & texts" : ""})`;
      const co = await pm.createCheckout({
        amountPHP: plan.pricePHP, name: `eSIM ${plan.name}`, description: `3UK Philippines eSIM: ${planLabel}`,
        reference: ref, successUrl: `${publicUrl}/paid?web=1&app=1`, cancelUrl: `${publicUrl}/paid?app=1&cancel=1`,
        metadata: { ref, psid: buyer, kind: "web" }, types: pm.methods()
      });
      await pmSaveOrder(co.id, { kind: "web", ref, psid: buyer, planId: plan.planId, planName: plan.name, planLabel, pricePHP: plan.pricePHP, amount: co.amount,
        email: user.email, method: "App checkout", reseller: false, discount: null, createdAt: now, status: "pending", quantity: 1, partner: null });
      await db.lpush(`app:orders:${user.email}`, JSON.stringify({ id: co.id, ref, planId: plan.planId, plan: plan.name, label: planLabel, pricePHP: plan.pricePHP, at: new Date(now).toISOString() }), 50);
      notifyAdmin({ title: `App checkout started: ${plan.price}`, tags: "iphone", message: `${name} (${user.email})\n${planLabel}\nRef ${ref}\nDelivered by email + app automatically when paid.` }).catch(() => {});
      res.json({ ok: true, url: co.url, ref });
    } catch (e) {
      console.error("[app] checkout:", e.message);
      res.status(500).json({ error: "Couldn't start the payment. Please try again." });
    }
  });

  app.get("/api/app/orders", auth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const rows = (await db.lrange(`app:orders:${req.appUser.email}`)).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    const out = await Promise.all(rows.map(async (r) => {
      const o = await pmGetOrder(r.id).catch(() => null);
      const st = String((o && o.status) || "").toLowerCase();
      const status = /deliver|done|complete/.test(st) ? "delivered" : /paid|process/.test(st) ? "processing" : /manual|fail|error|check|admin/.test(st) ? "checking" : /expire|cancel/.test(st) ? "cancelled" : "pending";
      return { ref: r.ref, plan: r.plan, label: r.label, pricePHP: r.pricePHP, at: r.at, status };
    }));
    res.json({ orders: out });
  });

  const lpaCache = new Map();
  async function lpaOf(rec) {
    if (rec.lpa) return rec.lpa;
    if (lpaCache.has(rec.iccid)) return lpaCache.get(rec.iccid);
    let lpa = null;
    try { const f = await esims.findEntry(rec.iccid); if (f && f.found) lpa = esims.simInfo(f.entry).lpa || null; } catch (_) { lpa = null; }
    if (lpa) lpaCache.set(rec.iccid, lpa);
    return lpa;
  }
  app.get("/api/app/esims", auth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const u = req.appUser;
      const lists = await Promise.all([esims.listEsims(u.buyer || buyerOf(u.email)).catch(() => []), esims.listEsims("email:" + u.email).catch(() => [])]);
      const seen = new Map();
      for (const r of [].concat(...lists)) if (r && r.iccid && !seen.has(r.iccid)) seen.set(r.iccid, r);
      const recs = [...seen.values()].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || ""))).slice(0, 40);
      const out = await Promise.all(recs.map(async (r) => {
        const lpa = await lpaOf(r);
        const m = /^LPA:1\$([^$]+)\$(.+)$/i.exec(lpa || "");
        return { iccid: r.iccid, plan: r.plan || "", addedAt: r.addedAt || null, lpa: lpa || null, smdp: m ? m[1] : null, activationCode: m ? m[2] : null };
      }));
      res.json({ esims: out });
    } catch (e) {
      console.error("[app] esims:", e.message);
      res.status(503).json({ error: "Couldn't load your eSIMs right now. Please try again." });
    }
  });

  return { buyerOf };
}

module.exports = { install, buyerOf, normEmail };
