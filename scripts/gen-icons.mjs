// Procedurally renders the app icons (no image assets in the repo). Runs before every build/dev.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size) {
  const px = Buffer.alloc((size * 4 + 1) * size);
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5,
        v = (y + 0.5) / size - 0.5;
      const r = Math.hypot(u, v);
      // background: deep violet radial
      let R = mix(42, 7, Math.min(1, r * 1.8)),
        G = mix(18, 4, Math.min(1, r * 1.8)),
        B = mix(88, 26, Math.min(1, r * 1.8));
      // rift: a glowing diagonal tear
      const d = Math.abs(v + u * 0.55 + Math.sin(u * 18) * 0.025);
      const tear = Math.max(0, 1 - d / 0.05) * Math.max(0, 1 - r / 0.42);
      const glow = Math.max(0, 1 - d / 0.2) * Math.max(0, 1 - r / 0.5) * 0.6;
      R += tear * 255 + glow * 150;
      G += tear * 200 + glow * 80;
      B += tear * 160 + glow * 255;
      // ember ring
      const ring = Math.max(0, 1 - Math.abs(r - 0.36) / 0.018);
      R += ring * 255;
      G += ring * 120;
      B += ring * 30;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      px[o] = Math.min(255, R);
      px[o + 1] = Math.min(255, G);
      px[o + 2] = Math.min(255, B);
      px[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
for (const s of [180, 192, 512]) writeFileSync(`public/icon-${s}.png`, icon(s));
console.log('icons generated');
