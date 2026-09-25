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
5. `$DSH_HOME/settings.yaml` sits over the adapter rows, not over a catalog. A
   `llm-pi-ai:` or `llm-deepseek:` section reshapes that adapter per request; a
   `dsh-provider-extra:` section reshapes only the legacy routes'
   `extraModels`/`codexExtraModels`, and only where no `models`/`codexModels`
   selection is declared. A managed catalog reads no settings overlay at all, so
   a catalog edit lands in the profile patch or nowhere.

Exclusive ownership is a set of disable rows plus the catalog itself:

```yaml
- { "id": "agent-default-model", "disabled": true }
- { "id": "llm-pi-ai", "disabled": true }
- { "id": "llm-deepseek", "disabled": true }
- id: dsh-provider-extra
  config: { catalog: { version: 1, ... } }
```

Disable every competing row in the **whole** profile, not only the rows that come
before provider-extra: on `dsh-base` those are `llm-pi-ai`, `llm-deepseek`, and
`agent-default-model`, and another bundle may add `llm-openai` or
`llm-anthropic`. Inspect the composed profile rather than trusting this list.
Preflight refuses to register managed routes when an adapter, a provider
directory, or a default owner already exists; a later registration is caught by
the host's `llm/adapters-updated` notification. Either way the plugin logs
`CATALOG_OWNER_COLLISION` once per transition and fails closed: listing,
selection resolution, request preparation, default reads and saves, new
dispatch, and starting a sign-in all refuse while the conflict exists. Requests
already past their credential gates finish. Removing the competing rows restores
service without a reload of the catalog itself.

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

Route fields (`providers` is a dict keyed by the route id; the key is the route):
`apiKeyEnv`, `displayName`, `api`, `baseURL`, `models`, `modelOverrides` (per-id
reshaping of an installed catalog, refused beside a `models` list), `compat`,
`defaultContextWindow` (262144), `defaultMaxTokens` (32768), `defaultInput`
(`[text]`), `headers`, `reasoning`, `thinkingBudgets`, `cacheRetention`,
`transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `streamIdleTimeoutMs`,
`maxRequestImageBytes`, `requestImagePixelBudget`, `requestImageMaxBytes`,
`retryPolicy`. A route key that names an installed pi-ai provider inherits that
provider's endpoint, protocol, display name, and catalog; any other key is a
complete hand declaration and must name `api` and `baseURL`.

`reasoningEfforts` is this adapter's spelling of `thinkingLevelMap`: a dict of
selectable level to the wire value dispatch sends, `false` for a non-reasoning
model, and only `off` may carry an empty or null value. An empty dict, a level
mapping to an empty string, or a dict offering nothing beyond `off` is refused.

## `dsh-provider-extra`

Two config generations exist; a profile normally uses one, and presence of
`catalog` is what opts a profile into managed ownership:

| Config | Use |
| --- | --- |
| Additive: `apiKeyEnv`, `routeId`, `displayName`, `baseURL`, `headers`, `fallbackSessionId`, `models`, `extraModels`, `codexEnabled`, `codexRouteId`, `codexDisplayName`, `codexModels`, `codexExtraModels`, `codexTransport`, `loginCommandEnabled`, `loginCommandName` | add a gateway or subscription route beside whatever else the profile serves |
| `catalog` v1 | own the entire directory: routes, ids, aliases, metadata, and the default selection |

The generations differ where a declaration cannot resolve. An additive
`extraModels` entry with a bad `template` lands in that route's model
diagnostics while the route keeps serving; an additive `models`/`codexModels`
whitelist naming an id nothing provides refuses the whole route. A **catalog**
rejects the whole candidate instead: there is no per-model diagnostic path.

Catalog route fields (an unknown field rejects the candidate):

```yaml
catalog:
  version: 1                      # exactly 1
  default:                        # null only when nothing is served
    { provider: opencode-go-session, model: deepseek-flash, reasoningEffort: max }
  providers:
    - id: opencode-go-session     # the id every selection and alias check uses
      name: OpenCode Go (session)
      source: opencode-go         # installed pi-ai provider id; its data is the base
      api: openai-completions     # own endpoint only: required without source, refused beside it
      baseURL: https://api.x.ai/v1            # required without source; http(s), no user/pass/fragment
      headers: { X-Route: tenant-a }          # static headers; secrets stay in a credential reference
      transport: sse                          # openai-codex only: sse|websocket|websocket-cached|auto
      fallbackSessionId: dsh-provider-extra   # opencode-go only: session header for sessionless calls
      auth: { apiKeyRef: OPENCODE_GO_API_KEY }        # or { credentialProvider: openai-codex }; absent = keyless route
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
          aliases: [deepseek-v4.1-flash]      # extra selector inputs, unique in the route, never extra rows
          template: deepseek-v4-flash         # installed sibling of the SAME source to clone
          defaultMaxTokens: 384000            # request default; must be <= resolved maxTokens
          metadata:
            api: openai-completions
            reasoning: true
            input: [text, image]
            cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 }
            # a threshold-priced vendor adds its tier rows beside those four rates:
            # cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0,
            #         tiers: [{ inputTokensAbove: 272000, input: 0.44, output: 1.32,
            #                   cacheRead: 0.014, cacheWrite: 0 }] }
            contextWindow: 1000000
            maxTokens: 384000                 # capacity, never a request cap
            thinkingLevelMap: { off: null, minimal: null, low: low, medium: null, high: high, xhigh: null, max: max }
            headers: { X-Model: flash }
            compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, supportsStrictMode: true, thinkingFormat: qwen }
    - id: zai-catalog
      name: Z.AI Coding Plan
      source: zai
      auth: { apiKeyRef: ZAI_API_KEY }
      filter: { include: ['glm-*'], exclude: ['glm-4*'] }   # instead of models; '*' is the only wildcard
