// reminders.js
//
// "Running low on data?" reminders: once a day (10 AM Manila) we check eSIMs delivered in the last
// 45 days. When one has used up its data, has less than 15% left, or expires within 2 days, the
// buyer gets ONE friendly email with a link to buy more for the same destination.
// Off until the owner turns it on in the console (customer-facing). Unsubscribed emails are skipped.
//   GET  /admin/api/reminders          status, last run
//   GET  /admin/api/reminders?dry=1     who would get it now (checks data, sends nothing)
//   GET  /admin/api/reminders?preview=1 the email, as the customer sees it (HTML)
//   POST /admin/api/reminders {on}      turn on/off

const RUN_HOUR = 10;
const MAX_CHECKS = 25;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let d = null;
let lastRun = null;
function init(deps) { d = deps; }

async function isOn() { try { return (await d.redis(["GET", "settings:reminders"])) === "on"; } catch { return false; } }

function emailHtml({ name, destination, plan, why, email }) {
  const dest = destination || "your destination";
  const shop = `https://3ukph.com/?dest=${encodeURIComponent(destination || "")}#ff`;
  const wa = `https://wa.me/639347069356?text=${encodeURIComponent(`Hi 3UK! I need more data for ${dest}.`)}`;
  return `<div style="font-family:Montserrat,Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:22px;color:#0b1233">
<img src="https://3ukph.com/logo.png" width="64" height="64" alt="3UK Philippines" style="border-radius:50%">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#cf0507;font-weight:700;margin-top:12px">Your ${esc(dest)} eSIM</div>
<h1 style="font-size:24px;line-height:1.25;color:#00166a;margin:6px 0 10px">${why === "expiring" ? "Your eSIM is about to expire" : "Running low on data?"}</h1>
<p style="line-height:1.55;margin:0 0 10px">Hi${name ? " " + esc(name.split(" ")[0]) : ""}! ${why === "expiring" ? `Your <b>${esc(plan)}</b> eSIM expires in the next 2 days.` : why === "used_up" ? `Your <b>${esc(plan)}</b> eSIM has used all its data.` : `Your <b>${esc(plan)}</b> eSIM is almost out of data.`} Still travelling? Get more data in minutes so you stay connected.</p>
<p style="margin:18px 0"><a href="${shop}" style="background:#cf0507;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px;display:inline-block">See ${esc(dest)} plans</a></p>
<p style="line-height:1.55;margin:0 0 6px">Prefer to chat? <a href="${wa}" style="color:#012ca5;font-weight:700">Message us on WhatsApp</a> and we'll send the right plan. Pay with GCash, Maya or card.</p>
<p style="font-size:12px;color:#4a5170;margin-top:22px">You got this because you bought an eSIM from 3UK Philippines. <a href="${d.unsubLink(email)}" style="color:#4a5170">Unsubscribe from reminders and promos</a>.</p></div>`;
}

async function run({ dry = false } = {}) {
  const out = { at: new Date().toISOString(), checked: 0, due: [], sent: 0, errors: 0, dry };
  const unsub = new Set(((await d.redis(["SMEMBERS", "mkt:unsub"]).catch(() => [])) || []).map((x) => String(x).toLowerCase()));
  const rows = (await d.salesRows()).filter((r) => r.iccid && r.email && !r.reseller && Date.now() - Date.parse(r.at) < 45 * 86400000).reverse();
  for (const r of rows) {
    if (out.checked >= MAX_CHECKS) break;
    if (unsub.has(r.email)) continue;
    if (await d.redis(["GET", `rem:sent:${r.iccid}`])) continue;
    if (!dry && (await d.redis(["SET", `rem:checked:${r.iccid}`, "1", "NX", "EX", String(20 * 3600)])) !== "OK") continue;
    out.checked++;
    let u;
    try { u = await d.esims.usage(r.iccid); } catch (e) { out.errors++; continue; }
    const exp = u.expires ? Date.parse(u.expires) : NaN;
    if (Number.isFinite(exp) && exp < Date.now()) continue; // already expired: too late, skip
    const zero = u.remaining && /^0(\.0+)?\s*(GB|MB)$/i.test(u.remaining) && !u.unlimited;
    const used = String(u.used || "");
    if (!u.unlimited && /^0(\.0+)?\s*(MB|GB)$/i.test(used)) continue; // not used yet
    let why = null;
    if (zero) why = "used_up";
    else if (!u.unlimited && Number(u.percentUsed) >= 85) why = "low";
    else if (Number.isFinite(exp) && exp - Date.now() < 2 * 86400000) why = "expiring";
    if (!why) continue;
    out.due.push({ email: r.email, name: r.name, plan: r.plan, destination: r.destination, why, remaining: u.remaining || null });
    if (dry) continue;
    try {
      await d.mailer.sendRaw({ to: r.email, subject: why === "expiring" ? `Your ${r.destination || "travel"} eSIM expires soon` : `Need more data for ${r.destination || "your trip"}?`,
        html: emailHtml({ name: r.name, destination: r.destination, plan: r.plan, why, email: r.email }),
        text: `Your ${r.plan} eSIM ${why === "expiring" ? "expires within 2 days" : why === "used_up" ? "has used all its data" : "is almost out of data"}. Get more data: https://3ukph.com/?dest=${encodeURIComponent(r.destination || "")} or WhatsApp +63 934 706 9356. Unsubscribe: ${d.unsubLink(r.email)}` });
      await d.redis(["SET", `rem:sent:${r.iccid}`, why, "EX", String(120 * 86400)]);
      out.sent++;
    } catch (e) { out.errors++; console.error("[reminders] send failed:", e.message); }
  }
  if (!dry) {
    lastRun = out;
    await d.redis(["SET", "reminders:last", JSON.stringify(out), "EX", String(30 * 86400)]).catch(() => {});
    if (out.sent) d.notifyAdmin({ title: `Data reminders sent: ${out.sent}`, message: out.due.map((x) => `${x.email} · ${x.plan} (${x.why})`).join("\n"), tags: "bell" }).catch(() => {});
  }
  return out;
}

function startScheduler() {
  setInterval(async () => {
    try {
      if (!d.hasDb() || !d.mailer.configured() || !d.esims.configured()) return;
      const now = new Date(Date.now() + 8 * 3600000);
      if (now.getUTCHours() !== RUN_HOUR || !(await isOn())) return;
      if ((await d.redis(["SET", `reminders:ran:${now.toISOString().slice(0, 10)}`, "1", "NX", "EX", String(2 * 86400)])) !== "OK") return;
      await run();
    } catch (e) { console.error("[reminders] failed:", e.message); }
  }, 10 * 60000);
}

function install(app, requireAdmin, express) {
  app.get("/admin/api/reminders", requireAdmin, async (req, res) => {
    try {
      if (req.query.preview === "1") return res.type("html").send(emailHtml({ name: "Juan Dela Cruz", destination: "Japan", plan: "Japan 5GB 7 days", why: "low", email: "sample@example.com" }));
      if (req.query.dry === "1") return res.json(await run({ dry: true }));
      let last = lastRun; try { last = last || JSON.parse(await d.redis(["GET", "reminders:last"])); } catch { /* none */ }
      res.json({ on: await isOn(), last });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/admin/api/reminders", requireAdmin, express.json(), async (req, res) => {
    await d.redis(["SET", "settings:reminders", req.body && req.body.on ? "on" : "off"]);
    res.json({ on: await isOn() });
  });
}

module.exports = { init, install, run, startScheduler, emailHtml };
