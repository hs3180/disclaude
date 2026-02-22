# Disclaude

[![npm version](https://badge.fury.io/js/disclaude.svg)](https://www.npmjs.com/package/disclaude)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/disclaude.svg)](https://nodejs.org)

A multi-platform AI agent bot that bridges messaging platforms (Feishu/Lark) with the Claude Agent SDK. Written in TypeScript, it enables chat-driven development, code editing, file operations, and browser automation through conversational interfaces.

## Features

- **Chat-driven development** - Read, edit, and write code through natural conversation
- **Streaming responses** - Real-time output with smart throttling for messaging platforms
- **Persistent conversations** - Per-user session management (in-memory)
- **Slash commands** - `/reset`, `/status`, `/help` for quick actions
- **Multi-model support** - Anthropic Claude or GLM (Zhipu AI)
- **Browser automation** - Playwright MCP tools for web interaction
- **Custom skills** - Extensible workflow system (`.claude/skills/`)
- **Message deduplication** - Prevents duplicate responses in WebSocket mode
- **PM2 production ready** - Background service with log management

## Version

**v0.0.1** - Initial Feishu/Lark Release

### Implementation Status

| Capability | Status |
|------------|--------|
| Code reading/editing/writing | ✅ Full support via chat |
| Bash command execution | ✅ Real-time feedback |
| File system operations | ✅ Glob, grep, read, write |
| Browser automation | ✅ Playwright MCP (15+ tools) |
| Custom skills | ✅ `implement-feature`, `deep-search` |
| Session management | ✅ In-memory per user |
| Message deduplication | ✅ WebSocket event handling |

## Requirements

- **Node.js** >= 18.0.0
- **npm** or **yarn** or **pnpm**

## Quick Start

### 1. Install

```bash
git clone <repo-url>
cd disclaude
npm install
```

### 2. Configure

Copy the example configuration file and customize it:

```bash
cp disclaude.config.example.yaml disclaude.config.yaml
```

Edit `disclaude.config.yaml` with your credentials:

```yaml
# Feishu/Lark Platform Configuration
feishu:
  appId: "your_feishu_app_id_here"
  appSecret: "your_feishu_app_secret_here"

# GLM (Zhipu AI) API Configuration
# GLM takes precedence if both GLM and Anthropic are configured
glm:
  apiKey: "your_glm_api_key_here"
  apiBaseUrl: "https://open.bigmodel.cn/api/anthropic"

# Agent/AI Configuration
agent:
  provider: "glm"          # Options: "glm" or "anthropic"
  model: "glm-5"           # Model to use
  permissionMode: "bypassPermissions"  # Auto-approve tool actions
```

For full configuration options (logging, MCP servers, etc.), see `disclaude.config.example.yaml`.

### 3. Run

```bash
# Development with auto-reload
npm run dev

# Production (after build)
npm run build && npm start

# CLI mode (quick testing without Feishu)
disclaude --prompt "your question"
```

## Platform Setup

### Feishu/Lark Bot Configuration

1. **Create App**
   - Go to [Feishu Open Platform](https://open.feishu.cn/) or [Lark Developer](https://open.larksuite.com/)
   - Create a new app → Get App ID & App Secret

2. **Enable Bot**
   - Navigate to "Robot" (机器人) in app settings
   - Enable bot capabilities

3. **Configure WebSocket** (Critical)
   - Go to **Events and Callbacks** (事件与回调)
   - **Mode** → Select "Receive events/callbacks through persistent connection" (通过长连接接收事件)
   - This enables WebSocket mode (no public server needed)

4. **Subscribe to Events**
   - Add event: `im.message.receive_v1`
   - This enables message receiving

5. **Publish Bot**
   - Add bot to a group or enable in organization
   - Test by sending a message

## Available Tools

### Built-in SDK Tools

| Category | Tools |
|----------|-------|
| **Planning** | `TodoWrite`, `Task`, `ExitPlanMode`, `AskUserQuestion` |
| **File System** | `Read`, `Write`, `Edit`, `Glob`, `Grep` |
| **Execution** | `Bash`, `KillShell`, `NotebookEdit` |
| **Code** | `LSP` (Language Server Protocol) |
| **MCP** | `ListMcpResources`, `ReadMcpResource` |

> **Note**: Web tools (`WebSearch`, `WebFetch`) are disabled by default for security. To enable, modify `allowedTools` in `src/agent/client.ts`.

### MCP Tools (Playwright)

Browser automation capabilities:
- Navigation: `browser_navigate`, `browser_navigate_back`
- Interaction: `browser_click`, `browser_type`, `browser_fill_form`
- Information: `browser_snapshot`, `browser_take_screenshot`
- Advanced: `browser_evaluate`, `browser_drag`, `browser_wait_for`

### Custom Skills

Located in `.claude/skills/<name>/SKILL.md`:

| Skill | Description |
|-------|-------------|
| **`implement-feature`** | Structured feature implementation workflow |
| **`deep-search`** | Advanced multi-stage research |

Create your own by adding a `SKILL.md` file in a new directory under `.claude/skills/`.

## Running as a Background Service (PM2)

### Important: Manual Restart Policy

**PM2 will NOT restart automatically after code changes.** You must explicitly run `npm run pm2:restart` when ready to deploy.

This prevents:
- Accidental deployment of untested code
- Disruption of active user sessions
- Surprising users with mid-conversation restarts

### Commands

```bash
npm run pm2:start    # Build and start service
npm run pm2:restart  # Restart (manual, after code changes)
npm run pm2:reload   # Zero-downtime reload
npm run pm2:stop     # Stop service
npm run pm2:logs     # View logs
npm run pm2:status   # Check status
npm run pm2:monit    # Live monitoring
npm run pm2:delete   # Remove from PM2
```

### Log Management

```bash
npm run pm2:logs            # Real-time logs (all)
pm2 logs disclaude-feishu   # Specific app logs
pm2 flush                   # Clear all logs
cat ./logs/pm2-out.log      # Standard output
cat ./logs/pm2-error.log    # Errors only
```

### Configuration

Edit `ecosystem.config.cjs`:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_memory_restart` | `500M` | Restart if memory exceeded |
| `instances` | `1` | Number of processes |

## Usage

### CLI Commands

```bash
# Show help
disclaude
disclaude --help

# Single process mode (all-in-one, default)
disclaude start
disclaude start --mode single

# Distributed mode - Communication Node (Feishu WebSocket)
disclaude start --mode comm --port 3001

# Distributed mode - Execution Node (Pilot Agent)
disclaude start --mode exec --communication-url http://localhost:3001

# CLI prompt mode (one-shot query, no Feishu needed)
disclaude --prompt "List all TypeScript files"
```

### Run Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `single` | All-in-one process | Development, small deployments |
| `comm` | Communication Node only | Distributed deployments |
| `exec` | Execution Node only | Scale agent processing independently |

### Distributed Deployment

For production, you can split the Communication and Execution nodes:

```bash
# Terminal 1: Communication Node (handles Feishu)
disclaude start --mode comm --port 3001

# Terminal 2: Execution Node (handles Agent)
disclaude start --mode exec --communication-url http://localhost:3001
```

Or configure in `disclaude.config.yaml`:

```yaml
mode: "comm"  # or "exec"

transport:
  type: "http"
  http:
    execution:
      host: "localhost"
      port: 3001
    communication:
      callbackHost: "localhost"
      callbackPort: 3002
      executionUrl: "http://localhost:3001"
```

### Feishu Commands

```
/reset   - Clear conversation history
/status  - Show current session status
/help    - Show help message
```

### Example Conversations

```
You: Read src/agent/client.ts
Bot: [Shows file content]

You: Add a new function to log errors
Bot: [Edits the file with new function]

You: Run npm run type-check
Bot: [Executes and shows results]
```

## Development Workflow

### CLI Mode for Rapid Development

**Recommended approach:**

```bash
# 1. Make code changes
vim src/agent/client.ts

# 2. Build
npm run build

# 3. Test with CLI (instant feedback)
disclaude --prompt "Test the new feature"
disclaude --prompt "Read src/agent/client.ts and summarize"

# 4. Deploy when ready
npm run pm2:restart
```

### Mode Comparison

| Feature | CLI Mode | Feishu Mode |
|---------|----------|-------------|
| **Startup** | ⚡ Instant | 🔄 Requires WebSocket connection |
| **Output** | 📺 Full colored console | 💬 Chat messages (throttled) |
| **Session** | ❌ One-shot | ✅ Persistent (in-memory) |
| **Permissions** | 🔒 Asks user | ✅ Auto-approves |
| **Best for** | 🔧 Development & testing | 🤖 Production & users |

## Project Structure

```
disclaude/
├── src/
│   ├── cli-entry.ts          # Main CLI entry point
│   ├── index.ts              # Legacy entry (usage hint)
│   ├── cli/                  # CLI mode handler
│   ├── config/               # Environment configuration
│   ├── agent/
│   │   └── client.ts         # Claude Agent SDK wrapper
│   ├── feishu/
│   │   ├── bot.ts            # WebSocket bot implementation
│   │   └── session.ts        # In-memory session storage
│   ├── types/                # TypeScript types
│   └── utils/                # Utilities (output adapter, SDK helpers)
├── .claude/skills/           # Custom skills
├── workspace/                # Agent working directory
├── logs/                     # PM2 logs
├── ecosystem.config.cjs      # PM2 configuration
├── disclaude.config.example.yaml  # Configuration template
├── CLAUDE.md                 # AI assistant guidance
└── README.md                 # This file
```

## Architecture

### Single Process Mode (default)

```
┌─────────────────────────────────────────────────────┐
│              Single Process                          │
│  ┌─────────────┐    ┌─────────────┐                 │
│  │ Communication│◄──►│  Execution  │                │
│  │    Node     │    │    Node     │                 │
│  │  (Feishu)   │    │  (Pilot)    │                 │
│  └──────┬──────┘    └──────┬──────┘                 │
│         │                  │                        │
└─────────┼──────────────────┼────────────────────────┘
          │                  │
   ┌──────▼──────┐    ┌──────▼──────┐
   │   Feishu    │    │Claude Agent │
   │  WebSocket  │    │    SDK      │
   └─────────────┘    └─────────────┘
```

### Distributed Mode

```
┌──────────────────────────┐       ┌──────────────────────────┐
│   Communication Node     │       │    Execution Node        │
│  ┌────────────────────┐  │  HTTP │  ┌────────────────────┐  │
│  │  Feishu WebSocket  │  │◄─────►│  │   Pilot Agent      │  │
│  │  + HTTP Server     │  │       │  │   + HTTP Client    │  │
│  └────────────────────┘  │       │  └────────────────────┘  │
└──────────────────────────┘       └──────────────────────────┘
         │                                    │
  ┌──────▼──────┐                     ┌──────▼──────┐
  │   Feishu    │                     │Claude Agent │
  │   Cloud     │                     │    SDK      │
  └─────────────┘                     └─────────────┘
```

This separation enables:
- Independent scaling of Feishu handling and Agent processing
- Multiple Execution Nodes for load balancing
- Zero-downtime deployments

## Troubleshooting

### Bot doesn't start

| Symptom | Solution |
|---------|----------|
| WebSocket connection fails | Verify WebSocket mode is enabled in Feishu |
| Authentication error | Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` |
| No events received | Verify `im.message.receive_v1` is subscribed |

### Claude API errors

| Symptom | Solution |
|---------|----------|
| Invalid API key | Check `glm.apiKey` or `anthropic.apiKey` in `disclaude.config.yaml` |
| Model not found | Verify model name in `disclaude.config.yaml` |
| Rate limited | Check API quota/billing |

### MCP tools not working

| Symptom | Solution |
|---------|----------|
| Tool not found | Ensure `@playwright/mcp` is installed |
| Access denied | Check tool is in `allowedTools` list in `src/agent/client.ts` |
| Browser errors | Run `npm install playwright` (if standalone) |

### PM2 issues

```bash
# Check if service is running
npm run pm2:status

# View error logs
npm run pm2:logs --err

# Restart cleanly
npm run pm2:stop && npm run pm2:start
```

## Roadmap

### Core Milestones (In Progress)

| Milestone | Status | Description |
|-----------|--------|-------------|
| **One-hour tasks** | 🔜 In Progress | Autonomous completion of tasks within ~1 hour |
| **One-day tasks** | 🔜 Planned | Multi-step tasks with multiple commits within ~1 day |
| **One-week tasks** | 🔜 Planned | Long-running tasks with delayed human feedback |
| **Decouple from Claude Agent SDK** | 🔜 Planned | Build standalone agent without SDK dependency |

### Current Status

- ✅ Feishu/Lark integration (WebSocket bot)
- ✅ MCP tool support (Playwright)
- ✅ Custom skills system
- ✅ Session management (in-memory)
- 🔜 Working toward autonomous task completion milestones

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Made with [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
