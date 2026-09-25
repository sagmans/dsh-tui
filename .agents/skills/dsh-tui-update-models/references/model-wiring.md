# Model wiring reference

Companion to [SKILL.md](../SKILL.md): exact fields, files, and checks.

## Resolution order

1. Bundle layers in `cordis.yml`, in order.
2. The profile patch `~/.dsh/profiles/<profile>/cordis.patch.yml`, entry by entry:
   `id` targeted config, `disabled`, `insert`.
3. A patch `config` **replaces** that row's base config; fields it omits fall back
   to the schema default, not to the bundle's value.
4. The model directory a profile sees is owned by whichever row is enabled:
   `llm-pi-ai` (additive provider config), `dsh-provider-extra` (owned catalog),
   or both, if the profile is not using exclusive ownership.

Exclusive ownership is a set of disable rows plus the catalog itself:

```yaml
- { "id": "agent-default-model", "disabled": true }
- { "id": "llm-pi-ai", "disabled": true }
- { "id": "llm-deepseek", "disabled": true }
- id: dsh-provider-extra
  config: { catalog: { version: 1, ... } }
```

## `llm-pi-ai` provider config

```yaml
- id: llm-pi-ai
  config:
    providers:
      qwen-token-plan:
        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY   # env var holding the key
        baseURL: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
        api: openai-completions              # optional wire override
        models:
          - id: qwen3.8-max                  # served as-is
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts: { low: low, high: high, max: max }
            compat:
              supportsStore: false
              supportsDeveloperRole: false
              supportsReasoningEffort: true
              supportsStrictMode: true
              thinkingFormat: qwen
```

An id that the installed catalog already describes needs no restatement. An id it
does not describe needs the metadata (or a `template` sibling to clone).

## `dsh-provider-extra`

Two config generations exist; a profile normally uses one:

| Config | Use |
| --- | --- |
| Additive: `routeId`, `displayName`, `apiKeyEnv`, `fallbackSessionId`, `extraModels`, `models`, `codexExtraModels`, `codexModels`, `codexTransport` | add a gateway or subscription route beside whatever else the profile serves |
| `catalog` v1 | own the entire directory: ids, aliases, metadata, and the default selection |

Catalog fields:

```yaml
catalog:
  version: 1                      # exactly 1
  default:                        # null only when the catalog is empty
    { provider: opencode-go-session, model: deepseek-flash, reasoningEffort: max }
  providers:
    - id: opencode-go-session     # the id every selection and alias check uses
      name: OpenCode Go (session)
      source: opencode-go         # pi-ai provider id: its installed data is the base
      baseURL: https://api.x.ai/v1            # optional
      transport: sse                          # optional
      fallbackSessionId: dsh-provider-extra   # optional
      auth: { apiKeyRef: OPENCODE_GO_API_KEY }        # or { credentialProvider: openai-codex }
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
          aliases: [deepseek-v4.1-flash]      # extra ids that resolve to this model
          template: deepseek-v4-flash         # clone wire behavior when the source lacks the id
          defaultMaxTokens: 384000            # request ceiling; metadata.maxTokens overrides
          metadata:
            api: openai-completions
            reasoning: true
            input: [text, image]
            cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 }
            contextWindow: 1000000
            maxTokens: 384000
            thinkingLevelMap: { off: null, minimal: null, low: low, medium: null, high: high, xhigh: null, max: max }
            compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, supportsStrictMode: true, thinkingFormat: qwen }
```

Behaviour:

| Case | Result |
| --- | --- |
| `template` names a sibling the source ships | clone its wire behavior and metadata |
| `template` names nothing | that model lands in the route's diagnostics; the rest of the route still serves |
| a `models` whitelist names an id nothing provides | the whole route is refused - a typo there is a broken deployment |
| two providers share an id | composition error |
| `default` names a model outside the catalog | composition error |
| `reasoningEffort` unsupported by the model | composition error |

## Where the base data comes from

```sh
# the harness install owns the pi-ai catalog the profile resolves against
DSH=$(readlink -f "$(command -v dsh)")
PI_AI="${DSH%/lib/bin.js}/node_modules/@earendil-works/pi-ai"
ls "$PI_AI/dist/providers/data"      # one JSON per provider source, keyed by api
```

A JSON entry is the whole truth for a `source`: `id`, `name`, `cost`,
`contextWindow`, `maxTokens`, `input`, `reasoning`, `thinkingLevelMap`, `compat`.
A model declared without `template` and without `metadata` is served exactly as
this file describes it, so an id the vendor renamed or repriced shows stale
numbers until the catalog declares them.

## Credentials

| Field | Meaning |
| --- | --- |
| `apiKeyEnv` | read the key from this environment variable |
| `apiKeyRef` | read it from the profiles' stored credentials under this reference |
| `credentialProvider` | use a login flow's stored credentials (codex subscriptions) |

Keys never belong in a patch, a settings file, or a repository. Put launch-time
values in `$DSH_HOME/.env` or the environment. A provider row whose credential is
missing fails its route only; other routes still serve.

## Verify

```sh
dsh --profile tui list-models        # provider/model<TAB>display name, one per reachable route
~/.agents/skills/dsh-tui-update-models/scripts/dump-model-catalog.mjs --home "$DSH_HOME"
```

`list-models` exits zero only after printing a line, so a deployment that
advertises nothing cannot pass for one that was enumerated.

For every model you touched, confirm against the vendor's own page:

1. price per 1M tokens for input, output, cached input, cache write;
2. context window and maximum output tokens (a "272K" beside "above 272K input
   is priced 2x" is a billing threshold, not the window);
3. the accepted reasoning effort values, and how the vendor spells "no reasoning"
   (OpenAI: `none`; codex: omit the parameter);
4. whether the route bills per token at all - a credit or token plan wants cost
   `0`, a metered API wants its published rates;
5. that an `xhigh` or `max` mapping exists when the vendor documents one.

A model with no vendor page (stealth releases, previews) is documented only by the
routing catalog: its pi.dev model page and `models.dev/api.json`.

Then run the profile against a cloned home before the real one - see the
`dsh-tui-dogfood` skill - and `pnpm run build` any linked bundle first: a linked
profile loads `lib/`, not `src/`.
