# Changelog

All notable changes to `@sagmans/dsh-tui` are recorded in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x
caveat [RELEASE.md](RELEASE.md) states: while at 0.x, a minor bump may carry a
breaking change, and a patch carries only fixes.

## [Unreleased]

### Added

- `install-skills` ships both bundled skills: the dogfood helper, and
  `dsh-tui-update-models`, which names every place a provider or model is wired,
  the catalog fields that carry price, context window, and reasoning effort, and
  the checks that show an inherited value before it reaches a session.

### Fixed

- The model catalog dump reads a model the catalog spells out in metadata with no
  installed provider data, which is how a route the harness does not describe is
  wired.

- Model discovery failures now report a safe diagnostic instead of silently hiding
  a failed provider's catalog. Healthy routes remain selectable.
- TUI preferences now expose a Config schema for source hosts while preserving
  released section APIs and standalone core provider discovery. Config-backed
  writes reject schema runtimes without native live references instead of
  persisting a change that the running surface cannot apply.
- Row preferences apply before prompt history and rendering. Config-backed
  history and ghost completion require explicit opt-in, so delayed or failed
  legacy imports cannot enable recording first.
- Unsupported preference writes now report failure. Rejected theme changes
  restore the applied appearance, and theme diagnostics use that same state.
- Malformed preference reads preserve readable privacy opt-outs and the last valid
  appearance. History checks publicly exposed raw opt-outs even when an invalid
  sibling prevents the host from committing or notifying a change.

### Changed

- Enumeration of the workspace, the shared file index and its deadlines, and
  the @-mention grammar each sit in their own module, so the walk that lists
  files no longer changes beside the ranking that offers them.
- The action table, the spelling equivalences a key press is matched by, and
  the collision policy a layered keymap is judged with now sit in three modules,
  leaving the effective-map resolution and its display queries above them.
- The transcript view keeps row order, clicks, and caches, while tool-card,
  gate-card, and message drawing each live in their own renderer, so a card or a
  thought can change without touching the row cache around it.
- The transcript keeps reading order and in-flight text, while the bookkeeping
  a tool row shares between its request, its nested dispatches, and its result
  lives in a call fold that hands back the rows to commit; recorded message
  reading sits in its own module.
- Decision gates keep their question state machine, their question-card
  projection, and the shared gate contract in three modules, so a rendering
  change no longer sits beside the cursor and selection rules it draws.
- Tool cards now take their shape from one module, sub-call folding from
  another, the preview window from a third, and per-tool rendering from the
  presenter, so a new tool family touches the presenter alone.
- Terminal text now reads its escape grammar, its modelled style state, and its
  two public policies from three modules. Recognition is the trust boundary the
  drawing paths depend on, so it no longer changes beside row layout.
- The token contract, the shipped appearance, and the resolution algorithm each
  live in their own module. Appearance defaults and colour resolution change for
  reasons the token vocabulary does not, and the coverage sweep now fails beside
  the table it guards.
- The mounted surface is now a composition root under 500 lines: the terminal's
  lifetime, the one modal interaction, the prompt bar's presses, prompt memory
  and its draft bank, session discovery, the driven agent, the transcript on
  screen, staged turns, the session's mode, the model route, background work,
  appearance, and the command plane each own their state, so a change to one
  capability no longer moves beside the others in a single file.

### Added

- Running subagents in the dock now show the parent agent’s task label,
  limited to ten words, beside their ID and status.
- The subagent dock now previews three running children. Click the heading,
  overflow row, or blank space in the section to expand or collapse it. Click a
  child’s text to view that session’s transcript.
- `dsh --profile tui install-skills` copies `dsh-tui-dogfood` to the user
  skill root only on request. The skill supports any dsh plugin checkout through
  a cloned home. An existing copy prompts before replacement; `--update` skips
  the prompt.
- A theme can be pinned in this bundle's own row config, which is the layer that
  reaches the surface on a harness keeping settings per plugin row: the profile
  patch carries the name where the settings document no longer can. The
  `dsh-tui:` section still outranks the row, and the shipped default answers when
  neither names a theme. `/theme tokens` reports the row-pinned name too.
- `dsh --profile tui list-models` prints every provider/model the model picker
  can reach, one `provider/model<TAB>name` line in picker order, and exits
  without opening the alternate screen, so provider wiring is testable through a
  pipe. It exits 1 when the llm listing is unavailable or when nothing is
  configured to advertise a model.

