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

## Tools and inspector

Open Inspect with `gi` or the mouse tab. Tool calls use host-computed
presentation intents when structurally valid: generic, terminal, diff, read,
search, and web result shapes. Unknown or malformed intent payloads fall back
to sanitized arguments and results. Nested Code Mode dispatches appear as a
tree; `j`/`k` or arrows move selection and `Enter` or a second click folds a
branch. URLs and file paths remain inert text in this slice.

## Human interactions

Pending approvals and questions open a blocking overlay. Keyboard and mouse
actions are equivalent. Only `y` or `ALLOW ONCE` grants an approval; `n`,
`Esc`, or `REJECT` denies it. Questions support option selection, custom text,
skip, paging, and whole-batch submission. Strict binary `plan-review` requests
use approve, refuse, and discuss actions; malformed requests expose only a
cancel path. Responses stay visible and disabled until the host broadcasts
resolution.

## Operations

Open the operations overlay with `<leader>o`. `1`–`7` select Goal, Plan,
Workflows, Jobs, Subagents, Trace, and Feedback. `h`/`l` or arrows switch
sections; `j`/`k` or arrows move rows; `Enter` runs the row's primary action.
Mouse tabs, rows, and action labels provide equivalent navigation.

Goal mutations use projected compare-and-set revisions. Clear actions require a
second explicit activation. Plan mode exits through the existing `/plan off`
command. Workflow and subagent rows open only destinations authorized by the
shared runtime. Jobs remain read-only, matching current Harness behavior. Trace
shows the loaded event/request facts and can page older history. Feedback uses
Host-owned compare-and-set versions; conflicts reconcile from authoritative
Host values. Paths, payloads, and output remain sanitized inert text.
