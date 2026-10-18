// server.js
//
// Messenger webhook bot for the 3UK Philippines Facebook page.
// Flow: Facebook sends an incoming message -> Claude answers using
// business-info.js for policies, and calls tools to look up real prices
// (in pesos), place an order (sends the payment QR code + alerts the
// admin), or hand the chat over to a human admin -> the reply is sent back
// via Facebook's Send API.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { BUSINESS_INFO } = require("./business-info");
const { findPlansByText, getRawPlan, searchPlans, getPlan, listAllDestinations, getRate, headlinePrices, regionSummaries, formatPHP } = require("./planSearch");
const QRCode = require("qrcode");
const { brandedQr } = require("./qrcard");
const { startPriceSync, syncPrices, getSyncStatus } = require("./priceSync");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const reseller = require("./reseller");
const esims = require("./esimcard");

const app = express();
// Admin image uploads (QR codes) are bigger than normal requests.
app.use("/admin/api/send-image", express.json({ limit: "12mb" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
// Where the admin gets alerts (with sound) on their phone -- see README, "Admin alerts".
const ADMIN_NTFY_TOPIC = process.env.ADMIN_NTFY_TOPIC || "";
// How long the bot stays quiet in a chat after it's handed to a human, or after an admin replies.
const BOT_PAUSE_HOURS = Number(process.env.BOT_PAUSE_HOURS || 12);
// Public address of this server, used to send the payment QR images. Render sets RENDER_EXTERNAL_URL automatically.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const MAX_TOOL_ROUNDS = 5;

// WhatsApp Cloud API (optional). WA_TOKEN = permanent System User token, WA_PHONE_NUMBER_ID from
// WhatsApp > API Setup. WhatsApp customers are stored as "wa<number>", e.g. wa639171234567.
const WA_TOKEN = (process.env.WA_TOKEN || "").trim();
const WA_PHONE_NUMBER_ID = (process.env.WA_PHONE_NUMBER_ID || "").trim();
const WA_VERIFY_TOKEN = (process.env.WA_VERIFY_TOKEN || process.env.VERIFY_TOKEN || "").trim();
const isWa = (id) => /^wa\d+$/.test(String(id || ""));

if (!VERIFY_TOKEN || !PAGE_ACCESS_TOKEN || !ANTHROPIC_API_KEY) {
  console.warn(
    "[startup] Missing one or more required environment variables: VERIFY_TOKEN, PAGE_ACCESS_TOKEN, ANTHROPIC_API_KEY. " +
    "The server will start, but the bot will not work until these are set."
  );
}
if (!ADMIN_NTFY_TOPIC) {
  console.warn("[startup] ADMIN_NTFY_TOPIC not set -- admin phone alerts are OFF (alerts will only appear in the Render logs).");
}

console.log(`[startup] Loaded pricing catalog covering ${listAllDestinations().length} destinations. Rate: 1 USD = ${getRate()} PHP.`);

// ---------------------------------------------------------------------
// Payment QR codes. Put the image files in public/qr/ named after the
// payment method (e.g. public/qr/gcash.png). They're served publicly at
// <PUBLIC_URL>/qr/<file> so Messenger can send them as images.
// ---------------------------------------------------------------------
app.use("/qr", express.static(path.join(__dirname, "public", "qr")));

// Privacy policy page (required by Meta for app review): <PUBLIC_URL>/privacy
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
// One link for bios (TikTok, Instagram): choose WhatsApp or Messenger.
app.get("/chat", (req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));

const PAYMENT_METHODS = {
  gcash: "GCash",
  maya: "Maya",
  maribank: "MariBank",
  unionbank: "UnionBank",
  bpi: "BPI",
  paypal: "PayPal",
  wallet: "Reseller wallet"
};

// PayPal (for customers abroad): they pay in USD via this payment link, where
// they type in the amount we quote. Override with PAYPAL_LINK in Render.
// PAYPAL_EXTRA_PERCENT (default 5) adds a % on top of the USD price to cover
// PayPal's fees, e.g. 5 -> a $16.74 plan is quoted as $17.58.
const PAYPAL_LINK = (process.env.PAYPAL_LINK || "https://www.paypal.com/ncp/payment/GWWNPBXR353YJ").trim();
const PAYPAL_EXTRA_PERCENT = (() => {
  const v = String(process.env.PAYPAL_EXTRA_PERCENT ?? "").trim();
  const n = v === "" ? 5 : Number(v); // default 5% covers PayPal's fee (about 4.6% on international payments)
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : 5;
})();

// USD amount for a PayPal order: the peso price (after any discount) converted
// back at our fixed rate, plus the optional PayPal fee %, rounded UP to the cent.
function paypalUsdAmount(pricePHP) {
  const usd = (pricePHP / getRate()) * (1 + PAYPAL_EXTRA_PERCENT / 100);
  return Math.ceil(Math.round(usd * 10000) / 100) / 100;
}

function findQrFile(methodKey) {
  const dir = path.join(__dirname, "public", "qr");
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const file = `${methodKey}.${ext}`;
    if (fs.existsSync(path.join(dir, file))) return file;
  }
  return null;
}

// Which QR to send when a method has no QR of its own (e-wallet -> e-wallet QR, bank -> bank QR first).
const INSTAPAY_FALLBACK = {
  maya: ["gcash", "maribank", "unionbank"],
  gcash: ["maribank", "unionbank"],
  bpi: ["unionbank", "maribank", "gcash"],
  unionbank: ["maribank", "gcash"],
  maribank: ["unionbank", "gcash"]
};

// "₱1,037.88" / "PHP 1037.88" / 1037.88 -> 1037.88 (null if no number)
function priceNumber(v) {
  const m = String(v ?? "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0]) * 100) / 100 : null;
}

function normalizePaymentMethod(input) {
  const s = String(input || "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("gcash")) return "gcash";
  if (s.includes("maya") || s.includes("paymaya")) return "maya";
  if (s.includes("mari") || s.includes("seabank")) return "maribank";
  if (s.includes("union")) return "unionbank";
  if (s.includes("bpi") || s.includes("philippineislands")) return "bpi";
  if (s.includes("wallet")) return "wallet";
  if (s.includes("paypal") || s.includes("card") || s.includes("visa") || s.includes("mastercard")) return "paypal";
  return null;
}

// ---------------------------------------------------------------------
// Tools the AI can call.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Discount codes. Default: SALAMAT10 = 10% off (thank-you code for past
// customers) and WELCOME10 = 10% off a new customer's first order (shown on
// 3ukph.com). To change them without editing code, set DISCOUNT_CODES in
// Render, e.g.  SALAMAT10:10,BAYANIHAN5:5   (set it to "none" to turn all off).
// ---------------------------------------------------------------------
const DISCOUNT_CODES = (() => {
  const raw = (process.env.DISCOUNT_CODES || "SALAMAT10:10,WELCOME10:10").trim();
  const codes = {};
  if (raw.toLowerCase() === "none") return codes;
  for (const part of raw.split(",")) {
    const [code, pct] = part.split(":").map((x) => (x || "").trim());
    const n = Number(pct);
    if (code && n > 0 && n < 100) codes[code.toUpperCase()] = n;
  }
  return codes;
})();

// Returns the plan with the discount applied (price = discounted price), or
// the plan unchanged plus a discountError if the code isn't valid.
function applyDiscount(plan, code) {
  if (!plan || !code) return plan;
  const key = String(code).trim().toUpperCase().replace(/\s+/g, "");
  const pct = DISCOUNT_CODES[key];
  if (!pct) return { ...plan, discountError: `"${code}" is not a valid discount code. Quote the regular price.` };
  const discounted = Math.round(plan.pricePHP * (100 - pct)) / 100;
  return {
    ...plan,
    regularPrice: plan.price,
    discountCode: key,
    discountPercent: pct,
    discountAmount: formatPHP(Math.round((plan.pricePHP - discounted) * 100) / 100),
    price: formatPHP(discounted),
    pricePHP: discounted
  };
}

// ---------------------------------------------------------------------
// One discount per customer, ever (any code). Used discounts are saved in a
// free Upstash Redis database so they survive restarts and redeploys.
// Render settings: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
// Without them, used discounts are only remembered until the next restart.
// To let a customer use a discount again, delete their "discount:used:..."
// key in Upstash (Data Browser).
// ---------------------------------------------------------------------
// Tidy up values pasted into Render: spaces, quotes, a leading "NAME=", and a
// redis:// / rediss:// address (turned into the matching https:// REST address).
function cleanEnv(v, name) {
  let x = String(v || "").trim();
  if (name && x.toUpperCase().startsWith(name + "=")) x = x.slice(name.length + 1).trim();
  x = x.replace(/^["']+|["']+$/g, "").trim();
  return x;
}
let UPSTASH_URL = cleanEnv(process.env.UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
const UPSTASH_TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
if (/^rediss?:\/\//i.test(UPSTASH_URL)) {
  try { UPSTASH_URL = "https://" + new URL(UPSTASH_URL).hostname; } catch { /* leave as is */ }
}
if (UPSTASH_URL && !/^https?:\/\//i.test(UPSTASH_URL)) UPSTASH_URL = "https://" + UPSTASH_URL;
UPSTASH_URL = UPSTASH_URL.replace(/\/+$/, "");
const usedDiscountsMemory = new Map(); // fallback only
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn("[startup] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set -- used discount codes are only remembered until the server restarts.");
}

// Never let the token show up in error messages or logs.
function redact(text) {
  let t = String(text || "");
  if (UPSTASH_TOKEN) t = t.split(UPSTASH_TOKEN).join("***");
  return t.replace(/Bearer\s+\S+/g, "Bearer ***");
}

async function redis(command) {
  try {
    const res = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Upstash HTTP ${res.status}`);
    return data.result;
  } catch (err) {
    throw new Error(redact(err.message).slice(0, 200));
  }
}

// Startup self-test, so the Render logs show whether the discount database works.
async function checkDiscountDb() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, message: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set" };
  try {
    const pong = await redis(["PING"]);
    const keys = await redis(["KEYS", "discount:used:*"]);
    return { ok: pong === "PONG", message: `connected to ${new URL(UPSTASH_URL).hostname} (${(keys || []).length} customers have used a discount)` };
  } catch (err) {
    return { ok: false, message: `can't reach Upstash at "${redact(UPSTASH_URL)}": ${err.message}` };
  }
}
// Reseller program data (private costs + approved resellers) also lives in Upstash.
reseller.init(UPSTASH_URL && UPSTASH_TOKEN ? redis : null);
esims.init(UPSTASH_URL && UPSTASH_TOKEN ? redis : null);

if (UPSTASH_URL && UPSTASH_TOKEN) {
  checkDiscountDb().then((r) => console.log(`[discount] Discount database: ${r.ok ? "✅" : "❌"} ${r.message}`));
}

// Returns { code, at } if this customer already used a discount, else null.
// Throws if the database can't be reached.
async function getUsedDiscount(senderId) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return usedDiscountsMemory.get(senderId) || null;
  const v = await redis(["GET", `discount:used:${senderId}`]);
  try { return v ? JSON.parse(v) : null; } catch { return { code: String(v) }; }
}

// Atomically records the discount. Returns true if recorded, false if the
// customer had already used one. Throws if the database can't be reached.
async function claimDiscount(senderId, record) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    if (usedDiscountsMemory.has(senderId)) return false;
    usedDiscountsMemory.set(senderId, record);
    return true;
  }
  const r = await redis(["SET", `discount:used:${senderId}`, JSON.stringify(record), "NX"]);
  return r === "OK";
}

function alreadyUsedMessage(used) {
  const when = used && used.at ? ` on ${new Date(used.at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric" })}` : "";
  return `This customer already used a discount${used && used.code ? ` (${used.code})` : ""}${when}. ` +
    "Only one discount per customer, and codes can't be combined. Kindly explain this and quote the regular price.";
}

// ---------------------------------------------------------------------
// Reseller helpers: approved resellers see (and pay) their reseller price.
// ---------------------------------------------------------------------
async function getResellerSafe(senderId) {
  try { return await reseller.getMember(senderId); } catch (err) { console.error("[reseller] lookup failed:", err.message); return null; }
}
function addResellerPrice(plan, member) {
  if (!plan || !member) return plan;
  const r = reseller.resellerPrice(getRawPlan(plan.planId), member.tier, getRate());
  if (!r) return { ...plan, resellerPrice: "not available for this plan -- hand off to the admin if they want it" };
  // For an approved reseller, "price" IS their reseller price, so it is what gets quoted by default.
  return {
    ...plan,
    price: formatPHP(r.pricePHP), pricePHP: r.pricePHP,
    priceType: `${member.tier === "gold" ? "Gold" : "Starter"} reseller price (what this reseller pays)`,
    retailPrice: plan.price,
    resellerProfitIfSoldAtRetail: formatPHP(r.profitAtRetailPHP)
  };
}

const TOOLS = [
  {
    name: "search_esim_plans",
    description:
      "Look up real, current eSIM plans and peso prices for a destination (a country, a region like 'Europe', " +
      "or 'global'). Always use this instead of guessing a price. Use the optional filters to narrow big " +
      "destinations (Japan, Europe, etc. have 70+ plans).",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Country, region, or 'global', e.g. 'Japan', 'UK', 'Europe'." },
        minDataGB: { type: "number", description: "Only plans with at least this many GB." },
        minDays: { type: "number", description: "Only plans valid for at least this many days." },
        maxDays: { type: "number", description: "Only plans valid for at most this many days." },
        needsCallsAndTexts: { type: "boolean", description: "true = only plans that include calls & texts." }
      },
      required: ["destination"]
    }
  },
  {
    name: "get_plan",
    description:
      "Get the exact details and peso price of ONE plan by its planId. Use this whenever the customer picks " +
      "a plan, before confirming the plan and price back to them.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "The planId from a search result, e.g. 'P6413'." },
        discountCode: { type: "string", description: "Only if the customer gave a discount code (e.g. 'SALAMAT10'). The result's price is then the discounted price." }
      },
      required: ["planId"]
    }
  },
  {
    name: "create_order",
    description:
      "Place the order once you know: the exact plan (planId), the payment method, and the customer's email. " +
      "This sends the customer the payment QR code for their chosen method (or the PayPal link and USD amount " +
      "for PayPal) and alerts the admin.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "The planId of the EXACT plan the customer confirmed (the one whose price you quoted)." },
        confirmedPrice: { type: "string", description: "The exact peso price you last quoted the customer for this plan, from get_plan (e.g. '₱1,037.88', the discounted price if a code was accepted, or the resellerPrice for an approved reseller)." },
        paymentMethod: { type: "string", enum: ["GCash", "Maya", "MariBank", "UnionBank", "BPI", "PayPal", "Wallet"], description: "\"Wallet\" is only for approved Gold resellers paying from their prepaid reseller wallet." },
        email: { type: "string", description: "Email address where the eSIM QR code should be sent." },
        deliverVia: { type: "string", enum: ["Messenger", "Email", "Both"], description: "How the customer wants the eSIM QR code." },
        discountCode: { type: "string", description: "The discount code the customer gave, if any (only one that get_plan accepted)." },
        notes: { type: "string", description: "Anything else useful, e.g. 'eSIM is for a friend', travel dates, phone model." }
      },
      required: ["planId", "confirmedPrice", "paymentMethod", "email"]
    }
  },
  {
    name: "check_data_usage",
    description:
      "Check how much data a customer has used / has left on their 3UK eSIM (live from our system). Use when they ask about " +
      "data usage, remaining data, balance of their eSIM, or validity. Without an iccid it checks the eSIMs saved for this " +
      "customer. If they give their ICCID (starts with 89, 18-22 digits), pass it.",
    input_schema: { type: "object", properties: { iccid: { type: "string", description: "Optional ICCID the customer provided." } } }
  },
  {
    name: "check_wallet",
    description: "For approved resellers only: their current wallet balance and recent purchases. Use when a reseller asks about their balance, wallet, or past orders.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "apply_reseller",
    description:
      "Send a reseller application to the admin for approval (the admin gets a phone alert). Use when someone " +
      "wants to become a 3UK Philippines reseller, after you've explained the program and collected their details. " +
      "Never quote reseller prices to someone who is not yet approved.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Applicant's full name." },
        contact: { type: "string", description: "Mobile number and/or email." },
        sellsTo: { type: "string", description: "Who they plan to sell to, e.g. 'crewmates on my ship', 'travel agency clients'." },
        tier: { type: "string", enum: ["Starter", "Gold"], description: "Starter (free) or Gold (₱5,000+ wallet)." },
        notes: { type: "string", description: "Anything else useful." }
      },
      required: ["name", "contact"]
    }
  },
  {
    name: "handoff_to_human",
    description:
      "Alert the page admin to take over this chat (the admin gets a phone notification). Use when the " +
      "customer asks for a person/admin, for payment problems, refunds, complaints, bulk/manning-agency " +
      "orders, or anything you're unsure about. The bot then stays quiet in this chat for a while.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason, e.g. 'Customer asked for an admin', 'Refund request'." },
        summary: { type: "string", description: "1-3 sentence summary of the conversation so far for the admin." }
      },
      required: ["reason"]
    }
  }
];

