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
    defaultModel: your-model-id
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

Every named agent binds an LLM. Agents bound to a provider can use ANY model
it serves; `llms.<name>.defaultModel` only sets that provider's default — the
model a runtime falls back to when nothing more specific selects one. Set it
to pin one deployment default for every runtime bound to the provider, omit it
to keep each runtime's native selection (a set-but-blank value is rejected).
This includes native Codex: bind `backend: codex` to a named LLM with no `api`
block. `ANTHROPIC_MODEL` and `OPENAI_MODEL` do not fill missing models.
`CODEX_MODEL` explicitly overrides the default Codex binding only after the
configured model passes validation; it does not supply a missing model. Named
non-default bindings remain independent. Put `reasoningEffort` alongside
`defaultModel` in `llms.<name>`; it is a provider-level default, not a harness
setting — runtimes that cannot apply an effort ignore it (currently Codex and
DSH apply it), and omission keeps the model's own default. Transport stays
under the agent's `codex` block.
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
For example, `llms.daily: {defaultModel: your-model-id, reasoningEffort: your-supported-effort, maxConcurrentSessions: 3}`.
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

Claude accepts its native model aliases or full model IDs. Claude Code's
multi-agent capability resolves three model tiers — opus, sonnet and haiku
(subagents, background tasks, `/model` alias switching). Configure which of
the provider's models play those roles with `agents.<name>.claude.models`
(only with `backend: claude`):

```yaml
agents:
  assistant:
    backend: claude
    llm: shared-gateway
    claude:
      models:
        opus: kimi-k3          # pretends to be the heavyweight tier
        sonnet: kimi-k3-flash  # pretends to be the default tier
        haiku: kimi-k3-air     # pretends to be the fast tier
llms:
  shared-gateway:
    defaultModel: kimi-k3-flash
```

