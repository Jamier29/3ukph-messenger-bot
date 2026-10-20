// marketingKit.js
//
// Reseller Marketing Kit: ready-to-post social media posts for approved resellers.
//
// - The admin clicks "Generate" in the console: we pick an image from the kit
//   library (our own post images, plus any the admin uploads later) and Claude
//   writes a caption with real retail prices.
// - Every reseller gets the post PERSONALISED: a footer band under the image and a
//   line in the caption with THEIR name and contact, so buyers inquire with them.
// - Each reseller has a private kit page: https://3ukph.com/kit/<token>
//
// Nothing here spends money: images are our own, captions cost a few centavos.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let redis = null;           // async (cmd[]) => result, or null when Upstash isn't set
let callClaude = null;      // async (system, user, maxTokens) => text
let findPlans = null;       // planSearch.findPlansByText
let renderer = null;        // lazily loaded @resvg/resvg-js
const mem = { posts: [], lib: [], tokens: new Map(), psidTokens: new Map(), libImgs: new Map() };

const SOCIAL_DIR = path.join(__dirname, "social");
const FONT_FILES = ["Montserrat_800ExtraBold.ttf", "Montserrat_600SemiBold.ttf"].map((f) => path.join(__dirname, "assets", "fonts", f));
const CONTACT_TOKEN = "{RESELLER}";

// Built-in images: our own posts that don't advertise a discount code or our own
// chat line, so inquiries go to the reseller. Topic + price lookups guide Claude.
const BUILT_IN = [
  { file: "nov-post13-data-tips.jpg", topic: "5 tips to save mobile data abroad", prices: ["Asia 10GB", "Europe 10GB", "Japan 10GB"] },
  { file: "nov-post15-sign-on.jpg", topic: "Seafarers signing on: global and regional data plans for every route", prices: ["Global Lite 10GB", "Europe 20GB", "Asia 10GB"] },
  { file: "nov-post16-legit.jpg", topic: "Trust: 3UK Philippines is a DTI and BIR registered eSIM provider with 24/7 support", prices: ["Europe 20GB", "Japan 10GB"] },
  { file: "nov-post18-unlocked.jpg", topic: "Is your phone unlocked? eSIM needs an unlocked, eSIM-compatible phone", prices: ["Japan 5GB", "Asia 5GB"] },
  { file: "nov-post20-gift.jpg", topic: "An eSIM as a Christmas gift for family and friends traveling abroad", prices: ["Japan 10GB", "Europe 20GB", "United States 10GB"] },
  { file: "nov-post22-pasko-barko.jpg", topic: "Christmas on board: seafarers can video call family when the ship is in port", prices: ["Global Lite 10GB", "Europe 20GB", "Asia 10GB"] },
  { file: "nov-post23-saan-pasko.jpg", topic: "Where will you spend Christmas abroad? Ask followers to comment their destination", prices: ["Japan 10GB", "South Korea 10GB", "United States 10GB", "Europe 20GB"] },
  { file: "oct-post1-dual-sim.jpg", topic: "Keep your PH SIM for OTPs and use the eSIM for data abroad (dual SIM)", prices: ["Japan 5GB", "Asia 10GB"] },
  { file: "oct-post10-esim-myths.jpg", topic: "eSIM myths vs facts", prices: ["Asia 10GB", "Europe 10GB"] },
  { file: "oct-post3-crew-bulk.jpg", topic: "Bulk eSIMs for a whole crew team or manning agency", prices: ["Global Lite 10GB", "Europe 20GB"] },
  { file: "oct-post4-roaming-vs-esim.jpg", topic: "Roaming vs eSIM: fixed price, no surprise bills", prices: ["Europe 20GB", "Europe 10GB"] },
  { file: "oct-post5-sea-trip.jpg", topic: "Southeast Asia trip: Thailand, Vietnam, Singapore with one eSIM", prices: ["Asia 10GB", "Thailand 10GB", "Singapore 10GB"] },
  { file: "oct-post6-travel-checklist.jpg", topic: "Travel checklist: don't forget your eSIM before leaving", prices: ["Japan 10GB", "Asia 10GB", "Europe 20GB"] },
  { file: "oct-post8-ofw.jpg", topic: "OFWs: have data right away, no hunting for airport Wi-Fi", prices: ["Saudi Arabia 10GB", "United Arab Emirates 10GB", "Middle East 10GB"] },
  { file: "oct-post9-reload-contract.jpg", topic: "Seafarers can reload while on contract, in ports and coastal areas", prices: ["Global Lite 10GB", "Asia 10GB"] },
  { file: "post2-seafarers.jpg", topic: "eSIM for seafarers: data in every port, connected with family", prices: ["Global Lite 10GB", "Europe 20GB", "Asia 10GB"] },
  { file: "post5-compatible.jpg", topic: "Is your phone eSIM-compatible? Dial *#06# and look for EID", prices: ["Japan 5GB", "Asia 5GB"] },
  { file: "post8-seafarer-family.jpg", topic: "Family buys the eSIM, the seafarer stays connected", prices: ["Global Lite 10GB", "Europe 20GB"] },
  { file: "post9-install.jpg", topic: "How to install an eSIM in 3 easy steps (Settings > Add eSIM > scan QR)", prices: ["Japan 10GB", "Europe 20GB"] }
].map((b) => ({ id: "b:" + b.file, ...b }));

