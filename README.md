# Barynt Plugin Store

The official plugin directory for [Barynt](https://github.com/barynt-dev/barynt-web),
a self-hosted issue tracker. Barynt reads it as a plugin source: **Admin → Plugins →
Add source**, `https://github.com/barynt-dev/barynt-plugin-store` (provider GitHub).

> **Status: early.** Plugins come with Barynt 1.1.0. Until that's released, what's
> listed here is a pre-release.

## How it works

The directory is this Git repository. It contains **entries, not plugin code**:

```
plugins.json          what Barynt reads — made from plugins/ (`bun run build`)
plugins/<id>.json     one plugin's entry
```

An entry says where a plugin lives and pins each of its versions by its **release
hash**, the SHA-256 Barynt checks when it installs:

```json
{
  "id": "github",
  "name": "GitHub",
  "author": "Barynt",
  "description": "Pull requests, branches, commits and checks on the issues they name.",
  "repo": "barynt-dev/barynt-plugin-github",
  "levels": ["project"],
  "kind": "sandbox",
  "categories": ["development"],
  "versions": { "0.1.0-beta.1": "<the release hash>" }
}
```

- A **release** is a GitHub release tagged with the version itself (`1.2.0`, not
  `v1.2.0`), its files flat: `manifest.json`, `main.js`, `styles.css`, previews.
- **Authors** add or update an entry with a pull request.
- **CI** downloads each new version's files, computes the release hash as Barynt
  does, compares the manifest with the entry and lists the capabilities it asks for.
- **Maintainers** review and merge. **A merged entry is what makes a plugin
  verified**: Barynt installs only files that match the pinned hash, so a release
  changed afterwards is refused. A weekly run checks every version again.

How a release and its hash are made is in Barynt's
[publishing docs](https://github.com/barynt-dev/barynt-web/blob/main/docs/dev/plugins-publishing.md);
the [plugin template](https://github.com/barynt-dev/barynt-plugin-template) does it
with `bun run release` and its CI.

Want a private or company-internal directory? It's just a repository with a
`plugins.json` like this one — or a `plugins.json` on any web server.

## Adding a plugin

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun test               # the checks' tests
bun run build          # plugins.json from plugins/
bun run validate       # check every entry (downloads the releases)
```

`scripts/schema.ts` mirrors the entry format of Barynt's
`lib/plugins/directory.ts`.

## License

[MIT](LICENSE). Each plugin keeps its own license, declared in its manifest.
