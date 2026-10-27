// Branded eSIM delivery email (QR code + install steps + order receipt).
// Sends through Resend's HTTPS API (works on Render, where SMTP ports may be blocked).
//
// Setup (Render -> Environment):
//   RESEND_API_KEY = re_...            (resend.com -> API Keys)
//   MAIL_FROM      = 3UK Philippines <orders@3ukph.com>   (domain verified in Resend)
//   MAIL_REPLY_TO  = admin@3ukph.com   (optional)
// Without RESEND_API_KEY nothing is sent and delivery works exactly as before.

const API_KEY = (process.env.RESEND_API_KEY || "").trim();
const FROM = (process.env.MAIL_FROM || "3UK Philippines <orders@3ukph.com>").trim();
const REPLY_TO = (process.env.MAIL_REPLY_TO || "admin@3ukph.com").trim();
const SITE = "https://3ukph.com";

function configured() { return !!API_KEY; }
function validEmail(e) { return /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(String(e || "").trim()); }
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function row(label, value) {
  if (!value) return "";
  return `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;width:150px;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${esc(value)}</td></tr>`;
}

function buildHtml(d) {
  const date = new Date(d.paidAt || Date.now()).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "long", timeStyle: "short" });
  const manual = d.smdp && d.activationCode
    ? `<p style="margin:16px 0 4px;font-size:14px;color:#374151"><b>Or enter it manually</b> (Add eSIM › Enter details manually):</p>
       <table role="presentation" style="width:100%;border-collapse:collapse;background:#f3f4f6;border-radius:8px">
         <tr><td style="padding:10px 12px;font-size:13px;color:#6b7280">SM-DP+ address</td><td style="padding:10px 12px;font-family:Consolas,monospace;font-size:13px;color:#111827;word-break:break-all">${esc(d.smdp)}</td></tr>
         <tr><td style="padding:10px 12px;font-size:13px;color:#6b7280">Activation code</td><td style="padding:10px 12px;font-family:Consolas,monospace;font-size:13px;color:#111827;word-break:break-all">${esc(d.activationCode)}</td></tr>
       </table>` : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef2ff;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" style="background:#eef2ff;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="background:#1e3a8a;padding:22px 24px">
    <table role="presentation" width="100%"><tr>
      <td style="width:56px"><img src="${SITE}/logo.png" width="52" height="52" alt="3UK Philippines" style="border-radius:50%;background:#fff;display:block"></td>
      <td style="padding-left:12px"><div style="color:#ffffff;font-size:20px;font-weight:700">3UK Philippines</div>
        <div style="color:#fcd34d;font-size:13px">Global Connections. Endless Possibilities.</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:26px 24px 8px">
    <h1 style="margin:0 0 8px;font-size:22px;color:#111827">Your eSIM is ready! ✅</h1>
    <p style="margin:0;font-size:15px;color:#374151;line-height:1.5">Hi${d.name ? " " + esc(d.name) : ""}, thank you for your order. Here is your <b>${esc(d.plan)}</b> eSIM. Keep this email: it has your QR code and receipt.</p>
  </td></tr>
  ${d.hasQr ? `<tr><td align="center" style="padding:18px 24px 6px">
    <img src="${esc(d.qrUrl || "cid:esimqr")}" width="280" alt="Your eSIM QR code" style="width:280px;max-width:100%;border:1px solid #e5e7eb;border-radius:12px;display:block">
    <p style="margin:8px 0 0;font-size:12px;color:#6b7280">The QR code can usually be used only once. Don't delete the eSIM after installing it.</p>
  </td></tr>` : ""}
  <tr><td style="padding:16px 24px 4px">
    <h2 style="margin:0 0 8px;font-size:17px;color:#1e3a8a">How to install (on Wi-Fi, before you travel)</h2>
    <p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.55"><b>iPhone:</b> Settings › Cellular (Mobile Data) › Add eSIM › Use QR Code, then scan the QR above (open this email on another screen).</p>
    <p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.55"><b>Android:</b> Settings › Connections › SIM manager › Add eSIM › Scan QR code.</p>
    <p style="margin:0;font-size:14px;color:#374151;line-height:1.55"><b>Only one phone?</b> Save the QR image, then on iPhone press and hold it in Photos and tap "Add eSIM"; on Android use the gallery icon in the QR scanner.</p>
    ${manual}
    <p style="margin:14px 0 0;font-size:14px;color:#374151;line-height:1.55">When you arrive, turn on the eSIM line and <b>Data Roaming</b> for it. Your Philippine SIM can stay in the phone.</p>
  </td></tr>
  ${d.iccid ? `<tr><td style="padding:16px 24px 4px">
    <a href="${SITE}/data?iccid=${encodeURIComponent(d.iccid)}" style="display:inline-block;background:#c8102e;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:8px">📊 Check my remaining data</a>
  </td></tr>` : ""}
  <tr><td style="padding:22px 24px 6px">
    <h2 style="margin:0 0 6px;font-size:17px;color:#1e3a8a">Order receipt</h2>
    <table role="presentation" style="width:100%;border-collapse:collapse;border-top:1px solid #e5e7eb">
      ${row("Order reference", d.reference)}
      ${row("Date", date)}
      ${row("eSIM plan", d.plan)}
      ${row("Amount paid", d.amount)}
      ${row("Payment method", d.method)}
      ${row("ICCID", d.iccid)}
    </table>
    <p style="margin:10px 0 0;font-size:12px;color:#6b7280">This email confirms your payment and order. Need an official receipt for your company? Just reply to this email.</p>
  </td></tr>
  <tr><td style="padding:20px 24px">
    <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;font-size:14px;color:#374151;line-height:1.5">
      Need help installing? We're here 24/7:<br>
      💬 WhatsApp <a href="https://wa.me/639347069356" style="color:#1e3a8a;font-weight:700">+63 934 706 9356</a> · 🌐 <a href="${SITE}" style="color:#1e3a8a;font-weight:700">3ukph.com</a>
    </div>
  </td></tr>
  <tr><td style="background:#1e3a8a;padding:14px 24px;color:#c7d2fe;font-size:12px;line-height:1.5">
    3UK Philippines · DTI- and BIR-registered · Taguig City, Metro Manila, Philippines<br>
    You received this email because you ordered an eSIM from us.
  </td></tr>
