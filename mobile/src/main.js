// 3UK eSIM app: shop plans, pay with PayMongo, and see/install your eSIMs.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import qrcode from "qrcode-generator";

// Native helper (android/.../EsimPlugin.java): opens the phone's eSIM settings.
const Esim = registerPlugin("Esim", { web: { openEsimSettings: async () => ({ opened: false }) } });

const NATIVE = Capacitor.isNativePlatform();
const API = NATIVE ? "https://3ukph.com" : (new URLSearchParams(location.search).get("api") || "https://3ukph.com");
const WHATSAPP = "https://wa.me/639347069356";
const POPULAR = ["Japan", "South Korea", "China", "Hong Kong", "Taiwan", "Thailand", "Vietnam", "Singapore", "Malaysia", "Indonesia", "USA", "Europe", "Asia", "Global"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };

const state = { token: null, user: null, tab: "shop", stack: [], destinations: null, pendingPlan: null, plans: {}, usage: {}, pollUntil: 0 };

// ---------- API ----------
async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth || state.token) { if (state.token) headers.Authorization = "Bearer " + state.token; }
  let r;
  try { r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error("No internet connection. Please check your connection and try again."); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && auth) { await setSession(null, null); }
  if (!r.ok) { const e = new Error(j.message || j.error || "Something went wrong. Please try again."); e.status = r.status; throw e; }
  return j;
}
async function setSession(token, user) {
  state.token = token; state.user = user;
  if (token) await Preferences.set({ key: "session", value: JSON.stringify({ token, user }) });
  else await Preferences.remove({ key: "session" });
}

// ---------- UI helpers ----------
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function openSheet(html) { $("sheet").innerHTML = html; $("sheet").classList.remove("hidden"); $("sheetBg").classList.remove("hidden"); $("sheet").scrollTop = 0; }
function closeSheet() { $("sheet").classList.add("hidden"); $("sheetBg").classList.add("hidden"); }
$("sheetBg").onclick = closeSheet;
function setTop(title, canBack) {
  $("topTitle").textContent = title;
  $("backBtn").classList.toggle("hidden", !canBack);
  $("topLogo").classList.toggle("hidden", !!canBack);
}
const loading = () => { $("view").innerHTML = '<div class="spin"></div>'; };
function render(html) { $("view").innerHTML = html; window.scrollTo(0, 0); }
async function copy(text, label) {
  try { await Clipboard.write({ string: text }); } catch { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } }
  toast((label || "Copied") + " ✓");
}
function openExternal(url) { if (NATIVE) Browser.open({ url }); else window.open(url, "_blank"); }

// Simple navigation: tabs + a back stack of screens.
function go(screen, args, push = true) {
  if (push) state.stack.push({ screen, args });
  closeSheet();
  SCREENS[screen](args || {});
}
function back() {
  if ($("sheet").classList.contains("hidden") === false) return closeSheet();
  if (state.stack.length > 1) { state.stack.pop(); const s = state.stack[state.stack.length - 1]; SCREENS[s.screen](s.args || {}); return true; }
  return false;
}
$("backBtn").onclick = back;
function tab(name) {
  state.tab = name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  state.stack = [];
  go(name === "shop" ? "home" : name);
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));

