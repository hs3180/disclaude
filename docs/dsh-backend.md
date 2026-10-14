# DSH runtime modes

For Project-bound Notebook capabilities, see [optional Jupyter CLI/Skill](jupyter-service.md).

DSH is an agent runtime that can use different model providers. Select its
backend and composition independently of the model vendor:

```yaml
agents:
  default:
    backend: dsh
    llm: native
    mode: minimal
    dsh:
      dshHome: /absolute/path/to/isolated-dsh-home
llms:
  native:
    model: your-supported-model
```

`agents.<name>.mode` accepts `standard` (default) or `minimal` for `backend: dsh`. Restart the service
when changing it; existing tasks are not switched in place. Each provider owns
its own process pool and selects one profile for its lifetime.
Named DSH agents use their own mode and optional `dsh` connection settings even
when Codex is the default agent. The `dsh` block holds provider, credential and
home options; it is unnecessary when only setting mode. Other backends reject
the DSH mode and connection settings.
Equivalent DSH connections share a provider; different modes, routes, homes or
credentials use separate providers. Switching and resetting a named agent use
the same selected connection as its queries.

`backend: deepseek` and an agent's `deepseek` block are rejected. Use `backend: dsh`,
move composition to `agents.<name>.mode` and native connection settings to
`agents.<name>.dsh` before restarting. Nested `dsh.mode` is also rejected with
guidance to move it to the agent's direct `mode` field.

| Mode | Official SDK profile | Intended composition |
| --- | --- | --- |
| `standard` | `sdk` | Base-backed SDK environment with the standard tools and supporting services. |
| `minimal` | `sdk-minimal` | Standalone minimal SDK environment; reduced model-facing tools and runtime context. |

These are SDK profiles served over JSON-RPC, not the interactive Web/TUI presets.
The installed dsh version and any user profile patches determine the effective
plugin/tool set. Selecting minimal does not uninstall global packages or rewrite
existing user profiles. It also does not guarantee higher quality for every task.
The upstream SDK-minimal defaults omit managed credentials, skill discovery and
compaction; supply credentials through `agents.<name>.dsh.apiKeyEnv` / `DEEPSEEK_API_KEY` and
check the capabilities of your installed version before using long-running tasks.

An unsupported profile fails with its profile name and startup/protocol error;
disclaude does not retry using another mode. Check `dsh --version`, then inspect
the selected composition with `DSH_HOME=... dsh --profile sdk-minimal
--dump-default-config` (or `sdk`). The dump shows composition, not evidence that a
model/tool task completes. Use `--dump-config` locally to inspect user overrides;
configuration output may contain private settings.

Upstream: https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/README.md
