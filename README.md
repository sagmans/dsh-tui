# @sagmans/dsh-tui

Interactive terminal (TUI) surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): use `dsh` in a terminal instead of a browser.

Status: **v1 feature-complete; published on npm as `@sagmans/dsh-tui`.** The surface owns the alternate screen, streams assistant text as markdown, renders every tool's own card, answers approvals and questions, restores and names stored conversations, switches model mid-session, runs any of the four shipped agent modes and switches between them before a session's first turn, reads a child agent's conversation in place, keeps the goal, plan mode, todo list, delegations, and background jobs above the editor with a status line below it, nudges an agent whose plan has aged without an update, and hands the terminal back on every graceful exit. Publication is tag-driven with GitHub OIDC provenance and no stored npm token; see [RELEASE.md](RELEASE.md).

## Install

A profile keeps this plugin as one bundle layer. Install it from a checkout of this repository, or from the registry (`0.1.0` or later). Both paths need Node.js >= 22.19 and `pnpm` on `PATH`. Both need a real terminal: stdin and stdout must be TTYs.

### From a plugin checkout

A linked profile loads the package's built entry point. Build the checkout before you add it:

```sh
cd "$PLUGIN_CHECKOUT"
CI=true pnpm install && pnpm run build
dsh plugin --profile tui add "$PWD"
dsh --profile tui
```

The `add` command creates the `tui` profile on first use and records a link to the directory. Keep the checkout in place. If you move or delete it, the link breaks, and a later `plugin install` removes the bundle from the layer list (see Troubleshooting).

### From the registry

```sh
dsh plugin --profile tui add @sagmans/dsh-tui@latest
dsh --profile tui
```

Releases are published, so this path works today. A checkout stays the path for unreleased work.

### Confirm the plugin mounted

The profile records its layers in `$DSH_HOME/profiles/tui/package.json` (`~/.dsh` by default). `@sagmans/dsh-tui` must appear in `dsh.profile.bundles`:

```sh
node -p "require((process.env.DSH_HOME ?? require('node:os').homedir() + '/.dsh') + '/profiles/tui/package.json').dsh.profile.bundles.join('\n')"
# @deepseek-ai/dsh-base
# @sagmans/dsh-tui
```

Then check that the surface is mounted. A pipe is not a terminal, so this command must refuse before it takes the screen over:

```sh
echo hi | dsh --profile tui
# dsh-tui: both stdin and stdout must be TTYs; run this profile from a terminal or SSH session
```

### Update

Rebuild a linked checkout, then start the next session. The link itself does not change:

```sh
cd "$PLUGIN_CHECKOUT" && git pull && CI=true pnpm install && pnpm run build
```

A registry install updates with `dsh plugin --profile tui update @sagmans/dsh-tui`.

### Remove

```sh
dsh plugin --profile tui remove @sagmans/dsh-tui
```

The profile then keeps `@deepseek-ai/dsh-base` and no application, so `dsh --profile tui` waits with no output. Add the plugin again to use the profile.

### Launching from a harness checkout

`pnpm dsh --profile tui` is the sanctioned launcher, but pnpm verifies that dependencies are current before it runs any script, and a checkout whose `postinstall` refuses to take over a user-owned `core.hooksPath` fails that check — the process exits before the surface starts. Any of these reaches the surface:

```sh
pnpm --config.verify-deps-before-run=false dsh --profile tui   # from the checkout
CI=true pnpm dsh --profile tui                                 # also suppresses the check
node "$CHECKOUT/apps/cli/lib/bin.js" --profile tui             # needs neither pnpm nor the check
```

## Troubleshooting

Two facts explain most failures.

**A linked profile is a link, not a copy.** The profile points at a directory, so a checkout that moves or disappears breaks it.

**`dsh plugin install` removes a bundle it cannot resolve, and says nothing.** The command reconciles `dsh.profile.bundles` against the installed dependencies. A bundle whose path does not resolve leaves the list, and the command still exits 0. The next launch composes `@deepseek-ai/dsh-base` alone. No application plugin mounts, so nothing reads the command line: `dsh --profile tui` then prints nothing and never exits, and `--help` waits with it.

