---
name: dogfood-tui
description: "Use when a change to this repository's terminal surface has to be tried in a real dsh profile: dogfooding a worktree or branch, handing a developer a profile to test by hand, reproducing a report on the live surface, or choosing between a throwaway home, a cloned home, and the real one."
---
# Dogfood the TUI

## Why a clone, and not a scratch home

A fresh `DSH_HOME` proves the bundle boots and nothing else. It carries no other
bundles, no `cordis.patch.yml`, no settings, no themes — so a change is tested
against a composition nobody runs and an integration bug has nowhere to show up.
Running the real home is the opposite mistake: the branch then writes sessions,
prompt history, storages, the stash, and themes into the state the developer's
daily driver reads, and a state migration or a crash mid-write lands there for
good.

Clone the home, run the real profile inside the clone, repoint only the bundle
under test. Everything that shapes a run is present; every write goes to a
throwaway directory.

## The one command

From the repository root:

```sh
./scripts/dogfood/run-tui-from-worktree.sh                    # this checkout
./scripts/dogfood/run-tui-from-worktree.sh feat/copy-columns  # a sibling worktree
./scripts/dogfood/run-tui-from-worktree.sh ../dsh-tui-fix     # a path
./scripts/dogfood/run-tui-from-worktree.sh feature-x -- --resume
```

The target is a worktree name or path; a name matches a worktree directory or a
branch tail, and no target means the checkout the script lives in. The script
clones `~/.dsh` to `<tmp>/dsh-dogfood/<worktree>` with `sessions/` left out,
runs `pnpm run build` in the target, points `@sagmans/dsh-tui` at that checkout
inside the clone, and starts the surface. Later runs reuse the clone in about a
second.

## Quick reference

| Need | Command |
| --- | --- |
| See what the clone points at | `... --status` |
| Resume the developer's history | `... --with-sessions` (the first run copies ~190M) |
| A composition-free run | `... --fresh` (credentials and settings only) |
| Another profile of the same home | `... --profile NAME` |
| A home other than `~/.dsh` | `... --source-home DIR` |
| Plan without touching anything | `... --dry-run` |
| Set up but do not start | `... --no-launch` |
| Remove the clone | `... --clean` (refuses a directory it did not create) |
| List the repository's worktrees | `... --list` |

The script does **not** follow `$DSH_HOME`: an agent run has its own scratch home
in that variable, and cloning that is never what a developer meant. Pass
`--source-home "$DSH_HOME"` when the custom home really is the target.

## What the clone keeps

`credentials`, `settings.yaml`, `themes/`, `prompt-history.json`,
`tui-stash/`, `storages/`, `attachments/`, and `profiles/<name>/` — the bundle
list and profile patch that compose the run. Only `sessions/` is opt-in. The
clone holds a copy of the credentials: it is created `700`, it belongs in a
scratch directory, and `--clean` is how it goes away.

Details, including what a run writes where and the failure modes worth knowing:
[references/home-state.md](references/home-state.md).

## Prove it before handing it over

1. `... --status` — the bundle list must still name every bundle the real profile
   had, and `link:` must point at the worktree under test.
2. `node tools/pty-drive.mjs --launcher "$(command -v dsh)" --home <clone> --prompt 'Reply with exactly: pong'`
   boots it in a real PTY. Without `--launcher`, pty-drive runs the
   workspace-linked dev harness (`pnpm dsh`), which is a different build and may
   fail to compose for reasons that have nothing to do with the change.
3. Hand over the printed `DSH_HOME=... dsh --profile tui` line, or the
   `--no-launch` output.

## Troubleshooting

- The surface waits with no output and `--help` waits with it: the bundle left
  `dsh.profile.bundles` (a moved link is enough), or a local bundle's link does
  not resolve at the clone's depth. Do not reach for `dsh plugin --profile tui
  add` — it re-materialises relative links and drops the other bundles. Re-run
  the script (it rebuilds every `link:` as an absolute symlink), or relink by
  hand.
- A source edit has no effect: the profile loads `lib/`. Re-run without
  `--no-build`.
- `error: Insufficient Balance`: the provider account behind the copied
  credentials has no credit; that is not a surface bug.
- `pnpm dsh --profile tui` exits before the surface appears: pnpm's dependency
  check on the harness checkout. Use `dsh` directly or the dogfood script.

Long form: [DEVELOPMENT.md](../../../DEVELOPMENT.md).
