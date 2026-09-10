# @sagmans/dsh-tui

Interactive terminal (TUI) surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): use `dsh` in a terminal instead of a browser.

Status: **early v1.** The surface boots over the composed agent plane, owns the alternate screen, streams assistant text as markdown, renders every tool's own card, answers approvals and questions, restores a stored conversation, and hands the terminal back on exit. Model and work-state panels are next.

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
| `/help` | list registered and local commands |
| `/resume` | open another stored session without leaving the terminal |
| `/clear` | clear the visible transcript |
| `/quit` | leave and print the resume command |

Any other `/command` goes to the command registry, so `/plan`, `/compact`, `/goal`, and `/feedback` behave as they do on the other surfaces.

## How it works

The package is a Cordis plugin bundle that stacks over `@deepseek-ai/dsh-base`:

- `@sagmans/dsh-tui/startup` parses this app's own flags and publishes the launch identity.
- `@sagmans/dsh-tui/ask-user` mounts the official `ask_user_question` tool, which the base does not ship because agent presets normally provide it.
- `@sagmans/dsh-tui` owns the terminal: it creates or resumes one agent through `ctx.agents`, folds `session/event` into transcript rows, renders them with `@earendil-works/pi-tui`, and releases the terminal on exit, on a boot failure, and on a signal.

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

## Limitations

- No model, permission-mode, or status panel yet; `/model` and `/mode` are not wired.
- Scrolling is the mouse wheel, or the terminal's own scrollback keys where it offers them.
- Approvals and questions render inline and take the keyboard; a question batch is answered in order.
- Styling uses the standard 16 ANSI colors and terminal defaults, so light and dark terminals follow their own theme.
- Tool text, model text, and file content are escaped before rendering, so a hostile result cannot inject terminal control sequences; the cost is that a literal tab shows as \x09.

## License

MIT
