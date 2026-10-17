// reseller.js
//
// Reseller program: approved resellers get a lower price than retail so they
// can resell at a profit.
//
//   Starter reseller (free to join): cost + RESELLER_STARTER_MARKUP % (default 25)
//   Gold reseller (₱5,000+ wallet):  cost + RESELLER_GOLD_MARKUP % (default 20)
//
// Prices are rounded UP to the whole peso. If cost + markup would leave the
// reseller less than RESELLER_MIN_PROFIT pesos (default 30) when they sell at
// our retail price, the reseller price is lowered to retail - that amount.
// On very cheap plans where even that doesn't fit, we split the margin 50/50.
// (Same rules as the "3UKPH_Reseller_Pricing_INTERNAL.xlsx" workbook.)
//
// YOUR COST is private. It is NOT stored in this (public) GitHub repo. Upload
// the eSIMCard "reseller_pricing" export in the Admin Console
// (https://3ukph.com/admin/console -> Reseller prices). It is saved in your
// Upstash database and reloaded on every restart. If the price sheet at
// PRICE_SHEET_URL has a "Price" (cost) column, costs are refreshed from it too.
//
// Approved resellers (by Messenger ID) are also saved in Upstash
// ("reseller:member:<id>"). Approve or remove them in the Admin Console.

const zlib = require("zlib");

const STARTER = Number(process.env.RESELLER_STARTER_MARKUP ?? 25) / 100;
const GOLD = Number(process.env.RESELLER_GOLD_MARKUP ?? 20) / 100;
const MIN_PROFIT = Number(process.env.RESELLER_MIN_PROFIT ?? 30);

let redis = null;          // async (command[]) => result, or null when Upstash isn't set
let costs = new Map();     // costKey -> cost in USD
let costsInfo = { count: 0, updatedAt: null, source: "none" };
const membersMemory = new Map(); // fallback when Upstash isn't set

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function costKey(destination, name, validityDays, retailUSD) {
  return [norm(destination), norm(name), Math.round(Number(validityDays) || 0), (Math.round(Number(retailUSD) * 100) / 100).toFixed(2)].join("|");
}

