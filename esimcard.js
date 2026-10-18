// esimcard.js
//
// eSIM records + live data usage from eSIMCard.
//
// 1) eSIM records (permanent, in Upstash): the admin saves each delivered eSIM
//    (ICCID, plan, email, date) under the customer in the Admin Console.
//      esims:<customerId>  = JSON list of records
//      esim:iccid:<iccid>  = customerId   (to search by ICCID)
// 2) Data usage: asks the eSIMCard developer API (same calls as eSIMCard's
//    official SDK): GET check-token -> { extension }, then
//    GET <extension>/my-sim/<id>/usage. Needs ESIMCARD_TOKEN in Render
//    (the API key from the eSIMCard partner dashboard).

const TOKEN = (process.env.ESIMCARD_TOKEN || "").trim();
const BASE = ((process.env.ESIMCARD_API_URL || "https://portal.esimcard.com/api/developer/").trim().replace(/\/?$/, "/"));

let redis = null;
const memory = new Map();
function init(redisFn) { redis = redisFn; }

const cleanIccid = (v) => String(v || "").replace(/\D/g, "");
const isIccid = (v) => /^89\d{16,20}$/.test(cleanIccid(v));

// ---- Records -------------------------------------------------------------
async function listEsims(customerId) {
  if (!redis) return memory.get(customerId) || [];
  const v = await redis(["GET", `esims:${customerId}`]);
  try { return v ? JSON.parse(v) : []; } catch { return []; }
}
async function saveList(customerId, list) {
  if (!redis) { memory.set(customerId, list); return; }
  await redis(["SET", `esims:${customerId}`, JSON.stringify(list)]);
}
async function addEsim(customerId, rec) {
  const iccid = cleanIccid(rec.iccid);
  if (!isIccid(iccid)) throw new Error("That doesn't look like an ICCID (it starts with 89 and has 18-22 digits).");
  const list = await listEsims(customerId);
  if (list.some((e) => e.iccid === iccid)) throw new Error("This ICCID is already saved for this customer.");
  const entry = {
    iccid,
    plan: String(rec.plan || "").slice(0, 120),
    email: String(rec.email || "").slice(0, 120),
    note: String(rec.note || "").slice(0, 200),
    addedAt: new Date().toISOString()
  };
  list.unshift(entry);
  await saveList(customerId, list.slice(0, 100));
  if (redis) await redis(["SET", `esim:iccid:${iccid}`, customerId]);
  return entry;
}
async function removeEsim(customerId, iccid) {
  iccid = cleanIccid(iccid);
  const list = (await listEsims(customerId)).filter((e) => e.iccid !== iccid);
  await saveList(customerId, list);
  if (redis) await redis(["DEL", `esim:iccid:${iccid}`]);
  return list;
}
async function findCustomerByIccid(iccid) {
  iccid = cleanIccid(iccid);
  if (!redis) { for (const [c, l] of memory) if (l.some((e) => e.iccid === iccid)) return c; return null; }
  return await redis(["GET", `esim:iccid:${iccid}`]);
}

// ---- eSIMCard API --------------------------------------------------------
let ext = null;
async function api(path) {
  if (!TOKEN) throw new Error("ESIMCARD_TOKEN is not set in Render.");
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) { const e = new Error(`eSIMCard ${r.status}: ${(data && (data.message || data.error)) || text.slice(0, 120)}`); e.status = r.status; e.data = data; throw e; }
  return data;
}
async function extension() {
  if (ext) return ext;
  const d = await api("check-token");
  ext = (d && (d.extension || (d.data && d.data.extension))) || "";
  if (!ext) throw new Error("eSIMCard token check didn't return an account type.");
  return ext;
}
async function call(path) { return api(`${await extension()}/${path}`); }

// Find eSIMCard's own id for an ICCID (some accounts use ids, not ICCIDs, in URLs).
async function findSimId(iccid) {
  for (let page = 1; page <= 10; page++) {
    const d = await call(`my-esims?page=${page}`);
    const list = Array.isArray(d) ? d : (d.data && Array.isArray(d.data) ? d.data : (d.data && Array.isArray(d.data.data) ? d.data.data : []));
    const hit = list.find((s) => cleanIccid(s.iccid) === iccid);
    if (hit) return hit.id || hit.sim_id || hit.uuid;
    if (list.length === 0) break;
  }
  return null;
}

