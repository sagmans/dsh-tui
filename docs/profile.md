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

Startup, kernel, and shell use distinct Loader rows. Later profile patches may
disable or replace each row independently.