async function runTool(name, input, senderId) {
  switch (name) {
    case "search_esim_plans": {
      const result = searchPlans(input || {});
      const member = await getResellerSafe(senderId);
      if (member && Array.isArray(result.plans)) result.plans = result.plans.map((p) => addResellerPrice(p, member));
      return result;
    }

    case "get_plan": {
      const plan = getPlan(input.planId);
      if (!plan) return { error: "No plan with that planId. Search again." };
      const member = await getResellerSafe(senderId);
      if (member) {
        const rp = addResellerPrice(plan, member);
        return input.discountCode ? { ...rp, discountError: "Discount codes are for retail customers and don't apply to reseller prices." } : rp;
      }
      if (input.discountCode) {
        try {
          const used = await getUsedDiscount(senderId);
          if (used) return { ...plan, discountError: alreadyUsedMessage(used) };
        } catch (err) {
          console.error("[discount] could not check used discounts:", err.message);
        }
      }
      return applyDiscount(plan, input.discountCode);
    }

    case "create_order": {
      const basePlan = getPlan(input.planId);
      if (!basePlan) return { error: "No plan with that planId. Search again and confirm the plan with the customer." };
      const methodKey = normalizePaymentMethod(input.paymentMethod);
      if (!methodKey) return { error: "Unknown payment method. Accepted: GCash, Maya, MariBank, UnionBank, BPI, PayPal." };
      const email = String(input.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email looks invalid. Ask the customer to re-type it." };

      // Approved resellers pay their reseller price (no discount codes on top).
      const member = await getResellerSafe(senderId);
      let resellerPlan = null;
      if (member) {
        const r = reseller.resellerPrice(getRawPlan(basePlan.planId), member.tier, getRate());
        if (r) resellerPlan = { ...basePlan, regularPrice: basePlan.price, price: formatPHP(r.pricePHP), pricePHP: r.pricePHP };
      }
      if (methodKey === "wallet" && !(member && member.tier === "gold" && resellerPlan)) {
        return { error: "Wallet payment is only for approved Gold resellers. Ask for another payment method." };
      }
      const resellerTag = resellerPlan ? `RESELLER (${member.tier === "gold" ? "Gold" : "Starter"}) ` : "";

      // Safety check: the plan being ordered must cost what the customer was quoted.
      // Catches a wrong planId (several plans share a name). Done before any side effects.
      const quoted = priceNumber(input.confirmedPrice);
      const expected = resellerPlan || applyDiscount(basePlan, input.discountCode);
      const candidates = (resellerPlan ? [resellerPlan.pricePHP] : [expected.pricePHP, basePlan.pricePHP]).map((n) => Math.round(n * 100) / 100);
      if (quoted === null || !candidates.includes(quoted)) {
        console.warn(`[order] price mismatch: planId ${input.planId} costs ${expected.price}, bot quoted ${input.confirmedPrice}`);
        return {
          error:
            `Price check failed: planId ${input.planId} costs ${expected.price}, but confirmedPrice was "${input.confirmedPrice || ""}". ` +
            "You probably used the wrong planId. Do NOT place the order yet. Find the planId of the plan the customer actually " +
            "agreed to (call get_plan to check its price), then call create_order again with that planId and its exact price. " +
            "Do not tell the customer about this check unless the price they will pay changes."
        };
      }

      // Discount: only one per customer, ever. Record it now (atomically) so it can't be used twice.
      let plan = resellerPlan || applyDiscount(basePlan, input.discountCode);
      let discountNote = resellerPlan ? `Reseller price (retail ${basePlan.price}).\n` : "";
      if (resellerPlan) {
        // no discount codes for resellers
      } else if (plan.discountCode) {
        try {
          const ok = await claimDiscount(senderId, { code: plan.discountCode, planId: plan.planId, price: plan.price, at: Date.now() });
          if (!ok) {
            const used = await getUsedDiscount(senderId).catch(() => null);
            discountNote = `Note: customer tried ${plan.discountCode} but already used a discount${used && used.code ? ` (${used.code})` : ""}; regular price charged.\n`;
            plan = { ...basePlan, discountError: alreadyUsedMessage(used) };
          }
        } catch (err) {
          console.error("[discount] could not record discount:", err.message);
          discountNote = "⚠️ Couldn't check the discount database -- please make sure this customer hasn't used a discount before.\n";
        }
      } else if (plan.discountError) {
        discountNote = `Note: customer tried an invalid code (${input.discountCode}); regular price charged.\n`;
      }

      const methodName = PAYMENT_METHODS[methodKey];

      // Gold reseller paying from their prepaid wallet: no QR, the admin deducts it.
      if (methodKey === "wallet") {
        const planLabel = `${plan.name} (${plan.destination}, ${plan.data}, ${plan.validityDays} days${plan.callsAndTexts ? ", with calls & texts" : ""})`;
        let w;
        try {
          w = await reseller.walletOrder(senderId, { pricePHP: plan.pricePHP, plan: planLabel, retailPHP: basePlan.pricePHP, email });
        } catch (err) {
          console.error("[wallet] order failed:", err.message);
          return { error: "The wallet system couldn't be reached. Ask the reseller to pay another way this time, or hand off to the admin." };
        }
        if (!w.ok) {
          return {
            error: `Not enough wallet balance: they have ${formatPHP(w.balance)} but this plan is ${plan.price}. Nothing was deducted. ` +
              "Tell them their balance, and offer to pay this order with GCash/Maya/bank instead, or to top up their wallet (an admin confirms top-ups)."
          };
        }
        const customer = await getCustomerName(senderId);
        await notifyAdmin({
          title: `${resellerTag}order: ${plan.price} paid from WALLET`,
          message:
            `Reseller: ${customer}${member.name ? ` (${member.name})` : ""}\n` +
            `Plan: ${planLabel}\n` +
            `Deducted ${plan.price} from their wallet (retail ${basePlan.price}). New balance: ${formatPHP(w.balance)}\n` +
            `Email: ${email}\nDeliver via: ${input.deliverVia || "not specified"}\n` +
            (input.notes ? `Notes: ${input.notes}\n` : "") +
            "👉 Already paid -- send the eSIM. If you can't fulfil it, refund it in the Admin Console.",
          tags: "moneybag"
        });
        return {
          ok: true, plan: plan.name, price: plan.price, paymentMethod: "Reseller wallet", walletBalanceNow: formatPHP(w.balance),
          instructionsForYou: `Tell the reseller the order is placed and ${plan.price} was deducted from their wallet; their remaining balance is ${formatPHP(w.balance)}. Their eSIM QR code arrives within about 5 minutes.`
        };
      }

      // Reseller paying by GCash/bank/PayPal: log the purchase in their history (balance unchanged).
      if (resellerPlan) {
        reseller.logOrder(senderId, {
          pricePHP: plan.pricePHP, retailPHP: basePlan.pricePHP, method: methodName, email,
          plan: `${plan.name} (${plan.destination}, ${plan.data}, ${plan.validityDays} days${plan.callsAndTexts ? ", with calls & texts" : ""})`
        }).catch((err) => console.error("[wallet] could not log order:", err.message));
      }

      // PayPal (customers abroad): quote a USD amount and give the PayPal link.
      if (methodKey === "paypal") {
        const usd = paypalUsdAmount(plan.pricePHP);
        const usdText = `USD ${usd.toFixed(2)}`;
        const ppQr = findQrFile("paypal");
        let ppQrSent = false;
        if (ppQr && PUBLIC_URL) ppQrSent = await sendImage(senderId, `${PUBLIC_URL}/qr/${ppQr}`);

        const customer = await getCustomerName(senderId);
        await notifyAdmin({
          title: `New ${resellerTag}order: ${usdText} via PayPal`,
          message:
            `Customer: ${customer}\n` +
            `Plan: ${plan.name} (${plan.destination}, ${plan.data}, ${plan.validityDays} days${plan.callsAndTexts ? ", with calls & texts" : ""})\n` +
            `Amount to receive on PayPal: ${usdText} (peso price ${plan.price}${PAYPAL_EXTRA_PERCENT ? ` + ${PAYPAL_EXTRA_PERCENT}% PayPal fee` : ""})\n` +
            (plan.discountCode ? `Discount: ${plan.discountCode} (${plan.discountPercent}% off ${plan.regularPrice})\n` : "") +
            discountNote +
            `Email: ${email}\n` +
            `Deliver via: ${input.deliverVia || "not specified"}\n` +
            (input.notes ? `Notes: ${input.notes}\n` : "") +
            `👉 Check in PayPal that exactly ${usdText} arrived before sending the eSIM.`,
          tags: "moneybag"
        });

        return {
          ok: true,
          plan: plan.name,
          price: usdText,
          ...(plan.discountCode ? { discountApplied: `${plan.discountCode} (${plan.discountPercent}% off)` } : {}),
          ...(plan.discountError ? { discountNotApplied: plan.discountError } : {}),
          paymentMethod: "PayPal",
          paypalLink: PAYPAL_LINK,
          instructionsForYou:
            `Give the customer this PayPal link: ${PAYPAL_LINK} ` +
            (PAYPAL_EXTRA_PERCENT ? `Mention briefly that the USD amount includes a ${PAYPAL_EXTRA_PERCENT}% PayPal processing fee. ` : "") +
            (ppQrSent ? "(a PayPal QR code image was also just sent to them) " : "") +
            `Tell them to enter exactly ${usdText} as the amount, pay with their PayPal account or a credit/debit card, ` +
            `then send a screenshot of the PayPal receipt here. Their eSIM QR code arrives after the payment is confirmed. ` +
            `Quote ONLY ${usdText} for this order (not the peso price).`
        };
      }

      // All our QR codes are InstaPay QRs, which any Philippine bank or e-wallet app can scan.
      // If there's no QR for the chosen method (e.g. Maya, BPI), send an InstaPay QR they can scan from that app.
      let qrFile = findQrFile(methodKey);
      let viaInstaPay = false;
      if (!qrFile) {
        for (const alt of INSTAPAY_FALLBACK[methodKey] || []) {
          qrFile = findQrFile(alt);
          if (qrFile) { viaInstaPay = true; break; }
        }
      }
      let qrSent = false;
      if (qrFile && PUBLIC_URL) {
        qrSent = await sendImage(senderId, `${PUBLIC_URL}/qr/${qrFile}`);
      }

      const customer = await getCustomerName(senderId);
      await notifyAdmin({
        title: `New ${resellerTag}order: ${plan.price} via ${methodName}`,
        message:
          `Customer: ${customer}\n` +
          `Plan: ${plan.name} (${plan.destination}, ${plan.data}, ${plan.validityDays} days${plan.callsAndTexts ? ", with calls & texts" : ""})\n` +
          (plan.discountCode
            ? `Price: ${plan.price} (code ${plan.discountCode}: ${plan.discountPercent}% off ${plan.regularPrice}, saves ${plan.discountAmount})\n` +
              (plan.discountCode === "WELCOME10"
                ? `👉 WELCOME10 is for NEW customers -- check they haven't bought from you before (e.g. on your personal Facebook).\n`
                : `👉 ${plan.discountCode} is for returning customers you sent it to -- check this is one of them.\n`)
            : `Price: ${plan.price}\n`) +
          discountNote +
          `Payment: ${methodName}\n` +
          `Email: ${email}\n` +
          `Deliver via: ${input.deliverVia || "not specified"}\n` +
          (input.notes ? `Notes: ${input.notes}\n` : "") +
          (qrSent ? "" : `\n⚠️ The ${methodName} payment QR was NOT sent automatically -- please send it manually.`),
        tags: "moneybag"
      });

      return {
        ok: true,
        plan: plan.name,
        price: plan.price,
        ...(plan.discountCode ? { regularPrice: plan.regularPrice, discountApplied: `${plan.discountCode} (${plan.discountPercent}% off)` } : {}),
        ...(plan.discountError ? { discountNotApplied: plan.discountError } : {}),
        paymentMethod: methodName,
        paymentQrSentToCustomer: qrSent,
        instructionsForYou: qrSent
          ? (viaInstaPay
              ? `An InstaPay payment QR image was just sent to the customer. Tell them to open their ${methodName} app, choose InstaPay / Scan QR, scan that QR, and pay exactly ${plan.price} (small InstaPay transfer fees may apply), then send a screenshot of the payment here. Their eSIM QR code arrives within 5 minutes after the payment is confirmed.`
              : `The ${methodName} payment QR image was just sent to the customer. Tell them to pay exactly ${plan.price} using it and send a screenshot of the payment here. Their eSIM QR code arrives within 5 minutes after the payment is confirmed.`)
          : `The payment QR could not be sent automatically. Tell the customer the order is noted and an admin will send the ${methodName} payment QR here shortly. Amount to pay: ${plan.price}.`
      };
    }

    case "check_data_usage": {
      let list = [];
      try { list = await esims.listEsims(senderId); } catch (e) { console.error("[esims] list failed:", e.message); }
      let targets = list.map((e) => e.iccid);
      if (input.iccid) {
        const ic = esims.cleanIccid(input.iccid);
        if (!esims.isIccid(ic)) return { error: "That doesn't look like a valid ICCID. It starts with 89 and has about 19-20 digits. Ask them to check it." };
        targets = [ic];
      }
      if (!targets.length) {
        return { noEsimsOnFile: true, instructionsForYou: "We don't have an eSIM saved for this chat yet. Ask for the ICCID (reference number starting with 89 that we sent with their eSIM). If they don't have it, hand off to the admin." };
      }
      if (!esims.configured()) {
        await notifyAdmin({ title: "Data usage request", message: `Customer: ${await getCustomerName(senderId)}\nICCID: ${targets.join(", ")}\nPlease check usage in eSIMCard and reply.`, tags: "bar_chart" });
        return { instructionsForYou: "Tell them an admin will check their data usage and reply here shortly." };
      }
      const results = [];
      for (const ic of targets.slice(0, 3)) {
        try {
          const u = await esims.usage(ic);
          const rec = list.find((e) => e.iccid === ic);
          results.push({ iccidEnding: ic.slice(-4), plan: (rec && rec.plan) || u.bundle || undefined, total: u.total, used: u.used, remaining: u.remaining, percentUsed: u.percentUsed, unlimited: u.unlimited, status: u.statusText || u.status, expires: u.expires, purchased: u.purchasedAt ? u.purchasedAt.slice(0, 10) : undefined, validity: (u.bundle && (u.bundle.match(/\d+\s*days?/i) || [])[0]) || undefined, note: u.expires ? undefined : "Plan days count from the eSIM's first connection; there's no fixed end date to quote." });
        } catch (e) {
          console.error("[esims] usage failed:", e.message);
          results.push({ iccidEnding: ic.slice(-4), error: "Couldn't read usage right now." });
        }
      }
      if (results.every((r) => r.error)) {
        await notifyAdmin({ title: "Data usage check failed", message: `Customer: ${await getCustomerName(senderId)}\nICCID: ${targets.join(", ")}\nThe automatic check failed; please check in eSIMCard and reply.`, tags: "warning" });
        return { instructionsForYou: "Tell them you couldn't load the usage right now and an admin will check and reply here shortly." };
      }
      return { results, instructionsForYou: "Tell them the usage clearly (used / total / remaining, and expiry if known). Refer to each eSIM by the last 4 digits of its ICCID. If data is low, offer a top-up or a new plan." };
    }

    case "check_wallet": {
      const member = await getResellerSafe(senderId);
      if (!member) return { error: "This person is not an approved reseller, so they have no wallet." };
      const [balance, ledger] = await Promise.all([reseller.getBalance(senderId), reseller.getLedger(senderId, 50)]);
      const recent = ledger.slice(0, 5).map((e) => ({
        date: new Date(e.at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }),
        type: e.type, amount: formatPHP(Math.abs(e.method === "Wallet" || e.type !== "order" ? e.amount : e.price || 0)),
        ...(e.plan ? { plan: e.plan } : {}), ...(e.method ? { paidWith: e.method } : {}), ...(e.note ? { note: e.note } : {})
      }));
      return { tier: member.tier, walletBalance: formatPHP(balance), summary: reseller.summarize(ledger), recent,
        instructionsForYou: "Tell them their balance and, if they asked, their recent purchases. To top up the wallet they pay by GCash/bank and send the screenshot; an admin adds it." };
    }

    case "apply_reseller": {
      const existing = await getResellerSafe(senderId);
      if (existing) return { ok: true, alreadyApproved: existing.tier, instructionsForYou: "This person is already an approved reseller. Help them with their order." };
      await reseller.saveApplicant(senderId, input).catch((err) => console.error("[reseller] could not save applicant:", err.message));
      const customer = await getCustomerName(senderId);
      await notifyAdmin({
        title: `New reseller application (${input.tier || "Starter"})`,
        message:
          `Facebook name: ${customer}\nName: ${input.name}\nContact: ${input.contact}\n` +
          (input.sellsTo ? `Sells to: ${input.sellsTo}\n` : "") +
          (input.notes ? `Notes: ${input.notes}\n` : "") +
          `\n👉 To approve: open ${PUBLIC_URL || "https://3ukph.com"}/admin/console, open this chat, and set Reseller to Starter or Gold.`,
        tags: "handshake"
      });
      appendNote(senderId, `[Reseller application sent to the admin: ${input.name}, ${input.tier || "Starter"}.]`);
      return { ok: true, instructionsForYou: "Tell them their reseller application was sent and the admin will message them once approved (usually within a day). Until then, don't quote reseller prices. You can still help with retail orders." };
    }

    case "handoff_to_human": {
      const customer = await getCustomerName(senderId);
      pauseBot(senderId);
      await notifyAdmin({
        title: `Customer needs an admin: ${input.reason || "help requested"}`,
        message: `Customer: ${customer}\n${input.summary || ""}\n\nThe bot will stay quiet in this chat for ${BOT_PAUSE_HOURS} hours. Reply from the page inbox.`,
        tags: "rotating_light"
      });
      return { ok: true, instructionsForYou: "Tell the customer an admin has been notified and will reply here soon. Keep it short." };
    }

    default:
      return { error: "Unknown tool: " + name };
  }
}

