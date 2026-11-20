import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { isPrivateAddress, releaseFileUrl, releaseHash, validateEntry } from "./lib";

// The store's checks (BARY-232) against a local stand-in for GitHub's
// release downloads: /<owner>/<repo>/releases/download/<version>/<file>.

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "github",
    name: "GitHub",
    version: "0.1.0-beta.1",
    kind: "sandbox",
    levels: ["project"],
    capabilities: ["issues:read", "webhooks:receive"],
    ...over,
  });
let releases: Record<string, Record<string, string>> = {};
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const m = new URL(req.url).pathname.match(/^\/acme\/github\/releases\/download\/([^/]+)\/(.+)$/);
      const body = m ? releases[decodeURIComponent(m[1])]?.[m[2]] : undefined;
      return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop());

const hashOf = (files: Record<string, string>) =>
  releaseHash(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)])));

function release(files: Record<string, string>) {
  releases = { "0.1.0-beta.1": files };
  return hashOf(files);
}
const entry = (versions: Record<string, string>, over: Record<string, unknown> = {}) => ({
  id: "github",
  name: "GitHub",
  author: "Barynt",
  description: "Pull requests on issues.",
  repo: "acme/github",
  levels: ["project"],
  kind: "sandbox",
  versions,
  ...over,
});
const check = (raw: unknown, base_?: unknown, verify: "all" | "new" = "new") =>
  validateEntry("github.json", raw, { base: base_, verify, allowLocal: true, releaseBase: base });

describe("the release hash", () => {
  it("is what sha256sum … | sort -k2 | sha256sum prints", () => {
    const files = { "main.js": "a", "manifest.json": "b" };
    const line = (s: string, n: string) => `${createHash("sha256").update(s).digest("hex")}  ${n}\n`;
    expect(hashOf(files)).toBe(
      createHash("sha256").update(line("a", "main.js") + line("b", "manifest.json")).digest("hex"),
    );
  });
});

describe("an entry", () => {
  it("passes when its release's files hash to its version, and lists what it asks for", async () => {
    const hash = release({ "manifest.json": manifest(), "main.js": "export {}", "styles.css": "" });
    const r = await check(entry({ "0.1.0-beta.1": hash }));
    expect(r.errors).toEqual([]);
    expect(r.versions).toEqual([
      { version: "0.1.0-beta.1", errors: [], capabilities: ["issues:read", "webhooks:receive"] },
    ]);
  });

  it("fails on a hash that doesn't match, or a manifest that says otherwise", async () => {
    release({ "manifest.json": manifest({ id: "other", kind: "service" }), "main.js": "x" });
    const r = await check(entry({ "0.1.0-beta.1": "0".repeat(64) }));
    expect(r.versions[0].errors).toEqual([
      "manifest id is other, the entry's github",
      "manifest kind is service, the entry's sandbox",
      expect.stringContaining("hash mismatch"),
    ]);
  });

  it("needs the files a sandbox plugin runs, and the previews it lists", async () => {
    release({ "manifest.json": manifest({ previews: [{ file: "preview-1.webp" }] }) });
    const r = await check(entry({ "0.1.0-beta.1": "0".repeat(64) }));
    expect(r.versions[0].errors).toContain("main.js: not in the release");
    expect(r.versions[0].errors).toContain("preview-1.webp: listed in the manifest, not in the release");
  });

  it("keeps a released version as it was, and checks only new ones in a pull request", async () => {
    const hash = release({ "manifest.json": manifest(), "main.js": "x" });
    const before = entry({ "0.1.0-beta.1": hash });
    expect((await check(entry({ "0.1.0-beta.1": "f".repeat(64) }), before)).errors).toEqual([
      "0.1.0-beta.1: a released version's hash can't change",
    ]);
    expect((await check(entry({}), before)).errors.length).toBeGreaterThan(0);
    // Nothing new: nothing downloaded.
    expect((await check(before, before)).versions).toEqual([]);
  });

  it("is named after its id, in Barynt's format", async () => {
    expect((await check(entry({ "0.1.0-beta.1": "0".repeat(64) }, { id: "gh-plugin" }))).errors).toEqual([
      "id is gh-plugin, the file is github.json",
    ]);
    expect((await check({ id: "github", versions: {} })).errors.length).toBeGreaterThan(0);
  });
});

describe("where a release is", () => {
  it("reads GitHub releases, by short name or address", () => {
    expect(releaseFileUrl({ repo: "acme/github" }, "1.0.0", "main.js")).toBe(
      "https://github.com/acme/github/releases/download/1.0.0/main.js",
    );
    expect(releaseFileUrl({ repo: "https://github.com/acme/github.git" }, "1.0.0", "main.js")).toBe(
      "https://github.com/acme/github/releases/download/1.0.0/main.js",
    );
    expect(() => releaseFileUrl({ repo: "https://gitlab.com/acme/x" }, "1.0.0", "main.js")).toThrow();
  });

  it("never downloads from a private address", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "fd00::1", "169.254.1.1"])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress("140.82.112.3")).toBe(false);
  });
});
