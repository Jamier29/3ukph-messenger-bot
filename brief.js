// brief.js
//
// 1. Sales log: every delivered eSIM is recorded once (sales:log), with price paid and cost,
//    so we can report sales and profit.
// 2. Morning brief: every day at 7:00 AM Manila time the owner gets a summary of yesterday
//    (orders, sales, profit, top plans) plus "needs you" items, by email and phone push.
//    Preview or send it any time from the console: /admin/api/brief (?send=1).
// 3. Customer list: every buyer email we know (sales log, delivered eSIMs, app accounts,
//    website and PayMongo orders), for the console's Customers card and CSV export.
//    People who unsubscribe (/unsubscribe link) are marked and must be left out of marketing.
//
// Render settings (optional):
//   BRIEF_EMAIL = where the morning brief goes (default: admin@3ukph.com)
//   BRIEF_HOUR  = hour in Manila time to send it (default 7)

const crypto = require("crypto");

const BRIEF_HOUR = Number(process.env.BRIEF_HOUR || 7);
const manilaDate = (t = Date.now()) => new Date(t + 8 * 3600000).toISOString().slice(0, 10);
const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let d = null; // deps
function init(deps) { d = deps; }

// ---------- sales log ----------
async function recordSale(s) {
  try {
    if (!d || !d.hasDb()) return;
    if (s.iccid && (await d.redis(["SET", `sales:done:${s.iccid}`, "1", "NX", "EX", String(400 * 86400)])) !== "OK") return;
    const rec = {
      at: new Date().toISOString(), day: manilaDate(), psid: String(s.psid || ""), name: String(s.name || "").slice(0, 80),
      email: String(s.email || "").trim().toLowerCase().slice(0, 120), plan: String(s.plan || "").slice(0, 120),
      paidPHP: Math.round(Number(s.paidPHP || 0) * 100) / 100, costPHP: Math.round(Number(s.costPHP || 0) * 100) / 100,
      method: String(s.method || "").slice(0, 40), reseller: !!s.reseller, channel: String(s.channel || "").slice(0, 20), iccid: String(s.iccid || "")
    };
    await d.redis(["RPUSH", "sales:log", JSON.stringify(rec)]);
  } catch (e) { console.error("[sales] log failed:", e.message); }
}
async function salesRows() {
  if (!d || !d.hasDb()) return [];
  const v = await d.redis(["LRANGE", "sales:log", "-3000", "-1"]).catch(() => []);
  return (v || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}
function summarize(rows) {
  const paid = rows.reduce((s, r) => s + (r.paidPHP || 0), 0);
  const cost = rows.reduce((s, r) => s + (r.costPHP || 0), 0);
  const withPrice = rows.filter((r) => r.paidPHP > 0);
  const profit = withPrice.reduce((s, r) => s + r.paidPHP - (r.costPHP || 0), 0);
  const plans = {};
  for (const r of rows) plans[r.plan] = (plans[r.plan] || 0) + 1;
  const top = Object.entries(plans).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { count: rows.length, paid, cost, profit, unpriced: rows.length - withPrice.length, top, resellerCount: rows.filter((r) => r.reseller).length };
}

// ---------- morning brief ----------
async function buildBrief() {
  const today = manilaDate();
  const yesterday = manilaDate(Date.now() - 86400000);
  const month = today.slice(0, 7);
  const rows = await salesRows();
  const y = summarize(rows.filter((r) => r.day === yesterday));
  const m = summarize(rows.filter((r) => String(r.day).startsWith(month)));
  const needs = [];
  try { const p = await d.pendingOrders(); const proof = p.filter((o) => o.paymentProof); if (proof.length) needs.push(`${proof.length} order(s) sent payment proof and are waiting for delivery`); if (p.length - proof.length > 0) needs.push(`${p.length - proof.length} unpaid order(s) from the last 7 days (follow up?)`); } catch (_) { /* optional */ }
  try { const n = await d.pendingApplicants(); if (n) needs.push(`${n} reseller application(s) to review`); } catch (_) { /* optional */ }
  try { const n = await d.manualChecks(); if (n) needs.push(`${n} paid order(s) need a manual check (see Delivery in the console)`); } catch (_) { /* optional */ }
  let partnerLine = "";
  try {
    const parts = [];
    for (const p of d.partners.list()) { const st = await d.partners.statement(p.code, month); if (st && st.orders) parts.push(`${p.name}: ${st.orders} order(s), ${peso(st.salesPHP)}`); }
    if (parts.length) partnerLine = parts.join(" · ");
  } catch (_) { /* optional */ }
  let appUsers = 0;
  try { appUsers = Number((await d.redis(["GET", `app:newusers:${yesterday}`])) || 0); } catch (_) { appUsers = 0; }
  return { today, yesterday, y, m, needs, partnerLine, appUsers };
}

function briefText(b) {
  const L = [];
  L.push(`☀️ 3UK Morning Brief, ${b.today}`);
  L.push(`Yesterday: ${b.y.count} eSIM(s) delivered · ${peso(b.y.paid)} sales · ${peso(b.y.profit)} profit`);
  if (b.y.top.length) L.push(`Top: ${b.y.top.map(([p, n]) => `${p} ×${n}`).join(", ")}`);
  L.push(`This month: ${b.m.count} eSIM(s) · ${peso(b.m.paid)} sales · ${peso(b.m.profit)} profit`);
  if (b.partnerLine) L.push(`Partners this month: ${b.partnerLine}`);
  if (b.appUsers) L.push(`New app accounts yesterday: ${b.appUsers}`);
  L.push(b.needs.length ? `Needs you:\n- ${b.needs.join("\n- ")}` : "Needs you: nothing. 🎉");
  return L.join("\n");
}
function briefHtml(b) {
  const tile = (label, val) => `<td style="padding:10px 12px;background:#f3f5fb;border-radius:10px;width:33%"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4a5170;font-weight:700">${label}</div><div style="font-size:20px;font-weight:800;color:#0b1233;margin-top:2px">${val}</div></td>`;
  return `<div style="font-family:Montserrat,Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#0b1233">
<table style="width:100%"><tr><td><img src="https://3ukph.com/logo.png" width="52" height="52" alt="3UK" style="border-radius:50%"></td>
<td style="text-align:right;font-size:12px;color:#4a5170">${esc(b.today)}</td></tr></table>
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#cf0507;font-weight:700;margin-top:10px">Your morning brief</div>
<h1 style="font-size:26px;margin:4px 0 14px;color:#00166a">Good morning, besh! ☀️</h1>
<div style="font-weight:700;margin:6px 0">Yesterday (${esc(b.yesterday)})</div>
<table style="width:100%;border-spacing:6px 0"><tr>${tile("eSIMs", b.y.count)}${tile("Sales", peso(b.y.paid))}${tile("Profit", peso(b.y.profit))}</tr></table>
${b.y.top.length ? `<p style="margin:10px 0 0;color:#4a5170">Top plans: ${b.y.top.map(([p, n]) => `${esc(p)} ×${n}`).join(", ")}</p>` : ""}
<div style="font-weight:700;margin:18px 0 6px">This month</div>
<table style="width:100%;border-spacing:6px 0"><tr>${tile("eSIMs", b.m.count)}${tile("Sales", peso(b.m.paid))}${tile("Profit", peso(b.m.profit))}</tr></table>
${b.partnerLine ? `<p style="margin:10px 0 0;color:#4a5170">Partners: ${esc(b.partnerLine)}</p>` : ""}
${b.appUsers ? `<p style="margin:6px 0 0;color:#4a5170">New app accounts yesterday: <b>${b.appUsers}</b></p>` : ""}
<div style="margin-top:18px;padding:12px 14px;border-radius:12px;background:${b.needs.length ? "#fff3cf" : "#e2f5ea"};border-left:4px solid ${b.needs.length ? "#f8c830" : "#0e7a3e"}">
<b>${b.needs.length ? "Needs you" : "Nothing needs you today 🎉"}</b>${b.needs.length ? `<ul style="margin:6px 0 0;padding-left:18px">${b.needs.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>
<p style="margin-top:16px;font-size:12px;color:#4a5170">Profit = price paid minus eSIM cost (cards' and PayMongo fees not included). Sales are counted when the eSIM is delivered.
${b.m.unpriced ? ` ${b.m.unpriced} eSIM(s) this month were delivered without a recorded price.` : ""} Open the console: https://3ukph.com/admin</p></div>`;
}

async function sendBrief({ force } = {}) {
  const b = await buildBrief();
  const text = briefText(b);
  if (!force && d.hasDb() && (await d.redis(["SET", `brief:sent:${b.today}`, "1", "NX", "EX", String(3 * 86400)])) !== "OK") return { skipped: true, text };
  await d.notifyAdmin({ title: `3UK Morning Brief: ${b.y.count} sold, ${peso(b.y.paid)}`, message: text, tags: "sunny" }).catch(() => {});
  const to = (process.env.BRIEF_EMAIL || "admin@3ukph.com").trim();
  let emailed = false;
  if (d.mailer.configured() && d.mailer.validEmail(to)) {
    try { await d.mailer.sendRaw({ to, subject: `☀️ 3UK Morning Brief: ${b.y.count} sold yesterday, ${peso(b.y.paid)}`, html: briefHtml(b), text }); emailed = true; }
    catch (e) { console.error("[brief] email failed:", e.message); }
  }
  return { sent: true, emailed, text };
}
function startScheduler() {
  setInterval(() => {
    const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
    if (h === BRIEF_HOUR) sendBrief().catch((e) => console.error("[brief] failed:", e.message));
  }, 5 * 60000);
}

// ---------- customers ----------
function unsubToken(email) {
  const secret = process.env.UNSUB_SECRET || process.env.ADMIN_KEY || "3uk";
  return crypto.createHmac("sha256", secret).update(String(email).toLowerCase()).digest("hex").slice(0, 20);
}
function unsubLink(email) { return `https://3ukph.com/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`; }

async function listCustomers() {
  const map = new Map();
  const add = (email, data) => {
    const e = String(email || "").trim().toLowerCase();
    if (!d.mailer.validEmail(e)) return;
    const c = map.get(e) || { email: e, name: "", orders: 0, lastPlan: "", lastDate: "", sources: new Set() };
    if (data.name && !c.name) c.name = data.name;
    if (data.order) c.orders += 1;
    if (data.plan && (!c.lastDate || String(data.date || "") > c.lastDate)) { c.lastPlan = data.plan; c.lastDate = String(data.date || "").slice(0, 10); }
    if (data.source) c.sources.add(data.source);
    map.set(e, c);
  };
  if (!d.hasDb()) return [];
  const keys = async (pat) => (await d.redis(["KEYS", pat]).catch(() => [])) || [];
  const mget = async (ks) => { const out = []; for (let i = 0; i < ks.length; i += 100) out.push(...((await d.redis(["MGET", ...ks.slice(i, i + 100)]).catch(() => [])) || [])); return out; };
  const seenIccid = new Set();
  for (const r of await salesRows()) { if (r.iccid) seenIccid.add(r.iccid); add(r.email, { name: r.name, plan: r.plan, date: r.at, order: true, source: "sale" }); }
  const ek = (await keys("esims:*")).filter((k) => !k.startsWith("esims:email:"));
  const ev = await mget(ek);
  ev.forEach((v) => { let list = []; try { list = JSON.parse(v) || []; } catch { list = []; } for (const r of list) { if (r.iccid && seenIccid.has(r.iccid)) continue; add(r.email, { plan: r.plan, date: r.addedAt, order: true, source: "esim" }); } });
  const uk = await keys("app:user:*");
  (await mget(uk)).forEach((v) => { try { const u = JSON.parse(v); add(u.email, { name: u.name, source: "app" }); } catch { /* skip */ } });
  const wk = await keys("web:buyer:*");
  (await mget(wk)).forEach((v) => { try { const u = JSON.parse(v); add(u.email, { name: u.name, source: "website" }); } catch { /* skip */ } });
  const unsub = new Set(((await d.redis(["SMEMBERS", "mkt:unsub"]).catch(() => [])) || []).map((x) => String(x).toLowerCase()));
  return [...map.values()].map((c) => ({ ...c, sources: [...c.sources].join(" "), unsubscribed: unsub.has(c.email) }))
    .sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)));
}