// ---------------------------------------------------------------------
// Short-term conversation memory per Messenger user (resets when the
// server restarts). Tool calls are kept too, so the bot remembers exactly
// which plan (planId) the customer was looking at.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Returning visitors. Saved in Upstash so it survives restarts:
//   customer:<id>  = { orders, lastOrderAt, lastPlan }  (updated on every order)
//   seen:<id>      = last time they messaged us
// A "new visit" is the first message after RETURNING_GAP_HOURS of silence; returning
// customers and resellers then get a warm welcome-back greeting.
// ---------------------------------------------------------------------
const RETURNING_GAP_HOURS = Number(process.env.RETURNING_GAP_HOURS || 3);
const seenMemory = new Map();
const customersMemory = new Map();
const hasDb = () => !!(UPSTASH_URL && UPSTASH_TOKEN);

async function getAndSetLastSeen(senderId) {
  const now = Date.now();
  try {
    if (!hasDb()) { const prev = seenMemory.get(senderId) || null; seenMemory.set(senderId, now); return prev; }
    const prev = await redis(["GETSET", `seen:${senderId}`, String(now)]);
    return prev ? Number(prev) : null;
  } catch (err) { console.error("[visits] seen failed:", err.message); return null; }
}
async function getCustomerRecord(senderId) {
  try {
    if (!hasDb()) return customersMemory.get(senderId) || null;
    const v = await redis(["GET", `customer:${senderId}`]);
    return v ? JSON.parse(v) : null;
  } catch (err) { console.error("[visits] customer lookup failed:", err.message); return null; }
}
async function recordCustomerOrder(senderId, plan) {
  try {
    const prev = (await getCustomerRecord(senderId)) || { orders: 0 };
    const rec = { orders: (prev.orders || 0) + 1, firstOrderAt: prev.firstOrderAt || new Date().toISOString(), lastOrderAt: new Date().toISOString(), lastPlan: String(plan || "").slice(0, 120) };
    if (!hasDb()) customersMemory.set(senderId, rec);
    else await redis(["SET", `customer:${senderId}`, JSON.stringify(rec)]);
  } catch (err) { console.error("[visits] could not record order:", err.message); }
}
function realFirstName(name) {
  if (!name || /^(Messenger user|WhatsApp \+)/i.test(name)) return "";
  return String(name).trim().split(/\s+/)[0];
}
function shortDate(iso) {
  return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric" });
}

const MAX_HISTORY_MESSAGES = 24;
const MAX_USERS_TRACKED = 500;
const conversations = new Map(); // senderId -> messages[]

function getHistory(senderId) {
  return conversations.get(senderId) || [];
}

function saveHistory(senderId, messages) {
  let hist = messages.slice(-MAX_HISTORY_MESSAGES);
  // History must start with a plain customer message (not a tool result).
  while (hist.length && !(hist[0].role === "user" && typeof hist[0].content === "string")) hist.shift();
  if (!conversations.has(senderId) && conversations.size >= MAX_USERS_TRACKED) {
    conversations.delete(conversations.keys().next().value);
  }
  conversations.set(senderId, hist);
  // Also keep it in Upstash (14 days), so a restart or redeploy doesn't make the bot forget the chat.
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    redis(["SET", `hist:${senderId}`, JSON.stringify(hist), "EX", 14 * 24 * 3600])
      .catch((err) => console.error("[history] save failed:", err.message));
  }
}

