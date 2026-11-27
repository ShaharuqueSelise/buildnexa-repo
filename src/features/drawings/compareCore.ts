// Revision impact: which parts of a sheet changed between two revisions. Pure maths on two "ink"
// masks (1 = dark pixel) of page 1 rendered at the same width; compare.ts renders them with pdf.js.
// No DOM here, so tools/test-compare.mjs runs it in Node.
//
// 1. Different page shape (more than 1 %): "notComparable", every pinned item is to check.
// 2. Find the small shift between the two renders (plotters and PDF exports move a sheet by a few
//    pixels): coarse search on a quarter-size copy, then a fine one at full size.
// 3. Thicken the lines of both by 2 px, so anti-aliasing and tiny shifts don't count; a pixel has
//    changed when it is ink in one and not near ink in the other.
// 4. Count changes in 8 px cells, group cells that are close (3 cells), drop specks, merge boxes.
// 5. More than 40 areas or more than 35 % of the page: "redrawn" (check everything).

export type Mask = { w: number; h: number; data: Uint8Array };
export type Area = { x: number; y: number; w: number; h: number };
export type CompareResult = { status: "compared" | "redrawn" | "notComparable"; areas: Area[] };

const SHAPE_TOLERANCE = 0.01;
const COARSE = 4; // quarter size
const COARSE_RANGE = 4; // ±4 quarter pixels = ±16 px
const FINE_RANGE = 2;
const THICKEN = 2;
const CELL = 8;
const CELL_MIN = 6; // changed pixels for a cell to count
const GAP = 3; // cells
const SPECK = 40; // changed pixels: smaller groups are noise
const MAX_AREAS = 40;
const MAX_COVER = 0.35;

/** 1 where the RGBA pixel is dark enough to be a line or text. */
export function inkMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, threshold = 160): Mask {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 1, j += 4) {
    const a = (rgba[j + 3] ?? 255) / 255;
    // Transparent counts as white paper.
    const lum = 255 - a * (255 - (0.299 * (rgba[j] ?? 0) + 0.587 * (rgba[j + 1] ?? 0) + 0.114 * (rgba[j + 2] ?? 0)));
    data[i] = lum < threshold ? 1 : 0;
  }
  return { w, h, data };
}

function shrink(m: Mask, f: number): Mask {
  const w = Math.floor(m.w / f);
  const h = Math.floor(m.h / f);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let any = 0;
      for (let yy = 0; yy < f && !any; yy += 1) {
        const row = (y * f + yy) * m.w + x * f;
        for (let xx = 0; xx < f; xx += 1) if (m.data[row + xx]) { any = 1; break; }
      }
      data[y * w + x] = any;
    }
  }
  return { w, h, data };
}

/** How many ink pixels of `a` also are ink in `b` moved by (dx, dy), minus the ones that aren't. */
function overlap(a: Mask, b: Mask, dx: number, dy: number, step = 1) {
  let score = 0;
  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  for (let y = 0; y < h; y += step) {
    const by = y + dy;
    if (by < 0 || by >= b.h) continue;
    for (let x = 0; x < w; x += step) {
      if (!a.data[y * a.w + x]) continue;
      const bx = x + dx;
      score += bx >= 0 && bx < b.w && b.data[by * b.w + bx] ? 1 : -1;
    }
  }
  return score;
}

/** The shift (in full-size pixels) that lines `b` up with `a`. */
export function bestShift(a: Mask, b: Mask): { dx: number; dy: number } {
  const ca = shrink(a, COARSE);
  const cb = shrink(b, COARSE);
  let best = { dx: 0, dy: 0, s: overlap(ca, cb, 0, 0) };
  for (let dy = -COARSE_RANGE; dy <= COARSE_RANGE; dy += 1) {
    for (let dx = -COARSE_RANGE; dx <= COARSE_RANGE; dx += 1) {
      const s = overlap(ca, cb, dx, dy);
      if (s > best.s) best = { dx, dy, s };
    }
  }
  const cx = best.dx * COARSE;
  const cy = best.dy * COARSE;
  let fine = { dx: cx, dy: cy, s: overlap(a, b, cx, cy, 2) };
  for (let dy = cy - FINE_RANGE; dy <= cy + FINE_RANGE; dy += 1) {
    for (let dx = cx - FINE_RANGE; dx <= cx + FINE_RANGE; dx += 1) {
      const s = overlap(a, b, dx, dy, 2);
      if (s > fine.s) fine = { dx, dy, s };
    }
  }
  return { dx: fine.dx, dy: fine.dy };
}

