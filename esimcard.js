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
    unlimited: /unlimited/i.test(JSON.stringify(d).slice(0, 2000)) || undefined,
    status: pick("status", "sim_status", "bundle_status"),
    expires: pick("expiry_date", "expire_date", "end_date", "valid_until", "expired_at"),
    bundle: pick("bundle_name", "package_name", "name")
  };
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
  return { iccid, ...summarize(raw), raw };
}

function configured() { return !!TOKEN; }

module.exports = { init, isIccid, cleanIccid, listEsims, addEsim, removeEsim, findCustomerByIccid, usage, configured, call };
