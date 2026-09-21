# Changelog

All notable changes to `@sagmans/dsh-tui` are recorded in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x
caveat [RELEASE.md](RELEASE.md) states: while at 0.x, a minor bump may carry a
breaking change, and a patch carries only fixes.

## [Unreleased]

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

[Unreleased]: https://github.com/sagmans/dsh-tui/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sagmans/dsh-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sagmans/dsh-tui/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/sagmans/dsh-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/dsh-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/dsh-tui/tree/v0.1.0
