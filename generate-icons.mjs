import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  const clampedX = Math.max(left + radius, Math.min(x, right - radius));
  const clampedY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - clampedX;
  const dy = y - clampedY;
  return dx * dx + dy * dy <= radius * radius;
}

function makePNG(size) {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / 512;

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const index = (y * size + x) * 4;
    const baseAlpha = pixels[index + 3] / 255;
    const nextAlpha = a / 255;
    const outAlpha = nextAlpha + (baseAlpha * (1 - nextAlpha));
    if (outAlpha <= 0) return;

    pixels[index] = Math.round(((r * nextAlpha) + (pixels[index] * baseAlpha * (1 - nextAlpha))) / outAlpha);
    pixels[index + 1] = Math.round(((g * nextAlpha) + (pixels[index + 1] * baseAlpha * (1 - nextAlpha))) / outAlpha);
    pixels[index + 2] = Math.round(((b * nextAlpha) + (pixels[index + 2] * baseAlpha * (1 - nextAlpha))) / outAlpha);
    pixels[index + 3] = Math.round(outAlpha * 255);
  }

  function toPx(value) {
    return value * scale;
  }

  function drawRoundedRect(left, top, width, height, radius, colorAt) {
    const x0 = Math.max(0, Math.floor(toPx(left)));
    const y0 = Math.max(0, Math.floor(toPx(top)));
    const x1 = Math.min(size - 1, Math.ceil(toPx(left + width)));
    const y1 = Math.min(size - 1, Math.ceil(toPx(top + height)));
    const radiusPx = toPx(radius);

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (!insideRoundedRect(x, y, toPx(left), toPx(top), toPx(width), toPx(height), radiusPx)) {
          continue;
        }
        const color = colorAt(x / scale, y / scale);
        setPixel(x, y, color[0], color[1], color[2], color[3] ?? 255);
      }
    }
  }

  function strokeRoundedRect(left, top, width, height, radius, strokeWidth, color) {
    const x0 = Math.max(0, Math.floor(toPx(left)));
    const y0 = Math.max(0, Math.floor(toPx(top)));
    const x1 = Math.min(size - 1, Math.ceil(toPx(left + width)));
    const y1 = Math.min(size - 1, Math.ceil(toPx(top + height)));
    const outerLeft = toPx(left);
    const outerTop = toPx(top);
    const outerWidth = toPx(width);
    const outerHeight = toPx(height);
    const outerRadius = toPx(radius);
    const innerLeft = toPx(left + strokeWidth);
    const innerTop = toPx(top + strokeWidth);
    const innerWidth = toPx(width - strokeWidth * 2);
    const innerHeight = toPx(height - strokeWidth * 2);
    const innerRadius = toPx(Math.max(0, radius - strokeWidth));

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const inOuter = insideRoundedRect(x, y, outerLeft, outerTop, outerWidth, outerHeight, outerRadius);
        const inInner =
          innerWidth > 0 &&
          innerHeight > 0 &&
          insideRoundedRect(x, y, innerLeft, innerTop, innerWidth, innerHeight, innerRadius);
        if (inOuter && !inInner) {
          setPixel(x, y, color[0], color[1], color[2], color[3] ?? 255);
        }
      }
    }
  }

  function fillEllipse(cx, cy, rx, ry, color, alpha = 255) {
    const left = Math.max(0, Math.floor(toPx(cx - rx)));
    const top = Math.max(0, Math.floor(toPx(cy - ry)));
    const right = Math.min(size - 1, Math.ceil(toPx(cx + rx)));
    const bottom = Math.min(size - 1, Math.ceil(toPx(cy + ry)));
    const cxPx = toPx(cx);
    const cyPx = toPx(cy);
    const rxPx = toPx(rx);
    const ryPx = toPx(ry);

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = (x - cxPx) / rxPx;
        const dy = (y - cyPx) / ryPx;
        const distance = dx * dx + dy * dy;
        if (distance > 1) continue;
        const strength = Math.pow(1 - distance, 1.35);
        setPixel(x, y, color[0], color[1], color[2], Math.round(alpha * strength));
      }
    }
  }

  function fillPolygon(points, colorAt) {
    const scaledPoints = points.map(([x, y]) => [toPx(x), toPx(y)]);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of scaledPoints) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const startY = Math.max(0, Math.floor(minY));
    const endY = Math.min(size - 1, Math.ceil(maxY));

    for (let y = startY; y <= endY; y += 1) {
      const intersections = [];
      for (let index = 0; index < scaledPoints.length; index += 1) {
        const [x1, y1] = scaledPoints[index];
        const [x2, y2] = scaledPoints[(index + 1) % scaledPoints.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          intersections.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      intersections.sort((a, b) => a - b);
      for (let index = 0; index < intersections.length; index += 2) {
        const startX = Math.max(0, Math.ceil(intersections[index]));
        const endX = Math.min(size - 1, Math.floor(intersections[index + 1]));
        for (let x = startX; x <= endX; x += 1) {
          const color = colorAt(x / scale, y / scale);
          setPixel(x, y, color[0], color[1], color[2], color[3] ?? 255);
        }
      }
    }
  }

  function fillRect(left, top, width, height, colorAt) {
    const x0 = Math.max(0, Math.floor(toPx(left)));
    const y0 = Math.max(0, Math.floor(toPx(top)));
    const x1 = Math.min(size - 1, Math.ceil(toPx(left + width)));
    const y1 = Math.min(size - 1, Math.ceil(toPx(top + height)));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const color = colorAt(x / scale, y / scale);
        setPixel(x, y, color[0], color[1], color[2], color[3] ?? 255);
      }
    }
  }

  function drawLine(x1, y1, x2, y2, width, color, alpha = 255) {
    const sx1 = toPx(x1);
    const sy1 = toPx(y1);
    const sx2 = toPx(x2);
    const sy2 = toPx(y2);
    const radius = Math.max(1, toPx(width) / 2);
    const steps = Math.ceil(Math.hypot(sx2 - sx1, sy2 - sy1));
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps;
      const cx = mix(sx1, sx2, t);
      const cy = mix(sy1, sy2, t);
      const left = Math.max(0, Math.floor(cx - radius));
      const top = Math.max(0, Math.floor(cy - radius));
      const right = Math.min(size - 1, Math.ceil(cx + radius));
      const bottom = Math.min(size - 1, Math.ceil(cy + radius));
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > radius) continue;
          const strength = Math.pow(1 - (distance / radius), 1.2);
          setPixel(x, y, color[0], color[1], color[2], Math.round(alpha * strength));
        }
      }
    }
  }

  drawRoundedRect(0, 0, 512, 512, 104, (_x, y) => {
    const t = y / 512;
    return [
      Math.round(mix(0x2f, 0x10, t)),
      Math.round(mix(0x20, 0x0b, t)),
      Math.round(mix(0x17, 0x08, t)),
      255,
    ];
  });

  fillEllipse(256, 188, 168, 132, [0xf1, 0xc9, 0x8c], 62);
  strokeRoundedRect(28, 28, 456, 456, 86, 4, [0xff, 0xf4, 0xe4, 22]);
  fillEllipse(256, 396, 158, 30, [0x00, 0x00, 0x00], 46);

  const coverGradient = (_x, y) => {
    const t = Math.max(0, Math.min(1, (y - 146) / 260));
    return [
      Math.round(mix(0x2a, 0x18, t)),
      Math.round(mix(0x1a, 0x10, t)),
      Math.round(mix(0x12, 0x0c, t)),
      255,
    ];
  };
  const pageGradient = (_x, y) => {
    const t = Math.max(0, Math.min(1, (y - 160) / 208));
    return [
      Math.round(mix(0xfb, 0xe7, t)),
      Math.round(mix(0xf3, 0xd5, t)),
      Math.round(mix(0xe7, 0xb6, t)),
      255,
    ];
  };

  fillPolygon([[112, 156], [178, 128], [250, 138], [250, 408], [180, 386], [112, 418]], coverGradient);
  fillPolygon([[400, 156], [334, 128], [262, 138], [262, 408], [332, 386], [400, 418]], coverGradient);
  fillPolygon([[134, 161], [176, 148], [212, 142], [242, 148], [242, 378], [192, 364], [134, 392]], pageGradient);
  fillPolygon([[378, 161], [336, 148], [300, 142], [270, 148], [270, 378], [320, 364], [378, 392]], pageGradient);

  fillPolygon([[246, 100], [266, 100], [266, 274], [256, 288], [246, 274]], (_x, y) => {
    const t = Math.max(0, Math.min(1, (y - 100) / 188));
    return [
      Math.round(mix(0xd8, 0x9c, t)),
      Math.round(mix(0x89, 0x4f, t)),
      Math.round(mix(0x4f, 0x27, t)),
      255,
    ];
  });

  drawRoundedRect(242, 136, 28, 248, 14, (_x, y) => {
    const t = Math.max(0, Math.min(1, (y - 136) / 248));
    return [
      Math.round(mix(0xeb, 0xbc, t)),
      Math.round(mix(0xcb, 0x85, t)),
      Math.round(mix(0x97, 0x50, t)),
      255,
    ];
  });

  const lineColor = [0xb6, 0x92, 0x67];
  [
    [158, 206, 226, 194],
    [158, 244, 226, 234],
    [158, 282, 226, 274],
    [158, 320, 226, 314],
    [354, 206, 286, 194],
    [354, 244, 286, 234],
    [354, 282, 286, 274],
    [354, 320, 286, 314],
  ].forEach(([x1, y1, x2, y2]) => drawLine(x1, y1, x2, y2, 6, lineColor, 180));

  fillRect(246, 100, 20, 16, () => [0xef, 0xb3, 0x77, 70]);

  const rowSize = size * 4 + 1;
  const raw = Buffer.alloc(size * rowSize);
  for (let y = 0; y < size; y += 1) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4;
      const dst = y * rowSize + 1 + x * 4;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'public');
for (const size of [192, 512]) {
  const output = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(output, makePNG(size));
  console.log(`Written ${output}`);
}