```

`filter` needs an installed `source`: an absent `include` starts from every
installed model, matches keep installed order and every installed fact (id, name,
cost, capacity, protocol, endpoint), and the route serves them minus `exclude`.
A matched model that publishes no endpoint needs a route `baseURL`.

A model with no resolvable template must declare all of `api` (unless the route
declares `api`), `reasoning`, `input`, `cost`, `contextWindow`, and
`maxTokens`. `metadata.api` cannot change a template-backed protocol, must equal
a route's declared `api`, and must be an api the `source` describes.

`compat` accepts only the flags the model's protocol honors: completions takes the
`supports*`/`requires*` booleans plus `maxTokensField`, `thinkingFormat`,
`thinkingTokenBudgetField`, `cacheControlFormat`, `deferredToolsMode`, and
`sessionAffinityFormat`; responses takes its own flag set plus
`sessionAffinityFormat`; anthropic-messages takes its flag set and no enums.
Template-language and gateway-routing keys (`chatTemplateKwargs`,
`chatTemplateArgs`, `openRouterRouting`, `vercelGatewayRouting`,
`vllmPriority`, `allowedFallbackModels`) are refused. The plugin's own
`src/catalog-routes.ts` lists the accepted names per protocol.

Behaviour:

| Case | Result |
| --- | --- |
| `template` names a sibling the source ships | clone its wire behavior and metadata |
| `template` names nothing, or the route has no source | candidate rejected: `unknown template <id>` |
| unknown id, no template, incomplete metadata | candidate rejected: `unknown model requires complete metadata: missing <field>` |
| both `models` and `filter`, or neither | candidate rejected: `declare exactly one of models or filter` |
| duplicate provider id, model id, or alias | candidate rejected |
| `defaultMaxTokens` above the resolved `maxTokens` | candidate rejected: `exceeds model maxTokens` |
| `default` names a model outside the served selection | candidate rejected; an alias is canonicalized to its wire id |
| `reasoningEffort` unsupported by the model | candidate rejected |
| nothing served (empty providers, or `models: []`) | `default` must be `null`; `currentSelection()` throws `NO_DEFAULT_MODEL` |

### Default persistence

`catalog.default` reaches a new session as provider and model only: the pinned
host ignores its `reasoningEffort`, so effort is chosen in the surface.
`saveSelection(next)` validates first, then writes through the host's
`configEditor.edit(entry, updater)` so only `catalog.default` changes and
membership is re-checked inside the editor's lock. A host with no addressable
entry or no such editor rejects with `CONFIG_PERSISTENCE_UNAVAILABLE` - the
released `0.1.5-rc.2` host does - and nothing falls back to legacy
`agent-default-model` settings. Edit the profile patch there.

`compileCatalog(config)` and `buildCatalogProfile(provider)` are public: the
first returns a detached frozen snapshot or `undefined` for absence, the second
validates one route declaration on its own. Both are what the dump script and a
candidate check should read against.

## Where the base data comes from

```sh
# the harness install owns the pi-ai catalog the profile resolves against
DSH=$(readlink -f "$(command -v dsh)")
PI_AI="${DSH%/lib/bin.js}/node_modules/@earendil-works/pi-ai"
ls "$PI_AI/dist/providers/data"      # one JSON per provider source, keyed by api
```

`source` must be an id the installed pi-ai build ships (`builtinProviders()`);
`ls` the data directory for the list this harness answers. A JSON entry is the
whole truth for a `source`: `id`, `name`, `cost`, `contextWindow`,
`maxTokens`, `input`, `reasoning`, `thinkingLevelMap`, `compat`, `baseUrl`.
A model declared without `template` and without `metadata` is served exactly as
this file describes it, so an id the vendor renamed or repriced shows stale
numbers until the catalog declares them. An entry that carries its own complete
`metadata` needs no installed entry at all, which is how a route the harness does
not describe is wired.

## Credentials

| Field | Meaning |
| --- | --- |
| `apiKeyEnv` | additive config and `llm-pi-ai`: read the key from this environment variable |
| `apiKeyRef` | catalog: a host credential reference; without a credential service the route reads that environment variable. Refused on an `openai-codex` source, which needs OAuth |
| `credentialProvider` | catalog: use a login flow's stored grant. Needs an installed `source` and must equal that source id |
| no `auth` | catalog: the route carries no key of its own, as a local endpoint does |

Keys never belong in a patch, a settings file, or a repository. Put launch-time
values in `$DSH_HOME/.env` or the environment. A provider row whose credential is
missing fails its route only; other routes still serve.

## Verify

```sh
dsh --profile tui list-models        # provider/model<TAB>display name, one per reachable route
~/.agents/skills/dsh-tui-update-models/scripts/dump-model-catalog.mjs \
  [--home "$DSH_HOME"] [--profile tui] [--data <pi-ai data dir>] [--json]
