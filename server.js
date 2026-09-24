// server.js
//
// Messenger webhook bot for the 3UK Philippines Facebook page.
// Flow: Facebook sends an incoming message -> Claude answers using
// business-info.js for policy/FAQ context, and can call the
// search_esim_plans tool to look up real, current prices from the
// reseller catalog (data/plans.json, 6,493 plans) on demand -> the
// final reply is sent back via Facebook's Send API.

require("dotenv").config();
const express = require("express");
const { BUSINESS_INFO } = require("./business-info");
const { searchPlans, listAllDestinations } = require("./planSearch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Haiku is fast and inexpensive, which fits a high-volume FAQ-style bot well.
// Swap to "claude-sonnet-5" for more nuanced replies at a higher per-message cost.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 3; // safety cap so a confused loop can't run forever

if (!VERIFY_TOKEN || !PAGE_ACCESS_TOKEN || !ANTHROPIC_API_KEY) {
  console.warn(
    "[startup] Missing one or more required environment variables: " +
    "VERIFY_TOKEN, PAGE_ACCESS_TOKEN, ANTHROPIC_API_KEY. " +
    "The server will start, but the bot will not work until these are set."
  );
}

console.log(`[startup] Loaded pricing catalog covering ${listAllDestinations().length} destinations.`);

// ---------------------------------------------------------------------
// Tool definition Claude uses to look up real, current pricing instead
// of guessing. See planSearch.js for the actual lookup logic.
// ---------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_esim_plans",
    description:
      "Look up real, current eSIM plans and prices for a destination (a country, a region like " +
      "'Europe' or 'Africa', or 'global' for worldwide plans). Always use this instead of guessing " +
      "or recalling a price from memory — prices change and must come from this tool. Returns plans " +
      "sorted from smallest to largest data amount.",
    input_schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "The country, region, or 'global' the customer is asking about, e.g. 'United Kingdom', 'UK', 'Japan', 'Europe'."
        }
      },
      required: ["destination"]
    }
  }
];

function runTool(name, input) {
  if (name === "search_esim_plans") {
    return searchPlans({ destination: input.destination });
  }
  return { error: "Unknown tool: " + name };
}

// ---------------------------------------------------------------------
// Very small in-memory conversation memory, per Messenger user, so the
// bot has short-term context within a conversation. Resets on server
// restart and is capped in size — this is intentionally lightweight,
// not a database.
// ---------------------------------------------------------------------
const MAX_HISTORY_PER_USER = 10; // messages (user+assistant combined)
const MAX_USERS_TRACKED = 500; // simple cap so memory can't grow unbounded
const conversations = new Map(); // senderId -> [{role, content}, ...]

function getHistory(senderId) {
  return conversations.get(senderId) || [];
}

function appendHistory(senderId, role, content) {
  if (!conversations.has(senderId)) {
    if (conversations.size >= MAX_USERS_TRACKED) {
      // Drop the oldest tracked conversation to make room.
      const oldestKey = conversations.keys().next().value;
      conversations.delete(oldestKey);
    }
    conversations.set(senderId, []);
  }
  const hist = conversations.get(senderId);
  hist.push({ role, content });
  while (hist.length > MAX_HISTORY_PER_USER) hist.shift();
}

// ---------------------------------------------------------------------
// Health check — also handy for confirming the Render deployment is up.
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`3UKPH Messenger bot is running. Catalog: ${listAllDestinations().length} destinations loaded.`);
});

// ---------------------------------------------------------------------
// Facebook webhook verification (GET). Facebook calls this once when you
// set up the webhook in the Meta App dashboard, to confirm you control
// this server. Must echo back the hub.challenge value if the verify
// token matches.
// ---------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] Verified successfully.");
    res.status(200).send(challenge);
  } else {
    console.warn("[webhook] Verification failed — token mismatch.");
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------------
// Incoming messages (POST). Facebook sends every new message here.
// ---------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Always respond 200 quickly so Facebook doesn't retry/backlog — the
  // actual reply is sent separately via the Send API below.
  res.status(200).send("EVENT_RECEIVED");

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
  const senderId = event.sender && event.sender.id;
  if (!senderId) return;

  // Ignore echoes of our own sent messages, and events with no text
  // (e.g. delivery/read receipts, stickers, attachments-only messages).
  if (event.message && event.message.is_echo) return;
  const text = event.message && event.message.text;
  if (!text) {
    if (event.message) {
      await sendMessage(senderId, "Thanks for your message! Could you type your question in words? That helps me answer accurately. 😊");
    }
    return;
  }

  appendHistory(senderId, "user", text);
  const reply = await getClaudeReply(senderId);
  appendHistory(senderId, "assistant", reply);
  await sendMessage(senderId, reply);
}

// ---------------------------------------------------------------------
// Ask Claude for a reply, given the business info, this user's recent
// conversation history, and access to the plan-search tool. Runs a
// short tool-use loop: Claude may call search_esim_plans one or more
// times before giving its final text answer.
// ---------------------------------------------------------------------
async function getClaudeReply(senderId) {
  const systemPrompt =
    "You are the AI assistant for 3UK Philippines, an eSIM reselling business, replying to customers " +
    "on Facebook Messenger. Use the business information below for policies and general questions. " +
    "For any plan availability or pricing question, ALWAYS use the search_esim_plans tool rather than " +
    "guessing or recalling a price — the catalog changes and only the tool has current data. If a " +
    "destination isn't found, say so plainly rather than inventing a plan. If something falls under a " +
    "'hand off to a human' case per the info below, say a team member will follow up shortly instead " +
    "of guessing.\n\n" + BUSINESS_INFO;

  const messages = getHistory(senderId).slice(); // working copy for this exchange, tool turns appended locally

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
          max_tokens: 500,
          system: systemPrompt,
          tools: TOOLS,
          messages: messages
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("[claude] API error:", res.status, errText);
        return "Sorry, I'm having a little trouble right now! Please give us a moment and try again, or a team member will follow up with you shortly.";
      }

      const data = await res.json();

      if (data.stop_reason === "tool_use") {
        // Claude wants to call one or more tools before finishing its reply.
        messages.push({ role: "assistant", content: data.content });

        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== "tool_use") continue;
          let result;
          try {
            result = runTool(block.name, block.input);
          } catch (err) {
            result = { error: "Tool execution failed: " + err.message };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
        messages.push({ role: "user", content: toolResults });
        continue; // ask Claude again, now with the tool result available
      }

      // Not a tool call — this is the final answer.
      const textBlock = (data.content || []).find((b) => b.type === "text");
      return (textBlock && textBlock.text) || "Sorry, could you rephrase that? I want to make sure I answer correctly.";
    }

    // Exceeded MAX_TOOL_ROUNDS without a final answer — fail gracefully.
    console.warn("[claude] Exceeded max tool-use rounds for sender", senderId);
    return "Sorry, that one's tricky — let me have a team member follow up with you on this.";
  } catch (err) {
    console.error("[claude] Request failed:", err);
    return "Sorry, I'm having a little trouble right now! Please give us a moment and try again, or a team member will follow up with you shortly.";
  }
}

// ---------------------------------------------------------------------
// Send a reply back to the user via Facebook's Send API.
// ---------------------------------------------------------------------
async function sendMessage(recipientId, text) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: text }
        })
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("[send] Facebook Send API error:", res.status, errText);
    }
  } catch (err) {
    console.error("[send] Request failed:", err);
  }
}

app.listen(PORT, () => {
  console.log(`3UKPH Messenger bot listening on port ${PORT}`);
});