### Fixed

- Switching model no longer leaves a reasoning effort in force that the chosen
  model cannot take, which made the next turn fail with `does not support
  reasoning effort`. The level in force now travels with the switch only while
  the model offers it, and a level the model does not offer falls back to the
  model's own default with one notice naming the model and the dropped level.
- The one-command dogfood run now works on the first try. A profile installs its
  local bundles as symlinks relative to the home they were installed in, so a
  clone at another depth — a scratch home under the temporary directory — left
  every one dangling and dsh refused to mount the profile; the script rebuilt
  each link from the absolute `link:` spec the profile's `package.json` already
  carried, and does so without `dsh plugin add`, which re-materialised the same
  relative links and dropped the other bundles the profile had, failing the run
  on its own bundle guard. `pnpm test` pins both halves on a synthetic home.
- A developer home that links its instructions outside it — `AGENTS.md` into a
  shared prompt tree is the common one — no longer stops the dogfood clone.
  Seeding copies such a read-only link in as a regular file, while a link to state
  the run may write (credentials, settings, storages, sessions, profiles) still
  stops the run, and links that stay inside the clone are left alone. The link
  policy lives in one module, so the seeding step and the validator read the same
  rules.
- The terminal surface no longer refuses a reader's settings on a harness whose
  ownership API is spelled differently. It registers its `dsh-tui:` section
  through whichever shape the mounted settings service offers, so a stored
  section parses and the prompt-history switch it carries is honoured instead of
  recording being forced off. A harness that keeps configuration per plugin row
  has no section at all, and that composition is read quietly rather than
  reported as a missing section.

## [0.6.0] - 2026-09-24

### Added

- A tool call now says what it is doing in the colour of its own name rather
  than in a mark beside it: `tool.running.title` paints the name of a call that
  has not answered, which also counts the whole seconds it has waited, once that
  is a second or more, in `tool.running.elapsed`. A call that failed is painted
  in `tool.failed.title` — including a shell command that exited non-zero or died
  on a signal, which the surface now reads as the failure it is rather than as a
  result that happens to carry a number. A card that dispatched calls keeps that
  total, dimmed and italic in `tool.elapsed.done`, when the program answers, and
  every call the program dispatched names itself the same way in its own indented
  row — `tool.subcall.running` while the program waits on it, `tool.subcall.title`
  once it is back — beside the tool's own line about its outcome, such as a shell's
  exit status, in `tool.terminal.status` where that tool declares one. Every one of
  these elements can be recoloured or hidden like any other token, so a reader can
  tell which of several calls is still running, which finished, and how each one
  ended without opening anything.

- Trying a build on a real profile is now one command:
  `scripts/dogfood/run-tui-from-worktree.sh` clones the developer's home into a
  scratch directory, points the clone's own profile at a worktree, rebuilds it,
  and starts the surface there — so a change meets the bundles, patch overlay,
  settings, and themes the daily driver actually runs, while every write lands in
  the clone. [DEVELOPMENT.md](DEVELOPMENT.md) says when a clone, a fresh home, or
  the real one is the right call, and `.agents/skills/dsh-tui-dogfood/` ships the same
  practice as a skill an agent working in this repository loads.

- `ctrl+x` then `u` (or `/undo`) hides the newest prompt with its whole turn and
  puts that prompt back in the bar, and `ctrl+x` then `r` (or `/redo`) steps forward
  again — unlimited while nothing new is sent. The log is untouched until the
  next send, which continues the visible prefix as a real branch, so the model
  never sees a prompt the reader undid; a running turn is stopped first, and
  queued prompts are parked in the stash one entry each rather than dropped.

- `/reload` composes this session's agent again without leaving the
  conversation. A preset's standing mount only re-reads its composition file for
  an agent that joins after the file changed, so an edited preset, skill, or
  prompt file reaches a running session only by joining anew; the durable log is
  replayed afterwards, so the reader keeps the conversation they were reading. A
  reload while a turn is in flight is refused with the way forward rather than
  forced: `ctrl+c` already owns that decision, and it hands any queued prompts
  back to the bar before the agent is disposed.

### Changed

- The shipped token table paints a tool's name in the palette accent rather than in
  the warning shade, which is now what a call that has not answered wears: a name
  painted in the colour of a state would leave that state nothing to say.