function install(app, requireAdmin) {
  app.get("/admin/api/brief", requireAdmin, async (req, res) => {
    try {
      if (req.query.send === "1") return res.json(await sendBrief({ force: true }));
      const b = await buildBrief(); res.json({ text: briefText(b), brief: b });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/admin/api/customers", requireAdmin, async (req, res) => {
    try {
      const list = await listCustomers();
      if (req.query.format === "csv") {
        const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
        const csv = ["email,name,orders,last_plan,last_date,sources,unsubscribed"].concat(list.map((c) => [c.email, c.name, c.orders, c.lastPlan, c.lastDate, c.sources, c.unsubscribed ? "yes" : "no"].map(q).join(","))).join("\n");
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="3uk-customers-${manilaDate()}.csv"`);
        return res.send("﻿" + csv);
      }
      res.json({ total: list.length, buyers: list.filter((c) => c.orders > 0).length, unsubscribed: list.filter((c) => c.unsubscribed).length, customers: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/unsubscribe", async (req, res) => {
    const e = String(req.query.e || "").trim().toLowerCase();
    const ok = d.mailer.validEmail(e) && String(req.query.t || "") === unsubToken(e);
    if (ok && d.hasDb()) await d.redis(["SADD", "mkt:unsub", e]).catch(() => {});
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe | 3UK Philippines</title>
<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:60px auto;padding:24px;text-align:center;color:#0b1233">
<img src="/logo.png" width="80" height="80" alt="3UK Philippines"><h2 style="color:#00166a">${ok ? "You're unsubscribed" : "This link isn't valid"}</h2>
<p>${ok ? `We won't send promotions to ${esc(e)} anymore. You'll still get receipts and eSIM emails for orders you place.` : "Please use the unsubscribe link from our email, or message us and we'll remove you."}</p></div>`);
  });
}

module.exports = { init, install, recordSale, sendBrief, buildBrief, briefText, startScheduler, listCustomers, unsubLink, manilaDate };
