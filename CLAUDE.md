# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# === Development ===
npm run dev          # Start with auto-reload (tsx watch)
npm run build        # Build to dist/
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run test         # Run tests
npm run test:coverage # Run tests with coverage

# === Production (PM2) ===
npm run pm2:start     # Build and start PM2 service
npm run pm2:restart   # Restart after code changes (manual only - not automatic)
npm run pm2:reload    # Zero-downtime reload
npm run pm2:logs      # View logs (nostream mode - default, shows current logs)
npm run pm2:logs:follow # View logs with live tail (follow mode)
npm run pm2:logs:err  # View error logs only (nostream)
npm run pm2:logs:out  # View output logs only (nostream)
npm run pm2:status    # Check status
npm run pm2:stop      # Stop service
npm run pm2:delete    # Remove from PM2

# === CLI usage ===
disclaude feishu              # Start Feishu bot
disclaude --prompt "<query>"  # Single prompt query
```

## Architecture Overview

Disclaude is a multi-platform AI agent bot bridging messaging platforms (Feishu/Lark) with Claude Agent SDK capabilities.

### Entry Points

- **`src/cli-entry.ts`** - Main CLI entry, handles `disclaude feishu` and `disclaude --prompt`

### Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    cli-entry.ts                             │
│                  (Command Router)                           │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌──────────────┐         ┌──────────────┐
│  CLI Mode    │         │  Feishu Bot  │
│  (cli/)      │         │  (feishu/)   │
└──────┬───────┘         └──────┬───────┘
       │                        │
       └────────────────┬───────┴────────┐
                        ▼                ▼
                 ┌──────────────────────────┐
                 │      Pilot Agent         │
                 │    (agents/pilot.ts)     │
                 └────────────┬─────────────┘
                              ▼
                 ┌──────────────────────────┐
                 │   Claude Agent SDK       │
                 │   + MCP Servers          │
                 └──────────────────────────┘
```

### Key Modules

#### `src/config/` - Configuration Management

File-based configuration using `disclaude.config.yaml`:

- **GLM (Zhipu AI)** takes precedence over Anthropic if both configured
- `Config.getAgentConfig()` returns agent options:
  - `apiKey` - API key for the configured provider
  - `model` - Model identifier
  - `apiBaseUrl` - Optional custom endpoint
  - `provider` - `'anthropic'` or `'glm'`

**Configuration file structure**:
```yaml
workspace:
  dir: ./workspace
glm:
  apiKey: "..."
  model: "glm-5"
feishu:
  appId: "..."
  appSecret: "..."
agent:
  model: "claude-sonnet-4-20250514"
logging:
  level: debug
  rotate: true
tools:
  mcpServers:
    my-server:
      command: node
      args: ["./my-mcp-server.js"]
```

#### `src/agents/` - Agent System

Agent implementations using the Template Method pattern:

- **`base-agent.ts`** - Abstract base class with common functionality:
  - SDK configuration building via `createSdkOptions()`
  - `queryOnce()` - For static prompts (Evaluator, Executor)
  - `createQueryStream()` - For streaming input (Pilot)
  - Error handling and logging

- **`pilot.ts`** - Platform-agnostic direct chat abstraction:
  - **Streaming Input Mode**: Uses SDK's AsyncGenerator-based input
  - **Per-chatId Agent Instances**: Each conversation has its own persistent Agent
  - **Message Queue**: Messages queued and processed sequentially per chatId
  - **Session Cleanup**: Idle sessions cleaned up after timeout (default 30min)
  - `processMessage()` - Non-blocking, queues message for Agent processing
  - `executeOnce()` - Blocking one-shot query for CLI mode

- **`evaluator.ts`** - Task completion evaluation
- **`executor.ts`** - Task execution with progress reporting

#### `src/task/` - Task Orchestration

- **`dialogue-orchestrator.ts`** - Manages Evaluator-Executor flow
- **`iteration-bridge.ts`** - Handles iteration state and streaming messages
- **`mcp-utils.ts`** - MCP server utilities for task processing

#### `src/feishu/bot.ts` - WebSocket Bot

Feishu/Lark WebSocket implementation:

```typescript
// Key components
- processedMessageIds: Set<string>  // Message deduplication
- commands: /reset, /status, /help
- Message handler: handleMessageReceive()
- Uses Pilot for agent interactions
```

**Critical behaviors**:
- Ignores messages from bot itself (`sender.sender_type === 'app'`)
- Deduplicates via `message_id` to prevent infinite loops
- **Each SDK message is sent immediately** (no accumulation/batching)

