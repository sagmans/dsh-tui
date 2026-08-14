<!-- Generated from docs/parity.json. Edit the manifest, then update this file. -->

# Web–TUI capability parity

Target: DeepSeek Harness Web `0.1.0-rc.6`. Capability parity, not layout parity.

Web profile roster and shared runtime contracts are authoritative. Every non-Web-only action requires keyboard and mouse reachability plus automated and real-user proof.

Keyboard paths, mouse paths, source evidence, automated proof, dogfood proof, and gap notes live in `docs/parity.json`.

## Implemented

_None._

## Capability matrix

| Capability | Disposition | Status | Owner |
| --- | --- | --- | --- |
| `profile.shared-host-runtime` — Shared Harness host and client runtime | parity | partial | cordis.patch.yml; src/client/context.ts |
| `runtime.browser-surface` — React client halves, browser server, transport, modules, client runner, and HMR | web-only | excluded | Excluded by cordis.patch.yml surface policy |
| `conversation.feedback` — Per-message useful/not-useful feedback and note lifecycle | parity | partial | src/features/operations; src/views/operations/root.ts |
| `conversation.export` — Session and descendant log export | terminal-alternative | partial | src/features/export; src/views/conversation |
| `conversation.statistics` — Whole-log turn, step, token, tool, timing, and context statistics | parity | partial | src/features/conversation; src/views/conversation/information.ts |
| `workspace.directory-selection` — Workspace directory selection | terminal-alternative | partial | src/features/sessions; src/views/sessions/root.ts |
| `settings.plugin-inventory` — Installed plugin inventory and extension lifecycle | parity | partial | src/features/settings; src/views/settings/root.ts |
| `theme.terminal` — Light, dark, and system theme preference | parity | missing | planned: src/services/theme.ts; src/features/settings |
| `locale.chrome` — English and Chinese application locale | parity | missing | planned: src/services/locale.ts; src/locales; src/views |
| `shell.navigation` — Full-screen shell, navigation, sidebar outcomes, and route access | parity | partial | src/features/shell; src/views/shell |
| `settings.general` — General settings shell and persisted preferences | parity | partial | src/features/settings; src/views/settings/root.ts |
| `settings.providers-models` — Provider credentials, endpoints, protocols, model catalog, and discovery | parity | partial | src/features/settings; src/views/catalog/root.ts |
| `settings.plugin-configuration` — Field-level plugin configuration | parity | partial | src/features/settings; src/views/settings/root.ts |
| `conversation.core` — Messages, reasoning, streaming, history, retry, cancellation, and composer | parity | partial | src/features/conversation; src/client/conversation; src/views/conversation |
| `tools.inspection` — Generic, specialized, nested Code Mode, and Web tool inspection | parity | partial | src/features/tools; src/views/tools/root.ts |
| `workflow.runs` — Workflow lifecycle, durable run nodes, workers, and Ralph controls | parity | partial | src/features/operations; src/client/conversation/workflows.ts |
| `deliverables.files` — Produced-file discovery, turn tails, inert mentions, and safe opening | terminal-alternative | partial | src/features/deliverables; src/views/conversation; src/views/tools |
| `workspace.sessions` — Workspace/session CRUD, grouping, sorting, unread state, search, and reorder | parity | partial | src/features/sessions; src/views/sessions/root.ts |
| `input.trigger-pipeline` — Slash and at-sign trigger arbitration, menu, popup, and references | parity | partial | src/features/input-trigger; src/views/input-trigger/root.ts; src/features/conversation |
| `commands.slash` — Slash command catalog and exact-match execution | parity | partial | src/client/conversation/commands.ts; src/features/input-trigger |
| `skills.references` — Skill catalog, loading, command trigger, and prompt reference | parity | partial | src/client/conversation/commands.ts; src/features/input-trigger |
| `subagents.lifecycle` — Recursive subagent hierarchy, activity, timing, usage, opening, and references | parity | partial | src/features/operations; src/views/conversation; src/features/input-trigger |
| `jobs.background` — Background job status and lifecycle controls | parity | partial | src/features/operations; src/views/operations/root.ts |
| `goals.session` — Session goal display and lifecycle | parity | partial | src/features/operations; src/views/catalog/root.ts |
| `model.selection` — Session model/reasoning choice, composer seat, /model, and unroutable blocking | parity | partial | src/features/model-selection; src/views/model-selection/root.ts |
| `permissions.presets` — Current-session access and future-session default permission | parity | partial | src/features/settings; src/views/conversation/composer.ts |
| `agent.presets` — Per-session agent preset composition, defaults, staging, and management | parity | partial | cordis.patch.yml; src/features/settings; src/views/conversation/composer.ts |
| `plans.session` — Plan state, composer control, review, and command lifecycle | parity | partial | src/features/operations; src/features/interactions; src/features/conversation |
| `conversation.compaction` — Context meter, compaction command, and tool-result pruning detail | parity | partial | src/features/conversation; src/views/conversation/information.ts |
| `todos.session` — Session todo state and model-facing todo capability | parity | partial | src/features/conversation; src/views/conversation/information.ts |
| `interactions.questions` — Questions, options, custom answers, recommendations, and approvals | parity | partial | src/features/interactions; src/views/interactions/root.ts |
| `trajectory.ledger` — Turn/step ledger, search, folding, totals, details, timing, and pagination | parity | partial | planned: src/features/trajectory; src/views/trajectory/root.ts |
| `attachments.images` — Image attachment admission, removal, metadata, and history access | terminal-alternative | partial | src/features/attachments; src/features/conversation/media.ts; src/views/conversation |
| `browser.rich-content` — Raw HTML/SVG interpretation and rich browser card markup | web-only | excluded | Excluded by terminal sanitization policy |
| `browser.url-navigation` — Arbitrary browser URL navigation | web-only | excluded | Excluded by terminal external-open policy |
| `browser.layout-geometry` — DOM/CSS geometry, responsive placement, hover, and drag gestures | web-only | excluded | Excluded; terminal layout remains OpenTUI-native |
| `notifications.status` — Completion, attention, and error notifications | terminal-alternative | partial | src/views/shell/status.ts; feature status/error rows |