function init(opts) {
  redis = opts.redis || null;
  callClaude = opts.callClaude;
  findPlans = opts.findPlans;
}
const db = async (cmd) => (redis ? redis(cmd) : null);

// ---------------------------------------------------------------- library
async function loadLibrary() {
  if (!redis) return mem.lib;
  const v = await db(["GET", "kit:lib"]).catch(() => null);
  try { return v ? JSON.parse(v) : []; } catch { return []; }
}
async function saveLibrary(list) {
  mem.lib = list;
  if (redis) await db(["SET", "kit:lib", JSON.stringify(list)]);
}
async function libraryItems() {
  const uploaded = await loadLibrary();
  return [...uploaded.map((u) => ({ ...u, uploaded: true })), ...BUILT_IN];
}
// Adds an image the admin uploaded (already resized to JPEG in the browser).
async function addLibraryImage(buf, topic) {
  if (!buf || buf.length < 1000) throw new Error("Image looks empty.");
  if (buf.length > 900 * 1024) throw new Error("Image is too big (max ~900 KB). The console resizes it; try again.");
  const id = "u:" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  mem.libImgs.set(id, buf);
  if (redis) await db(["SET", `kit:img:${id}`, buf.toString("base64")]);
  const list = await loadLibrary();
  list.unshift({ id, topic: String(topic || "").slice(0, 200) || "General eSIM promo for travelers and seafarers", prices: [], addedAt: new Date().toISOString() });
  await saveLibrary(list.slice(0, 200));
  return id;
}
async function removeLibraryImage(id) {
  const list = (await loadLibrary()).filter((x) => x.id !== id);
  await saveLibrary(list);
  mem.libImgs.delete(id);
  if (redis) await db(["DEL", `kit:img:${id}`]).catch(() => {});
}
async function imageBuffer(item) {
  if (item.file) return fs.promises.readFile(path.join(SOCIAL_DIR, item.file));
  if (mem.libImgs.has(item.id)) return mem.libImgs.get(item.id);
  const b64 = redis ? await db(["GET", `kit:img:${item.id}`]).catch(() => null) : null;
  if (!b64) throw new Error("Image not found in the kit library.");
  const buf = Buffer.from(b64, "base64");
  mem.libImgs.set(item.id, buf);
  return buf;
}

// ---------------------------------------------------------------- posts
async function listPosts() {
  if (!redis) return mem.posts;
  const v = await db(["GET", "kit:posts"]).catch(() => null);
  try { return v ? JSON.parse(v) : []; } catch { return []; }
}
async function savePosts(list) {
  mem.posts = list.slice(0, 40);
  if (redis) await db(["SET", "kit:posts", JSON.stringify(mem.posts)]);
}
async function getPost(id) { return (await listPosts()).find((p) => p.id === id) || null; }
async function deletePost(id) { await savePosts((await listPosts()).filter((p) => p.id !== id)); }

