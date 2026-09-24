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
pnpm test
pnpm test:release
node tools/pack-smoke.mjs
```

The gate does not prove terminal behaviour. That is what
`node tools/pty-drive.mjs` and the manual acceptance table in the README are
for: it allocates a real PTY, rebuilds first, sends a prompt, and prints what the
screen showed.

A linked profile loads `lib/`, never `src/`, so a run against a stale build
tests the previous release. `tools/pty-drive.mjs` rebuilds on every run for that
reason; a profile you launch by hand does not.

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
a branch tail, and no target means the checkout the script lives in. The script:

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

### What the clone carries

| Entry | Why it decides what you see |
| --- | --- |
| `.credentials.yaml` | the run cannot answer without it |
| `settings.yaml` (+ `.imported`) | theme, tokens, dock and stash sections |
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
cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml "$S/" && chmod 600 "$S"/*.yaml
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

The surface's bundle patch disables the base `skill-filesystem` row on purpose.
A session's preset mounts that row. Thus, `--profile tui` scans the roots above.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| the surface waits with no output and `--help` waits with it | the bundle left `dsh.profile.bundles`, or a local bundle's link does not resolve at the clone's depth | re-run the dogfood script (it rebuilds every `link:` as an absolute symlink); `dsh plugin add` re-materialises relative links and drops the other bundles |
| a source edit has no effect | the profile loads `lib/` | `pnpm run build`, or use the dogfood script |
| `error: Insufficient Balance` on every turn | the provider account behind the copied credentials has no credit | top up or point `--model`/provider elsewhere |
| `pnpm dsh --profile tui` exits before the surface appears | pnpm's dependency check fails on the harness checkout's own postinstall | see [README.md](README.md#launching-from-a-harness-checkout) |
| `pnpm dsh` boots the workspace-linked dev harness and composition fails | `pnpm dsh` runs the harness checkout's own `dsh`, not the released one | `dsh`, or `--dsh <released bin.js>`; `pty-drive` takes `--launcher` |

A broken link is silent: `dsh plugin install` and `dsh plugin add` drop a bundle
they cannot resolve and still exit 0, so a missing row is worth checking against
`node -p "require('<home>/profiles/tui/package.json').dsh.profile.bundles"`
before anything else. The dogfood script rebuilds every local `link:` as an
absolute symlink for exactly this reason: a profile installs those links relative
to the home it was made in, so a clone at another depth leaves them dangling.
