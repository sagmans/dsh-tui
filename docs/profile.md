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

Startup, kernel, shell, and sessions/workspaces use distinct Loader rows. Later
profile patches may disable or replace each row independently.

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
