// tripAdvisor.js
//
// The bot's "travel brain". Before the AI answers, this reads the customer's
// recent messages, works out the trip (countries, days, how heavy a user they
// are, calls needed) and picks the right plan itself, using the real catalog:
//   - 1 country  -> best country plan
//   - 2+ countries -> ONE regional/global plan that covers all of them
//   - data sized to the trip (light 0.5GB/day, normal 1GB/day, heavy 2GB/day)
//   - validity >= trip days, cheapest plan that fits, plus 2 alternatives
// The result is handed to the AI as a "TRIP ANALYSIS" so even a small model
// recommends the right thing.

const { countryNames, searchPlans, searchMultiCountryPlans } = require("./planSearch");

// Cities / nicknames people use instead of the country.
const CITY_TO_COUNTRY = {
  tokyo: "Japan", osaka: "Japan", kyoto: "Japan", hokkaido: "Japan", sapporo: "Japan", okinawa: "Japan", fukuoka: "Japan", nagoya: "Japan",
  seoul: "South Korea", busan: "South Korea", jeju: "South Korea", korea: "South Korea",
  taipei: "Taiwan", kaohsiung: "Taiwan",
  beijing: "China", shanghai: "China", shenzhen: "China", guangzhou: "China",
  macao: "Macau", bangkok: "Thailand", phuket: "Thailand", "chiang mai": "Thailand",
  hanoi: "Vietnam", "ho chi minh": "Vietnam", saigon: "Vietnam", "da nang": "Vietnam", danang: "Vietnam",
  bali: "Indonesia", jakarta: "Indonesia", "kuala lumpur": "Malaysia", penang: "Malaysia", "kota kinabalu": "Malaysia",
  dubai: "United Arab Emirates", "abu dhabi": "United Arab Emirates", uae: "United Arab Emirates", doha: "Qatar",
  riyadh: "Saudi Arabia", jeddah: "Saudi Arabia", mecca: "Saudi Arabia", makkah: "Saudi Arabia", medina: "Saudi Arabia",
  "tel aviv": "Israel", jerusalem: "Israel", "holy land": "Israel", cairo: "Egypt", amman: "Jordan", petra: "Jordan",
  istanbul: "Turkey", "türkiye": "Turkey", turkiye: "Turkey",
  london: "United Kingdom", uk: "United Kingdom", england: "United Kingdom", scotland: "United Kingdom", britain: "United Kingdom",
  paris: "France", nice: "France", rome: "Italy", milan: "Italy", venice: "Italy", florence: "Italy", vatican: "Italy",
  madrid: "Spain", barcelona: "Spain", lisbon: "Portugal", porto: "Portugal", amsterdam: "Netherlands", rotterdam: "Netherlands",
  holland: "Netherlands", brussels: "Belgium", berlin: "Germany", munich: "Germany", frankfurt: "Germany", hamburg: "Germany",
  vienna: "Austria", salzburg: "Austria", zurich: "Switzerland", geneva: "Switzerland", lucerne: "Switzerland",
  prague: "Czech Republic", czechia: "Czech Republic", budapest: "Hungary", warsaw: "Poland", krakow: "Poland",
  athens: "Greece", santorini: "Greece", mykonos: "Greece", oslo: "Norway", stockholm: "Sweden", copenhagen: "Denmark",
  helsinki: "Finland", reykjavik: "Iceland", dublin: "Ireland", edinburgh: "United Kingdom",
  usa: "United States", "u.s.": "United States", america: "United States", "new york": "United States", "los angeles": "United States",
  "san francisco": "United States", "las vegas": "United States", hawaii: "United States", guam: "Guam",
  toronto: "Canada", vancouver: "Canada", sydney: "Australia", melbourne: "Australia", brisbane: "Australia", perth: "Australia",
  auckland: "New Zealand", singapore: "Singapore", "hong kong": "Hong Kong", hk: "Hong Kong"
};
// Words that are also ordinary words or names: only count them with travel context.
const RISKY = new Set(["chad", "jordan", "georgia", "nice", "turkey", "china", "guinea", "niger", "mali", "oman", "india"]);
// A risky word only counts as a country right after a travel word: "to Jordan", "sa Turkey", "visit China".
function riskyOk(text, key) {
  return new RegExp(`\\b(to|in|visit|visiting|sa|for|going to|papuntang|pupunta sa|trip to|via)\\s+(the\\s+)?${escapeRe(key)}\\b`, "i").test(text) ||
    new RegExp(`\\b${escapeRe(key)}\\s+(trip|tour|travel|esim|plan)\\b`, "i").test(text);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

let MATCHERS = null;
function matchers() {
  if (MATCHERS) return MATCHERS;
  const list = [];
  for (const c of countryNames()) list.push([c.toLowerCase(), c]);
  for (const [k, v] of Object.entries(CITY_TO_COUNTRY)) list.push([k, v]);
  list.sort((a, b) => b[0].length - a[0].length); // longest first ("south korea" before "korea")
  MATCHERS = list.map(([k, v]) => ({ key: k, country: v, re: new RegExp(`(^|[^a-z])${escapeRe(k)}([^a-z]|$)`, "i") }));
  return MATCHERS;
}

function findCountries(text) {
  let t = " " + String(text || "").toLowerCase() + " ";
  const found = [];
  for (const m of matchers()) {
    if (!m.re.test(t)) continue;
    if (RISKY.has(m.key) && !riskyOk(text, m.key) &&
        !(found.length && new RegExp(`(,|&|\\band|\\bat|\\bor|\\bthen)\\s+${escapeRe(m.key)}\\b`, "i").test(text))) continue;
    if (!found.includes(m.country)) found.push(m.country);
    t = t.replace(m.re, "$1 $2"); // so "south korea" doesn't also match "korea"
  }
  // "from the Philippines to X" -> the Philippines is home, not a destination.
  if (found.length > 1 && found.includes("Philippines") &&
      /(from|galing( sa)?|leaving|aalis( sa)?)\s+(the\s+)?(philippines|pinas|manila|cebu|clark|ph)\b/i.test(text)) {
    found.splice(found.indexOf("Philippines"), 1);
  }
  return found;
}

const NUM_WORDS = { a: 1, an: 1, one: 1, isang: 1, isa: 1, two: 2, dalawang: 2, dalawa: 2, three: 3, tatlong: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
function num(s) { const n = parseInt(s, 10); return Number.isFinite(n) ? n : NUM_WORDS[String(s).toLowerCase()] || null; }

function findDays(text) {
  const t = String(text || "").toLowerCase();
  let m = t.match(/(\d+|a|an|one|isang|two|dalawang|three|tatlong|four|five|six)\s*(-|\s)?\s*(months?|buwan)/);
  if (m) return num(m[1]) * 30;
  m = t.match(/(\d+|a|an|one|isang|two|dalawang|three|tatlong|four)\s*(-|\s)?\s*(weeks?|wks?|linggo)/);
  if (m) return num(m[1]) * 7;
  m = t.match(/(\d+)\s*(-|\s)?\s*(days?|d\b|araw|nights?|gabi)/);
  if (m) return parseInt(m[1], 10) + (/night|gabi/.test(m[3]) ? 1 : 0);
  m = t.match(/(\d+)\s*(d|days?)\s*(\d+)\s*n/); // "5D4N"
  if (m) return parseInt(m[1], 10);
  return null;
}

function findUsage(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(heavy|hotspot|tether|laptop|work|stream|streaming|netflix|youtube|tiktok live|video ?calls? (a lot|everyday|daily)|madami|malakas gumamit|unlimited)\b/.test(t)) return "heavy";
  if (/\b(light|maps?|messag|chat|whatsapp|messenger|grab|konti|kaunti|basic|email)\b/.test(t)) return "light";
  return null;
}
function findCalls(text) {
  return /\b(calls?|tawag|sms|texts?|local number|phone number|numero)\b/i.test(String(text || "")) && !/\bvideo ?call/i.test(String(text || ""));
}

// Read the chat (oldest -> newest); the latest message that mentions something wins.
function analyzeTrip(userTexts) {
  const trip = { countries: [], days: null, usage: null, needsCalls: false, seafarer: false };
  for (const txt of userTexts) {
    const c = findCountries(txt); if (c.length) trip.countries = c;
    const d = findDays(txt); if (d) trip.days = d;
    const u = findUsage(txt); if (u) trip.usage = u;
    if (findCalls(txt)) trip.needsCalls = true;
    if (/\b(seafarer|seaman|seamen|marino|crew|sasampa|sampa|sign on|sign-on|barko|vessel|onboard|on board|ship)\b/i.test(txt)) trip.seafarer = true;
  }
  return trip;
}

const PER_DAY = { light: 0.5, normal: 1, heavy: 2 };
function gb(p) { return /unlimited/i.test(p.data || "") || p.unlimitedData ? Infinity : (parseFloat(String(p.data).replace(/[^0-9.]/g, "")) || 0) / (/mb/i.test(p.data) ? 1024 : 1); }

function recommend(trip) {
  if (!trip.countries.length) return null;
  const multi = trip.countries.length > 1;
  // Seafarers move port to port: prefer a regional plan that covers the country (and its neighbours).
  const regionalForSeafarer = trip.seafarer && !multi;
  const res = (multi || regionalForSeafarer)
    ? searchMultiCountryPlans({ countries: multi ? trip.countries : [trip.countries[0], trip.countries[0]], needsCallsAndTexts: trip.needsCalls || undefined, maxResults: 60 })
    : searchPlans({ destination: trip.countries[0], needsCallsAndTexts: trip.needsCalls || undefined, maxResults: 200 });
  let plans = (res && res.plans) || [];
  if (!trip.needsCalls) plans = plans.filter((p) => !p.callsAndTexts);
  if (!plans.length) return { trip, multi, none: true };
  if (!trip.days) return { trip, multi, needDays: true, regions: res.plansThatCoverAllOfThem };

  const usage = trip.usage || (trip.seafarer ? "light" : "normal"); // seafarers only use data in port
  const needGB = Math.max(1, Math.ceil(trip.days * PER_DAY[usage]));
  const fits = plans.filter((p) => (p.validityDays || 0) >= trip.days);
  const byPrice = (a, b) => a.pricePHP - b.pricePHP;
  const best = fits.filter((p) => gb(p) >= needGB).sort(byPrice)[0] || fits.sort((a, b) => gb(b) - gb(a) || byPrice(a, b))[0];
  const alts = [];
  if (best) {
    const cheaper = fits.filter((p) => p.pricePHP < best.pricePHP && gb(p) >= needGB * 0.5).sort((a, b) => gb(b) - gb(a) || byPrice(a, b))[0];
    if (cheaper) alts.push({ why: "budget option, less data", plan: cheaper });
    const more = fits.filter((p) => p !== best && gb(p) > gb(best) && p.pricePHP > best.pricePHP).sort(byPrice)[0];
    if (more) alts.push({ why: Number.isFinite(gb(more)) ? "more data for a bit more" : "unlimited data", plan: more });
  }
  return { trip, multi, seafarerRegional: regionalForSeafarer, usage, needGB, best, alts, regions: res.plansThatCoverAllOfThem };
}

function short(p) {
  return `${p.name} | ${p.data} / ${p.validityDays} days | ${p.price}${p.coverage ? " | covers " + p.coverage : ""} | planId ${p.planId}`;
}

// Text block for the AI's instructions. Empty when the chat has no destination yet.
function tripContext(userTexts) {
  let r;
  try { r = recommend(analyzeTrip(userTexts)); } catch (e) { console.error("[trip] analysis failed:", e.message); return ""; }
  if (!r) return "";
  const t = r.trip;
  const lines = ["", "--- TRIP ANALYSIS (computed by our system from this chat, using the live catalog) ---",
    `Countries: ${t.countries.join(", ")}${r.multi ? " (multi-country trip: offer ONE eSIM that covers all of them)" : ""}`,
    ...(t.seafarer ? ["Seafarer: data works in port and near the coast only (not open sea). A regional plan covers the next ports too; ask about the route if unsure."] : []),
    `Trip length: ${t.days ? t.days + " days" : "unknown"}${t.usage ? " | usage: " + t.usage : ""}${t.needsCalls ? " | wants calls/texts" : ""}`];
  if (r.none) lines.push("No plan found for this combination: search again (region or global) before telling the customer.");
  else if (r.needDays) {
    lines.push("Ask how many days the trip is (and how they use data) before recommending a specific plan.");
    if (r.regions && r.regions.length) lines.push(`Plans that cover all these countries: ${r.regions.slice(0, 4).join("; ")}.`);
  } else if (r.best) {
    lines.push(`Estimated data need: about ${r.needGB}GB (${r.usage} use${t.usage ? "" : ", assumed; ask if unsure"}).`);
    lines.push(`BEST PICK: ${short(r.best)}`);
    r.alts.forEach((a) => lines.push(`Alternative (${a.why}): ${short(a.plan)}`));
    lines.push("Recommend the BEST PICK with a one-line reason, show the alternatives briefly, and confirm with get_plan before ordering. " +
      "If the customer gave different details than this analysis, trust the customer and search again. Prices here are retail.");
  }
  return lines.join("\n");
}

module.exports = { analyzeTrip, recommend, tripContext, findCountries, findDays };
