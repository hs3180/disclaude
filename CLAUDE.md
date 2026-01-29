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

# === Production (PM2) ===
npm run pm2:start    # Build and start PM2 service
npm run pm2:restart  # Restart after code changes (manual only - not automatic)
npm run pm2:reload   # Zero-downtime reload
npm run pm2:logs     # View logs
npm run pm2:status   # Check status
npm run pm2:stop     # Stop service
npm run pm2:delete   # Remove from PM2

# === CLI usage ===
disclaude feishu              # Start Feishu bot
disclaude --prompt "<query>"  # Single prompt query
```

## Environment Initialization (.bashrc-like Mechanism)

Disclaude supports automatic environment initialization through bash scripts, similar to `.bashrc`.

### Script Files

On startup, Disclaude looks for and executes bash initialization scripts in the working directory (in priority order):

1. **`.disclauderc`** - Project-specific environment initialization (checked first)
2. **`.env.sh`** - Generic shell environment setup (fallback)

Only the first script found is executed.

### Use Cases

- **Conda environments**: Activate specific conda environments for Python subprocesses
- **Custom PATH**: Add directories to PATH for subprocess execution
- **Environment-specific configs**: Set different variables for dev/staging/production
- **Proxy settings**: Configure HTTP/HTTPS proxies for API calls
- **Custom variables**: Set application-specific environment variables

### Example Configuration

```bash
#!/bin/bash
# .disclauderc example

# Activate conda environment
source ~/anaconda/anaconda3/bin/activate falcon

# Add conda environment to PATH
export PATH="$HOME/anaconda/anaconda3/envs/falcon/bin:$PATH"

# Set conda environment variables
export CONDA_DEFAULT_ENV="falcon"
export CONDA_PREFIX="$HOME/anaconda/anaconda3/envs/falcon"

# Set Python interpreter
export PYTHON="$HOME/anaconda/anaconda3/envs/falcon/bin/python"
```

### Execution Behavior

- Scripts are sourced in a bash shell before main service logic
- Environment variables are captured and merged into `process.env`
- **Existing variables are not overwritten** - only new variables are added
- Script execution errors are logged but don't prevent startup
- Use PM2 logs to verify script execution: `pm2 logs disclaude-feishu`

### Setup Steps

1. **Copy example script**:
   ```bash
   cp .disclauderc.example .disclauderc
   ```

2. **Customize for your environment**:
   ```bash
   vim .disclauderc
   ```

3. **Restart Disclaude**:
   ```bash
   npm run build
   npm run pm2:restart
   ```

4. **Verify loading**:
   ```bash
   pm2 logs disclaude-feishu --lines 50
   # Look for: "Environment initialization script loaded"
   ```

### Important Notes

- Scripts must be valid bash syntax
- Avoid long-running operations (scripts run synchronously during startup)
- Use `source` to activate conda environments (not `conda activate`)
- Multi-line shell functions are not captured as environment variables
- For security, scripts are only loaded from the working directory

### Debugging

If environment variables aren't loading as expected:

1. **Check script execution in logs**:
   ```bash
   pm2 logs disclaude-feishu --err
   ```

2. **Test script manually**:
   ```bash
   bash -lc "source .disclauderc && env | grep CONDA"
   ```

3. **Verify variables in process**:
   - Add debug logging in your code
   - Check `process.env.VARIABLE_NAME`
   - Use `disclaude --prompt "echo $CONDA_DEFAULT_ENV"`

## Architecture Overview

Disclaude is a multi-platform AI agent bot bridging messaging platforms (Feishu/Lark) with Claude Agent SDK capabilities.

### Entry Points

- **`src/cli-entry.ts`** - Primary entry, handles `disclaude feishu` and `disclaude --prompt`
- **`src/index.ts`** - Legacy entry, shows usage hint

### Core Components

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
       │                ┌───────┴────────┐
       │                │  Session Mgr   │
       │                │  (in-memory)   │
       │                └───────┬────────┘
       │                        │
       └────────────────┬───────┴────────┐
                        ▼                ▼
                 ┌──────────────────────────┐
                 │      Agent Client        │
                 │      (agent/client.ts)   │
                 └────────────┬─────────────┘
                              ▼
                 ┌──────────────────────────┐
                 │   Claude Agent SDK       │
                 │   + MCP Servers          │
                 └──────────────────────────┘
```

### Key Modules

#### `src/config/` - Environment Configuration

Static configuration from environment variables:

- **GLM (Zhipu AI)** takes precedence over Anthropic if both configured
- `Config.getAgentConfig()` returns agent options:
  - `apiKey` - API key for the configured provider
  - `model` - Model identifier
  - `permissionMode` - `bypassPermissions` for bot, `default` for CLI