Each tier key is optional; an omitted tier falls back to the provider's
`llms.<name>.defaultModel`. That is also the single-model shorthand: skip
`models` entirely and configure only `defaultModel`, and all three tiers
point at that one model. Tiers compile to Claude Code's native
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and
`ANTHROPIC_DEFAULT_HAIKU_MODEL` environment; an explicit entry for the same
tier in `agents.<name>.claude.env` overrides the computed default, and
configuring one tier in both places is rejected. Other variables supported by
your CLI version can still be set in `agents.<name>.claude.env`; values pass
through unchanged.
See [Claude model configuration](https://code.claude.com/docs/en/model-config).

For a gateway or provider-specific model ID Claude Code does not know
(`kimi-k3`, a Bedrock inference profile, …), bind its client-side identity with
`agents.<name>.claude.behavesAs` (Issue #5410): a full Claude model ID whose catalog
entry — context window, capability and effort defaults — Claude Code applies to
`model` while still sending `model` on the wire.
`behavesAs: claude-opus-5` with the provider default `defaultModel: kimi-k3`
generates `modelOverrides: {"claude-opus-5": "kimi-k3"}` in the per-query private
settings file; no user `~/.claude/settings.json` is written. Overrides also
apply on the `ANTHROPIC_DEFAULT_*_MODEL` env-pin path. Window rules: Opus-line
IDs (`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`) are the only 1M
context keys — `claude-sonnet-4-5` / `claude-haiku-4-5` assume 200k, whatever
slot the model serves. Pin the ID deliberately per deployment: aliases like
`opus` are not auto-resolved, and once an override applies,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` stops applying while the slot inherits the
target's effort defaults (override with `CLAUDE_EFFORT`). Requires Claude
Code ≥ v2.1.200; agent startup fails with a clear error when the bundled CLI
is older. For multi-slot mappings set `agents.<name>.claude.modelOverrides` directly —
a raw Claude Code `modelOverrides` map (full Claude model ID → provider ID),
mutually exclusive with `behavesAs`.

One binding can serve several harnesses (Issue #5679): bind both
`backend: claude` and `backend: dsh` (or `pi`) agents to the same `llms` entry
and `defaultModel` is the wire model for every one of them — the deployment-level
alias is configured once. `models`/`behavesAs`/`modelOverrides` live under
`agents.<claude-name>.claude` and are capability metadata for that Claude
runtime only; DSH/Pi send `defaultModel` verbatim.
Changing the provider default model means editing `llms.<name>.defaultModel` in that
one place. Two boundaries keep the
wire models honest: a bare Claude alias (`sonnet`, `opus`, …) as `defaultModel` is
rejected when the binding is shared with DSH/Pi/Codex, because Claude Code
resolves aliases internally while the other harnesses would put the alias
string itself on the wire — pin the wire model and map the Claude tiers via
`agents.<name>.claude.models`; and
`agents.<name>.claude` requires `backend: claude`, so native Codex cannot
reference Claude model-name configuration. A provider default model is
optional — set it when agents sharing the provider should use one deployment
model, omit it to keep each runtime's native selection. Explicit
canonical model IDs (`claude-sonnet-4-5`, `gpt-6-luna`, `group/hq-degrade`)
pass through to every backend unchanged. Configuration errors surface at
startup, before `/agent use` can replace a session; failed switch preflight
preserves the existing session and never falls back to another binding.

Use one `default: true` marker (or the reserved name `default`); without a marker,
the first declaration is the default. `/agent use <name>` validates the selected
connection before replacing the current chat's session. Failed preflight preserves
the existing session. No credentials are required for dormant API bindings when
the default runtime is native.

Selection precedence for each incoming session is `/agent use <preset>`
(explicit, process-lifetime) > an administrator's durable chat binding
(`/agent use <preset> --bind <chatId>`, `#5476`) > the owning application's
`channels.<app>.agent` default > the global default marker. The durable
binding rides on the same `/agent use` verb rather than separate commands:
`/agent use --bind <chatId>` (without a preset) queries the binding and the
effective preset, while `/agent use --unbind <chatId>` clears it. These
binding operations are restricted to actor ids listed in
`messaging.admin.actorIds`; each attempt is logged with actor, target
chat and preset as an `agent-binding` audit record. A binding takes effect on
the target chat's next message, survives restarts through
`workspace/.disclaude/agent-bindings.json`, and refuses to replace a busy
session. Locking a binding against later `/agent use` is intentionally out of
scope for this slice.

## Migration

Move the old singleton runtime's settings into a named `agents` entry, its API
connection and optional default model into a named `llms` entry, and platform
settings into `channels`. Replace capability-tier settings with the Claude
agent's `claude.models` tier mapping (or `claude.env` alias variables).
Replace `agent.codex.model` with the bound `llms.<name>.defaultModel`. Old
provider and top-level platform sections are rejected with migration guidance.
Configuration files are never rewritten automatically; keep a backup when
migrating deployments. For earlier #5294 previews, move
`agents.<name>.codex.reasoningEffort` to its bound LLM and replace
`apiKeyEnv: NAME` with `apiKey: $NAME`.

For the provider-ownership rework of Issue #5679, `llms.<name>.behavesAs`,
`modelOverrides` and the `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` variables
have moved to `agents.<claude-name>.claude` (`behavesAs`, `modelOverrides`,
`models`, `env`); old locations fail validation with field-path migration
guidance. The 2026-11-06 review additionally renamed the provider default key:
`llms.<name>.model` is now `llms.<name>.defaultModel` — agents can use any
model of the provider, the key only sets the default, and the old name fails
validation with rename guidance. A provider default model remains optional;
`CODEX_MODEL`, `ANTHROPIC_MODEL` and `OPENAI_MODEL` never fill it, and blank
values are rejected. The application never edits the file.

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
    defaultModel: your-claude-model
    env:
      BASH_DEFAULT_TIMEOUT_MS: "600000"
      BASH_MAX_TIMEOUT_MS: "1800000"
```

Set either value to an empty string to leave that knob to the CLI's own default. `"0"` does not disable Claude's native command timeout. In the pinned SDK 0.3.263 CLI, the fallback values are 120000/600000 ms, so the Disclaude defaults provide a longer foreground window. This configuration is not evidence that the historical indefinite-wait incident is fixed; native background jobs and actual task/notification lifecycles need separate verification.
