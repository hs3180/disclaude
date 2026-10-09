# Runtime environment variables

This page covers operator-facing `DISCLAUDE_*` settings. Browser-service
settings are documented in [browser coordination](browser-coordination.md) and
[browser setup](chromium-setup.md); provider credentials belong in the relevant
backend guide. Values injected for a managed task are runtime context, not
persistent configuration.

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DISCLAUDE_CONFIG_PATH` | Select the Disclaude configuration file. | Use an absolute path for unattended services. |
| `DISCLAUDE_WORKSPACE_DIR` | Override `workspace.dir`. | The configured workspace remains user data; do not point it into a disposable install. |
| `DISCLAUDE_API_BASE_URL` | Address the local DisclaudeService HTTP API used by channel commands. | Managed child processes receive the active address. |
| `DISCLAUDE_API_TOKEN` | Bearer token for write requests to that API. | The service generates a fresh value by default, or uses an explicit `--api-token`; managed children receive the active value. Do not persist or reuse an old token. |
| `DISCLAUDE_ALLOW_BUILTIN_CRON` | Re-enable the backend's built-in cron/loop tools. | Disabled by default; `1` or `true` enables them. The persistent `schedule` feature is separate. |
| `DISCLAUDE_STALL_TIMEOUT_MS` | Override the local stall timeout for providers that still use a stall watchdog. | Defaults to 180,000 ms; Claude delegates stream-level retries and liveness to its SDK/CLI. |
| `DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS` | Grace period before force-closing a stalled provider process when its provider watchdog is active. | Defaults to 5,000 ms; Claude does not use this watchdog. |
| `DISCLAUDE_QUERY_MAX_RETRIES` | Override Claude SDK query retries. | Positive integer; otherwise the provider default is used. |
| `DISCLAUDE_SYSTEM_FLOOD_THRESHOLD` | Set Claude system-message flood threshold. | Positive integer; defaults to 50. |
| `DISCLAUDE_MIDSTREAM_RETRY_DELAY_MS` | Set the delay used by mid-stream retry handling. | Internal reliability tuning; omit unless diagnosing or testing provider behavior. |
| `ANTHROPIC_MODEL` | Fallback primary model for Claude/API backends. | Explicit model configuration wins; an empty or whitespace-only value does not satisfy model validation. |

For Anthropic/API model selection, the priority is the selected named preset's
`model`, `agent.model`, `anthropic.model`, then `ANTHROPIC_MODEL`. For GLM,
the selected named preset's `model` wins, followed by `glm.model`, then
`ANTHROPIC_MODEL`. The fallback uses the service process environment first,
then `env.ANTHROPIC_MODEL` in `disclaude.config.yaml`; surrounding whitespace is
removed. The API key and GLM endpoint remain required. Codex continues to use
its own `CODEX_MODEL`/Codex configuration rules.

Claude Code `settingSources: ['user', 'project', 'local']` loads settings into
the SDK subprocess. It does not export `model` or `env.ANTHROPIC_MODEL` from
those files into the Disclaude service process. The service validates its
configuration before launching that subprocess, and passes the resolved model
explicitly to the SDK. Set `ANTHROPIC_MODEL` in the service's launch environment
or YAML `env` block to use the fallback; a Claude Code settings file alone
cannot satisfy the service's required model. Explicit SDK model selection
also takes priority over the subprocess's model settings. See the official
[Claude Code settings](https://code.claude.com/docs/en/settings) and
[model configuration](https://code.claude.com/docs/en/model-config) references.

`disclaude start` generates a fresh API token for each run by default and
supplies it to managed child processes. If `--api-token` is set, use that
explicit value instead. External channel CLI calls should use the active
`--base-url` / `--api-token` options or the corresponding environment values;
never copy a token from an earlier run. The service API defaults to a local
binding. Do not expose it on an untrusted network, especially when write-route
authentication is disabled.

The launchd script has deployment-specific `DISCLAUDE_LAUNCHD_*` overrides.
Prefer its documented CLI workflow instead of setting those low-level values
directly. `DISCLAUDE_SCHEDULE_ID`, `DISCLAUDE_SCHEDULE_NAME`, and
`DISCLAUDE_CHAT_ID` are injected as task context, not service configuration.