// After a restart, reload a chat's recent history from Upstash (once per chat).
async function loadHistory(senderId) {
  if (conversations.has(senderId) || !(UPSTASH_URL && UPSTASH_TOKEN)) return;
  try {
    const v = await redis(["GET", `hist:${senderId}`]);
    const hist = v ? JSON.parse(v) : null;
    if (Array.isArray(hist) && !conversations.has(senderId)) conversations.set(senderId, hist);
  } catch (err) { console.error("[history] load failed:", err.message); }
}

// ---------------------------------------------------------------------
// Bot pause per chat: after a hand-off, or when an admin types a reply in
// the page inbox, the bot stays quiet in that chat for BOT_PAUSE_HOURS.
// ---------------------------------------------------------------------
const pausedUntil = new Map(); // senderId -> timestamp (ms)
const botSentMessageIds = new Set(); // message ids the bot itself sent (to tell bot vs. admin replies apart)

function pauseBot(senderId) {
  pausedUntil.set(senderId, Date.now() + BOT_PAUSE_HOURS * 3600 * 1000);
}

function isPaused(senderId) {
  const until = pausedUntil.get(senderId);
  if (!until) return false;
  if (Date.now() > until) {
    pausedUntil.delete(senderId);
    return false;
  }
  return true;
}

const adminSentIds = new Set(); // message ids sent from the Admin Console
function rememberAdminSent(mid) {
  if (!mid) return;
  adminSentIds.add(mid);
  if (adminSentIds.size > 2000) adminSentIds.delete(adminSentIds.values().next().value);
}

function rememberSentId(mid) {
  if (!mid) return;
  botSentMessageIds.add(mid);
  if (botSentMessageIds.size > 5000) botSentMessageIds.delete(botSentMessageIds.values().next().value);
}

// ---------------------------------------------------------------------
// Health check.
// ---------------------------------------------------------------------
// Business website homepage (3ukph.com)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
// Search engines: robots.txt and sitemap.xml (helps Google find and list 3ukph.com)
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /webhook\nDisallow: /admin/\n\nSitemap: https://3ukph.com/sitemap.xml\n"));
app.get("/sitemap.xml", (req, res) => res.type("application/xml").send(
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  '  <url><loc>https://3ukph.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n' +
  '  <url><loc>https://3ukph.com/chat</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>\n' +
  '  <url><loc>https://3ukph.com/privacy</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>\n' +
  '</urlset>\n'));
app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "public", "logo.png")));
// BIR Registration Seal Badge (RMC 38-2026) shown on the website header and footer
app.get("/bir-seal-badge.png", (req, res) => res.sendFile(path.join(__dirname, "public", "bir-seal-badge.png"), { maxAge: "7d" }));
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "public", "favicon.png")));
// Public plan-finder API used by the website (peso prices only, no cost data)
app.get("/api/destinations", (req, res) => res.json(listAllDestinations()));
app.get("/api/plans", (req, res) => {
  const num = (v) => (v === undefined || v === "" ? undefined : Number(v));
  const result = searchPlans({
    destination: String(req.query.destination || "").slice(0, 60),
    minDataGB: num(req.query.minDataGB),
    minDays: num(req.query.minDays),
    maxDays: num(req.query.maxDays),
    needsCallsAndTexts: req.query.calls === "1" ? true : undefined,
    maxResults: 200
  });
  res.json(result);
});
// Headline prices for the website's destination cards (always the latest prices)
app.get("/api/popular", (req, res) => {
  const list = String(req.query.dest || "").split(",").map((d) => d.trim()).filter(Boolean).slice(0, 30);
  const out = {};
  list.forEach((d) => { const h = headlinePrices(d.slice(0, 60)); if (h) out[d] = h; });
  res.set("Cache-Control", "public, max-age=300");
  res.json(out);
});
// Regional / global plan groups with coverage, for the route map
app.get("/api/regions", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json(regionSummaries());
});
// When were prices last updated? (no secrets here)
app.get("/api/price-status", (req, res) => {
  const s = getSyncStatus();
  res.json({ autoUpdate: s.autoUpdate, lastCheck: s.at, ok: s.ok, message: s.message, plans: s.catalog.planCount, rate: s.catalog.rate, pricesUpdatedAt: s.catalog.updatedAt });
});
// Update prices right now instead of waiting for the next automatic check.
// Open https://3ukph.com/admin/refresh-prices?key=YOUR_ADMIN_KEY in a browser.
// Check the discount database: https://3ukph.com/admin/discount-check?key=YOUR_ADMIN_KEY
app.get("/admin/discount-check", async (req, res) => {
  const want = process.env.ADMIN_KEY || "";
  const got = String(req.query.key || "");
  const okKey = want.length >= 12 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!okKey) return res.status(403).send("Wrong or missing key.");
  const r = await checkDiscountDb();
  res.type("text/plain").send(`Discount database: ${r.ok ? "OK ✅" : "NOT WORKING ❌"}\n${r.message}\n`);
});

