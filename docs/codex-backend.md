# Codex backend

Set `agent.agentBackend: codex` to run the Codex CLI as Disclaude's agent
harness. Codex uses its own authentication and model configuration; Disclaude's
Anthropic-compatible `provider` settings do not select the Codex model.

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
agent:
  agentBackend: codex
  codex:
    model: gpt-5.6-luna
    reasoningEffort: high # optional; must be supported by this model
    transport: app-server # optional; default: exec
    maxActiveSessions: 3  # optional
    maxConcurrentRuns: 2  # optional
```

`agent.codex.model` is the canonical model setting. `CODEX_MODEL` overrides it;
the legacy `agent.model` and a default Codex preset's `model` remain fallback
sources for existing configurations. If multiple legacy and canonical values
conflict, the selected source wins and startup warns which duplicate setting to
remove. A named agent preset can still select its own model for that chat.

The precedence for a run is a selected per-chat/per-turn model, then a
per-query `CODEX_MODEL`, the process `CODEX_MODEL`, the resolved configuration
setting, and finally the Codex CLI default. Avoid setting the same model in
several places; use the resolved run log to see the effective model and source.
Do not configure `agent.provider` or an Anthropic-compatible API key to select
the Codex model.

When no Disclaude model override is set, the Codex CLI keeps its own model
selection from `CODEX_HOME/config.toml` or its built-in default. An explicit
resolved model is passed as `codex exec -m`; an explicit effort is passed as
`-c model_reasoning_effort=...`, so these run options take precedence over the
Codex CLI config file.

Set `agent.codex.reasoningEffort` or `CODEX_REASONING_EFFORT` to request an
explicit effort. Supported labels exposed by current Codex model catalogs
include `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; each
model exposes only a subset. App-server checks the selected model's catalog
before starting a turn and reports unsupported pairs. With `exec`, the value is
passed to Codex CLI as `model_reasoning_effort`; the CLI validates it. If unset,
Disclaude leaves the model's Codex CLI default unchanged. `CODEX_REASONING_EFFORT`
overrides the YAML value. Precedence is a per-turn `reasoningEffort` option,
per-query `CODEX_REASONING_EFFORT`, process `CODEX_REASONING_EFFORT`, the YAML
setting, then the selected model's Codex CLI default.

The default `exec` transport runs non-interactive turns. Set
`agent.codex.transport: app-server` when using Codex's structured
`requestUserInput` interaction; see [Feishu channel cards](feishu-channel.md#codex-input-cards).
Concurrency limits are per service process; extra work waits rather than
starting unlimited Codex sessions or child processes.

## Permissions and behavior

- The default Codex sandbox is `workspace-write`. Set `agent.codexSandbox` to
  `read-only`, `workspace-write`, or `danger-full-access` to choose an explicit
  level. `agent.fullAccess: true` is an explicit opt-in to unrestricted access.
- A `disallowedTools` policy that denies mutating tools caps the effective
  sandbox at `read-only`. If a requested restriction cannot be enforced by the
  selected Codex transport, Disclaude fails closed instead of claiming it was
  applied.
- Codex conversations resume within a running service process. Restarting the
  service clears Disclaude's in-memory conversation mapping; Codex owns its
  session files under `CODEX_HOME`.
- When Codex is unavailable or unauthenticated, startup or the affected request
  reports the problem. Disclaude does not silently switch to another backend.

For Codex CLI options, authentication, and supported models, consult the
[official Codex CLI documentation](https://developers.openai.com/codex/cli).