- A dock section — todos, subagents, jobs — now opens on a dashed rule that
  carries the section's own name, in a hue of its own. The heading row it
  replaces is the row the rule spends, so a section is no taller and no narrower
  than it was, and which board a row belongs to is read off the edge above it
  instead of off the row itself. Hiding a section's border element restores the
  plain heading, a section too narrow for a name and a dash falls back to one,
  and a section whose name the reader hid keeps the rows it always had: with no
  name to carry, the rule is not drawn at all.

- A copied selection now leaves the frame behind. A terminal copies the screen,
  so a drag across a message used to take the box it was drawn in along with it,
  and a prompt or a reply pasted anywhere carried the sides and the padding
  between them. The surface reads a copy back through the account it kept of its
  own drawing: a rule carries no text and is dropped, and the columns a row
  spends on a side and its padding are not part of what that row says, while a
  line it did not draw is handed back exactly as it came. A drag takes part of a
  message as readily as two of them, so what lands on the clipboard is the text
  the reader selected and nothing the surface added around it — a drag that
  caught no words at all, only the frame, comes back as the reader made it,
  because a copy is never emptied.

### Fixed

- A question's answer no longer offers the prompt bar's slash commands. The
  question borrows the prompt bar's own editor, so it borrowed its completion
  menu with it: typing `/` in a free-text answer listed the commands this
  session can run, which are lines the surface would execute rather than text
  the model reads. The bar now carries the menu its role calls for — the
  workspace's files behind `@`, path completion, and no commands while a
  question holds it — and gets the full menu back the moment the answer is
  settled.

- A Herdr row no longer flips through idle between two turns of one
  still-working agent. The harness chains turns through a pending inbox inside
  a single driver run, and the pane reported each turn's end, so a completion
  alert fired mid-run and the row restored working milliseconds later. The
  pane now reports the driver-level status instead, read once when a session
  opens (it is emitted on transitions only) and followed on every flip; waits
  still outrank it, and releases, retries, and session reports are unchanged.

- A resumed session whose composition will not mount now reports that refusal
  instead of falling back to a create, which dressed the real fault as the
  identity collision of a session that exists — the message a reload showed when
  the preset file it re-read had been broken.

## [0.5.2] - 2026-09-23

### Added

- A consumer install smoke packs the candidate and installs it inside a minimal
  `node:24-alpine` container, once with npm beside the harness and once as a
  plugin profile. A manifest that cannot resolve, a wrong mounted version, or a
  duplicated host package now fails CI instead of a user's install.

