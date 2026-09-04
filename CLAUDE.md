# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# === Development ===
npm run build          # Build all packages to dist/ (tsc -b) — do this first
npx tsx watch packages/primary-node/src/cli.ts start  # Run Primary Node with auto-reload
npx tsc -b             # Build to dist/
npm run type-check     # TypeScript type checking (tsc -b && tsc --noEmit)
npm run lint           # ESLint
npm run lint:fix       # ESLint with auto-fix
npm test               # Run tests (build + vitest --run)
npm run test:coverage # Run tests with coverage

# === Production (Docker — recommended) ===
# No local build needed. Docker builds inside the container.
docker compose up -d              # Build and start
docker compose up -d --build      # Force rebuild
docker compose logs -f            # View logs (live tail)
docker compose down               # Stop

# === Production (launchd — macOS local) ===
npm run launchd:install   # First-time: generate plist + build + start
npm run launchd:start     # Build + start service
npm run launchd:stop      # Stop service
npm run launchd:restart   # Build + restart service
npm run launchd:logs      # View recent logs
npm run launchd:status    # Check service status
npm run launchd:uninstall # Remove plist and stop service

# === CLI usage (Issue #4601: --prompt / feishu subcommands were removed) ===
npx tsx packages/primary-node/src/cli.ts start               # Start the Primary Node (Feishu bot + REST API)
npx tsx packages/primary-node/src/cli.ts start --api-port 9200 --api-token <token>
# `disclaude start` / `disclaude mcp` route through bin/disclaude.js; disclaude-push is packages/primary-node/src/push-cli.ts
# There is NO single-prompt CLI mode anymore — run tests (vitest) or the REST /api/push route instead.
```

## Architecture Overview

Disclaude is a multi-platform AI agent bot bridging messaging platforms (Feishu/Lark) with agent-SDK capabilities. It is an npm-workspaces monorepo (Issue #4601: the old flat `src/` layout no longer exists):

| Package | Purpose |
|---------|---------|
| `packages/core` | Config, agents (base/message-builder), IPC (REST), channels abstraction, scheduling, SDK provider layer |
| `packages/primary-node` | Primary Node runtime: Feishu channel + bot, ChatAgent pool, REST API (`--api-port`), `push-cli` |
| `packages/channel-cli` | Channel messaging tools and CLI, talks to Primary Node over REST |
| `packages/voice-orchestrator` | Voice intent snapshot store (MVP foundation) |

### Entry Points

- **`bin/disclaude.js`** - Unified CLI router: `disclaude start` → `packages/primary-node/src/cli.ts`, `disclaude channel` → `packages/channel-cli/src/cli.ts`
- **`packages/primary-node/src/cli.ts`** - Primary Node entry; only subcommand is `start` (+ `--config` / `--api-port` / `--api-token`)
- **`packages/primary-node/src/push-cli.ts`** - `disclaude-push` external push CLI (REST-only, POST /api/push)

### Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              packages/primary-node/src/cli.ts               │
│                  (`disclaude start`)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌──────────────┐         ┌──────────────┐
│ Feishu WS    │         │  REST API    │
│ channel      │         │ (--api-port) │
└──────┬───────┘         └──────┬───────┘
       │                        │
       └────────────────┬───────┴────────┐
                        ▼                ▼
                 ┌──────────────────────────┐
                 │  ChatAgent pool          │
                 │  (primary-agent-pool)    │
                 └────────────┬─────────────┘
                              ▼
                 ┌──────────────────────────┐
                 │  Agent SDK provider      │
                 │  (claude | pi) + Skills  │
                 └──────────────────────────┘
```

### Key Modules

#### `packages/core/src/config/` - Configuration Management

File-based configuration using `disclaude.config.yaml`:

- **GLM (Zhipu AI)** takes precedence over Anthropic if both configured
- `Config.getAgentConfig()` returns agent options:
  - `apiKey` - API key for the configured provider
  - `model` - Model identifier
  - `apiBaseUrl` - Optional custom endpoint
  - `provider` - `'anthropic'` or `'glm'` (model layer)
  - `agentBackend` - `'claude'` or `'pi'` (agent-runtime layer, orthogonal to `provider`, default `'claude'`)