app.get("/admin/refresh-prices", async (req, res) => {
  const want = process.env.ADMIN_KEY || "";
  const got = String(req.query.key || "");
  const okKey = want.length >= 12 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!okKey) return res.status(403).send("Wrong or missing key.");
  const r = await syncPrices("manual refresh");
  res.type("text/plain").send((r.ok ? "Prices updated. " : "Prices NOT updated. ") + r.message);
});
// ---------------------------------------------------------------------
// Admin Console (https://3ukph.com/admin/console)
// Lets the page admin see the connected Facebook Page, read recent Messenger
// conversations and send a reply from our own app UI. Protected by ADMIN_KEY,
// sent in the "x-admin-key" header.
// ---------------------------------------------------------------------
function adminKeyOk(got) {
  const want = process.env.ADMIN_KEY || "";
  got = String(got || "");
  return want.length >= 12 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function requireAdmin(req, res, next) {
  if (!adminKeyOk(req.get("x-admin-key"))) return res.status(403).json({ error: "Wrong or missing admin key." });
  next();
}
// The console works with the pages_messaging permission only: the page is
// identified from webhook events, and the chat list/history comes from a small
// in-memory log the server keeps of messages it receives and sends.
let cachedPageId = process.env.PAGE_ID || null;
const PAGE_NAME = process.env.PAGE_NAME || "3UK Philippines";
const chatLog = new Map(); // psid -> [{ text, fromPage, by, time, en?, lang? }]
const customerLang = new Map(); // psid -> last non-English language the customer wrote in

// ---------------------------------------------------------------------
// Console translation: detects the language of a message and, if it isn't
// English or Filipino/Taglish, returns { language, english }. Otherwise null.
// ---------------------------------------------------------------------
const translateCache = new Map();
async function callClaudeText(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens || 800, temperature: 0, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
async function translateForConsole(text) {
  const t = String(text || "").trim();
  if (t.length < 2 || !ANTHROPIC_API_KEY) return null;
  if (!/\p{L}{2,}/u.test(t)) return null; // numbers, ICCIDs, emojis: no language to detect
  // Plain ASCII text with common English/Taglish words: skip the API call.
  if (/^[\x00-\x7F₱]*$/.test(t) && /\b(the|and|you|your|is|are|i|my|for|to|of|please|thanks|hi|hello|eSIM|po|ako|ko|ng|sa|mo|yung|na|lang|pa|salamat)\b/i.test(t)) return null;
  if (translateCache.has(t)) return translateCache.get(t);
  const out = await callClaudeText(
    "You detect the language of a chat message and translate it to English. Reply with JSON only: " +
    '{"language":"<language name in English>","english":"<English translation>"}. ' +
    'If the message is already English, Tagalog/Filipino or Taglish, reply exactly {"language":"English","english":""}.',
    t, 900);
  let res = null;
  try {
    const j = JSON.parse(out.replace(/^```(json)?|```$/g, "").trim());
    if (j && j.language && !/^(english|tagalog|filipino|taglish)$/i.test(j.language) && j.english) res = { language: j.language, english: String(j.english).slice(0, 2000) };
  } catch (_) { /* not JSON: ignore */ }
  translateCache.set(t, res);
  if (translateCache.size > 1000) translateCache.delete(translateCache.keys().next().value);
  return res;
}
async function translateTo(text, language) {
  return callClaudeText(
    `Translate the user's message into ${language}. Keep the meaning, a friendly customer-service tone, and keep numbers, ` +
    "peso amounts (₱), plan names, links, emails and codes exactly as written. Reply with the translation only.",
    text, 1200);
}
function recordChat(psid, fromPage, text, by, extra) {
  if (!psid) return;
  const list = chatLog.get(psid) || [];
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: String(text || "").slice(0, 2000), fromPage: !!fromPage, by: by || (fromPage ? "bot" : "customer"), time: new Date().toISOString(), ...(extra || {}) };
  list.push(entry);
  // Non-English messages get an English translation for the console (admin messages are typed in English).
  if (entry.by !== "admin" && !entry.en && !/^\(.*\)$/.test(entry.text.trim())) {
    translateForConsole(entry.text).then((t) => {
      if (!t) { if (entry.by === "customer" && /\p{L}{3,}/u.test(entry.text)) { customerLang.delete(psid); saveChatLog(psid); } return; }
      entry.en = t.english; entry.lang = t.language;
      if (entry.by === "customer") customerLang.set(psid, t.language);
      saveChatLog(psid);
    }).catch(() => {});
  }
  while (list.length > 50) list.shift();
  chatLog.delete(psid); chatLog.set(psid, list); // keep most recent last
  while (chatLog.size > 300) chatLog.delete(chatLog.keys().next().value);
  saveChatLog(psid);
}

// Console chat history is also saved in Upstash (30 days), so restarts/updates don't erase it.
function saveChatLog(psid) {
  if (!(UPSTASH_URL && UPSTASH_TOKEN)) return;
  const list = chatLog.get(psid);
  if (!list) return;
  const last = list[list.length - 1];
  const score = last ? Date.parse(last.time) : Date.now();
  redis(["SET", `chatlog:${psid}`, JSON.stringify({ list, lang: customerLang.get(psid) || null }), "EX", 30 * 24 * 3600])
    .then(() => redis(["ZADD", "chatlog:index", score, psid]))
    .catch((err) => console.error("[chatlog] save failed:", err.message));
}
async function loadChatLogs() {
  if (!(UPSTASH_URL && UPSTASH_TOKEN)) return;
  try {
    const ids = (await redis(["ZREVRANGE", "chatlog:index", 0, 299])) || [];
    for (const psid of ids.slice().reverse()) {
      const v = await redis(["GET", `chatlog:${psid}`]).catch(() => null);
      if (!v) continue;
      const d = JSON.parse(v);
      if (!chatLog.has(psid) && Array.isArray(d.list)) chatLog.set(psid, d.list);
      if (d.lang && !customerLang.has(psid)) customerLang.set(psid, d.lang);
    }
    // Chats from before the console history was saved: rebuild their text from the bot's conversation memory.
    const histKeys = (await redis(["KEYS", "hist:*"])) || [];
    for (const k of histKeys.slice(0, 300)) {
      const psid = k.slice(5);
      if (chatLog.has(psid)) continue;
      const v = await redis(["GET", k]).catch(() => null);
      if (!v) continue;
      const seen = Number(await redis(["GET", `seen:${psid}`]).catch(() => 0)) || Date.now();
      const list = [];
      for (const msg of JSON.parse(v)) {
        let text = typeof msg.content === "string" ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
        text = String(text || "").trim();
        if (!text || text === "Noted." || /^\[.*\]$/s.test(text)) continue;
        list.push({ id: "h" + list.length, text: text.slice(0, 2000), fromPage: msg.role === "assistant", by: msg.role === "assistant" ? "bot" : "customer", time: new Date(seen).toISOString() });
      }
      if (list.length) { chatLog.set(psid, list.slice(-50)); saveChatLog(psid); }
    }
    console.log(`[chatlog] Restored ${chatLog.size} conversations for the Admin Console.`);
  } catch (err) { console.error("[chatlog] load failed:", err.message); }
}
setTimeout(loadChatLogs, 500);
setTimeout(() => { if (esims.configured()) esims.packageList().catch(() => {}); }, 15000); // download eSIMCard package list in the background
setInterval(() => { if (esims.configured()) esims.packageList().catch(() => {}); }, 3600000);

// Image in a chat (payment screenshot, QR code) for the Admin Console: /admin/api/media?psid=...&id=...
app.get("/admin/api/media", requireAdmin, async (req, res) => {
  const psid = String(req.query.psid || "");
  const entry = (chatLog.get(psid) || []).find((e) => e.id === String(req.query.id || ""));
  const media = entry && entry.media;
  if (!media) return res.status(404).json({ error: "No image." });
  try {
    if (media.key) {
      const saved = await loadSentImage(media.key);
      if (saved) { res.set("Content-Type", saved.mime || "image/jpeg"); res.set("Cache-Control", "private, max-age=3600"); return res.send(saved.buf); }
      if (media.src === "store") return res.status(410).json({ error: "This image is no longer stored." });
    }
    let r;
    if (media.src === "wa") {
      const meta = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(media.id)}`, { headers: { Authorization: `Bearer ${WA_TOKEN}` } }).then((x) => x.json());
      if (!meta.url) return res.status(410).json({ error: "WhatsApp no longer has this image (media expires after about 30 days)." });
      r = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    } else {
      r = await fetch(media.url);
    }
    if (!r.ok) return res.status(502).json({ error: `Couldn't load the image (${r.status}).` });
    res.set("Content-Type", r.headers.get("content-type") || media.mime || "image/jpeg");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/admin/console", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
// Installable app (PWA) files for the Admin Console: install it on Android / Windows from the console.
app.use("/admin/app", express.static(path.join(__dirname, "public", "admin-app"), { maxAge: "1d" }));
app.get("/admin/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("application/javascript").sendFile(path.join(__dirname, "public", "admin-app", "sw.js"));
});

app.get("/admin/api/page", requireAdmin, (req, res) => {
  res.json({ id: cachedPageId || "(appears after the first message)", name: PAGE_NAME, category: "Messenger connected via pages_messaging", picture: "/logo.png" });
});

app.get("/admin/api/conversations", requireAdmin, async (req, res) => {
  const entries = Array.from(chatLog.entries()).reverse().slice(0, 20);
  const list = await Promise.all(entries.map(async ([psid, msgs]) => {
    const last = msgs[msgs.length - 1] || {};
    const member = await getResellerSafe(psid);
    return { id: psid, psid, customerName: await getCustomerName(psid), snippet: last.text || "", updated: last.time, botPaused: isPaused(psid), reseller: member ? member.tier : null, channel: isWa(psid) ? "WhatsApp" : "Messenger", language: customerLang.get(psid) || null };
  }));
  res.json(list);
});

app.get("/admin/api/messages", requireAdmin, async (req, res) => {
  const psid = String(req.query.conv || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad conversation id." });
  const name = await getCustomerName(psid);
  res.json((chatLog.get(psid) || []).map((m, i) => ({
    id: m.id || String(i), text: m.text, time: m.time, fromPage: m.fromPage, en: m.en || null, lang: m.lang || null, hasMedia: !!m.media, mediaType: m.media ? (m.media.mime || "image") : null,
    fromName: m.fromPage ? (m.by === "admin" ? `${PAGE_NAME} (admin)` : `${PAGE_NAME} (AI assistant)`) : name
  })));
});

// Sends a message as the page admin (no bot tag, so the bot pauses in that chat
// and doesn't talk over the admin -- same as replying from the page inbox).
app.post("/admin/api/send", requireAdmin, async (req, res) => {
  const psid = String((req.body && req.body.psid) || "");
  const text = String((req.body && req.body.text) || "").trim();
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Pick a conversation first." });
  if (!text || text.length > 1900) return res.status(400).json({ error: "Message must be 1 to 1900 characters." });
  // Optional: translate the admin's English reply into the customer's language.
  let outText = text, extra;
  const lang = customerLang.get(psid);
  if (req.body.translate && lang) {
    try {
      outText = (await translateTo(text, lang)).slice(0, 1900) || text;
      extra = { en: text, lang };
    } catch (e) { return res.status(502).json({ error: "Couldn't translate right now: " + e.message + ". Untick Translate to send in English." }); }
  }
  const sendAndLog = () => { recordChat(psid, true, outText, "admin", extra); };
  try {
    if (isWa(psid)) {
      const data = await waSend(psid, { type: "text", text: { body: outText, preview_url: false } });
      if (!data) return res.status(502).json({ error: "WhatsApp didn't accept the message. If the customer's last message was more than 24 hours ago, WhatsApp only allows template messages." });
      pauseBot(psid);
      sendAndLog();
      return res.json({ ok: true, sentText: outText, messageId: data.messages && data.messages[0] && data.messages[0].id });
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: outText } })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (data.error && data.error.message) || `Facebook error ${r.status}` });
    pauseBot(psid);
    rememberAdminSent(data.message_id);
    sendAndLog();
    res.json({ ok: true, sentText: outText, messageId: data.message_id });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Admin sends an image (eSIM QR code, receipt) from the console. Body: { psid, image: dataURL, caption? }
const sentImages = new Map(); // entryId -> { mime, buf } (recent, also saved in Upstash 30 days)
async function storeSentImage(key, mime, buf) {
  sentImages.set(key, { mime, buf });
  while (sentImages.size > 60) sentImages.delete(sentImages.keys().next().value);
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try { await redis(["SET", `img:${key}`, JSON.stringify({ mime, b64: buf.toString("base64") }), "EX", 30 * 24 * 3600]); }
    catch (e) { console.error("[send-image] couldn't save a copy for the console:", e.message); }
  }
}
async function loadSentImage(key) {
  if (sentImages.has(key)) return sentImages.get(key);
  if (!(UPSTASH_URL && UPSTASH_TOKEN)) return null;
  const v = await redis(["GET", `img:${key}`]).catch(() => null);
  if (!v) return null;
  const d = JSON.parse(v); return { mime: d.mime, buf: Buffer.from(d.b64, "base64") };
}
// Sends an image as the admin (WhatsApp or Messenger) and records it for the console.
async function adminSendImage(psid, buf, mime, caption, capExtra) {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
  let media, messageId;
  if (isWa(psid)) {
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", mime);
    fd.append("file", new Blob([buf], { type: mime }), `image.${ext}`);
    const up = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/media`, { method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}` }, body: fd });
    const ud = await up.json().catch(() => ({}));
    if (!up.ok || !ud.id) throw new Error("WhatsApp didn't accept the image: " + ((ud.error && ud.error.message) || up.status));
    const data = await waSend(psid, { type: "image", image: caption ? { id: ud.id, caption } : { id: ud.id } });
    if (!data) throw new Error("WhatsApp didn't deliver the image. If the customer's last message was more than 24 hours ago, WhatsApp only allows template messages.");
    messageId = data.messages && data.messages[0] && data.messages[0].id;
    media = { src: "wa", id: ud.id, mime };
  } else {
    const fd = new FormData();
    fd.append("recipient", JSON.stringify({ id: psid }));
    fd.append("messaging_type", "RESPONSE");
    fd.append("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: false } } }));
    fd.append("filedata", new Blob([buf], { type: mime }), `image.${ext}`);
    const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || `Facebook error ${r.status}`);
    messageId = data.message_id; rememberAdminSent(messageId);
    if (caption) await adminSendText(psid, caption, true);
    media = { src: "store", mime };
  }
  pauseBot(psid);
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await storeSentImage(key, mime, buf);
  media.key = key;
  recordChat(psid, true, caption ? "(image) " + caption : "(image)", "admin", { media, ...(capExtra || {}) });
  return messageId;
}
// Sends a text as the admin (no console record when quiet=true; caller records it).
async function adminSendText(psid, text, quiet) {
  if (isWa(psid)) {
    const data = await waSend(psid, { type: "text", text: { body: text.slice(0, 4000), preview_url: false } });
    if (!data) throw new Error("WhatsApp didn't accept the message (24-hour window may have closed).");
  } else {
    const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: text.slice(0, 1990) } })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || `Facebook error ${r.status}`);
    rememberAdminSent(d.message_id);
  }
  pauseBot(psid);
  if (!quiet) recordChat(psid, true, text, "admin");
}

app.post("/admin/api/send-image", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const psid = String(b.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Pick a conversation first." });
  const m = String(b.image || "").match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: "Please choose a PNG or JPG image." });
  const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Image is too big (max 8 MB)." });
  let caption = String(b.caption || "").trim().slice(0, 1000);
  let capExtra;
  const lang = customerLang.get(psid);
  if (caption && b.translate && lang) {
    try { const t = (await translateTo(caption, lang)).slice(0, 1000); if (t) { capExtra = { en: caption, lang }; caption = t; } } catch (e) { /* send in English */ }
  }
  try {
    const messageId = await adminSendImage(psid, buf, mime, caption, capExtra);
    appendNote(psid, "[ADMIN UPDATE: The admin just sent the customer an image" + (caption ? ` with the message: "${caption.slice(0, 200)}"` : "") + ". If it was the eSIM QR code, help them install it if they ask.]");
    res.json({ ok: true, messageId });
  } catch (e) { console.error("[send-image] failed:", e.message); res.status(502).json({ error: e.message }); }
});