// ---------- Shop ----------
async function loadDestinations() {
  if (!state.destinations) { try { state.destinations = await api("/api/destinations"); } catch { state.destinations = POPULAR; } }
  return state.destinations;
}
const SCREENS = {};
const ROTATE = ["Japan", "Korea", "Hong Kong", "Thailand", "Europe", "the USA", "Vietnam", "Singapore"];
SCREENS.home = async () => {
  setTop("3UK Philippines", false);
  render(`<section class="hero">
      <div class="label">Global connections. Endless possibilities.</div>
      <h1 class="display">Stay connected in <span class="destw" id="rot">Japan</span></h1>
      <p class="lede">Travel eSIMs for 200+ destinations. No roaming shock, no SIM swapping.</p>
      <div class="finder"><label class="flabel" for="q">Destination</label>
        <div class="search"><input id="q" type="search" placeholder="Where are you going?" autocomplete="off" enterkeyhint="search"></div><div id="sug"></div>
        <div class="chips" style="margin-top:14px">${POPULAR.slice(0, 8).map((d) => `<button class="chip" data-d="${esc(d)}">${esc(d)}</button>`).join("")}</div></div>
      <ul class="trust"><li>DTI &amp; BIR-registered</li><li>GCash, Maya &amp; cards</li><li>Delivered in ~5 min</li><li>Open 24/7</li></ul>
    </section>
    <div class="label" style="margin-top:6px">Popular</div><h2 class="h2">Where are you going next?</h2>
    <div class="grid" id="pop">${POPULAR.map((d) => `<button class="dest" data-d="${esc(d)}"><b>${esc(d)}</b><span data-from="${esc(d)}">&nbsp;</span></button>`).join("")}</div>
    <button class="ship" id="shipCard"><div class="label gold">⚓ By ship</div><b>Working on board or cruising?</b><span>Global Max covers 169 countries in port and near the coast.</span><span class="go">See Global plans ›</span></button>
    <div class="note">📱 <b>Does my phone support eSIM?</b> Dial <b>*#06#</b>. If you see an <b>EID</b>, it does. Your phone must also be unlocked.</div>`);
  clearInterval(state.rotT);
  let ri = 0;
  state.rotT = setInterval(() => { const el = $("rot"); if (!el) return clearInterval(state.rotT); el.classList.add("out"); setTimeout(() => { ri = (ri + 1) % ROTATE.length; el.textContent = ROTATE[ri]; el.classList.remove("out"); }, 300); }, 2600);
  document.querySelectorAll(".finder .chip").forEach((b) => (b.onclick = () => go("dest", { d: b.dataset.d })));
  $("shipCard").onclick = () => go("dest", { d: "Global" });
  document.querySelectorAll("#pop .dest").forEach((b) => (b.onclick = () => go("dest", { d: b.dataset.d })));
  const q = $("q");
  q.oninput = async () => {
    const v = q.value.trim().toLowerCase();
    if (v.length < 2) { $("sug").innerHTML = ""; return; }
    const all = await loadDestinations();
    const hits = all.filter((d) => d.toLowerCase().includes(v)).sort((a, b) => a.toLowerCase().indexOf(v) - b.toLowerCase().indexOf(v)).slice(0, 7);
    $("sug").innerHTML = hits.length ? `<div class="suggest">${hits.map((d) => `<button data-d="${esc(d)}">${esc(d)}</button>`).join("")}</div>`
      : `<div class="suggest"><button disabled>No match. Try a country name, e.g. Japan.</button></div>`;
    $("sug").querySelectorAll("button[data-d]").forEach((b) => (b.onclick = () => go("dest", { d: b.dataset.d })));
  };
  q.onkeydown = (e) => { if (e.key === "Enter") { const f = $("sug").querySelector("button[data-d]"); if (f) f.click(); } };
  try {
    const pop = await api("/api/popular?dest=" + encodeURIComponent(POPULAR.join(",")));
    document.querySelectorAll("[data-from]").forEach((s) => { const h = pop[s.dataset.from]; if (h && h.from) s.textContent = "from " + h.from.price; });
  } catch { /* prices are optional */ }
};