**Configuration file structure**:
```yaml
workspace:
  dir: ./workspace   # Docker: /data/workspace | Local: ./workspace
glm:
  apiKey: "..."
  model: "glm-5"
feishu:
  appId: "..."
  appSecret: "..."
agent:
  model: "claude-sonnet-4-20250514"
  agentBackend: claude   # claude | pi (agent SDK runtime; #4383)
logging:
  level: debug
  rotate: true
```

#### `packages/core/src/agents/` + `packages/primary-node/src/agents/` - Agent System

Agent implementations using the Template Method pattern:

- **`base-agent.ts`** (core) - Abstract base class with common functionality:
  - SDK configuration building via `createSdkOptions()`
  - Error handling and logging

- **`chat-agent.ts`** (primary-node) - Platform-agnostic direct chat abstraction:
  - **Streaming Input Mode**: Uses SDK's AsyncGenerator-based input
  - **Per-chatId Agent Instances**: Each conversation has its own persistent Agent (pool: `primary-agent-pool.ts`)
  - **Message Queue**: Messages queued and processed sequentially per chatId
  - **Session Cleanup**: Idle sessions cleaned up after timeout
  - `processMessage()` - Non-blocking, queues message for Agent processing
  - `runOnce()` - Blocking one-shot query (still on ChatAgent, but **no CLI flag exposes it** — Issue #4601)

#### `packages/primary-node/src/channels/feishu/` - Feishu Channel & Bot

Feishu/Lark WebSocket implementation (split into focused modules):

- **`message-handler.ts`** - `handleMessageReceive()` pipeline: dedup → bot-self check → age check → thread/history context → command router → agent
- **`message-filters.ts`** - Pure verdict functions for the three early guard clauses (duplicate / bot / old)
- **`ws-connection-manager.ts`** - WebSocket connection manager & auto-reconnect
- **`command-router.ts`** - Slash commands (`/reset`, `/status`, `/help`, `/project`, ...)
- **`mention-detector.ts`** - @mention detection (group trigger modes)

**Critical behaviors**:
- Ignores messages from bot itself (`sender.sender_type === 'app'`)
- Deduplicates via processed `message_id` to prevent infinite loops
- **Each SDK message is sent immediately** (no accumulation/batching)

#### Session / History Storage

Conversation history is managed by `packages/primary-node/src/agents/history-manager.ts` (Issue #4125): it attaches persisted (session-restore) history context and chat log file paths to each message, so a restarted process restores prior context for ongoing chats.

#### `packages/channel-cli/` - Channel Tool Implementations

First-party channel tool implementations (`send_text`, `send_file`, `send_card`, `send_interactive`, `push_to_agent`) are owned by the channel CLI. Agents invoke them through `bin/disclaude.js channel`. The tools communicate with the Primary Node **over REST** (`RestIpcClient`).

The external-MCP-server loader (config `tools.mcpServers`) was **removed** (#4459 Scope 4). External tools migrate to CLI Skills — see `docs/skill-format-spec.md`, `skills/channel/`, and `skills/browser-use/`.

### Data Flow (Feishu Mode)

```
WebSocket Event
    ↓
handleMessageReceive() (message-handler.ts)
    ↓
Message filters: dedup / bot-self / age (message-filters.ts)
    ↓
Is Command? → command-router.ts → Send response
    ↓
agent.processMessage() - queues message
    ↓
Agent loop processes queue → generates response
    ↓
For each SDK message:
    extractText() → sendMessage() immediately
```

### Configuration Priority

1. **Config file** (`disclaude.config.yaml`) - Primary source
2. **Environment variables** - Fallback for Anthropic API key only

### Permission Modes

Chat agents default to `bypassPermissions` (`packages/primary-node/src/agents/factory.ts` — `permissionMode ?? 'bypassPermissions'`); override per-call via the factory options. The pi backend has no built-in permission system — gating is the `beforeToolCall` deny hook over `buildDisallowedTools()` (#4389).

### WebSocket Bot Gotchas

1. **Infinite loop prevention**: Bot must ignore its own messages (`sender.sender_type === 'app'`)
2. **Duplicate events**: Feishu may send duplicate events - processed-message dedup drops them
3. **Message timing**: Each SDK message is sent immediately, don't accumulate

### Build Output

- **Builder**: `tsc -b` (root `package.json` build script; follows project references core → channel-cli/primary-node). `tsup` is a leftover devDependency and is NOT used.
- **Output**: per-package `dist/` (e.g. `packages/primary-node/dist/cli.js`)
- **Binaries** (root `package.json` `bin`):
  - `disclaude` → `bin/disclaude.js` (subcommand router)
  - `disclaude-primary` → `packages/primary-node/dist/cli.js`
  - `disclaude-push` → `packages/primary-node/dist/push-cli.js`

### Testing

- **Framework**: Vitest
- **Test pattern**: `**/*.test.ts`
- **Coverage**: `@vitest/coverage-v8`

```bash
npx vitest run               # Run tests
npx vitest run --coverage    # With coverage
```

## Testing Rules (Mandatory)

These rules are enforced to prevent AI agents from "self-justifying" tests by modifying mock return values to keep tests green while actual behavior is broken.

### 1. Prohibit vi.mock() for External SDKs

**严禁对外部 SDK 使用 vi.mock()**：`@anthropic-ai/sdk`、`@larksuiteoapi/node-sdk` 等外部网络库不得使用 vi.mock()，违反此规则将导致 ESLint 报错并阻断 CI。

```typescript
// ❌ PROHIBITED - Will cause ESLint error
vi.mock('@anthropic-ai/sdk');
vi.mock('@larksuiteoapi/node-sdk');

// ✅ CORRECT - Use nock for network interception
import nock from 'nock';
nock('https://api.anthropic.com')
  .post('/v1/messages')
  .reply(200, { content: 'mocked response' });
```

### 2. Network Tests Must Use nock

**网络交互测试必须使用 nock**：需要模拟 HTTP 交互时，在 `tests/fixtures/recordings/` 提供录制的请求/响应 JSON，通过 nock 加载后测试。

```typescript
// ✅ Using nock for HTTP mocking
import nock from 'nock';

describe('API tests', () => {
  afterEach(() => nock.cleanAll());

  it('should fetch data', async () => {
    nock('https://api.example.com')
      .get('/data')
      .reply(200, { result: 'success' });

    const result = await fetchData();
    expect(result).toEqual({ result: 'success' });
  });
});
```

### 3. Build Before Delete

**先建后删原则**：重构测试时，必须先新增替代测试并确保覆盖率不下降，再删除旧的 vi.mock 代码。

**Why?** The project has a 70% coverage threshold. Deleting tests before adding replacements will cause CI to fail due to coverage drops.

### Network Isolation

All tests run with network isolation enabled via `tests/setup.ts`:
- External network requests are BLOCKED by default
- Only `localhost` and `127.0.0.1` are allowed
- Use `allowHost()` helper for specific test scenarios requiring real network access

### 4. Test Anti-Patterns

**不要 mock 你正在测试的机制本身。** 如测试超时行为，必须保留真实的 setTimeout→abort 链路：

```typescript
// ❌ 跳过真实链路，测试无效
globalThis.setTimeout = (cb) => cb() as any;

// ✅ 用 vi.useFakeTimers 验证真实流程
vi.useFakeTimers();
const promise = fetchWithTimeout(url, 5000);
await vi.advanceTimersByTimeAsync(5100);
```

**避免无意义的 async**：mock 函数直接返回 Promise，不加 async：

```typescript
// ❌ async 无 await
sendInteractive: async (_chatId, _params) => { return { id: 1 }; }

// ✅ 直接返回
sendInteractive: (_chatId, _params) => Promise.resolve({ id: 1 })
```

**资源必须 try/finally 清理**：IPC server/client、临时文件等需确保断言失败时也能释放：

```typescript
const server = new IpcServer();
try { /* assertions */ } finally { await server.stop().catch(() => {}); }
```

**集成测试放 `tests/integration/`**，不放 `packages/*/src/` 内的测试目录（后者会混入单元测试）。

## Development Workflow

### Service Restart Policy

**Docker (recommended):** `docker compose up -d --build` handles build + restart. No local build step needed.

**macOS (launchd):** `npm run launchd:restart` automatically builds before restarting.

General rules:
- Always test changes (vitest + lint + type-check) before deploying
- Only restart when **explicitly requested** by the user
- **Why?** Prevents accidental deployment of untested code and mid-conversation restarts

### Testing New Features

**Recommended approach for rapid development (no CLI prompt mode — Issue #4601):**

```bash
# 1. Make code changes
vim packages/primary-node/src/agents/chat-agent.ts

# 2. Type-check / build
npx tsc -b

# 3. Run the relevant tests (instant feedback)
npx vitest run packages/primary-node/src/agents/chat-agent.test.ts

# 4. Exercise a live agent turn via the REST API (if the service runs with --api-port):
curl -X POST http://localhost:9200/api/push -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"oc_xxx","message":"Read packages/primary-node/src/agents/chat-agent.ts and summarize it"}'

# 5. If working, deploy:
#    Docker: docker compose up -d --build
```

There is **no single-prompt CLI mode** anymore (`--prompt` / `feishu` subcommands were removed; `runOnce()` exists on ChatAgent but no CLI flag exposes it). Use vitest for code-level verification and the REST `/api/push` route (or `disclaude-push`) for end-to-end agent turns against a running service.

## Working Directory

The agent uses `workspace/` as its working directory:
- File operations default to this directory
- Relative paths are resolved from here
- Useful for isolating agent-generated content

## Common Pitfalls

### 1. Forgetting to Build

After code changes, always run `npx tsc -b` before:
- Running tests against built output
- **Note**: Docker deployments build inside the container — no local build needed

### 2. WebSocket Event Duplication

Feishu may send duplicate events. Always:
- Dedup on `message_id` (the processed-message check in `message-handler.ts`)
- Check `message_id` before processing

### 3. Bot Messaging Itself

When implementing new features:
- Always check `sender.sender_type === 'app'`
- Skip processing to prevent infinite loops

### 4. Tool Configuration

Tools are configured via `buildDisallowedTools()` (`packages/primary-node/src/agents/disallowed-tools.ts`, Issue #4181):
- Base list always included: `EnterPlanMode` (keeps agent in execution mode), `AskUserQuestion` (disclaude uses interactive cards instead)
- Session-only built-in cron/loop tools (`CronCreate`/`CronList`/`CronDelete`/`ScheduleWakeup`) are also disallowed by default — persistent recurring work goes through the file-based `schedules/<slug>/SCHEDULE.md` + `schedule` skill
- Set `DISCLAUDE_ALLOW_BUILTIN_CRON=1` to restore the built-in cron tools

To change the list, modify `BASE_DISALLOWED_TOOLS` / `BUILTIN_CRON_TOOLS` in `disallowed-tools.ts`.

### 5. Installing System Packages (Container)

Inside Docker the agent runs as the non-root `disclaude` user (uid 1001). It has **passwordless sudo** (restricted to `apk` only), so install Alpine packages on demand:

```bash
sudo apk add llvm19-dev        # -dev pkgs are version-pinned in Alpine, use `apk search` to find exact names
sudo apk search llvm           # find available llvm packages
```

- `cmake` and `python3-dev` are pre-baked into the image as part of the `.build-deps` virtual group, so common native builds work without a network fetch. If space is reclaimed via `apk del .build-deps`, these tools will be removed and must be reinstalled with `sudo apk add`.
- The process deliberately stays uid 1001 (not root) to keep `/data/workspace` files owned by the host user; elevate via `sudo apk` only for system package installs.

## Logging Guidelines

**IMPORTANT**: The application uses Pino (structured JSON logging) which writes to stdout/stderr and optionally to local files. Since v0.4.0, application-level Elasticsearch transport has been removed in favor of infrastructure-level log forwarding (see `docs/log-forwarding.md`). Log shippers like Fluentd or Filebeat can forward logs to Elasticsearch, Loki, or other backends.

### Logging — Implications for Code

All Agent outputs MUST be logged in full, not just metadata (like length). Structured fields matter for searchability regardless of the log backend.

- **Agent outputs**: Must include a `content` field with the full text
- **Example**: `logger.debug({ content: text, textLength: text.length }, 'Agent output')`
- **Purpose**: Enables task retrospection and debugging via full-text search in your log backend

### Why This Matters

When reviewing logs (via Kibana, Loki, or local files) to understand what happened during a task execution:
- **Only `textLength`**: Tells you the output was 2463 bytes, but not what it said
- **With `content`**: You can Kibana-search the actual instructions, responses, and reasoning

### Example Pattern

```typescript
// ❌ Bad - only metadata
logger.debug({
  iteration: this.iteration,
  textLength: text.length,
}, 'Manager output received');

// ✅ Good - includes content (searchable in ES)
logger.debug({
  iteration: this.iteration,
  textLength: text.length,
  content: text,  // Full output for ES/Kibana retrospection
}, 'Manager output received');
```

### Locations

- `packages/core/src/utils/logger.ts`: Pino logger factory (JSON structured output)

## Debugging Tips

### Enable Verbose Logging

```typescript
// In packages/primary-node/src/channels/feishu/message-handler.ts or the module under test
console.log('[DEBUG]', { context });
```

### Check Service Logs

**IMPORTANT**: Logs can be forwarded to backends like Elasticsearch/Loki via infrastructure-level log shippers (see `docs/log-forwarding.md`). Local files are short-lived and mainly useful for real-time tailing during active development. For historical analysis and searching, use your configured log backend.

**Elasticsearch/Kibana (if configured):**
- Use Kibana for log search, filtering, and retrospection
- Pino writes structured JSON logs — all fields (`content`, `context`, `level`, etc.) are searchable
- See `docs/log-forwarding.md` for setup instructions

**launchd (macOS) — local real-time only:**

```bash
npm run launchd:logs          # View recent logs (stdout + stderr)
tail -100 /tmp/disclaude-stdout.log   # stdout directly
tail -100 /tmp/disclaude-stderr.log   # stderr directly
tail -f /tmp/disclaude-stdout.log     # Live tail (Ctrl+C to exit)
```

### WebSocket Connection Issues

1. Verify WebSocket mode is enabled in Feishu
2. Check network connectivity
3. Verify event subscriptions

### Tool Not Working

1. Check if the tool is in the `buildDisallowedTools()` list (`packages/primary-node/src/agents/disallowed-tools.ts`)
2. Channel tools live in `packages/channel-cli/src/tools/` and need the Primary Node REST API reachable; browser automation is the `browser-use` skill (`skills/browser-use/`)
3. Check SDK version compatibility

## Error Handling Patterns

```typescript
// Wrap async operations
try {
  await riskyOperation();
} catch (error) {
  console.error('[Error]', error.message);
  // Send user-friendly message
}

// Handle WebSocket disconnection
ws.on('close', () => {
  // Implement reconnection logic
});
```

## Adding Custom Skills

Create `.claude/skills/<skill-name>/SKILL.md`:

```markdown
# Skill: <skill-name>

<skill instructions here>
```

The skill will be available to the agent automatically.

## Project-Level Agent Definitions

Claude Code supports project-level agent definitions in `.claude/agents/`. These are Markdown files with YAML frontmatter that define specialized sub-agents.

### Preset Agents

Disclaude bundles preset agent definitions that are automatically copied to `.claude/agents/` on startup:

| Agent | Description | Tools |
|-------|-------------|-------|
| `mac-screen-control` | macOS screen/keyboard/mouse control via Accessibility API and CGEvent | Read, Write, Bash, Glob, Grep |

> Browser automation is not a preset agent. It is the [`browser-use`](skills/browser-use/SKILL.md) skill (piped-Python CLI, no MCP grants) — invoke it directly from the conversation.

### Agent Definition Format

Create `.claude/agents/<agent-name>.md`:

```markdown
---
name: <agent-name>
description: When to use this agent (Claude uses this for auto-delegation)
tools: ["Read", "Write", "Bash"]
model: sonnet
---

# Agent Name

Detailed instructions for the agent...
```

### Key Fields

| Field | Description |
|-------|-------------|
| `name` | Unique agent identifier |
| `description` | Claude uses this to decide when to delegate to this agent |
| `tools` | Available tools for this agent |
| `model` | Model to use (`sonnet`, `opus`, `haiku`) |

### Relationship to Skills

| File | Defines | Purpose |
|------|---------|---------|
| `SKILL.md` | Capabilities (what to do) | Task execution instructions |
| Agent `.md` | Behavior (how to act) | Persistent agent personality and workflow |

### User Customizations

User-created agent files in `.claude/agents/` are **never overwritten** by preset agents during setup.

## Documentation Guidelines

### Code Comments Over Separate Documentation

**IMPORTANT**: Do NOT create standalone documentation files (README, guides, etc.) unless explicitly requested by the user.

- **Code explanations**: Write them as JSDoc comments in the source code
- **Usage examples**: Include them in code comments
- **Architecture notes**: Add them to the relevant source files
- **Rationale**: Explain design decisions in inline comments

**Example**:
```typescript
/**
 * Feishu interactive card builder for Write tool content preview.
 *
 * This module generates visual cards when the Agent writes files:
 * - Small files (≤50 lines): Shows complete content
 * - Large files (>50 lines): Shows truncated preview (first/last 10 lines)
 *
 * @see https://open.feishu.cn/document/common-capabilities/message-card
 */
export function buildWriteContentCard(...) {
  // Implementation here
}
```

**When to add documentation**:
- ❌ Don't: Create separate FEATURE.md, IMPLEMENTATION.md, etc.
- ✅ Do: Add comprehensive JSDoc to functions and classes
- ✅ Do: Update CLAUDE.md for architecture-level decisions
- ✅ Do: Add inline comments for complex logic

## PR Submission Guidelines

### Change Threshold

- PRs exceeding **3 files or 200 added lines** (`git diff --stat`) of meaningful changes should be split into smaller PRs
- Each PR should address a single concern (one issue, one refactor, one fix)
- If a change naturally spans multiple files (e.g., renaming), document why splitting is not practical
- Mechanical changes (config sync, doc formatting, dependency bumps) are exempt from this threshold

### Reviewer Feedback Response

- Address **each review comment individually** — do not batch responses
- If disagreeing with feedback, explain the reasoning clearly rather than ignoring it
- When a reviewer suggests an alternative approach, evaluate it before pushing back
- After addressing feedback, explicitly confirm which comments were resolved

### Issue Linking

- Use `Related: #N` by default — avoid premature issue closure
- Use `Closes #N` / `Fixes #N` only when the PR **fully resolves** the issue
- Never use closure keywords for partial implementations

### Split PRs

- When splitting a large change, cross-reference with `Part 1/N of #N` in each PR description
- Each split PR must be independently reviewable and mergeable

## Configuration Reference

### File-Based Configuration (`disclaude.config.yaml`)

All configuration is read from `disclaude.config.yaml`. Create this file in your project root or home directory.

```yaml
# Workspace directory for file operations
workspace:
  dir: ./workspace

# GLM (Zhipu AI) configuration - takes precedence over Anthropic
glm:
  apiKey: "your-glm-api-key"
  model: "glm-5"
  apiBaseUrl: "https://open.bigmodel.cn/api/anthropic"  # optional

# Feishu/Lark bot configuration
feishu:
  appId: "your-app-id"
  appSecret: "your-app-secret"

# Agent configuration
agent:
  model: "claude-sonnet-4-20250514"  # Used when Anthropic is provider
  agentBackend: claude              # claude | pi — agent SDK runtime (#4383)

# Logging configuration
# NOTE: Logs can be forwarded to Elasticsearch/Loki via infrastructure-level log shippers.
# See docs/log-forwarding.md for setup. Local files are short-lived by default.
logging:
  level: info          # trace | debug | info | warn | error
  file: undefined      # Optional log file path
  pretty: true         # Pretty print console output
  rotate: false        # Enable log rotation

# External MCP servers (tools.mcpServers) were REMOVED (#4459 Scope 4).
# Migrate external tools to a CLI Skill — see docs/skill-format-spec.md.

# Global environment variables (passed to all agent processes)
env:
  MY_GLOBAL_VAR: "value"
```

### Environment Variables (Fallback)

Environment variables are **only** used as fallback for Anthropic API key:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key (fallback if not in config file) |

**Note**: GLM configuration must be in `disclaude.config.yaml` - environment variables are not supported for GLM.
