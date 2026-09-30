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
| Drive the real surface in a PTY | `node tools/pty-drive.mjs --home <clone> --prompt 'Reply with exactly: pong'` |
| Dogfood a worktree in a cloned home | `./scripts/dogfood/run-tui-from-worktree.sh <worktree name or path>` |

`.github/workflows/ci.yml` is the completion gate, in this order: `pnpm install
--frozen-lockfile`, `npm audit signatures`, `pnpm typecheck`, `pnpm test`,
`pnpm test:release`, `node tools/pack-smoke.mjs`. Terminal behaviour is not
proven by that gate — use the cloned-home PTY command above and read its screen.

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
because the app's `--provider` and `--model` flags are ignored when a session
resumes, and `$DSH_HOME/settings.yaml` is legacy on this line: the launcher renames
it to `settings.yaml.imported` and never folds its sections into the profile patch,
so a route declared only there is silently absent. Naming the route keeps a scratch
profile from billing a route the developer did not choose; a route with no credit
stops at `error: Insufficient Balance` once the surface is ready, which says
nothing about the plugin under test.

**A rendered-frame change usually changes the golden snapshot.** Read
`tests/golden/__snapshots__/frames.spec.ts.snap` in the diff before accepting it
with `pnpm vitest run -u`.

**`cordis.patch.yml` mounts only this bundle's own rows, and disables none.** The
agent plane — tools, prompt sections, skills, commands, and planning — belongs to
the bundle that ships each of those plugins, and the profile's own layers compose
it. The shipped modes are selections rather than compositions, so they list no
plugin either. A row mounted here registers a plugin the profile already
registered, and composition fails with "already registered" for every one of
them; a row disabled here is the same mistake from the other side.

**The harness matrix names one supported line.** The `devDependencies`,
`dsh.compatibility.dshReleases`, and every harness package this bundle mounts name
the same verified release, and `dsh.compatibility.dsh` is the range a profile
resolves it through. One line means one copy: an alias of this bundle's own beside
the base's own row is what made a consumer tree hold two copies of a mounted package
and disable the host's rows, which `tools/install-smoke.mjs` counts. The harness
peers stay `*` so npm resolves them against the consumer's own harness, because npm
reaches a prerelease only through a comparator naming its own `X.Y.Z` tuple.
`node tools/harness-matrix.mjs` guards the matrix and
[RELEASE.md](RELEASE.md#harness-matrix) owns the bump.

**Comments state why a choice was made**, not what the code does; the reason a
non-obvious constraint exists is the part that prevents future drift.

## Boundaries

- **Publication is tag-driven CI, never local.** `release.yml` publishes through
  npm OIDC trusted publishing and the repository stores no token; the
  `scripts/npm/` helpers act only on an explicit `CONFIRM=<action>` (preview with
  `DRY_RUN=1`). Ask the maintainer instead of starting a release.
- **Release shape:** the `vX.Y.Z` tag and `package.json` `version` must match,
  and a candidate reaches `main` through a reviewed PR (squash merge).
- **A publication carries both its tag and its GitHub release.** The tag is what
  `release.yml` publishes from; the record, with the `CHANGELOG.md` entry as notes,
  is what a reader finds. A version short of either half is incomplete, and the
  missing half is created from the same signed tag — never by retagging. The gates
  are [RELEASE.md](RELEASE.md#gates--all-required-before-tagging)'s.
- **Dependency install scripts and release age are gated in
  `pnpm-workspace.yaml`** (`allowBuilds`, `minimumReleaseAgeExclude`). Ask before
  adding a dependency or allowlisting a build.
- **Commits are Conventional Commits with a scope** (`feat(tui): …`,
  `fix(gates): …`, `docs(readme): …`), signed and DCO-signed. Work on a branch and
  land through a PR.
- **Every PR carries its `CHANGELOG.md` entry** under `## [Unreleased]`, in the
  section that fits (`Added`, `Changed`, `Fixed`, …). The entry is part of the
  change, not a follow-up, and its absence makes the PR incomplete.
