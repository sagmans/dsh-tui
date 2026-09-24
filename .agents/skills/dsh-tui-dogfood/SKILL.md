---
name: dsh-tui-dogfood
description: "Use when a dsh plugin checkout must be tested against a real profile without writing to the developer's live home: clone the home, relink only that plugin, and run or hand off the profile."
---
# Dogfood a dsh plugin checkout

A fresh `DSH_HOME` misses the installed bundles, profile patch, settings, and themes.
A run against the real home writes real sessions and state. Clone the source
home and relink only the plugin under test inside the clone.

From **any dsh plugin checkout root**, run the packaged helper:

```sh
~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh --no-launch
~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh feat/plugin-fix -- --resume
~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh ../plugin-fix --dry-run
```

No target means the current checkout. A name matches its repository's worktree
directory or branch tail. A path selects that checkout directly. The helper reads
`package.json` for the plugin name; it never assumes `@sagmans/dsh-tui`. It
runs `pnpm run build` only when the checkout declares a build script. It adds
the bundle once if absent from the cloned profile, updates only its dependency,
restores local links from `link:` specifications, and launches
`dsh --profile tui` by default. The legacy
`scripts/dogfood/run-tui-from-worktree.sh` remains available in dsh-tui and
defaults to that script's checkout even when called elsewhere.

| Need | Option |
| --- | --- |
| Inspect clone and linked bundle | `--status` |
| Copy saved sessions for `--resume` | `--with-sessions` |
| Copy credentials and settings only | `--fresh` |
| Select profile, source home, or scratch home | `--profile NAME`, `--source-home DIR`, `--home DIR` |
| Print plan without mutation | `--dry-run` |
| Set up without starting dsh | `--no-launch` |
| Discard and clone again | `--reseed` |
| Remove matching scratch clone | `--clean` |
| List checkout worktrees | `--list` |

The helper ignores `$DSH_HOME` as source. Pass `--source-home "$DSH_HOME"`
when you intend to clone it. The default scratch path includes the checkout
name and path hash to avoid reuse across repositories.

The clone contains copied credentials. Store it only in private scratch storage
and remove it with `--clean`. Cleanup and reseed refuse nonmatching markers,
source-home overlap, and home-root paths.

External links are allowed only under `profiles/node_modules`,
`profiles/*/node_modules`, and `profiles/*/.dsh-module-fallback/node_modules`.
These package links can point to global packages or external checkouts, but
never into the source home. Mutable cloned files with multiple hardlinks are
rejected. Never write test state through a package link.

The old dsh-tui entry point still requires a prelisted bundle. Do not use
`dsh plugin add` on a cloned profile with other bundles; it can drop them.

Use `--status` to verify the existing bundles and the checkout `link:`
dependency. In dsh-tui, drive a cloned profile with:

```sh
node tools/pty-drive.mjs --launcher "$(command -v dsh)" --home <clone> --prompt 'Reply with exactly: pong'
```

Dsh-tui source edits are invisible until `pnpm run build` updates `lib/`.
Omit `--no-build` for real runs.

If the checkout or source home was removed, use
`--clean --home <clone> --source-home <original-source-path>`. Run from the
checkout while it exists, or pass its path as the target from another
directory. If the checkout was removed, run from any directory. Supply the
original `--profile NAME` when it was not `tui`.

Cleanup canonicalizes a missing source path only for `--clean --home` and
still requires its marker to match. Orphan cleanup requires a private marker
owned by the current user. It validates home, source, profile, and absent
target, but cannot recheck a removed checkout.

For home contents, storage, and cleanup details, read [references/home-state.md](references/home-state.md).
