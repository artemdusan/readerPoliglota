// Generates public/icon-192.png and public/icon-512.png from scratch using Node built-ins only.
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CRC32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function makePNG(size) {
  const s = size;
  // RGBA pixels
  const pixels = new Uint8Array(s * s * 4);

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= s || y < 0 || y >= s) return;
    const i = (y * s + x) * 4;
    // alpha blending over existing
    const ao = pixels[i + 3] / 255;
    const an = a / 255;
    const out = an + ao * (1 - an);
    if (out === 0) return;
    pixels[i]     = Math.round((r * an + pixels[i]     * ao * (1 - an)) / out);
    pixels[i + 1] = Math.round((g * an + pixels[i + 1] * ao * (1 - an)) / out);
    pixels[i + 2] = Math.round((b * an + pixels[i + 2] * ao * (1 - an)) / out);
    pixels[i + 3] = Math.round(out * 255);
  }

  // Scale factor: design is 512x512
  const sc = s / 512;

  // Background: #0e0d0b with rounded corners (rx=96 scaled)
  const rx = Math.round(96 * sc);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Check rounded corners
      let inCorner = false;
      const cx = x < rx ? rx : x > s - 1 - rx ? s - 1 - rx : x;
      const cy = y < rx ? rx : y > s - 1 - rx ? s - 1 - rx : y;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > rx * rx) inCorner = true;
      if (!inCorner) setPixel(x, y, 0x0e, 0x0d, 0x0b);
    }
  }

  // Translate to center (256,256) -> (s/2, s/2)
  const ox = s / 2, oy = s / 2;

  function sc2px(vx, vy) { return [ox + vx * sc, oy + vy * sc]; }

  // Draw filled polygon
  function fillPoly(points, r, g, b, a) {
    // find bounding box
    let minY = Infinity, maxY = -Infinity;
    for (const [, py] of points) { minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(s - 1, Math.ceil(maxY));
    for (let y = minY; y <= maxY; y++) {
      const intersects = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          intersects.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
        }
      }
      intersects.sort((a, b) => a - b);
      for (let k = 0; k < intersects.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(intersects[k]));
        const x1 = Math.min(s - 1, Math.floor(intersects[k + 1]));
        for (let x = x0; x <= x1; x++) setPixel(x, y, r, g, b, a);
      }
    }
  }

  // Left page: M-140,-90 C-140,-90 -80,-80 -20,-60 L-20,130 C-80,110 -140,120 -140,120
  // Approximate with polygon
  const leftPage = [
    sc2px(-140, -90), sc2px(-80, -80), sc2px(-20, -60),
    sc2px(-20, 130), sc2px(-80, 110), sc2px(-140, 120),
  ];
  fillPoly(leftPage, 0xf5, 0xf0, 0xe8, Math.round(0.95 * 255));

  // Right page
  const rightPage = [
    sc2px(140, -90), sc2px(80, -80), sc2px(20, -60),
    sc2px(20, 130), sc2px(80, 110), sc2px(140, 120),
  ];
  fillPoly(rightPage, 0xf5, 0xf0, 0xe8, Math.round(0.85 * 255));

  // Spine: rect x=-8 y=-65 w=16 h=200 rx=4
  const spineX = ox - 8 * sc, spineY = oy - 65 * sc;
  const spineW = 16 * sc, spineH = 200 * sc;
  for (let y = Math.floor(spineY); y <= Math.ceil(spineY + spineH); y++) {
    for (let x = Math.floor(spineX); x <= Math.ceil(spineX + spineW); x++) {
      setPixel(x, y, 0xc8, 0xb8, 0x9a);
    }
  }

  // Lines (left page)
  const lineData = [
    [-120, -30, -30, -20], [-120, 0, -30, 8], [-120, 30, -30, 36], [-120, 60, -30, 64],
    [120, -30, 30, -20],   [120, 0, 30, 8],   [120, 30, 30, 36],   [120, 60, 30, 64],
  ];
  const lw = Math.max(2, Math.round(6 * sc));
  for (const [x1, y1, x2, y2] of lineData) {
    const [px1, py1] = sc2px(x1, y1);
    const [px2, py2] = sc2px(x2, y2);
    const steps = Math.ceil(Math.sqrt((px2-px1)**2 + (py2-py1)**2));
    for (let t = 0; t <= steps; t++) {
      const fx = px1 + (px2-px1)*t/steps;
      const fy = py1 + (py2-py1)*t/steps;
      for (let dy = -lw/2; dy <= lw/2; dy++) {
        for (let dx = -lw/2; dx <= lw/2; dx++) {
          if (dx*dx + dy*dy <= (lw/2)*(lw/2))
            setPixel(Math.round(fx+dx), Math.round(fy+dy), 0xc8, 0xb8, 0x9a);
        }
      }
    }
  }

  // Build raw PNG image data (RGBA)
  const rowSize = s * 4 + 1;
  const raw = Buffer.alloc(s * rowSize);
  for (let y = 0; y < s; y++) {
    raw[y * rowSize] = 0; // filter none
    for (let x = 0; x < s; x++) {
      const src = (y * s + x) * 4;
      const dst = y * rowSize + 1 + x * 4;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(s, 0); ihdrData.writeUInt32BE(s, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'public');
for (const size of [192, 512]) {
  const buf = makePNG(size);
  const out = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(out, buf);
  console.log(`Written ${out} (${buf.length} bytes)`);
}
