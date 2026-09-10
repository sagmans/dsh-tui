# @sagmans/dsh-tui

Interactive terminal (TUI) surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): use `dsh` in a terminal instead of a browser.

Status: **v1 feature-complete.** The surface owns the alternate screen, streams assistant text as markdown, renders every tool's own card, answers approvals and questions, restores and names stored conversations, switches model mid-session, reads a child agent's conversation in place, keeps the goal, plan mode, todo list, delegations, and background jobs above the editor with a status line below it, and hands the terminal back on every graceful exit. What is left is packaging: the publish itself.

## Install

```sh
dsh plugin --profile tui add @sagmans/dsh-tui@latest
dsh --profile tui
```

The first command creates a base-backed `tui` profile and adds this bundle to it. Requires Node.js >= 22.19, a real terminal (stdin and stdout must be TTYs), and `pnpm` on `PATH` for the install step.

## Usage

```sh
dsh --profile tui                      # new session in the current directory
dsh --profile tui --resume             # pick a stored session, titled by its first prompt
dsh --profile tui --resume <session-id>
dsh --profile tui --model deepseek-chat
dsh --profile tui --no-color
dsh --profile tui --no-bell            # do not ring when a long turn finishes
```

| Key | Action |
|---|---|
| Enter | submit the prompt |
| Ctrl+C | interrupt the running turn, or leave when idle |
| Ctrl+O | show every line of the tool cards instead of their preview |
| Ctrl+T | show the reasoning behind an answer instead of its summary |
| `y` / `n` / Esc | allow once, reject, or cancel a pending approval |
| digits / space / ↑↓ / Enter / Esc | answer a question: pick or toggle, confirm, or skip one |
| `/` then Tab | complete commands, including every command this session registered |
| `@` or a path then Tab | complete workspace file references |
| `ctrl+shift+f` | search the transcript (`enter` next, `shift+enter` previous, `esc` close) |
| `home` / `end` | jump to the start or the end of the transcript |
| `ctrl+down` | jump to the next prompt |
| `ctrl+b` | leave a child's conversation and return to this session |
| mouse wheel, drag | scroll, and copy a selection through OSC 52 |
| `/help` | list registered and local commands |
| `/status` | show the session id, model, permissions, context, and directory |
| `/model` | show the route the next step will use, and the providers available |
| `/model <provider>` | list that provider's advertised models |
| `/model <provider>/<model>` | use that route from the next step on (session only, nothing is written to settings) |
| `/jobs` | list background jobs with their state and duration |
| `/jobs read <id>` / `/jobs kill <id>` | show the tail of a job's output, or stop it |
| `/subagents` | list the delegations this session started, with their provider and age |
| `/subagents open <id\|last>` | read a child's own conversation in place; `ctrl+b` comes back |
| `/subagents kill <id>` | stop a live child agent |
| `/fork [title]` | branch this conversation after its last completed turn and continue in the branch |
| `/rename <title>` | title this session; the picker shows it instead of the session id |
| `/export [path]` | write the visible transcript as markdown (default `dsh-session-<id>.md`) |
| `/resume` | open another stored session without leaving the terminal |
| `/clear` | clear the visible transcript |
| `/quit` | leave and print the resume command |

Any other `/command` goes to the command registry, so `/plan`, `/compact`, `/goal`, and `/feedback` behave as they do on the other surfaces.

## How it works

The package is a Cordis plugin bundle that stacks over `@deepseek-ai/dsh-base`:

- `@sagmans/dsh-tui/startup` parses this app's own flags and publishes the launch identity.
- `@sagmans/dsh-tui/ask-user` mounts the official `ask_user_question` tool, which the base does not ship because agent presets normally provide it.
- `@sagmans/dsh-tui` owns the terminal: it creates or resumes one agent through `ctx.agents`, folds `session/event` into transcript rows and work state, renders them with `@earendil-works/pi-tui`, and releases the terminal on exit, on a boot failure, and on a signal.

The fold is durable-only: the live stream decorates the row that is still being written, and everything else — cards, reasoning, work state, compaction markers — comes from the log, so a resumed session renders what the live one did. Subagent start and finish are the exception: they arrive as service events, and the transcript shows them as decoration because the durable record of a delegation is the tool call that asked for it.