// "Unlimited Plus eSIM Data for 1 Day for Japan" -> "Unlimited Plus"
const planTitle = (p) => { const t = String(p.name || "").split(/\s+eSIM\b/i)[0].trim(); return t && t.length <= 40 ? t : (p.unlimitedData ? "Unlimited" : p.data); };
const netTag = (p) => p.coverage || (p.networks ? p.networks + " network" : "");
const FILTERS = [
  { k: "all", t: "All" }, { k: "unl", t: "Unlimited" }, { k: "d7", t: "Up to 7 days" }, { k: "d15", t: "8–15 days" }, { k: "d30", t: "30+ days" }, { k: "calls", t: "With calls" }
];
SCREENS.dest = async ({ d, f = "all" }) => {
  setTop(d, true);
  if (!state.plans[d]) {
    loading();
    try { state.plans[d] = (await api("/api/plans?destination=" + encodeURIComponent(d))).plans || []; }
    catch (e) { render(`<div class="empty"><div class="big">📡</div><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`); $("retry").onclick = () => SCREENS.dest({ d, f }); return; }
  }
  const all = state.plans[d];
  const pass = (p) => f === "all" || (f === "unl" && p.unlimitedData) || (f === "d7" && p.validityDays <= 7) || (f === "d15" && p.validityDays > 7 && p.validityDays <= 15) || (f === "d30" && p.validityDays >= 30) || (f === "calls" && p.callsAndTexts);
  const list = all.filter(pass).sort((a, b) => a.validityDays - b.validityDays || a.pricePHP - b.pricePHP).slice(0, 80);
  render(`<div class="filters">${FILTERS.map((x) => `<button class="chip ${x.k === f ? "on" : ""}" data-f="${x.k}">${x.t}</button>`).join("")}</div>
    <div class="label">${esc(d)}</div><h2 class="h2" style="margin-top:2px">${all.length} plan${all.length === 1 ? "" : "s"} available</h2>
    ${list.length ? list.map((p) => `<button class="uk-plan plan" data-id="${esc(p.planId)}">
      ${p.callsAndTexts ? '<span class="badge gold ptag">Calls &amp; texts</span>' : p.unlimitedData ? '<span class="badge navy ptag">Unlimited</span>' : ""}
      <div class="ptop"><div><div class="pname">${esc(planTitle(p))}</div>
      <div class="pspec"><span class="pdata">${esc(p.unlimitedData ? "Unlimited" : p.data)}</span><span>·</span><span>${p.validityDays} day${p.validityDays > 1 ? "s" : ""}</span>${p.scope && p.scope !== "country" ? `<span>·</span><span>${esc(p.destination)}</span>` : ""}</div></div>
      <div class="pprice">${esc(p.price)}</div></div>
      ${netTag(p) ? `<div class="pnet">✓ ${esc(netTag(p))}</div>` : ""}</button>`).join("")
      : `<div class="empty"><div class="big">🔎</div><p>No ${f === "all" ? "" : "matching "}plans for ${esc(d)}.</p></div>`}`);
  document.querySelectorAll(".filters .chip").forEach((b) => (b.onclick = () => { state.stack[state.stack.length - 1].args = { d, f: b.dataset.f }; SCREENS.dest({ d, f: b.dataset.f }); }));
  document.querySelectorAll(".plan").forEach((b) => (b.onclick = () => planSheet(all.find((p) => p.planId === b.dataset.id))));
};

function planSheet(p) {
  if (!p) return;
  openSheet(`<div class="label">${esc(p.destination)}</div><h3>${esc(planTitle(p))} · ${p.validityDays} day${p.validityDays > 1 ? "s" : ""}</h3><div class="sprice">${esc(p.price)}</div>
    <div class="card" style="margin-top:12px"><div class="kv"><span>Destination</span><span>${esc(p.destination)}</span></div>
    <div class="kv"><span>Data</span><span>${esc(p.unlimitedData ? "Unlimited" : p.data)}</span></div>
    <div class="kv"><span>Valid for</span><span>${p.validityDays} day${p.validityDays > 1 ? "s" : ""}</span></div>
    ${netTag(p) ? `<div class="kv"><span>Networks</span><span>${esc(netTag(p))}</span></div>` : ""}
    <div class="kv"><span>Calls & texts</span><span>${p.callsAndTexts ? "Included" : "Data only"}</span></div>
    </div>
    <ul class="feats"><li>Delivered in minutes to this app and your email</li><li>Install on Wi-Fi before you travel, turn on when you land</li><li>Your phone must support eSIM and be unlocked</li></ul>
    <button class="btn red" id="buyBtn">Buy now · ${esc(p.price)}</button>
    <div class="pay"><span class="flabel">We accept</span><ul><li>GCash</li><li>Maya</li><li>Cards</li></ul></div>`);
  $("buyBtn").onclick = () => buy(p);
}

async function buy(p) {
  if (!state.token) { state.pendingPlan = p; closeSheet(); return go("login", { reason: "Sign in to buy your eSIM. We'll send it to this email too." }); }
  const b = $("buyBtn"); if (b) { b.disabled = true; b.textContent = "Opening payment…"; }
  try {
    const r = await api("/api/app/checkout", { method: "POST", body: { planId: p.planId }, auth: true });
    closeSheet();
    state.pollUntil = Date.now() + 15 * 60000;
    if (NATIVE) await Browser.open({ url: r.url, presentationStyle: "popover" });
    else window.open(r.url, "_blank");
    tab("esims");
  } catch (e) {
    if (e.status === 401) { state.pendingPlan = p; closeSheet(); return go("login", { reason: "Please sign in again to continue." }); }
    toast(e.message); if (b) { b.disabled = false; b.textContent = "Buy now · " + p.price; }
  }
}

