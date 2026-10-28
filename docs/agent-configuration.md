# Agent configuration

`agents` defines runtimes, `llms` defines models and their connections, and
`channels` defines communication settings. See `disclaude.config.example.yaml`.

```yaml
agents:
  assistant:
    backend: claude
    llm: proxy
    default: true
llms:
  proxy:
    model: glm-5.3
    api:
      protocol: anthropic
      baseUrl: https://your-anthropic-api.example
      apiKey: $ASSISTANT_API_KEY
channels:
  feishu:
    appId: your-app-id
    appSecret: $FEISHU_APP_SECRET
```

Model vendors do not define configuration sections or API formats. Any model
exposed by an Anthropic-compatible endpoint uses `protocol: anthropic`; Pi and DSH also
support `protocol: openai` through an OpenAI chat-completions adapter. Claude
requires the Anthropic format. There are no built-in third-party proxy URLs.

Set `apiKey: $ASSISTANT_API_KEY` (or `apiKey: ${ASSISTANT_API_KEY}`) to reference
the service environment; it takes precedence over global `env` defaults.
References must occupy the whole value: literal credentials, embedded references,
and shell expressions are rejected without logging their values. Omit `apiKey` to
use `$ANTHROPIC_API_KEY` or `$OPENAI_API_KEY`. A selected API connection overrides
inherited endpoint and bearer/OAuth settings. Configured LLM credential variables
are removed from child environments before only the selected key is projected.
Do not put literal API keys in YAML; supply them through the service's environment
or a restricted environment file in launchd, systemd or Docker.

Every named agent binds an LLM with an explicit, non-empty `model`. This includes
native Codex: bind `backend: codex` to a named LLM with `model` and no `api` block.
`ANTHROPIC_MODEL` and `OPENAI_MODEL` do not fill missing models. `CODEX_MODEL`
explicitly overrides the default Codex binding only after the configured model
passes validation; it does not supply a missing model. Named non-default bindings
remain independent. Put `reasoningEffort` alongside `model`
in `llms.<name>`; it is currently supported by native Codex and DSH. Omission
keeps the model's native default. Transport stays under the agent's `codex` block.
DSH uses `backend: dsh` and the bound `llms.<name>.api` connection. Set the composition
directly with `agents.<name>.mode: minimal` or `standard`, and set its optional home
with `agents.<name>.dshHome` (overriding `DSH_HOME`). There is no nested `dsh` block.
The LLM declares its model, reasoning effort, API protocol, base URL and credential
reference. DSH requires an explicit base URL. The host adds the connection through
an owned temporary profile patch; it does not rewrite the installed profile or put
the resolved credential in that patch. Different endpoints, protocols, models and
credentials use separate providers. An existing API adapter receives the selected
route instead of loading a duplicate adapter.
See [DSH runtime modes](dsh-backend.md) for minimal mode and native provider routes.

Set `llms.<name>.maxConcurrentSessions` to a positive integer to cap live host
sessions using that LLM across all agents and backends in this service process.
For example, `llms.daily: {model: gpt-6-luna, reasoningEffort: max, maxConcurrentSessions: 3}`.
Idle open sessions still count for stream-scoped runtimes; native subagents are
outside this host budget. Codex app-server reserves this shared budget per native
connection and releases it after transport shutdown, preserving the input stream
and thread ID for later turns. A later turn reacquires the same bounded FIFO budget.
At capacity new sessions wait in a process-local FIFO queue of up to 64 sessions.
Accepted chat inputs receive a queue notice and continue automatically when a
slot is released, with their original chat, topic and message identity. A full
queue rejects the input explicitly; it must be sent again after capacity is freed.
Closing, canceling, resetting, or ending a stream releases its slot. Canceling a
waiting session removes it before any native query starts. Configuration and
provider errors are not retried as capacity waits. The queue does not survive
service restart; the existing interrupted-turn recovery reports unfinished work.
Different LLM names have independent budgets. Omission preserves backend defaults.
For Codex an explicit LLM cap replaces the legacy process session cap, while
`agents.<default>.codex.maxConcurrentRuns` still caps running children process-wide.

