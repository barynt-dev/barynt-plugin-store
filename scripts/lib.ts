import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { manifestSchema, PLUGIN_ID, sourceSchema, storeSchema } from "./schema";

// Everything the CI checks about an entry. Design rules:
//  - The archive is untrusted input. It is never extracted to disk: we list it,
//    inspect the listing, and read exactly one member (barynt-plugin.json).
//  - The download URL is untrusted input too (it comes from a pull request),
//    so it is fetched only over https, only from public addresses, with a size
//    and time limit, and every redirect hop is checked again.

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_FILES = 5000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

type SourceFile = z.infer<typeof sourceSchema>;
type VersionEntry = SourceFile["versions"][number];

export interface ValidateOptions {
  /** Tests only: allow http and loopback downloads. */
  allowLocal?: boolean;
  /** source.json / barynt-plugin.json at the pull request base (undefined = new plugin or full run). */
  baseSource?: unknown;
  baseManifest?: unknown;
  /** "new": download only versions that are new compared to the base. "all": every version. */
  verify?: "all" | "new";
}

export interface PluginResult {
  id: string;
  errors: string[];
  notes: string[];
  versions: { version: string; status: "verified" | "skipped" | "failed" }[];
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
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
  return (
    lower === "::" ||
    lower === "::1" ||
    /^fe[89ab]/.test(lower) ||
    /^f[cd]/.test(lower)
  );
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`${host} does not resolve`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${host} resolves to a non-public address (${address})`);
    }
  }
}

async function readCapped(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error(`archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchArchive(url: string, allowLocal = false): Promise<Buffer> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowLocal) {
      if (current.protocol !== "https:") {
        throw new Error(`only https:// downloads are allowed (got ${current.protocol})`);
      }
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
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES) {
      throw new Error(`archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`);
    }
    return await readCapped(response);
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
}

// ─── Archive inspection (no extraction) ─────────────────────────────────────

type ArchiveKind = "tar" | "zip";

function archiveKind(url: string): ArchiveKind {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".tgz") || path.endsWith(".tar.gz")) return "tar";
  if (path.endsWith(".zip")) return "zip";
  throw new Error("download must be a .tgz, .tar.gz or .zip archive");
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString().trim().slice(0, 300)}`);
  }
  return result.stdout.toString();
}

interface Listing {
  names: string[];
  unpackedBytes: number;
}

function inspectListing(kind: ArchiveKind, file: string): Listing {
  const names =
    kind === "tar"
      ? run(["tar", "-tzf", file]).split("\n").filter(Boolean)
      : run(["unzip", "-Z1", file]).split("\n").filter(Boolean);
  if (names.length > MAX_FILES) throw new Error(`archive has more than ${MAX_FILES} entries`);

  // Second pass over the verbose listing: entry types and sizes. The number of
  // parsed lines must match the number of names, otherwise we cannot vouch for it.
  const verbose = run(kind === "tar" ? ["tar", "-tvzf", file] : ["unzip", "-Z", file]).split("\n");
  const pattern =
    kind === "tar"
      ? /^([-dlhcbps])\S{9}\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/
      : /^([-dlcbps])\S{6,9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/;
  let parsed = 0;
  let unpackedBytes = 0;
  for (const line of verbose) {
    const match = pattern.exec(line);
    if (!match) continue;
    parsed++;
    const [, type = "-", size = "0", name = ""] = match;
    if (type !== "-" && type !== "d") {
      throw new Error(`archive contains a link or special file (${name}); only regular files are allowed`);
    }
    unpackedBytes += Number(size);
  }
  if (parsed !== names.length) {
    throw new Error("could not read the archive listing reliably");
  }
  if (unpackedBytes > MAX_UNPACKED_BYTES) {
    throw new Error(`archive unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
  }

  for (const name of names) {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      throw new Error(`archive contains an unsafe path: ${name}`);
    }
  }
  return { names, unpackedBytes };
}

