# Development

How to work on the surface itself. Behaviour, install, and the manual acceptance
table live in [README.md](README.md); publication lives in
[RELEASE.md](RELEASE.md); the agent-facing map is [AGENTS.md](AGENTS.md).

## Gates

In this order, because CI runs them in this order:

```sh
pnpm install --frozen-lockfile
npm audit signatures
pnpm run typecheck
pnpm test:golden
node tools/pack-smoke.mjs
pnpm test:terminal
pnpm dogfood
node tools/harness-matrix.mjs
node tools/install-smoke.mjs  # requires Docker with a running daemon
```

Unit tests are not maintained. Golden tests remain visual regression checks, not actual-use proof.
Run `pnpm verify` after development: free real-profile dogfood runs automatically.
[FEATURES.md](FEATURES.md) defines scope and evidence requirements.
In a Herdr-managed caller, the same gate also runs real native-pane workflows in a disposable named session.
Without that prerequisite, the report records unavailable Herdr evidence; portable PTY checks still run.
When tmux is installed, the same gate also verifies a private server, Unicode editing, stash outcomes, and terminal restoration.
Private native controllers do not start the caller's shell or source its startup files.

Golden tests do not prove native terminal behaviour. `pnpm test:terminal` checks native widgets in a credential-free PTY.
It checks ASCII, Unicode, paste, Kitty press/repeat/release, redraw limits, resize, and terminal restoration during styled streaming.
Its receipt reports dispatch-to-output-write timing, not hardware-input-to-pixel latency. Shared CI runners do not enforce timing budgets.

The native-widget check does not start a full Cordis profile. `pnpm dogfood`
starts the installed Harness with the base bundle and this checkout in fresh
credential-free homes, then checks real command, editor, picker, persistence,
and shutdown behavior. It retains private screen evidence and fails on missing
postconditions or terminal restoration. It does not call a model.

For explicit paid verification, run `node tools/pty-drive.mjs --home <clone>`
and follow the manual acceptance table in the README: the driver verifies the
installed launcher against the releases the manifest lists, rebuilds, allocates a
PTY, and prints the screen.

A linked profile loads `lib/`, never `src/`, so a run against a stale build
tests the previous release. `tools/pty-drive.mjs` rebuilds on every run for that
reason; a profile you launch by hand does not.

## Local static checks

```sh
pnpm run check:unused
pnpm run check:deadcode
pnpm run check:local
```

