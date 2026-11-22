// tours.js
//
// Tour referrals with our partner travel agency (TripHappy.ph).
//   Public page:  /tours          (tour cards show when tours-data.json has "live": true,
//                                   or at /tours?preview=1 while we wait for the real list)
//   Public API:   GET  /api/tours
//                 POST /api/tours/inquiry   guest picks a tour and leaves details
//   Admin API:    GET  /admin/api/tours/inquiries
//
// Each inquiry gets a Ref ID (TH-YYMMDD-XXXX) so the referral and commission are on record
// before the agency contacts the guest. On submit we:
//   1. save it (Redis: tours:inq:<ref>, list tours:inq:list)
//   2. push + email the owner
//   3. email the agency, only if TOURS_PARTNER_EMAIL is set (comma-separated)
//   4. email the guest a confirmation with their Ref ID
//   5. add a row to the Google Sheet tracker, if TOURS_SHEET_WEBHOOK is set
//      (an Apps Script web app inside the sheet; TOURS_SHEET_SECRET must match the script)
//
// Render settings (all optional):
//   TOURS_PARTNER_EMAIL, TOURS_SHEET_WEBHOOK, TOURS_SHEET_SECRET, BRIEF_EMAIL (owner email)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "tours-data.json");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const manilaDate = (t = Date.now()) => new Date(t + 8 * 3600000).toISOString().slice(0, 10);
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { console.error("[tours] data file:", e.message); return { live: false, tours: [] }; }
}

