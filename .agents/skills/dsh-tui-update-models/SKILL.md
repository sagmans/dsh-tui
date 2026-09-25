---
name: dsh-tui-update-models
description: "Use when providers, models, prices, context windows, or reasoning effort levels must be added, changed, subset, or removed in a dsh profile: the llm-pi-ai provider config, the dsh-provider-extra owned catalog, settings.yaml, and a profile's cordis.patch.yml."
---
# Update dsh providers and models

Every model the surface can pick comes from one of two owners, resolved at
composition time and read back by `/model`, `dsh --profile tui list-models`, and
the ctx gauge. Find the owner first; then edit exactly one place.

## 1. Find the owner

| Where the wiring is | What it owns |
| --- | --- |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | The patch layer: applied after every bundle layer, last entry wins. Holds the catalog or `llm-pi-ai` config a developer actually edits. |
| `~/.dsh/settings.yaml` | Host settings, hot-reloaded. A `llm-pi-ai:` or `llm-deepseek:` section overrides that adapter's patch entry without a restart - it is what the web Models page writes, and what an additive sign-in declares a route in. The legacy `dsh-provider-extra:` section carries `extraModels` and `codexExtraModels` only. **A catalog is never settings-owned**: managed mode installs no section, reads no overlay, and turns off settings projection for its own Config, so the profile patch is the only place a catalog exists. |
| `~/.dsh/profiles/<profile>/package.json` | Bundles and their dependency specs (`link:` for a checkout, a range for a release). |
| `node_modules/<bundle>/cordis.patch.yml` | The bundle's own defaults: disabled base rows, inserted rows, default config. |
| `node_modules/@earendil-works/pi-ai/dist/providers/data/<source>.json` | Installed per-provider catalog: ids, and the cost/context/effort data a template clone or a `filter` match inherits. |
| `node_modules/@sagmans/dsh-provider-extra/docs/catalog.md` | The catalog's own field list and rejection rules, matching the plugin build the profile resolves. Read it before inventing a field. |

Entry shapes in the patch layer:

```yaml
- id: llm-pi-ai                 # id-targeted config override
  config: { ... }               # replaces that row's config wholesale - restate every field
- { "id": "llm-deepseek", "disabled": true }   # retire a row a bundle ships
- insert:                       # add a row the profile does not have
    - id: web-search-exa
      name: '@deepseek-ai/dsh-web-search-exa'
```

A config in a patch **replaces** the base config; it never merges field by field.

## 2. Pick the approach

