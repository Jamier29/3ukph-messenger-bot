// payFees.js
//
// PayMongo processing fees, so discounts never push a sale below cost and the
// Morning Brief shows real profit (after payment fees).
//
// Rates from paymongo.com/pricing (Nov 2026), VAT-exclusive; 12% VAT is charged on the fee.
// Cards: we don't know at checkout whether a card is local or foreign, so we use the
// higher foreign-card rate (4.02% + ₱13.39) to stay safe.
// Override in Render with PAYMONGO_FEES, JSON like {"card":[0.0402,13.39],"gcash":[0.0223,0]}.
//
// CARD_MIN_PHP (default 300): card payments only for orders of at least this amount,
// because the fixed card fee (about ₱15 with VAT) eats the profit on small orders.

const VAT = 1.12;
const DEFAULT = {
  qrph: [0.0134, 0],
  gcash: [0.0223, 0],
  paymaya: [0.0179, 0],
  grab_pay: [0.0196, 0],
  shopee_pay: [0.017, 0],
  card: [0.0402, 13.39],
  dob: [0.0071, 0],
  billease: [0.015, 0]
};
let RATES = { ...DEFAULT };
try { if (process.env.PAYMONGO_FEES) RATES = { ...DEFAULT, ...JSON.parse(process.env.PAYMONGO_FEES) }; } catch (e) { console.error("[fees] PAYMONGO_FEES is not valid JSON, using defaults"); }

const CARD_MIN_PHP = Number(process.env.CARD_MIN_PHP ?? 300);
const round2 = (n) => Math.round(n * 100) / 100;

// "GCash (PayMongo)", "paymaya", "card", "Credit/Debit card", "QR Ph" ... -> rate key
function keyOf(method) {
  const s = String(method || "").toLowerCase();
  if (/card|visa|master/.test(s)) return "card";
  if (/gcash/.test(s)) return "gcash";
  if (/maya/.test(s)) return "paymaya";
  if (/grab/.test(s)) return "grab_pay";
  if (/shopee/.test(s)) return "shopee_pay";
  if (/qr ?ph|qrph|instapay/.test(s)) return "qrph";
  if (/dob|bpi|union|bank/.test(s)) return "dob";
  return null;
}

// Fee in pesos (VAT included) for one PayMongo payment.
function feeFor(method, amountPHP) {
  const r = RATES[keyOf(method)] || RATES.gcash; // unknown PayMongo method: assume the GCash rate
  return round2((Number(amountPHP) * r[0] + r[1]) * VAT);
}

// The highest fee a payment of this size could cost us (used for the discount safety floor).
function worstFee(amountPHP, cardEnabled) {
  const others = Object.keys(RATES).filter((k) => k !== "card").map((k) => feeFor(k, amountPHP));
  const worst = Math.max(...others);
  return cardEnabled && Number(amountPHP) >= CARD_MIN_PHP ? Math.max(worst, feeFor("card", amountPHP)) : worst;
}

module.exports = { feeFor, worstFee, keyOf, CARD_MIN_PHP };
