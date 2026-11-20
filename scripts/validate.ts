import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryResult, listEntryFiles, readJson, validateEntry } from "./lib";

// Checks the entries: all of them with every version (a push to main, the
// weekly run), or — `--changed <base sha>` — those a pull request touches,
// downloading only the versions it adds. Writes what each version asks for
// to the job summary, for the review.

const root = join(import.meta.dir, "..");
const at = process.argv.indexOf("--changed");
const baseSha = at >= 0 ? process.argv[at + 1] : undefined;

function atBase(file: string): unknown {
  if (!baseSha) return undefined;
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${baseSha}:plugins/${file}`], { cwd: root, encoding: "utf8" }),
    );
  } catch {
    return undefined;
  }
}

function changedFiles(): string[] {
  if (!baseSha) return listEntryFiles(root);
  const out = execFileSync("git", ["diff", "--name-only", `${baseSha}...HEAD`, "--", "plugins/"], {
    cwd: root,
    encoding: "utf8",
  });
  const existing = new Set(listEntryFiles(root));
  return out
    .split("\n")
    .map((p) => p.replace(/^plugins\//, ""))
    .filter((f) => existing.has(f));
}

const results: EntryResult[] = [];
for (const file of changedFiles()) {
  results.push(
    await validateEntry(file, readJson(join(root, "plugins", file)), {
      base: atBase(file),
      verify: baseSha ? "new" : "all",
    }),
  );
}

let failed = false;
const summary: string[] = ["## Plugin entries", ""];
for (const r of results) {
  const errors = [...r.errors, ...r.versions.flatMap((v) => v.errors.map((e) => `${v.version}: ${e}`))];
  failed ||= errors.length > 0;
  console.log(`${errors.length ? "✗" : "✓"} ${r.id}`);
  for (const e of errors) console.log(`    ${e}`);
  summary.push(`### ${errors.length ? "✗" : "✓"} ${r.id}`);
  for (const e of errors) summary.push(`- ${e}`);
  for (const v of r.versions)
    summary.push(`- **${v.version}** asks for: ${v.capabilities.length ? v.capabilities.map((c) => `\`${c}\``).join(", ") : "nothing"}`);
  summary.push("");
}
if (results.length === 0) console.log("No entries to check.");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
process.exit(failed ? 1 : 0);