/** `b` moved by (dx, dy) into a w × h frame. */
function moved(b: Mask, dx: number, dy: number, w: number, h: number): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const by = y + dy;
    if (by < 0 || by >= b.h) continue;
    for (let x = 0; x < w; x += 1) {
      const bx = x + dx;
      if (bx >= 0 && bx < b.w) data[y * w + x] = b.data[by * b.w + bx] ?? 0;
    }
  }
  return { w, h, data };
}

function cropTo(m: Mask, w: number, h: number): Mask {
  if (m.w === w && m.h === h) return m;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) data.set(m.data.subarray(y * m.w, y * m.w + w), y * w);
  return { w, h, data };
}

/** Lines made `r` pixels thicker (a square around every ink pixel). */
export function thicken(m: Mask, r: number): Mask {
  const { w, h } = m;
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    let last = -Infinity;
    // Left to right, then right to left: within r of an ink pixel on the same row.
    for (let x = 0; x < w; x += 1) {
      if (m.data[y * w + x]) last = x;
      if (x - last <= r) rows[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x -= 1) {
      if (m.data[y * w + x]) last = x;
      if (last - x <= r) rows[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    let last = -Infinity;
    for (let y = 0; y < h; y += 1) {
      if (rows[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y -= 1) {
      if (rows[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return { w, h, data: out };
}

type Box = { x0: number; y0: number; x1: number; y1: number; px: number };

function mergeBoxes(boxes: Box[]): Box[] {
  const list = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < list.length && !changed; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          list[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), px: a.px + b.px };
          list.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return list;
}

/** The changed areas between the older (`a`) and the newer (`b`) render, as fractions of the page. */
export function compareMasks(a: Mask, b: Mask): CompareResult {
  if (!a.w || !a.h || !b.w || !b.h) return { status: "notComparable", areas: [] };
  const ra = a.h / a.w;
  const rb = b.h / b.w;
  if (Math.abs(ra - rb) / ra > SHAPE_TOLERANCE) return { status: "notComparable", areas: [] };

  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  const { dx, dy } = bestShift(a, b);
  const A = cropTo(a, w, h);
  const B = moved(b, dx, dy, w, h);
  const At = thicken(A, THICKEN);
  const Bt = thicken(B, THICKEN);

  const gw = Math.ceil(w / CELL);
  const gh = Math.ceil(h / CELL);
  const cells = new Uint16Array(gw * gh);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if ((A.data[i] && !Bt.data[i]) || (B.data[i] && !At.data[i])) {
        const k = ((y / CELL) | 0) * gw + ((x / CELL) | 0);
        cells[k] = (cells[k] ?? 0) + 1;
      }
    }
  }

  // Group nearby busy cells (within GAP cells of each other).
  const seen = new Uint8Array(gw * gh);
  const boxes: Box[] = [];
  for (let start = 0; start < cells.length; start += 1) {
    if (seen[start] || (cells[start] ?? 0) < CELL_MIN) continue;
    const stack = [start];
    seen[start] = 1;
    const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, px: 0 };
    while (stack.length) {
      const k = stack.pop()!;
      const cx = k % gw;
      const cy = (k / gw) | 0;
      box.x0 = Math.min(box.x0, cx); box.y0 = Math.min(box.y0, cy);
      box.x1 = Math.max(box.x1, cx); box.y1 = Math.max(box.y1, cy);
      box.px += cells[k] ?? 0;
      for (let ny = Math.max(0, cy - GAP); ny <= Math.min(gh - 1, cy + GAP); ny += 1) {
        for (let nx = Math.max(0, cx - GAP); nx <= Math.min(gw - 1, cx + GAP); nx += 1) {
          const n = ny * gw + nx;
          if (!seen[n] && (cells[n] ?? 0) >= CELL_MIN) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    if (box.px >= SPECK) boxes.push(box);
  }

  const merged = mergeBoxes(boxes);
  const areas = merged.map((b) => {
    const x = (b.x0 * CELL) / w;
    const y = (b.y0 * CELL) / h;
    return {
      x: round(x),
      y: round(y),
      w: round(Math.min(1 - x, ((b.x1 + 1) * CELL - b.x0 * CELL) / w)),
      h: round(Math.min(1 - y, ((b.y1 + 1) * CELL - b.y0 * CELL) / h))
    };
  });
  const cover = areas.reduce((sum, r) => sum + r.w * r.h, 0);
  if (areas.length > MAX_AREAS || cover > MAX_COVER) return { status: "redrawn", areas: [] };
  return { status: "compared", areas };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
