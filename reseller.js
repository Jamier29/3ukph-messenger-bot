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
  const rec = { tier: record.tier === "gold" ? "gold" : "starter", name: String(record.name || "").slice(0, 80), since: record.since || new Date().toISOString() };
  membersMemory.set(psid, rec);
  if (redis) await redis(["SET", `reseller:member:${psid}`, JSON.stringify(rec)]);
  return rec;
}

async function listMembers() {
  if (!redis) return [...membersMemory].map(([psid, r]) => ({ psid, ...r }));
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
