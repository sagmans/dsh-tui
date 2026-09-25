# What a ~/.dsh home holds, and what a dogfood run touches

Read this when a dogfood run behaves differently from the developer's own
profile. It gives the operational detail behind [../SKILL.md](../SKILL.md).

## The entries

| Entry | Kind | What reads or writes it |
| --- | --- | --- |
| `.credentials.yaml` | secret | the provider layer, at start-up; read-only |
| `settings.yaml`, `settings.yaml.imported` | config | the `dsh-tui:` section: theme, tokens, dock, stash, prompt history |
| `themes/` | data | created and watched at start-up; saving a file changes the live surface |
| `prompt-history.json` | data | the editor's history recall; appended as prompts are sent |
| `tui-stash/` | data | the parked-draft bank, one file per session, behind a lock |
| `storages/` | data | durable plugin state |
| `attachments/` | data | images pasted into prompts |
| `profiles/<name>/` | config | `package.json` (bundle list and deps), `cordis.yml`, `cordis.patch.yml`, a pnpm lockfile, `node_modules` |
| `sessions/<bucket>/<id>/` | data | the transcript (`session.v3.jsonl.zstd`) and a lock; the bucket name encodes the launch directory |
| `AGENTS.md` | config | injected into the agent's instructions |

## Home state versus profile state

Credentials, settings, themes, history, the stash, storages, and sessions belong
to the **home**: every profile in it shares them. The bundle list and the patch
overlay belong to the **profile**: a new profile name starts from the base plus
whatever is added to it, and inherits none of another profile's bundles or
patches. That is the trap behind "test it in a profile named after the feature" —
the run is compositionally thinner than the developer's own while still writing
their real state.

## What the dogfood clone changes

The checkout package name selects its bundle in `profiles/<name>/package.json`.
The generic helper adds it once if absent, repoints only its dependency, and
rebuilds cloned local symlinks. It uses `dsh plugin add` only if the profile is
missing after `dsh --help`, and does not modify the lockfile of an existing
profile. Other bundles and the profile patch remain copied from the source home.
One module, `scripts/clone-links.mjs`, holds the clone's link policy, so the
seeding step and the validator read the same rules.

`sessions/` is the only entry left out by default: it is the bulk of a home
(190M of 200M in a busy one) and a test drive rarely needs it. `--with-sessions`
copies it when present, which makes `--resume` reach the developer's history.

## Failure modes worth knowing

- **A missing row is silent.** `dsh plugin install` drops a bundle whose path
  does not resolve and still exits 0; the profile then composes the base alone and
  the surface waits with no output. Check
  `node -p "require('<home>/profiles/<name>/package.json').dsh.profile.bundles"`.
- **Mutable home state must remain inside the clone.** External symlinks in
  settings, storages, or sessions and multiply linked mutable files stop the run.
  Package links in `profiles/node_modules`, `profiles/*/node_modules`, and
  `profiles/*/.dsh-module-fallback/node_modules` can point to global installs or
  external checkouts, but not into the source home. An instruction file linked
  into a shared prompt tree (`AGENTS.md`, `CLAUDE.md`) is read only and is copied
  in while seeding, so the clone stays self-contained; a link to state the run may
  write still stops the run. Writes through permitted package links are not
  isolated. Re-seed with `--reseed` when the source changes.
- **The clone keeps a copy of the credentials.** Create it in a scratch
  directory, keep it `700`, and `--clean` it when done.
- **The launcher decides the harness, not the profile.** `pnpm dsh` runs the
  workspace-linked harness checkout (a dev build, which may fail to compose);
  `dsh` on `PATH` is the released one. A profile cannot tell them apart.
- **A turn can fail for reasons outside the surface** — no provider credit, a
  sandbox policy, a missing credential. Read the error line in the transcript
  before treating it as a rendering bug.

## Cleanup

```sh
~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh --status      # which clone, which target
~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh --clean       # removes it (marker-guarded)
```

The default clone lives at `${TMPDIR:-/tmp}/dsh-dogfood/<worktree>-<checkout-id>`
and survives until `--clean` removes it. Cleanup validates the scratch-home
marker against its canonical home, source, checkout, and profile.
