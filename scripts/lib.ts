import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { z } from "zod";
import { type Entry, entrySchema, releaseManifestSchema } from "./schema";

// Everything the CI checks about an entry (BARY-232). A version's release is
// downloaded file by file — the files Barynt installs — and hashed the way
// Barynt hashes it; its manifest must say what the entry says.
//
// The repository address comes from a pull request, so it's untrusted: files
// are fetched only over https, only from public addresses, with size and
// time limits, and every redirect hop is checked again.

/** Each release file at most — Barynt's own limits. */
export const FILE_LIMITS: Record<string, number> = {
  "manifest.json": 64 * 1024,
  "main.js": 5 * 1024 * 1024,
  "styles.css": 1024 * 1024,
};
const PREVIEW_MAX = 512 * 1024;
const PREVIEW_RE = /^preview-[1-6]\.(webp|png)$/;
const LOGO_MAX = 128 * 1024;
const LOGO_RE = /^logo\.(webp|png)$/;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(entry)"}: ${i.message}`);
}

// ─── Network ────────────────────────────────────────────────────────────────

/** Private, loopback, link-local and reserved addresses (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (lower.startsWith("::ffff:") && isIP(v4) !== 4) return true;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  return lower === "::" || lower === "::1" || /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower);
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`${host} does not resolve`);
  for (const address of addresses)
    if (isPrivateAddress(address))
      throw new Error(`${host} resolves to a non-public address (${address})`);
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** A release file — `null` when it isn't there (404). */
export async function fetchFile(
  url: string,
  max: number,
  allowLocal = false,
): Promise<Uint8Array | null> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowLocal) {
      if (current.protocol !== "https:")
        throw new Error(`only https:// downloads are allowed (got ${current.protocol})`);
      await assertPublicHost(current.hostname);
    }
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "user-agent": "barynt-plugin-store-ci" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect without Location header (HTTP ${response.status})`);
      current = new URL(location, current);
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    return readCapped(response, max);
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
}

// ─── Releases ───────────────────────────────────────────────────────────────

/** Where a version's file is: GitHub's release downloads (tag = version). */
export function releaseFileUrl(
  entry: Pick<Entry, "repo" | "provider">,
  version: string,
  file: string,
  base = "https://github.com",
): string {
  const short = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(entry.repo);
  const github = short || /^https:\/\/github\.com\//.test(entry.repo);
  if (!github || (entry.provider && entry.provider !== "github"))
    throw new Error("the store checks GitHub releases only for now");
  const path = short
    ? entry.repo
    : entry.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
  return `${base}/${path}/releases/download/${encodeURIComponent(version)}/${file}`;
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** The release hash, exactly as Barynt computes it: SHA-256 over each
 *  file's hash and name, sorted by name (`sha256sum … | sort -k2 | sha256sum`). */
export function releaseHash(files: Record<string, Uint8Array>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((name) => `${sha256(files[name] as Uint8Array)}  ${name}\n`)
      .join(""),
  );
}

export interface VersionResult {
  version: string;
  errors: string[];
  capabilities: string[];
}

/** One version: its files downloaded, hashed, its manifest checked. */
export async function verifyVersion(
  entry: Entry,
  version: string,
  options: { allowLocal?: boolean; base?: string } = {},
): Promise<VersionResult> {
  const errors: string[] = [];
  const url = (file: string) => releaseFileUrl(entry, version, file, options.base);
  const files: Record<string, Uint8Array> = {};
  try {
    for (const [name, max] of Object.entries(FILE_LIMITS)) {
      const bytes = await fetchFile(url(name), max, options.allowLocal);
      if (bytes) files[name] = bytes;
    }
  } catch (error) {
    return { version, errors: [String((error as Error).message)], capabilities: [] };
  }
  const raw = files["manifest.json"];
  if (!raw) return { version, errors: ["manifest.json: not in the release"], capabilities: [] };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { version, errors: ["manifest.json: not valid JSON"], capabilities: [] };
  }
  const parsed = releaseManifestSchema.safeParse(json);
  if (!parsed.success)
    return { version, errors: formatIssues(parsed.error).map((e) => `manifest.json ${e}`), capabilities: [] };
  const m = parsed.data;
  if (m.kind === "sandbox" && !files["main.js"]) errors.push("main.js: not in the release");
  for (const preview of m.previews ?? []) {
    if (!PREVIEW_RE.test(preview.file)) {
      errors.push(`previews: ${preview.file} isn't preview-1 … preview-6 (.webp or .png)`);
      continue;
    }
    const bytes = await fetchFile(url(preview.file), PREVIEW_MAX, options.allowLocal).catch(
      (e: Error) => {
        errors.push(`${preview.file}: ${e.message}`);
        return null;
      },
    );
    if (bytes) files[preview.file] = bytes;
    else errors.push(`${preview.file}: listed in the manifest, not in the release`);
  }
  // The logo it names is part of the release and its hash too (BARY-235).
  if (m.logo !== undefined) {
    if (!LOGO_RE.test(m.logo)) errors.push(`logo: ${m.logo} isn't logo.png or logo.webp`);
    else {
      const bytes = await fetchFile(url(m.logo), LOGO_MAX, options.allowLocal).catch(
        (e: Error) => {
          errors.push(`${m.logo}: ${e.message}`);
          return null;
        },
      );
      if (bytes) files[m.logo] = bytes;
      else errors.push(`${m.logo}: named in the manifest, not in the release`);
    }
  }
  if (m.id !== entry.id) errors.push(`manifest id is ${m.id}, the entry's ${entry.id}`);
  if (m.version !== version) errors.push(`manifest version is ${m.version}, not ${version}`);
  if (m.kind !== entry.kind) errors.push(`manifest kind is ${m.kind}, the entry's ${entry.kind}`);
  if ([...m.levels].sort().join() !== [...entry.levels].sort().join())
    errors.push(`manifest levels are ${m.levels.join(", ")}, the entry's ${entry.levels.join(", ")}`);
  const hash = releaseHash(files);
  if (hash !== entry.versions[version])
    errors.push(`hash mismatch: the release's files hash to ${hash}`);
  return { version, errors, capabilities: m.capabilities };
}

