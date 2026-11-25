// affiliates.js
//
// Open affiliate program: anyone can sign up at 3ukph.com/affiliate, get their own code and links,
// and earn a commission (AFFILIATE_PCT, default 5%) on every PAID order from customers they bring.
// Approved automatically. Commission is paid monthly by GCash/Maya once it reaches AFFILIATE_MIN_PAYOUT
// (default ₱500). No commission on the affiliate's own purchases. Customers get no extra discount.
//
// Tracking reuses partners.js: an affiliate code works exactly like a partner code
//   - 3ukph.com/r/CODE      (counts a click, opens the website, chats carry "Partner: CODE")
//   - m.me/<page>?ref=CODE  (Messenger)
//   - wa.me/...?text=...CODE (WhatsApp: the code typed in the first message)
//
// Pages / API:
//   /affiliate                          sign-up + dashboard (one page)
//   POST /api/affiliate/signup          create affiliate, returns code + links + login token
//   POST /api/affiliate/login/start     email a 6-digit code
//   POST /api/affiliate/login/verify    -> token
//   GET  /api/affiliate/me              stats for the signed-in affiliate (Bearer token)
//   POST /api/affiliate/me              update payout details
//   GET  /r/:code                       click tracker + redirect
//   GET  /admin/api/affiliates?month=   list with month commission and payout status
//   POST /admin/api/affiliates/paid     { code, month, amountPHP, note } mark a payout as sent
//   POST /admin/api/affiliates/status   { code, status: "active"|"paused" }

const crypto = require("crypto");
const path = require("path");

