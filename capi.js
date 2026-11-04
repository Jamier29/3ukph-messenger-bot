// capi.js
//
// Tells Meta (Facebook) when a chat customer buys, so Ads Manager can show
// purchases and sales for the Messenger / WhatsApp ads ("Conversions API for
// business messaging"). Free to use.
//
// Render settings:
//   META_CAPI_TOKEN  = Conversions API access token of the dataset (keep private)
//   META_DATASET_ID  = the dataset linked to the Page (default 2620336965082142)
//   WA_WABA_ID       = WhatsApp Business Account ID (only needed for WhatsApp purchases)
//
// Only the order value, currency, a hashed email and the chat ID are sent.
// If the token is not set, nothing is sent.

const crypto = require("crypto");

const TOKEN = (process.env.META_CAPI_TOKEN || "").trim();
const DATASET = (process.env.META_DATASET_ID || "2620336965082142").trim();
const WABA = (process.env.WA_WABA_ID || "").trim();
const PAGE_ID = (process.env.PAGE_ID || "103294518884622").trim();

let redis = null; // async (cmd[]) => result
const memRef = new Map();
let last = { at: null, ok: null, message: TOKEN ? "No purchase sent yet." : "META_CAPI_TOKEN not set -- purchase tracking is off." };

function init(redisFn) { redis = redisFn; }
function configured() { return !!TOKEN; }
function status() { return { enabled: configured(), dataset: DATASET, last }; }
const sha = (s) => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

// Remember the ad click a chat came from (Click-to-WhatsApp ctwa_clid / Messenger ad referral), 30 days.
async function rememberReferral(psid, ref) {
  if (!psid || !ref) return;
  const rec = { ...ref, at: Date.now() };
  memRef.set(psid, rec);
  if (redis) await redis(["SET", `capi:ref:${psid}`, JSON.stringify(rec), "EX", 30 * 24 * 3600]).catch(() => {});
}
async function getReferral(psid) {
  if (redis) {
    try { const v = await redis(["GET", `capi:ref:${psid}`]); if (v) return JSON.parse(v); } catch (_) { /* ignore */ }
  }
  return memRef.get(psid) || null;
}

// psid: Messenger PSID or "wa<number>". valuePHP: amount paid. ref: our order reference (dedupe).
async function sendPurchase({ psid, valuePHP, email, ref, planName }) {
  if (!TOKEN || !psid || !(valuePHP > 0)) return { skipped: true };
  const isWa = /^wa\d+$/.test(String(psid));
  const referral = await getReferral(psid);
  const user_data = {};
  if (email) user_data.em = [sha(email)];
  let channel;
  if (isWa) {
    channel = "whatsapp";
    user_data.ph = [sha(String(psid).slice(2))];
    if (WABA) user_data.whatsapp_business_account_id = WABA;
    if (referral && referral.ctwa_clid) user_data.ctwa_clid = referral.ctwa_clid;
    if (!user_data.ctwa_clid || !WABA) { last = { at: new Date().toISOString(), ok: null, message: "WhatsApp purchase not from an ad click (or WA_WABA_ID missing); not sent." }; return { skipped: true }; }
  } else {
    channel = "messenger";
    user_data.page_id = PAGE_ID;
    user_data.page_scoped_user_id = String(psid);
  }
  const event = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: ref ? `purchase-${ref}` : undefined,
    action_source: "business_messaging",
    messaging_channel: channel,
    user_data,
    custom_data: { currency: "PHP", value: Math.round(valuePHP * 100) / 100, content_name: planName || undefined }
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(DATASET)}/events?access_token=${encodeURIComponent(TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [event] })
    });
    const d = await r.json().catch(() => ({}));
    last = { at: new Date().toISOString(), ok: r.ok, message: r.ok ? `Sent ${channel} purchase ₱${event.custom_data.value}` : ((d.error && d.error.message) || `HTTP ${r.status}`) };
    if (!r.ok) console.error("[capi] purchase not accepted:", last.message);
    else console.log("[capi]", last.message);
    return { ok: r.ok };
  } catch (e) {
    last = { at: new Date().toISOString(), ok: false, message: e.message };
    console.error("[capi] send failed:", e.message);
    return { ok: false };
  }
}

module.exports = { init, configured, status, rememberReferral, getReferral, sendPurchase };
