import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { manifestSchema, sourceSchema, storeSchema } from "./schema";

// Generates schemas/*.schema.json from the zod schemas so editors can validate
// entries (`"$schema"` in store.json / source.json) and the files can never
// drift from what the CI enforces. `--check` fails if they are out of date.

const targets = {
  "store.schema.json": storeSchema,
  "source.schema.json": sourceSchema,
  "manifest.schema.json": manifestSchema,
} as const;

const root = join(import.meta.dir, "..", "schemas");
const check = process.argv.includes("--check");
let stale = false;

for (const [file, schema] of Object.entries(targets)) {
  const json = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
  const path = join(root, file);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== json) {
      console.error(`schemas/${file} is out of date, run: bun run schemas`);
      stale = true;
    }
  } else {
    writeFileSync(path, json);
    console.log(`wrote schemas/${file}`);
  }
}

if (stale) process.exit(1);