function num(v) { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; }
function toGB(value, unit) {
  if (value === null) return null;
  const u = String(unit || "").toUpperCase();
  if (u.startsWith("MB")) return value / 1024;
  if (u.startsWith("KB")) return value / 1048576;
  if (u === "B" || u.startsWith("BYTE")) return value / 1073741824;
  return value; // assume GB
}

// Unlimited only when a field really says so (not just a key like "is_unlimited": false).
function isUnlimited(d) {
  let yes = false;
  walk(d, (k, v) => {
    if (yes) return;
    if (/unlimited/i.test(k) && (v === true || v === 1 || /^(1|true|yes)$/i.test(String(v)))) yes = true;
    else if (/(quantity|data|unit|amount|volume|allowance)/i.test(k) && typeof v === "string" && /^\s*unlimited\s*$/i.test(v)) yes = true;
  });
  return yes;
}

// Normalize whatever shape the API returns into a friendly summary.
function summarize(raw) {
  const d = (raw && (raw.data || raw)) || {};
  const pick = (...keys) => { for (const k of keys) if (d[k] !== undefined && d[k] !== null) return d[k]; return undefined; };
  const unit = pick("unit", "data_unit");
  const total = toGB(num(pick("initial_data_quantity", "total_data", "total", "data_total", "initial_data")), pick("initial_data_unit", "total_unit") || unit);
  const remaining = toGB(num(pick("rem_data_quantity", "remaining_data", "remaining", "data_remaining", "rem_data")), pick("rem_data_unit", "remaining_unit") || unit);
  let used = toGB(num(pick("used_data", "used", "data_used", "usage")), pick("used_unit") || unit);
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  const fmt = (g) => (g === null || g === undefined ? null : g >= 1 ? `${g.toFixed(2)} GB` : `${Math.round(g * 1024)} MB`);
  return {
    total: fmt(total), used: fmt(used), remaining: fmt(remaining !== null ? remaining : (total !== null && used !== null ? total - used : null)),
    percentUsed: total ? Math.round(((used || 0) / total) * 100) : null,
    unlimited: isUnlimited(d) || undefined,
    status: pick("status", "sim_status", "bundle_status"),
    expires: pick("expiry_date", "expire_date", "end_date", "valid_until", "expired_at"),
    bundle: pick("bundle_name", "package_name", "name")
  };
}

// ---- Expiry / status: the response shape varies by account, so search it --
function walk(obj, fn, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") walk(v, fn, depth + 1);
    else fn(k, v);
  }
}
function parseDate(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v); const d = new Date(n < 1e12 ? n * 1000 : n);
    return d.getFullYear() > 2015 && d.getFullYear() < 2100 ? d : null;
  }
  const s = String(v).trim();
  if (!/\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s)) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") + (/[zZ+]/.test(s.slice(10)) ? "" : "Z") : s);
  return isNaN(d) || d.getFullYear() < 2015 || d.getFullYear() > 2100 ? null : d;
}
function findDate(obj, re) {
  let hit = null;
  walk(obj, (k, v) => { if (!hit && re.test(k)) { const d = parseDate(v); if (d) hit = d; } });
  return hit;
}
function findNum(obj, re) {
  let hit = null;
  walk(obj, (k, v) => { if (hit === null && re.test(k)) { const n = num(v); if (n !== null && n > 0 && n <= 3650) hit = n; } });
  return hit;
}
function findStr(obj, re) {
  let hit = null;
  walk(obj, (k, v) => { if (!hit && re.test(k) && typeof v === "string" && v.length < 60) hit = v; });
  return hit;
}
const EXPIRY_KEYS = /(expir|valid_?until|valid_?to|valid_?till|end_?(date|time|at|on)$|^ends?_at$)/i;
const START_KEYS = /(activat|first_?use|start_?(date|time|at|on)|installed_?at)/i;
const VALIDITY_KEYS = /(validity|duration|_days$|^days$|valid_?days|period)/i;

