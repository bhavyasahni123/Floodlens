// Generates FloodLens PWA icons (navy tile + white water drop) with no dependencies.
// Usage: node scripts/make-icons.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const navy = [22, 41, 92], white = [255, 255, 255];
  const r = maskable ? 0 : size * 0.18; // rounded corners unless maskable (full bleed)
  const scale = maskable ? 0.62 : 0.78; // keep drop inside the maskable safe zone
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded-rect alpha
      const cx = Math.min(Math.max(x + 0.5, r), size - r), cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = r === 0 || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      // drop shape in unit coords: circle bottom + triangle top
      const u = ((x + 0.5) / size - 0.5) / scale, v = ((y + 0.5) / size - 0.5) / scale;
      const circle = Math.hypot(u, v - 0.12) <= 0.26;
      const tri = v >= -0.36 && v <= 0.12 && Math.abs(u) <= ((v + 0.36) / 0.48) * 0.245;
      const col = circle || tri ? white : navy;
      raw[i] = col[0]; raw[i + 1] = col[1]; raw[i + 2] = col[2]; raw[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.resolve(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(out, name), png(size, maskable));
}
console.log('icons written to', out);