// ─── Entries ────────────────────────────────────────────────────────────────

export function listEntryFiles(root: string): string[] {
  return readdirSync(join(root, "plugins"))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export interface EntryResult {
  id: string;
  errors: string[];
  versions: VersionResult[];
}

/**
 * An entry file: its shape, its name, and — `verify` — the versions to
 * download. A version already listed at the base must not change: its
 * files are fixed once merged.
 */
export async function validateEntry(
  file: string,
  raw: unknown,
  options: {
    base?: unknown;
    verify: "all" | "new";
    allowLocal?: boolean;
    releaseBase?: string;
  },
): Promise<EntryResult> {
  const parsed = entrySchema.safeParse(raw);
  const id = file.replace(/\.json$/, "");
  if (!parsed.success) return { id, errors: formatIssues(parsed.error), versions: [] };
  const entry = parsed.data;
  const errors: string[] = [];
  if (entry.id !== id) errors.push(`id is ${entry.id}, the file is ${file}`);
  const before = entrySchema.safeParse(options.base);
  const old = before.success ? before.data.versions : {};
  for (const [version, hash] of Object.entries(old)) {
    if (!(version in entry.versions)) errors.push(`${version}: a released version can't be removed`);
    else if (entry.versions[version] !== hash) errors.push(`${version}: a released version's hash can't change`);
  }
  const toCheck = Object.keys(entry.versions).filter(
    (v) => options.verify === "all" || !(v in old),
  );
  const versions: VersionResult[] = [];
  for (const version of toCheck)
    versions.push(
      await verifyVersion(entry, version, {
        allowLocal: options.allowLocal,
        base: options.releaseBase,
      }),
    );
  return { id, errors, versions };
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
