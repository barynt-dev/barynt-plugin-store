import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateAddress, validatePlugin, validateStoreFile } from "./lib";
import { manifestSchema, sourceSchema, storeSchema } from "./schema";

// Fixtures are real archives served from a local http server, so the tests
// exercise the same download, hash and archive-inspection code as the CI.
process.env.BARYNT_STORE_ALLOW_LOCAL = "1";

const work = mkdtempSync(join(tmpdir(), "store-test-"));
const files = new Map<string, Buffer>();
let server: ReturnType<typeof Bun.serve>;
let origin = "";

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  description: "A demo plugin",
  author: "Someone",
  license: "MIT",
  barynt: ">=1.0.0",
  capabilities: ["issues:read"],
  ...over,
});

const sha512 = (buffer: Buffer) => createHash("sha512").update(buffer).digest("hex");

function sh(command: string[], cwd?: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** Builds an archive under /<name> on the local server and returns its download URL. */
function serveTgz(name: string, prepare: (dir: string) => void, tarArgs: string[] = ["."]) {
  const dir = join(work, `${name}-src`);
  mkdirSync(dir, { recursive: true });
  prepare(dir);
  const out = join(work, `${name}.tgz`);
  sh(["tar", "-czf", out, "-C", dir, ...tarArgs]);
  const buffer = readFileSync(out);
  files.set(`/${name}.tgz`, buffer);
  return { url: `${origin}/${name}.tgz`, buffer };
}

function entry(
  id: string,
  versions: { version: string; download: string; sha512: string; revoked?: true }[],
  entryManifest: Record<string, unknown> = manifest({ id, version: versions[versions.length - 1]?.version }),
) {
  const root = join(work, `store-${Math.random().toString(36).slice(2)}`);
  const dir = join(root, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "barynt-plugin.json"), JSON.stringify(entryManifest));
  writeFileSync(join(dir, "source.json"), JSON.stringify({ versions }));
  return root;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const body = files.get(new URL(request.url).pathname);
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

describe("schemas", () => {
  test("accepts a minimal store.json and rejects unknown keys", () => {
    expect(storeSchema.safeParse({ schemaVersion: 1, id: "official", name: "Official" }).success).toBe(true);
    expect(storeSchema.safeParse({ schemaVersion: 1, id: "official", name: "Official", extra: 1 }).success).toBe(false);
  });

  test("manifest id must be lowercase ascii with dashes", () => {
    expect(manifestSchema.safeParse(manifest()).success).toBe(true);
    expect(manifestSchema.safeParse(manifest({ id: "Demo" })).success).toBe(false);
    expect(manifestSchema.safeParse(manifest({ id: "demo_x" })).success).toBe(false);
    expect(manifestSchema.safeParse(manifest({ version: "1.0" })).success).toBe(false);
  });

  test("source.json pins a 128 char sha512, rejects duplicates and http", () => {
    const good = { version: "1.0.0", download: `${origin}/x.tgz`, sha512: "a".repeat(128) };
    expect(sourceSchema.safeParse({ versions: [good] }).success).toBe(true);
    expect(sourceSchema.safeParse({ versions: [{ ...good, sha512: "abc" }] }).success).toBe(false);
    expect(sourceSchema.safeParse({ versions: [good, good] }).success).toBe(false);
    delete process.env.BARYNT_STORE_ALLOW_LOCAL;
    expect(sourceSchema.safeParse({ versions: [{ ...good, download: "http://example.com/x.tgz" }] }).success).toBe(false);
    process.env.BARYNT_STORE_ALLOW_LOCAL = "1";
  });
});

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["8.8.8.8", false],
    ["140.82.112.3", false],
    ["::1", true],
    ["fe80::1", true],
    ["fd00::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["2606:4700::1111", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("store.json", () => {
  test("reports a missing file", () => {
    expect(validateStoreFile(work)[0]).toContain("store.json");
  });
});