function lifecycle(...raws) {
  let expires = null, activated = null, validityDays = null, status = null, name = null;
  for (const r of raws) {
    if (!r) continue;
    expires = expires || findDate(r, EXPIRY_KEYS);
    activated = activated || findDate(r, START_KEYS);
    validityDays = validityDays || findNum(r, VALIDITY_KEYS);
    status = status || findStr(r, /status|state/i);
    name = name || findStr(r, /^(bundle_?name|package_?name|plan_?name|bundle|package|plan)$/i);
  }
  let estimated = false;
  if (!expires && activated && validityDays) { expires = new Date(activated.getTime() + validityDays * 86400000); estimated = true; }
  return { expires: expires ? expires.toISOString() : null, expiresEstimated: estimated || undefined, activated: activated ? activated.toISOString() : null, validityDays, statusText: status, name };
}

// SIM details (packages, dates). Best effort; cached because dates rarely change.
const detailCache = new Map();
// Index of all eSIMs on the account (iccid -> list entry), from my-esims pages.
let simIndex = { at: 0, map: new Map(), ok: false };
async function loadIndex() {
  const map = new Map();
  for (let page = 1; page <= 40; page++) {
    const d = await call(`my-esims?page=${page}`);
    const list = Array.isArray(d) ? d : (d.data && Array.isArray(d.data) ? d.data : (d.data && Array.isArray(d.data.data) ? d.data.data : []));
    for (const x of list) { const ic = cleanIccid(x.iccid || (x.sim && x.sim.iccid)); if (ic) map.set(ic, x); }
    const last = d && (d.last_page || (d.meta && d.meta.last_page) || (d.data && d.data.last_page));
    if (!list.length || (last && page >= last)) break;
  }
  simIndex = { at: Date.now(), map, ok: true };
  return simIndex;
}
// Returns { found: true, entry } / { found: false } / { found: null } when the list can't be read.
async function findEntry(iccid) {
  iccid = cleanIccid(iccid);
  try {
    if (!simIndex.ok || Date.now() - simIndex.at > 10 * 60000) await loadIndex();
    let e = simIndex.map.get(iccid);
    if (!e && Date.now() - simIndex.at > 60000) { await loadIndex(); e = simIndex.map.get(iccid); }
    return e ? { found: true, entry: e } : { found: false };
  } catch (err) {
    console.error("[esimcard] list failed:", err.message);
    return { found: null };
  }
}

async function details(iccid) {
  iccid = cleanIccid(iccid);
  const f = await findEntry(iccid);
  return { found: f.found, listEntry: f.entry || null };
}

async function usage(iccid) {
  iccid = cleanIccid(iccid);
  let raw;
  try { raw = await call(`my-sim/${iccid}/usage`); }
  catch (e) {
    if (e.status !== 404 && e.status !== 422 && e.status !== 400) throw e;
    const id = await findSimId(iccid);
    if (!id) throw new Error("This ICCID wasn't found in the eSIMCard account.");
    raw = await call(`my-sim/${id}/usage`);
  }
  const sum = summarize(raw);
  let det = null;
  try { det = await details(iccid); } catch { det = null; }
  const le = (det && det.listEntry) || {};
  const life = lifecycle(raw, det);
  return { iccid, ...sum, onAccount: det ? det.found : null, bundle: le.last_bundle || sum.bundle || life.name || undefined,
    purchasedAt: (parseDate(le.created_at) || {}).toISOString ? parseDate(le.created_at).toISOString() : null,
    installedAt: (parseDate(le.installed_at) || {}).toISOString ? parseDate(le.installed_at).toISOString() : null,
    expires: life.expires || sum.expires || null, expiresEstimated: life.expiresEstimated, activated: life.activated, validityDays: life.validityDays, statusText: sum.status || life.statusText || null, raw, details: det };
}

function configured() { return !!TOKEN; }

module.exports = { init, isIccid, cleanIccid, listEsims, addEsim, removeEsim, findCustomerByIccid, usage, details, findEntry, configured, call };
