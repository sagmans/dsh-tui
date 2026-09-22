# Changelog

All notable changes to `@sagmans/dsh-tui` are recorded in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x
caveat [RELEASE.md](RELEASE.md) states: while at 0.x, a minor bump may carry a
breaking change, and a patch carries only fixes.

## [Unreleased]

### Changed

- A theme name the surface does not have is no longer a settings error. The names
  are files, so a name nothing answers to is reported as a notice listing the ones
  that do, and the shipped table is drawn meanwhile; a settings document naming a
  theme therefore loads even if the file is renamed or deleted later. `/theme`
  reports a themed element's origin as `theme` rather than `preset`, and its
  footer names the themes actually on disk, marking the ones in your directory,
  with the export hint.
- `/keys` opens the key map as a list you filter as you type instead of
  printing every row into the transcript. `/keys <layer>` opens the same list
  already narrowed to one layer, and a layer name the surface does not have is
  still refused with the names it does.
- Ctrl+C no longer leaves. It takes back one thing per press — the draft in the
  bar, the prompts waiting in the agent's inbox (put back into the bar before the
  turn is stopped, because an interrupt drops them), the running turn, or a
  child's conversation — and with a picker, an approval, a question, or the
  transcript search open it closes that first. A press with nothing left to
  cancel does nothing rather than ending the session. Ctrl+D is the only key
  that leaves, and only while the bar holds no text: a running turn is cancelled
  on the way out, the resume command prints, and the terminal is restored as
  before. `/quit` and `/exit` still leave.
- A question gate gained an abandon key: Ctrl+C settles the batch with no
  answers, the shape an aborted call already produces, while Esc keeps skipping
  one question. An approval now cancels on Ctrl+C as well as Esc.
- A folded tool card is one row for every tool, bash included: the row carries
  the tool, its command clipped at the screen edge, the exit status, and the
  count of output rows waiting behind the fold, instead of spending twenty
  rows on shell output by default. `output: tail` restores a preview window per
  tool, and a PTC card's dispatched calls stay one row each under the header.
- A thought and the row naming it both recede to a shade below the muted
  family, and only the row is italic, so the signpost no longer competes with
  the text it introduces.
- Injected context rows name what arrived instead of only the producer: the
  workspace-instructions row lists the instruction files it loaded
  (`~/.dsh/AGENTS.md`, `AGENTS.md`, or the nested file a later delta touched),
  the skill catalog reports how many entries it published, a runtime snapshot
  names its sections, and notices, relays, goals, and cross-session recalls get
  labels of their own. A source that declares no form keeps the previous
  `producer · N lines — preview` row.
- Tool output, model text, and file content are drawn the way a terminal would
  draw them instead of being escaped into visible bytes: a colour the terminal
  can show is shown at the session's colour budget, a tab lands on the column
  its writer saw, and a carriage return collapses to the state its row settled
  on. Cursor moves, screen clears, window titles, and clipboard writes are still
  consumed, so a hostile result cannot reach the terminal, and a stray control
  byte is spelled out rather than dropped. Text the surface paints itself — a
  ghost suggestion, a completion row, a queued prompt, an export — carries no
  colour, because the surface is already styling it.

### Added

- Themes are files. The package ships each one in full — `shipped`, the default
  table written out element by element, and `violet-orbit` — and your own live in
  `$DSH_HOME/themes/`, which the surface creates at start-up and watches, so
  saving a file there restyles the running session without a restart. `/theme
  export <built-in>` copies a built-in into that directory as
  `<built-in>_export_<n>.yaml`, with one comment naming the release it came from,
  because the package's own file is replaced whenever the package updates. Both
  shipped files name every element and palette entry, so a copy is a complete
  theme rather than a diff against something invisible. A file whose name is a
  built-in's is ignored, and reported at start-up with the rename that fixes it.
- `Ctrl+X` then `?` opens the key map as a searchable list: one row per action
  with the keys in force, one row for every key the map took from the library,
  and a filter reaching the action id, the layer, a key, or what the row does.
  The list is drawn in a box over the transcript, so looking a key up no longer
  costs the reader their place in it.
- A PTC program's dispatched calls stay visible as one row each under the
  `run_code` header without opening the card, and a click opens one call's
  argument in full while its neighbours stay as they were; opening a shell call
  also shows the rows it printed, which the program's return value alone often
  drops. A thought opens and folds on a click too, instead of only through the
  key that moves every one.
- Tool cards fold one message at a time: a click on a card opens or folds that
  row alone, and a `dsh-tui: tools:` block decides how each tool starts —
  whether its cards start folded and whether a fold hides its rows or keeps a
  `tail` of them. Ctrl+O still opens or folds every card at once, and a
  message the reader clicked keeps the state the click gave it.
- The bar's draft opens in the reader's own editor: `ctrl+x` then `e` hands the
  terminal to `$VISUAL` (or `$EDITOR`) with the draft in an owner-only scratch
  file, waits for the child, repaints, and takes back what was saved through one
  no-follow handle that refuses anything past 1 MiB, with control and bidi
  characters stripped. A non-zero exit still keeps the saved text, no
  editor configured is a notice rather than a failure, and a draft past 1 MiB is
  left on disk with its path instead of loaded into the bar.
