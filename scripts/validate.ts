import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listPluginIds, type PluginResult, validatePlugin, validateStoreFile } from "./lib";

// Usage:
//   bun scripts/validate.ts                  every entry (push to main, weekly re-check)
//   bun scripts/validate.ts --changed <sha>  only entries changed since <sha> (pull requests)

const root = process.cwd();
const args = process.argv.slice(2);
const changedAt = args.indexOf("--changed");
const baseSha = changedAt >= 0 ? args[changedAt + 1] : undefined;
if (changedAt >= 0 && !baseSha) {
  console.error("--changed needs a base commit");
  process.exit(2);
}

function git(...gitArgs: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...gitArgs], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function baseFile(path: string): unknown {
  const text = baseSha ? git("show", `${baseSha}:${path}`) : undefined;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function selectIds(): string[] {
  const all = listPluginIds(root);
  if (!baseSha) return all;
  const changed = (git("diff", "--name-only", `${baseSha}...HEAD`) ?? "").split("\n").filter(Boolean);
  // A change to the validator, the schemas or the workflow can affect every entry.
  const validatorChanged = changed.some((file) =>
    /^(scripts\/|schemas\/|\.github\/workflows\/|store\.json$|package\.json$|bun\.lock$)/.test(file),
  );
  if (validatorChanged) return all;
  const touched = new Set<string>();
  for (const file of changed) {
    const match = /^plugins\/([^/_.][^/]*)\//.exec(file);
    if (match?.[1]) touched.add(match[1]);
  }
  return all.filter((id) => touched.has(id));
}

function annotate(level: "error" | "notice", file: string, message: string) {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::${level} file=${file}::${escaped}`);
}

const storeErrors = validateStoreFile(root);
for (const error of storeErrors) annotate("error", "store.json", error);

const results: PluginResult[] = [];
for (const id of selectIds()) {
  const entry = join("plugins", id);
  const result = await validatePlugin(root, id, {
    baseSource: baseFile(`${entry}/source.json`),
    baseManifest: baseFile(`${entry}/barynt-plugin.json`),
    verify: baseSha ? "new" : "all",
  });
  results.push(result);
  for (const error of result.errors) annotate("error", `${entry}/source.json`, error);
  for (const note of result.notes) annotate("notice", `${entry}/barynt-plugin.json`, note);
  const status = result.errors.length === 0 ? "ok" : "FAILED";
  console.log(`${status}  ${id}  ${result.versions.map((v) => `${v.version}:${v.status}`).join(" ")}`);
  for (const error of result.errors) console.log(`      ${error}`);
}

if (results.length === 0 && storeErrors.length === 0) console.log("No plugin entries to validate.");

// A readable summary on the pull request's checks page.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const lines = ["## Store entries", ""];
  if (results.length === 0) lines.push("No plugin entries were changed.");
  else {
    lines.push("| Plugin | Result | Versions | Review notes |", "| --- | --- | --- | --- |");
    for (const r of results) {
      const versions = r.versions.map((v) => `${v.version} (${v.status})`).join(", ");
      const notes = [...r.errors.map((e) => `❌ ${e}`), ...r.notes].join("<br>") || "-";
      lines.push(`| \`${r.id}\` | ${r.errors.length === 0 ? "✅ ok" : "❌ failed"} | ${versions} | ${notes} |`);
    }
  }
  if (storeErrors.length > 0) lines.push("", ...storeErrors.map((e) => `- ❌ ${e}`));
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

const failed = storeErrors.length > 0 || results.some((r) => r.errors.length > 0);
if (failed) process.exit(1);
