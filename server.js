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
const { searchPlans, getPlan, listAllDestinations, USD_TO_PHP } = require("./planSearch");

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

console.log(`[startup] Loaded pricing catalog covering ${listAllDestinations().length} destinations. Rate: 1 USD = ${USD_TO_PHP} PHP.`);

// ---------------------------------------------------------------------
// Payment QR codes. Put the image files in public/qr/ named after the
// payment method (e.g. public/qr/gcash.png). They're served publicly at
// <PUBLIC_URL>/qr/<file> so Messenger can send them as images.
// ---------------------------------------------------------------------
app.use("/qr", express.static(path.join(__dirname, "public", "qr")));

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
      properties: { planId: { type: "string", description: "The planId from a search result, e.g. 'P6413'." } },
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
      return plan ? plan : { error: "No plan with that planId. Search again." };
    }

    case "create_order": {
      const plan = getPlan(input.planId);
      if (!plan) return { error: "No plan with that planId. Search again and confirm the plan with the customer." };
      const methodKey = normalizePaymentMethod(input.paymentMethod);
      if (!methodKey) return { error: "Unknown payment method. Accepted: GCash, Maya, MariBank, UnionBank, BPI." };
      const email = String(input.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email looks invalid. Ask the customer to re-type it." };

      const methodName = PAYMENT_METHODS[methodKey];
      const qrFile = findQrFile(methodKey);
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
          `Price: ${plan.price}\n` +
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
        paymentMethod: methodName,
        paymentQrSentToCustomer: qrSent,
        instructionsForYou: qrSent
          ? `The ${methodName} payment QR image was just sent to the customer. Tell them to pay exactly ${plan.price} using it and send a screenshot of the payment here. Their eSIM QR code arrives within 5 minutes after the payment is confirmed.`
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
app.get("/", (req, res) => {
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

app.listen(PORT, () => {
  console.log(`3UKPH Messenger bot listening on port ${PORT}`);
});