// ---- 1-tap eSIM delivery: buy on eSIMCard, send QR + install links, save ICCID ----
// order:last:<psid> = the customer's latest order (saved when the bot creates it)
async function saveLastOrder(psid, o) {
  if (!hasDb()) { lastOrders.set(psid, o); return; }
  await redis(["SET", `order:last:${psid}`, JSON.stringify(o), "EX", 60 * 24 * 3600]).catch((e) => console.error("[order] save failed:", e.message));
}
const lastOrders = new Map();
async function getLastOrder(psid) {
  if (!hasDb()) return lastOrders.get(psid) || null;
  const v = await redis(["GET", `order:last:${psid}`]).catch(() => null);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
const deliveryLocks = new Set();

app.get("/admin/api/plan-search", requireAdmin, (req, res) => {
  res.json({ plans: findPlansByText(req.query.q, 15).map((p) => ({ planId: p.planId, name: p.name, destination: p.destination, price: p.price })) });
});
app.get("/admin/api/delivery", requireAdmin, async (req, res) => {
  const psid = String(req.query.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  const order = await getLastOrder(psid);
  const planId = String(req.query.planId || (order && order.planId) || "");
  const plan = planId ? getPlan(planId) : null;
  const out = { order, plan: plan ? { planId: plan.planId, name: plan.name, destination: plan.destination, price: plan.price } : null, apiConnected: esims.configured() };
  if (plan && esims.configured()) {
    try {
      const raw = getRawPlan(plan.planId);
      const pk = await esims.findPackage(plan.name, { retailUSD: raw && raw.retailPrice, costUSD: reseller.costOf(raw) });
      if (pk && pk.loading) out.packageError = `Downloading the eSIMCard package list (${pk.status.building || "starting"}). This takes about 5 minutes the first time; pick the plan again shortly.`;
      else if (pk && pk.ambiguous) out.packageError = `eSIMCard has ${pk.matches} packages named "${pk.name}" and the price didn't single one out. Deliver this one manually.`;
      else out.package = pk;
    } catch (e) { out.packageError = e.message; }
    try { out.balanceUSD = await esims.accountBalance(); } catch (e) { /* optional */ }
  }
  res.json(out);
});
app.post("/admin/api/deliver", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const psid = String(b.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Pick a conversation first." });
  if (!esims.configured()) return res.status(400).json({ error: "ESIMCARD_TOKEN is not set in Render." });
  const plan = getPlan(b.planId);
  if (!plan) return res.status(400).json({ error: "Pick the plan first." });
  if (deliveryLocks.has(psid)) return res.status(409).json({ error: "A delivery for this customer is already running. Wait a moment." });
  deliveryLocks.add(psid);
  try {
    const rawPlan = getRawPlan(plan.planId);
    const pkg = await esims.findPackage(plan.name, { retailUSD: rawPlan && rawPlan.retailPrice, costUSD: reseller.costOf(rawPlan) });
    if (pkg && pkg.loading) return res.status(503).json({ error: "The eSIMCard package list is still downloading. Try again in a few minutes." });
    if (pkg && pkg.ambiguous) return res.status(400).json({ error: `eSIMCard has ${pkg.matches} packages with this name. Deliver this one manually.` });
    if (!pkg) return res.status(400).json({ error: `eSIMCard has no package named "${plan.name}". Deliver this one manually.` });
    if (String(b.packageId || "") !== pkg.id) return res.status(409).json({ error: "The package changed since you checked. Tap Check again." });
    // Final check on eSIMCard right before buying: same package name, price not changed much.
    try {
      const live = await esims.packageDetail(pkg.id);
      if (live.name && live.name.toLowerCase() !== plan.name.toLowerCase()) return res.status(409).json({ error: `eSIMCard package is now "${live.name}", not "${plan.name}". Not bought; deliver manually.` });
      if (live.price && pkg.price && live.price > pkg.price * 1.1) return res.status(409).json({ error: `eSIMCard price went up to $${live.price.toFixed(2)} (was $${pkg.price.toFixed(2)}). Not bought; check before delivering.` });
    } catch (e) { console.error("[deliver] detail check skipped:", e.message); }
    let sim;
    try { sim = await esims.purchase(pkg.id); }
    catch (e) { await notifyAdmin({ title: "eSIM purchase FAILED", message: `${await getCustomerName(psid)}\n${plan.name}\n${e.message}`, tags: "warning" }); return res.status(502).json({ error: e.message }); }
    if (!sim.lpa && !sim.iccid) {
      await notifyAdmin({ title: "eSIM bought, details missing", message: `${await getCustomerName(psid)}\n${plan.name}\nCheck eSIMCard "My eSIMs" and send the QR manually.`, tags: "warning" });
      return res.status(502).json({ error: "The eSIM was bought, but eSIMCard didn't return the QR yet. Open eSIMCard > My eSIMs and send it manually (don't buy again).", bought: true });
    }
    const steps = [];
    if (sim.lpa) {
      let png;
      try { png = brandedQr(sim.lpa, sim.iccid); } // 3UK-branded card; falls back to a plain QR
      catch (e) { console.error("[deliver] branded QR failed:", e.message); png = await QRCode.toBuffer(sim.lpa, { width: 720, margin: 3, errorCorrectionLevel: "M" }); }
      await adminSendImage(psid, png, "image/png", `Your eSIM QR code: ${plan.name}`);
      steps.push("qr");
    }
    const lines = [`✅ Your eSIM is ready! ${plan.name}`, "", "📲 How to install (on Wi-Fi, before you travel):", "1️⃣ Easiest: scan the QR code above using your phone's eSIM settings (show it on another screen or ask someone to show it)."];
    lines.push("2️⃣ Only this one phone? Save the QR image. iPhone: open it in Photos, press and hold the QR, tap \"Add eSIM\". Android: Settings › SIM manager › Add eSIM › Scan QR › tap the gallery icon and pick the image.");
    if (sim.ios) lines.push(`3️⃣ iPhone (iOS 17.4+) one-tap link, open it in Safari: ${sim.ios}`);
    if (sim.smdp && sim.matching) lines.push("", "Or type it in manually (Add eSIM › Enter details manually):", `SM-DP+ address: ${sim.smdp}`, `Activation code: ${sim.matching}`);
    if (sim.iccid) lines.push("", `🔖 ICCID: ${sim.iccid}`);
    lines.push("", "The QR usually works only once, so don't delete the eSIM after installing. When you arrive, turn on the eSIM line and data roaming.", "Need help? Just reply here 💬");
    if (sim.iccid) lines.push("", `📊 Check your data anytime: https://3ukph.com/data?iccid=${sim.iccid}`);
    await adminSendText(psid, lines.join("\n"));
    steps.push("text");
    const order = await getLastOrder(psid);
    if (sim.iccid) {
      try { await esims.addEsim(psid, { iccid: sim.iccid, plan: plan.name, email: (order && order.email) || "", note: "Auto-delivered" }); } catch (e) { console.error("[deliver] save ICCID:", e.message); }
    }
    await saveLastOrder(psid, { ...(order && order.planId === plan.planId ? order : { planId: plan.planId, plan: plan.name, price: plan.price, method: "(chosen in console)", at: new Date().toISOString() }), deliveredAt: new Date().toISOString(), iccid: sim.iccid || null });
    appendNote(psid, `[ADMIN UPDATE: The customer's eSIM (${plan.name}${sim.iccid ? ", ICCID ending " + sim.iccid.slice(-4) : ""}) was just delivered with its QR code and install links. Help them install it if they ask. Use check_data_usage for data questions.]`);
    notifyAdmin({ title: "eSIM delivered", message: `${await getCustomerName(psid)}\n${plan.name}${sim.iccid ? "\nICCID " + sim.iccid : ""}`, tags: "white_check_mark" }).catch(() => {});
    res.json({ ok: true, iccid: sim.iccid || null, steps, costUSD: pkg.price });
  } catch (e) {
    console.error("[deliver] failed:", e.message);
    res.status(502).json({ error: e.message });
  } finally { deliveryLocks.delete(psid); }
});

// --- Reseller program (approve resellers, upload private costs) ---
app.get("/admin/api/reseller", requireAdmin, async (req, res) => {
  const psid = String(req.query.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  try { res.json({ member: await reseller.getMember(psid) }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/admin/api/reseller", requireAdmin, async (req, res) => {
  const psid = String((req.body && req.body.psid) || "");
  const tier = String((req.body && req.body.tier) || "").toLowerCase();
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Pick a conversation first." });
  if (!["starter", "gold", "none"].includes(tier)) return res.status(400).json({ error: "Tier must be starter, gold or none." });
  try {
    const before = await reseller.getMember(psid);
    const member = tier === "none" ? await reseller.setMember(psid, null)
      : await reseller.setMember(psid, await (async () => {
          const app = await reseller.getApplicant(psid).catch(() => null);
          const fbName = await getCustomerName(psid);
          const keep = before && before.name && !/^Messenger user/.test(before.name) ? before.name : null;
          return { tier, name: keep || (app && app.name) || fbName, contact: (before && before.contact) || (app && app.contact) || "", since: before && before.since };
        })());
    if (!before || !member || before.tier !== member.tier) {
      appendNote(psid, member
        ? `[ADMIN UPDATE: this person is now an APPROVED ${member.tier === "gold" ? "GOLD" : "STARTER"} reseller. Anything earlier in this chat about the application being pending no longer applies. Use reseller prices from now on: call get_plan again before confirming any plan, because prices quoted earlier were retail prices.${member.tier === "gold" ? " They can pay with the Wallet." : ""}]`
        : "[ADMIN UPDATE: this person is no longer a reseller. Use regular retail prices from now on.]");
    }
    if (member && (!before || before.tier !== member.tier) && req.body.notify !== false) {
      const label = member.tier === "gold" ? "Gold" : "Starter";
      await sendText(psid, `Welcome to the 3UK Philippines reseller program! 🎉 You're now a ${label} reseller. Ask me for any destination and I'll show your reseller price, the retail price, and your profit.`);
    }
    res.json({ ok: true, member });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/admin/api/resellers", requireAdmin, async (req, res) => {
  try {
    const members = await reseller.listMembers();
    const withWallets = await Promise.all(members.map(async (m) => {
      const [balance, ledger] = await Promise.all([reseller.getBalance(m.psid), reseller.getLedger(m.psid, 1000)]);
      return { ...m, balance, ...reseller.summarize(ledger) };
    }));
    res.json({ members: withWallets, costs: reseller.getCostsInfo() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// One reseller's wallet and full purchase history.
app.get("/admin/api/wallet", requireAdmin, async (req, res) => {
  const psid = String(req.query.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  try {
    const [member, balance, ledger] = await Promise.all([reseller.getMember(psid), reseller.getBalance(psid), reseller.getLedger(psid, 1000)]);
    res.json({ psid, member, balance, ledger, summary: reseller.summarize(ledger) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Top-up / refund / adjust a reseller's wallet.
app.post("/admin/api/wallet", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const psid = String(b.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  try {
    const r = await reseller.walletTransaction(psid, { type: b.type, amountPHP: b.amount, note: b.note });
    if (b.notify !== false && (b.type === "topup" || b.type === "refund")) {
      await sendText(psid, `${b.type === "topup" ? "Your reseller wallet was topped up" : "A refund was added to your reseller wallet"}: +${formatPHP(Math.abs(r.entry.amount))}. Your balance is now ${formatPHP(r.balance)}. Thank you!`);
    }
    appendNote(psid, `[ADMIN UPDATE: reseller wallet ${b.type} of ${formatPHP(Math.abs(r.entry.amount))}. Current wallet balance: ${formatPHP(r.balance)}.]`);
    // A top-up/refund closes what the admin was handling, so let the AI assistant answer this reseller again.
    if (b.type === "topup" || b.type === "refund") pausedUntil.delete(psid);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Upload the eSIMCard "reseller_pricing" export (.xlsx) -- needs the Price (cost) and Retail Price columns.
app.post("/admin/api/reseller-costs", requireAdmin, express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.slice(0, 2).toString() !== "PK") return res.status(400).json({ error: "That's not an Excel (.xlsx) file." });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const map = reseller.costsFromWorkbook(wb);
    if (map.size < 500) return res.status(400).json({ error: `Only ${map.size} plans with a cost found. Upload the eSIMCard reseller_pricing export (it needs "Price" and "Retail Price" columns).` });
    const r = await reseller.saveCosts(map, "Admin Console upload");
    res.json({ ok: true, plans: map.size, savedToDatabase: r.saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- eSIM records per customer (permanent) + live usage ---
app.get("/admin/api/esims", requireAdmin, async (req, res) => {
  const psid = String(req.query.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  try { res.json({ esims: await esims.listEsims(psid), apiConnected: esims.configured() }); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/admin/api/esims", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const psid = String(b.psid || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Pick a conversation first." });
  try {
    if (b.remove) return res.json({ ok: true, esims: await esims.removeEsim(psid, b.remove) });
    const entry = await esims.addEsim(psid, b);
    appendNote(psid, `[ADMIN UPDATE: eSIM delivered and saved for this customer: ${entry.plan || "eSIM"} (ICCID ending ${entry.iccid.slice(-4)}). Use check_data_usage when they ask about their data.]`);
    res.json({ ok: true, entry, esims: await esims.listEsims(psid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/admin/api/esim-usage", requireAdmin, async (req, res) => {
  const ic = esims.cleanIccid(req.query.iccid);
  if (!esims.isIccid(ic)) return res.status(400).json({ error: "Enter a valid ICCID." });
  try { const u = await esims.usage(ic); delete u.raw; delete u.details; res.json(u); } catch (e) { res.status(502).json({ error: e.message }); }
});
// --- Public "Check my data" (website pop-up). Shows only data numbers and
// dates for one of OUR eSIMs; no names, phones or order details. Rate limited.
const dcHits = new Map(); // ip -> [timestamps]
let dcGlobal = [];
const dcCache = new Map(); // iccid -> { at, body }
function dcClientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function dcLimited(ip) {
  const now = Date.now();
  dcGlobal = dcGlobal.filter((t) => now - t < 3600000);
  if (dcGlobal.length >= 600) return "busy";
  const list = (dcHits.get(ip) || []).filter((t) => now - t < 86400000);
  const last10 = list.filter((t) => now - t < 600000).length;
  if (last10 >= 20 || list.length >= 100) { dcHits.set(ip, list); return "you"; }
  list.push(now); dcHits.set(ip, list); dcGlobal.push(now);
  if (dcHits.size > 5000) for (const [k, v] of dcHits) if (!v.length || now - v[v.length - 1] > 86400000) dcHits.delete(k);
  return null;
}
function validityFromPlan(plan) { const m = String(plan || "").match(/(\d{1,3})\s*-?\s*days?/i); return m ? Number(m[1]) : null; }
app.get("/api/data-check", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const ic = esims.cleanIccid(req.query.iccid);
  if (!esims.isIccid(ic)) return res.status(400).json({ error: "bad_iccid", message: "That doesn't look like an ICCID. It starts with 89 and has 19 or 20 digits." });
  const cached = dcCache.get(ic);
  if (cached && Date.now() - cached.at < 60000 && !req.query.refresh) return res.json(cached.body);
  const lim = dcLimited(dcClientIp(req));
  if (lim) return res.status(429).json({ error: "rate_limited", message: lim === "busy" ? "Lots of people are checking right now. Please try again in a few minutes." : "Too many checks from this device. Please wait about 10 minutes and try again." });
  if (!esims.configured()) return res.status(503).json({ error: "unavailable", message: "Data checking is temporarily unavailable. Message us on WhatsApp and we'll check for you." });
  // Only our own eSIMs: the ICCID must be on our eSIMCard account list.
  const onList = await esims.findEntry(ic);
  if (onList.found === false) return res.status(404).json({ error: "not_found", message: "We couldn't find a 3UKPH eSIM with that ICCID. Please check the number, or message us on WhatsApp." });
  let u;
  try { u = await esims.usage(ic); }
  catch (e) {
    const notFound = /wasn't found|not found|404|422|invalid/i.test(e.message);
    if (!notFound) console.error("[data-check] failed:", e.message);
    return res.status(notFound ? 404 : 502).json(notFound
      ? { error: "not_found", message: "We couldn't find a 3UKPH eSIM with that ICCID. Please check the number, or message us on WhatsApp." }
      : { error: "unavailable", message: "We couldn't reach the network just now. Please try again in a minute." });
  }
  let plan = u.bundle || null, deliveredAt = null; const apiPlan = u.bundle || null;
  try {
    const owner = await esims.findCustomerByIccid(ic);
    if (owner) { const rec = (await esims.listEsims(owner)).find((e) => e.iccid === ic); if (rec) { plan = apiPlan || rec.plan || plan; deliveredAt = rec.addedAt || null; } }
  } catch (e) { /* records are optional */ }
  const st = String(u.statusText || "").toLowerCase();
  const expMs = u.expires ? Date.parse(u.expires) : NaN;
  const remainingZero = u.remaining && /^0(\.0+)?\s*(GB|MB)$/i.test(u.remaining) && !u.unlimited;
  let state = "active";
  if ((Number.isFinite(expMs) && expMs < Date.now()) || /expir/.test(st)) state = "expired";
  else if (remainingZero || /deplet|exhaust|used.?up|finish/.test(st)) state = "used_up";
  else if (/not.?activ|inactive|pending|new|unused|ready|released|not.?install/.test(st) || (!u.unlimited && /^0(\.0+)?\s*(MB|GB)$/i.test(String(u.used || "")))) state = "not_active";
  const body = {
    ok: true, iccidEnding: ic.slice(-4), plan,
    total: u.total, used: u.used, remaining: u.remaining, percentUsed: u.percentUsed, unlimited: !!u.unlimited,
    state, expires: Number.isFinite(expMs) ? new Date(expMs).toISOString() : null, expiresEstimated: !!u.expiresEstimated,
    activated: u.activated || u.installedAt || null, validityDays: validityFromPlan(plan) || u.validityDays || null, deliveredAt,
    purchasedAt: u.purchasedAt || deliveredAt || null,
    checkedAt: new Date().toISOString()
  };
  dcCache.set(ic, { at: Date.now(), body });
  if (dcCache.size > 2000) dcCache.clear();
  res.json(body);
});
app.get(["/data", "/check-data", "/usage"], (req, res) => {
  const ic = esims.cleanIccid(req.query.iccid);
  res.redirect(302, "/" + (esims.isIccid(ic) ? `?iccid=${ic}` : "") + "#check-data");
});

app.get("/admin/api/esim-find", requireAdmin, async (req, res) => {
  const ic = esims.cleanIccid(req.query.iccid);
  try {
    const psid = await esims.findCustomerByIccid(ic);
    res.json(psid ? { psid, customerName: await getCustomerName(psid), channel: isWa(psid) ? "WhatsApp" : "Messenger" } : { psid: null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Raw eSIMCard API check (for setup): /admin/esimcard-test?key=ADMIN_KEY&iccid=89...
app.get("/admin/esimcard-test", async (req, res) => {
  if (!adminKeyOk(req.query.key)) return res.status(403).send("Wrong or missing key.");
  if (!esims.configured()) return res.type("text/plain").send("ESIMCARD_TOKEN is not set in Render yet.");
  try {
    const ic = esims.cleanIccid(req.query.iccid);
    if (req.query.get) {
      // Read-only peek at any eSIMCard GET endpoint (for setup), e.g. &get=packages?page=1
      const path = String(req.query.get).replace(/^\/+/, "");
      if (!/^[A-Za-z0-9_\-\/?=&.]+$/.test(path)) return res.status(400).send("Bad path.");
      const t0 = Date.now();
      const d = await esims.call(path);
      return res.type("application/json").send(`// ${Date.now() - t0} ms\n` + JSON.stringify(d, null, 2).slice(0, 6000));
    }
    if (req.query.find || req.query.pricing) {
      await esims.packageList();
      const st = esims.pricingStatus();
      if (req.query.pricing || !st.packages) return res.type("application/json").send(JSON.stringify(st, null, 2).slice(0, 5000) + (st.packages ? "" : "\n\nThe package list is downloading in the background (about 5 minutes). Refresh this page to see progress."));
      const rows = [];
      for (const pl of findPlansByText(req.query.find, 4)) {
        const raw = getRawPlan(pl.planId);
        rows.push({ planId: pl.planId, name: pl.name, ourPrice: pl.price, costUSD: reseller.costOf(raw), package: await esims.findPackage(pl.name, { retailUSD: raw && raw.retailPrice, costUSD: reseller.costOf(raw) }) });
      }
      return res.type("application/json").send(JSON.stringify({ packageList: { packages: st.packages, loadedAt: st.loadedAt }, rows }, null, 2));
    }
    const out = ic ? await esims.usage(ic) : await esims.call("my-esims?page=1");
    res.type("application/json").send(JSON.stringify(out, null, 2).slice(0, 6000));
  } catch (e) { res.status(502).type("text/plain").send(e.message + (e.data ? "\n" + JSON.stringify(e.data).slice(0, 1500) : "")); }
});

app.post("/admin/api/resume-bot", requireAdmin, (req, res) => {
  const psid = String((req.body && req.body.psid) || "");
  if (!/^(wa)?\d+$/.test(psid)) return res.status(400).json({ error: "Bad id." });
  pausedUntil.delete(psid);
  res.json({ ok: true });
});

// Health check for uptime monitoring
app.get("/health", (req, res) => {
  res.send(`3UKPH Messenger bot is running. Catalog: ${listAllDestinations().length} destinations loaded.`);
});

// ---------------------------------------------------------------------
// Facebook webhook verification (GET).
// ---------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] Verified successfully.");
    res.status(200).send(challenge);
  } else {
    console.warn("[webhook] Verification failed -- token mismatch.");
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------------
// Incoming messages (POST).
// ---------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.status(200).send("EVENT_RECEIVED"); // answer Facebook right away
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    if (entry.id) cachedPageId = entry.id;
    for (const event of entry.messaging || []) {
      try {
        await handleMessagingEvent(event);
      } catch (err) {
        console.error("[webhook] Error handling event:", err);
      }
    }
  }
});

async function handleMessagingEvent(event) {
  const message = event.message;

  // Echo = a message the PAGE sent. If the bot didn't send it, an admin
  // typed it in the inbox -> pause the bot in that chat so they don't talk over each other.
  if (message && message.is_echo) {
    const customerId = event.recipient && event.recipient.id;
    const sentByBot = message.metadata === BOT_METADATA || botSentMessageIds.has(message.mid);
    const sentByConsole = adminSentIds.has(message.mid);
    // Facebook's own Instant reply / away message (set in Meta Business Suite) also arrives
    // as an echo. It starts with AUTO_REPLY_PREFIX, so it must not pause the bot.
    const autoReplyPrefix = (process.env.AUTO_REPLY_PREFIX || "Salamat sa message").toLowerCase();
    const isFbAutoReply = !!message.text && message.text.trim().toLowerCase().startsWith(autoReplyPrefix);
    if (isFbAutoReply) return;
    if (customerId && !sentByBot && !sentByConsole) {
      recordChat(customerId, true, message.text || "(attachment)", "admin");
      pauseBot(customerId);
      console.log(`[handoff] Admin replied to ${customerId}; bot paused for ${BOT_PAUSE_HOURS}h.`);
    }
    return;
  }

  const senderId = event.sender && event.sender.id;
  if (!senderId) return;

  // Button taps (e.g. "Get Started") arrive as postbacks.
  let text = message && message.text;
  if (!text && event.postback) text = event.postback.title || event.postback.payload;

  {
    const att = ((message && message.attachments) || []).find((a) => a.payload && a.payload.url);
    const media = att ? { src: "url", url: att.payload.url, mime: att.type === "image" ? "image" : att.type } : null;
    recordChat(senderId, false, text || (message && message.attachments ? (att && att.type === "image" ? "(image)" : "(attachment)") : ""), "customer", media ? { media } : undefined);
  }
  if (isPaused(senderId)) return; // a human is handling this chat

  if (!text) {
    const attachments = (message && message.attachments) || [];
    if (attachments.some((a) => a.type === "image")) {
      // Most likely a payment screenshot.
      const customer = await getCustomerName(senderId);
      await notifyAdmin({
        title: "Payment screenshot received",
        message: `Customer: ${customer} sent an image (likely proof of payment). Please verify it in the page inbox and send the eSIM QR.`,
        tags: "receipt"
      });
      await sendText(senderId, "Thank you! We received your screenshot. Our team is verifying your payment now, and your eSIM QR code will be sent within 5 minutes once it's confirmed.");
      appendNote(senderId, "[Customer sent an image, probably a payment screenshot. The admin was alerted.]");
    } else if (message) {
      await sendText(senderId, "Thanks for your message! Could you type your question in words? That helps me answer accurately. 😊");
    }
    return;
  }

  await sendTyping(senderId);
  const reply = await getClaudeReply(senderId, text);
  // (If a hand-off happened during this reply, this is the one "an admin will reply soon" message.)
  if (reply) await sendText(senderId, reply);
}

// Adds a note to the chat history so the AI knows something happened (e.g. an image was sent).
async function appendNote(senderId, note) {
  await loadHistory(senderId);
  const hist = getHistory(senderId).slice();
  hist.push({ role: "user", content: note });
  hist.push({ role: "assistant", content: "Noted." });
  saveHistory(senderId, hist);
}

// ---------------------------------------------------------------------
// Ask Claude for a reply, with a short tool-use loop.
// ---------------------------------------------------------------------
async function getClaudeReply(senderId, userText) {
  await loadHistory(senderId);
  const member = await getResellerSafe(senderId);
  const resellerContext = member
    ? `\n\n--- THIS CHAT ---\nThe person you are chatting with is an APPROVED ${member.tier === "gold" ? "GOLD" : "STARTER"} RESELLER` +
      `${member.name ? `; their name is ${member.name}, so address them by that name` : ""}. In search and get_plan results for this person, "price" IS their reseller price (what they pay us), ` +
      `"retailPrice" is our public price and "resellerProfitIfSoldAtRetail" is their profit. Always quote "price" as their price ` +
      `(you may also mention the retail price and their profit) and use it as confirmedPrice in create_order. Discount codes don't ` +
      `apply to reseller prices. This status is current and OVERRIDES anything said earlier in the conversation (e.g. an application ` +
      `that was pending); if a plan was quoted earlier, call get_plan again to get the reseller price before ordering.` + (member.tier === "gold" ? ` As a Gold reseller they can pay with paymentMethod "Wallet" (deducted from their prepaid wallet). Never refuse a Wallet payment yourself -- ` +
        `call create_order with paymentMethod "Wallet"; it checks the balance and tells you if it's too low.` : "")
    : "\n\n--- THIS CHAT ---\nThis person is NOT an approved reseller. Never quote reseller prices or reseller discounts to them.";
  // Warm welcome-back greeting on the first message of a new visit.
  let greetingContext = "";
  const lastSeen = await getAndSetLastSeen(senderId);
  const newVisit = !lastSeen || Date.now() - lastSeen > RETURNING_GAP_HOURS * 3600 * 1000;
  if (newVisit) {
    const customerRec = await getCustomerRecord(senderId);
    let greeting = "";
    if (member) {
      const first = realFirstName(member.name) || realFirstName(await getCustomerName(senderId));
      let bal = "";
      if (member.tier === "gold") { try { bal = formatPHP(await reseller.getBalance(senderId)); } catch { /* ignore */ } }
      greeting = `Welcome back${first ? ", " + first : ""}! 👋 Thanks for being a 3UK Philippines ${member.tier === "gold" ? "Gold" : "Starter"} reseller.` +
        (bal ? ` Your wallet balance is ${bal}.` : "");
    } else if (customerRec && customerRec.orders > 0) {
      const first = realFirstName(await getCustomerName(senderId));
      greeting = `Welcome back${first ? ", " + first : ""}! 👋 So glad to see you again at 3UK Philippines.`;
    }
    // The greeting is sent by the code itself (so it never gets skipped); the AI then just answers.
    if (greeting) {
      await sendText(senderId, greeting);
      greetingContext = `\n\n--- GREETING ---\nThis message was just sent to them: "${greeting}". Do NOT greet or welcome them again; go straight to answering their message.`;
    }
  }
  const systemPrompt =
    "You are the AI assistant for 3UK Philippines, an eSIM business, replying to customers on " +
    (isWa(senderId) ? "WhatsApp (never call it Messenger)" : "Facebook Messenger") + ". Follow the business information below exactly. For ANY plan or price question, use the " +
    "search_esim_plans / get_plan tools -- never guess or remember a price. If a destination isn't found, " +
    "say so plainly. Write plain text only (no asterisks or markdown). This is a private one-to-one chat: " +
    "EVERY customer message in it comes from the same single person, so never say you are busy with or helping " +
    "someone else. Names mentioned in the chat (e.g. on a reseller application) belong to this person unless they " +
    "clearly say the eSIM is for someone else.\n\n" + BUSINESS_INFO + resellerContext + greetingContext;

  const messages = getHistory(senderId).slice();
  messages.push({ role: "user", content: userText });

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 800,
          temperature: 0.3,
          system: systemPrompt,
          tools: TOOLS,
          messages
        })
      });

      if (!res.ok) {
        console.error("[claude] API error:", res.status, await res.text());
        return "Sorry, I'm having a little trouble right now! Please try again in a moment, or an admin will follow up with you shortly.";
      }

      const data = await res.json();
      messages.push({ role: "assistant", content: data.content });

      if (data.stop_reason === "tool_use") {
        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== "tool_use") continue;
          let result;
          try {
            result = await runTool(block.name, block.input || {}, senderId);
            if (block.name === "create_order" && result && result.ok) { recordCustomerOrder(senderId, result.plan); saveLastOrder(senderId, { planId: String((block.input || {}).planId || ""), plan: result.plan, price: result.price, method: result.paymentMethod || (block.input || {}).paymentMethod || "", email: String((block.input || {}).email || ""), at: new Date().toISOString() }); }
          } catch (err) {
            console.error("[tool] Failed:", block.name, err);
            result = { error: "Tool failed: " + err.message };
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      saveHistory(senderId, messages);
      return cleanForMessenger(text) || "Sorry, could you rephrase that? I want to make sure I answer correctly.";
    }

    console.warn("[claude] Exceeded max tool rounds for", senderId);
    const fallback = "Sorry, that one's tricky -- let me have an admin follow up with you on this.";
    saveHistory(senderId, [...getHistory(senderId), { role: "user", content: userText }, { role: "assistant", content: fallback }]);
    return fallback;
  } catch (err) {
    console.error("[claude] Request failed:", err);
    return "Sorry, I'm having a little trouble right now! Please try again in a moment, or an admin will follow up with you shortly.";
  }
}

// Remove markdown that Messenger would show as raw symbols, and any leftover placeholders.
function cleanForMessenger(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,!?:;]|$)/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\*\s+/gm, "- ")
    .replace(/\[TODO[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------
// Admin alerts via ntfy.sh (free phone push notifications with sound).
// ---------------------------------------------------------------------
async function notifyAdmin({ title, message, tags }) {
  console.log(`[admin-alert] ${title}\n${message}`);
  if (!ADMIN_NTFY_TOPIC) return;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(ADMIN_NTFY_TOPIC)}`, {
      method: "POST",
      headers: {
        Title: encodeHeader(title),
        Priority: "high", // high = plays a sound / vibrates on the phone
        Tags: tags || "bell",
        Click: "https://business.facebook.com/latest/inbox/all"
      },
      body: message
    });
    if (!res.ok) console.error("[admin-alert] ntfy error:", res.status, await res.text());
  } catch (err) {
    console.error("[admin-alert] Failed:", err);
  }
}

// HTTP headers can't hold emoji/peso signs directly; ntfy accepts RFC 2047 encoding.
function encodeHeader(s) {
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// Best-effort customer name lookup for admin alerts.
const nameCache = new Map();
async function getCustomerName(psid) {
  if (nameCache.has(psid)) return nameCache.get(psid);
  if (isWa(psid)) {
    let name = `WhatsApp +${psid.slice(2)}`;
    try {
      const v = UPSTASH_URL && UPSTASH_TOKEN ? await redis(["GET", `wa:name:${psid}`]) : null;
      if (v) name = `${v} (+${psid.slice(2)})`;
    } catch (_) { /* ignore */ }
    nameCache.set(psid, name);
    return name;
  }
  let name = `Messenger user ${psid}`;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`);
    if (res.ok) {
      const d = await res.json();
      const full = [d.first_name, d.last_name].filter(Boolean).join(" ");
      if (full) name = full;
    }
  } catch (_) { /* ignore */ }
  nameCache.set(psid, name);
  return name;
}

// ---------------------------------------------------------------------
// Facebook Send API helpers.
// ---------------------------------------------------------------------
// Every message the bot sends is tagged with this, and Facebook echoes the tag
// back -- that's how the bot tells its own messages apart from an admin's.
const BOT_METADATA = "3ukph-bot";

async function callSendApi(payload) {
  if (payload.message) payload.message.metadata = BOT_METADATA;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[send] Facebook Send API error:", res.status, JSON.stringify(data));
      return null;
    }
    rememberSentId(data.message_id);
    return data;
  } catch (err) {
    console.error("[send] Request failed:", err);
    return null;
  }
}

// Messenger allows max 2000 characters per message, so long replies are split.
async function sendText(recipientId, text) {
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf("\n", 1900);
    if (cut < 500) cut = 1900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  for (const chunk of chunks) {
    if (isWa(recipientId)) {
      const ok = await waSend(recipientId, { type: "text", text: { body: chunk, preview_url: false } });
      if (ok) recordChat(recipientId, true, chunk, "bot");
      continue;
    }
    const sent = await callSendApi({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: chunk } });
    if (sent) recordChat(recipientId, true, chunk, "bot");
  }
}

async function sendImage(recipientId, url) {
  if (isWa(recipientId)) {
    const ok = await waSend(recipientId, { type: "image", image: { link: url } });
    if (ok) recordChat(recipientId, true, "(image)", "bot", { media: { src: "url", url } });
    return !!ok;
  }
  const data = await callSendApi({
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { attachment: { type: "image", payload: { url, is_reusable: true } } }
  });
  if (data) recordChat(recipientId, true, "(image)", "bot", { media: { src: "url", url } });
  return !!data;
}

async function sendTyping(recipientId) {
  if (isWa(recipientId)) return; // WhatsApp: the typing indicator is sent with the read receipt
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: "typing_on" })
    });
  } catch (_) { /* not important */ }
}

// ---------------------------------------------------------------------
// WhatsApp Cloud API: same AI assistant, prices, reseller program and
// alerts as Messenger. Webhook: <PUBLIC_URL>/whatsapp/webhook
// ---------------------------------------------------------------------
async function waSend(recipientId, message) {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) { console.error("[whatsapp] WA_TOKEN / WA_PHONE_NUMBER_ID not set."); return null; }
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: String(recipientId).slice(2), ...message })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("[whatsapp] send error:", res.status, JSON.stringify(data)); return null; }
    return data;
  } catch (err) { console.error("[whatsapp] send failed:", err.message); return null; }
}

async function waMarkReadTyping(messageId) {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID || !messageId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } })
    });
  } catch (_) { /* not important */ }
}

app.get("/whatsapp/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && WA_VERIFY_TOKEN && req.query["hub.verify_token"] === WA_VERIFY_TOKEN) {
    console.log("[whatsapp] Webhook verified.");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  console.warn("[whatsapp] Webhook verification failed -- token mismatch.");
  res.sendStatus(403);
});