## Terminal alternative

| Capability | Disposition | Status | Owner |
| --- | --- | --- | --- |
| `conversation.export` — Session and descendant log export | terminal-alternative | partial | src/features/export; src/views/conversation |
| `workspace.directory-selection` — Workspace directory selection | terminal-alternative | partial | src/features/sessions; src/views/sessions/root.ts |
| `deliverables.files` — Produced-file discovery, turn tails, inert mentions, and safe opening | terminal-alternative | partial | src/features/deliverables; src/views/conversation; src/views/tools |
| `attachments.images` — Image attachment admission, removal, metadata, and history access | terminal-alternative | partial | src/features/attachments; src/features/conversation/media.ts; src/views/conversation |
| `notifications.status` — Completion, attention, and error notifications | terminal-alternative | partial | src/views/shell/status.ts; feature status/error rows |

## Web-only exclusion

| Capability | Disposition | Status | Owner |
| --- | --- | --- | --- |
| `runtime.browser-surface` — React client halves, browser server, transport, modules, client runner, and HMR | web-only | excluded | Excluded by cordis.patch.yml surface policy |
| `browser.rich-content` — Raw HTML/SVG interpretation and rich browser card markup | web-only | excluded | Excluded by terminal sanitization policy |
| `browser.url-navigation` — Arbitrary browser URL navigation | web-only | excluded | Excluded by terminal external-open policy |
| `browser.layout-geometry` — DOM/CSS geometry, responsive placement, hover, and drag gestures | web-only | excluded | Excluded; terminal layout remains OpenTUI-native |

## Source of truth

- `deepseek-harness/packages/bundle/web-app/cordis.patch.yml`
- `deepseek-harness/packages/bundle/base/cordis.patch.yml`
- `deepseek-harness/packages/client/ui-*/README.md`
- `deepseek-harness/packages/client/runtime/src/client/contract/session.ts`