Claude accepts its native model aliases or full model IDs. Configure subagent
aliases directly under the bound LLM's `env`, using
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` and other variables supported by your CLI version.
Values pass through unchanged; unspecified aliases remain native defaults.
See [Claude model configuration](https://code.claude.com/docs/en/model-config).

For a gateway or provider-specific model ID Claude Code does not know
(`kimi-k3`, a Bedrock inference profile, …), bind its client-side identity with
`llms.<name>.behavesAs` (Issue #5410): a full Claude model ID whose catalog
entry — context window, capability and effort defaults — Claude Code applies to
`model` while still sending `model` on the wire.
`behavesAs: claude-opus-5` with `model: kimi-k3` generates
`modelOverrides: {"claude-opus-5": "kimi-k3"}` in the per-query private
settings file; no user `~/.claude/settings.json` is written. Overrides also
apply on the `ANTHROPIC_DEFAULT_*_MODEL` env-pin path. Window rules: Opus-line
IDs (`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`) are the only 1M
context keys — `claude-sonnet-4-5` / `claude-haiku-4-5` assume 200k, whatever
slot the model serves. Pin the ID deliberately per deployment: aliases like
`opus` are not auto-resolved, and once an override applies,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` stops applying while the slot inherits the
target's effort defaults (override with `CLAUDE_EFFORT`). Requires Claude
Code ≥ v2.1.200; agent startup fails with a clear error when the bundled CLI
is older. For multi-slot mappings set `llms.<name>.modelOverrides` directly —
a raw Claude Code `modelOverrides` map (full Claude model ID → provider ID),
mutually exclusive with `behavesAs`.

Use one `default: true` marker (or the reserved name `default`); without a marker,
the first declaration is the default. `/agent use <name>` validates the selected
connection before replacing the current chat's session. Failed preflight preserves
the existing session. No credentials are required for dormant API bindings when
the default runtime is native.

## Migration

Move the old singleton runtime's settings into a named `agents` entry, its model
and API connection into a named `llms` entry, and platform settings into
`channels`. Replace capability-tier settings with native Claude alias variables.
Replace `agent.codex.model` with the bound `llms.<name>.model`. Old provider and
top-level platform sections are rejected with migration guidance. Configuration
files are never rewritten automatically; keep a backup when migrating deployments.
For earlier #5294 previews, move `agents.<name>.codex.reasoningEffort` to its bound
LLM and replace `apiKeyEnv: NAME` with `apiKey: $NAME`.

For the 0.6.4 named-configuration contract, add an explicit `llms.<name>.model`
when an older configuration omitted it or relied on a native/API environment
default. Missing or blank models fail with that field path before startup or
preset selection, even when `CODEX_MODEL`, `ANTHROPIC_MODEL` or `OPENAI_MODEL` is
set. Choose the intended model locally; the application never edits the file.

For DSH, replace `backend: deepseek` with `backend: dsh`, move composition and home
to the agent's `mode` and `dshHome`, and remove either old `deepseek` or `dsh`
connection block. Move the native provider's protocol and URL to the bound
`llms.<name>.api.protocol` and `.baseUrl`, and replace `apiKeyEnv: NAME` with
`.apiKey: $NAME`. The old blocks are rejected with migration guidance. The LLM
API declaration now selects the connection; a native provider route name is not
a public agent setting. Keep custom tools and other profile settings; an existing
`@deepseek-ai/dsh-llm-pi-ai` entry must have an explicit id so it can be augmented.

Global `env` contains public defaults; persistent secrets use external references.
The optional owner-only secret file and selected LLM native/tool environment
projection are described in [configuration secrets](configuration-secrets.md).
Workspace `.runtime-env` keeps its existing lifecycle.

Channel credential sources and migration: [channel-credentials.md](channel-credentials.md).


### Claude foreground Bash timeouts

Claude subprocesses receive native `BASH_DEFAULT_TIMEOUT_MS=600000` (10 minutes) and `BASH_MAX_TIMEOUT_MS=1800000` (30 minutes) when unset. These apply to individual foreground Bash calls; native tool results return to the same running query. They do not limit a Goal or terminate a turn because it is quiet. Longer jobs can use the native background-task mechanism.

Override the values through the bound LLM's existing `env` mapping (or the service environment). Native user/project settings retain their normal precedence:

```yaml
llms:
  assistant:
    model: sonnet
    env:
      BASH_DEFAULT_TIMEOUT_MS: "600000"
      BASH_MAX_TIMEOUT_MS: "1800000"
```

Set either value to an empty string to leave that knob to the CLI's own default. `"0"` does not disable Claude's native command timeout. In the pinned SDK 0.3.263 CLI, the fallback values are 120000/600000 ms, so the Disclaude defaults provide a longer foreground window. This configuration is not evidence that the historical indefinite-wait incident is fixed; native background jobs and actual task/notification lifecycles need separate verification.