`check:unused` uses TypeScript to reject unused locals and parameters without producing build output.
`check:deadcode` uses Knip in production mode, so test references cannot hide test-only production APIs.
Published module roots come from package metadata; Cordis-only rows and standalone native helpers use explicit entries.
Herdr remains an optional host-native executable, not an npm package dependency.
The optional default-model peer retains the verified RC development pin because wildcard resolution does not safely select that prerelease.
`pnpm exec knip --no-progress` also checks supported golden fixtures and development-only code.
Review findings against published module entry points and dynamic Cordis loading before removing code.
[Knip 6 omits class-member analysis](https://knip.dev/blog/knip-v6#what-about-classmembers).
Review class methods and test-only customization separately; framework callbacks remain live even without direct method references.

Repository hooks live in `.githooks`. The commit hook runs the TypeScript check.
The message hooks call the existing global hooks to retain message structure and DCO policy.
The push hook runs the global signature/DCO check before TypeScript and Knip.
Forwarders preserve arguments, standard input, and failure status; missing or recursive global hooks stop the operation.

Activate these hooks only with repository-level approval:

```bash
git config --local core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"
```

Git uses this absolute directory for this repository and its linked worktrees.
The absolute path preserves global-policy forwarding when another worktree does not contain `.githooks`.
Other worktrees must support the local check commands; otherwise those checks stop the operation.
Before removing the hook-owning worktree, move this local setting to a maintained checkout that contains the hooks.
The forwarders read `core.hooksPath` from included global configuration; global files and configuration stay unchanged.
These additional checks remain local; GitHub CI stays unchanged.

## Performance evidence

Use the same machine, Node version, terminal, dimensions, profile, and workload for baseline and treatment.
Record input and output timestamps, sample counts, p50/p95, maximum, redraw counts, and terminal restoration.
Do not treat PTY output or a 60 fps video without input timestamps as hardware latency proof.
Run timing budgets only on a controlled host; native behavioral invariants remain safe gates on shared CI runners.

Profile matching history suggestions separately from unmatched input. Fresh raw-user consent still gates each actual suggestion.
The supported SettingsForms API exposes `describe(options)`, but no namespace-scoped raw-user read.
A scoped optimization needs a supported harness capability. Do not cache consent or substitute applied configuration for raw opt-outs.

Measure history misses at 2,000 and 20,000 entries, and streaming at 100 and 10,000 settled entries.
A miss cache or incremental document assembly needs a material measured benefit before it adds invalidation state.
Keep coverage for 10,000-character drafts, 45,700-character live output, and 8,000-character styled output when testing those workloads.
Native Linux CI and local macOS PTYs do not replace the supported emulator, tmux, SSH, and hardware-key acceptance checks.

## Trying a change in a real profile

Two questions decide how to run a build, and they pull in opposite directions.
A throwaway home is safe but compositionally empty: it has no other bundles, no
profile patch, no settings, no themes, so a change is tested against a setup
nobody runs and an integration bug has nowhere to show up. The real home is
compositionally right but is live state: a branch that migrates sessions,
storages, or the stash rewrites what the daily driver reads, and a crash
mid-write leaves real files broken.

The way out is a **clone**: copy the real home, run the real profile inside the
copy, and repoint only the bundle under test. Everything that shapes a run is
present; every write lands in a throwaway directory.

### Dogfood a worktree

```sh
./scripts/dogfood/run-tui-from-worktree.sh                    # this checkout
./scripts/dogfood/run-tui-from-worktree.sh feat/copy-columns  # a sibling worktree
./scripts/dogfood/run-tui-from-worktree.sh ../dsh-tui-fix -- --resume
```

The target is a worktree name or path; the name matches a worktree directory or
a branch tail, and no target means the checkout the script lives in. For this TUI,
the packaged helper rejects host versions outside `dsh.compatibility.dshReleases`
before it clones the home. Use installed `dsh`, not a Harness source checkout.
The script:

1. clones `~/.dsh` to `<tmp>/dsh-dogfood/<worktree>` (10M for a typical home:
   `sessions/` is the bulk and is left out unless `--with-sessions` is given),
2. runs `pnpm run build` in the target, because the profile loads `lib/`,
3. runs `dsh plugin --profile tui add <target>` inside the clone, which repoints
   `@sagmans/dsh-tui` at that checkout and leaves every other bundle and the
   profile patch alone,
4. starts the surface.

Later runs reuse the clone and only re-link and rebuild, so they start in about a
second. `--status` prints what the clone is pointed at, `--clean` removes it,
and `--list` prints the repository's worktrees. Nothing outside the clone is
written; `--clean` refuses any directory that lacks the marker the script wrote.

```sh
./scripts/dogfood/run-tui-from-worktree.sh --dry-run --with-sessions
./scripts/dogfood/run-tui-from-worktree.sh --status
./scripts/dogfood/run-tui-from-worktree.sh --clean
```

Flags that matter day to day: `--with-sessions` copies stored sessions, which is
what makes `--resume` reach your own history; `--fresh` seeds only credentials
and settings, for a composition-free run; `--profile NAME` uses another profile
of the same home; `--source-home DIR` clones a home other than `~/.dsh`, which
is what a shell with a custom `DSH_HOME` needs, since the script deliberately
does not follow `DSH_HOME` — an agent run has its own scratch home in that
variable, and cloning that is never what a developer meant.

### The model a dogfood run uses

Use the active model in the current session for dogfooding. Configure its adapter
and `agent-default-model` route in the clone's profile patch. `settings.yaml` is
legacy input on verified `0.2.0-rc.2`, not a live route overlay. Do not rely on launch flags
`--model` and `--provider` alone for a resumed session; check `/status` and
select `/model` before sending a prompt. A route with no credit
stops at `error: Insufficient Balance`
after the surface is ready, which proves composition and nothing about the plugin
under test.

### What the clone carries

| Entry | Why it decides what you see |
| --- | --- |
| `.credentials.yaml` | the run cannot answer without it |
| `settings.yaml` (+ `.imported`) | legacy migration input; live Config-backed settings belong to profile entries on verified `0.2.0-rc.2` |
| `themes/` | the surface writes and watches this directory at start-up |
| `prompt-history.json` | history recall in the editor |
| `tui-stash/` | the parked-draft bank and its lock |
| `storages/` | durable plugin state |
| `attachments/` | images pasted into prompts |
| `profiles/<name>/` | the bundle list and `cordis.patch.yml` that compose the run |
| `sessions/` | only with `--with-sessions`; the bulk of the home |

The clone holds a copy of your credentials, so it is created `700`, it belongs
in a scratch directory, and `--clean` is the way to be rid of it.

### A scratch home by hand

For a repro someone else can run, or when the question *is* what a build does to
state it has never seen, use an empty home and copy in only what the run needs
(the README's recipe):

```sh
S=$(mktemp -d)
cp ~/.dsh/.credentials.yaml "$S/" && chmod 600 "$S/.credentials.yaml"
DSH_HOME="$S" dsh plugin --profile tui add "$PWD"
DSH_HOME="$S" dsh --profile tui
```

### The real home

Only for the surface you already run: no feature build, no uncommitted checkout.
Everything a profile touches there is live, and nothing distinguishes a test
session from a real one afterwards.

## Repository skills

`.agents/skills/<name>/SKILL.md` holds skills for agents working in this
repository. The harness's filesystem skill provider scans, in rank order,
`<projectRoot>/.dsh/skills`, `<projectRoot>/.agents/skills`, then the user roots
`<dshHome>/skills` (its `.system` child skipped) and `~/.agents/skills`, where
the project root is the nearest ancestor holding `.git`. A skill is a directory
bundle `<name>/SKILL.md` or a flat `<name>.md`; nested `**/SKILL.md` files are
deliberately not discovered, so a `references/` directory is safe. Frontmatter
requires `name` and `description` and may add `whenToUse`, `metadata`,
`disable-model-invocation`, and `user-invocable`.

This repository ships [`dsh-tui-dogfood`](.agents/skills/dsh-tui-dogfood/SKILL.md).
Run `dsh --profile tui install-skills` to copy it to `~/.agents/skills/` for use
from any dsh plugin checkout. An existing copy prompts for confirmation on a
TTY. Use `dsh --profile tui install-skills --update` to replace it without a
prompt. The skill tells an agent how to hand a developer an isolated profile
to test.

The surface's bundle patch does not disable `skill-filesystem`. The profile's
composition must supply the skill rows; the shipped modes do not mount them.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| the surface waits with no output and `--help` waits with it | the bundle left `dsh.profile.bundles`, or a local bundle's link does not resolve at the clone's depth | re-run the dogfood script (it rebuilds every `link:` as an absolute symlink); `dsh plugin add` re-materialises relative links and drops the other bundles |
| a source edit has no effect | the profile loads `lib/` | `pnpm run build`, or use the dogfood script |
| `error: Insufficient Balance` on every turn | the provider account behind the copied credentials has no credit, or the run named it | point the run at the model active in the current session, which is what every dogfood run should use |
| `pty-drive: --home must name an existing isolated directory` | the PTY driver refuses to use the live home | clone the profile first, then pass its directory with `--home` |
| `pty-drive: launcher must report a verified release (...), got ...` | the selected launcher is not a release the manifest lists | run `dsh --version` and select that installed release, not a Harness source checkout |

A broken link is silent: `dsh plugin install` and `dsh plugin add` drop a bundle
they cannot resolve and still exit 0, so a missing row is worth checking against
`node -p "require('<home>/profiles/tui/package.json').dsh.profile.bundles"`
before anything else. The dogfood script rebuilds every local `link:` as an
absolute symlink for exactly this reason: a profile installs those links relative
to the home it was made in, so a clone at another depth leaves them dangling.
