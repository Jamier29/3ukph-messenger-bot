// planSearch.js
//
// Loads data/plans.json (built from the reseller pricing spreadsheet) and
// provides a search function the bot calls as a tool, instead of the raw
// catalog being stuffed into every prompt (6,493 plans is far too much
// to send on every message).

const fs = require("fs");
const path = require("path");

const PLANS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "plans.json"), "utf8"));
const DESTINATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "destinations.json"), "utf8"));
const DESTINATIONS_LOWER = DESTINATIONS.map((d) => d.toLowerCase());

// Common alternate names customers might type. Add more here any time you
// notice the bot missing a match in real conversations.
const ALIASES = {
  "uk": "United Kingdom",
  "u.k.": "United Kingdom",
  "england": "United Kingdom",
  "britain": "United Kingdom",
  "great britain": "United Kingdom",
  "us": "United States",
  "u.s.": "United States",
  "usa": "United States",
  "u.s.a.": "United States",
  "america": "United States",
  "uae": "United Arab Emirates",
  "emirates": "United Arab Emirates",
  "korea": "South Korea",
  "hk": "Hong Kong",
  "ph": "Philippines",
  "phils": "Philippines",
  "hong kong sar": "Hong Kong"
};

function resolveDestination(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  if (ALIASES[q]) return [ALIASES[q]];

  // Exact match against a real destination name.
  const exactIdx = DESTINATIONS_LOWER.indexOf(q);
  if (exactIdx !== -1) return [DESTINATIONS[exactIdx]];

  // Substring match either direction (query inside a name, or a name inside
  // the query) — catches things like "japan" vs "Japan" already handled
  // above, but also partial typing and country names embedded in a longer
  // customer message if ever passed straight through.
  const matches = DESTINATIONS.filter((d, i) => DESTINATIONS_LOWER[i].includes(q) || q.includes(DESTINATIONS_LOWER[i]));
  return matches;
}

// Rough numeric GB value for sorting ("20GB" -> 20, "Unlimited" -> Infinity).
function dataToNumber(dataStr) {
  if (!dataStr) return 0;
  if (/unlimited/i.test(dataStr)) return Infinity;
  const m = String(dataStr).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Search plans by destination name (with alias/fuzzy handling), optionally
 * narrowed by minimum data amount or max validity days. Returns up to
 * `limit` plans, sorted by data amount then validity then price.
 */
function searchPlans({ destination, maxResults } = {}) {
  const limit = Math.min(Math.max(maxResults || 30, 1), 60);
  const resolvedNames = resolveDestination(destination);

  if (resolvedNames.length === 0) {
    return { found: false, matchedDestinations: [], plans: [] };
  }

  const resolvedSet = new Set(resolvedNames.map((n) => n.toLowerCase()));
  let matches = PLANS.filter((p) => resolvedSet.has(p.destination.toLowerCase()));

  matches = matches
    .slice()
    .sort((a, b) => {
      const dataDiff = dataToNumber(a.data) - dataToNumber(b.data);
      if (dataDiff !== 0) return dataDiff;
      const validDiff = (a.validityDays || 0) - (b.validityDays || 0);
      if (validDiff !== 0) return validDiff;
      return (a.retailPrice || 0) - (b.retailPrice || 0);
    })
    .slice(0, limit)
    .map((p) => {
      const out = {
        destination: p.destination,
        scope: p.scope,
        data: p.data,
        unlimited: p.unlimited,
        validityDays: p.validityDays,
        priceUSD: p.retailPrice,
        voiceSms: p.voiceSms
      };
      // Only include carrier names when the list is short (country-specific
      // plans usually have 1-3); regional/global plans can list 70+ carriers,
      // which isn't useful to show a customer.
      const networkCount = p.networks ? p.networks.split(",").length : 0;
      if (networkCount > 0 && networkCount <= 3) out.networks = p.networks;
      return out;
    });

  return {
    found: matches.length > 0,
    matchedDestinations: resolvedNames,
    totalMatchesBeforeLimit: PLANS.filter((p) => resolvedSet.has(p.destination.toLowerCase())).length,
    plans: matches
  };
}

function listAllDestinations() {
  return DESTINATIONS;
}

module.exports = { searchPlans, listAllDestinations };
