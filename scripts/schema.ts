import { z } from "zod";

// Schemas for everything a store repository contains. They are the single
// source of truth: the CI (`scripts/validate.ts`) uses them, and
// `bun run schemas` generates the JSON Schemas under `schemas/` from them.

/** Plugin id: lowercase ASCII letters, digits and dashes. Must equal the directory name. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{1,62}$/;

const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Tests only: lets fixtures point at http://127.0.0.1. Never set in CI workflows. */
const allowLocal = () => process.env.BARYNT_STORE_ALLOW_LOCAL === "1";

const httpsUrl = z
  .url()
  .refine(
    (value) => allowLocal() || new URL(value).protocol === "https:",
    "must be an https:// URL",
  );

/** `store.json` at the repository root. */
export const storeSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
  /** Reserved for verifying signed commits of this store; not evaluated yet. */
  maintainerKeys: z.array(z.string().min(1)).optional(),
});

/**
 * `plugins/<id>/barynt-plugin.json`: a verbatim copy of the manifest inside the
 * release archive. PROVISIONAL: Barynt's real manifest schema is still being
 * designed, so unknown keys pass through and only the fields the store itself
 * needs are checked.
 */
export const manifestSchema = z.looseObject({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1).max(80),
  version: z.string().regex(SEMVER),
  description: z.string().min(1).max(500),
  author: z.union([
    z.string().min(1),
    z.looseObject({ name: z.string().min(1) }),
  ]),
  license: z.string().min(1),
  /** SemVer range of Barynt versions the plugin supports. */
  barynt: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
});

/** One published release. Once merged, `download` and `sha512` never change. */
export const versionSchema = z.strictObject({
  version: z.string().regex(SEMVER),
  download: httpsUrl,
  sha512: z
    .string()
    .regex(/^[0-9a-f]{128}$/, "must be 128 lowercase hex characters"),
  released: z.iso.date().optional(),
  changelog: httpsUrl.optional(),
  /** `true` or a reason. Instances warn and refuse to install a revoked version. */
  revoked: z.union([z.literal(true), z.string().min(1)]).optional(),
});

/** `plugins/<id>/source.json`. */
export const sourceSchema = z
  .strictObject({
    $schema: z.string().optional(),
    repository: httpsUrl.optional(),
    versions: z.array(versionSchema).min(1),
  })
  .superRefine((source, ctx) => {
    const seen = new Set<string>();
    source.versions.forEach((entry, index) => {
      if (seen.has(entry.version)) {
        ctx.addIssue({
          code: "custom",
          path: ["versions", index, "version"],
          message: `version ${entry.version} is listed twice`,
        });
      }
      seen.add(entry.version);
    });
  });
