# Renderer parity

TUI reuses Harness Host services and shared client runtime. It never loads browser bundles. Each Web renderer capability has one explicit disposition.

## Implemented

| Web capability | TUI behavior |
| --- | --- |
| Layout, sidebar, workspaces, sessions | Full-screen routes, workspace/session tree, search, create, rename, fork, archive, close, reorder, keyboard and mouse navigation. |
| `@deepseek-ai/dsh-client-ui-conversation` | Durable and streaming messages, reasoning, commands, tool lifecycle, queues, history paging, cancellation, slash completion, queue, and steer. |
| `@deepseek-ai/dsh-client-ui-tool` and `@deepseek-ai/dsh-client-ui-cordis` | Sanitized generic, terminal, diff, read, search, Web, and nested Code Mode inspector views. |
| `@deepseek-ai/dsh-client-ui-workflow-run`, jobs, subagents, goals, plans, trajectory | Operations overlay exposes the shared runtime projections and authorized actions. |
| Permissions and `@deepseek-ai/dsh-client-ui-user-questions` | Fail-closed approval, question, and plan-review overlays with keyboard and mouse controls. |
| Model, permission preset, agent preset, settings, credentials, plugin inventory | Redacted configuration routes with confirmation for destructive or full-access changes. |
| Commands, skills, and subagent input references | Slash completion uses Host command and skill catalogs; shared Harness commands remain executable. |
| Message feedback | Versioned Host feedback editor is available in Operations. |
| Theme | Native terminal palette and color-disable support replace browser CSS theming. |

## Terminal alternative

| Web capability | TUI behavior |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-attachment` | `Ctrl+O` or `ATTACH` accepts an explicit absolute PNG, JPEG, WebP, or GIF path. Bounded bytes enter the shared prompt contract; only safe name, MIME type, dimensions when supplied by Host history, and size metadata render. No path or base64 enters render state. |
| `@deepseek-ai/dsh-client-ui-deliverables` | Successful Host-projected edit locations appear as inert produced-file paths. `o` or mouse activation requires the same path twice before calling the Host external-open boundary. Failed calls produce no open target. |
| `@deepseek-ai/dsh-session-log-export` | `Ctrl+E` or `EXPORT` streams the current session and descendants from Host to an explicit absolute destination. Creation is exclusive, mode `0600`, and failed partial files are removed. Browser download routes are bypassed. |
| `@deepseek-ai/dsh-host-directory-picker` | Workspace registration accepts an explicit typed path. This deterministic terminal path avoids browser picker and display-server dependencies. |
| `@deepseek-ai/dsh-client-locale` | TUI chrome is English. User, model, workspace, and tool Unicode remains intact across CJK, emoji, combining marks, and RTL scripts; terminal-control and bidi-formatting controls are stripped. |
| Browser notifications | In-app status and error rows replace system notifications; no background notification permission exists. |
| Image preview | Text metadata replaces lightbox thumbnails and image decoding. |

## Web-only exclusion

| Web capability | Reason |
| --- | --- |
| React client halves | Loader inventory marks packages with browser faces unsupported. TUI never fetches, evaluates, or mounts React client halves. |
| Browser server, transport, modules, client runner, and HMR | In-process API, RPC, shared runtime, and OpenTUI own the terminal surface. No HTTP listener is required. |
| Drag/drop, clipboard image upload, lightbox, and browser download dialog | Explicit local-path attachment and export flows provide bounded terminal equivalents. |
| Rendered HTML/SVG and rich card markup | Content remains sanitized inert text. HTML/SVG is never interpreted. Only a Host-derived produced path can cross the double-confirmed external-open boundary. |
| Browser locale preference and live locale switching | TUI chrome remains stable English; terminal content still preserves safe Unicode. |
| Browser URL navigation | URLs remain selectable inert text. TUI does not launch arbitrary links. |
| System notifications | Terminal status remains visible and auditable inside the application. |