function publicTour(t) {
  return { id: t.id, type: t.type, rank: t.rank, name: t.name, destination: t.destination, duration: t.duration,
    price: typeof t.price === "number" ? t.price : null, blurb: t.blurb, image: /^https:\/\//.test(t.image || "") ? t.image : "", sample: !!t.sample };
}

function newRef() {
  const d = manilaDate().replace(/-/g, "").slice(2);
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; const b = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += abc[b[i] % abc.length];
  return `TH-${d}-${s}`;
}

function install(app, { redis, hasDb, mailer, notifyAdmin, requireAdmin, express, publicUrl }) {
  const ownerEmail = () => process.env.BRIEF_EMAIL || "admin@3ukph.com";

  app.get("/tours", (req, res) => res.sendFile(path.join(__dirname, "public", "tours.html")));

  app.get("/api/tours", (req, res) => {
    const data = loadData();
    const preview = req.query.preview === "1";
    const show = !!data.live || preview;
    res.set("Cache-Control", "no-store");
    res.json({ live: !!data.live, preview: preview && !data.live, partner: data.partner || "our partner travel agency",
      tours: show ? (data.tours || []).map(publicTour) : [] });
  });

  app.post("/api/tours/inquiry", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.website) return res.json({ ok: true, ref: newRef() }); // honeypot: bots fill hidden field
      const name = clean(b.name, 80);
      const email = clean(b.email, 120).toLowerCase();
      const mobile = clean(b.mobile, 30);
      const notes = clean(b.notes, 800);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "";
      const flexible = !!b.flexible || !date;
      const adults = Math.max(1, Math.min(50, parseInt(b.adults, 10) || 1));
      const kids = Math.max(0, Math.min(50, parseInt(b.kids, 10) || 0));
      if (!name) return res.status(400).json({ error: "Please enter your name." });
      if (!mailer.validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (!b.consent) return res.status(400).json({ error: "Please tick the box so our partner can contact you." });

      const data = loadData();
      const tour = (data.tours || []).find((t) => t.id === b.tourId);
      const tourName = tour ? tour.name : clean(b.tourOther, 120) || "Not sure yet (please suggest)";
      const tourType = tour ? tour.type : (b.type === "International" ? "International" : b.type === "Local" ? "Local" : "");

      if (hasDb()) {
        const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
        const k = `tours:rl:${crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
        const n = await redis(["INCR", k]).catch(() => 0);
        if (n === 1) await redis(["EXPIRE", k, "3600"]).catch(() => {});
        if (n > 6) return res.status(429).json({ error: "Too many requests. Please try again in an hour, or message us on WhatsApp." });
      }

      const ref = newRef();
      const rec = { ref, at: new Date().toISOString(), day: manilaDate(), name, email, mobile, tourId: tour ? tour.id : "", tour: tourName, type: tourType,
        date: flexible && !date ? "Flexible" : date + (b.flexible ? " (flexible)" : ""), adults, kids, pax: adults + kids, notes, source: clean(b.source, 60), status: "Inquiry" };

      if (hasDb()) {
        await redis(["SET", `tours:inq:${ref}`, JSON.stringify(rec), "EX", String(800 * 86400)]).catch(() => {});
        await redis(["RPUSH", "tours:inq:list", ref]).catch(() => {});
      }
      res.json({ ok: true, ref });

      // after replying: notifications (never block the guest)
      const paxTxt = `${adults} adult${adults > 1 ? "s" : ""}${kids ? `, ${kids} child${kids > 1 ? "ren" : ""}` : ""}`;
      const lines = [["Ref ID", ref], ["Tour", tourName + (tourType ? ` (${tourType})` : "")], ["Preferred date", rec.date], ["Guests", paxTxt],
        ["Name", name], ["Email", email], ["Mobile / WhatsApp", mobile || "(not given)"], ["Notes", notes || "(none)"]];
      const table = `<table style="border-collapse:collapse;font:14px/20px Arial,sans-serif">${lines.map(([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#4a5170;vertical-align:top"><b>${esc(k)}</b></td><td style="padding:6px 0">${esc(v)}</td></tr>`).join("")}</table>`;
      const text = lines.map(([k, v]) => `${k}: ${v}`).join("\n");

      Promise.resolve().then(() => notifyAdmin({ title: `New tour inquiry ${ref}`, message: `${name} · ${tourName} · ${rec.date} · ${paxTxt}`, tags: "airplane" })).catch(() => {});

      if (mailer.configured()) {
        mailer.sendRaw({ to: ownerEmail(), subject: `Tour inquiry ${ref}: ${tourName}`,
          html: `<p>New tour inquiry from 3ukph.com/tours.</p>${table}<p>Tracker: add or check this Ref ID in the TripHappy tracker sheet.</p>`, text }).catch((e) => console.error("[tours] owner email:", e.message));

        const partner = String(process.env.TOURS_PARTNER_EMAIL || "").split(",").map((s) => s.trim()).filter((s) => mailer.validEmail(s));
        for (const to of partner) {
          mailer.sendRaw({ to, subject: `New guest from 3UK Philippines (${ref}): ${tourName}`,
            html: `<p>Hi ${esc(data.partner || "team")},</p><p>A 3UK Philippines customer would like to book a tour. Please contact them to finalize the itinerary and date, and quote <b>Ref ID ${esc(ref)}</b> in the tracker when the booking is confirmed.</p>${table}<p>Thank you!<br>3UK Philippines · admin@3ukph.com</p>`,
            text: `A 3UK Philippines customer would like to book a tour. Please contact them and use Ref ID ${ref} in the tracker.\n\n${text}` }).catch((e) => console.error("[tours] partner email:", e.message));
        }

        mailer.sendRaw({ to: email, subject: `We got your tour request (${ref})`,
          html: `<div style="font:15px/22px Arial,sans-serif;color:#0b1233;max-width:560px"><p>Hi ${esc(name.split(" ")[0])},</p>
<p>Thanks for your interest in <b>${esc(tourName)}</b>. Our travel partner <b>${esc(data.partner || "")}</b> will contact you soon by email${mobile ? " or mobile" : ""} to plan the itinerary, date and price with you.</p>
<p>Your reference: <b>${esc(ref)}</b></p>
<p>Traveling abroad? Get your data ready before you fly with a 3UK travel eSIM: <a href="${esc(publicUrl || "https://3ukph.com")}">3ukph.com</a></p>
<p>3UK Philippines<br>admin@3ukph.com · WhatsApp +63 934 706 9356</p></div>`,
          text: `Hi ${name.split(" ")[0]},\n\nThanks for your interest in ${tourName}. Our travel partner ${data.partner || ""} will contact you soon to plan the itinerary, date and price.\n\nYour reference: ${ref}\n\n3UK Philippines · admin@3ukph.com` })
          .catch((e) => console.error("[tours] guest email:", e.message));
      }

      const hook = process.env.TOURS_SHEET_WEBHOOK;
      if (hook && /^https:\/\/script\.google\.com\//.test(hook)) {
        fetch(hook, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
          body: JSON.stringify({ secret: process.env.TOURS_SHEET_SECRET || "", ref, day: rec.day, name, contact: [email, mobile].filter(Boolean).join(" / "),
            tour: tourName, type: tourType, date: rec.date, pax: rec.pax, notes: [notes, kids ? paxTxt : ""].filter(Boolean).join(" · ") }) })
          .then(async (r) => { const t = await r.text().catch(() => ""); if (!/"ok"\s*:\s*true/.test(t)) console.error("[tours] sheet webhook:", r.status, t.slice(0, 200)); })
          .catch((e) => console.error("[tours] sheet webhook:", e.message));
      }
    } catch (e) {
      console.error("[tours] inquiry failed:", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please message us on WhatsApp." });
    }
  });

  app.get("/admin/api/tours/inquiries", requireAdmin, async (req, res) => {
    if (!hasDb()) return res.json({ inquiries: [] });
    const refs = (await redis(["LRANGE", "tours:inq:list", "-300", "-1"]).catch(() => [])) || [];
    const vals = refs.length ? (await redis(["MGET", ...refs.map((r) => `tours:inq:${r}`)]).catch(() => [])) || [] : [];
    const list = vals.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean).reverse();
    if (req.query.format === "csv") {
      const cols = ["ref", "day", "name", "email", "mobile", "tour", "type", "date", "adults", "kids", "notes"];
      const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
      res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", "attachment; filename=tour-inquiries.csv");
      return res.send([cols.join(","), ...list.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n"));
    }
    res.json({ inquiries: list });
  });
}

module.exports = { install, loadData };