describe("validatePlugin", () => {
  const write = (dir: string, over: Record<string, unknown> = {}) => {
    writeFileSync(join(dir, "barynt-plugin.json"), JSON.stringify(manifest(over)));
    writeFileSync(join(dir, "server.js"), "export default {}");
  };
  const opts = { allowLocal: true };

  test("accepts a matching archive (with ./ prefix)", async () => {
    const { url, buffer } = serveTgz("ok", (dir) => write(dir));
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }]);
    const result = await validatePlugin(root, "demo", opts);
    expect(result.errors).toEqual([]);
    expect(result.versions).toEqual([{ version: "1.0.0", status: "verified" }]);
    expect(result.notes[0]).toContain("issues:read");
  });

  test("accepts an archive without ./ prefix", async () => {
    const { url, buffer } = serveTgz("plain", (dir) => write(dir), ["barynt-plugin.json", "server.js"]);
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors).toEqual([]);
  });

  test("accepts a zip archive", async () => {
    const dir = join(work, "zip-src");
    mkdirSync(dir, { recursive: true });
    write(dir);
    const out = join(work, "z.zip");
    sh(["python3", "-m", "zipfile", "-c", out, "barynt-plugin.json", "server.js"], dir);
    const buffer = readFileSync(out);
    files.set("/z.zip", buffer);
    const root = entry("demo", [{ version: "1.0.0", download: `${origin}/z.zip`, sha512: sha512(buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors).toEqual([]);
  });

  test("fails when the hash does not match", async () => {
    const { url } = serveTgz("hash", (dir) => write(dir));
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: "0".repeat(128) }]);
    const result = await validatePlugin(root, "demo", opts);
    expect(result.errors.join("\n")).toContain("sha512 mismatch");
  });

  test("fails when the entry manifest differs from the archive manifest", async () => {
    const { url, buffer } = serveTgz("diff", (dir) => write(dir));
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }], manifest({ description: "changed" }));
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("verbatim copy");
  });

  test("fails when the archive manifest has another id or version", async () => {
    const other = serveTgz("id", (dir) => write(dir, { id: "evil" }));
    let root = entry("demo", [{ version: "1.0.0", download: other.url, sha512: sha512(other.buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain('has id "evil"');
    const wrongVersion = serveTgz("ver", (dir) => write(dir, { version: "9.9.9" }));
    root = entry("demo", [{ version: "1.0.0", download: wrongVersion.url, sha512: sha512(wrongVersion.buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("has version 9.9.9");
  });

  test("fails on a missing manifest inside the archive", async () => {
    const { url, buffer } = serveTgz("nomani", (dir) => writeFileSync(join(dir, "server.js"), "x"));
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("archive root");
  });

  test("rejects symlinks in the archive", async () => {
    const { url, buffer } = serveTgz("link", (dir) => {
      write(dir);
      symlinkSync("/etc/passwd", join(dir, "leak"));
    });
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("link or special file");
  });

  test("rejects path traversal in the archive", async () => {
    const dir = join(work, "trav-src");
    mkdirSync(dir, { recursive: true });
    write(dir);
    const out = join(work, "trav.tgz");
    sh(["tar", "-czf", out, "-C", dir, "--transform", "s,^,../,", "barynt-plugin.json", "server.js"]);
    const buffer = readFileSync(out);
    files.set("/trav.tgz", buffer);
    const root = entry("demo", [{ version: "1.0.0", download: `${origin}/trav.tgz`, sha512: sha512(buffer) }]);
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("unsafe path");
  });

  test("blocks downloads from non-public addresses", async () => {
    const root = entry("demo", [{ version: "1.0.0", download: `${origin}/ok.tgz`, sha512: "0".repeat(128) }]);
    const result = await validatePlugin(root, "demo", { allowLocal: false });
    expect(result.errors.join("\n")).toMatch(/only https|non-public/);
  });

  test("published versions are immutable and cannot be removed", async () => {
    const one = serveTgz("imm1", (dir) => write(dir));
    const two = serveTgz("imm2", (dir) => write(dir, { version: "1.1.0" }));
    const baseSource = { versions: [{ version: "1.0.0", download: one.url, sha512: sha512(one.buffer) }] };
    const baseManifest = manifest();

    // Same version, different hash.
    let root = entry("demo", [{ version: "1.0.0", download: two.url, sha512: sha512(two.buffer) }], manifest());
    let result = await validatePlugin(root, "demo", { ...opts, baseSource, baseManifest, verify: "new" });
    expect(result.errors.join("\n")).toContain("already published");

    // Version removed.
    root = entry("demo", [{ version: "1.1.0", download: two.url, sha512: sha512(two.buffer) }], manifest({ version: "1.1.0" }));
    result = await validatePlugin(root, "demo", { ...opts, baseSource, baseManifest, verify: "new" });
    expect(result.errors.join("\n")).toContain("was removed");

    // A proper update verifies only the new version and reports capability changes.
    root = entry(
      "demo",
      [
        { version: "1.0.0", download: one.url, sha512: sha512(one.buffer) },
        { version: "1.1.0", download: two.url, sha512: sha512(two.buffer) },
      ],
      manifest({ version: "1.1.0", capabilities: ["issues:read", "issues:write"] }),
    );
    // The archive for 1.1.0 must carry the same capabilities as the entry copy.
    const withCaps = serveTgz("imm3", (dir) => write(dir, { version: "1.1.0", capabilities: ["issues:read", "issues:write"] }));
    root = entry(
      "demo",
      [
        { version: "1.0.0", download: one.url, sha512: sha512(one.buffer) },
        { version: "1.1.0", download: withCaps.url, sha512: sha512(withCaps.buffer) },
      ],
      manifest({ version: "1.1.0", capabilities: ["issues:read", "issues:write"] }),
    );
    result = await validatePlugin(root, "demo", { ...opts, baseSource, baseManifest, verify: "new" });
    expect(result.errors).toEqual([]);
    expect(result.versions).toEqual([
      { version: "1.0.0", status: "skipped" },
      { version: "1.1.0", status: "verified" },
    ]);
    expect(result.notes.join("\n")).toContain("new capabilities: issues:write");
  });

  test("directory name must equal the manifest id", async () => {
    const { url, buffer } = serveTgz("dir", (dir) => write(dir));
    const root = entry("demo", [{ version: "1.0.0", download: url, sha512: sha512(buffer) }], manifest({ id: "other" }));
    expect((await validatePlugin(root, "demo", opts)).errors.join("\n")).toContain("must equal the directory name");
  });
});
