// planSearch.js
//
// Loads data/plans.json (built from the reseller pricing spreadsheet) and
// provides the lookups the bot calls as tools. The catalog is far too big
// (6,493 plans) to put in every prompt, so the bot searches it on demand.
//
// Prices: the catalog stores retail prices in USD. Customers are always
// quoted in Philippine pesos at a FIXED rate (USD_TO_PHP below). The peso
// amount is calculated here, in code, so the AI never does the math itself
// and can't get it wrong. Change the rate in one place: USD_TO_PHP.

const fs = require("fs");
const path = require("path");

let USD_TO_PHP = 65; // fixed exchange rate: 1 USD = 65 PHP (can be updated from the price sheet's "Settings" tab)

// The catalog starts from data/plans.json (built in to the code) and is
// replaced automatically whenever priceSync.js loads a newer price sheet.
let PLANS = [];
let PLANS_BY_ID = new Map();
let DESTINATIONS = [];
let DESTINATIONS_LOWER = [];
let CATALOG_INFO = { source: "built-in file (data/plans.json)", updatedAt: null, planCount: 0 };

// Give every plan a stable ID (its position in the catalog) so the bot can
// refer to ONE exact plan. Several plans share the same name (e.g. two
// different "50GB eSIM Data for 30 Days in Europe" with different prices
// and coverage), which is what caused mixed-up prices before.
function setCatalog(rawPlans, { rate, source, updatedAt } = {}) {
  PLANS = rawPlans.map((p, i) => ({ ...p, planId: "P" + (i + 1) }));
  PLANS_BY_ID = new Map(PLANS.map((p) => [p.planId, p]));
  DESTINATIONS = [...new Set(PLANS.map((p) => p.destination))].sort((a, b) => a.localeCompare(b));
  DESTINATIONS_LOWER = DESTINATIONS.map((d) => d.toLowerCase());
  if (typeof rate === "number" && rate > 0) USD_TO_PHP = rate;
  CATALOG_INFO = { source: source || CATALOG_INFO.source, updatedAt: updatedAt || new Date().toISOString(), planCount: PLANS.length };
}

setCatalog(JSON.parse(fs.readFileSync(path.join(__dirname, "data", "plans.json"), "utf8")), {
  source: "built-in file (data/plans.json)"
});

// Common alternate names customers might type. Add more here any time you
// notice the bot missing a match in real conversations.
const ALIASES = {
  "uk": "United Kingdom",
  "u.k.": "United Kingdom",
  "england": "United Kingdom",
  "britain": "United Kingdom",
  "great britain": "United Kingdom",
  "london": "United Kingdom",
  "us": "United States",
  "u.s.": "United States",
  "usa": "United States",
  "u.s.a.": "United States",
  "america": "United States",
  "uae": "United Arab Emirates",
  "dubai": "United Arab Emirates",
  "emirates": "United Arab Emirates",
  "korea": "South Korea",
  "hk": "Hong Kong",
  "hong kong sar": "Hong Kong",
  "ph": "Philippines",
  "phils": "Philippines",
  "worldwide": "global",
  "world": "global",
  "schengen": "Europe",
  "eu": "Europe"
};