function priceLines(queries) {
  const out = [];
  for (const q of queries || []) {
    const list = (findPlans && findPlans(q, 40)) || [];
    const pick = list.find((p) => p.validityDays === 30 && !p.unlimitedData) || list.find((p) => !p.unlimitedData);
    if (pick) out.push(`${pick.destination}: ${pick.data} for ${pick.validityDays} days = ${pick.price}`);
  }
  return out;
}

// Picks an image (prefers ones not used recently) and asks Claude for a caption.
async function generatePost({ language, imageId } = {}) {
  if (!callClaude) throw new Error("Claude isn't configured.");
  const lib = await libraryItems();
  const posts = await listPosts();
  let item = imageId ? lib.find((x) => x.id === imageId) : null;
  if (!item) {
    const recent = new Set(posts.slice(0, Math.min(10, lib.length - 1)).map((p) => p.imageId));
    const pool = lib.filter((x) => !recent.has(x.id));
    item = (pool.length ? pool : lib)[Math.floor(Math.random() * (pool.length ? pool.length : lib.length))];
  }
  const lang = language === "english" ? "english" : "taglish";
  const prices = priceLines(item.prices && item.prices.length ? item.prices : ["Japan 10GB", "Europe 20GB", "Asia 10GB"]);
  const system =
    "You write social media captions (Facebook, Instagram, TikTok) for independent resellers of 3UK Philippines travel eSIMs. " +
    "3UK Philippines is a DTI and BIR registered eSIM provider in the Philippines; eSIMs work in 190+ countries, the QR code arrives within minutes, " +
    "and seafarers get data in ports and near the coast (never claim coverage in the open sea). " +
    "Rules: write as the reseller (\"I\"/\"we\" is fine), friendly and energetic, short paragraphs, a few emojis but NO flag emojis. " +
    "Use only the prices given, written exactly as given, and say \"from\" or \"as low as\". Never mention discount codes, 3ukph.com/chat, or a WhatsApp number of 3UK. " +
    `Include exactly one line with the placeholder ${CONTACT_TOKEN} where the reseller's name and contact go, e.g. "📲 Order / inquire: ${CONTACT_TOKEN}". ` +
    "End with 6 to 10 relevant hashtags including #3UKPH and #eSIM. Keep it under 900 characters. Output ONLY the caption text.";
  const user =
    `Image theme: ${item.topic}\n` +
    `Language: ${lang === "english" ? "English" : "Taglish (natural mix of Filipino and English, like Filipino social media posts)"}\n` +
    `Real retail prices you may use (pick 1 to 3 that fit the theme):\n${prices.length ? prices.map((p) => "- " + p).join("\n") : "- (no prices: don't mention prices)"}`;
  let caption = await callClaude(system, user, 700);
  caption = String(caption || "").trim();
  if (!caption.includes(CONTACT_TOKEN)) caption += `\n\n📲 Order / inquire: ${CONTACT_TOKEN}`;
  const post = { id: Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), imageId: item.id, topic: item.topic, language: lang, caption, createdAt: new Date().toISOString(), sentAt: null };
  posts.unshift(post);
  await savePosts(posts);
  return post;
}

// ---------------------------------------------------------------- personalisation
function resellerLabel(member, psid) {
  const name = String((member && member.name) || "").trim() || "Your 3UK reseller";
  let contact = String((member && member.contact) || "").trim();
  if (!contact && /^wa\d+$/.test(String(psid || ""))) contact = "+" + String(psid).slice(2);
  return { name, contact };
}
function personalCaption(post, member, psid) {
  const { name, contact } = resellerLabel(member, psid);
  return post.caption.split(CONTACT_TOKEN).join(contact ? `${name} · ${contact}` : name);
}