| Symptom | Cause | Fix |
|---|---|---|
| `dsh: cannot resolve profile bundle "@sagmans/dsh-tui" ...` | the linked checkout moved or was deleted | `dsh plugin --profile tui add "$PLUGIN_CHECKOUT"` |
| `dsh --profile tui` prints nothing and never exits | the bundle left `dsh.profile.bundles`, usually after a broken link and a `plugin install` | confirm the layer list, then run the `add` command again |
| `dsh-tui: both stdin and stdout must be TTYs` | stdin or stdout is a pipe, a file, or a CI runner | run the command from a terminal |
| Node warnings, such as `ExperimentalWarning: stripTypeScriptTypes …`, appear after exit | the TUI holds runtime warnings until it returns the terminal to your shell; startup warnings remain visible before the TUI starts | read the warnings in your shell after exit; no warning-suppression flag is needed |
| Changes under `src/` have no effect | a linked profile loads `lib/`, not `src/` | `pnpm run build` in the plugin checkout |
| `pnpm dsh --profile tui` exits before the surface appears | pnpm's dependency check fails on the harness checkout's own postinstall | see [Launching from a harness checkout](#launching-from-a-harness-checkout) |
| `--preset <id>` is refused, because the session's agent preset is fixed | a session keeps the mode that composed it, and this session already took a turn | `/preset <id>` before the first turn, or resume without `--preset` |
| `--resume <id>` starts a new session | the id is a bare UUID | pass the stored id, `tui-session-…` included; a bare `--resume` opens the picker |
| `dsh: profile "tui" does not exist` | the profile is not created yet | the `add` command creates it |

The full recovery from a broken link:

```sh
cd "$PLUGIN_CHECKOUT" && CI=true pnpm install && pnpm run build
dsh plugin --profile tui add "$PWD"
node -p "require((process.env.DSH_HOME ?? require('node:os').homedir() + '/.dsh') + '/profiles/tui/package.json').dsh.profile.bundles.join('\n')"
# @deepseek-ai/dsh-base
# @sagmans/dsh-tui
```

## Usage

```sh
dsh --profile tui                      # new session in the current directory
dsh --profile tui --resume             # pick a stored session, titled by its first prompt
dsh --profile tui --resume <session-id>
dsh --profile tui --preset minimal          # start in a shipped mode other than the default (PTC)
dsh --profile tui --model deepseek-chat
dsh --profile tui --no-color
dsh --profile tui --no-bell            # do not ring when a long turn finishes
```

Every key below is a shipped default. `/keys` lists every action the surface
and its library can perform with the keys in force, and the `keys:` section
moves any of them — see [Keys](#keys).

| Key | Action |
|---|---|
| Enter / Shift+Enter | break the line: a prompt is written before it is sent |
| Ctrl+Enter / Alt+Enter / Ctrl+S | submit the prompt |
| Ctrl+C | interrupt the running turn, or leave when idle |
| Ctrl+O | open every tool card: its header plus every retained row. Folded, a card is one line, and a shell card keeps its command plus the last 20 rows of output with a hint naming what it dropped |
| Ctrl+Y | show or hide the calls a PTC program dispatched: one two-space-indented entry per call under its `run_code` card, named and argued from the tool's own header and wrapped at the screen edge; shown by default |
| Shift+Tab | expand or fold the reasoning behind an answer: folded, the row names itself, its token count, and the key; opened, it adds the thought |
| Ctrl+T | pick the reasoning effort for the next step |
| Ctrl+R | reverse-search recorded prompts: the list opens filtered by whatever is in the bar, `enter` puts one back, `esc` keeps the draft |
| Ctrl+X then M | open the model picker |
| Ctrl+X then Y | copy the last answer to the clipboard |
| `y` / `n` / Esc | allow once, reject, or cancel a pending approval |
| digits / space / ↑↓ / Enter / Esc | answer a question: pick or toggle, confirm, or skip one; `0` answers with your own text in the input bar |
| typing in any picker or question | narrow the rows by fragment (`glm53` finds `GLM-5.3`); backspace widens, `esc` or Ctrl+C leaves |
| `/` then Tab | complete commands, including every command this session registered |
| `@` or a path then Tab | complete workspace file references |
| `ctrl+shift+f` | search the transcript (`enter` next, `shift+enter` previous, `esc` close) |
| `home` / `end` | jump to the start or the end of the transcript |
| `ctrl+down` | jump to the next prompt |
| `ctrl+b` | leave a child's conversation and return to this session (the status line names the key you have now) |
| mouse wheel, drag | scroll, and copy a selection through OSC 52 |
| `/help` | list registered and local commands |
| `/status` | show the session id, model, permissions, context, and directory |
| `/model` | open the picker for the configured providers and their models; it heads itself with the route the next step will use, and typing filters it by fragment (`glm53` finds `GLM-5.3`) |
| `/model <provider>` | list that provider's advertised models |
| `/model <provider>/<model>` | use that route from the next step on (session only, nothing is written to settings) |
| `/model <provider>/<model>/<effort>` | use that route and reasoning effort (the effort must be one the route advertises) |
| `/preset` | pick the agent mode for this session from the roster |
| `/preset <id>` | switch to that mode, while the session is still blank |
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
| `/history` | show how many prompts are recorded and where the file is |
| `/history clear` | forget every recorded prompt, reporting how many went |
| `/theme` | list every styled element and the value in force |
| `/keys` | list every action and the keys in force; `/keys <layer>` narrows it (see [Keys](#keys)) |
| `/quit` | leave and print the resume command |

`Ctrl+X` starts a chord. For the next two seconds the footer leads with the
prefix alone — enough to say that a key is waiting, without reciting the map —
and a key that finishes nothing is typed as usual rather than swallowed, so a
prefix pressed by accident costs nothing; `/help` lists the chords, `m` for the
model picker, `p` for plan mode, and `y` for the last answer.
`keys.chord.prefix: alt+x` starts the chord with another key — or with a list of
them, as so many ways in — and `prefixWindow: 0` waits for the next key instead
of lapsing; every second key is a row of its own (`chord.model`, `chord.plan`,
`chord.copy`), so a chord can be respelled whole. A prefix that is not a modifier chord, that
the surface or the prompt bar already answers (`ctrl+c`, `ctrl+s`), or that the
terminal keeps (`ctrl+q`) is refused with the reason, and the shipped keymap
stays in force. The chords themselves are the commands they stand for: `m`, `p`,
and `y` ask the same dispatcher `/model`, `/plan`, and `/copy` do. Plan mode is
the one pair that cannot share a name: `/plan` only enters, so the chord names
`/plan off` instead when the agent is in plan mode — or is waiting for the turn
boundary to become so — and reads that state from the plan package rather than
from the dock.

An approval or a question draws inline above the editor and takes the keyboard. A question that lists options always adds row `0. other — type your own answer`: type or paste an answer the model did not offer, and the seam receives it as that question's free text — replacing a single-select choice, or supplementing a multi-select one. `0`, or `↓` past the last option, reaches the row; `↑` walks back to the list with the text kept, and `esc` does the same from that row, because a question skipped by accident is a question answered twice — an escape from the list skips it. Free text is written in the prompt bar's own editor, drawn under that row: movement, word and line deletion, undo, completion, and multi-line paste are all the editor the reader already uses, and the prompt bar steps aside while a question is open, so a prompt written but not sent comes back untouched once the question is answered. No question hides its answer — the reader is the one who has to check what they are about to send. Every gate row wraps at the screen edge under its own label, so a long option or question is readable rather than cut.

While a turn runs, a prompt submitted into the editor waits in the agent's own inbox instead of disappearing: it is drawn above the editor in the input bar's own frame, faint and italic, and moves into the transcript when the agent takes it — where it keeps that frame in the prompt's own mint shade, so what the reader typed is never mistaken for what the agent said. `editor.queued` and `editor.queued.more` restyle or hide the waiting rows; `transcript.user` restyles the submitted prompt.

Every submitted line is also kept in a global prompt history at
`$DSH_HOME/prompt-history.json`. Typing the start of a prompt that was sent
before draws the rest of the newest match after the cursor in a faint shade.
`Ctrl+E` takes the whole suggestion and the word-movement key takes the next
word, and both keys fall back to their old meaning the moment nothing is
offered. The history is deliberately global — the same prompt is useful in
every checkout — so nothing records a directory. An exact repeat moves to the
front instead of being stored twice. `history.ghost: false` keeps reverse
search but stops drawing the suggestion, `history.enabled: false` stops
recording and offering, and `history.maxEntries` bounds the file. A file this
build cannot parse is left untouched and writes are refused, so a newer format
is never overwritten; `/history` names it and the count, and `/history clear`
forgets everything.

Any other `/command` goes to the command registry, so `/plan`, `/compact`, `/goal`, and `/feedback` behave as they do on the other surfaces.

## Settings

Every styled element is a named token with a shipped default, and every key is
an action with one, so the surface can be restyled and rebound without touching
code. Preferences live in the same user-settings document as every other
(`$DSH_HOME/settings.yaml`), under a `dsh-tui:` section:

```yaml
dsh-tui:
  subcalls: collapsed         # fold the calls a PTC program dispatched (default inline)
  mermaid: streaming          # draw a reply's mermaid fences: off, final, or streaming (default streaming)
  prefixWindow: 2             # seconds a chord waits for its second key; 0 waits for the next key instead
  keys:
    chord.prefix: ctrl+x      # the key that starts a chord; "prefix:" is the older spelling of this row
    prompt.submit: [ctrl+enter, alt+enter, ctrl+s]
    surface.effort: ctrl+t    # one key, or a list of them
    tui.editor.yank: ctrl+y   # any action the library draws, by the id /keys prints
  history:
    enabled: true             # record prompts and offer them back (default true)
    ghost: true               # draw the dimmed completion; reverse search stays either way (default true)
    maxEntries: 2000          # prompts kept, newest first (1-20000, default 2000)
  palette:
    muted: '#5c5c5c'          # one shade quiets every receding element
  tokens:
    transcript.reasoning.body:
      fg: '#7a7a7a'
      italic: true
    tool.title:
      fg: accent              # a palette name, a hex value, or an index 0-255
      bold: true
    dock.jobs.heading:
      hidden: true            # the element renders nothing at all
```

Every field is optional, so a section that changes one shade is enough. The
document is hot-reloaded: an edit restyles a running session and re-arms the
keymap on the next press, and `/theme` shows each element's effective value and
whether it came from an override, the palette, or the default.


The section is not only shades. By default every session draws the calls a PTC
program dispatched under their card, and `subcalls: collapsed` starts with the
card alone instead. `Ctrl+Y` toggles the same choice for the current session,
and an edit to the document re-seeds it. An unknown key or value is
refused with a notice naming it, so a typo cannot quietly do nothing.

The `history` block tunes the prompt history. `enabled: false` stops recording
and offering it; `ghost: false` keeps reverse search but stops the dimmed
completion; `maxEntries` bounds the file, and an exact repeat moves to the
front rather than being stored twice. `editor.ghost` styles the suggestion, and
`NO_COLOR` or `--no-color` suppresses it entirely, because a suggestion the
reader cannot see but could still accept is worse than none.

A reply whose fenced block names `mermaid` is drawn as terminal box art instead
of source, laid out at the width the transcript has. `mermaid: streaming` (the
default) draws a diagram while the reply is still arriving, `final` waits for
the turn to end, and `off` leaves every fence exactly as written. A diagram
wider than the terminal, one the renderer cannot draw at all, or one whose source
is larger than a frame can lay out stays as the source fence rather than being
truncated; a settled diagram whose source was only partly readable keeps the
fence and names what was dropped. The drawing is
restyleable like anything else through `markdown.diagram.border`,
`.text`, `.edge`, `.edgeLabel`, `.title`, and `.warning`, so `/theme`
lists it with the rest. Nothing is lost by drawing: `/export` and the session
file keep the reply exactly as the model wrote it.

`fg` and `bg` accept `#rrggbb`, a palette name (`default`, `muted`, `accent`,
`arg`, `warn`, `added`, `removed`, `user`, `assistant`), or an index. A colour is
emitted as 24-bit when the terminal advertises it (`COLORTERM`) and degraded to
the nearest 256-colour entry or 16-colour slot otherwise; a hue keeps its family
there, so an addition stays green instead of collapsing to black. Muted elements
name the palette rather than a terminal slot, so on anything but a 16-colour
terminal their contrast does not depend on what the reader's colour scheme maps
slot 8 to. `arg` is the pale blue a card gives the argument it was called with,
so `tool.args` is restyled on its own and stays distinct from the tool's own
label and from its output. `user` is the mint a submitted prompt takes, so a
reader's own turns stand apart from the reply without reading either.

`NO_COLOR` and `--no-color` disable styling entirely, attributes included, and
outrank everything in this section. A token or palette name the surface does not
have is refused with the offending name, and the surface prints the refusal as a
notice when the document loads, so a typo cannot quietly paint nothing.

### Keys

Every press the surface answers is an action with an id and a shipped key.
`/keys` prints all of them with the keys in force, marks the rows you wrote,
names the keys your map took from the library, and ends with a sample `keys:`
section rather than a whole one; the table above it is the complete account.
`/keys prompt`, `surface`, `chord`, `gate`, `question`,
`picker`, and `library` narrow that list to one part of the surface.

An entry is one key or a list of them. A key is a modifier chord
(`ctrl`/`alt`/`shift` joined by `+`, written in that order), a named key
(`enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `home`, `end`,
`pageUp`, `pageDown`, the arrows, `f1`–`f12`), or a bare character where the
layer reads one: `y` and `n` for an approval, or a chord's second key. Ids
beginning `tui.` are pi-tui's own actions, so the editor, the search, and the
transcript move where you tell them to.

Refused, with the reason in a notice and the shipped map left in force: an
action the surface does not have, a key no terminal reports, `ctrl+q` (the
terminal keeps it), a bare character outside the chord and gate layers, two
actions of one layer on one press, a key the library already answers on a row you
never wrote, a key the viewport reads before the surface sees it, whichever of the
two the map moved onto it (`pageUp`, or `tui.altScreen.search` moved onto a
surface key), a `chord.prefix` that is not a modifier chord or that takes a key
the surface or the prompt bar answers, and `prefix:` beside
`keys.chord.prefix:`, which are the same row under two names.

Two rows count as one press when some sequence reaches both, not merely when they
are spelled alike, because one press can arrive as several bytes and one byte can
spell several keys. A bare terminal reports Return for `enter` and `ctrl+m`, a
line feed for `ctrl+j` and, without the keyboard protocol, Return as well, one
control byte carries both `ctrl+-` and `ctrl+_`, and an escape with a letter
reaches `alt+up` as readily as `alt+p`.

A key the surface or a chord answers is a key the library never sees: that is
how `ctrl+y` shows nested calls instead of yanking a line in the editor.
`/keys` names every shadow your map introduces, and moving the surface key
hands the library its own key back.

Left alone, because they are typing rather than commands: the keys a question's
filter narrows with and the ones that leave its free-text row, the digits and
row `0` that name an option, and the mouse.

One residual escapes that promise, and it is not the surface's to close. After a
component returns its rows, the framework appends a reset to each row and closes
the hyperlink it wraps them in, so a session can still receive a bare `ESC[0m`
with colour off. It paints nothing. It is recorded here because "no escapes at
all" is otherwise the claim, and because the surface cannot make good on it
alone.

## Modes

A mode is an **agent preset**: the plugin composition an agent's own scope joins. It decides that agent's tools, prompt sections, skills, and planning rows, which is why a mode is fixed once a session has produced a turn — it is what composed the agent that answered.

Four ship, under the ids a session log records:

| `--preset` | Mode | What the agent gets |
|---|---|---|
| `ptc` | PTC (default) | the same agent, reaching its tools through one TypeScript program |
| `standard` | standard | full agent: editing, shell, search, skills, planning, goals, subagents, workflows |
| `minimal` | minimal | one tool: a persistent shell |
| `cordis` | creator | harness authoring: runtime inspection and composition guidance |

A session takes its mode from the first of these that applies:

1. `--preset <id>`, refused before the terminal is taken over when the roster does not ship that id.
2. `/preset` while the session is still blank: a bare command opens the picker, `/preset <id>` switches directly, and the choice is written to the log.
3. The roster's default, `ptc`, when nobody names one.

The mode is re-read rather than remembered: resuming mounts what that session's own log recorded, resuming with a `--preset` that disagrees with it is refused instead of silently ignored, and forking inherits the mode of the conversation being branched. The status line names the mode, and `/status` lists it with the rest.

## How it works

The package is a Cordis plugin bundle that stacks over `@deepseek-ai/dsh-base`:

- `@sagmans/dsh-tui/startup` parses this app's own flags and publishes the launch identity.
- `@deepseek-ai/dsh-agent-presets` is the roster of modes, holding the id a session starts in when nobody names one.
- `@deepseek-ai/dsh-code-runtime-worker-thread` and `@deepseek-ai/dsh-cordis-host-runner` are the host machinery PTC mode and creator mode need; only the Web bundle shipped them, so a terminal profile has to mount them to offer those modes at all.
- `@sagmans/dsh-tui` owns the terminal: it creates or resumes one agent through `ctx.agents`, folds `session/event` into transcript rows and work state, renders them with `@earendil-works/pi-tui`, and releases the terminal on exit, on a boot failure, and on a signal.
- `@sagmans/dsh-tui/todo-guard` is the one advisory row this bundle adds to the agent plane: it watches the harness's own `todos` and `plan` projections and rides the next tool result with a reminder when a plan ages. See [Todo discipline](#todo-discipline).

A question whose id ends in `:secret` declares its typed answer a credential: the bar hides everything but its first and last four characters, and the free-text row a question with options offers is labelled `API KEY`. Wording is not a declaration, because hiding every question that mentions a key would hide answers their authors meant to be read.

The fold is durable-only: the live stream decorates the row that is still being written, and everything else — cards, reasoning, work state, compaction markers — comes from the log, so a resumed session renders what the live one did. Subagent start and finish are the exception: they arrive as service events, and the transcript shows them as decoration because the durable record of a delegation is the tool call that asked for it.

Tool cards are folded by default: a card draws its header and nothing else, so a long read, diff, or search cannot bury the conversation. A shell card is the exception, because its output is the answer the reader asked for: it names the tool in its header, always shows the command that ran, keeps the last 20 output rows, and adds a hint naming the rows it dropped. `Ctrl+O` opens every card to its header plus every retained row.

A PTC card is the one card with children: every call the `run_code` program dispatched hangs off the card that made it, and each draws under the header as the tool's own name and argument, wrapping rather than being cut. `Ctrl+Y` folds them away again, and `subcalls: collapsed` starts every session folded; see [Settings](#settings).

A card's header names the tool, then the argument the call was made with — a path or a command — in the `tool.args` colour, then the facts the result measured: a read reports its line range, line count, and token size; a file change that carried no prior content to compare against reports its lines and tokens; one that did reports added, changed, and removed lines as `+n ~n -n` in green, yellow, and red. Each stat is its own token, so any of them can be recoloured or hidden independently.

The bundle also takes the base's global agent rows out of the composition, twenty-three of them. Every one is a row the shipped modes supply per session instead, so leaving it mounted registers the same tool names in two layers and doubles each prompt section it owns. What stays mounted is the host: sessions, storage, models, permissions, jobs, and the command registry.

### Todo discipline

The todo tool and its list belong to the agent; this bundle owns the surface and one advisory guard. `@sagmans/dsh-tui/todo-guard` mounts host-plane, reads the harness's own `todos` and `plan` projections, and — when a non-empty list has gone a threshold of model steps without a `todo_write`, or a long turn has produced no list at all — rides the next tool result with a model-visible reminder. It never vetoes a call, never steers a stopped turn, and never adds a prompt section, so its request prefix stays stable across deployments. A reminder costs the loop one extra model step to consume; the per-turn cap bounds that. It stays silent in plan mode, in a mode whose catalog has no `todo_write`, and when the projections are absent.

| Option | Default | Effect |
|---|---|---|
| `staleSteps` | `6` | model steps a non-empty open list may age before the guard speaks |
| `missingListSteps` | `12` | steps in a turn before the guard suggests a first list |
| `maxRemindersPerTurn` | `3` | hard cap on reminders, and on the extra steps they cost, per turn |
| `previewItems` | `5` | open items quoted in a reminder; the rest become a count |

Override them from the home-level patch, which outranks the profile's own layers. An id-targeted patch replaces the whole config, so restate every field you keep:

```yaml
# $DSH_HOME/cordis.patch.yml
- id: tui-todo-guard
  config:
    staleSteps: 4
    missingListSteps: 12
    maxRemindersPerTurn: 3
    previewItems: 5
```

The list the dock and `/todo` draw follows the same lifetime every other surface shows: it is cleared when the next turn opens, because a fresh task must not inherit the previous turn's checklist.

## Herdr

[Herdr](https://github.com/herdrdev/herdr) is a terminal multiplexer for coding agents. When it starts this surface in one of its panes it exports `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`, and the pane reports what it is doing over that socket — as the agent `dsh`, under the source `custom:dsh-tui`. Away from Herdr (an ordinary terminal, SSH, tmux) the reporter is inert: no socket is opened, and nothing reaches the screen the reader owns.

| This surface | Herdr |
|---|---|
| the screen is taken, before any session opens | `idle`, claiming the pane's agent row |
| `turn/start` | `working` |
| an approval, a question, or a picker takes the keyboard | `blocked`, named by that card's title |
| the decision settles | `working` if a turn is open, otherwise `idle` |
| `turn/end` | `idle` |
| a session opens, resumes, forks, or is switched to | its id and reason, plus the `dsh_session` / `dsh_cwd` pane tokens |
| exit, signal, or boot failure | `herdr pane release-agent`, so no row is left waiting on a process that is gone |

A wait outranks a running turn: a turn waiting on a human is not making progress, and the wait is the only thing worth acting on from a wall of panes. Reports are sequenced per source, so a delivery that arrives late cannot undo the state the surface already moved past, and a state Herdr is already showing is not sent again.

Herdr persists a session reference only for its own built-in integrations, so this pane's session identity travels as metadata tokens instead: a script or a companion plugin reads them back with `herdr pane get <id>` and resumes that exact conversation with `dsh --profile tui --resume=<id>`. What Herdr cannot do is identify the process itself — its detection table and its screen rules both name built-in agents only — so a pane that has not reported yet reads as an ordinary pane.

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
| `DSH_HOME=$(mktemp -d) dsh plugin --profile tui add "$PWD"` from a built checkout | the profile is created, `dsh.profile.bundles` lists the plugin, and `dsh --profile tui` reaches a prompt |
| the same over SSH | the interface arrives intact; keys and mouse work on the host, with no local echo doubling |
| inside tmux or screen | wheel scroll and `ctrl+shift+f` search work; dragging selects text |
| a light terminal and a dark one | the interface follows the terminal's own palette; nothing becomes unreadable |
| `NO_COLOR=1 dsh --profile tui` | no styling anywhere, layout unchanged |
| `dsh --profile tui --no-bell` | a turn that runs for minutes still ends silently |
| `dsh --profile tui --preset ptc`, then a turn | the status line names `ptc`, and the agent reaches its tools through one TypeScript program rather than one shell call at a time |
| a PTC turn | one entry per dispatched call draws two spaces indented under the `run_code` header, from the first frame and with no keypress |
| that turn in a terminal narrower than a call's own argument | the argument wraps onto continuation rows indented to the same two spaces, with no ellipsis |
| that same turn, then `ctrl+y` | the lines fold away; `ctrl+y` again draws them back |
| `dsh-tui: { subcalls: collapsed }` in `$DSH_HOME/settings.yaml`, then a PTC turn | the card arrives alone, and editing the document to `inline` unfolds a running session |
| a reply carrying a mermaid fence | it draws as box art at the transcript width, with the prose around it untouched |
| that reply in a terminal narrower than the drawing | the fence stays source, and widening the window draws it without a new turn |
| `dsh-tui: { mermaid: off }` in `$DSH_HOME/settings.yaml`, then a mermaid reply | the fence stays source; editing the value to `streaming` draws a settled reply without a restart |
| type the start of a prompt already recorded | the rest of the newest match follows the cursor in a faint shade; `ctrl+e` takes it whole, the word-right key takes one word, and both keys do their old job when nothing is offered |
| `ctrl+r`, then a fragment | reverse search opens seeded with the bar's draft; `enter` puts a prompt back, `esc` keeps the draft |
| `dsh-tui: { history: { ghost: false } }`, then type a known prefix | no suggestion is drawn, and `ctrl+r` still searches |
| `/history clear`, then `/history` | the notice reports the count forgotten, and the second reports `1 prompt recorded` — the check line is itself recorded |
| `/model` on a configured profile | the picker lists only the configured providers' advertised models, heads itself with the route in force, and typing filters it while later rows stream in; `esc` or Ctrl+C leaves without changing the route, and `enter` chains into the route's reasoning efforts |
| `/preset` on a fresh session | the picker lists four modes, marks the current one, and the switch survives a resume |
| `/preset minimal` after a turn | refused, naming the reason; the session keeps the mode it composed with |
| `--resume --preset <mode>` and then picking a session that runs another mode | the list stays open and says why that row cannot be taken; `esc` leaves the picker |
| `dsh --profile tui --preset nope` | exits non-zero naming the modes that do exist, before the alternate screen appears |
| arrow keys in a picker, or on a question's options, in a terminal that reports key events (Kitty, WezTerm, Ghostty, iTerm2) | one press moves one row, and holding a key still repeats; a terminal that sends only the legacy sequence behaves the same |
| resize the window mid-turn | the transcript rewraps; the dock, editor, and status row stay put |
| a 40-column terminal | transcript and card rows end in `…` instead of wrapping into the next line |
| a question with a long option at 40 columns | the option wraps onto rows indented under its label, and `0. other — type your own answer` sits under the list |
| press `0` on a question, type an answer, press Enter | the editor under row `0` shows the text as it is edited, and the model receives it as that question's answer |
| type a prompt without sending it, then answer a question | the prompt bar steps aside while the question is open and holds the same prompt again afterwards |
| `echo hi \| dsh --profile tui` | refuses with a non-zero exit and a message naming the TTY requirement |
| `/quit`, Ctrl+C while idle, `kill -TERM <pid>` | the shell returns with cursor, echo, mouse, and title restored |

## Releasing

Published artefacts carry a provenance attestation, which only a CI provider can issue, so releases ship from the tag workflow rather than a laptop.

1. Bump `version` in `package.json` and move `CHANGELOG.md`'s `Unreleased` section to that version, land both on `main` through a reviewed PR, and wait for CI to pass on the merged SHA.
2. Tag that SHA with a signed tag and push it. The tag ruleset admits repository admins only.
3. `.github/workflows/release.yml` re-runs typecheck, tests, and the package smoke; the publish job then waits for a maintainer's approval on the `npm-release` environment before it publishes with OIDC trusted publishing and automatic provenance.

The workflow stores no npm token: the registry trusts `release.yml` on the `npm-release` environment, and [`scripts/npm/release.py`](scripts/npm/release.py) creates both the environment and that trust. The full runbook is [RELEASE.md](RELEASE.md); the user-visible history is [CHANGELOG.md](CHANGELOG.md).

## Limitations

- Two different things are called a preset. The agent mode (`--preset`, `/preset`) is fixed once a session has produced a turn; the permission preset (`/permission <preset>`, named in the status line) can change at any time.
- `/model` changes the route and reasoning effort for the running session only. Catalog membership is advisory — an adapter may accept an id it does not advertise, while an explicit effort is checked against the route's own levels before it is applied. The picker offers the routes this deployment configured, not the ones it can prove credentialed: a provider whose key or sign-in is still missing appears like any other, and its first request names the missing credential.
- Scrolling is the mouse wheel, or the terminal's own scrollback keys where it offers them.
- A turn that ran longer than ten seconds rings the terminal bell when it ends, because the reader may have walked away; `--no-bell` turns that off.
- The dock shows the goal, plan mode, the todo items still to do, and any background job or delegation still running; a settled item leaves rather than turns into a completed row, and the list clears when the next turn opens so a fresh task never inherits the previous one's checklist. The transcript marks where older history was compacted away. `/plan` toggles plan mode; `/plan <message>` also steers that message, which is the base command's own behaviour.
- Background jobs and subagent runs are live process state, not durable events: they disappear when the run ends, and a resumed session starts with an empty board and roster.
- A card reads its tool's own render intent through the agent whose session is on screen, so a stored session with no live agent — one this process is not running, or a child that has already finished — folds to the generic card instead of the tool's own.
- Reading a child's conversation does not move the terminal: commands, approvals, and the status line stay with the session you launched, and the transcript is the only thing that switches. The status line carries the way back, read from the map in force, so a remap shows up without reopening the view.
- Delete is unimplemented: the session store exposes no delete, and the surface does not reach around that seam into its files. `/fork` covers the case that needs it — it branches into a new session and leaves the original alone.
- Approvals and questions render inline and take the keyboard; a question batch is answered in order, and a question that lists options can always be answered with free text on row `0`.
- Inside Herdr the pane reports its own state, and that report is the only thing that makes it an agent there: Herdr cannot start, resume, or prompt this surface, so launching and resuming stay with `dsh` itself (or a Herdr plugin that runs it).
- Styling is per element and overridable; see [Settings](#settings). Shipped defaults are emitted as 24-bit colour where the terminal advertises it and degraded to 256 or 16 colours otherwise, so a light or dark terminal still follows its own palette where it has one.
- Tool text, model text, and file content are escaped before rendering, so a hostile result cannot inject terminal control sequences; the cost is that a literal tab shows as \x09.
- Mermaid fences draw in assistant replies only, and only at the top level of one: a fence nested in a list, quoted inside another fence, or carried by a prompt, a thought, or a tool card stays source. Author `:::class` styling and diagram links are ignored — the renderer reports what each run is, and the theme decides how it looks.
- Prompt history is global to this machine, not per project: `$DSH_HOME/prompt-history.json` holds every submitted line, deduplicated exactly, and a file this build cannot parse is left untouched with writes refused so a newer format is never overwritten. Every write re-reads the file under a lock shared by sessions, so a second session's prompts are folded in rather than overwritten, and a lock whose holder stopped is reclaimed or reported instead of guessed at; control characters are spelled out before a prompt is stored. A multiline suggestion draws its first line with `↵` marking the fold. `history.ghost: false` keeps reverse search without the suggestion, `history.enabled: false` stops recording and offering it, and `NO_COLOR`/`--no-color` suppresses the ghost because text the reader cannot see but could still accept is worse than none.

## License

MIT