#### `src/agent/client.ts` - Agent SDK Wrapper

Core wrapper around `@anthropic-ai/claude-agent-sdk`:

```typescript
// Main function
queryStream(prompt: string, sessionId?: string): AsyncIterable<AgentMessage>

// Key behaviors
- Handles session persistence via SDK's `resume` option
- Injects environment variables for subprocess execution
- Configures allowed/disallowed tools
- Sets up MCP server connections
```

**Tool Configuration**: Edit `allowedTools` in this file to enable/disable tools. Web tools (`WebSearch`, `WebFetch`) are disabled by default.

#### `src/feishu/bot.ts` - WebSocket Bot

Feishu/Lark WebSocket implementation:

```typescript
// Key components
- processedMessageIds: Set<string>  // Message deduplication
- commands: /reset, /status, /help
- Message handler: handleMessageReceive()
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

#### `src/utils/sdk.ts` - SDK Utilities

Helper functions for SDK message handling:

```typescript
extractTextFromSDKMessage(message: AgentMessage): string
getNodeBinDir(): string  // For subprocess PATH
```

#### `src/utils/output-adapter.ts` - Output Adapter

Converts SDK messages to platform-specific formats:

- **CLI mode**: Full colored console output
- **Feishu mode**: Text messages with rate limiting/throttling

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
processAgentMessage()
    ↓
For each SDK message:
    extractText() → sendMessage() immediately
```

### Configuration Priority

1. **GLM API** - If `GLM_API_KEY` is set, uses Zhipu AI
2. **Anthropic** - Falls back to `ANTHROPIC_API_KEY`

### Permission Modes

| Mode | Setting | Behavior |
|------|---------|----------|
| **Bot** | `bypassPermissions` | Auto-approves all actions |
| **CLI** | `default` | Asks user for permissions |

### WebSocket Bot Gotchas

1. **Infinite loop prevention**: Bot must ignore its own messages (`sender.sender_type === 'app'`)
2. **Duplicate events**: Feishu may send duplicate events - use `processedMessageIds` Set
3. **Session storage**: Currently in-memory; sessions lost on restart
4. **Message timing**: Each SDK message is sent immediately, don't accumulate

### Build Output

- **Builder**: `tsup` ( wraps esbuild)
- **Output dir**: `dist/`
- **Entry points**:
  - `dist/cli-entry.js` - Main binary entry point
  - `dist/index.js` - Legacy compatibility

### Testing

- **Framework**: Vitest
- **Test pattern**: `**/*.test.ts`
- **Coverage**: `@vitest/coverage-v8`

```bash
npm run test               # Run tests
npm run test -- --coverage # With coverage
```

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
vim src/agent/client.ts

# 2. Build
npm run build

# 3. Test with CLI (instant feedback)
disclaude --prompt "Read src/agent/client.ts and summarize it"
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
| **Session** | ❌ One-shot | ✅ Persistent (in-memory) |
| **Permissions** | 🔒 `default` (ask user) | ✅ `bypassPermissions` (auto-approve) |
| **Best for** | 🔧 Development & testing | 🤖 Production & users |

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

When adding new tools:
- Add to `allowedTools` in `src/agent/client.ts`
- Web tools are disabled by default for security

## Debugging Tips

### Enable Verbose Logging

```typescript
// In src/feishu/bot.ts or src/cli/
console.log('[DEBUG]', { context });
```

### Check PM2 Logs

```bash
# All logs
npm run pm2:logs

# Errors only
npm run pm2:logs --err

# Last 100 lines
pm2 logs disclaude-feishu --lines 100
```

### WebSocket Connection Issues

1. Verify WebSocket mode is enabled in Feishu
2. Check network connectivity
3. Verify event subscriptions

### Tool Not Working

1. Check if tool is in `allowedTools` list
2. Verify MCP server is configured
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

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKSPACE_DIR` | Optional | Working directory for file operations (default: current directory) |
| `FEISHU_APP_ID` | Bot mode | Feishu/Lark application ID |
| `FEISHU_APP_SECRET` | Bot mode | Feishu/Lark application secret |
| `ANTHROPIC_API_KEY` | One of | Anthropic Claude API key |
| `GLM_API_KEY` | One of | Zhipu AI API key (takes precedence) |
| `CLAUDE_MODEL` | Optional | Model identifier |
| `GLM_MODEL` | Optional | GLM model identifier |
| `GLM_API_BASE_URL` | Optional | GLM API endpoint |
