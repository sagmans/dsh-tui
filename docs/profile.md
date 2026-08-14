# TUI profile

`@sagmans/dsh-tui` is a patch bundle layered after `@deepseek-ai/dsh-base`.
It targets published Harness `0.1.0-rc.6` packages.

## Install from this checkout

```sh
dsh plugin --profile tui add .
dsh plugin --profile tui install
NODE_OPTIONS=--experimental-ffi dsh --profile tui
```

Runtime requires Node.js 26.4.0 or newer. `--experimental-ffi` must be active.

## Composition boundary

Included host services match Web workflows requiring storage, workspaces,
session projections and statistics, feedback, export, directory selection,
plugin inventory, API proxying, Cordis host control, and Code Mode.

Excluded rows: Web server/runtime, browser transport, browser module loading,
client HMR, client runner, and React UI plugins. Private in-process client
runtime wiring lands separately.

Startup, kernel, shell, sessions/workspaces, and conversation use distinct
Loader rows. Later profile patches may disable or replace each row
independently.

## Sessions and workspaces

Open Sessions with `gs` or the mouse tab. Default actions:

- `j`/`k`, arrows, or `Ctrl+N`/`Ctrl+P`: move selection
- `Enter`: open a session or fold a workspace
- `n`, `/`, `r`, `f`, `x`: new, search, rename, fork, archive
- `c`, `h`: close current view, load older selected-session history
- `a`, `Delete`: register or remove a workspace
- `Shift+Up`/`Shift+Down`: reorder the selected workspace or session

Footer actions provide mouse equivalents. Session titles, search excerpts, and
runtime errors have terminal control sequences removed before rendering.
Workspace removal unregisters only the workspace; it does not delete its path or
sessions.

## Conversation and composer

The Chat route reads the shared Harness conversation registry. It renders
streaming text/reasoning, tool and command lifecycles, compaction, retries,
todos, request context, usage, queued prompts, and shared runtime errors.
History rendering is bounded; `Ctrl+U`/`Ctrl+D` move the window and `PageUp`
loads older events.

- `Enter`: newline
- `Meta+Enter`: queue prompt or execute a matched command
- `Ctrl+Enter`: steer the running turn
- `Ctrl+X`: stop the running turn
- `Tab`: complete leading slash commands and skills

`SEND`, `STEER`, `STOP`, and `OLDER` provide mouse equivalents. Failed sends
restore the submitted draft. Terminal-control bytes are removed while line
breaks remain intact.

MVP attachments are text-only. Browser-owned temporary image uploads are not
executed in this profile; a terminal-safe local-path attachment flow remains a
later parity slice.
