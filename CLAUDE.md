# CLAUDE.md

Guidance for Claude Code when working in this repository. Disclaude is a multi-platform AI agent bot: it bridges messaging platforms (Feishu/Lark, REST) with agent-SDK runtimes (Claude Code CLI, pi, Codex CLI) and an on-prem scheduler. npm-workspaces monorepo.

## Commands

```bash
# Build & verify
npm run build            # tsc -b across project references (do this before running dist)
npm run type-check       # build + tsc --noEmit
npm run lint             # eslint packages/*/src --max-warnings=0
npm test                 # build + vitest --run
npm run test:coverage    # build + vitest --run --coverage (70% threshold, see Testing Rules)
npm run format:check     # prettier --check (format auto-fixes)

# macOS launchd service (scripts/launchd.mjs)
npm run launchd:start|stop|restart|logs|status|install|uninstall|generate
npm run launchd:chromium:start|stop|restart|logs|status   # Chromium CDP sidecar
#   launchd:restart = build + reload plist. launchd:logs tails combined/stdout/stderr (--lines=N).

# Docker (production, recommended) — builds inside the container, no local build needed
docker compose up -d --build    # build + start (Dockerfile.primary; Debian node:22-trixie-slim)
docker compose logs -f          # tail logs
docker compose down             # stop
#   Services: primary; chromium (profile chromium); filebeat (profile logging)
```