const renderCache = new Map();
function xmlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fit(s, max) { s = String(s || ""); return s.length > max ? s.slice(0, max - 1) + "…" : s; }
function jpegSize(buf) {
  // Reads width/height from a JPEG's SOF marker.
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 1080, h: 1350 };
}
// Returns a JPEG of the post image with a footer band carrying the reseller's name and contact.
async function personalImage(post, member, psid) {
  const { name, contact } = resellerLabel(member, psid);
  const key = `${post.imageId}|${name}|${contact}`;
  if (renderCache.has(key)) return renderCache.get(key);
  const lib = await libraryItems();
  const item = lib.find((x) => x.id === post.imageId);
  if (!item) throw new Error("This post's image was removed from the library.");
  const src = await imageBuffer(item);
  const { w, h } = jpegSize(src);
  const band = Math.round(w * 0.16);
  const s = w / 1122;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + band}" viewBox="0 0 ${w} ${h + band}">` +
    `<image href="data:image/jpeg;base64,${src.toString("base64")}" x="0" y="0" width="${w}" height="${h}"/>` +
    `<rect x="0" y="${h}" width="${w}" height="${band}" fill="#00166a"/>` +
    `<rect x="0" y="${h}" width="${w}" height="${Math.round(8 * s)}" fill="#f8c830"/>` +
    `<text x="${Math.round(48 * s)}" y="${h + Math.round(52 * s)}" font-family="Montserrat" font-weight="600" font-size="${Math.round(24 * s)}" letter-spacing="${(3 * s).toFixed(1)}" fill="#f8c830">ORDER / INQUIRE WITH</text>` +
    `<text x="${Math.round(48 * s)}" y="${h + Math.round(106 * s)}" font-family="Montserrat" font-weight="800" font-size="${Math.round(46 * s)}" fill="#ffffff">${xmlEsc(fit(name, 30))}</text>` +
    (contact ? `<text x="${Math.round(48 * s)}" y="${h + Math.round(152 * s)}" font-family="Montserrat" font-weight="600" font-size="${Math.round(32 * s)}" fill="#d6dcf5">${xmlEsc(fit(contact, 44))}</text>` : "") +
    `<text x="${w - Math.round(48 * s)}" y="${h + Math.round(152 * s)}" text-anchor="end" font-family="Montserrat" font-weight="600" font-size="${Math.round(20 * s)}" fill="#aab4e0">Authorized 3UK Philippines reseller</text>` +
    `</svg>`;
  if (!renderer) renderer = require("@resvg/resvg-js");
  const png = new renderer.Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Montserrat" } }).render().asPng();
  const { PNG } = require("pngjs");
  const img = PNG.sync.read(png);
  const jpeg = require("jpeg-js").encode({ data: img.data, width: img.width, height: img.height }, 86).data;
  renderCache.set(key, jpeg);
  while (renderCache.size > 80) renderCache.delete(renderCache.keys().next().value);
  return jpeg;
}

// ---------------------------------------------------------------- reseller tokens
async function tokenFor(psid) {
  if (mem.psidTokens.has(psid)) return mem.psidTokens.get(psid);
  let t = redis ? await db(["GET", `kit:psid:${psid}`]).catch(() => null) : null;
  if (!t) {
    t = crypto.randomBytes(6).toString("base64url");
    if (redis) { await db(["SET", `kit:token:${t}`, psid]); await db(["SET", `kit:psid:${psid}`, t]); }
  }
  mem.psidTokens.set(psid, t); mem.tokens.set(t, psid);
  return t;
}
async function psidForToken(t) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(String(t || ""))) return null;
  if (mem.tokens.has(t)) return mem.tokens.get(t);
  const p = redis ? await db(["GET", `kit:token:${t}`]).catch(() => null) : null;
  if (p) { mem.tokens.set(t, p); mem.psidTokens.set(p, t); }
  return p || null;
}
async function markSent(id) {
  const posts = await listPosts();
  const p = posts.find((x) => x.id === id);
  if (p) { p.sentAt = new Date().toISOString(); await savePosts(posts); }
}

module.exports = { init, generatePost, listPosts, getPost, deletePost, markSent, libraryItems, addLibraryImage, removeLibraryImage, imageBuffer, personalCaption, personalImage, tokenFor, psidForToken, resellerLabel, CONTACT_TOKEN };
