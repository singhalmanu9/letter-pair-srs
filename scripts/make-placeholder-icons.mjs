// Generates placeholder app icons (a 3x3 cube face) into public/.
// Replace the output with real icons when they're ready.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [17, 24, 39];
const TILE = [229, 231, 235];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  // Grid sits in the central 60% so it survives maskable cropping.
  const grid = size * 0.6;
  const start = (size - grid) / 2;
  const gap = grid * 0.06;
  const tile = (grid - 2 * gap) / 3;
  const radius = tile * 0.18;

  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let color = BG;
      const gx = x - start, gy = y - start;
      if (gx >= 0 && gy >= 0 && gx < grid && gy < grid) {
        const cx = Math.floor(gx / (tile + gap)), cy = Math.floor(gy / (tile + gap));
        const lx = gx - cx * (tile + gap), ly = gy - cy * (tile + gap);
        if (lx < tile && ly < tile) {
          const dx = Math.max(radius - lx, lx - (tile - radius), 0);
          const dy = Math.max(radius - ly, ly - (tile - radius), 0);
          if (dx * dx + dy * dy <= radius * radius) color = TILE;
        }
      }
      raw.set(color, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public", { recursive: true });
writeFileSync("public/icon-192.png", png(192));
writeFileSync("public/icon-512.png", png(512));
writeFileSync("public/apple-touch-icon.png", png(180));

const tiles = [];
for (let r = 0; r < 3; r++)
  for (let c = 0; c < 3; c++) tiles.push(`<rect x="${21 + c * 20}" y="${21 + r * 20}" width="18" height="18" rx="3"/>`);
writeFileSync(
  "public/icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#111827"/><g fill="#e5e7eb">${tiles.join("")}</g></svg>\n`,
);
console.log("icons written to public/");