const waSeen = new Set(); // WhatsApp may deliver the same message twice
app.post("/whatsapp/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body || {};
  if (body.object !== "whatsapp_business_account") return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = {};
      (v.contacts || []).forEach((c) => { if (c.wa_id && c.profile && c.profile.name) names[c.wa_id] = c.profile.name; });
      for (const m of v.messages || []) {
        if (!m.id || waSeen.has(m.id)) continue;
        waSeen.add(m.id); if (waSeen.size > 2000) waSeen.delete(waSeen.values().next().value);
        try { await handleWhatsAppMessage(m, names[m.from]); } catch (err) { console.error("[whatsapp] Error handling message:", err); }
      }
    }
  }
});

async function handleWhatsAppMessage(m, profileName) {
  const senderId = "wa" + String(m.from || "").replace(/\D/g, "");
  if (senderId === "wa") return;
  if (profileName) {
    nameCache.set(senderId, `${profileName} (+${senderId.slice(2)})`);
    if (UPSTASH_URL && UPSTASH_TOKEN) redis(["SET", `wa:name:${senderId}`, profileName.slice(0, 80)]).catch(() => {});
  }
  let text = "";
  if (m.type === "text") text = m.text && m.text.body;
  else if (m.type === "button") text = m.button && m.button.text;
  else if (m.type === "interactive") {
    const i = m.interactive || {};
    text = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || "";
  }
  const isImage = m.type === "image" || (m.type === "document" && /image|pdf/i.test((m.document && m.document.mime_type) || ""));

  const waMedia = (m.image && m.image.id) ? { src: "wa", id: m.image.id, mime: m.image.mime_type || "image" }
    : (m.document && m.document.id) ? { src: "wa", id: m.document.id, mime: m.document.mime_type || "document" } : null;
  recordChat(senderId, false, text || (isImage ? "(image)" : `(${m.type})`) + (m.image && m.image.caption ? " " + m.image.caption : ""), "customer", waMedia ? { media: waMedia } : undefined);
  if (isPaused(senderId)) return;

  if (!text) {
    if (isImage) {
      const customer = await getCustomerName(senderId);
      await notifyAdmin({
        title: "Payment screenshot received (WhatsApp)",
        message: `Customer: ${customer} sent an image (likely proof of payment). Please verify it and send the eSIM QR on WhatsApp.`,
        tags: "receipt"
      });
      await sendText(senderId, "Thank you! We received your screenshot. Our team is verifying your payment now, and your eSIM QR code will be sent within 5 minutes once it's confirmed.");
      appendNote(senderId, "[Customer sent an image, probably a payment screenshot. The admin was alerted.]");
    } else {
      await sendText(senderId, "Thanks for your message! Could you type your question in words? That helps me answer accurately. 😊");
    }
    return;
  }

  await waMarkReadTyping(m.id);
  const reply = await getClaudeReply(senderId, text);
  if (reply) await sendText(senderId, reply);
}

