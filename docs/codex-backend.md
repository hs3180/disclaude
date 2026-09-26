# Codex backend

Set `agent.agentBackend: codex` to run the Codex CLI as Disclaude's agent
harness. Codex uses its own authentication and model configuration; Disclaude's
Anthropic-compatible `provider` settings do not select the Codex model.

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
  model: your-codex-model-id
  codex:
    transport: app-server # optional; default: exec
    maxActiveSessions: 3  # optional
    maxConcurrentRuns: 2  # optional
```

Choose a model supported by the installed Codex CLI and the signed-in account.
Do not configure `agent.provider` or an Anthropic-compatible API key to select
the Codex model.

The default `exec` transport runs non-interactive turns. Set
`agent.codex.transport: app-server` when using Codex's structured
`requestUserInput` interaction; see [Codex input cards](codex-user-input.md).
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
