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
| `~/.dsh/settings.yaml` | Host settings. Plugin sections keyed by plugin id; used when a host writes config through the settings service instead of a patch. |
| `~/.dsh/profiles/<profile>/package.json` | Bundles and their dependency specs (`link:` for a checkout, a range for a release). |
| `node_modules/<bundle>/cordis.patch.yml` | The bundle's own defaults: disabled base rows, inserted rows, default config. |
| `node_modules/@earendil-works/pi-ai/dist/providers/data/<source>.json` | Installed per-provider catalog: ids, and the cost/context/effort data a template clone inherits. |

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
| Retire a model or a provider | drop it from the list, or disable the row that offers it |

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
          auth: { apiKeyRef: OPENAI_API_KEY }
          models:
            - id: gpt-6-sol
              name: GPT-6 Sol
              template: gpt-5.6-sol   # inherits wire behavior AND stale metadata
              metadata:               # override what the vendor documented
                contextWindow: 1050000
                cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
```

Rules the resolver enforces: `version` is exactly `1`; duplicate provider ids
are refused; an empty catalog requires `default: null`; `default` must resolve to
a declared provider/model; a `reasoningEffort` the model does not support fails
composition.

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

Per 1M tokens: `{ input, output, cacheRead, cacheWrite }`. `0` is right for a plan
that bills credits, wrong for a per-token route. A vendor that charges more above
an input threshold needs the tier row, otherwise long prompts are understated.

## 5. Verify before and after the edit

```sh
dsh --profile tui list-models                          # every reachable route, id<TAB>name
~/.agents/skills/dsh-tui-update-models/scripts/dump-model-catalog.mjs   # resolved cost/ctx/efforts
```

The dump marks each value `installed`, `template:<id>`, or `metadata`, so an
inherited number is visible instead of trusted. Then check the vendor's own page
for price, context window, max output, and accepted effort values - the installed
catalog lags vendors, and a template clone carries a sibling's numbers.

## 6. Pitfalls

| Symptom | Cause |
| --- | --- |
| A new model shows the sibling's price or ctx | it was cloned from a `template`; declare `metadata` |
| A window that is really a pricing threshold | vendors publish e.g. "above 272K input priced 2x" beside the real window |
| `off` missing on a reasoning model | `thinkingLevelMap.off` is `null` or absent where the vendor takes `none` |
| A stealth model with no vendor page | its numbers exist only in the routing catalog (pi.dev model page, models.dev) |
| Config ignored after an edit | a linked bundle loads `lib/`; run `pnpm run build` in that checkout |
| ctx gauge and auto-compact trigger early/late | the declared `contextWindow` is wrong, not the gauge |

Never put a key in a profile or a patch: name it (`apiKeyEnv`, `apiKeyRef`,
`credentialProvider`) and keep the value in the environment or `$DSH_HOME/.env`.
Test catalog edits in a cloned home - see the `dsh-tui-dogfood` skill.

Full field lists, credentials, and the vendor-verification checklist:
[references/model-wiring.md](references/model-wiring.md).
