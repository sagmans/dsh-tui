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

Included Host services match Web workflows requiring storage, workspaces,
session projections and statistics, feedback, directory selection, plugin
inventory, API proxying, Cordis host control, and Code Mode. Session archives
stream directly through the Host API rather than the browser export command.

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
- `/`: open grouped fuzzy command and prefix-matched skill candidates
- `@`: open running direct-child subagent references
- `Meta+/`: open the command, skill, and subagent launcher without typing a trigger
- `Up`/`Down`, `Enter`, `Esc`: traverse, select, or dismiss trigger candidates
- `Tab`: complete leading slash commands and skills
- `Meta+M`: open the current session's shared model/reasoning picker
- `/model`: open direct model selection and apply that model's default effort
- `Ctrl+O`: stage an image from an absolute local path
- `Ctrl+E`: export the current session to a new absolute `.zip` path
- `Ctrl+Delete`: clear staged images

`SEND`, `STEER`, `STOP`, `OLDER`, `MODEL`, `ATTACH`, `EXPORT`, `CLEAR`, and
`+` provide mouse equivalents. Trigger candidates and the dismissal row are
also clickable. Model and reasoning choices share one Host-backed
session directory across the composer and `/model`. A definitely unroutable
Host selection blocks submission and exposes the Providers handoff; unknown or
unadvertised catalog state does not block. Failed sends restore the submitted
draft and staged images.
PNG, JPEG, WebP, and GIF inputs are bounded before base64 enters the shared
prompt contract. Render state contains metadata only. Exports never overwrite
an existing file, use mode `0600`, and remove failed partials.
Terminal-control and bidi-formatting bytes are removed while safe Unicode and
line breaks remain intact.

## Tools and inspector

Open Inspect with `gi` or the mouse tab. Tool calls use host-computed
presentation intents when structurally valid: generic, terminal, diff, read,
search, and web result shapes. Unknown or malformed intent payloads fall back
to sanitized arguments and results. Nested Code Mode dispatches appear as a
tree; `j`/`k` or arrows move selection and `Enter` or a second click folds a
branch. URLs remain inert text. Successful Host-projected edit paths appear as
produced files; `o` or the mouse action must select the same path twice before
requesting an external open.

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

## Configuration and plugins

Open Settings with `g,` or the mouse tab. `1`–`8` select Models, Providers,
Access, Presets, Settings, Credentials, Plugins, and Extensions. `h`/`l`,
arrows, or `Tab` switch sections; `j`/`k`, arrows, or `Ctrl+N`/`Ctrl+P` move
rows. `[`/`]` choose an exact row action, `Enter` runs it, and `r` refreshes.
Mouse tabs, rows, and action labels are equivalent.

Model and preset changes reuse Host APIs. Full-access selection requires a
second exact activation. Settings display redacted values and secret configured
state only; namespace reset uses the displayed revision and requires
confirmation. Credential values use a masked write-only editor, leave no
render-buffer copy, and are cleared before the Host call. Unset also requires
confirmation.

Configured Loader plugins are read-only inventory. Dynamic Cordis packages are
limited to the current session. Host-only packages may run; stop and remove
require confirmation. Packages with browser client halves are shown as
unsupported and cannot run, so this profile never fetches or executes browser
plugin code.

See [`parity.md`](parity.md) for every renderer-specific implementation,
terminal alternative, and Web-only exclusion.