const PCT = Number(process.env.AFFILIATE_PCT ?? 5);
const MIN_PAYOUT = Number(process.env.AFFILIATE_MIN_PAYOUT ?? 500);
const SITE = "https://3ukph.com";
const PAGE_ID = "103294518884622";
const WA = "639347069356";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);
const manilaMonth = (t = Date.now()) => new Date(t + 8 * 3600000).toISOString().slice(0, 7);
const digits = (s) => String(s || "").replace(/\D/g, "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// +63 917 123 4567 / 09171234567 -> 639171234567
function intlMobile(m) {
  let d = digits(m);
  if (d.startsWith("0") && d.length === 11) d = "63" + d.slice(1);
  if (d.length === 10 && d.startsWith("9")) d = "63" + d;
  return d.length >= 10 && d.length <= 15 ? d : "";
}

function linksFor(code) {
  return {
    website: `${SITE}/r/${code}`,
    messenger: `https://m.me/${PAGE_ID}?ref=${code}`,
    whatsapp: `https://wa.me/${WA}?text=${encodeURIComponent(`Hi 3UK Philippines! I'd like to get an eSIM. (Ref: ${code})`)}`
  };
}

function install(app, { redis, hasDb, mailer, partners, requireAdmin, express, notifyAdmin, reservedCodes }) {
  const R = (cmd) => redis(cmd);
  const getAff = async (code) => { const v = await R(["GET", `aff:${partners.norm(code)}`]).catch(() => null); try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const saveAff = async (a) => { await R(["SET", `aff:${a.code}`, JSON.stringify(a)]); partners.addDynamic(toPartner(a)); };
  const toPartner = (a) => ({ code: a.code, name: `Affiliate ${a.code}`, person: a.name, pct: a.pct, email: a.email, selfIds: a.mobile ? ["wa" + a.mobile] : [], status: a.status, affiliate: true });

  // Load every affiliate into partners.js at startup (and every 10 minutes, in case another instance added one).
  async function loadAll() {
    if (!hasDb()) return;
    const codes = (await R(["SMEMBERS", "aff:all"]).catch(() => [])) || [];
    for (const c of codes) { const a = await getAff(c); if (a) partners.addDynamic(toPartner(a)); }
    if (codes.length) console.log(`[affiliates] loaded ${codes.length}`);
  }
  loadAll().catch((e) => console.error("[affiliates] load:", e.message));
  setInterval(() => loadAll().catch(() => {}), 10 * 60 * 1000).unref?.();

  async function newCode(name) {
    const base = (String(name || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || "UK").padEnd(2, "K");
    for (let i = 0; i < 30; i++) {
      const code = base + String(100 + crypto.randomInt(900));
      if (partners.getAny(code) || (reservedCodes && reservedCodes(code))) continue;
      if (await R(["EXISTS", `aff:${code}`]).catch(() => 0)) continue;
      return code;
    }
    throw new Error("Could not create a code, please try again.");
  }

  async function rateLimit(req, key, max, sec) {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const k = `aff:rl:${key}:${sha(ip).slice(0, 16)}`;
    const n = await R(["INCR", k]).catch(() => 0);
    if (n === 1) await R(["EXPIRE", k, String(sec)]).catch(() => {});
    return n > max;
  }

  async function newSession(code) {
    const token = crypto.randomBytes(24).toString("hex");
    await R(["SET", `aff:sess:${sha(token)}`, code, "EX", String(120 * 86400)]);
    return token;
  }
  async function authed(req) {
    const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!/^[a-f0-9]{48}$/.test(t)) return null;
    const code = await R(["GET", `aff:sess:${sha(t)}`]).catch(() => null);
    return code ? getAff(code) : null;
  }

  async function stats(a) {
    const month = manilaMonth();
    const [clicksM, clicksAll, chats] = await Promise.all([
      R(["GET", `aff:clicks:${a.code}:${month}`]).catch(() => 0),
      R(["GET", `aff:clicks:${a.code}:all`]).catch(() => 0),
      R(["GET", `partner:chats:${a.code}`]).catch(() => 0)
    ]);
    const all = await partners.statement(a.code, null);
    const rows = (all && all.rows) || [];
    const byMonth = {};
    for (const r of rows) {
      const m = manilaMonth(new Date(r.at).getTime());
      const b = byMonth[m] || (byMonth[m] = { month: m, orders: 0, salesPHP: 0, commissionPHP: 0 });
      b.orders++; b.salesPHP += r.amountPHP; b.commissionPHP += r.commissionPHP;
    }
    const payouts = ((await R(["LRANGE", `aff:payouts:${a.code}`, "0", "-1"]).catch(() => [])) || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    const earned = rows.reduce((s, r) => s + r.commissionPHP, 0);
    const paid = payouts.reduce((s, p) => s + Number(p.amountPHP || 0), 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      month, clicksThisMonth: Number(clicksM) || 0, clicksAllTime: Number(clicksAll) || 0, chats: Number(chats) || 0,
      ordersAllTime: rows.length, salesAllTimePHP: r2(rows.reduce((s, r) => s + r.amountPHP, 0)),
      earnedAllTimePHP: r2(earned), paidOutPHP: r2(paid), balancePHP: r2(earned - paid),
      thisMonth: byMonth[month] ? { ...byMonth[month], salesPHP: r2(byMonth[month].salesPHP), commissionPHP: r2(byMonth[month].commissionPHP) } : { month, orders: 0, salesPHP: 0, commissionPHP: 0 },
      months: Object.values(byMonth).sort((x, y) => (x.month < y.month ? 1 : -1)).map((b) => ({ ...b, salesPHP: r2(b.salesPHP), commissionPHP: r2(b.commissionPHP) })),
      recent: rows.slice(-15).reverse().map((r) => ({ at: r.at, plan: r.plan, quantity: r.quantity, amountPHP: r.amountPHP, commissionPHP: r.commissionPHP })),
      payouts: payouts.slice().reverse(), minPayoutPHP: MIN_PAYOUT
    };
  }
  const publicProfile = (a) => ({ code: a.code, name: a.name, email: a.email, mobile: a.mobile ? "+" + a.mobile : "", payoutMethod: a.payoutMethod, payoutNumber: a.payoutNumber,
    payoutName: a.payoutName, pct: a.pct, status: a.status, createdAt: a.createdAt, links: linksFor(a.code) });

  const json = express.json({ limit: "10kb" });

  app.get("/affiliate", (req, res) => res.sendFile(path.join(__dirname, "public", "affiliate.html")));

  // Click tracker: 3ukph.com/r/CODE
  app.get("/r/:code", async (req, res) => {
    const code = partners.norm(req.params.code);
    if (!partners.isCode(code)) return res.redirect(302, "/");
    if (hasDb()) {
      R(["INCR", `aff:clicks:${code}:${manilaMonth()}`]).catch(() => {});
      R(["INCR", `aff:clicks:${code}:all`]).catch(() => {});
    }
    // Optional destination: 3ukph.com/r/CODE?d=Japan opens the plan finder on Japan.
    const d = String(req.query.d || "").trim();
    res.redirect(302, `/?ref=${code}` + (/^[A-Za-z .&'-]{2,40}$/.test(d) ? `&dest=${encodeURIComponent(d)}` : ""));
  });

  app.post("/api/affiliate/signup", json, async (req, res) => {
    try {
      if (!hasDb()) return res.status(503).json({ error: "Sign-up is not available right now. Please try again later." });
      const b = req.body || {};
      if (b.website) return res.json({ ok: true }); // honeypot
      if (await rateLimit(req, "signup", 5, 3600)) return res.status(429).json({ error: "Too many sign-ups from this connection. Please try again later." });
      const name = clean(b.name, 80);
      const email = clean(b.email, 120).toLowerCase();
      const mobile = intlMobile(b.mobile);
      const payoutMethod = b.payoutMethod === "Maya" ? "Maya" : "GCash";
      const payoutNumber = intlMobile(b.payoutNumber) || mobile;
      const payoutName = clean(b.payoutName || name, 80);
      const how = clean(b.how, 300);
      if (name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
      if (!mailer.validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (!mobile) return res.status(400).json({ error: "Please enter your mobile / WhatsApp number." });
      if (!b.agree) return res.status(400).json({ error: "Please read and accept the affiliate terms." });
      if (await R(["GET", `aff:email:${sha(email)}`]).catch(() => null)) return res.status(409).json({ error: "This email is already an affiliate. Sign in instead.", signIn: true });
      const code = await newCode(name);
      const a = { code, name, email, mobile, payoutMethod, payoutNumber, payoutName, how, pct: PCT, status: "active", createdAt: new Date().toISOString() };
      await saveAff(a);
      await R(["SET", `aff:email:${sha(email)}`, code]);
      await R(["SADD", "aff:all", code]);
      const token = await newSession(code);
      const L = linksFor(code);
      res.json({ ok: true, token, profile: publicProfile(a) });

      notifyAdmin({ title: `🤝 New affiliate: ${code}`, tags: "handshake", message: `${name} · ${email} · +${mobile}\nPayout: ${payoutMethod} ${payoutNumber}\nHow: ${how || "(not said)"}` }).catch(() => {});
      if (mailer.configured()) {
        mailer.sendRaw({ to: email, subject: `Welcome to the 3UK affiliate program! Your code: ${code}`,
          html: `<div style="font:15px/22px Arial,sans-serif;color:#0b1233;max-width:560px">
<p>Hi ${esc(name.split(" ")[0])},</p>
<p>Welcome to the <b>3UK Philippines affiliate program</b>! You earn <b>${PCT}%</b> of every paid eSIM order from customers who come through your links or use your code.</p>
<p>Your code: <b style="font-size:20px;letter-spacing:1px">${code}</b></p>
<p><b>Your links</b><br>Website: <a href="${L.website}">${L.website}</a><br>Messenger: <a href="${L.messenger}">${L.messenger}</a><br>WhatsApp: <a href="${esc(L.whatsapp)}">Chat link with your code</a></p>
<p>Customers can also just type <b>${code}</b> in their first message to us.</p>
<p>See your clicks, sales and earnings anytime at <a href="${SITE}/affiliate">${SITE}/affiliate</a> (sign in with this email).</p>
<p>Commission is paid monthly by ${esc(payoutMethod)} once your balance reaches ₱${MIN_PAYOUT}.</p>
<p>Happy selling!<br>3UK Philippines · admin@3ukph.com</p></div>`,
          text: `Welcome to the 3UK Philippines affiliate program! Your code: ${code}. You earn ${PCT}% of every paid order.\nWebsite: ${L.website}\nMessenger: ${L.messenger}\nWhatsApp: ${L.whatsapp}\nDashboard: ${SITE}/affiliate` })
          .catch((e) => console.error("[affiliates] welcome email:", e.message));
      }
    } catch (e) {
      console.error("[affiliates] signup:", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  app.post("/api/affiliate/login/start", json, async (req, res) => {
    try {
      const email = clean((req.body || {}).email, 120).toLowerCase();
      if (!mailer.validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (await rateLimit(req, "login", 8, 3600)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
      const code = await R(["GET", `aff:email:${sha(email)}`]).catch(() => null);
      if (!code) return res.status(404).json({ error: "No affiliate account with this email yet. Sign up below." });
      const otp = String(crypto.randomInt(1000000)).padStart(6, "0");
      await R(["SET", `aff:otp:${sha(email)}`, JSON.stringify({ h: sha(otp + email), tries: 0 }), "EX", "600"]);
      await mailer.sendRaw({ to: email, subject: `${otp} is your 3UK affiliate sign-in code`,
        html: `<div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#15204a;text-align:center"><h2 style="color:#0e2578">Your 3UK affiliate sign-in code</h2><div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f1f5fd;border-radius:14px;padding:16px 0">${otp}</div><p style="color:#6b7695;font-size:13px">Expires in 10 minutes. If you didn't ask for it, ignore this email.</p></div>`,
        text: `Your 3UK affiliate sign-in code is ${otp}. It expires in 10 minutes.` });
      res.json({ ok: true });
    } catch (e) { console.error("[affiliates] login start:", e.message); res.status(500).json({ error: "Couldn't send the code. Please try again." }); }
  });

  app.post("/api/affiliate/login/verify", json, async (req, res) => {
    try {
      const email = clean((req.body || {}).email, 120).toLowerCase();
      const otp = digits((req.body || {}).code).slice(0, 6);
      const k = `aff:otp:${sha(email)}`;
      const v = await R(["GET", k]).catch(() => null);
      const o = v ? JSON.parse(v) : null;
      if (!o) return res.status(400).json({ error: "The code expired. Please ask for a new one." });
      if (o.tries >= 5) { await R(["DEL", k]); return res.status(400).json({ error: "Too many wrong codes. Please ask for a new one." }); }
      if (o.h !== sha(otp + email)) { o.tries++; await R(["SET", k, JSON.stringify(o), "KEEPTTL"]).catch(() => {}); return res.status(400).json({ error: "Wrong code. Please check the email and try again." }); }
      await R(["DEL", k]);
      const code = await R(["GET", `aff:email:${sha(email)}`]);
      res.json({ ok: true, token: await newSession(code) });
    } catch (e) { console.error("[affiliates] verify:", e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
  });

  app.get("/api/affiliate/me", async (req, res) => {
    const a = await authed(req);
    if (!a) return res.status(401).json({ error: "Please sign in again." });
    res.set("Cache-Control", "no-store").json({ profile: publicProfile(a), stats: await stats(a) });
  });

  app.post("/api/affiliate/me", json, async (req, res) => {
    const a = await authed(req);
    if (!a) return res.status(401).json({ error: "Please sign in again." });
    const b = req.body || {};
    if (b.payoutMethod) a.payoutMethod = b.payoutMethod === "Maya" ? "Maya" : "GCash";
    if (b.payoutNumber) { const n = intlMobile(b.payoutNumber); if (!n) return res.status(400).json({ error: "Please enter a valid mobile number for payouts." }); a.payoutNumber = n; }
    if (b.payoutName) a.payoutName = clean(b.payoutName, 80);
    await saveAff(a);
    res.json({ ok: true, profile: publicProfile(a) });
  });

  app.post("/api/affiliate/logout", async (req, res) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (t) await R(["DEL", `aff:sess:${sha(t)}`]).catch(() => {});
    res.json({ ok: true });
  });

  // ---- admin ----
  app.get("/admin/api/affiliates", requireAdmin, async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : manilaMonth();
    const codes = (await R(["SMEMBERS", "aff:all"]).catch(() => [])) || [];
    const out = [];
    for (const c of codes) {
      const a = await getAff(c); if (!a) continue;
      const st = await stats(a);
      const m = st.months.find((x) => x.month === month) || { orders: 0, salesPHP: 0, commissionPHP: 0 };
      out.push({ ...publicProfile(a), how: a.how, clicksAllTime: st.clicksAllTime, chats: st.chats, monthOrders: m.orders, monthSalesPHP: m.salesPHP, monthCommissionPHP: m.commissionPHP,
        earnedAllTimePHP: st.earnedAllTimePHP, paidOutPHP: st.paidOutPHP, balancePHP: st.balancePHP, payoutDue: st.balancePHP >= MIN_PAYOUT, paidThisMonth: st.payouts.some((p) => p.month === month) });
    }
    out.sort((x, y) => y.balancePHP - x.balancePHP || y.monthSalesPHP - x.monthSalesPHP);
    res.json({ month, pct: PCT, minPayoutPHP: MIN_PAYOUT, affiliates: out });
  });

  app.post("/admin/api/affiliates/paid", requireAdmin, json, async (req, res) => {
    const b = req.body || {};
    const a = await getAff(b.code);
    const amt = Math.round(Number(b.amountPHP) * 100) / 100;
    if (!a) return res.status(404).json({ error: "Unknown affiliate." });
    if (!(amt > 0)) return res.status(400).json({ error: "Enter the amount you sent." });
    const rec = { month: /^\d{4}-\d{2}$/.test(String(b.month || "")) ? b.month : manilaMonth(), amountPHP: amt, note: clean(b.note, 120), paidAt: new Date().toISOString(),
      to: `${a.payoutMethod} ${a.payoutNumber}` };
    await R(["RPUSH", `aff:payouts:${a.code}`, JSON.stringify(rec)]);
    if (mailer.configured()) mailer.sendRaw({ to: a.email, subject: `3UK affiliate payout sent: ₱${amt.toFixed(2)}`,
      html: `<p>Hi ${esc(a.name.split(" ")[0])},</p><p>We sent your affiliate commission of <b>₱${amt.toFixed(2)}</b> to your ${esc(a.payoutMethod)} (${esc(a.payoutNumber)}).${rec.note ? " Reference: " + esc(rec.note) + "." : ""}</p><p>Thank you for sharing 3UK Philippines! See your dashboard at <a href="${SITE}/affiliate">${SITE}/affiliate</a>.</p><p>3UK Philippines</p>`,
      text: `We sent your 3UK affiliate commission of PHP ${amt.toFixed(2)} to your ${a.payoutMethod} (${a.payoutNumber}). Thank you!` }).catch(() => {});
    res.json({ ok: true });
  });

  app.post("/admin/api/affiliates/status", requireAdmin, json, async (req, res) => {
    const b = req.body || {};
    const a = await getAff(b.code);
    if (!a) return res.status(404).json({ error: "Unknown affiliate." });
    a.status = b.status === "paused" ? "paused" : "active";
    await saveAff(a);
    res.json({ ok: true, status: a.status });
  });
}

module.exports = { install, linksFor };
