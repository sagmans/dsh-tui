# Feature verification

## Scope

[`tools/feature-inventory.json`](tools/feature-inventory.json) records product scope, owners, commands, keyboard actions, and appearance tokens.
[`tools/dogfood-scenarios.json`](tools/dogfood-scenarios.json) records actual-use procedures and postconditions.

The inventory covers session lifecycle, editing, completion, models, modes, history, stashes, appearance, rendering, tools, gates, work, and integrations.
Each feature names its source owner and its free, paid, or environment-specific scenarios.
Public command, action, token, and palette catalog changes fail the gate until the inventory changes.
Private card-row membership does not require a production export.
Actual appearance scenarios remain the behavior proof.

Inventory membership is not verification.
Action discovery in `/keys` does not prove keyboard dispatch.
Golden frames remain visual regression checks.
Neither snapshots nor a clean boot prove full feature behavior.

## Duration indicators

The free `timers` scenario mounts a test-owned workload in a credential-free profile.
It verifies registry ownership, non-consuming UI reads, job cancellation, and clock repainting after parent settlement.
It also checks tool duration after replay, duplicate child starts, and unknown runtimes for end-only children.
Golden frames pin zero, minute, and hour boundaries without rounding time forward.
Paid model usage and physical window focus checks remain demand-only.

## Free verification after development

1. Run `pnpm verify` after every development change.
2. Read failures and the private evidence directory printed by the runner.
3. Fix the responsible behavior or an incorrect scenario precondition.
4. Repeat the gate before reporting completion.

`pnpm test` runs golden frames and free dogfood automatically.
`pnpm dogfood` rebuilds and runs every free scenario.
The installed Harness must match a release listed in `package.json`.
Use `--launcher` when the installed binary is not on `PATH`.
CI installs that same host locally with lifecycle scripts disabled.
CI checks its dependency signatures before dogfood.

Free runs start real `dsh --profile tui` processes in PTYs.
Each profile composes the installed base bundle and the current worktree.
The runner creates private homes and workspaces without copying credentials or live state.
Its environment excludes model credentials, existing agent-pane coordinates, and notification credentials.
Free input submits only local surface commands.
The pruning scenario mounts a scratch-only event fixture and publishes native session events without executing tools or billing a model.
It checks retained PTC cards, nested calls, subsequent ordinary results, and durable exports before and after restart.
A fresh-process stored-child view separately checks the persistence adapter, where reconstructed events can lose replacement metadata.
These checks prove live, resumed, and stored-session presentation, not model reasoning or tool dispatch.
Model prompts require the separate paid mode.

The gate checks current terminal cells, durable exports, private file permissions, persisted restart, actual editor handoff, and terminal restoration.
Native-widget PTY checks supplement the full-profile runs.
The command table checks the exact never-written `/todo` notice.
The guard table checks exact rejection notices for extra `/jobs read` and `/jobs kill` arguments before lookup or action.
History runs retain native consent refusal.
The public consent configuration proves default-home restart recall and clear without stale search entries.
Stash runs use native clocks and filesystem writes.
Editor-scoped assertions and restart recall prove actual use.
Repaired/deleted history-file recovery remains unverified: `step.file` supports assertions, not mutations or home paths.
A status receipt establishes the command plane before keyboard scenarios; the initial ready footer alone is insufficient.

## Herdr transport

In a Herdr-managed caller (`HERDR_ENV=1`), the free gate also runs `tools/dogfood-herdr.mjs`.
The runner uses real `pane send-keys`, current terminal cells, changed geometry, and private scratch profiles.
A disposable named session and private controlling PTY keep this work separate from live conversations.
The controller does not launch the caller's configured shell or source its startup files.
Cleanup verifies named-session deletion, controller exit, and shell usability.
A free lifecycle scenario reads actual agent idle state, session-change tokens, workspace identity, and released authority.
Only manager-attested private coordinates enable the reporter; the driver never fabricates agent reports.

Herdr server startup needs the account HOME.
Its XDG paths and configuration remain private.
A non-login `/bin/sh` avoids account shell startup files; remote update checks remain disabled.
Profile processes still use private HOME and DSH_HOME without copied credentials.

Herdr 0.9.1 refuses native `delete`, `pageup`, and `pagedown` key names.
Native editing and search scenarios use explicit custom bindings where necessary.
These bindings verify action effects, not delivery of unsupported default key names.

Without a managed caller, the report records `environment-not-run`, not a pass.
Inside a managed caller, a missing CLI or failed native assertion fails the free gate.
SIGINT and SIGTERM produce cancellation evidence and independent cleanup attempts for each owned resource.

## tmux transport

When tmux is installed, the free gate also runs `tools/dogfood-tmux.mjs`.
A private socket, minimal environment, empty config, and non-login shell exclude the operator's server and startup files.
Native keys prove Unicode editing and stash effects through current cells.
The runner verifies alternate-screen restoration, successful exit, and a usable shell.
Cleanup requires the manager-attested server process to exit before removing its stale private socket.
This proves tmux transport behavior, not physical keyboard delivery or OS clipboard acceptance.

## Paid live-model verification

Paid work requires explicit human demand.
Select one scenario to bound billed work.

