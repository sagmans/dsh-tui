# AGENTS.md

`@sagmans/dsh-tui` is a Cordis plugin bundle that gives DeepSeek Harness an
interactive terminal surface: `dsh --profile tui` runs one agent in the
alternate screen instead of a browser. ESM TypeScript (strict), Node >= 22.19,
pnpm. Behaviour and install: [README.md](README.md). Development on a real
profile: [DEVELOPMENT.md](DEVELOPMENT.md). Publication: [RELEASE.md](RELEASE.md).
History: [CHANGELOG.md](CHANGELOG.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Typecheck `src` and `tests` | `pnpm run typecheck` |
| Unit and golden tests | `pnpm test` |
| Release-helper guards (python3 >= 3.11) | `pnpm test:release` |
| Build `src` into `lib` | `pnpm run build` |
| Tarball inventory check | `node tools/pack-smoke.mjs` |
| Native widget PTY invariants | `pnpm test:terminal` |
| Drive the real surface in a PTY | `node tools/pty-drive.mjs --home <clone> --prompt 'Reply with exactly: pong'` |
| Dogfood a worktree in a cloned home | `./scripts/dogfood/run-tui-from-worktree.sh <worktree name or path>` |

`.github/workflows/ci.yml` is the completion gate, in this order: `pnpm install
--frozen-lockfile`, `npm audit signatures`, `pnpm typecheck`, `pnpm test`,
`pnpm test:release`, `node tools/pack-smoke.mjs`, `pnpm test:terminal`,
`node tools/harness-matrix.mjs`, `node tools/install-smoke.mjs`. The consumer
install gate needs Docker. The native widget gate checks input, redraw, resize,
and restoration without credentials.
It does not prove full-profile composition or hardware input-to-pixel latency.
Use the cloned-home PTY command above and read its screen for actual profile usage.

## Map

- `src/index.ts` mounts the surface; `src/startup.ts` parses this app's flags;
  `src/todo-guard.ts` is the one advisory agent-plane row, nudging a stale plan
  from the harness's own projections.
- `src/host/` holds the rows the bundle patch cannot mount itself: the roster shim
  publishes the mode registry plus one row per mode — a mode names a selection and
  mounts no plugin of another bundle — and the runner shim mounts the
  dynamic-plugin host creator mode needs, both after the services they wait on.
- `src/agent/` composes, projects, and resumes the agent. `src/cards.ts`,
  `src/transcript.ts`, and `src/work.ts` fold `session/event` into what is drawn;
  `src/ui/` draws the dock, editor, gates, pickers, markdown, and mermaid;
  `src/input/` holds keymap, submission, and completion; `src/terminal/` owns the
  alternate screen, restore, bell, and clipboard; `src/compat/` probes the harness
  it mounts on.
- `src/stash.ts` answers the parked-draft commands and their chord rows;
  `src/stash/` holds the bank's schema, the private path it is written through,
  and the lock one read-modify-write takes.
- `tests/unit/*.spec.ts` are the focused specs, `tests/golden/frames.spec.ts`
  snapshots rendered frames, `tests/release/test_release.py` guards
  `scripts/npm/release.py`.
- `scripts/dogfood/run-tui-from-worktree.sh` clones the developer's home, points
  the clone's own profile at a worktree, and runs the surface there;
  `.agents/skills/dsh-tui-dogfood/` is the packaged skill an agent loads,
  and [DEVELOPMENT.md](DEVELOPMENT.md) is the long form.
- `lib/` is build output and `.plans/` is local planning scratch; both are
  gitignored and neither is edited by hand.

## Sharp edges

**A linked profile loads `lib/`, not `src/`.** Source edits are invisible to
`dsh --profile tui` until `pnpm run build` runs.

**Specs reach sources only through the `@/` alias** (declared in
`vitest.config.ts`, mirrored by `tsconfig.test.json`): parent-relative imports
do not resolve under this runner.

**Point `DSH_HOME` at a scratch directory for every surface run**, and copy in
only the credentials that run needs. The real home holds
`~/.dsh/.credentials.yaml`; no credential or session log belongs in the tree.
Applies to the human too: a run against the real home writes real sessions,
history, storages, the stash, and themes. When a run needs the developer's own
bundles and patch overlay, clone the home with
`./scripts/dogfood/run-tui-from-worktree.sh` rather than pointing at it.

**A dogfood run uses the active model in the current session.** Declare it in the
clone's profile patch, in two entries: the adapter under the `llm-pi-ai` row's own
config, as `providers: { zai: { apiKeyEnv: ZAI_API_KEY } }`, and the route under
`agent-default-model`, as `provider`, `model`, and `reasoningEffort`. The
adapter belongs there because a catalog route is only the picker's directory — a
route declaring `source` with `auth.apiKeyRef` never registers one, and the turn
then stops at `no adapter registered for provider "zai"`. The route belongs there
so the clone has an explicit default; check `/status` on resume rather than
relying on `--provider` and `--model` alone. `$DSH_HOME/settings.yaml` is legacy
on this line: the settings service
renames it to `settings.yaml.imported` before attempting a one-time import into matching
profile entries. Rejected sections stay only in that renamed file; do not rely
on the legacy file for the clone's route. Naming the route keeps a scratch
profile from billing a route the developer did not choose; a route with no credit
stops at `error: Insufficient Balance` once the surface is ready, which says
nothing about the plugin under test.

**A rendered-frame change usually changes the golden snapshot.** Read
`tests/golden/__snapshots__/frames.spec.ts.snap` in the diff before accepting it
with `pnpm vitest run -u`.

**`cordis.patch.yml` inserts the TUI rows and host model-selection settings, and disables none.** The
agent plane — tools, prompt sections, skills, commands, and planning — belongs to
the bundle that ships each of those plugins, and the profile's own layers compose
it. The shipped modes are selections rather than full compositions; only PTC adds
a `tool-presentation` plugin. Do not duplicate agent rows the profile already
registers: duplicate registrations can fail with "already registered". Do not
disable those profile-owned rows from this surface bundle.

**The declared harness range is not the verified list.** The manifest declares
`>=0.2.0-rc.2 <0.3.0`, but lists only `0.2.0-rc.2` as verified. Mounted and
development harness dependencies pin that release; harness peers are open (`*`)
and optional. These declarations do not guarantee consumer deduplication.
`node tools/harness-matrix.mjs` checks manifest consistency, not installed
versions, compilation, or runtime behavior. `--check-registry` checks only the
`latest` dist-tag, not RC tags. Consumer install smoke checks selected install
paths and package-copy counts, not interactive profile behavior.
[RELEASE.md](RELEASE.md#harness-matrix) owns verification and matrix changes.

**Comments state why a choice was made**, not what the code does; the reason a
non-obvious constraint exists is the part that prevents future drift.

## Boundaries

- **Release and publication:** follow the signed-tag, approval, and readback
  sequence below and the gates in [RELEASE.md](RELEASE.md).
- **Dependency install scripts and release age are gated in
  `pnpm-workspace.yaml`** (`allowBuilds`, `minimumReleaseAgeExclude`). Ask before
  adding a dependency or allowlisting a build.
- **Commits are Conventional Commits with a scope** (`feat(tui): …`,
  `fix(gates): …`, `docs(readme): …`), signed and DCO-signed. Work on a branch and
  land through a PR.
- **Every PR carries its `CHANGELOG.md` entry** under `## [Unreleased]`, in the
  section that fits (`Added`, `Changed`, `Fixed`, …). The entry is part of the
  change, not a follow-up, and its absence makes the PR incomplete.

## Release and publication

Read [RELEASE.md](RELEASE.md) before preparing a version, pushing a release tag,
publishing, or repairing a release record. Shipping a documentation or code PR
is not approval to publish. Require explicit maintainer approval for publication
and each remote release action; never publish on your own initiative.

1. Land the candidate through a reviewed PR to `main`. Match `package.json`
   `version`, the `vX.Y.Z` tag, and the versioned `CHANGELOG.md` entry.
   Pass the release gates in `RELEASE.md` on the exact merged commit.
2. Create an annotated, signed tag on that commit:
   `git tag -s -a "vX.Y.Z" -m "vX.Y.Z" <merged-sha>`.
   Verify it with `git verify-tag "vX.Y.Z"`. Never use a lightweight or unsigned
   release tag; require GitHub to verify the signature after the approved push.
3. Push only that tag with `git push origin "vX.Y.Z"` after approval.
   `.github/workflows/release.yml` checks tag/version agreement and publishes through npm
   OIDC trusted publishing after the `npm-release` environment approval.
   Wait for success; never substitute a local `npm publish`. The documented
   first-publication bootstrap is a maintainer-only exception, not a retry path.
4. After publication succeeds, create the GitHub release from the existing tag:
   `gh release create "vX.Y.Z" --verify-tag --title "vX.Y.Z" --notes-file <notes-file>`.
   Use that version's changelog entry as notes. Set `--latest=false` when filling
   an older release so it does not replace the current latest release.
5. Read back the npm version, tarball integrity and available provenance, the
   remote tag's verified signature and source commit, and the published GitHub
   release for the same version. A green workflow alone is not completion:
   every npm version requires its own signed tag and GitHub release record.

Published versions and tags are immutable. Never delete, move, or re-sign an
existing release tag, and never republish or unpublish an existing npm version.
For a missing GitHub release, verify the existing signed tag and create only its
release record with `--verify-tag`; do not push another tag or retry publication.
If a tag or signature is missing or invalid, stop and ask the maintainer; do not
invent a source commit from current `main`. Forward-fix broken packages as
`RELEASE.md` directs. Helper mutations require `CONFIRM=<action>`; preview
with `DRY_RUN=1`.
