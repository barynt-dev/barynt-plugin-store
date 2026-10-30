# Barynt Plugin Store

The official plugin store for [Barynt](https://github.com/barynt-dev/barynt-web), a
self-hosted issue tracker.

> **Status: early.** Barynt's plugin system is still being built, so no Barynt
> release reads this repository yet. The layout and the manifest schema below are
> provisional and will change until the plugin system ships. The tooling in this
> repository (validation, CI) already works.

## How it works

The store is this Git repository. It contains **entries, not plugin code**. An
entry says where to download a plugin's release archive and pins that archive by
its SHA-512 hash:

```
store.json                  store id and name
plugins/
  <plugin-id>/
    barynt-plugin.json      the plugin's manifest, a verbatim copy of the one inside the archive
    source.json             download link and SHA-512 for every published version
```

- **Authors** add or update an entry with a pull request.
- **CI** downloads the archive, checks the hash, compares the manifest inside the
  archive with the copy in the entry and reports new capabilities for review.
- **Maintainers** review and merge. **A merged entry is what makes a plugin
  verified**: a Barynt instance installs only what matches the pinned hash, so a
  release that is changed afterwards is refused instead of installed.
- **Barynt instances** keep a local clone of this repository, show its plugins in
  the admin area and install from the authors' release links.

Want a private or company-internal store? A store is just a repository with this
layout. Fork this one or start from the schemas in [`schemas/`](schemas), and add its
Git URL in your Barynt instance's system settings once that is supported.

## Adding a plugin

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun test                   # validator tests
bun run schemas            # regenerate schemas/*.json from scripts/schema.ts
bun run validate           # check every entry (downloads the archives)
```

`scripts/schema.ts` is the single source of truth for the entry format; the JSON
Schemas in `schemas/` are generated from it and checked in CI.

## License

[MIT](LICENSE). Each plugin keeps its own license, declared in its manifest.
