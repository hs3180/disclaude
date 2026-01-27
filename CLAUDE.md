# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Start with auto-reload (tsx watch)
npm run build        # Build to dist/
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run test         # Run tests

# Production (PM2)
npm run pm2:start    # Build and start PM2 service
npm run pm2:restart  # Restart after code changes
npm run pm2:logs     # View logs
npm run pm2:stop     # Stop service

# CLI usage
disclaude feishu              # Start Feishu bot
disclaude --prompt "<query>"  # Single prompt query
```

## Architecture Overview

Disclaude is a multi-platform AI agent bot bridging messaging platforms (Feishu/Lark) with Claude Agent SDK capabilities.

### Entry Points

- **`cli-entry.ts`** - Primary entry, handles `disclaude feishu` and `disclaude --prompt`
- **`index.ts`** - Legacy entry, shows usage hint

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
                 └──────────────────────────┘
```

### Key Modules

**`src/config/`** - Static configuration from environment variables
- GLM (Zhipu AI) takes precedence over Anthropic if both configured
- `Config.getAgentConfig()` returns agent options (apiKey, model, permissionMode)

**`src/agent/client.ts`** - Wrapper around `@anthropic-ai/claude-agent-sdk`
- `queryStream()` - Returns AsyncIterable of AgentMessage
- Handles session persistence via SDK's `resume` option
- Injects environment variables for subprocess execution

**`src/feishu/bot.ts`** - WebSocket-based Feishu/Lark bot
- Message deduplication via `processedMessageIds` Set (prevents infinite loops)
- Ignores messages from bot itself (`sender.sender_type === 'app'`)
- Commands: `/reset`, `/status`, `/help`
- **Important**: Each SDK message is sent immediately (no accumulation)

**`src/feishu/session.ts`** - In-memory session storage per chatId
- `getSessionId()` / `setSessionId()` / `clearSession()`

**`src/utils/sdk.ts`** - SDK message utilities
- `extractTextFromSDKMessage()` - Extracts text from SDK messages
- `getNodeBinDir()` - Gets node binary path for subprocess PATH

### Data Flow (Feishu Mode)

```
WebSocket Event → handleMessageReceive() → Deduplication Check
      ↓
   Bot Self-Check? (skip if app)
      ↓
   Command? → handleCommand() → Send response
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

- **Bot mode**: `bypassPermissions` - Auto-approves actions
- **CLI mode**: `default` - Normal permission handling

### WebSocket Bot Gotchas

1. **Infinite loop prevention**: Bot must ignore its own messages (`sender.sender_type === 'app'`)
2. **Duplicate events**: Use `processedMessageIds` Set to deduplicate by `message_id`
3. **Session storage**: Currently in-memory; sessions lost on restart

### Build Output

- `tsup` builds to `dist/`
- `dist/cli-entry.js` is the binary entry point
- `dist/index.js` is legacy compatibility

### Testing

- Uses Vitest
- Test files: `**/*.test.ts`
- Coverage: `@vitest/coverage-v8`
