# DeepSeek harness modes

Select the dsh backend and its composition in the service configuration:

```yaml
agent:
  agentBackend: deepseek
  model: your-supported-deepseek-model
deepseek:
  mode: minimal
  dshHome: /absolute/path/to/isolated-dsh-home
```

`deepseek.mode` accepts `standard` (default) or `minimal`. Restart the service
when changing it; existing tasks are not switched in place. Each provider owns
its own process pool and selects one profile for its lifetime.

| Mode | Official SDK profile | Intended composition |
| --- | --- | --- |
| `standard` | `sdk` | Base-backed SDK environment with the standard tools and supporting services. |
| `minimal` | `sdk-minimal` | Standalone minimal SDK environment; reduced model-facing tools and runtime context. |

These are SDK profiles served over JSON-RPC, not the interactive Web/TUI presets.
The installed dsh version and any user profile patches determine the effective
plugin/tool set. Selecting minimal does not uninstall global packages or rewrite
existing user profiles. It also does not guarantee higher quality for every task.
The upstream SDK-minimal defaults omit managed credentials, skill discovery and
compaction; supply credentials through `deepseek.apiKey` / `DEEPSEEK_API_KEY` and
check the capabilities of your installed version before using long-running tasks.

An unsupported profile fails with its profile name and startup/protocol error;
disclaude does not retry using another mode. Check `dsh --version`, then inspect
the selected composition with `DSH_HOME=... dsh --profile sdk-minimal
--dump-default-config` (or `sdk`). The dump shows composition, not evidence that a
model/tool task completes. Use `--dump-config` locally to inspect user overrides;
configuration output may contain private settings.

The local dsh `0.1.2-rc.1` was verified to compose both profiles and complete their
real initialize/shutdown JSON-RPC exchanges using separate temporary homes.
Core tests cover mode validation and actual subprocess arguments. Both modes
also passed the real model/tool use case with the configured `deepseek-flash`
endpoint: write a unique workspace artifact, read it back, and return its content.
This is functional acceptance, not a comparative quality or latency benchmark.

Run the actual use case with an already configured credential/endpoint:

```sh
DISCLAUDE_E2E_DSH=1 DISCLAUDE_E2E_DSH_MODEL=deepseek-flash \
npx vitest run --config vitest.e2e.config.ts tests/e2e/deepseek-mode.test.ts
```

Set `DEEPSEEK_API_KEY` and, for a custom endpoint, `DEEPSEEK_BASE_URL` privately.
The test uses a temporary home and workspace for each mode. It is skipped unless
explicitly enabled, and fails if enabled without the required model or credential.

Upstream: https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/README.md