| Intent | Approach |
| --- | --- |
| Add or re-declare providers additively | `llm-pi-ai` config: `providers.<route>.models[]` |
| One new id that behaves like a catalog sibling | `extraModels: [{ id, template, name? }]` (clone the sibling's wire behavior) |
| Serve only some of a route's catalog | a `models:` whitelist of ids, in the order the picker should show |
| Own the whole model directory (gateways, subscriptions, logins) | `dsh-provider-extra` `catalog` v1, and disable the base rows |
| Serve most of an installed source, minus a few ids | catalog route `filter: { include?, exclude? }` - keeps every installed fact |
| Point a route at your own endpoint | catalog route with `api` + `baseURL` and no `source` |
| Retire a model or a provider | drop it from the list, or disable the row that offers it |

A catalog route declares **exactly one** of `models` and `filter`; `models: []`
is the explicit empty selection, and `filter` needs an installed `source`.

`dsh-provider-extra` catalog skeleton, with the two override layers a correct
entry needs as soon as a vendor number differs from the inherited one:

```yaml
- id: dsh-provider-extra
  config:
    catalog:
      version: 1
      default: { provider: opencode-go-session, model: deepseek-flash, reasoningEffort: max }
      providers:
        - id: openai
          name: OpenAI API
          source: openai              # pi-ai provider id; its data is the base
          auth: { apiKeyRef: OPENAI_API_KEY }   # omit auth for a keyless local route
          models:
            - id: gpt-6-sol
              name: GPT-6 Sol
              aliases: [gpt-6-sol-preview]  # extra selector inputs, never extra rows
              template: gpt-5.6-sol   # inherits wire behavior AND stale metadata
              defaultMaxTokens: 128000  # request cap, only when the request gives none
              metadata:               # override what the vendor documented
                contextWindow: 1050000
                cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
        - id: local-llm
          name: Local llama.cpp
          api: openai-completions     # own endpoint: api is required, source is absent
          baseURL: http://127.0.0.1:8080/v1
          models:
            - id: qwen3-coder
              name: Qwen3 Coder
              metadata:             # no installed sibling: every fact is declared
                reasoning: true
                input: [text]
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                contextWindow: 262144
                maxTokens: 65536
        - id: zai-all
          name: Z.AI Coding Plan
          source: zai
          auth: { apiKeyRef: ZAI_API_KEY }
          filter: { include: ['glm-*'], exclude: ['glm-4*'] }   # '*' is the only wildcard
```

Rules the resolver enforces, each rejecting the **whole** candidate: `version` is
exactly `1`; an unknown field anywhere; duplicate provider ids, model ids, or
aliases; a `source` no installed pi-ai provider ships; `api` beside `source`, or
absent when `source` is absent; `baseURL` absent, non-HTTP(S), or carrying
credentials; a `transport` on a route whose source is not `openai-codex`; a
`fallbackSessionId` on a route whose source is not `opencode-go`; `auth` naming
both modes, or `apiKeyRef` on `openai-codex`, or a `credentialProvider` that is
not the `source`; both or neither of `models`/`filter`; an unknown `template`; a
model with no resolvable template and incomplete `metadata`; a
`defaultMaxTokens` above the model's `maxTokens`; a `metadata.api` that changes a
template-backed protocol; an empty catalog whose `default` is not `null`; a
`default` outside the served selection; a `reasoningEffort` the model does not
support. Omitting `catalog` is not `providers: []`: the first keeps the plugin's
legacy additive routes, the second serves nothing.

Ownership is exclusive and checked at boot. Disable **every** competing row in
the whole profile - on `dsh-base` those are `llm-pi-ai`, `llm-deepseek`, and
`agent-default-model` - and mount provider-extra after them. A surviving adapter,
provider directory, or default owner logs `CATALOG_OWNER_COLLISION` and fails
listing, selection, dispatch, and sign-in closed until it is gone.

The pinned host reads only `provider` and `model` from `catalog.default`: it
ignores `reasoningEffort`, so effort is chosen in the session surface. Saving a
default needs the host's `configEditor`; a host without one rejects with
`CONFIG_PERSISTENCE_UNAVAILABLE`, and the profile patch stays the place to edit.

## 3. Reasoning efforts

pi-ai levels are `off, minimal, low, medium, high, xhigh, max`. In
`metadata.thinkingLevelMap`:

| Value | Meaning |
| --- | --- |
| `null` | level is not offered |
| absent | offered, sent to the vendor under this same name |
| a string | offered, sent as that vendor value (OpenAI's `none`, codex's `low` for `minimal`) |

`xhigh` and `max` are offered **only** when explicitly mapped. `off` means "send no
reasoning parameter" on the OpenAI and codex adapters. Vendors name the same
concept differently - map it, never rename the vendor value.

## 4. Costs

Per 1M tokens: `{ input, output, cacheRead, cacheWrite }`, plus optional
`tiers: [{ inputTokensAbove, input, output, cacheRead, cacheWrite }]`. `0` means
unknown pricing on a credit plan, not free inference. A vendor that charges more
above an input threshold needs its tier row, otherwise long prompts are
understated. `metadata.maxTokens` is model capacity and never a request cap;
`defaultMaxTokens` is the request default and must not exceed that capacity.

## 5. Verify before and after the edit

```sh
dsh --profile tui list-models        # every reachable route, id<TAB>name
# resolved cost/ctx/efforts, naming the layer each number came from:
~/.agents/skills/dsh-tui-update-models/scripts/dump-model-catalog.mjs \
  [--home "$DSH_HOME"] [--profile tui] [--data <pi-ai data dir>] [--json]
```

The dump marks each value `installed`, `template:<id>`, `route`, or `metadata`, so
an inherited number is visible instead of trusted, expands a `filter` route
against the installed data the same way the resolver does, and exits 1 on the
declarations the resolver refuses - incomplete metadata, a request default above
capacity, both membership styles, a default the served selection does not
contain.

Then check the vendor's own page for price, context window, max output, and
accepted effort values - the installed catalog lags vendors, and a template
clone carries a sibling's numbers.

To prove a catalog on a disposable home instead of the live one, provider-extra
ships a clone-only setup that composes the candidate and disables the competing
rows for you:

```sh
cd <dsh-provider-extra checkout> && pnpm catalog:setup \
  --helper ~/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh \
  --source-home ~/.dsh --home /tmp/dsh-catalog-check --profile tui \
  --catalog /tmp/catalog-config.json [--allow-row ROW_ID] [--dsh /abs/path/to/dsh/lib/bin.js]
```

`--catalog` is a private JSON file holding only `{"catalog": {...}}`. Success
means `composition-verified`, not authenticated runtime; launch only the clone
command it prints.

## 6. Pitfalls

| Symptom | Cause |
| --- | --- |
| A new model shows the sibling's price or ctx | it was cloned from a `template`; declare `metadata` |
| A window that is really a pricing threshold | vendors publish e.g. "above 272K input priced 2x" beside the real window |
| `off` missing on a reasoning model | `thinkingLevelMap.off` is `null` or absent where the vendor takes `none` |
| A stealth model with no vendor page | its numbers exist only in the routing catalog (pi.dev model page, models.dev) |
| Config ignored after an edit | a linked bundle loads `lib/` or `dist/`; run the build in that checkout |
| ctx gauge and auto-compact trigger early/late | the declared `contextWindow` is wrong, not the gauge |
| Same model id, two context windows | each route inherits its own source's numbers; declare `metadata` on both |
| Everything fails closed, logs `CATALOG_OWNER_COLLISION` | a competing adapter, provider directory, or default owner row survived |
| A new field looks accepted but does nothing | the resolver rejects unknown fields; a stale plugin build silently predates it |
| `/model` saves a default that reverts | the host has no `configEditor`: `CONFIG_PERSISTENCE_UNAVAILABLE`; edit the patch |
| Route serves nothing after a `filter` edit | patterns match installed ids only, and `exclude` wins over `include` |

Never put a key in a profile or a patch: name it (`apiKeyEnv`, `apiKeyRef`,
`credentialProvider`) and keep the value in the environment or `$DSH_HOME/.env`.
Test catalog edits in a cloned home - see the `dsh-tui-dogfood` skill.

Full field lists, credentials, and the vendor-verification checklist:
[references/model-wiring.md](references/model-wiring.md).
