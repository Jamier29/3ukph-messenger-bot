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
const { searchPlans, getPlan, listAllDestinations, getRate, headlinePrices, regionSummaries, formatPHP } = require("./planSearch");
const { startPriceSync, syncPrices, getSyncStatus } = require("./priceSync");
const crypto = require("crypto");

const app = express();
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

const PAYMENT_METHODS = {
  gcash: "GCash",
  maya: "Maya",
  maribank: "MariBank",
  unionbank: "UnionBank",
  bpi: "BPI"
};

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

function normalizePaymentMethod(input) {
  const s = String(input || "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("gcash")) return "gcash";
  if (s.includes("maya") || s.includes("paymaya")) return "maya";
  if (s.includes("mari") || s.includes("seabank")) return "maribank";
  if (s.includes("union")) return "unionbank";
  if (s.includes("bpi") || s.includes("philippineislands")) return "bpi";
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

async function redis(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Upstash HTTP ${res.status}`);
  return data.result;
}

// Startup self-test, so the Render logs show whether the discount database works.
async function checkDiscountDb() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, message: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set" };
  try {
    const pong = await redis(["PING"]);
    const keys = await redis(["KEYS", "discount:used:*"]);
    return { ok: pong === "PONG", message: `connected to ${new URL(UPSTASH_URL).hostname} (${(keys || []).length} customers have used a discount)` };
  } catch (err) {
    return { ok: false, message: `can't reach Upstash at "${UPSTASH_URL.replace(UPSTASH_TOKEN, "***")}": ${err.message}` };
  }
}
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
      "This sends the customer the payment QR code for their chosen method and alerts the admin.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string" },
        paymentMethod: { type: "string", enum: ["GCash", "Maya", "MariBank", "UnionBank", "BPI"] },
        email: { type: "string", description: "Email address where the eSIM QR code should be sent." },
        deliverVia: { type: "string", enum: ["Messenger", "Email", "Both"], description: "How the customer wants the eSIM QR code." },
        discountCode: { type: "string", description: "The discount code the customer gave, if any (only one that get_plan accepted)." },
        notes: { type: "string", description: "Anything else useful, e.g. 'eSIM is for a friend', travel dates, phone model." }
      },
      required: ["planId", "paymentMethod", "email"]
    }
  },
  {
    name: "handoff_to_human",
    description:
      "Alert the page admin to take over this chat (the admin gets a phone notification). Use when the " +
      "customer asks for a person/admin, for payment problems, refunds, complaints, reseller/bulk " +
      "inquiries, or anything you're unsure about. The bot then stays quiet in this chat for a while.",
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
    case "search_esim_plans":
      return searchPlans(input || {});

    case "get_plan": {
      const plan = getPlan(input.planId);
      if (!plan) return { error: "No plan with that planId. Search again." };
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
      if (!methodKey) return { error: "Unknown payment method. Accepted: GCash, Maya, MariBank, UnionBank, BPI." };
      const email = String(input.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email looks invalid. Ask the customer to re-type it." };

      // Discount: only one per customer, ever. Record it now (atomically) so it can't be used twice.
      let plan = applyDiscount(basePlan, input.discountCode);
      let discountNote = "";
      if (plan.discountCode) {
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
        title: `New order: ${plan.price} via ${methodName}`,
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
  '  <url><loc>https://3ukph.com/privacy</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>\n' +
  '</urlset>\n'));
app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "public", "logo.png")));
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
    if (customerId && !sentByBot) {
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
      await sendText(senderId, "Salamat! We received your screenshot. Our team is verifying your payment now, and your eSIM QR code will be sent within 5 minutes once it's confirmed.");
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
function appendNote(senderId, note) {
  const hist = getHistory(senderId).slice();
  hist.push({ role: "user", content: note });
  hist.push({ role: "assistant", content: "Noted." });
  saveHistory(senderId, hist);
}

// ---------------------------------------------------------------------
// Ask Claude for a reply, with a short tool-use loop.
// ---------------------------------------------------------------------
async function getClaudeReply(senderId, userText) {
  const systemPrompt =
    "You are the AI assistant for 3UK Philippines, an eSIM business, replying to customers on Facebook " +
    "Messenger. Follow the business information below exactly. For ANY plan or price question, use the " +
    "search_esim_plans / get_plan tools -- never guess or remember a price. If a destination isn't found, " +
    "say so plainly. Write plain text only (no asterisks or markdown).\n\n" + BUSINESS_INFO;

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
    await callSendApi({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: chunk } });
  }
}

async function sendImage(recipientId, url) {
  const data = await callSendApi({
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { attachment: { type: "image", payload: { url, is_reusable: true } } }
  });
  return !!data;
}

async function sendTyping(recipientId) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: "typing_on" })
    });
  } catch (_) { /* not important */ }
}

startPriceSync();

app.listen(PORT, () => {
  console.log(`3UKPH Messenger bot listening on port ${PORT}`);
});
