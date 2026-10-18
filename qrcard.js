// qrcard.js — branded eSIM QR card: 3UK header and footer from assets/qr-template.png,
// with a plain black-on-white QR in the middle (no logo on the QR itself, so every phone scans it).
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const QRCode = require("qrcode");

let template = null;
function loadTemplate() {
  if (!template) template = PNG.sync.read(fs.readFileSync(path.join(__dirname, "assets", "qr-template.png")));
  return template;
}
// QR area inside the template (pixels)
const AREA = { x: 110, y: 270, size: 680 };

let glyphs = null;
function loadGlyphs() {
  if (glyphs) return glyphs;
  const dir = path.join(__dirname, "assets", "glyphs");
  glyphs = {};
  for (const name of ["label", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) glyphs[name] = PNG.sync.read(fs.readFileSync(path.join(dir, name + ".png")));
  return glyphs;
}
// Alpha-blend a glyph onto the card.
function blit(png, g, x0, y0) {
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const si = (g.width * y + x) << 2, a = g.data[si + 3] / 255;
    if (!a) continue;
    const di = (png.width * (y0 + y) + (x0 + x)) << 2;
    for (let k = 0; k < 3; k++) png.data[di + k] = Math.round(g.data[si + k] * a + png.data[di + k] * (1 - a));
  }
}
// ICCID row, centred in the pill under the QR (digits in groups of 4).
const ICCID_ROW = { cy: 1015 };
function drawIccid(png, iccid) {
  const G = loadGlyphs();
  const digits = String(iccid || "").replace(/\D/g, "").slice(0, 22);
  if (!digits) return;
  const gap = 9;
  let width = G.label.width;
  for (let i = 0; i < digits.length; i++) width += G[digits[i]].width + (i && i % 4 === 0 ? gap : 0);
  let x = Math.round((png.width - width) / 2);
  blit(png, G.label, x, ICCID_ROW.cy - Math.round(G.label.height / 2) + 1); x += G.label.width;
  for (let i = 0; i < digits.length; i++) {
    if (i && i % 4 === 0) x += gap;
    const g = G[digits[i]];
    blit(png, g, x, ICCID_ROW.cy - Math.round(g.height / 2)); x += g.width;
  }
}

function brandedQr(text, iccid) {
  const t = loadTemplate();
  const png = new PNG({ width: t.width, height: t.height });
  t.data.copy(png.data);
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 3;
  const scale = Math.floor(AREA.size / (n + quiet * 2));
  const total = scale * (n + quiet * 2);
  const ox = AREA.x + Math.floor((AREA.size - total) / 2) + quiet * scale;
  const oy = AREA.y + Math.floor((AREA.size - total) / 2) + quiet * scale;
  // white background for the whole QR + quiet zone
  const set = (x, y, v) => { const i = (png.width * y + x) << 2; png.data[i] = png.data[i + 1] = png.data[i + 2] = v; png.data[i + 3] = 255; };
  for (let y = oy - quiet * scale; y < oy - quiet * scale + total; y++) for (let x = ox - quiet * scale; x < ox - quiet * scale + total; x++) set(x, y, 255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) set(ox + c * scale + x, oy + r * scale + y, 0);
  }
  if (iccid) drawIccid(png, iccid);
  return PNG.sync.write(png, { colorType: 2 });
}

module.exports = { brandedQr };