- A related-plugins section closes the README: the two companion bundles that
  stack onto a profile — an absolute compaction budget and extra provider
  routes — with the commands that mount them and how each meets this bundle's
  own composition.
- Ctrl+P and Ctrl+N move through every list the way the arrows do: a picker's
  rows, a question's options and the free-text row that leaves them, and the
  editor's completion menu. They are ordinary bindings, so `/keys` prints them
  and the `keys:` section moves them.
- Themes are chosen by name. `dsh-tui: theme: violet-orbit` applies a port of
  the pi theme of the same name: its palette, plus the elements it draws its own
  way. A theme is a layer rather than a replacement, so anything it says nothing
  about keeps its shipped appearance and a reader's own `tokens:` entry still
  wins over it one field at a time. `/theme <name>` applies one to the running
  session and writes the choice to the document, `shipped` returns to the
  default table, and a name the surface does not ship is refused with the names
  it does. A bare `/theme` names the theme in force in its heading and reports
  each element as `override`, `preset`, `palette`, or `default`, so a screen
  that looks wrong can be traced to the layer that drew it. The port keeps a
  prompt's frame but not the fill pi puts behind it, because a band inside a
  frame treats one fact twice and reads as a selected row; and it lifts a tool's
  argument out of pi's link blue, which sat too close to the periwinkle pi gives
  a tool's name for one row to read as the two facts it carries.
- Every tool's dispatched call opens on a click to what that tool declared and
  what it produced, not only a shell's output: an edit's diff in the diff
  colours, a read's lines, a search's hits. What the call declared is kept from
  the moment it starts, so the row opens while the call still runs and keeps the
  state the reader gave it when the outcome lands.

### Changed

- A prompt stash belongs to the session that parked it rather than to the
  working directory: a second terminal in the same checkout no longer sees or
  clears the first one's drafts, and resuming a session finds its own. The bank
  key moved to `v2`, so directory-scoped banks written by 0.4.0 are left where
  they are and are not read.
- Markdown renders for every message rather than only a reply: a submitted
  prompt lays its markdown out inside its own frame, and an opened thought
  parses lists, fences, and emphasis in the thought's own shade. A thought's
  mermaid fence stays source instead of carrying the answer's weight.

### Fixed

- A frame a component cannot draw no longer ends the session: the last good
  screen stays up and the failure reaches the transcript, and a terminating
  signal (Ctrl+C at the terminal, SIGTERM, SIGHUP, SIGQUIT) restores the screen
  and leaves with the status a shell reports for it.
- Text the host writes straight to stdout or stderr — a library's log line, an
  unhandled-rejection report, a stack trace — waits until the surface gives the
  screen back instead of landing inside a frame, where it would be painted over
  and then skipped as unchanged.
- A thought still streaming is bounded like the row it settles into, so a long
  one cannot make every frame it draws slower than the last.
- A cached transcript row is kept for the life of the entry it belongs to instead
  of being evicted at a fixed count, so a session longer than that count no
  longer re-wraps every row on every repaint.
- Every row a bar hands out fits the surface that draws it: a bar narrower than
  its own padding, a wide glyph beside the edge, and a gate answer under an
  indent as wide as the terminal are cut where the bar can count what it lost,
  and a cut — including a thought's own character budget — falls between
  grapheme clusters instead of splitting a joined emoji.
- A fold no longer keeps sub-call indexing from a session that was dropped, a
  thought the stream never settled no longer stays live into the next turn, and
  every thought a replayed turn recorded is painted instead of every other one.
- A click in the prompt bar reaches the editor that drew it, the work board
  gives up rows before the input bar does — which keeps a frame's worth of rows
  no shrink can take — and live text and failures fold into the session the
  reader is looking at rather than the one this terminal drives.
- A click lands on the row it was made on while a thought is still streaming,
  and a folded thought fits a terminal too narrow to hold both its signpost and
  its fold key.
- A row that carried a line break — a background job's label, a command a PTC
  program wrote across lines, a path, or any other fact a component draws on one
  row — no longer writes the rest of itself over the row below it, which is how
  a tool row could reach the editor's frame. The one line a cut promises is now
  one line, and the status row flattens what a fact brought even when it never
  needed a cut.
- A picker's hint folds under its indent instead of being cut, so a narrow
  screen still names the keys that leave the list (`esc/ctrl+c`).
- A failed call's own details are reachable. A program's dispatched call kept
  rows only when its tool drew a shell view, so the red row a reader clicked for
  an edit, a read, or a search opened to nothing; the outcome the model was shown
  is now kept for every kind, and a failure takes back the change it declared
  rather than drawing rows for work that never happened.

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

[Unreleased]: https://github.com/sagmans/dsh-tui/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sagmans/dsh-tui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sagmans/dsh-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sagmans/dsh-tui/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/sagmans/dsh-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/dsh-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/dsh-tui/tree/v0.1.0