There is **no single-prompt CLI mode** (`--prompt`/`feishu` subcommands were removed, Issue #4601). Verify behavior with vitest or by exercising the REST `/api/push` route against a running node.

## Runtime Facts

| Thing | Value |
|---|---|
| API (REST IPC) port | **19200** default — plist, docker-compose, and the channel-CLI client all use it (`REST_IPC_DEFAULT_BASE_URL = http://localhost:19200`) |
| Key REST routes | `/api/health/detailed`, `/api/push`, `/api/send-card`, `/api/send-interactive`, `/api/send-message`, `/api/topic-stream` |
| launchd plist | `~/Library/LaunchAgents/com.disclaude.primary.plist`, label `com.disclaude.primary` |
| launchd logs | `~/Library/Logs/disclaude/{disclaude-combined.log, launchd-stdout.log, launchd-stderr.log}` (not `/tmp`) |
| Local workspace | `./workspace`; Docker mounts host `./workspace` → container `/data/workspace` |
| In-container user | `disclaude` (uid 1001); passwordless sudo limited to `apt-get` (audited to `/data/logs/sudo.log`). Base image pre-installs cmake, gcc/g++/make, python3-dev, gh, codex, lark CLI |
| Log rotation | Pino JSON (`packages/core/src/utils/logger.ts`). `logging.rotate` (env `LOG_ROTATE`) off by default; pino-roll writes `disclaude-combined.<n>.log` + `current.log` symlink. Docker sets `LOG_ROTATE=true`. `initLogger()` is **async** — await it |

Restart policy: only restart when the user asks. Prefer `npm run launchd:restart` (macOS) / `docker compose up -d --build` (Docker), after tests+lint+type-check pass.

## Architecture

| Package | Purpose |
|---|---|
| `packages/core` | Config, agents, SDK provider layer, IPC (REST client/server), channels abstraction, control commands, scheduling |
| `packages/primary-node` | Primary Node runtime: channel impls (Feishu, REST), ChatAgent pool, control handler, scheduler, HTTP API |
| `packages/channel-cli` | Channel messaging tools (`send_card`, `send_file`, …), talks to Primary Node over REST |
| `packages/voice-orchestrator` | Voice intent snapshot store (MVP) |

### Entry points

- `bin/disclaude.js` — routes `disclaude start` → `packages/primary-node/src/cli.ts`, `disclaude channel` → `packages/channel-cli/src/cli.ts`, `disclaude chromium-cdp` → launchd script.
- `packages/primary-node/src/cli.ts` is a thin bootstrap (pre-scans `--config` into `DISCLAUDE_CONFIG_PATH`, Issue #4654); the real parser is `cli-main.ts`: subcommand `start`, flags `--config/-c`, `--api-port`, `--api-token`. The channel CLI additionally accepts `--base-url` / `DISCLAUDE_REST_IPC_BASE_URL` (#4801).

### Data flow (Feishu mode)

```
Feishu WS event → handleMessageReceive() [channels/feishu/message-handler.ts]
  → message-filters.ts (dedup / bot-self / age)
  → /-command? → command-router.ts → control handler (@disclaude/core) or reset/status/stop fallback
  → agent.processMessage() (queued per chatId)
  → ChatAgent runs (SDK backend) → each SDK message sent immediately (no batching)
```

### Key modules

- **Agent system** — Template Method. `packages/core/src/agents/base-agent.ts` (abstract base, `createSdkOptions()`); `packages/primary-node/src/agents/chat-agent.ts` (`processMessage()` non-blocking queue, per-chatId instances, streaming input). Pool lives in `packages/core/src/agents/agent-pool.ts`; factory is `packages/primary-node/src/agents/factory.ts` (`AgentFactory.createChatAgent`, default `permissionMode: 'bypassPermissions'`). `history-manager.ts` attaches session-restore context + chat log paths so restarts keep context.
- **Disallowed tools** — `packages/primary-node/src/agents/disallowed-tools.ts` (`buildDisallowedTools()`). Base list always includes `EnterPlanMode` + `AskUserQuestion`; built-in cron/loop tools are also disallowed by default → persistent recurring work uses file-based `schedules/<slug>/SCHEDULE.md` + the `schedule` skill. `DISCLAUDE_ALLOW_BUILTIN_CRON=1` restores them.
- **SDK backend** — `packages/core/src/sdk/factory.ts` selects by `agent.agentBackend` (`claude` | `pi` | `codex`); providers under `packages/core/src/sdk/providers/<name>/`.
- **Feishu channel** — `packages/primary-node/src/channels/feishu/{message-handler,message-filters,ws-connection-manager,command-router,mention-detector}.ts` plus the newer `feishu-channel.ts` / `messaging/adapters/feishu-adapter.ts` split. Slash commands dispatch through a control handler (`/trigger` etc.); keep the reset/status/stop fallbacks working.
- **channel-cli tools** — `packages/channel-cli/src/tools/{send-card,send-file,send-message,interactive-message,push-to-agent}.ts`; the CLI subcommands are `send_card`, `send_file`, `send_text`, `send_interactive`, `push`. External MCP servers (`tools.mcpServers`) were **removed** (#4459) — migrate to Skills (`skills/`, `docs/skill-format-spec.md`).

## Configuration

Config is file-based (`disclaude.config.yaml`), **gitignored** (holds secrets). Copy from the committed, canonical **`disclaude.config.example.yaml`** — it is the authoritative full reference and this section only highlights essentials. Loader searches the project root, then `$HOME`.

- **Provider resolution**: `agent.provider` (`anthropic` | `glm`) if set; otherwise GLM wins when `glm.apiKey` is present, else Anthropic. GLM is usually routed through an Anthropic-compatible base URL (`glm.apiBaseUrl`).
- **Env fallback** is minimal: `ANTHROPIC_API_KEY` (when provider is anthropic), `WORKSPACE_DIR` / `DISCLAUDE_WORKSPACE_DIR` (override `workspace.dir`), `DISCLAUDE_CONFIG_PATH`, `DISCLAUDE_REST_IPC_BASE_URL`, logging knobs. See `docs/environment-variables.md`.
- **`agent` essentials**: `provider`, `agentBackend`, `model`, `permissionMode` (`default`|`bypassPermissions`; bots default bypass), tier models (`high/low/multimodalModel`), `maxConcurrentTasks`, `enableAgentTeams`, and the codex block below.
- **`feishu`**: `appId`/`appSecret` auto-enable the Feishu channel; `deduplication.{maxIds,maxAgeMs}`, `cliChatId`, `streamingCard`, `topicNotify`.
- Advanced keys (`channels.rest`, `transport` (local/http distributed), `messaging`, `sessionRestore`, `ruliu`, `glm` tiers) — see the example file.
- **`tools.disabled`** — array of tool names; `tools.mcpServers` ignored.

```yaml
workspace: { dir: "./workspace" }        # Docker: /data/workspace
agent:
  provider: anthropic                    # or glm
  model: "gpt-5.6-luna"
  agentBackend: codex                    # claude | pi | codex (agent SDK runtime, #4383)
  fullAccess: true                       # codex only → danger-full-access sandbox (#4818)
  codex: { maxActiveSessions: 3, maxConcurrentRuns: 2, execTimeoutMs: 0 }
feishu: { appId: "...", appSecret: "..." }
logging: { level: info, pretty: true, rotate: false }
env: { MY_VAR: "value" }
```

### Codex backend (`agentBackend: codex`, #4627)

Disclaude drives the **Codex CLI** (`codex exec`), authenticated via the **ChatGPT-subscription OAuth session** — not an API key. Consequently `provider` and `glm.*` are ignored (loader warns) and `model` must be a Codex/ChatGPT alias (`/^gpt-5(?:[.-].+)/`; legacy `gpt-5.1-codex` maps to the CLI default). Requires the `codex` binary + one-time `codex login`. Deep doc: `docs/codex-backend.md`.

Sandbox mapping (`permissionMode` → `codex exec` `sandbox_mode`, see `packages/core/src/sdk/providers/codex/sandbox-policy.ts`):

| Input | Sandbox |
|---|---|
| `fullAccess: true` | `danger-full-access` (unrestricted — filesystem-wide writes) |
| `codexSandbox: <level>` explicit | that level (only when `fullAccess` unset) |
| `permissionMode: default` (ask) | `read-only` (fail closed — headless exec has no asker) |
| normal / `bypassPermissions` | `workspace-write` |
| `disallowedTools` contains a mutation tool (Bash/Write/Edit/…) | capped at `read-only` — **outranks fullAccess** |
| `disallowedTools` contains WebSearch | **throws** — codex exec cannot disable web search |

Loader **rejects** a config that sets `fullAccess: true` together with a non-`danger-full-access` `codexSandbox` — don't pair them. Governance caps (`agent.codex.*`) bound alive sessions and concurrent `exec` children per process; at the session cap the idlest session is evicted (LRU), conversation resumes on its next message.

## Testing Rules

Vitest runs single-fork (OOM-safe), coverage via v8 with **70% thresholds** (lines/functions/branches/statements) on the covered set; several entry-point and agent dirs are coverage-excluded.

1. **No `vi.mock()` for external SDKs.** ESLint (`eslint.config.js`, `no-restricted-syntax`) blocks `vi.mock()` of `@anthropic-ai/*` and `@larksuiteoapi/*` — CI fails on it. Intercept HTTP with **nock** (or recorded fixtures).
2. **Network isolation** on by default (`tests/setup.ts`): external requests blocked, only localhost allowed; opt specific hosts in via `allowHost(host)`.
3. **Don't mock the mechanism under test** — keep the real setTimeout→abort chain (use `vi.useFakeTimers`), etc.
4. **Hygiene**: avoid needless `async`; free resources (IPC server/client, temp files) in `try/finally`; integration tests go under `tests/integration/`, not in `packages/*/src`.
5. **Build before delete** when refactoring tests: add replacement tests first so coverage doesn't drop below 70%, then remove old ones.

## Common Pitfalls

1. **Forgetting to build** — after edits run `npx tsc -b` before tests against `dist/`. (Docker builds in-container.)
2. **Bot echoes itself** — always reject `sender.sender_type === 'app'` (infinite-loop guard).
3. **Feishu duplicate events** — dedup on processed `message_id`.
4. **Stale docs** — this file and `disclaude.config.example.yaml` drift. Verify claims against source (`config/types.ts`, `cli-main.ts`, `scripts/launchd.mjs`) before trusting them.
5. **Uncommitted launchd state** — a running service holds the old build; restart picks up new code. `launchd:restart` both builds and reloads.

## Conventions

- **Docs live in JSDoc/comments, not standalone files** — don't add README/FEATURE docs unless asked; update this file only for architecture-level decisions. Code examples belong in the source's JSDoc.
- **Skills** — portable builtin capabilities live at `skills/<name>/SKILL.md`
  (for example, `channel`, `browser-use`, and `schedule`). Deployment-specific
  opt-in examples live at `examples/skills/<name>/SKILL.md`; `diagnose-logs` is
  intentionally kept there because it requires privileged access to local or
  Elasticsearch logs. See `docs/skill-format-spec.md`.
- **PRs** — keep under ~3 files / ~200 added lines (mechanical changes exempt); split large PRs (`Part 1/N of #N`); prefer `Related: #N` and use `Closes`/`Fixes` only when fully resolved; answer each review comment individually.
- **Logging** — Pino JSON; log agent outputs in full with a `content` field (searchable retrospection), not just lengths.

## Deep-dive pointers

- `docs/quickstart.md`, `docs/feishu-setup.md`, `docs/codex-backend.md`, `docs/log-forwarding.md`, `docs/log-rotation.md`, `docs/skill-format-spec.md`, `docs/cdp-endpoint.md`, `docs/environment-variables.md`
- Debugging: `npm run launchd:logs`, `tail -f ~/Library/Logs/disclaude/disclaude-combined.log`, or Kibana/ES if a shipper is configured.
