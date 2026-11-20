import { z } from "zod";

// The format Barynt reads (BARY-232): a `plugins.json` — a list of entries —
// in the repository's root. It mirrors `directoryEntrySchema` in Barynt's
// `lib/plugins/directory.ts`; a change there is a change here.

export const PLUGIN_ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const REPO =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}|https?:\/\/\S{3,290})$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const PLUGIN_LEVELS = ["workspace", "project"] as const;
export const PLUGIN_KINDS = ["declarative", "sandbox", "service"] as const;
export const GIT_PROVIDERS = ["github", "gitlab", "gitea", "bitbucket", "https"] as const;
export const PLUGIN_CATEGORIES = [
  "development",
  "planning",
  "communication",
  "reports",
  "time",
  "automation",
  "support",
] as const;

const semver = z.string().regex(SEMVER, "expected MAJOR.MINOR.PATCH");

export const entrySchema = z.strictObject({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().trim().min(1).max(60),
  author: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  repo: z.string().regex(REPO, 'expected a repository address or "owner/name"'),
  provider: z.enum(GIT_PROVIDERS).optional(),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).max(3).optional(),
  featured: z.boolean().optional(),
  added: z.iso.date().optional(),
  notes: z.record(semver, z.string().trim().min(1).max(2000)).optional(),
  levels: z.array(z.enum(PLUGIN_LEVELS)).min(1).max(2),
  kind: z.enum(PLUGIN_KINDS),
  versions: z
    .record(semver, z.string().regex(SHA256, "expected a lower-case SHA-256"))
    .refine((v) => Object.keys(v).length > 0, "lists no version"),
});

export type Entry = z.infer<typeof entrySchema>;

/** What the store checks of a release's manifest against its entry; Barynt
 *  checks the rest when it installs. */
export const releaseManifestSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  version: semver,
  kind: z.enum(PLUGIN_KINDS),
  levels: z.array(z.enum(PLUGIN_LEVELS)),
  capabilities: z.array(z.string()),
  network: z.array(z.string()).optional(),
  previews: z.array(z.looseObject({ file: z.string() })).optional(),
});
