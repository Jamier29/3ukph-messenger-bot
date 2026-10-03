// priceSync.js
//
// Keeps website + bot prices in step with your price sheet automatically.
//
// How it works:
//   1. You keep your price list in Google Sheets and publish it
//      (File > Share > Publish to web > Entire document > Microsoft Excel .xlsx).
//   2. Put that link in Render as the environment variable PRICE_SHEET_URL.
//   3. Every PRICE_SYNC_MINUTES (default 30) the server downloads the sheet,
//      checks it, and swaps in the new prices. Nothing to redeploy.
//
// Safety: if the download fails or the sheet looks wrong (missing columns,
// too few plans, bad prices), the server keeps the last good prices and logs
// why. Customers never see a broken or empty price list.
//
// The peso price is always Retail Price (USD) x the rate. The rate is read
// from a "Settings" tab if it has one (first number between 40 and 100),
// otherwise the rate in planSearch.js (65) stays.

const ExcelJS = require("exceljs");
const { setCatalog, getCatalogInfo } = require("./planSearch");

const SHEET_URL = (process.env.PRICE_SHEET_URL || "").trim();
const SYNC_MINUTES = Math.max(5, Number(process.env.PRICE_SYNC_MINUTES) || 30);
const MIN_PLANS = 500; // a real price list has thousands; fewer means something went wrong

let lastResult = { ok: null, message: SHEET_URL ? "Not synced yet." : "PRICE_SHEET_URL is not set, using built-in prices.", at: null };
let running = false;

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result); // formula cell
  }
  return String(v);
}
function cellNumber(v) {
  if (v && typeof v === "object" && v.result !== undefined) v = v.result;
  const n = typeof v === "number" ? v : parseFloat(String(v || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function scopeFromSheetName(name) {
  const n = name.toLowerCase();
  if (n.startsWith("country")) return "country";
  if (n.startsWith("regional")) return "regional";
  if (n.startsWith("global")) return "global";
  return null;
}

// Turn the workbook into the same plan shape as data/plans.json.
function workbookToCatalog(wb) {
  const plans = [];
  const problems = [];
  let rate;

  wb.eachSheet((ws) => {
    if (/^settings$/i.test(ws.name.trim())) {
      ws.eachRow((row) => {
        row.eachCell((c) => {
          const n = cellNumber(c.value);
          if (rate === undefined && n >= 40 && n <= 100) rate = Math.round(n * 100) / 100;
        });
      });
      return;
    }
    const scope = scopeFromSheetName(ws.name);
    if (!scope) return; // e.g. "Website Prices" summary tab, ignored

    const header = {};
    ws.getRow(1).eachCell((c, col) => (header[cellText(c.value).trim().toLowerCase()] = col));
    const col = (name) => header[name];
    const need = ["destination", "name", "package type", "data", "validity", "retail price"];
    const missing = need.filter((h) => !col(h));
    if (missing.length) {
      problems.push(`Tab "${ws.name}" is missing column(s): ${missing.join(", ")}`);
      return;
    }

    ws.eachRow((row, r) => {
      if (r === 1) return;
      const destination = cellText(row.getCell(col("destination")).value).trim();
      const name = cellText(row.getCell(col("name")).value).trim();
      if (!destination || !name) return;
      const price = cellNumber(row.getCell(col("retail price")).value);
      if (!(price > 0)) {
        problems.push(`Tab "${ws.name}" row ${r}: price is missing or not a number`);
        return;
      }
      const data = cellText(row.getCell(col("data")).value).trim();
      const plan = {
        destination,
        scope,
        name,
        voiceSms: /voice|sms/i.test(cellText(row.getCell(col("package type")).value)),
        unlimited: /unlimited/i.test(data),
        data,
        validityDays: Math.round(cellNumber(row.getCell(col("validity")).value)) || 0,
        retailPrice: Math.round(price * 100) / 100,
        networks: col("supported networks") ? cellText(row.getCell(col("supported networks")).value).trim() : ""
      };
      if (scope !== "country" && col("supported countries")) {
        plan.countries = cellText(row.getCell(col("supported countries")).value)
          .split(",").map((s) => s.trim()).filter(Boolean);
      }
      plans.push(plan);
    });
  });

  return { plans, problems, rate };
}

async function syncPrices(reason = "scheduled") {
  if (!SHEET_URL) return lastResult;
  if (running) return { ok: false, message: "A sync is already running.", at: new Date().toISOString() };
  running = true;
  const at = new Date().toISOString();
  try {
    const res = await fetch(SHEET_URL, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}). Is the sheet still published to the web?`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.slice(0, 2).toString() !== "PK") throw new Error("The link did not return an Excel file. Publish it as 'Microsoft Excel (.xlsx)'.");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const { plans, problems, rate } = workbookToCatalog(wb);

    if (plans.length < MIN_PLANS) {
      throw new Error(`Only ${plans.length} plans found (expected thousands). ${problems.slice(0, 3).join(" | ")}`);
    }
    if (problems.length > plans.length * 0.05) {
      throw new Error(`Too many problem rows (${problems.length}). First ones: ${problems.slice(0, 3).join(" | ")}`);
    }

    setCatalog(plans, { rate, source: "Google Sheet (PRICE_SHEET_URL)", updatedAt: at });
    const info = getCatalogInfo();
    lastResult = {
      ok: true,
      at,
      reason,
      message: `Loaded ${info.planCount} plans for ${info.destinations} destinations at ₱${info.rate} per USD.` +
        (problems.length ? ` Skipped ${problems.length} bad row(s), e.g. ${problems[0]}` : "")
    };
    console.log(`[prices] ${lastResult.message}`);
  } catch (err) {
    lastResult = { ok: false, at, reason, message: `Kept previous prices. ${err.message}` };
    console.error(`[prices] ${lastResult.message}`);
  } finally {
    running = false;
  }
  return lastResult;
}

function startPriceSync() {
  if (!SHEET_URL) {
    console.log("[prices] PRICE_SHEET_URL not set, using built-in prices from data/plans.json.");
    return;
  }
  console.log(`[prices] Auto-update on: checking the price sheet every ${SYNC_MINUTES} minutes.`);
  syncPrices("startup");
  setInterval(() => syncPrices("scheduled"), SYNC_MINUTES * 60 * 1000).unref();
}

function getSyncStatus() {
  return { ...lastResult, autoUpdate: !!SHEET_URL, everyMinutes: SYNC_MINUTES, catalog: getCatalogInfo() };
}

module.exports = { startPriceSync, syncPrices, getSyncStatus, workbookToCatalog };