function resolveDestination(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  if (ALIASES[q]) return [ALIASES[q]];

  const exactIdx = DESTINATIONS_LOWER.indexOf(q);
  if (exactIdx !== -1) return [DESTINATIONS[exactIdx]];

  const partial = DESTINATIONS.filter((d, i) => DESTINATIONS_LOWER[i].includes(q) || q.includes(DESTINATIONS_LOWER[i]));
  if (partial.length) return partial;
  // Typo tolerance: "Iram" -> Iran, "Phillipines" -> Philippines.
  const close = closeDestinations(q, q.length <= 5 ? 1 : 2);
  return close.length === 1 ? close : [];
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function closeDestinations(q, maxDist) {
  if (!q || q.length < 3) return [];
  return DESTINATIONS.filter((d, i) => editDistance(q, DESTINATIONS_LOWER[i]) <= maxDist);
}

// Rough numeric GB value for sorting/filtering ("20GB" -> 20, "500MB" -> 0.5, "Unlimited" -> Infinity).
function dataToNumber(dataStr) {
  if (!dataStr) return 0;
  if (/unlimited/i.test(dataStr)) return Infinity;
  const m = String(dataStr).match(/([\d.]+)\s*(mb|gb)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] && m[2].toLowerCase() === "mb" ? n / 1024 : n;
}

function toPHP(usd) {
  return Math.round((usd || 0) * USD_TO_PHP * 100) / 100;
}

function formatPHP(amount) {
  return "₱" + amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function networkList(p) {
  return p.networks ? p.networks.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// What the bot sees for each plan. USD is deliberately NOT included, so the
// bot can only ever quote the peso price.
function describePlan(p) {
  const networks = networkList(p);
  const out = {
    planId: p.planId,
    name: p.name,
    destination: p.destination,
    scope: p.scope,
    data: p.data,
    unlimitedData: p.unlimited,
    validityDays: p.validityDays,
    callsAndTexts: !!p.voiceSms,
    price: formatPHP(toPHP(p.retailPrice)),
    pricePHP: toPHP(p.retailPrice)
  };
  if (Array.isArray(p.countries) && p.scope !== "country") {
    out.coverage = `${p.countries.length} countries`;
    out.countriesCovered = p.countries;
  } else if (networks.length > 0 && networks.length <= 3) out.networks = networks.join(", ");
  else if (networks.length > 3) out.coverage = `${networks.length} partner networks`;
  return out;
}

/**
 * Search plans by destination (with alias/fuzzy handling), optionally
 * narrowed by data amount, validity and whether calls/texts are needed.
 */
function searchPlans({ destination, minDataGB, minDays, maxDays, needsCallsAndTexts, maxResults } = {}) {
  const limit = Math.min(Math.max(maxResults || 25, 1), 200);
  const resolvedNames = resolveDestination(destination);

  if (resolvedNames.length === 0) {
    const q = String(destination || "").trim().toLowerCase();
    return {
      found: false, matchedDestinations: [], plans: [],
      didYouMean: closeDestinations(q, 3).sort((a, b) => editDistance(q, a.toLowerCase()) - editDistance(q, b.toLowerCase())).slice(0, 5),
      note: "No exact match. Check the spelling / didYouMean, try the country name in English, or offer a regional/global plan. Do not tell the customer we don't cover it until you have tried."
    };
  }

  const resolvedSet = new Set(resolvedNames.map((n) => n.toLowerCase()));
  let matches = PLANS.filter((p) => resolvedSet.has(p.destination.toLowerCase()));
  const totalForDestination = matches.length;

  if (typeof minDataGB === "number") matches = matches.filter((p) => dataToNumber(p.data) >= minDataGB);
  if (typeof minDays === "number") matches = matches.filter((p) => (p.validityDays || 0) >= minDays);
  if (typeof maxDays === "number") matches = matches.filter((p) => (p.validityDays || 0) <= maxDays);
  if (needsCallsAndTexts === true) matches = matches.filter((p) => p.voiceSms);

  matches.sort((a, b) => {
    const dataDiff = dataToNumber(a.data) - dataToNumber(b.data);
    if (dataDiff !== 0) return dataDiff;
    const validDiff = (a.validityDays || 0) - (b.validityDays || 0);
    if (validDiff !== 0) return validDiff;
    return (a.retailPrice || 0) - (b.retailPrice || 0);
  });

  const shown = matches.slice(0, limit).map(describePlan);
  return {
    found: shown.length > 0,
    matchedDestinations: resolvedNames,
    totalPlansForDestination: totalForDestination,
    matchingAfterFilters: matches.length,
    note:
      matches.length > limit
        ? `Only the first ${limit} of ${matches.length} matching plans are shown. Use minDataGB / minDays / maxDays / needsCallsAndTexts to narrow the search.`
        : undefined,
    plans: shown
  };
}

/**
 * Trip to several countries (e.g. Austria + Germany): find regional/global
 * plans whose coverage includes ALL of them, so the customer needs ONE eSIM.
 * Regional plans come before global ones (usually cheaper).
 */
function searchMultiCountryPlans({ countries, minDataGB, minDays, maxDays, needsCallsAndTexts, maxResults } = {}) {
  const list = (Array.isArray(countries) ? countries : String(countries || "").split(/,|\band\b|&|\+/i))
    .map((c) => String(c).trim()).filter(Boolean);
  if (list.length < 2) return { found: false, note: "Give at least two countries. For one country use search_esim_plans." };
  const resolved = [], unknown = [];
  for (const c of list) {
    const r = resolveDestination(c).filter((d) => PLANS.some((p) => p.scope === "country" && p.destination === d));
    if (r.length) resolved.push(r[0]); else unknown.push(c);
  }
  const want = resolved.map((c) => c.toLowerCase());
  const covers = (p) => Array.isArray(p.countries) && want.every((w) => p.countries.some((c) => c.toLowerCase() === w));
  let matches = PLANS.filter((p) => p.scope !== "country" && covers(p));
  if (typeof minDataGB === "number") matches = matches.filter((p) => dataToNumber(p.data) >= minDataGB);
  if (typeof minDays === "number") matches = matches.filter((p) => (p.validityDays || 0) >= minDays);
  if (typeof maxDays === "number") matches = matches.filter((p) => (p.validityDays || 0) <= maxDays);
  if (needsCallsAndTexts === true) matches = matches.filter((p) => p.voiceSms);
  const rank = (p) => (p.scope === "regional" ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b) || dataToNumber(a.data) - dataToNumber(b.data) ||
    (a.validityDays || 0) - (b.validityDays || 0) || (a.retailPrice || 0) - (b.retailPrice || 0));
  const limit = Math.min(Math.max(maxResults || 20, 1), 60);
  const regions = [...new Set(matches.map((p) => `${p.destination} (${p.countries.length} countries)`))];
  const plans = matches.slice(0, limit).map((p) => { const d = describePlan(p); delete d.countriesCovered; return d; });
  return {
    found: plans.length > 0,
    countriesRequested: resolved,
    notRecognised: unknown.length ? unknown : undefined,
    plansThatCoverAllOfThem: regions,
    totalMatching: matches.length,
    plans,
    instructionsForYou: plans.length
      ? "Recommend ONE of these multi-country plans first (one eSIM for the whole trip, no switching). " +
        "Only mention separate single-country eSIMs if the customer asks, or if they are clearly cheaper for a very short stop."
      : "No single regional/global plan covers all these countries" + (unknown.length ? ` (couldn't recognise: ${unknown.join(", ")})` : "") +
        ". Offer the best plan per country with search_esim_plans, or ask the customer to confirm the countries."
  };
}

function getPlan(planId) {
  const p = PLANS_BY_ID.get(String(planId || "").trim().toUpperCase());
  return p ? describePlan(p) : null;
}

// Raw catalog entry (includes the USD retail price) -- server-side use only,
// e.g. to look up the reseller price. Never send this to customers.
function getRawPlan(planId) {
  return PLANS_BY_ID.get(String(planId || "").trim().toUpperCase()) || null;
}

function listAllDestinations() {
  return DESTINATIONS;
}

function getRate() {
  return USD_TO_PHP;
}

function getCatalogInfo() {
  return { ...CATALOG_INFO, rate: USD_TO_PHP, destinations: DESTINATIONS.length };
}

// Headline prices for the website's destination cards: the "from" price and
// the cheapest 5GB/30-day, 10GB/30-day and Unlimited/7-day data plans.
function cheapest(list) {
  return list.length ? list.reduce((a, b) => (b.retailPrice < a.retailPrice ? b : a)) : null;
}
function headlinePrices(destination) {
  const d = String(destination || "").toLowerCase();
  const all = PLANS.filter((p) => p.destination.toLowerCase() === d && !p.voiceSms && p.retailPrice > 0);
  if (!all.length) return null;
  const pick = (fn) => {
    const p = cheapest(all.filter(fn));
    return p ? { pricePHP: toPHP(p.retailPrice), price: formatPHP(toPHP(p.retailPrice)), countries: p.countries ? p.countries.length : undefined } : null;
  };
  const isPlus = (p) => /plus|premium/i.test(p.name);
  return {
    destination: all[0].destination,
    from: pick(() => true),
    gb5days30: pick((p) => !p.unlimited && dataToNumber(p.data) === 5 && p.validityDays === 30),
    gb10days30: pick((p) => !p.unlimited && dataToNumber(p.data) === 10 && p.validityDays === 30),
    unlimitedDays7: pick((p) => p.unlimited && !isPlus(p) && p.validityDays === 7)
  };
}


// Regional and global plan groups for the website's route map: the cheapest
// "from" price, the headline plans and the exact list of countries covered.
// Europe comes in two coverage versions (e.g. 37 and 46 countries), Global
// in "Lite" and "Max", so each version is its own group.
function regionSummaries() {
  const groups = new Map();
  PLANS.forEach((p) => {
    if (p.scope === "country" || p.voiceSms || !(p.retailPrice > 0) || !Array.isArray(p.countries)) return;
    let key;
    if (p.scope === "global") key = /max/i.test(p.name) ? "Global Max" : /lite/i.test(p.name) ? "Global Lite" : "Global";
    else key = p.destination + " " + p.countries.length;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  // Regions with a single coverage version also get their plain name ("Asia").
  const perDest = {};
  groups.forEach((list, key) => { if (list[0].scope === "regional") (perDest[list[0].destination] = perDest[list[0].destination] || []).push(key); });
  const out = {};
  groups.forEach((list, key) => {
    if (list.length < 5) return; // odd one-off packages are not a plan family
    const pick = (fn) => { const p = cheapest(list.filter(fn)); return p ? toPHP(p.retailPrice) : null; };
    const isPlus = (p) => /plus|premium/i.test(p.name);
    const summary = {
      from: pick(() => true),
      p5: pick((p) => !p.unlimited && dataToNumber(p.data) === 5 && p.validityDays === 30),
      p10: pick((p) => !p.unlimited && dataToNumber(p.data) === 10 && p.validityDays === 30),
      u7: pick((p) => p.unlimited && !isPlus(p) && p.validityDays === 7),
      cov: [...new Set(list[0].countries)].sort((a, b) => a.localeCompare(b))
    };
    out[key] = summary;
    const d = list[0].destination;
    if (list[0].scope === "regional" && perDest[d].filter((k) => groups.get(k).length >= 5).length === 1) out[d] = summary;
  });
  return out;
}

// Admin console: find plans by words in the name/destination (e.g. "europe 20gb 30").
function findPlansByText(q, limit = 15) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const p of PLANS) {
    const hay = (p.name + " " + p.destination).toLowerCase();
    if (words.every((w) => hay.includes(w))) { out.push(describePlan(p)); if (out.length >= limit) break; }
  }
  return out;
}

module.exports = { searchMultiCountryPlans, findPlansByText, getRawPlan, regionSummaries, searchPlans, getPlan, listAllDestinations, getRate, getCatalogInfo, headlinePrices, setCatalog, formatPHP, toPHP };
