// guard.js
//
// Keeps "chat trippers" (people who only play with the AI) from using up the bot,
// without ever blocking a real customer.
//
// 1. Strikes: the AI calls the flag_troll tool when a message is clearly trolling,
//    abusive, sexual, a jailbreak attempt or pure nonsense. 3 strikes within 24 hours
//    => the AI goes quiet for that person for MUTE_HOURS (one short notice is sent).
// 2. Flood limit: more than FLOOD_MAX messages in FLOOD_WINDOW_MIN minutes => 10-minute
//    cooldown (one short notice is sent).
// While muted / cooling down, a message that looks like a real eSIM question
// (destination, price, order, payment, install...) still gets through to the AI.
// Customers who already ordered and resellers are never limited.
//
// Render settings (optional): TROLL_STRIKES (3), TROLL_MUTE_HOURS (12),
// FLOOD_MAX (15), FLOOD_WINDOW_MIN (5).

const STRIKES = Number(process.env.TROLL_STRIKES || 3);
const MUTE_HOURS = Number(process.env.TROLL_MUTE_HOURS || 12);
const FLOOD_MAX = Number(process.env.FLOOD_MAX || 15);
const FLOOD_WINDOW_MIN = Number(process.env.FLOOD_WINDOW_MIN || 5);
const COOLDOWN_MIN = 10;

let redis = null;
const mem = new Map(); // fallback when there is no database: key -> { v, exp }
function init(redisFn) { redis = redisFn; }

function memGet(k) { const e = mem.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; } return e.v; }
function memSet(k, v, sec) { mem.set(k, { v, exp: sec ? Date.now() + sec * 1000 : 0 }); if (mem.size > 5000) mem.delete(mem.keys().next().value); }
async function incr(key, ttlSec) {
  if (redis) {
    const n = Number(await redis(["INCR", key]));
    if (n === 1) await redis(["EXPIRE", key, String(ttlSec)]);
    return n;
  }
  const n = Number(memGet(key) || 0) + 1;
  const e = mem.get(key); memSet(key, n, e && e.exp ? Math.max(1, Math.round((e.exp - Date.now()) / 1000)) : ttlSec);
  return n;
}
async function get(key) { return redis ? redis(["GET", key]) : memGet(key); }
async function set(key, v, ttlSec) { return redis ? redis(["SET", key, String(v), "EX", String(ttlSec)]) : memSet(key, v, ttlSec); }
async function setOnce(key, ttlSec) {
  if (redis) return (await redis(["SET", key, "1", "NX", "EX", String(ttlSec)])) === "OK";
  if (memGet(key)) return false; memSet(key, 1, ttlSec); return true;
}
async function del(...keys) { if (redis) await redis(["DEL", ...keys]); else keys.forEach((k) => mem.delete(k)); }

// Looks like a real customer question -> always let it through.
const INTENT = /\b(e-?sims?|plans?|price|presyo|magkano|how much|order|buy|bili|bibili|data|gb|unlimited|days?|araw|travel|trip|biyahe|flight|country|countries|qr|install|activate|activation|payment|pay|bayad|gcash|maya|paypal|card|receipt|refund|reseller|roaming|signal|hotspot|validity|iccid|apn)\b/i;
const TIME = /\b(week|weeks|month|months|linggo|buwan|next|tomorrow|bukas|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct)\b/i;
let places = [];
try { places = require("./data/destinations.json").map((d) => String(d).toLowerCase()).filter((d) => d.length >= 4); } catch (_) { places = []; }
places.push("usa", "uae", "korea", "europe", "hongkong", "hong kong", "dubai", "saudi", "taiwan", "japan", "china");
function looksGenuine(text) {
  const t = String(text || "").toLowerCase();
  return INTENT.test(t) || TIME.test(t) || places.some((p) => new RegExp("\\b" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(t));
}

// Call before asking the AI. Returns { allow: true } or { allow: false, notice: "text or null" }.
async function check(senderId, text, { exempt } = {}) {
  try {
    if (exempt) return { allow: true };
    const genuine = looksGenuine(text);

    // Flood limit
    const flood = await incr(`guard:flood:${senderId}`, FLOOD_WINDOW_MIN * 60);
    if (flood > FLOOD_MAX) {
      await set(`guard:cool:${senderId}`, 1, COOLDOWN_MIN * 60);
    }
    if (!genuine && (await get(`guard:cool:${senderId}`))) {
      const first = await setOnce(`guard:coolnote:${senderId}`, COOLDOWN_MIN * 60);
      return { allow: false, reason: "flood", notice: first ? "You're sending a lot of messages. 😊 Please give me a few minutes. If you need an eSIM, just tell me your destination and travel dates and I'll help right away." : null };
    }

    // Muted after strikes
    if (!genuine && (await get(`guard:mute:${senderId}`))) {
      const first = await setOnce(`guard:mutenote:${senderId}`, MUTE_HOURS * 3600);
      return { allow: false, reason: "muted", notice: first ? "I'm here to help with travel eSIMs only. 😊 Whenever you're ready, tell me where you're travelling and for how many days, and I'll find the best plan for you." : null };
    }
    return { allow: true };
  } catch (e) {
    console.error("[guard] check failed:", e.message);
    return { allow: true }; // never block a customer because of an error
  }
}

// Called by the flag_troll tool.
async function strike(senderId, reason) {
  try {
    const n = await incr(`guard:strike:${senderId}`, 24 * 3600);
    let muted = false;
    if (n >= STRIKES) {
      await set(`guard:mute:${senderId}`, 1, MUTE_HOURS * 3600);
      await del(`guard:strike:${senderId}`, `guard:mutenote:${senderId}`);
      muted = true;
    }
    console.log(`[guard] strike ${n}/${STRIKES} for ${senderId}${muted ? " -> muted " + MUTE_HOURS + "h" : ""}: ${String(reason || "").slice(0, 120)}`);
    return { strikes: muted ? STRIKES : n, of: STRIKES, muted };
  } catch (e) {
    console.error("[guard] strike failed:", e.message);
    return { strikes: 0, of: STRIKES, muted: false };
  }
}

async function unmute(senderId) { await del(`guard:mute:${senderId}`, `guard:strike:${senderId}`, `guard:cool:${senderId}`, `guard:flood:${senderId}`); }

module.exports = { init, check, strike, unmute, looksGenuine, STRIKES, MUTE_HOURS };
