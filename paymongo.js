// paymongo.js
//
// PayMongo (Philippines) for automatic payments:
//   - createCheckout(): a hosted checkout link (QR Ph now; GCash, Maya, cards once
//     the account is upgraded) for the exact order amount
//   - getCheckout()/paidInfo(): ask PayMongo directly whether a checkout was paid
//     (the source of truth; we never trust a webhook body on its own)
//   - ensureWebhook(): registers our /webhooks/paymongo URL once and returns its
//     signing secret
//   - verifySignature(): checks the Paymongo-Signature header
//
// Settings (Render > Environment):
//   PAYMONGO_SECRET_KEY  sk_test_... while testing, sk_live_... for real money
//   PAYMONGO_METHODS     comma list of checkout methods, default "qrph"
//                        (later e.g. "qrph,gcash,paymaya,card")

const crypto = require("crypto");

const API = "https://api.paymongo.com/v1";
const KEY = (process.env.PAYMONGO_SECRET_KEY || "").trim();

function configured() { return /^sk_(test|live)_/.test(KEY); }
function isTest() { return KEY.startsWith("sk_test_"); }
function methods() {
  const list = String(process.env.PAYMONGO_METHODS || "qrph").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ["qrph"];
}

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = Array.isArray(d.errors) ? d.errors.map((e) => e.detail || e.code).join("; ") : `HTTP ${r.status}`;
    throw new Error("PayMongo: " + msg);
  }
  return d;
}

// amountPHP like 568.75 -> PayMongo wants centavos (56875).
async function createCheckout({ amountPHP, name, description, reference, successUrl, cancelUrl, metadata, types }) {
  const amount = Math.round(Number(amountPHP) * 100);
  if (!(amount >= 2000)) throw new Error("PayMongo: amount too small (minimum ₱20).");
  const attributes = {
    line_items: [{ currency: "PHP", amount, name: String(name).slice(0, 255), quantity: 1 }],
    payment_method_types: types && types.length ? types : methods(),
    description: String(description || name).slice(0, 255),
    reference_number: reference,
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    metadata: metadata || {}
  };
  if (successUrl) attributes.success_url = successUrl;
  if (cancelUrl) attributes.cancel_url = cancelUrl;
  const d = await call("POST", "/checkout_sessions", { data: { attributes } });
  return { id: d.data.id, url: d.data.attributes.checkout_url, amount };
}

async function getCheckout(id) {
  const d = await call("GET", "/checkout_sessions/" + encodeURIComponent(id));
  return d.data;
}

// Was this checkout paid? Returns { paid, amount (centavos), paymentId, method }.
function paidInfo(session) {
  const a = (session && session.attributes) || {};
  const pays = Array.isArray(a.payments) ? a.payments : [];
  const p = pays.find((x) => x && x.attributes && x.attributes.status === "paid");
  if (p) return { paid: true, amount: p.attributes.amount, paymentId: p.id, method: (p.attributes.source && p.attributes.source.type) || null };
  const pi = a.payment_intent && a.payment_intent.attributes;
  if (pi && pi.status === "succeeded") return { paid: true, amount: pi.amount, paymentId: a.payment_intent.id, method: null };
  return { paid: false };
}

// Make sure PayMongo sends checkout events to our URL. Returns the webhook's
// signing secret when PayMongo provides it (null otherwise).
async function ensureWebhook(url) {
  const list = await call("GET", "/webhooks");
  const hooks = Array.isArray(list.data) ? list.data : [];
  let hook = hooks.find((h) => h.attributes && h.attributes.url === url);
  if (!hook) {
    const d = await call("POST", "/webhooks", { data: { attributes: { url, events: ["checkout_session.payment.paid"] } } });
    hook = d.data;
    console.log(`[paymongo] webhook created for ${url}`);
  } else if (hook.attributes.status && hook.attributes.status !== "enabled") {
    try { await call("POST", `/webhooks/${hook.id}/enable`); } catch (e) { console.error("[paymongo] could not enable webhook:", e.message); }
  }
  return (hook && hook.attributes && hook.attributes.secret_key) || null;
}

// Paymongo-Signature: t=<timestamp>,te=<test sig>,li=<live sig>
// sig = HMAC-SHA256(secret, `${t}.${rawBody}`) as hex.
function verifySignature(header, rawBody, secret) {
  if (!header || !rawBody || !secret) return false;
  const parts = Object.fromEntries(String(header).split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const sig = isTest() ? parts.te : parts.li;
  if (!parts.t || !sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody.toString("utf8")}`).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); } catch { return false; }
}

module.exports = { configured, isTest, methods, createCheckout, getCheckout, paidInfo, ensureWebhook, verifySignature };
