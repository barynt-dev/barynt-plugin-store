import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listEntryFiles, readJson } from "./lib";

// `plugins.json` — what Barynt reads — from the entries in plugins/, one file
// per plugin so a pull request touches only its own. `--check` fails when the
// file isn't what the entries make.

const root = join(import.meta.dir, "..");
const entries = listEntryFiles(root).map((f) => readJson(join(root, "plugins", f)));
const text = `${JSON.stringify(entries, null, 2)}\n`;
const target = join(root, "plugins.json");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== text) {
    console.error("plugins.json is out of date: run `bun run build` and commit it.");
    process.exit(1);
  }
  console.log(`plugins.json is up to date (${entries.length} plugins).`);
} else {
  writeFileSync(target, text);
  console.log(`Wrote plugins.json (${entries.length} plugins).`);
}