The rows are additive. No base row is replaced or disabled, so the bundle composes with any profile that is already running.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

**A linked profile loads the built entry point**, so edits under `src/` are invisible to `dsh --profile tui` until `pnpm run build` runs. Drive the real surface end to end — it rebuilds first, allocates a PTY, sends a prompt, and prints what the screen showed:

```sh
node tools/pty-drive.mjs --prompt 'Reply with exactly: pong'
node tools/pty-drive.mjs --prompt 'Run: echo hi' --approve 20   # answer the approval gate
node tools/pty-drive.mjs --home /tmp/scratch-home --seconds 20  # no credentials: proves failures are visible
```

Keep verification off your real home: install the profile into a throwaway one and copy only the credentials it needs.

```sh
S=$(mktemp -d)
cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml "$S/" && chmod 600 "$S"/*.yaml
DSH_HOME="$S" dsh plugin --profile tui add "$PWD"
node tools/pty-drive.mjs --home "$S" --prompt 'Reply with exactly: pong'
```

Test specs import plugin sources through the `@/` alias. Under this test runner the spec file is resolved with a root-relative id, so parent-relative imports (`../src/...`) do not resolve; the alias and its matching `tsconfig.test.json` path mapping avoid that.

## Manual acceptance

The automated checks drive a real PTY, but they run on this machine's terminal. These are the checks only a terminal on your desk can answer; each line is what to do and what it should look like.

| Check | Expected |
|---|---|
| `dsh plugin --profile tui add @sagmans/dsh-tui@latest` into a fresh `DSH_HOME` | the profile is created, and `dsh --profile tui` reaches a prompt |
| the same over SSH | the interface arrives intact; keys and mouse work on the host, with no local echo doubling |
| inside tmux or screen | wheel scroll and `ctrl+shift+f` search work; dragging selects text |
| a light terminal and a dark one | the interface follows the terminal's own palette; nothing becomes unreadable |
| `NO_COLOR=1 dsh --profile tui` | no styling anywhere, layout unchanged |
| `dsh --profile tui --no-bell` | a turn that runs for minutes still ends silently |
| resize the window mid-turn | the transcript rewraps; the dock, editor, and status row stay put |
| a 40-column terminal | rows end in `…` instead of wrapping into the next line |
| `echo hi \| dsh --profile tui` | refuses with a non-zero exit and a message naming the TTY requirement |
| `/quit`, Ctrl+C while idle, `kill -TERM <pid>` | the shell returns with cursor, echo, mouse, and title restored |

## Releasing

Published artefacts carry a provenance attestation, which only a CI provider can issue, so releases ship from the tag workflow rather than a laptop.

1. Bump `version` in `package.json` and commit it.
2. `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` re-runs typecheck, tests, and the package smoke, then publishes with `--provenance`.

The workflow needs an `NPM_TOKEN` repository secret with publish rights for the `@sagmans` scope. To publish by hand instead, run `pnpm publish --access public --provenance` from a clean checkout of the tag.

## Limitations

- `/mode` is not a command here: the base bundle's `/permission <preset>` switches the permission preset and the footer shows the current one.
- `/model` changes the route for the running session only. Catalog membership is advisory — an adapter may accept an id it does not advertise.
- Scrolling is the mouse wheel, or the terminal's own scrollback keys where it offers them.
- A turn that ran longer than ten seconds rings the terminal bell when it ends, because the reader may have walked away; `--no-bell` turns that off.
- The dock shows the goal, plan mode, the todo list, and any background job still running; the transcript marks where older history was compacted away. `/plan` toggles plan mode; `/plan <message>` also steers that message, which is the base command's own behaviour.
- Background jobs and subagent runs are live process state, not durable events: they disappear when the run ends, and a resumed session starts with an empty board and roster.
- Reading a child's conversation does not move the terminal: commands, approvals, and the status line stay with the session you launched, and the transcript is the only thing that switches.
- Fork and delete are unimplemented because session storage exposes neither.
- Approvals and questions render inline and take the keyboard; a question batch is answered in order.
- Styling uses the standard 16 ANSI colors and terminal defaults, so light and dark terminals follow their own theme.
- Tool text, model text, and file content are escaped before rendering, so a hostile result cannot inject terminal control sequences; the cost is that a literal tab shows as \x09.

## License

MIT
