// Revision impact: the change finder (src/features/drawings/compareCore.ts) on made-up sheets.
// Run: node tools/test-compare.mjs   (Node 23.6+ reads the .ts file directly)
import { compareMasks } from "../src/features/drawings/compareCore.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok ${name}`); } catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const W = 800;
const H = 566;
/** A plan: a frame, grid lines every 50 px, a title block, plus extra boxes. */
function sheet({ w = W, h = H, shift = [0, 0], boxes = [], noise = 0, seed = 1 } = {}) {
  const data = new Uint8Array(w * h);
  const ink = (x, y) => {
    x += shift[0]; y += shift[1];
    if (x >= 0 && y >= 0 && x < w && y < h) data[y * w + x] = 1;
  };
  const rect = (x0, y0, x1, y1) => {
    for (let x = x0; x <= x1; x += 1) { ink(x, y0); ink(x, y1); }
    for (let y = y0; y <= y1; y += 1) { ink(x0, y); ink(x1, y); }
  };
  rect(10, 10, w - 11, h - 11);
  for (let x = 50; x < w - 150; x += 50) for (let y = 10; y < h - 10; y += 1) ink(x, y);
  for (let y = 50; y < h - 10; y += 50) for (let x = 10; x < w - 150; x += 1) ink(x, y);
  rect(w - 140, h - 120, w - 20, h - 20);
  for (const [x0, y0, x1, y1] of boxes) { rect(x0, y0, x1, y1); rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2); }
  let s = seed;
  for (let i = 0; i < noise; i += 1) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const x = s % w;
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    ink(x, s % h);
  }
  return { w, h, data };
}

console.log("change finder, local test");

test("the same sheet: nothing changed", () => {
  const r = compareMasks(sheet(), sheet());
  expect(r.status === "compared" && r.areas.length === 0, JSON.stringify(r));
});

test("the same sheet moved by a few pixels: nothing changed", () => {
  const r = compareMasks(sheet(), sheet({ shift: [7, -5] }));
  expect(r.status === "compared" && r.areas.length === 0, JSON.stringify(r));
});

test("a new room: one area around it", () => {
  const r = compareMasks(sheet(), sheet({ boxes: [[300, 200, 380, 260]] }));
  expect(r.status === "compared" && r.areas.length === 1, JSON.stringify(r));
  const [a] = r.areas;
  const cx = (340 / W);
  const cy = (230 / H);
  expect(a.x <= cx && a.x + a.w >= cx && a.y <= cy && a.y + a.h >= cy, `area ${JSON.stringify(a)} misses the room`);
  expect(a.w < 0.2 && a.h < 0.2, `area too big ${JSON.stringify(a)}`);
});

test("a removed room counts too, and a moved sheet doesn't hide it", () => {
  const r = compareMasks(sheet({ boxes: [[120, 120, 180, 170]] }), sheet({ shift: [3, 2] }));
  expect(r.status === "compared" && r.areas.length === 1, JSON.stringify(r));
});

test("two changes far apart: two areas", () => {
  const r = compareMasks(sheet(), sheet({ boxes: [[60, 60, 110, 100], [500, 380, 560, 430]] }));
  expect(r.status === "compared" && r.areas.length === 2, JSON.stringify(r));
});

test("a few stray dots are not a change", () => {
  const r = compareMasks(sheet(), sheet({ noise: 25 }));
  expect(r.status === "compared" && r.areas.length === 0, JSON.stringify(r));
});

test("landscape turned portrait: can't compare", () => {
  const r = compareMasks(sheet(), sheet({ w: H, h: W }));
  expect(r.status === "notComparable", r.status);
});

test("a different drawing altogether: redrawn", () => {
  const r = compareMasks(sheet(), sheet({ noise: 60000, seed: 7 }));
  expect(r.status === "redrawn", JSON.stringify(r).slice(0, 200));
});

test("a bigger render of the same page shape still compares", () => {
  const r = compareMasks(sheet(), sheet({ h: H + 2 }));
  expect(r.status === "compared", r.status);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
