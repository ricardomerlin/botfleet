// Renders the BotFleet icon (gradient tile + double chevron) to PNGs with no dependencies.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const lerp = (a, b, t) => a + (b - a) * t;
const A = [139, 108, 255], B = [34, 211, 238];

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Shapes in a 64x64 design space (matches server/public/logo.svg).
function sample(x, y) {
  const r = 16;
  const cx = Math.min(Math.max(x, r), 64 - r), cy = Math.min(Math.max(y, r), 64 - r);
  if (Math.hypot(x - cx, y - cy) > r) return null;
  const t = (x + y) / 128;
  let c = [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
  const white = (alpha) => (c = c.map((v) => lerp(v, 255, alpha)));
  if (Math.min(distSeg(x, y, 22, 50, 32, 40), distSeg(x, y, 32, 40, 42, 50)) < 2.5) white(0.55);
  if (Math.min(distSeg(x, y, 18, 40, 32, 26), distSeg(x, y, 32, 26, 46, 40)) < 3) white(1);
  if (Math.hypot(x - 32, y - 15) < 4) white(1);
  return c;
}

function render(size) {
  const ss = 4, px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
      const c = sample(((i + (si + 0.5) / ss) / size) * 64, ((j + (sj + 0.5) / ss) / size) * 64);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (j * size + i) * 4;
    if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = (255 * a) / (ss * ss); }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), png(s));
console.log("icons written to", out);
