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
| `DISCLAUDE_STALL_TIMEOUT_MS` | Override the provider stall timeout. | Defaults to 180,000 ms. |
| `DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS` | Grace period before force-closing a stalled provider process. | Defaults to 5,000 ms. |
| `DISCLAUDE_QUERY_MAX_RETRIES` | Override Claude SDK query retries. | Positive integer; otherwise the provider default is used. |
| `DISCLAUDE_SYSTEM_FLOOD_THRESHOLD` | Set Claude system-message flood threshold. | Positive integer; defaults to 50. |
| `DISCLAUDE_MIDSTREAM_RETRY_DELAY_MS` | Set the delay used by mid-stream retry handling. | Internal reliability tuning; omit unless diagnosing or testing provider behavior. |

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