/** Reads barynt-plugin.json from the archive root without extracting anything. */
export function readArchiveManifest(kind: ArchiveKind, buffer: Buffer): unknown {
  const dir = mkdtempSync(join(tmpdir(), "barynt-store-"));
  const file = join(dir, kind === "tar" ? "archive.tgz" : "archive.zip");
  try {
    writeFileSync(file, buffer);
    const { names } = inspectListing(kind, file);
    const member = names.find((name) => name === "barynt-plugin.json" || name === "./barynt-plugin.json");
    if (!member) throw new Error("barynt-plugin.json must be at the archive root");
    const text = kind === "tar" ? run(["tar", "-xzOf", file, member]) : run(["unzip", "-p", file, member]);
    if (text.length > MAX_MANIFEST_BYTES) throw new Error("barynt-plugin.json is larger than 256 KB");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("barynt-plugin.json inside the archive is not valid JSON");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Entries ────────────────────────────────────────────────────────────────

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function listPluginIds(root: string): string[] {
  const plugins = join(root, "plugins");
  if (!existsSync(plugins)) return [];
  return readdirSync(plugins)
    .filter((name) => !name.startsWith("_") && !name.startsWith("."))
    .filter((name) => statSync(join(plugins, name)).isDirectory())
    .sort();
}

export function validateStoreFile(root: string): string[] {
  const path = join(root, "store.json");
  if (!existsSync(path)) return ["store.json is missing"];
  try {
    const result = storeSchema.safeParse(readJson(path));
    return result.success ? [] : formatIssues(result.error).map((issue) => `store.json: ${issue}`);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function newest(versions: VersionEntry[]): VersionEntry {
  const active = versions.filter((entry) => !entry.revoked);
  const pool = active.length > 0 ? active : versions;
  return pool.reduce((best, entry) => (Bun.semver.order(entry.version, best.version) > 0 ? entry : best));
}

export async function validatePlugin(
  root: string,
  id: string,
  options: ValidateOptions = {},
): Promise<PluginResult> {
  const result: PluginResult = { id, errors: [], notes: [], versions: [] };
  const dir = join(root, "plugins", id);
  const fail = (message: string) => result.errors.push(message);

  if (!PLUGIN_ID.test(id)) {
    fail(`directory name "${id}" is not a valid plugin id (a-z, 0-9 and dashes, starting with a letter)`);
    return result;
  }

  let manifestRaw: unknown;
  let sourceRaw: unknown;
  try {
    manifestRaw = readJson(join(dir, "barynt-plugin.json"));
    sourceRaw = readJson(join(dir, "source.json"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return result;
  }

  const manifest = manifestSchema.safeParse(manifestRaw);
  if (!manifest.success) {
    for (const issue of formatIssues(manifest.error)) fail(`barynt-plugin.json: ${issue}`);
  }
  const source = sourceSchema.safeParse(sourceRaw);
  if (!source.success) {
    for (const issue of formatIssues(source.error)) fail(`source.json: ${issue}`);
  }
  if (!manifest.success || !source.success) return result;

  if (manifest.data.id !== id) {
    fail(`barynt-plugin.json: id "${manifest.data.id}" must equal the directory name "${id}"`);
  }

  const latest = newest(source.data.versions);
  if (manifest.data.version !== latest.version) {
    fail(`barynt-plugin.json: version ${manifest.data.version} must equal the newest listed version ${latest.version}`);
  }

  // Compare with the pull request base: published versions are immutable.
  const base = options.baseSource === undefined ? undefined : sourceSchema.safeParse(options.baseSource);
  const baseVersions = new Map<string, VersionEntry>();
  if (base?.success) {
    for (const entry of base.data.versions) baseVersions.set(entry.version, entry);
    for (const previous of base.data.versions) {
      const current = source.data.versions.find((entry) => entry.version === previous.version);
      if (!current) {
        fail(`version ${previous.version} was removed; published versions stay listed, mark it "revoked" instead`);
      } else if (current.sha512 !== previous.sha512 || current.download !== previous.download) {
        fail(`version ${previous.version} was already published; its download and sha512 must not change (publish a new version instead)`);
      }
    }
  }

  // New capabilities are what a reviewer has to look at first.
  const baseManifest = options.baseManifest === undefined ? undefined : manifestSchema.safeParse(options.baseManifest);
  const manifestChanged = !baseManifest?.success || !isDeepStrictEqual(baseManifest.data, manifest.data);
  if (baseManifest?.success) {
    const added = manifest.data.capabilities.filter((cap) => !baseManifest.data.capabilities.includes(cap));
    const removed = baseManifest.data.capabilities.filter((cap) => !manifest.data.capabilities.includes(cap));
    if (added.length > 0) result.notes.push(`new capabilities: ${added.join(", ")}`);
    if (removed.length > 0) result.notes.push(`removed capabilities: ${removed.join(", ")}`);
  } else if (manifest.data.capabilities.length > 0) {
    result.notes.push(`capabilities: ${manifest.data.capabilities.join(", ")}`);
  }

  // Download and hash the versions that are new (or all, in a full run). The
  // newest version is always checked when the manifest copy changed.
  for (const entry of source.data.versions) {
    const isNew = !baseVersions.has(entry.version);
    const mustVerify =
      options.verify === "new" && base?.success
        ? isNew || (entry.version === latest.version && manifestChanged)
        : true;
    if (!mustVerify) {
      result.versions.push({ version: entry.version, status: "skipped" });
      continue;
    }
    const problems = await verifyVersion(id, entry, entry.version === latest.version ? manifest.data : undefined, options.allowLocal ?? false);
    if (problems.length === 0) {
      result.versions.push({ version: entry.version, status: "verified" });
    } else {
      result.versions.push({ version: entry.version, status: "failed" });
      for (const problem of problems) fail(`${entry.version}: ${problem}`);
    }
  }
  return result;
}

async function verifyVersion(
  id: string,
  entry: VersionEntry,
  entryManifest: z.infer<typeof manifestSchema> | undefined,
  allowLocal: boolean,
): Promise<string[]> {
  try {
    const kind = archiveKind(entry.download);
    const buffer = await fetchArchive(entry.download, allowLocal);
    const actual = createHash("sha512").update(buffer).digest("hex");
    if (actual !== entry.sha512) {
      return [`sha512 mismatch: source.json pins ${entry.sha512.slice(0, 16)}…, the download hashes to ${actual.slice(0, 16)}…`];
    }
    const inside = manifestSchema.safeParse(readArchiveManifest(kind, buffer));
    if (!inside.success) {
      return formatIssues(inside.error).map((issue) => `manifest in archive: ${issue}`);
    }
    const problems: string[] = [];
    if (inside.data.id !== id) problems.push(`manifest in archive has id "${inside.data.id}", expected "${id}"`);
    if (inside.data.version !== entry.version) {
      problems.push(`manifest in archive has version ${inside.data.version}, source.json lists ${entry.version}`);
    }
    if (entryManifest && !isDeepStrictEqual(inside.data, entryManifest)) {
      problems.push("barynt-plugin.json in the entry differs from the manifest inside the archive (it must be a verbatim copy)");
    }
    return problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
