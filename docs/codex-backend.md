# Codex backend

Set `agents.<name>.backend: codex` and bind its `llm` to a model entry.
Codex owns authentication through the CLI account; omit the LLM's API block.
See [agent configuration](agent-configuration.md).

> Docker commands in this guide require a full source checkout. Prebuilt
> release packages omit Compose files; see the
> [Docker Compose deployment guide](docker-compose-deployment.md).

## Install and authenticate

Install a Codex CLI version supported by your deployment using the
[official installation instructions](https://developers.openai.com/codex/cli),
then sign in using the authentication method available in your environment:

```sh
codex login
```

The CLI owns its authentication files under `CODEX_HOME` (by default,
`~/.codex`). Keep that directory private and persistent. Disclaude does not
copy its credentials into the Disclaude configuration or workspace.

For Docker, the service image includes the Codex CLI and the Compose deployment
persists `CODEX_HOME` in its `codex_data` volume. A first-time device login can
be started with:

```sh
docker compose run --rm service codex login --device-auth
```

## Configure

```yaml
agents:
  daily:
    backend: codex
    llm: daily
    default: true
    codex:
      transport: app-server
      maxConcurrentRuns: 2
llms:
  daily:
    defaultModel: your-codex-model
    reasoningEffort: your-supported-effort
    maxConcurrentSessions: 3
```

`llms.daily.defaultModel` is optional — omit it and Codex keeps its own model
selection. When set, it must pass validation before
`CODEX_MODEL` may explicitly override the default Codex binding; named non-default
bindings retain their own models. The override cannot fill a missing declaration.
Model reasoning and session concurrency
follow the bound LLM. Agents sharing its name share its session budget. At the
limit, new sessions are rejected without stopping existing work. Transport and
execution permissions follow the selected agent; `maxConcurrentRuns` is the
startup process-wide child limit. See [agent configuration](agent-configuration.md).

Disclaude does not define a fixed default model. Concrete model and effort
recommendations are kept in the [configuration sample](../disclaude.config.example.yaml).
Choose a model available to the signed-in Codex account; explicit identifiers
are passed unchanged to Codex, which validates their availability. If no
Disclaude configuration, selected preset, or environment value resolves a
model, Codex uses the model from `CODEX_HOME` or its built-in default.

The precedence for a run is a selected per-chat/per-turn model, then a
per-query `CODEX_MODEL`, the process `CODEX_MODEL`, the resolved configuration
setting, and finally the Codex CLI default. Avoid setting the same model in
several places; use the resolved run log to see the effective model and source.

The bound `llms.<name>` picks the LLM access method with `via` (Issue #5338).
`via: chatgpt` — the default for an `api`-less entry — rides the CLI's own
ChatGPT login and subscription quota; declaring it together with an `api`
block is rejected. `via: api` binds a compatible API LLM instead: the entry
needs `api.protocol: openai` and an `api.baseUrl` (the runtime speaks the
OpenAI Responses wire protocol), disclaude injects the connection as a
namespaced upstream `model_providers` entry and passes the referenced
credential to the child — the ChatGPT login is not involved at all, so an
API-bound codex agent runs without `codex login`. Model ids on an API
binding are not checked against the ChatGPT catalog; the actual provider
validates them on the wire. A missing login, a rejected API credential and a
quota limit each surface as their own access method's explicit error — they
are never reported as (or silently degraded into) the other method's
problem, and a codex runtime is never rejected just for binding an API LLM.
See [agent configuration](agent-configuration.md) for the full `via` rules
and mixed subscription+API deployments.

When no Disclaude model override is set, the Codex CLI keeps its own model
selection from `CODEX_HOME/config.toml` or its built-in default. An explicit
resolved model is passed as `codex exec -m`; an explicit effort is passed as
`-c model_reasoning_effort=...`, so these run options take precedence over the
Codex CLI config file.

Set `llms.<name>.reasoningEffort` or `CODEX_REASONING_EFFORT` to request an
explicit effort. Supported labels exposed by current Codex model catalogs
include `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; each
model exposes only a subset. App-server checks the selected model's catalog
before starting a turn and reports unsupported pairs. With `exec`, the value is
passed to Codex CLI as `model_reasoning_effort`; the CLI validates it. If unset,
Disclaude leaves the model's Codex CLI default unchanged. `CODEX_REASONING_EFFORT`
overrides the YAML value. Precedence is a per-turn `reasoningEffort` option,
per-query `CODEX_REASONING_EFFORT`, process `CODEX_REASONING_EFFORT`, the YAML
setting, then the selected model's Codex CLI default.

The default `exec` transport runs non-interactive turns. It cannot load
Disclaude skill directories: native skill roots register only on the app-server
protocol (`skills/extraRoots/set`, verified with Codex CLI 0.140.0-0.164.0),
and `codex exec` offers no equivalent flag, environment variable or config
override. Because the shipped builtins always provide skill roots, `exec` and
`exec resume` fail fast with that diagnostic and never inject a skills
manifest into the prompt; set `agents.<name>.codex.transport: app-server` for
native skill loading. Set the same option when using Codex's structured
`requestUserInput` interaction; see [Feishu channel cards](feishu-channel.md#codex-input-cards).
Concurrency limits are per service process; extra work waits rather than
starting unlimited Codex sessions or child processes.

### Weekly-quota admission (#5607)

These windows are a ChatGPT-plan property: the ledger and admission below
apply to `via: chatgpt` bindings only. A `via: api` binding has no
subscription window — its usage-limit failures swap in the API quota notice
and never latch the weekly ledger (Issue #5338).

The ChatGPT subscription's rolling windows surface as structured rate-limit
readings on both transports: the `exec` protocol's `token_count` events and
the app-server's `account/rateLimits/updated` / `thread/tokenUsage/updated`
notifications carry per-window `{used_percent, window_minutes, resets_at}`.
Disclaude records these real readings in a per-process ledger (freshness is
process-local; a reading dies with its window) and admits **fresh sessions
only** — running turns are never killed, resumed conversations are never
gated, and capacity-recovery retries reuse a thread and pass untouched.

Admission compares progress, not balances: a fresh session is blocked while
the quota usage progress (`used_percent`) exceeds the weekly window's time
progress (elapsed share from `resets_at`/`window_minutes`). Burning quota
faster than the window elapses exhausts it before reset; slower does not.
Readings without a reset time (or a rolled window) never block —
insufficient data fails open. Set
`agents.<name>.codex.weeklyQuotaAdmission: enforce` to gate; the default
`observe` records and reports without blocking. REAL usage-limit errors gate
in both modes until their parsed `try again at/in …` deadline (or
`weeklyLimitCooldownMs` when unparsable). `/status` reports the readings,
the progress comparison and the current verdict. These caps are orthogonal
to the concurrency limits above.

## Quiet turns and liveness

`DISCLAUDE_STALL_TIMEOUT_MS` defaults to 180,000 ms. For Codex it schedules a
liveness check after a quiet interval; silence alone does not cancel a turn.
The `exec` bridge checks only its own child process. A live or unobservable
child keeps running; a confirmed stopped or exited child receives a terminal
`stall` failure. POSIX process inspection is bounded and reads state without
command arguments or environment values. An unavailable inspection, including
on Windows, remains unknown. Process health does not prove semantic progress;
session time limits and an explicit `/stop` remain separate controls.

The `app-server` bridge protects open tool items and pending human questions.
Other quiet turns use a read-only `thread/read` request with `includeTurns:
false`, bounded by the smaller of the quiet interval and five seconds. A
matching active thread continues. Unsupported or missing runtime status is
logged as unknown and continues; current status was verified with Codex CLI
0.162.0. A probe timeout, process exit, or a thread reported inactive without
its matching completion settles the original turn as failure. It does not
invent success or automatically replay work. Events and completion arriving
during a probe take precedence over its late result.

Failure diagnostics retain the last event, native thread/turn identity and
host request correlation. Scheduled-job failure notifications preserve the
provider cause alongside the request/run identifiers. A watchdog abort remains
failure even if the child exits with code zero.

## Real-model acceptance

Live acceptance scripts require an explicit model available to the signed-in
account; they do not supply a fixed model or inherit the account's default:

- `scripts/test-codex-live.mjs`: set `DISCLAUDE_TEST_MODEL`.
- Codex user-input E2E: set `DISCLAUDE_E2E_CODEX_INPUT_MODEL` when enabling
  `DISCLAUDE_E2E_CODEX_INPUT=1`.
- Browser Codex E2E: set `DISCLAUDE_E2E_BROWSER_CODEX_MODEL` when enabling
  `DISCLAUDE_E2E_BROWSER_CODEX=1`.

Use the model required by the acceptance issue and record that selection with
the result. Missing or blank model values fail before creating test resources
or starting a model turn.

## Permissions and behavior

- The default Codex sandbox is `workspace-write`. Set `agents.<name>.codexSandbox` to
  `read-only`, `workspace-write`, or `danger-full-access` to choose an explicit
  level. `agents.<name>.fullAccess: true` is an explicit opt-in to unrestricted access.
- Claude `allowedTools` / `disallowedTools` are not Codex policies; stale
  query fields are rejected. Choose business callbacks by passing their
  definitions in `tools`, and use the native sandbox configuration above.
- Codex conversations resume within a running service process. Restarting the
  service clears Disclaude's in-memory conversation mapping; Codex owns its
  session files under `CODEX_HOME`.
- When Codex is unavailable or unauthenticated, startup or the affected request
  reports the problem. Disclaude does not silently switch to another backend.

For Codex CLI options, authentication, and supported models, consult the
[official Codex CLI documentation](https://developers.openai.com/codex/cli).