// --- Costs -----------------------------------------------------------------
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
  }
  return String(v);
}
function cellNumber(v) {
  if (v && typeof v === "object" && v.result !== undefined) v = v.result;
  const n = typeof v === "number" ? v : parseFloat(String(v || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

// Reads an ExcelJS workbook with columns Destination, Name, Validity, Price (= cost), Retail Price.
function costsFromWorkbook(wb) {
  const map = new Map();
  wb.eachSheet((ws) => {
    const header = {};
    ws.getRow(1).eachCell((c, col) => (header[cellText(c.value).trim().toLowerCase()] = col));
    const need = ["destination", "name", "validity", "price", "retail price"];
    if (need.some((h) => !header[h])) return;
    ws.eachRow((row, r) => {
      if (r === 1) return;
      let dest = cellText(row.getCell(header["destination"]).value).trim();
      const name = cellText(row.getCell(header["name"]).value).trim();
      const cost = cellNumber(row.getCell(header["price"]).value);
      const retail = cellNumber(row.getCell(header["retail price"]).value);
      const days = cellNumber(row.getCell(header["validity"]).value);
      if (!dest || !name || !(cost > 0) || !(retail > 0)) return;
      map.set(costKey(dest, name, days, retail), Math.round(cost * 100) / 100);
    });
  });
  return map;
}

async function saveCosts(map, source) {
  costs = map;
  costsInfo = { count: map.size, updatedAt: new Date().toISOString(), source };
  if (!redis) return { saved: false };
  const packed = zlib.gzipSync(JSON.stringify({ info: costsInfo, costs: [...map] })).toString("base64");
  await redis(["SET", "reseller:costs", packed]);
  return { saved: true };
}

async function loadCosts() {
  if (!redis) return;
  try {
    const packed = await redis(["GET", "reseller:costs"]);
    if (!packed) return console.log("[reseller] No reseller costs uploaded yet (Admin Console -> Reseller prices).");
    const data = JSON.parse(zlib.gunzipSync(Buffer.from(packed, "base64")).toString("utf8"));
    costs = new Map(data.costs);
    costsInfo = data.info || { count: costs.size };
    console.log(`[reseller] Loaded costs for ${costs.size} plans (uploaded ${costsInfo.updatedAt}).`);
  } catch (err) {
    console.error("[reseller] Could not load reseller costs:", err.message);
  }
}

// --- Prices ----------------------------------------------------------------
function tierMarkup(tier) {
  return tier === "gold" ? GOLD : STARTER;
}

// rawPlan: catalog entry (destination, name, validityDays, retailPrice in USD). rate: pesos per USD.
function resellerPrice(rawPlan, tier, rate) {
  if (!rawPlan) return null;
  const cost = costs.get(costKey(rawPlan.destination, rawPlan.name, rawPlan.validityDays, rawPlan.retailPrice));
  if (!(cost > 0)) return null;
  const cp = cost * rate;
  const rp = Math.round(rawPlan.retailPrice * rate * 100) / 100;
  const target = Math.ceil(+(cp * (1 + tierMarkup(tier))).toFixed(6));
  const cap = rp - MIN_PROFIT;
  const price = target <= cap ? target : Math.max(Math.floor(cap), Math.ceil(+(cp + (rp - cp) / 2).toFixed(6)));
  if (!(price > cp) || price > rp) return null; // safety: never below cost or above retail
  return { pricePHP: price, profitAtRetailPHP: Math.round((rp - price) * 100) / 100 };
}

// --- Members ---------------------------------------------------------------
async function getMember(psid) {
  if (!psid) return null;
  if (!redis) return membersMemory.get(psid) || null;
  const v = await redis(["GET", `reseller:member:${psid}`]);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

async function setMember(psid, record) {
  if (!record) {
    membersMemory.delete(psid);
    if (redis) await redis(["DEL", `reseller:member:${psid}`]);
    return null;
  }
  const rec = { tier: record.tier === "gold" ? "gold" : "starter", name: String(record.name || "").slice(0, 80), contact: String(record.contact || "").slice(0, 120), since: record.since || new Date().toISOString() };
  membersMemory.set(psid, rec);
  if (redis) await redis(["SET", `reseller:member:${psid}`, JSON.stringify(rec)]);
  return rec;
}

async function listMembers() {
  if (!redis) return [...membersMemory].filter(([k]) => !k.startsWith("applicant:")).map(([psid, r]) => ({ psid, ...r }));
  const keys = (await redis(["KEYS", "reseller:member:*"])) || [];
  const out = [];
  for (const k of keys.slice(0, 200)) {
    const r = await getMember(k.split(":").pop()).catch(() => null);
    if (r) out.push({ psid: k.split(":").pop(), ...r });
  }
  return out.sort((a, b) => String(a.since).localeCompare(String(b.since)));
}

function init(redisFn) {
  redis = redisFn;
  return loadCosts();
}

function getCostsInfo() {
  return { ...costsInfo, starterMarkupPercent: STARTER * 100, goldMarkupPercent: GOLD * 100, minResellerProfit: MIN_PROFIT };
}

module.exports = { init, costsFromWorkbook, saveCosts, resellerPrice, getMember, setMember, listMembers, getCostsInfo };

// --- Wallet + purchase tracker ---------------------------------------------
// Balance:  reseller:wallet:<psid>  (integer, in centavos, so no rounding drift)
// History:  reseller:ledger:<psid>  (newest first, last 1000 entries)
// Entry types: topup (+), order (wallet: -, other payment: 0), refund (+), adjust (+/-)
const LEDGER_MAX = 1000;
const walletMemory = new Map();
const ledgerMemory = new Map();
const cents = (php) => Math.round(Number(php) * 100);

async function getBalance(psid) {
  if (!redis) return (walletMemory.get(psid) || 0) / 100;
  return (Number(await redis(["GET", `reseller:wallet:${psid}`])) || 0) / 100;
}

async function addLedger(psid, entry) {
  const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), ...entry };
  if (!redis) {
    const l = ledgerMemory.get(psid) || [];
    l.unshift(e); l.length = Math.min(l.length, LEDGER_MAX); ledgerMemory.set(psid, l);
    return e;
  }
  await redis(["LPUSH", `reseller:ledger:${psid}`, JSON.stringify(e)]);
  await redis(["LTRIM", `reseller:ledger:${psid}`, 0, LEDGER_MAX - 1]);
  return e;
}

async function getLedger(psid, limit = 200) {
  if (!redis) return (ledgerMemory.get(psid) || []).slice(0, limit);
  const rows = (await redis(["LRANGE", `reseller:ledger:${psid}`, 0, limit - 1])) || [];
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

// Changes the balance by `deltaPHP` (negative = deduct). If allowNegative is false
// and the balance would go below zero, nothing changes and { ok:false } is returned.
async function changeBalance(psid, deltaPHP, allowNegative) {
  const d = cents(deltaPHP);
  if (!redis) {
    const now = (walletMemory.get(psid) || 0) + d;
    if (now < 0 && !allowNegative) return { ok: false, balance: (now - d) / 100 };
    walletMemory.set(psid, now);
    return { ok: true, balance: now / 100 };
  }
  const now = Number(await redis(["INCRBY", `reseller:wallet:${psid}`, d]));
  if (now < 0 && !allowNegative) {
    const back = Number(await redis(["INCRBY", `reseller:wallet:${psid}`, -d]));
    return { ok: false, balance: back / 100 };
  }
  return { ok: true, balance: now / 100 };
}

// Admin: top-up, refund or adjust. amountPHP > 0 adds, adjust may be negative.
async function walletTransaction(psid, { type, amountPHP, note, by }) {
  if (!["topup", "refund", "adjust"].includes(type)) throw new Error("Type must be topup, refund or adjust.");
  const amt = Math.round(Number(amountPHP) * 100) / 100;
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1000000) throw new Error("Enter a valid amount.");
  if (type !== "adjust" && amt < 0) throw new Error("Top-ups and refunds must be positive.");
  const r = await changeBalance(psid, amt, true);
  const entry = await addLedger(psid, { type, amount: amt, balanceAfter: r.balance, note: String(note || "").slice(0, 200), by: by || "admin" });
  return { balance: r.balance, entry };
}

// Bot: a reseller order paid from the wallet. Deducts only if the balance covers it.
async function walletOrder(psid, { pricePHP, plan, retailPHP, email }) {
  const r = await changeBalance(psid, -pricePHP, false);
  if (!r.ok) return { ok: false, balance: r.balance };
  const entry = await addLedger(psid, { type: "order", method: "Wallet", amount: -pricePHP, balanceAfter: r.balance, plan, retail: retailPHP, email, status: "paid from wallet" });
  return { ok: true, balance: r.balance, entry };
}

// Bot: a reseller order paid another way (GCash etc.) -- logged, balance unchanged.
async function logOrder(psid, { pricePHP, plan, retailPHP, method, email }) {
  const balance = await getBalance(psid);
  return addLedger(psid, { type: "order", method, amount: 0, price: pricePHP, balanceAfter: balance, plan, retail: retailPHP, email, status: `awaiting ${method} payment` });
}

function summarize(ledger) {
  const orders = ledger.filter((e) => e.type === "order");
  const spent = (e) => (e.method === "Wallet" ? -e.amount : e.price || 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const month = orders.filter((e) => String(e.at).startsWith(monthKey));
  return {
    orders: orders.length,
    purchased: Math.round(orders.reduce((s, e) => s + spent(e), 0) * 100) / 100,
    ordersThisMonth: month.length,
    purchasedThisMonth: Math.round(month.reduce((s, e) => s + spent(e), 0) * 100) / 100,
    toppedUp: Math.round(ledger.filter((e) => e.type === "topup").reduce((s, e) => s + e.amount, 0) * 100) / 100,
    lastOrderAt: orders[0] ? orders[0].at : null
  };
}

// Name/contact from the Messenger application, used when the admin approves.
async function saveApplicant(psid, info) {
  const rec = { name: String(info.name || "").slice(0, 80), contact: String(info.contact || "").slice(0, 120), at: new Date().toISOString() };
  membersMemory.set("applicant:" + psid, rec);
  if (redis) await redis(["SET", `reseller:applicant:${psid}`, JSON.stringify(rec)]);
}
async function getApplicant(psid) {
  if (!redis) return membersMemory.get("applicant:" + psid) || null;
  const v = await redis(["GET", `reseller:applicant:${psid}`]);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

Object.assign(module.exports, { saveApplicant, getApplicant, getBalance, getLedger, walletTransaction, walletOrder, logOrder, summarize });
