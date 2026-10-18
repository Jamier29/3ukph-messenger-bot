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

function brandedQr(text) {
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
  return PNG.sync.write(png, { colorType: 2 });
}

module.exports = { brandedQr };
