// Copies functions/_shared/blocks.js into every Function's index.js between the markers below
// (Blocks uploads only index.js + package.json, so a Function cannot import a sibling file).
//   node tools/sync-functions.mjs          rewrite the copies
//   node tools/sync-functions.mjs --check  exit 1 if a copy is out of date (run before deploy)
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "functions");
const START = "// >>> shared: functions/_shared/blocks.js (copied by tools/sync-functions.mjs, do not edit here)";
const END = "// <<< shared";

// blocks.js (service identity, data access, handler) + permissions.js (the permission table, also
// imported by the screens), with `export ` removed.
const read = (file) =>
  readFileSync(join(root, "_shared", file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/^export (?=(async function|function|const|class) )/gm, "")
    .trimEnd();
const shared = `${read("blocks.js")}\n\n${read("permissions.js")}`;
const block = `${START}\n${shared}\n${END}`;

const check = process.argv.includes("--check");
let stale = 0;
for (const name of readdirSync(root)) {
  const file = join(root, name, "index.js");
  if (name.startsWith("_") || !existsSync(file)) continue;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) continue; // this Function does not use the shared code
  const next = text.slice(0, a) + block + text.slice(b + END.length);
  if (next === text) continue;
  stale += 1;
  if (check) console.log(`out of date: ${name}`);
  else {
    writeFileSync(file, next);
    console.log(`updated: ${name}`);
  }
}
if (check && stale) process.exit(1);
if (!stale) console.log("all Functions up to date");
