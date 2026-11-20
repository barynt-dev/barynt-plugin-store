# Contributing a plugin

Plugins are added and updated with pull requests. Review works like it does for
code: CI checks the mechanical parts, a maintainer checks the rest, and the merge
is the approval.

## Add a new plugin

1. **Release it on GitHub**: a release tagged with the version (`0.1.0`, no `v`),
   with `manifest.json`, `main.js` (for a sandbox plugin), `styles.css` (optional)
   and the previews the manifest lists, flat. Never change the files of a
   published release.
2. **Compute the release hash** — what the plugin template's `bun run release`
   prints, or by hand:
   `sha256sum manifest.json main.js styles.css | sort -k2 | sha256sum`
3. **Add `plugins/<id>.json`** with your entry (see the [README](README.md)), the
   version and its hash in `versions`.
4. **Run `bun run build`** and commit the updated `plugins.json` with it.
5. **Open a pull request.** The `validate` check must pass.

Rules the CI enforces:

- The file name is the plugin id, as Barynt allows it.
- The release's files hash to the listed hash, its `manifest.json` has the
  entry's `id`, `kind` and `levels`, and the version the entry lists it under.
- `plugins.json` is what `plugins/` makes.
- The repository is on GitHub (other hosts aren't checked yet).

## Publish an update

Add the new version and its hash to `versions` (and, if you like, a line in
`notes`). Do **not** change or remove listed versions: their files are fixed once
merged, so instances that installed them keep working. Only new versions are
downloaded and checked in a pull request.

## What reviewers look at

- **Capabilities** the manifest asks for. CI lists them in the checks summary;
  each has to make sense for what the plugin does.
- **Network hosts** and **credentials**: what it talks to, and with whose token.
- **Purpose and description**: does the plugin do what it says?
- Changes to an existing plugin should come from its author.

## Running the checks locally

```sh
bun install
bun test
bun run validate
```