```sh
pnpm dogfood:paid --list
./scripts/dogfood/run-tui-from-worktree.sh --no-launch
pnpm dogfood:paid --scenario live-reply --home <clone> --provider <provider> --model <model>
```

The clone must contain the chosen model adapter and its required credentials.
Before delegation or autonomous work, set the cloned catalog default to the approved model and effort.
Session-only `/model` selection does not constrain child-agent defaults.
For the non-Team `subagent` tool, set `agentOptions.provider`, `agentOptions.model`, and `agentOptions.reasoningEffort` in its cloned config.
Restate the existing provider, toolName, and backgroundMode because a config replacement does not merge fields.
The runner selects the route through `/model` and reads it back through `/status`.
Use `--effort max` when explicitly requested and advertised by the route.
The runner confirms model and effort before submitting a billed prompt.
It refuses paid execution without `--home`, `--provider`, `--model`, and `--scenario`.
It never reads a model route from an implicit default.
Paid runs also exclude inherited provider credentials, pane coordinates, and notification credentials.
Keep only the approved credential in the private home.
The runner uses the same minimal environment whitelist for free and paid processes.
Notification checks require a separate, explicitly requested development token and direct scratch-profile launch.

Demand-only scenarios cover replies, rich text, tools, PTC, conversation branching, clipboard transport, questions, approvals, queues, work, jobs, and delegations.
A model that cannot perform the requested tool workflow fails that scenario.
Question checks require the advertised `ask_user_question` tool, not only the question service.
The installed base provides that service but does not enable the opt-in question tool.
Mount the already-installed `@deepseek-ai/dsh-tool-ask-user` only in the private profile when required.
Approval checks use an approval-enabled private session and verify allow, reject, and cancel through actual file outcomes.
Assertions may inspect the runner-owned private parent, never unrelated paths.
If delegation uses Agent Teams, require explicit human authorization for Agent Teams before running that scenario.
Do not treat its final text as proof that a tool executed.
Durable file and transcript checks provide separate evidence where applicable.

`tools/pty-drive.mjs` starts with an empty prompt by default.
An explicit model prompt can incur charges; use it only for requested paid work.
Never point either driver at the live home.

Native attention and background checks require a separate explicit paid invocation:

```sh
node tools/dogfood-herdr.mjs --paid --scenario herdr-attention --home <clone> --provider zai --model glm-5.3-flash --effort max
```

This scenario verifies working state after the foreground settles, successful background file output, blocked question state, and released authority.
It uses the same private question-tool prerequisite and exact model/effort readback before billing.
Free native automation never selects this paid case.
Caller-owned cloned homes remain intact until the caller explicitly cleans them.

## Evidence and limits

`report.json` records runtime, transport outcomes, prerequisites, cleanup, and the feature-to-scenario matrix.
Each step records attempted input, stated postconditions, an artifact path, and observed cell changes.
`postconditions-satisfied` does not prove internal handler invocation or an unspecified keyboard action.
The matrix keeps portable, Herdr, and tmux results separate.
The runner saves current screens, raw terminal output, CLI output, and failure screens in a private temporary directory.
Free scratch homes are removed after each scenario.
Evidence remains available for review.
A 64 MiB terminal-output budget bounds memory; exceeding it fails the scenario.
Paid evidence can contain private conversation data; do not commit it or publish it.

Paid scenarios remain `paid-not-run` until requested.
Optional integrations and physical transports remain `environment-not-run` without their prerequisites.
The manual entries record those prerequisites and their actual-use procedures.
Use an explicitly requested development Herdr pane and development notification endpoint, never production state.

A passed scenario proves its stated postconditions, not every permutation in its feature group.
PTY evidence does not prove physical key delivery, clipboard acceptance, or hardware input-to-pixel latency.
Do not report 100% working scope while any required paid, environment, or behavioral evidence remains absent.

Release helper dogfood exercises its real help and invalid-action CLI paths without publication.
Authenticated read-only and approved release actions remain subject to [RELEASE.md](RELEASE.md).

## Checks requiring human prerequisites

Do not use a production session, clipboard, endpoint, or SSH target for these checks.

- Physical keyboard and clipboard: prepare a cloned profile on a dedicated test desktop.
  Exercise configured keys and copy a known reply; verify pasted text in a separate test application.
  Record the terminal, operating system, actions, and actual destination text.
- SSH: authorize a dedicated development host and its model-free profile first.
  Launch the linked profile through that real SSH connection; check Unicode, keys, resize, and restoration.
  Record client/server versions and current terminal evidence.
- Moshi: provide a separately authorized development endpoint and token.
  Configure only the scratch profile; trigger a real question and inspect its delivered notification.
  Revoke the development token after verification.
- Other Harness releases: name and authorize the exact release before changing the verification matrix.
  Install only in an isolated consumer environment and run real profile checks before marking it verified.

These checks remain unverified without the specified prerequisites.

## Change a feature

1. Update its inventory entry and source owners.
2. Update its actual-use scenarios and postconditions.
3. Run all free scenarios through `pnpm verify`.
4. Report paid or environment prerequisites that remain unverified.

Preserve golden suites and their required tooling.
Do not add unit suites.
