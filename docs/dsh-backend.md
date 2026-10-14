# DSH runtime modes

For Project-bound Notebook capabilities, see [optional Jupyter CLI/Skill](jupyter-service.md).

DSH is an agent runtime that can use different model providers. Select its
backend and composition independently of the model vendor:

```yaml
agents:
  default:
    backend: dsh
    llm: glm-openai
    mode: minimal
    dshHome: /absolute/path/to/isolated-dsh-home
llms:
  glm-openai:
    model: glm-5.3
    api:
      protocol: openai
      baseUrl: https://your-openai-compatible-api.example/v1
      apiKey: $GLM_API_KEY
```

`agents.<name>.mode` accepts `standard` (default) or `minimal` for `backend: dsh`. Restart the service
when changing it; existing tasks are not switched in place. Each provider owns
its own process pool and selects one profile for its lifetime.
Set the native home directly with `agents.<name>.dshHome`; it overrides `DSH_HOME`.
Omission uses `DSH_HOME`, then the native runtime's default home. Named DSH agents
use their own mode and home even when Codex is the default agent. API settings
belong only in the bound LLM: `api.protocol`, `api.baseUrl`, and `api.apiKey` as a
credential reference. OpenAI means Chat Completions; Anthropic means Messages.
The agent has no nested `dsh` connection block. Other backends reject DSH mode and home.
Equivalent DSH connections share a provider; different modes, homes, protocols,
endpoints, models or credentials use separate providers. Switching and resetting a named agent use
the same selected connection as its queries.

`backend: deepseek`, `agents.<name>.deepseek`, and `agents.<name>.dsh` are rejected.
Use `backend: dsh`, put composition and home directly on the agent, and move the
native connection's protocol, URL and credential reference to `llms.<name>.api`
before restarting. A model-only DSH binding is rejected; a missing selected key
fails preflight instead of falling back to a native account or another provider.

The host registers the bound API route in a temporary patch, augmenting an existing
API adapter with an explicit entry id or loading the optional pinned adapter once.
The configured home/profile files stay untouched; only a credential variable name
enters the patch. The resolved key is projected into the owned child process.

| Mode       | Official SDK profile | Intended composition                                                                |
| ---------- | -------------------- | ----------------------------------------------------------------------------------- |
| `standard` | `sdk`                | Base-backed SDK environment with the standard tools and supporting services.        |
| `minimal`  | `sdk-minimal`        | Standalone minimal SDK environment; reduced model-facing tools and runtime context. |

These are SDK profiles served over JSON-RPC, not the interactive Web/TUI presets.
The installed dsh version and any user profile patches determine the effective
plugin/tool set. Selecting minimal does not uninstall global packages or rewrite
existing user profiles. It also does not guarantee higher quality for every task.
The upstream SDK-minimal defaults omit managed credentials, skill discovery and
compaction; supply API credentials through the bound LLM's `api.apiKey` reference and
check the capabilities of your installed version before using long-running tasks.

On macOS and Linux, the owned DSH process uses a UTF-8 locale for its persistent
Bash terminal. A host with no locale or a `C`/`POSIX` override can otherwise make
Readline treat Chinese input as Meta shortcuts, corrupting the command and causing
a tool timeout. An effective UTF-8 `LC_ALL`, `LC_CTYPE`, or `LANG` is preserved in
that priority order. Otherwise, disclaude sets the child's `LC_ALL` to an existing
declared UTF-8 locale, or to `en_US.UTF-8` on macOS / `C.UTF-8` on Linux. This applies
after per-query environment settings are merged. Restart existing DSH runtimes to
receive the corrected environment.

An unsupported profile fails with its profile name and startup/protocol error;
disclaude does not retry using another mode. Check `dsh --version`, then inspect
the selected composition with `DSH_HOME=... dsh --profile sdk-minimal
--dump-default-config` (or `sdk`). The dump shows composition, not evidence that a
model/tool task completes. Use `--dump-config` locally to inspect user overrides;
configuration output may contain private settings.

## Direct Node SDK prototype

The default bootstrap remains `cli`. For an isolated experiment, set
`env.DISCLAUDE_DSH_BOOTSTRAP: node-sdk` on a named DSH agent, select
`mode: minimal`, and give it an existing, isolated `dshHome` directory:

```yaml
agents:
  dsh-sdk:
    backend: dsh
    llm: glm-openai
    mode: minimal
    dshHome: /absolute/path/to/isolated-sdk-home
    env:
      DISCLAUDE_DSH_BOOTSTRAP: node-sdk
```

This opt-in path starts an owned Node worker using the declared, pinned
`@deepseek-ai/dsh-app-boot` and `@deepseek-ai/dsh-sdk-minimal` libraries; it does
not look up or execute the global `dsh` binary. It reuses the native Agent,
Session, persistence, API routing and host-tool bridge. The optional local
attachment plugin supplies the service required by the controller.

This prototype supports only the pinned minimal composition. It rejects standard
mode, custom process launch arguments and user profile overrides rather than
silently changing the composition. It does not promise standard-mode skill,
compaction or Bash capability parity. Set the same flag to `cli` and restart
the service to return to the existing CLI bootstrap. Preserve the configured
home and workspace; test either path with its own chosen composition before
using it for production work.

| Capability | CLI bootstrap | Node SDK prototype |
| --- | --- | --- |
| Runtime source | Installed `dsh` and selected profile | Pinned local libraries in an owned Node worker |
| Composition | `standard` / `minimal`, including selected home patches | Published minimal bundle; user profile overrides rejected |
| Bound OpenAI / Anthropic APIs | Existing native adapter | Same native adapter and selected credential |
| Host tools, session persistence, cancellation | Existing native controller | Same native controller; each query owns its worker |
| Standard Bash, skill discovery and compaction | Depends on installed composition | Not offered by this minimal prototype |
| Rollback | Default `cli` flag | Change the flag to `cli` and restart |

Upstream: https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/examples/README.md
