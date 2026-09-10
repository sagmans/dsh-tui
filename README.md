# @sagmans/dsh-tui

Interactive terminal (TUI) surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): use `dsh` in a terminal instead of a browser.

Status: **M0 walking skeleton.** The surface boots over the composed agent plane, owns the alternate screen, streams assistant text, and exits cleanly. Approvals, questions, plan review, session resume, and the full card set are the next milestones.

## Install

```sh
dsh plugin --profile tui add @sagmans/dsh-tui@latest
dsh --profile tui
```

The first command creates a base-backed `tui` profile and adds this bundle to it. Requires Node.js >= 22.19, a real terminal (stdin and stdout must be TTYs), and `pnpm` on `PATH` for the install step.

## Usage

```sh
dsh --profile tui                      # new session in the current directory
dsh --profile tui --resume             # resume picker
dsh --profile tui --resume <session-id>
dsh --profile tui --model deepseek-chat
dsh --profile tui --no-color
```

| Key | Action |
|---|---|
| Enter | submit the prompt |
| Ctrl+C | interrupt the running turn, or leave when idle |
| `y` / `n` / Esc | allow once, reject, or cancel a pending approval |
| digits / space / ↑↓ / Enter / Esc | answer a question: pick or toggle, confirm, or skip one |
| `/help` | list registered and local commands |
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

Test specs import plugin sources through the `@/` alias. Under this test runner the spec file is resolved with a root-relative id, so parent-relative imports (`../src/...`) do not resolve; the alias and its matching `tsconfig.test.json` path mapping avoid that.

## Limitations

- No session resume picker, plan-review panel, subagents, jobs, model switching, or transcript scrolling controls yet.
- Approvals and questions render inline and take the keyboard; a question batch is answered in order.
- Transcript rendering is plain text: markdown, diffs, and tool cards arrive with the presentation milestone.
- Rendering styling uses the standard 16 ANSI colors and terminal defaults, so light and dark themes follow the terminal.

## License

MIT
