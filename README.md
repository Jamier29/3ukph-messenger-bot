# 3UKPH Messenger Bot — Setup Guide

This connects your 3UK Philippines Facebook Page to an AI assistant that
replies to customer messages automatically, using Claude for
context-aware answers — including real, current pricing looked up from
your actual reseller catalog, not guessed or memorized.

**What's already loaded:** your reseller pricing spreadsheet has been
converted into `data/plans.json` — 6,493 plans across 223 destinations
(individual countries, regional bundles like Europe/Asia/Africa, and
global bundles). The bot looks up real prices from this file on demand
for every pricing question, instead of the raw catalog being crammed
into every message (which would be far too much data to send each time).

Do the steps below roughly in order. None of them require coding —
just filling in dashboards.

---

## 1. Fill in your remaining business details

Open `business-info.js` and replace the remaining `[TODO: ...]` spots —
your landing page URL, payment methods, delivery process, and how you
want PHP conversion handled. Pricing itself is already wired up; this
file now only needs policy/process details.

---

## 2. Get an Anthropic API key (this is separate from your claude.ai login)

1. Go to https://console.anthropic.com and sign in or create an account.
2. Add a small amount of billing credit (this is pay-as-you-go, and a
   Messenger FAQ bot is inexpensive — typically a fraction of a cent
   per reply on the default model).
3. Go to **API Keys** → **Create Key**. Copy it somewhere safe — you
   won't be able to see it again after leaving the page.

---

## 3. Create a Meta App and connect it to your Page

1. Go to https://developers.facebook.com/apps and log in with the
   account that manages your 3UK Philippines Page.
2. Click **Create App** → choose **Other** → **Business** as the type.
3. Once created, on the app dashboard, find **Messenger** and click
   **Set up**.
4. Under **Messenger → Settings → Access Tokens**, select your 3UK
   Philippines Page and generate a **Page Access Token**. Copy it.

Keep this tab open — you'll come back to the **Webhooks** section in
Step 5, after your server is deployed and has a real URL.

---

## 4. Deploy the server to Render (runs 24/7, doesn't need your laptop on)

1. Go to https://render.com and sign up (free tier works to start).
2. Create a new **GitHub repository** and push this folder's contents
   to it (or use Render's "Deploy from a public Git repository" if
   you'd rather not use GitHub — ask me if you want help with this
   step specifically).
3. In Render, click **New +** → **Web Service**, connect your repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment Variables**, add:
   - `VERIFY_TOKEN` — make up any random string (write it down, you'll
     need it again in Step 5)
   - `PAGE_ACCESS_TOKEN` — from Step 3
   - `ANTHROPIC_API_KEY` — from Step 2
6. Click **Create Web Service**. Wait for it to deploy — Render gives
   you a URL like `https://your-app-name.onrender.com`.
7. Visit that URL in your browser — you should see
   "3UKPH Messenger bot is running." If you see that, it's working.

**Note on the free tier:** Render's free tier "sleeps" after 15 minutes
of no traffic, so the very first message after a quiet period can take
10-20 seconds to get a reply while it wakes up. This is fine for
testing; if that delay matters once you're live, Render's cheapest
paid tier (~$7/month) keeps it always-on.

---

## 5. Connect the webhook in Meta

1. Back in your Meta App dashboard, go to **Messenger → Settings → Webhooks**.
2. Click **Add Callback URL**.
   - **Callback URL:** `https://your-app-name.onrender.com/webhook`
   - **Verify Token:** the exact same random string you set as
     `VERIFY_TOKEN` in Render.
3. Click **Verify and Save** — if it succeeds, your server and
   Facebook are now talking to each other.
4. Still on that page, under **Webhook Fields**, subscribe your Page
   to at least: `messages`.

---

## 6. Test it

Send your 3UK Philippines Page a message from a personal account (not
the page itself) and see if you get a reply. Try a few different
questions to see how it handles them.

---

## Ongoing: updating what the bot knows

Whenever your policies change, edit `business-info.js`, then redeploy
(push the change to your GitHub repo — Render redeploys automatically).

**When your pricing spreadsheet updates:** send me the new version and
I'll regenerate `data/plans.json` from it — the bot will then be
quoting the new prices as soon as you redeploy. No other code changes
needed either way.