- `tools/harness-matrix.mjs` guards the harness matrix that the manifest only
  described: every verified release must lie inside the compatible range, the
  packages this bundle mounts must accept that range, and the sources must
  compile against a verified release. CI runs it on every change, and a
  scheduled workflow reads the registry's `latest` so a harness release that
  moves past the verified list fails on its own rather than during a release
  ([RELEASE.md](RELEASE.md#harness-matrix)).

### Changed

- The three harness packages this bundle mounts now follow the compatible range
  instead of one exact prerelease, so an npm tree keeps the host's copy rather
  than resolving a private duplicate beside it. `0.1.5-rc.2` and
  `0.1.5-rc.3` are verified releases, and the sources compile against rc.3.

### Fixed

- A goal that was marked complete no longer keeps a row in the work board: the
  harness keeps the completed snapshot as the session's last goal, so the row
  read as a loop still running until the goal was cleared or replaced. A paused
  or blocked goal now names its phase on the row rather than showing only its
  round counter.

## [0.5.1] - 2026-09-23

### Fixed

- The manifest pinned every harness peer at one exact prerelease. npm answered
  with `ERESOLVE` as soon as the harness's own floating peers resolved past
  that pin, so the package could not be installed with npm at all; the pins also
  let npm place a private copy of a singleton the host already provides. The
  peers now declare the harness range the manifest already promises and are
  marked optional, so an npm tree keeps the host's copy and the install
  resolves ([#67](https://github.com/sagmans/dsh-tui/pull/67)).

## [0.5.0] - 2026-09-22

### Added

- An assistant reply is drawn inside a frame of its own, in the
  `transcript.assistant.border` element, so one exchange reads as two objects
  rather than as a box followed by a stream of rows. Hiding that element draws the
  reply bare, exactly as hiding `editor.border` does for a prompt ([#65](https://github.com/sagmans/dsh-tui/pull/65)).

- Themes are files. The package ships each one in full — `deepseek-blue`, the
  table written out element by element in the colours the project answers to, and
  `violet-orbit` — and your own live in `$DSH_HOME/themes/`, which the surface
  creates at start-up and watches, so saving a file there restyles the running
  session without a restart. `deepseek-blue` is what a section naming no theme
  draws, so the default look is a file a reader can read, list, and copy. `/theme
  export <built-in>` copies a built-in into that directory as
  `<built-in>_export_<n>.yaml`, with one comment naming the release it came from,
  because the package's own file is replaced whenever the package updates. Every
  shipped file names every element and palette entry, so a copy is a complete
  theme rather than a diff against something invisible. A file whose name is a
  built-in's is ignored, and reported at start-up with the rename that fixes it.
  `deepseek-blue` takes every shade from the product's own design tokens, at the
  steps its dark theme names, and writes the token beside each value, so the
  surface can be re-derived rather than guessed at; the accent is the step the
  product keeps for the brand as text. It names only palette entries, so the brand
  moves in one line, and it marks a reader's own turn with the product's bubble
  fill rather than a hue of its own ([#61](https://github.com/sagmans/dsh-tui/pull/61)).

- A fenced block that names `diff` or `patch` draws as the change it describes
  instead of one plain code block: file and hunk headers recede, added rows draw
  green, removed rows draw red, and the characters that changed inside a paired
  row sit on a darker band of that row's colour. Unchanged rows keep the shade a
  code block always had, every other language draws exactly as before, and the
  seven diff elements are overridden through `tokens:` like any other ([#62](https://github.com/sagmans/dsh-tui/pull/62)).
- `Ctrl+X` then `?` opens the key map as a searchable list: one row per action
  with the keys in force, one row for every key the map took from the library,
  and a filter reaching the action id, the layer, a key, or what the row does.
  The list is drawn in a box over the transcript, so looking a key up no longer
  costs the reader their place in it ([#53](https://github.com/sagmans/dsh-tui/pull/53)).
- A PTC program's dispatched calls stay visible as one row each under the
  `run_code` header without opening the card, and a click opens one call's
  argument in full while its neighbours stay as they were; opening a shell call
  also shows the rows it printed, which the program's return value alone often
  drops. A thought opens and folds on a click too, instead of only through the
  key that moves every one ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- Tool cards fold one message at a time: a click on a card opens or folds that
  row alone, and a `dsh-tui: tools:` block decides how each tool starts —
  whether its cards start folded and whether a fold hides its rows or keeps a
  `tail` of them. Ctrl+O still opens or folds every card at once, and a
  message the reader clicked keeps the state the click gave it ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- The bar's draft opens in the reader's own editor: `ctrl+x` then `e` hands the
  terminal to `$VISUAL` (or `$EDITOR`) with the draft in an owner-only scratch
  file, waits for the child, repaints, and takes back what was saved through one
  no-follow handle that refuses anything past 1 MiB, with control and bidi
  characters stripped. A non-zero exit still keeps the saved text, no
  editor configured is a notice rather than a failure, and a draft past 1 MiB is
  left on disk with its path instead of loaded into the bar ([#44](https://github.com/sagmans/dsh-tui/pull/44)).
- A related-plugins section closes the README: the two companion bundles that
  stack onto a profile — an absolute compaction budget and extra provider
  routes — with the commands that mount them and how each meets this bundle's
  own composition ([#47](https://github.com/sagmans/dsh-tui/pull/47)).
- Ctrl+P and Ctrl+N move through every list the way the arrows do: a picker's
  rows, a question's options and the free-text row that leaves them, and the
  editor's completion menu. They are ordinary bindings, so `/keys` prints them
  and the `keys:` section moves them ([#52](https://github.com/sagmans/dsh-tui/pull/52)).
- Themes are chosen by name. `dsh-tui: theme: violet-orbit` applies a port of
  the pi theme of the same name: its palette, plus the elements it draws its own
  way. A theme is a layer rather than a replacement, so anything it says nothing
  about keeps its shipped appearance and a reader's own `tokens:` entry still
  wins over it one field at a time. `/theme <name>` applies one to the running
  session and writes the choice to the document, and a name the surface does not
  ship is refused with the names it does. `/theme tokens` names the theme in force
  in its heading and reports each element as `override`, `theme`, `palette`, or
  `default`, so a screen that looks wrong can be traced to the layer that drew it. The port keeps a
  prompt's frame but not the fill pi puts behind it, because a band inside a
  frame treats one fact twice and reads as a selected row; and it lifts a tool's
  argument out of pi's link blue, which sat too close to the periwinkle pi gives
  a tool's name for one row to read as the two facts it carries ([#56](https://github.com/sagmans/dsh-tui/pull/56), [#57](https://github.com/sagmans/dsh-tui/pull/57), [#61](https://github.com/sagmans/dsh-tui/pull/61)).
- Every tool's dispatched call opens on a click to what that tool declared and
  what it produced, not only a shell's output: an edit's diff in the diff
  colours, a read's lines, a search's hits. What the call declared is kept from
  the moment it starts, so the row opens while the call still runs and keeps the
  state the reader gave it when the outcome lands ([#60](https://github.com/sagmans/dsh-tui/pull/60)).
- `Ctrl+X` then `n` starts a fresh session, the session `/new` starts, without
  the typed line that would have replaced the draft in the bar ([#63](https://github.com/sagmans/dsh-tui/pull/63)).

### Changed

- A theme name the surface does not have is no longer a settings error. The names
  are files, so a name nothing answers to is reported as a notice listing the ones
  that do, and the default theme is drawn meanwhile; a settings document naming a
  theme therefore loads even if the file is renamed or deleted later. `/theme`
  reports a themed element's origin as `theme` rather than `preset`, and its
  footer names the themes actually on disk, marking the ones in your directory,
  with the export hint ([#61](https://github.com/sagmans/dsh-tui/pull/61)).
- `/theme` opens a list of the themes on disk instead of printing the table. The
  list narrows as you type and the screen paints the row under the cursor, so two
  themes are compared on the reader's own transcript; nothing is written until one
  is taken, and leaving the list puts back the theme that was in force. The table
  is still there, as `/theme tokens` ([#61](https://github.com/sagmans/dsh-tui/pull/61)).
- `/keys` opens the key map as a list you filter as you type instead of
  printing every row into the transcript. `/keys <layer>` opens the same list
  already narrowed to one layer, and a layer name the surface does not have is
  still refused with the names it does ([#53](https://github.com/sagmans/dsh-tui/pull/53)).
- Ctrl+C no longer leaves. It takes back one thing per press — the draft in the
  bar, the prompts waiting in the agent's inbox (put back into the bar before the
  turn is stopped, because an interrupt drops them), the running turn, or a
  child's conversation — and with a picker, an approval, a question, or the
  transcript search open it closes that first. A press with nothing left to
  cancel does nothing rather than ending the session. Ctrl+D is the only key
  that leaves, and only while the bar holds no text: a running turn is cancelled
  on the way out, the resume command prints, and the terminal is restored as
  before. `/quit` and `/exit` still leave ([#48](https://github.com/sagmans/dsh-tui/pull/48)).
- A question gate gained an abandon key: Ctrl+C settles the batch with no
  answers, the shape an aborted call already produces, while Esc keeps skipping
  one question. An approval now cancels on Ctrl+C as well as Esc ([#48](https://github.com/sagmans/dsh-tui/pull/48)).
- A folded tool card is one row for every tool, bash included: the row carries
  the tool, its command clipped at the screen edge, the exit status, and the
  count of output rows waiting behind the fold, instead of spending twenty
  rows on shell output by default. `output: tail` restores a preview window per
  tool, and a PTC card's dispatched calls stay one row each under the header ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- A thought and the row naming it both recede to a shade below the muted
  family, and only the row is italic, so the signpost no longer competes with
  the text it introduces ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- Injected context rows name what arrived instead of only the producer: the
  workspace-instructions row lists the instruction files it loaded
  (`~/.dsh/AGENTS.md`, `AGENTS.md`, or the nested file a later delta touched),
  the skill catalog reports how many entries it published, a runtime snapshot
  names its sections, and notices, relays, goals, and cross-session recalls get
  labels of their own. A source that declares no form keeps the previous
  `producer · N lines — preview` row ([#51](https://github.com/sagmans/dsh-tui/pull/51)).
- Tool output, model text, and file content are drawn the way a terminal would
  draw them instead of being escaped into visible bytes: a colour the terminal
  can show is shown at the session's colour budget, a tab lands on the column
  its writer saw, and a carriage return collapses to the state its row settled
  on. Cursor moves, screen clears, window titles, and clipboard writes are still
  consumed, so a hostile result cannot reach the terminal, and a stray control
  byte is spelled out rather than dropped. Text the surface paints itself — a
  ghost suggestion, a completion row, a queued prompt, an export — carries no
  colour, because the surface is already styling it ([#54](https://github.com/sagmans/dsh-tui/pull/54)).

- A prompt stash belongs to the session that parked it rather than to the
  working directory: a second terminal in the same checkout no longer sees or
  clears the first one's drafts, and resuming a session finds its own. The bank
  key moved to `v2`, so directory-scoped banks written by 0.4.0 are left where
  they are and are not read ([#43](https://github.com/sagmans/dsh-tui/pull/43)).
- Markdown renders for every message rather than only a reply: a submitted
  prompt lays its markdown out inside its own frame, and an opened thought
  parses lists, fences, and emphasis in the thought's own shade. A thought's
  mermaid fence stays source instead of carrying the answer's weight ([#46](https://github.com/sagmans/dsh-tui/pull/46)).

### Fixed

- A frame a component cannot draw no longer ends the session: the last good
  screen stays up and the failure reaches the transcript, and a terminating
  signal (Ctrl+C at the terminal, SIGTERM, SIGHUP, SIGQUIT) restores the screen
  and leaves with the status a shell reports for it ([#50](https://github.com/sagmans/dsh-tui/pull/50)).
- Text the host writes straight to stdout or stderr — a library's log line, an
  unhandled-rejection report, a stack trace — waits until the surface gives the
  screen back instead of landing inside a frame, where it would be painted over
  and then skipped as unchanged ([#50](https://github.com/sagmans/dsh-tui/pull/50)).
- A thought still streaming is bounded like the row it settles into, so a long
  one cannot make every frame it draws slower than the last ([#50](https://github.com/sagmans/dsh-tui/pull/50)).
- A cached transcript row is kept for the life of the entry it belongs to instead
  of being evicted at a fixed count, so a session longer than that count no
  longer re-wraps every row on every repaint ([#50](https://github.com/sagmans/dsh-tui/pull/50)).
- Every row a bar hands out fits the surface that draws it: a bar narrower than
  its own padding, a wide glyph beside the edge, and a gate answer under an
  indent as wide as the terminal are cut where the bar can count what it lost,
  and a cut — including a thought's own character budget — falls between
  grapheme clusters instead of splitting a joined emoji ([#50](https://github.com/sagmans/dsh-tui/pull/50)).
- A fold no longer keeps sub-call indexing from a session that was dropped, a
  thought the stream never settled no longer stays live into the next turn, and
  every thought a replayed turn recorded is painted instead of every other one ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- A click in the prompt bar reaches the editor that drew it, the work board
  gives up rows before the input bar does — which keeps a frame's worth of rows
  no shrink can take — and live text and failures fold into the session the
  reader is looking at rather than the one this terminal drives ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- A click lands on the row it was made on while a thought is still streaming,
  and a folded thought fits a terminal too narrow to hold both its signpost and
  its fold key ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- A row that carried a line break — a background job's label, a command a PTC
  program wrote across lines, a path, or any other fact a component draws on one
  row — no longer writes the rest of itself over the row below it, which is how
  a tool row could reach the editor's frame. The one line a cut promises is now
  one line, and the status row flattens what a fact brought even when it never
  needed a cut ([#49](https://github.com/sagmans/dsh-tui/pull/49)).
- A picker's hint folds under its indent instead of being cut, so a narrow
  screen still names the keys that leave the list (`esc/ctrl+c`) ([#59](https://github.com/sagmans/dsh-tui/pull/59)).
- A failed call's own details are reachable. A program's dispatched call kept
  rows only when its tool drew a shell view, so the red row a reader clicked for
  an edit, a read, or a search opened to nothing; the outcome the model was shown
  is now kept for every kind, and a failure takes back the change it declared
  rather than drawing rows for work that never happened ([#60](https://github.com/sagmans/dsh-tui/pull/60)).
- `/new` no longer leaves the conversation it starts blank: the transcript was
  still measuring the fresh session's rows against the numbering of the one it
  replaced, so the submitted prompt, every settled row, and the calls a PTC
  program dispatched under its card were dropped from the new session ([#64](https://github.com/sagmans/dsh-tui/pull/64)).

## [0.4.0] - 2026-09-21

### Added

- A todo guard nudges an agent whose plan has aged: the advisory host row reads
  the harness's own `todos` and `plan` projections and rides the next tool
  result with a reminder, capped per turn, plan-mode aware, and silent when it
  cannot know the plan ([#36](https://github.com/sagmans/dsh-tui/pull/36)).
- Every submitted line is kept in a machine-wide prompt history: a recorded
  prompt is offered as dimmed ghost text, `ctrl+r` opens reverse search seeded
  with the bar's draft, the `history` settings block tunes or disables both, and
  a lock shared by sessions folds concurrent writes together
  ([#37](https://github.com/sagmans/dsh-tui/pull/37)).
- A pane inside Herdr reports its lifecycle over the socket Herdr exports:
  `wait` while a gate or picker holds the keyboard, work during a turn, idle
  otherwise, with the session identity and resume tokens an exact resume needs;
  the row is handed back on the way out, and away from Herdr nothing changes
  ([#38](https://github.com/sagmans/dsh-tui/pull/38)).
- Prompt drafts park per working directory: `ctrl+x` then `s`, or
  `/stash <draft>`, saves the bar into an owner-only bank, `/stash-pop`,
  `/stash-apply`, `/stash-list`, `/stash-drop`, and `/stash-clear` answer
  it, the footer counts the drafts waiting, and a pop fills the editor before it
  removes the entry ([#39](https://github.com/sagmans/dsh-tui/pull/39)).

### Changed

- The plan strip clears when the next turn opens, following the host
  projection's lifetime, so a fresh task never inherits the previous turn's
  checklist ([#36](https://github.com/sagmans/dsh-tui/pull/36)).

### Documentation

- The prompt stash, prompt history, Herdr reporting, and the todo guard are
  documented with their commands, chords, settings, on-disk contract, and the
  checks a real terminal still has to answer
  ([#36](https://github.com/sagmans/dsh-tui/pull/36), [#37](https://github.com/sagmans/dsh-tui/pull/37), [#38](https://github.com/sagmans/dsh-tui/pull/38), [#39](https://github.com/sagmans/dsh-tui/pull/39)).

## [0.3.0] - 2026-09-21

### Added

- Every action's keys are settable: the `keys:` section of `settings.yaml`
  overrides any row the surface or its library answers, `/keys [layer]` lists
  every action with the keys in force and prints a sample document, and a write
  lands on the next press rather than the next launch ([#34](https://github.com/sagmans/dsh-tui/pull/34)).
- Chords: `ctrl+x` arms a chord, the footer shows it waiting, and the second key
  asks the same dispatcher its command does — `m` for the model picker, `p` for
  plan mode, `y` for the last answer. The prefix, the window, and every second
  key are settable rows ([#29](https://github.com/sagmans/dsh-tui/pull/29), [#34](https://github.com/sagmans/dsh-tui/pull/34)).
- Plan mode has a chord of its own, so the toggle is one prefix away ([#34](https://github.com/sagmans/dsh-tui/pull/34)).
- Prompts the agent has not taken yet are drawn in the editor's frame, and a
  submitted prompt keeps that frame in the transcript ([#24](https://github.com/sagmans/dsh-tui/pull/24)).
- The model picker filters as you type, and a query matches scattered fragments,
  so `glm53` finds `GLM-5.3` ([#25](https://github.com/sagmans/dsh-tui/pull/25)).
- A question is answered in the prompt bar's own editor, with completion,
  history, undo, cursor movement, and pasted text; an escape from typed text
  returns to the option list instead of dropping the answer ([#26](https://github.com/sagmans/dsh-tui/pull/26)).
- A reply's `mermaid` fence draws as a terminal diagram at the transcript width;
  `dsh-tui: mermaid: streaming|final|off` chooses when, and anything undrawable
  stays as the source fence ([#21](https://github.com/sagmans/dsh-tui/pull/21)).

### Changed

- **Breaking:** `enter` no longer sends a prompt — it writes the line. The
  default send keys are `ctrl+enter`, `alt+enter`, and `ctrl+s`, and
  `keys.prompt.submit` moves them ([#31](https://github.com/sagmans/dsh-tui/pull/31)).
- **Breaking:** a typed answer is hidden only when its question declares it with
  a `:secret` id suffix; wording alone no longer hides a value, because a
  question that merely mentions a key is not asking for a credential ([#27](https://github.com/sagmans/dsh-tui/pull/27)).
- A submitted prompt is shaded mint rather than rose, so the reader's own words
  stay apart from the agent's without the pink cast ([#28](https://github.com/sagmans/dsh-tui/pull/28)).

### Fixed

- A question gate leaves the keyboard when its call aborts instead of holding the
  editor for an answer no caller will read ([#33](https://github.com/sagmans/dsh-tui/pull/33)).
- Pasted text reaches gates and pickers, and a question keeps the heading its
  caller set ([#22](https://github.com/sagmans/dsh-tui/pull/22)).
- A windowed option list keeps counting from its position, so the drawn number
  and the digit that picks by it agree ([#23](https://github.com/sagmans/dsh-tui/pull/23)).
- A refused settings section is reported at boot instead of silently doing
  nothing ([#30](https://github.com/sagmans/dsh-tui/pull/30)).

### Documentation

- An `AGENTS.md` operating map records the constraints an agent needs before
  touching the tree ([#32](https://github.com/sagmans/dsh-tui/pull/32)).

## [0.2.0] - 2026-09-18

### Added

- A PTC card draws the calls its program dispatched as indented rows; `ctrl+y`
  folds them, `dsh-tui: subcalls: collapsed|inline` makes that choice stick, and
  `/export` carries the calls into the markdown dump ([#18](https://github.com/sagmans/dsh-tui/pull/18)).
- PTC is the default agent mode, and it is read from the session when a session
  opens, so a resume reports the mode it composed with ([#15](https://github.com/sagmans/dsh-tui/pull/15)).
- Reasoning effort is choosable for the next step ([#14](https://github.com/sagmans/dsh-tui/pull/14)).
- Tool cards fold, with the shell command and stats kept visible ([#13](https://github.com/sagmans/dsh-tui/pull/13)).
- Every element is individually themable, with shipped defaults degraded to
  256/16 colours where the terminal does not advertise 24-bit colour ([#12](https://github.com/sagmans/dsh-tui/pull/12)).

### Changed

- The prompt has an edge and completions stay off it ([#17](https://github.com/sagmans/dsh-tui/pull/17)).
- A submitted prompt takes its own shade ([#16](https://github.com/sagmans/dsh-tui/pull/16)).

### Fixed

- Runtime warnings no longer draw inside the interface: startup warnings print in
  the launching shell, and deferred ones are reported when terminal ownership
  returns ([#19](https://github.com/sagmans/dsh-tui/pull/19)).

## [0.1.2] - 2026-09-11

### Changed

- The README's status and registry-install lines name the package instead of a
  version, so they no longer go stale at each release ([#10](https://github.com/sagmans/dsh-tui/pull/10)).

### Build

- Workflow actions are pinned to commit SHAs ([#9](https://github.com/sagmans/dsh-tui/pull/9)).
- CI verifies the registry signatures and publish attestations of the dependency
  tree (`npm audit signatures`) before a release can publish ([#9](https://github.com/sagmans/dsh-tui/pull/9)).
- The release helper waits out registry propagation on its post-publish readback
  ([#8](https://github.com/sagmans/dsh-tui/pull/8)).

## [0.1.1] - 2026-09-11

### Changed

- No shipped-code change: the library is republished with the corrected README
  ([#7](https://github.com/sagmans/dsh-tui/pull/7)).

### Build

- First release published through the tag workflow: npm OIDC trusted publishing
  with a SLSA provenance attestation and no stored npm token ([#6](https://github.com/sagmans/dsh-tui/pull/6)).

## [0.1.0] - 2026-09-11

### Added

- Initial publication: the terminal surface for DeepSeek Harness — alternate
  screen sessions, streamed markdown, per-tool cards, approvals and questions,
  stored conversations, mid-session model switching, and the shipped agent modes
  ([#2](https://github.com/sagmans/dsh-tui/pull/2)).
- Installing from a plugin checkout, and the failures around it, are documented
  ([#3](https://github.com/sagmans/dsh-tui/pull/3)).

### Fixed

- The surface no longer reports a shallower path than the session's directory
  ([#4](https://github.com/sagmans/dsh-tui/pull/4)).

### Build

- Publication through npm OIDC trusted publishing, with the first version
  bootstrapped by hand ([#5](https://github.com/sagmans/dsh-tui/pull/5)).

[Unreleased]: https://github.com/sagmans/dsh-tui/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/sagmans/dsh-tui/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/sagmans/dsh-tui/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/sagmans/dsh-tui/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/sagmans/dsh-tui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sagmans/dsh-tui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sagmans/dsh-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sagmans/dsh-tui/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/sagmans/dsh-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/dsh-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/dsh-tui/tree/v0.1.0
