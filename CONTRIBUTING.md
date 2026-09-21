# Contributing a plugin

Plugins are added and updated with pull requests. Review works like it does for code:
CI checks the mechanical parts, a maintainer checks the rest, and the merge is the
approval.

> The plugin system in Barynt is not released yet, so the manifest format is
> provisional (see `scripts/schema.ts`). Entries that pass CI today may need
> small changes when the final manifest schema lands.

## Add a new plugin

1. **Build a release archive** of your plugin: a `.tgz`, `.tar.gz` or `.zip` with
   `barynt-plugin.json` at the archive root. Regular files only: no symlinks, no
   absolute or `..` paths. At most 50 MB, 5000 files, 200 MB unpacked.
2. **Publish it under a stable HTTPS URL**, for example as a GitHub release asset.
   Never replace or delete a published archive.
3. **Compute the hash**: `sha512sum your-plugin-1.0.0.tgz | cut -d' ' -f1`
4. **Create the entry** in `plugins/<plugin-id>/`:
   - `barynt-plugin.json`: an exact copy of the manifest inside the archive.
   - `source.json`: one item per version with `version`, `download` and `sha512`
     (optionally `released` and `changelog`). See [`plugins/_example`](plugins/_example).
5. **Open a pull request.** The `validate` check must pass.

Rules the CI enforces:

- The directory name is the plugin id: lowercase letters, digits and dashes,
  starting with a letter.
- `id` in the manifest equals the directory name. `license` is set.
- `download` is an `https://` URL to a public host.
- The hash matches, and the manifest inside the archive equals your copy.
- The manifest `version` equals the newest listed version.

## Publish an update

Add a new item to `versions` and update your `barynt-plugin.json` copy. Do **not**
edit or remove existing versions: their download and hash are fixed once merged,
so instances that installed them keep working. Only new versions are downloaded
and checked in a pull request.

If a version must not be installed any more, set `"revoked": true` (or a reason)
on it. Instances warn about revoked versions and refuse to install them.

## What reviewers look at

- **Capabilities** the manifest asks for. CI lists new ones in the checks summary;
  each has to make sense for what the plugin does.
- **Purpose and description**: does the plugin do what it says?
- Plugins that run code inside the Barynt server process get a closer look than
  purely declarative ones.
- Changes to an existing plugin should come from its author.

A weekly CI run re-downloads every published archive and compares it with its pinned
hash, so a release that was tampered with after the merge is noticed.

## Running the checks locally

```sh
bun install
bun test
bun run validate
```