</table></td></tr></table></body></html>`;
}

function buildText(d) {
  return [
    `Your eSIM is ready: ${d.plan}`, "",
    "Install it on Wi-Fi before you travel: scan the attached QR code in your phone's eSIM settings (Add eSIM > Use QR code).",
    d.smdp && d.activationCode ? `Manual install: SM-DP+ address ${d.smdp} / Activation code ${d.activationCode}` : "",
    d.iccid ? `ICCID: ${d.iccid}\nCheck your data: ${SITE}/data?iccid=${d.iccid}` : "", "",
    "ORDER RECEIPT", d.reference ? `Order reference: ${d.reference}` : "", `Plan: ${d.plan}`,
    d.amount ? `Amount paid: ${d.amount}` : "", d.method ? `Payment method: ${d.method}` : "", "",
    "Help 24/7: WhatsApp +63 934 706 9356 | 3ukph.com", "3UK Philippines, Taguig City, Metro Manila"
  ].filter((x) => x !== "").join("\n");
}

// d: { to, name, plan, qrUrl, iccid, lpa, smdp, activationCode, qrPng (Buffer), amount, method, reference, paidAt }
async function sendEsimEmail(d) {
  if (!configured()) return { skipped: "RESEND_API_KEY not set" };
  if (!validEmail(d.to)) return { skipped: "no valid email" };
  const data = { ...d, hasQr: !!d.qrPng };
  const body = {
    from: FROM, to: [String(d.to).trim()], reply_to: REPLY_TO,
    subject: `Your eSIM is ready: ${d.plan} | 3UK Philippines`,
    html: buildHtml(data), text: buildText(data),
    // The QR is shown from a hosted URL (works in every mail app) and also attached for download.
    attachments: d.qrPng ? [{ filename: `3UK-eSIM-QR${d.iccid ? "-" + String(d.iccid).slice(-6) : ""}.png`, content: Buffer.from(d.qrPng).toString("base64"), ...(d.qrUrl ? {} : { content_id: "esimqr" }) }] : []
  };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Email not sent (${r.status}): ${j.message || j.name || "unknown error"}`);
  return { id: j.id };
}

module.exports = { configured, validEmail, sendEsimEmail, buildHtml };