```

The dump reads the catalog row written as a single JSON flow map
(`- {"id":"dsh-provider-extra","config":{"catalog":…}}`), which is the shape
`pnpm catalog:setup` appends and the shape a hand-written patch keeps when one
line must stay machine-readable. A catalog spread over block YAML is invisible to
it; `list-models` still reads the composed result either way. `--data` points the
dump at a provider-data directory instead of the installed harness, which is how
a template clone or a `filter` route is read on a machine with no `dsh`. The dump
also reports what the resolver would refuse, and exits 1, because a catalog that
cannot compose serves nothing: incomplete metadata for an unknown model, a
`defaultMaxTokens` above capacity, both or neither of `models`/`filter`, a
default the served selection does not contain, an effort the selected model does
not offer, and a default that is null while models are served.

To validate a candidate on a disposable home, provider-extra's clone-only setup
composes it and disables the competing rows itself:

```sh
cd <dsh-provider-extra checkout> && pnpm catalog:setup \
  --helper <plugin checkout>/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh \
  --source-home ~/.dsh --home /tmp/dsh-catalog-check --profile tui \
  --catalog /tmp/catalog-config.json [--allow-row ROW_ID] [--dsh /abs/path/to/dsh/lib/bin.js]
```

`--catalog` is a private JSON file holding only `{"catalog": {...}}`. It prints
`composition-verified` on success, which is composition only: not runtime
ownership, not authentication. `--allow-row` asserts a provider-looking row
registers no provider and no default owner, because setup cannot see row
provenance and refuses rather than guesses.

`list-models` exits zero only after printing a line, so a deployment that
advertises nothing cannot pass for one that was enumerated.

For every model you touched, confirm against the vendor's own page:

1. price per 1M tokens for input, output, cached input, cache write;
2. context window and maximum output tokens (a "272K" beside "above 272K input
   is priced 2x" is a billing threshold, not the window);
3. the accepted reasoning effort values, and how the vendor spells "no reasoning"
   (OpenAI: `none`; codex: omit the parameter);
4. whether the route bills per token at all - a metered API wants its published
   rates, and a credit or token plan writes `0`, which reads as unknown pricing
   rather than free inference;
5. that an `xhigh` or `max` mapping exists when the vendor documents one;
6. that the same model id served on two routes carries the same facts: each route
   inherits its own `source` entry, so one declared `contextWindow` and one
   inherited is two different ctx gauges for one model.

A model with no vendor page (stealth releases, previews) is documented only by the
routing catalog: its pi.dev model page and `models.dev/api.json`.

Then run the profile against a cloned home before the real one - see the
`dsh-tui-dogfood` skill - and `pnpm run build` any linked bundle first: a linked
profile loads `lib/`, not `src/`.