#### `src/feishu/session.ts` - Session Storage

In-memory session management per chatId:

```typescript
getSessionId(chatId: string)    // Retrieve session ID
setSessionId(chatId, sessionId) // Store session ID
clearSession(chatId)            // Reset conversation
```

**Limitation**: Sessions are lost on restart (in-memory only).

#### `src/mcp/` - MCP Servers

Internal MCP servers providing custom tools:

- **`channel-mcp.ts`** - Platform-agnostic MCP implementation (send messages, files, cards, SDK integration) communicating via IPC
- **`feishu-mcp-server.ts`** - Thin stdio wrapper around channel-mcp.ts for external tool integration
- **`task-skill-mcp.ts`** - Custom skill integration

External MCP servers can be configured via `disclaude.config.yaml`.

### Data Flow (Feishu Mode)

```
WebSocket Event
    ↓
handleMessageReceive()
    ↓
Deduplication Check (processedMessageIds)
    ↓
Bot Self-Check? (skip if sender_type === 'app')
    ↓
Is Command? → handleCommand() → Send response
    ↓
pilot.processMessage() - queues message
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

| Mode | Setting | Behavior |
|------|---------|----------|
| **Bot** | `bypassPermissions` | Auto-approves all actions |
| **CLI** | `default` | Asks user for permissions |

**Note**: Pilot defaults to `bypassPermissions` for all modes unless explicitly configured.

### WebSocket Bot Gotchas

1. **Infinite loop prevention**: Bot must ignore its own messages (`sender.sender_type === 'app'`)
2. **Duplicate events**: Feishu may send duplicate events - use `processedMessageIds` Set
3. **Session storage**: Currently in-memory; sessions lost on restart
4. **Message timing**: Each SDK message is sent immediately, don't accumulate

### Build Output

- **Builder**: `tsup` (wraps esbuild)
- **Output dir**: `dist/`
- **Entry points**:
  - `dist/cli-entry.js` - Main binary entry point
  - `dist/mcp/` - Bundled MCP servers

### Testing

- **Framework**: Vitest
- **Test pattern**: `**/*.test.ts`
- **Coverage**: `@vitest/coverage-v8`

```bash
npm run test               # Run tests
npm run test -- --coverage # With coverage
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

## Development Workflow

### PM2 Restart Policy

**PM2 service will NOT restart automatically after code changes.**

- Code changes require **explicit manual restart** via `npm run pm2:restart`
- Always test changes with CLI mode before deploying
- Only restart PM2 when **explicitly requested** by the user

**Why?**
- Prevents accidental deployment of untested code
- Allows validation before production deployment
- Gives control over deployment timing
- Avoids surprising users with mid-conversation restarts

### Testing New Features with CLI Mode

**Recommended approach for rapid development:**

```bash
# 1. Make code changes
vim src/agents/pilot.ts

# 2. Build
npm run build

# 3. Test with CLI (instant feedback)
disclaude --prompt "Read src/agents/pilot.ts and summarize it"
disclaude --prompt "List all TypeScript files in src/"
disclaude --prompt "Run npm run type-check"

# 4. If working, deploy to Feishu (manual step)
npm run pm2:restart
```

### CLI vs Feishu Mode Comparison

| Aspect | CLI Mode (`--prompt`) | Feishu Mode (`feishu`) |
|--------|----------------------|------------------------|
| **Startup** | ⚡ Instant | 🔄 Requires WebSocket connection |
| **Output** | 📺 Full colored console | 💬 Chat messages (throttled) |
| **Session** | ❌ One-shot (`executeOnce()`) | ✅ Persistent (`processMessage()`) |
| **Permissions** | 🔒 `default` (ask user) | ✅ `bypassPermissions` (auto-approve) |
| **Best for** | 🔧 Development & testing | 🤖 Production & users |

**Note**: Pilot defaults to `bypassPermissions` for both modes unless explicitly configured otherwise.

## Working Directory

The agent uses `workspace/` as its working directory:
- File operations default to this directory
- Relative paths are resolved from here
- Useful for isolating agent-generated content

## Common Pitfalls

### 1. Forgetting to Build

After code changes, always run `npm run build` before:
- Testing with CLI mode
- Deploying to PM2

### 2. WebSocket Event Duplication

Feishu may send duplicate events. Always:
- Use `processedMessageIds` Set for deduplication
- Check `message_id` before processing

### 3. Bot Messaging Itself

When implementing new features:
- Always check `sender.sender_type === 'app'`
- Skip processing to prevent infinite loops

### 4. Session Loss on Restart

Current implementation uses in-memory sessions:
- All conversations reset on PM2 restart
- For persistence, consider implementing Redis/file-based storage

### 5. Tool Configuration

Tools are configured via `disallowedTools` in the agent classes:
- **Pilot** (`packages/worker-node/src/agents/pilot/index.ts`): Uses `disallowedTools: ['EnterPlanMode']`
- **BaseAgent**: Provides `createSdkOptions()` for SDK configuration

To enable/disable tools, modify the `disallowedTools` array in `Pilot.processMessage()` or `Pilot.executeOnce()`.

## Logging Guidelines

**IMPORTANT**: All Agent outputs MUST be logged in full, not just metadata (like length).

- **Agent outputs** (Evaluator/Executor): Must include a `content` field with the full text
- **Example**: `logger.debug({ content: text, textLength: text.length }, 'Agent output')`
- **Purpose**: Enables task retrospection and debugging by showing actual Agent output

### Why This Matters

When reviewing logs to understand what happened during a task execution:
- **Only `textLength`**: Tells you the output was 2463 bytes, but not what it said
- **With `content`**: You can see the actual instructions, responses, and reasoning

### Example Pattern

```typescript
// ❌ Bad - only metadata
logger.debug({
  iteration: this.iteration,
  textLength: text.length,
}, 'Manager output received');

// ✅ Good - includes content
logger.debug({
  iteration: this.iteration,
  textLength: text.length,
  content: text,  // Full output for retrospection
}, 'Manager output received');
```

### Locations

- `src/task/iteration-bridge.ts`: Evaluator and Executor outputs

## Debugging Tips

### Enable Verbose Logging

```typescript
// In src/feishu/bot.ts or src/cli/
console.log('[DEBUG]', { context });
```

### Check PM2 Logs

**IMPORTANT: Always use `--nostream` mode when checking logs programmatically or via Agent.**

```bash
# ✅ Recommended: Use npm scripts (default nostream mode)
npm run pm2:logs        # All logs (nostream, shows current logs)
npm run pm2:logs:err    # Error logs only (nostream)
npm run pm2:logs:out    # Output logs only (nostream)
npm run pm2:logs:follow # Live tail mode (follow, for manual monitoring)

# ❌ Avoid: Direct PM2 commands without --nostream
# pm2 logs disclaude-feishu  # This will hang waiting for Ctrl+C!

# ✅ If using PM2 directly, ALWAYS add --nostream
pm2 logs disclaude-feishu --nostream       # All logs
pm2 logs disclaude-feishu --nostream --err # Errors only
pm2 logs disclaude-feishu --nostream --lines 100 # Last 100 lines

# 🔧 For manual monitoring (follow mode)
pm2 logs disclaude-feishu  # Follows logs in real-time (Ctrl+C to exit)
```

**Why `--nostream` matters:**
- **Without `--nostream`**: PM2 enters "follow mode" and streams logs indefinitely, blocking the command until manually interrupted (Ctrl+C)
- **With `--nostream`**: PM2 outputs current logs and exits immediately - perfect for automation and Agent use
- **Default npm scripts**: All `pm2:logs` commands use `--nostream` by default, except `pm2:logs:follow` which intentionally uses follow mode

### WebSocket Connection Issues

1. Verify WebSocket mode is enabled in Feishu
2. Check network connectivity
3. Verify event subscriptions

### Tool Not Working

1. Check if tool is in `disallowedTools` array in `src/agents/pilot.ts`
2. Verify MCP server is configured in `disclaude.config.yaml` or built-in
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
| `site-miner` | Website information mining via Playwright | Read, Write, Bash, Glob, Grep, mcp__playwright__* |

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
  cliChatId: "optional-cli-chat-id"  # For CLI mode testing

# Agent configuration
agent:
  model: "claude-sonnet-4-20250514"  # Used when Anthropic is provider

# Logging configuration
logging:
  level: info          # trace | debug | info | warn | error
  file: undefined      # Optional log file path
  pretty: true         # Pretty print console output
  rotate: false        # Enable log rotation

# MCP external servers configuration
tools:
  mcpServers:
    my-server:
      command: node
      args: ["./my-mcp-server.js"]
      env:  # Optional environment variables for the MCP server
        MY_VAR: "value"

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