// One-time: register the WhatsApp number with a 6-digit two-step verification PIN you choose.
// Open https://3ukph.com/admin/whatsapp-register?key=YOUR_ADMIN_KEY&pin=123456
app.get("/admin/whatsapp-register", async (req, res) => {
  if (!adminKeyOk(req.query.key)) return res.status(403).send("Wrong or missing key.");
  const pin = String(req.query.pin || "");
  if (!/^\d{6}$/.test(pin)) return res.status(400).send("Add &pin=XXXXXX (6 digits you choose, keep it safe).");
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) return res.status(400).send("Set WA_TOKEN and WA_PHONE_NUMBER_ID in Render first.");
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/register`, {
    method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin })
  });
  const d = await r.json().catch(() => ({}));
  res.type("text/plain").send(r.ok ? "WhatsApp number registered ✅" : `Not registered: ${(d.error && (d.error.error_user_msg || d.error.message)) || r.status}`);
});

// If the number still needs SMS verification:
//   1) https://3ukph.com/admin/whatsapp-request-code?key=YOUR_ADMIN_KEY      (sends an SMS code to the SIM)
//   2) https://3ukph.com/admin/whatsapp-verify-code?key=YOUR_ADMIN_KEY&code=123456
app.get("/admin/whatsapp-request-code", async (req, res) => {
  if (!adminKeyOk(req.query.key)) return res.status(403).send("Wrong or missing key.");
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) return res.status(400).send("Set WA_TOKEN and WA_PHONE_NUMBER_ID in Render first.");
  const method = String(req.query.method || "SMS").toUpperCase() === "VOICE" ? "VOICE" : "SMS";
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/request_code`, {
    method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code_method: method, language: "en_US" })
  });
  const d = await r.json().catch(() => ({}));
  res.type("text/plain").send(r.ok ? `Code sent by ${method} ✅ Now open /admin/whatsapp-verify-code?key=...&code=THE_CODE` : `Not sent: ${(d.error && (d.error.error_user_msg || d.error.message)) || r.status}`);
});
app.get("/admin/whatsapp-verify-code", async (req, res) => {
  if (!adminKeyOk(req.query.key)) return res.status(403).send("Wrong or missing key.");
  const code = String(req.query.code || "").replace(/\D/g, "");
  if (!code) return res.status(400).send("Add &code=THE_CODE from the SMS.");
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/verify_code`, {
    method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  const d = await r.json().catch(() => ({}));
  res.type("text/plain").send(r.ok ? "Number verified ✅ Now open /admin/whatsapp-register?key=...&pin=YOUR_PIN" : `Not verified: ${(d.error && (d.error.error_user_msg || d.error.message)) || r.status}`);
});

// Quick status check: https://3ukph.com/admin/whatsapp-status?key=YOUR_ADMIN_KEY
app.get("/admin/whatsapp-status", async (req, res) => {
  if (!adminKeyOk(req.query.key)) return res.status(403).send("Wrong or missing key.");
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) return res.type("text/plain").send("WhatsApp is OFF: set WA_TOKEN and WA_PHONE_NUMBER_ID in Render.");
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type`, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  const d = await r.json().catch(() => ({}));
  res.type("text/plain").send(r.ok ? `WhatsApp is ON ✅\nNumber: ${d.display_phone_number}\nName: ${d.verified_name} (${d.name_status})\nSMS verification: ${d.code_verification_status || "?"}\nStatus: ${d.status || "?"} (${d.platform_type || "?"})\nQuality: ${d.quality_rating || "?"}` : `Token or ID problem: ${(d.error && d.error.message) || r.status}`);
});

startPriceSync();

app.listen(PORT, () => {
  console.log(`3UKPH Messenger bot listening on port ${PORT}`);
});