// ---------- Sign in ----------
SCREENS.login = ({ reason }) => {
  setTop("Sign in", state.stack.length > 1);
  render(`<div class="card" style="padding:20px"><div class="center"><img src="img/logo.png" width="76" height="76" alt=""></div>
    <h2 class="center" style="margin-top:8px">Sign in or create an account</h2>
    <p class="center muted small">${esc(reason || "Use your email. We'll send you a 6-digit code, no password needed.")}</p>
    <input class="field" id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" value="${esc((state.user && state.user.email) || "")}">
    <div class="err" id="err"></div><button class="btn" id="send">Send my code</button></div>`);
  const send = async () => {
    const email = $("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { $("err").textContent = "Please enter a valid email address."; return; }
    $("send").disabled = true; $("send").textContent = "Sending…"; $("err").textContent = "";
    try { await api("/api/app/login/start", { method: "POST", body: { email } }); go("code", { email }); }
    catch (e) { $("err").textContent = e.message; $("send").disabled = false; $("send").textContent = "Send my code"; }
  };
  $("send").onclick = send; $("email").onkeydown = (e) => { if (e.key === "Enter") send(); };
};
SCREENS.code = ({ email }) => {
  setTop("Enter code", true);
  render(`<div class="card" style="padding:20px"><h2 class="center">Check your email</h2>
    <p class="center muted small">We sent a 6-digit code to <b>${esc(email)}</b>. It may take a minute. Check Spam/Promotions too.</p>
    <input class="field code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
    <div class="err" id="err"></div><button class="btn" id="ok">Sign in</button>
    <button class="btn link" id="resend">Send a new code</button></div>`);
  const c = $("code"); setTimeout(() => c.focus(), 200);
  const verify = async () => {
    const code = c.value.replace(/\D/g, "");
    if (code.length !== 6) { $("err").textContent = "Please enter the 6-digit code."; return; }
    $("ok").disabled = true; $("ok").textContent = "Signing in…"; $("err").textContent = "";
    try {
      const r = await api("/api/app/login/verify", { method: "POST", body: { email, code } });
      await setSession(r.token, r.user);
      toast(r.isNew ? "Welcome to 3UK! 🎉" : "Welcome back! 👋");
      const p = state.pendingPlan; state.pendingPlan = null;
      if (p) { tab("shop"); go("dest", { d: p.destination }); planSheet(p); }
      else tab(state.tab === "shop" ? "shop" : state.tab);
    } catch (e) { $("err").textContent = e.message; $("ok").disabled = false; $("ok").textContent = "Sign in"; }
  };
  c.oninput = () => { c.value = c.value.replace(/\D/g, "").slice(0, 6); if (c.value.length === 6) verify(); };
  $("ok").onclick = verify;
  $("resend").onclick = async () => { try { await api("/api/app/login/start", { method: "POST", body: { email } }); toast("New code sent"); } catch (e) { $("err").textContent = e.message; } };
};

// ---------- My eSIMs ----------
const STATE_LABEL = { active: "Active", not_active: "Not installed yet", used_up: "Data used up", expired: "Expired", pending: "Waiting for payment", processing: "Preparing your eSIM", checking: "Being checked by our team", cancelled: "Cancelled" };
SCREENS.esims = async () => {
  setTop("My eSIMs", false);
  if (!state.token) {
    render(`<div class="empty"><div class="big">📶</div><h2>Your eSIMs live here</h2><p>Sign in to see your eSIMs, install them and check your data.</p></div><button class="btn" id="si">Sign in</button>`);
    $("si").onclick = () => go("login", {}); return;
  }
  loading();
  let esims = [], orders = [];
  try {
    const [a, b] = await Promise.all([api("/api/app/esims", { auth: true }), api("/api/app/orders", { auth: true }).catch(() => ({ orders: [] }))]);
    esims = a.esims || []; orders = b.orders || [];
  } catch (e) {
    if (e.status === 401) return SCREENS.esims();
    render(`<div class="empty"><div class="big">📡</div><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`); $("retry").onclick = () => SCREENS.esims(); return;
  }
  if (state.tab !== "esims") return;
  const recent = orders.filter((o) => o.status !== "delivered" && o.status !== "cancelled" && Date.now() - Date.parse(o.at) < 48 * 3600000 && (o.status !== "pending" || Date.now() - Date.parse(o.at) < 3 * 3600000));
  state.esims = esims;
  render(`${recent.length ? `<h2>In progress</h2>${recent.map((o) => `<div class="card"><div class="esim"><div class="row1"><span class="nm">${esc(o.plan)}</span><span class="state ${o.status}">${STATE_LABEL[o.status] || o.status}</span></div>
      <div class="small muted" style="margin-top:4px">${peso(o.pricePHP)} · Ref ${esc(o.ref)}</div>
      ${o.status === "checking" ? '<div class="small" style="margin-top:6px">Our team is on it. Need help? <a href="#" data-wa>Message us</a>.</div>' : o.status === "pending" ? '<div class="small muted" style="margin-top:6px">Finished paying? Tap Refresh in a minute.</div>' : ""}</div></div>`).join("")}` : ""}
    <h2>My eSIMs</h2>
    ${esims.length ? esims.map((s, i) => `<button class="card esim" data-i="${i}"><div class="row1"><span class="nm">${esc(s.plan || "eSIM")}</span><span class="state" data-st="${esc(s.iccid)}">…</span></div>
      <div class="small muted" style="margin-top:4px">ICCID …${esc(s.iccid.slice(-6))}${s.addedAt ? " · " + fmtDate(s.addedAt) : ""}</div><div data-u="${esc(s.iccid)}"></div></button>`).join("")
      : `<div class="empty"><div class="big">🌏</div><p>No eSIMs yet. eSIMs bought with <b>${esc(state.user.email)}</b> (in the app, on our website or in chat) show up here.</p></div><button class="btn" id="shopNow">Shop eSIMs</button>`}
    <button class="btn link" id="refresh">↻ Refresh</button>`);
  document.querySelectorAll("[data-wa]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); openExternal(WHATSAPP); }));
  if ($("shopNow")) $("shopNow").onclick = () => tab("shop");
  $("refresh").onclick = () => SCREENS.esims();
  document.querySelectorAll(".esim[data-i]").forEach((b) => (b.onclick = () => go("esim", { i: Number(b.dataset.i) })));
  for (const s of esims.slice(0, 12)) loadUsage(s.iccid).then((u) => paintUsage(s.iccid, u)).catch(() => {});
  if (recent.some((o) => o.status === "processing" || o.status === "pending") && Date.now() < state.pollUntil) {
    clearTimeout(state.pollT); state.pollT = setTimeout(() => { if (state.tab === "esims" && state.stack.length <= 1) SCREENS.esims(); }, 20000);
  }
};
async function loadUsage(iccid, force) {
  const c = state.usage[iccid];
  if (c && !force && Date.now() - c.at < 120000) return c.u;
  const u = await api("/api/data-check?iccid=" + iccid + (force ? "&refresh=1" : ""));
  state.usage[iccid] = { at: Date.now(), u }; return u;
}
function paintUsage(iccid, u) {
  const st = document.querySelector(`[data-st="${iccid}"]`);
  if (st) { st.className = "state " + u.state; st.textContent = STATE_LABEL[u.state] || u.state; }
  const box = document.querySelector(`[data-u="${iccid}"]`);
  if (box && u.state !== "not_active") box.innerHTML = u.unlimited ? `<div class="small" style="margin-top:6px">Unlimited data${u.expires ? " · until " + fmtDate(u.expires) : ""}</div>`
    : `<div class="bar"><i style="width:${Math.max(0, Math.min(100, 100 - (u.percentUsed || 0)))}%"></i></div><div class="small muted">${esc(u.remaining || "")} left of ${esc(u.total || "")}${u.expires ? " · until " + fmtDate(u.expires) : ""}</div>`;
}

function qrImg(text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  return q.createDataURL(8, 2);
}
SCREENS.esim = async ({ i }) => {
  const s = (state.esims || [])[i];
  if (!s) return tab("esims");
  setTop("My eSIM", true);
  const lpa = s.lpa;
  render(`<h2>${esc(s.plan || "eSIM")}</h2><div class="card"><div class="row1 esim" style="display:flex;justify-content:space-between;align-items:center"><b style="color:var(--navy)">Data</b><span class="state" data-st="${esc(s.iccid)}">…</span></div>
      <div data-u="${esc(s.iccid)}"><div class="small muted" style="margin-top:6px">Checking your data…</div></div>
      <button class="btn link" id="ref" style="padding:8px 0 0">↻ Refresh data</button></div>
    ${lpa ? `<h2>Install this eSIM</h2>
      <div class="note"><b>Install on Wi-Fi, before you travel.</b> An eSIM can usually be installed only once, so don't delete it after installing.</div>
      <button class="btn red" id="inst">📲 Install eSIM on this phone</button>
      <ol class="steps"><li>Tap the button above. We copy your <b>activation code</b> and open your phone's eSIM settings.</li>
      <li>Tap <b>Add eSIM</b> (Samsung: <b>Add eSIM › Other ways to add</b>), then <b>Enter activation code / Enter details manually</b>.</li>
      <li><b>Paste</b> the code and follow the steps. Name the line "3UK Travel".</li>
      <li>When you land: turn on the 3UK line, set it for <b>mobile data</b>, and turn on <b>data roaming</b>.</li></ol>
      <h2>Other ways</h2>
      <p class="small muted" style="margin:0 2px 8px">Scan this QR from your phone's eSIM settings using another screen, or type the details in manually.</p>
      <div class="qr"><img alt="eSIM QR code" src="${qrImg(lpa)}"></div>
      ${s.smdp ? `<div class="small muted" style="margin:12px 2px 0">SM-DP+ address</div><div class="copy"><code>${esc(s.smdp)}</code><button data-c="${esc(s.smdp)}" data-l="SM-DP+ address copied">Copy</button></div>` : ""}
      ${s.activationCode ? `<div class="small muted" style="margin:0 2px">Activation code</div><div class="copy"><code>${esc(s.activationCode)}</code><button data-c="${esc(s.activationCode)}" data-l="Activation code copied">Copy</button></div>` : ""}
      <div class="small muted" style="margin:0 2px">Full code (for "Enter activation code")</div><div class="copy"><code>${esc(lpa)}</code><button data-c="${esc(lpa)}" data-l="Code copied">Copy</button></div>`
    : `<div class="note">The install code for this eSIM isn't available in the app. It was sent to your email with the QR code. Need it again? Message us and we'll help.</div>`}
    <div class="card" style="margin-top:12px"><div class="kv"><span>ICCID</span><span>${esc(s.iccid)}</span></div>${s.addedAt ? `<div class="kv"><span>Delivered</span><span>${fmtDate(s.addedAt)}</span></div>` : ""}</div>
    <button class="btn ghost" id="help">💬 Help on WhatsApp</button>`);
  document.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => copy(b.dataset.c, b.dataset.l)));
  $("help").onclick = () => openExternal(WHATSAPP + "?text=" + encodeURIComponent(`Hi 3UK! I need help with my eSIM (ICCID ${s.iccid}).`));
  if ($("inst")) $("inst").onclick = async () => {
    await copy(lpa, "Activation code copied");
    let r = { opened: false };
    try { r = await Esim.openEsimSettings(); } catch { /* not available */ }
    if (!r.opened) toast("Code copied. Open Settings › Connections › SIM manager › Add eSIM");
  };
  const show = (u) => { paintUsage(s.iccid, u); };
  loadUsage(s.iccid).then(show).catch((e) => { const b = document.querySelector(`[data-u="${s.iccid}"]`); if (b) b.innerHTML = `<div class="small muted" style="margin-top:6px">${esc(e.message)}</div>`; });
  $("ref").onclick = () => loadUsage(s.iccid, true).then((u) => { show(u); toast("Data updated"); }).catch((e) => toast(e.message));
};

