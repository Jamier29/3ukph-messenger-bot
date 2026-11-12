// partners.js
//
// Referral partners (e.g. travel agencies). A customer is linked to a partner when:
//   - they open our Messenger link with ?ref=CODE   (m.me/103294518884622?ref=TRIPHAPPY)
//   - they come from our website opened with ?ref=CODE (the website adds "Partner: CODE" to the chat)
//   - they type the partner code in any message (e.g. "TRIPHAPPY")
// The link lasts LINK_DAYS (365). Every PAID order from a linked customer is recorded for that
// partner with its commission, so the console can show a monthly statement.
// Partner codes give no discount; they only credit the partner.
//
// Render setting (optional): PARTNERS = "CODE:Display name:commission%,..."
// default: "TRIPHAPPY:TRIPHAPPY.PH:8"

const LINK_DAYS = Number(process.env.PARTNER_LINK_DAYS || 365);

const PARTNERS = {};
for (const part of (process.env.PARTNERS || "TRIPHAPPY:TRIPHAPPY.PH:8").split(",")) {
  const [code, name, pct] = part.split(":").map((x) => (x || "").trim());
  const n = Number(pct);
  if (code && n >= 0 && n < 50) PARTNERS[code.toUpperCase()] = { code: code.toUpperCase(), name: name || code, pct: n };
}

let redis = null;
const memLink = new Map();
const memOrders = new Map();
const memDone = new Set();
function init(redisFn) { redis = redisFn; }

const norm = (c) => String(c || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
function isCode(code) { return !!PARTNERS[norm(code)]; }
function info(code) { return PARTNERS[norm(code)] || null; }
function list() { return Object.values(PARTNERS); }

// Finds a partner code written anywhere in a message ("TRIPHAPPY", "ref: triphappy", "Partner: TRIPHAPPY").
function findCodeInText(text) {
  const t = String(text || "").toUpperCase();
  for (const code of Object.keys(PARTNERS)) {
    if (new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`).test(t)) return code;
    // Also "Trip Happy", "triphappy.ph", "trip-happy" (long codes only, to avoid false matches).
    if (code.length >= 6 && t.replace(/[^A-Z0-9]/g, "").includes(code)) return code;
  }
  return null;
}

async function attach(senderId, code, source) {
  const c = norm(code);
  if (!senderId || !PARTNERS[c]) return false;
  const rec = { code: c, source: source || "", at: Date.now() };
  memLink.set(String(senderId), rec);
  if (redis) await redis(["SET", `partner:link:${senderId}`, JSON.stringify(rec), "EX", String(LINK_DAYS * 86400)]).catch(() => {});
  console.log(`[partners] ${senderId} linked to ${c} (${source || "?"})`);
  return true;
}
async function linkOf(senderId) {
  if (redis) {
    try { const v = await redis(["GET", `partner:link:${senderId}`]); if (v) return JSON.parse(v); } catch (_) { /* ignore */ }
  }
  const m = memLink.get(String(senderId));
  return m && Date.now() - m.at < LINK_DAYS * 86400000 ? m : null;
}

// Call for every incoming customer message.
async function noteText(senderId, text) {
  const code = findCodeInText(text);
  if (code) await attach(senderId, code, "typed");
  return code;
}

// The reseller wallet (chat id) that receives this partner's commission automatically, or null (paid out monthly).
const memWallet = new Map();
async function walletOf(code) {
  const c = norm(code);
  if (redis) { try { return (await redis(["GET", `partner:wallet:${c}`])) || null; } catch (_) { return null; } }
  return memWallet.get(c) || null;
}
async function setWallet(code, psid) {
  const c = norm(code);
  if (!PARTNERS[c]) throw new Error("Unknown partner code.");
  const v = String(psid || "").trim();
  if (v && !/^(wa)?\d+$/.test(v)) throw new Error("Bad chat id.");
  if (redis) await redis(v ? ["SET", `partner:wallet:${c}`, v] : ["DEL", `partner:wallet:${c}`]);
  else if (v) memWallet.set(c, v); else memWallet.delete(c);
  return v || null;
}

// Record a PAID order for the customer's partner (once per orderRef). Returns the record or null.
// creditWallet(walletPsid, rec) is called when the partner has a commission wallet; it should return true when credited.
async function recordPaid({ senderId, orderRef, amountPHP, plan, quantity, creditWallet }) {
  try {
    const link = await linkOf(senderId);
    if (!link || !PARTNERS[link.code] || !(amountPHP > 0) || !orderRef) return null;
    const p = PARTNERS[link.code];
    const key = `partner:done:${orderRef}`;
    if (redis) {
      const ok = await redis(["SET", key, "1", "NX", "EX", String(400 * 86400)]);
      if (ok !== "OK") return null;
    } else {
      if (memDone.has(key)) return null;
      memDone.add(key);
    }
    const rec = {
      at: new Date().toISOString(), orderRef: String(orderRef), customer: String(senderId),
      plan: String(plan || "").slice(0, 120), quantity: quantity || 1,
      amountPHP: Math.round(amountPHP * 100) / 100, pct: p.pct,
      commissionPHP: Math.round(amountPHP * p.pct) / 100, via: link.source || ""
    };
    const wallet = await walletOf(p.code);
    if (wallet && creditWallet && rec.commissionPHP > 0) {
      try { rec.creditedToWallet = !!(await creditWallet(wallet, rec)); if (rec.creditedToWallet) rec.wallet = wallet; }
      catch (e) { console.error("[partners] wallet credit failed:", e.message); rec.creditedToWallet = false; }
    }
    if (redis) await redis(["RPUSH", `partner:orders:${p.code}`, JSON.stringify(rec)]);
    else { const a = memOrders.get(p.code) || []; a.push(rec); memOrders.set(p.code, a); }
    console.log(`[partners] ${p.code} credited ₱${rec.commissionPHP} for ${rec.orderRef} (₱${rec.amountPHP})`);
    return { partner: p, rec };
  } catch (e) {
    console.error("[partners] record failed:", e.message);
    return null;
  }
}

// All recorded orders for a partner, optionally for one month "YYYY-MM" (Manila time).
async function statement(code, month) {
  const p = info(code);
  if (!p) return null;
  let rows = [];
  if (redis) {
    const v = await redis(["LRANGE", `partner:orders:${p.code}`, "0", "-1"]).catch(() => []);
    rows = (v || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  } else rows = memOrders.get(p.code) || [];
  const manilaMonth = (iso) => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 7);
  if (month) rows = rows.filter((r) => manilaMonth(r.at) === month);
  const sales = rows.reduce((s, r) => s + r.amountPHP, 0);
  const commission = rows.reduce((s, r) => s + r.commissionPHP, 0);
  const credited = rows.filter((r) => r.creditedToWallet).reduce((s, r) => s + r.commissionPHP, 0);
  return { partner: p, month: month || "all", orders: rows.length, salesPHP: Math.round(sales * 100) / 100, commissionPHP: Math.round(commission * 100) / 100,
    creditedToWalletPHP: Math.round(credited * 100) / 100, stillToPayPHP: Math.round((commission - credited) * 100) / 100, wallet: await walletOf(p.code), rows };
}

module.exports = { init, isCode, info, list, findCodeInText, attach, linkOf, noteText, recordPaid, statement, walletOf, setWallet };
