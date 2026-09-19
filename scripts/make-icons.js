'use strict';

// Draws the Flat icon at every size the desktop file, .DirIcon and
// the AppStream metadata need, with no image library on the machine.
//
// The artwork is square, and everything that carries meaning sits inside a
// circle of radius 0.40 around the centre — a launcher that crops icons to a
// circle clips only background.
//
//   node scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];
const OUT_DIR = path.join(__dirname, '..', 'build', 'icons');

// Brand yellow ground, brand navy artwork. This way round because it is the
// pair that survives a tray: a dark mark on a bright badge stays readable at
// 22px against any panel colour, where a dark badge disappears into a dark
// panel.
const GROUND = [0xfb, 0xc7, 0x11];
const MARK = [0x11, 0x18, 0x27];

// --------------------------------------------------------------------------
// Geometry, all in a 0..1 unit square
// --------------------------------------------------------------------------

function insideRoundedRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Distance from a point to a line segment: strokes are drawn as capsules.
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

const BOX = { x: 0.255, y: 0.545, w: 0.49, h: 0.245, r: 0.055 };
const STROKE = 0.052;
const ARROW = { x: 0.5, top: 0.205, tip: 0.515, wing: 0.108 };

// Returns the colour at a point, or null for the background.
function artworkAt(px, py) {
  // The tray, drawn as an outline. Two colours only: the inside of it is the
  // yellow ground, not a wash of the mark colour over it. A tinted fill was a
  // third tone in an icon that is meant to be brand yellow and brand navy.
  const outer = insideRoundedRect(px, py, BOX.x, BOX.y, BOX.w, BOX.h, BOX.r);
  if (outer) {
    const inner = insideRoundedRect(
      px, py,
      BOX.x + STROKE, BOX.y + STROKE,
      BOX.w - STROKE * 2, BOX.h - STROKE * 2,
      Math.max(0.001, BOX.r - STROKE),
    );
    if (!inner) return { colour: MARK, alpha: 1 };
    return null;
  }

  // The arrow going into it.
  const half = STROKE / 2;
  const shaft = distanceToSegment(px, py, ARROW.x, ARROW.top, ARROW.x, ARROW.tip);
  const left = distanceToSegment(px, py, ARROW.x, ARROW.tip, ARROW.x - ARROW.wing, ARROW.tip - ARROW.wing);
  const right = distanceToSegment(px, py, ARROW.x, ARROW.tip, ARROW.x + ARROW.wing, ARROW.tip - ARROW.wing);
  if (Math.min(shaft, left, right) <= half) return { colour: MARK, alpha: 1 };

  return null;
}

// --------------------------------------------------------------------------
// Rasteriser
// --------------------------------------------------------------------------

// 4x4 samples per pixel. Nothing here is animated or resized at runtime, so
// the cost is paid once at build time and the edges come out clean.
const SAMPLES = 4;

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES);
  const bgRadius = 0.235; // rounded-square corner, as a fraction of the side

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x * SAMPLES + sx + 0.5) * step;
          const py = (y * SAMPLES + sy + 0.5) * step;

          if (!insideRoundedRect(px, py, 0.02, 0.02, 0.96, 0.96, bgRadius)) continue;

          const art = artworkAt(px, py);
          let cr = GROUND[0]; let cg = GROUND[1]; let cb = GROUND[2];
          if (art) {
            cr = GROUND[0] + (art.colour[0] - GROUND[0]) * art.alpha;
            cg = GROUND[1] + (art.colour[1] - GROUND[1]) * art.alpha;
            cb = GROUND[2] + (art.colour[2] - GROUND[2]) * art.alpha;
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }

      const total = SAMPLES * SAMPLES;
      const coverage = a / total;
      const i = (y * size + x) * 4;
      if (coverage > 0) {
        // Straight (non-premultiplied) alpha: divide the colour by the
        // number of samples that actually landed on the shape, not by all
        // of them, or every edge pixel comes out dark.
        const hits = a / 255;
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round(coverage);
      }
    }
  }
  return rgba;
}

// --------------------------------------------------------------------------
// PNG
// --------------------------------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // One filter byte per scanline, filter type 0. The images are small and
  // flat, so a cleverer filter would buy nothing worth the code.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// --------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `${size}x${size}.png`);
  writePng(file, size, render(size));
  process.stdout.write(`${path.relative(process.cwd(), file)}\n`);
}