// ---------- Account ----------
SCREENS.account = async () => {
  setTop("Account", false);
  const links = `<div class="card list"><a href="#" data-x="${WHATSAPP}">💬 Chat with us on WhatsApp <span>›</span></a>
    <a href="#" data-x="https://3ukph.com">🌐 3ukph.com <span>›</span></a>
    <a href="#" data-x="https://3ukph.com/privacy">🔒 Privacy policy <span>›</span></a></div>`;
  if (!state.token) {
    render(`<div class="empty"><div class="big">👤</div><h2>Your 3UK account</h2><p>Sign in with your email to buy eSIMs and keep them all in one place.</p></div><button class="btn" id="si">Sign in</button><div style="height:14px"></div>${links}`);
    $("si").onclick = () => go("login", {});
  } else {
    const u = state.user || {};
    render(`<div class="card acct"><div class="avatar">${esc((u.name || u.email || "?").charAt(0).toUpperCase())}</div><div style="min-width:0"><b>${esc(u.name || "Add your name")}</b><div class="small muted" style="word-break:break-all">${esc(u.email)}</div></div></div>
      <div class="card"><div class="small muted">Your name</div><input class="field" id="nm" value="${esc(u.name || "")}" placeholder="Juan Dela Cruz" maxlength="60"><button class="btn ghost" id="saveNm">Save name</button></div>
      <h2>Orders</h2><div id="orders"><div class="spin"></div></div>
      <h2>Help & info</h2>${links}
      <button class="btn ghost" id="out" style="margin-top:14px">Sign out</button>
      <button class="btn danger" id="del">Delete my account</button>
      <p class="center small muted">3UK Philippines · Taguig City, Philippines</p>`);
    $("saveNm").onclick = async () => { try { const r = await api("/api/app/me", { method: "POST", body: { name: $("nm").value }, auth: true }); await setSession(state.token, r.user); toast("Saved"); SCREENS.account(); } catch (e) { toast(e.message); } };
    $("out").onclick = async () => { try { await api("/api/app/logout", { method: "POST", auth: true }); } catch { /* ignore */ } await setSession(null, null); toast("Signed out"); tab("shop"); };
    $("del").onclick = () => {
      openSheet(`<h3>Delete your account?</h3><p class="muted">This deletes your 3UK app account and signs you out. Your installed eSIMs keep working. To use the app again, just sign in with your email.</p>
        <button class="btn red" id="delYes">Yes, delete my account</button><button class="btn link" id="delNo">Cancel</button>`);
      $("delNo").onclick = closeSheet;
      $("delYes").onclick = async () => {
        try { await api("/api/app/delete-account", { method: "POST", auth: true }); await setSession(null, null); closeSheet(); toast("Account deleted"); tab("shop"); } catch (e) { toast(e.message); }
      };
    };
    try {
      const r = await api("/api/app/orders", { auth: true });
      const o = r.orders || [];
      if ($("orders")) $("orders").innerHTML = o.length ? `<div class="card">${o.map((x) => `<div class="kv"><span>${esc(x.plan)}<br><small>${fmtDate(x.at)} · ${esc(x.ref)}</small></span><span>${peso(x.pricePHP)}<br><small class="state ${x.status}" style="display:inline-block;margin-top:4px">${STATE_LABEL[x.status] || (x.status === "delivered" ? "Delivered" : x.status)}</small></span></div>`).join("")}</div>`
        : `<p class="muted small" style="margin:0 2px">No app orders yet.</p>`;
    } catch (e) { if ($("orders")) $("orders").innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  }
  document.querySelectorAll("[data-x]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); openExternal(a.dataset.x); }));
};
STATE_LABEL.delivered = "Delivered";

// ---------- Start ----------
(async function start() {
  try { const v = (await Preferences.get({ key: "session" })).value; if (v) { const s = JSON.parse(v); state.token = s.token; state.user = s.user; } } catch { /* first run */ }
  if (NATIVE) {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
    StatusBar.setBackgroundColor({ color: dark ? "#0b0e1e" : "#ffffff" }).catch(() => {});
    App.addListener("backButton", () => { if (!back()) { if (state.tab !== "shop") tab("shop"); else App.exitApp(); } });
    App.addListener("resume", () => { if (state.tab === "esims" && state.stack.length <= 1) SCREENS.esims(); });
    Browser.addListener("browserFinished", () => { if (state.tab === "esims") SCREENS.esims(); });
  }
  tab("shop");
  if (state.token) api("/api/app/me", { auth: true }).then((r) => setSession(state.token, r.user)).catch(() => {});
  if (NATIVE) setTimeout(() => SplashScreen.hide().catch(() => {}), 300);
})();
