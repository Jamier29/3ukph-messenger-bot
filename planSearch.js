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

  return DESTINATIONS.filter((d, i) => DESTINATIONS_LOWER[i].includes(q) || q.includes(DESTINATIONS_LOWER[i]));
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
    return { found: false, matchedDestinations: [], plans: [] };
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

function getPlan(planId) {
  const p = PLANS_BY_ID.get(String(planId || "").trim().toUpperCase());
  return p ? describePlan(p) : null;
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

module.exports = { searchPlans, getPlan, listAllDestinations, getRate, getCatalogInfo, headlinePrices, setCatalog, formatPHP, toPHP };
