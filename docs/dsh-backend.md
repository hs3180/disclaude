# DeepSeek harness modes

For Project-bound Notebook capabilities, see [optional Jupyter CLI/Skill](jupyter-service.md).

Select the dsh backend and its composition in the service configuration:

```yaml
agents:
  default:
    backend: deepseek
    llm: native
    deepseek:
      mode: minimal
      dshHome: /absolute/path/to/isolated-dsh-home
llms:
  native:
    model: your-supported-deepseek-model
```

`agents.<name>.deepseek.mode` accepts `standard` (default) or `minimal`. Restart the service
when changing it; existing tasks are not switched in place. Each provider owns
its own process pool and selects one profile for its lifetime.
Named DSH agents use their own `deepseek` settings even when Codex is the default
agent. Keep this block only under `backend: deepseek`; other backends reject it.
Equivalent DSH connections share a provider; different modes, routes, homes or
credentials use separate providers. Switching and resetting a named agent use
the same selected connection as its queries.

| Mode | Official SDK profile | Intended composition |
| --- | --- | --- |
| `standard` | `sdk` | Base-backed SDK environment with the standard tools and supporting services. |
| `minimal` | `sdk-minimal` | Standalone minimal SDK environment; reduced model-facing tools and runtime context. |

These are SDK profiles served over JSON-RPC, not the interactive Web/TUI presets.
The installed dsh version and any user profile patches determine the effective
plugin/tool set. Selecting minimal does not uninstall global packages or rewrite
existing user profiles. It also does not guarantee higher quality for every task.
The upstream SDK-minimal defaults omit managed credentials, skill discovery and
compaction; supply credentials through `agents.<name>.deepseek.apiKeyEnv` / `DEEPSEEK_API_KEY` and
check the capabilities of your installed version before using long-running tasks.

An unsupported profile fails with its profile name and startup/protocol error;
disclaude does not retry using another mode. Check `dsh --version`, then inspect
the selected composition with `DSH_HOME=... dsh --profile sdk-minimal
--dump-default-config` (or `sdk`). The dump shows composition, not evidence that a
model/tool task completes. Use `--dump-config` locally to inspect user overrides;
configuration output may contain private settings.

Upstream: https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/README.md
