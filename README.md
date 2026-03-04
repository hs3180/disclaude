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

- **Node.js** >= 18.0.0 (>= 20.0.0 recommended for development)
- **npm** or **yarn** or **pnpm**
- **Claude CLI** (for Claude Agent SDK functionality)

> **Note**: Some transitive dependencies require Node.js >= 20. If you encounter issues with `npm install`, use Node.js 20+ or run `npm install --production=false`.

### Install Claude CLI

Claude Agent SDK requires the Claude CLI to be installed on your system. Install it with one of the following methods:

```bash
# Using npm (recommended)
npm install -g @anthropic-ai/claude-code

# Or using the official installer
curl -fsSL https://claude.ai/install.sh | sh
```

After installation, verify:

```bash
claude --version
```

## Quick Start

### Option A: Install from GitHub (Recommended for Users)

Install directly from GitHub without cloning the repository:

```bash
# Install globally from GitHub
npm install -g hs3180/disclaude

# Or using SSH
npm install -g git+ssh://git@github.com:hs3180/disclaude.git
```

After installation, you can use the `disclaude` command directly:

```bash
# Show help
disclaude --help

# Start Feishu bot
disclaude start --mode feishu
```

#### Configuration for Global Install

Create a configuration file in your working directory:

```bash
# Create config file
mkdir -p ~/.disclaude
cp ~/.disclaude/disclaude.config.example.yaml ~/.disclaude/disclaude.config.yaml
# Or download from GitHub:
curl -o ~/.disclaude/disclaude.config.yaml https://raw.githubusercontent.com/hs3180/disclaude/main/disclaude.config.example.yaml
```

Edit `~/.disclaude/disclaude.config.yaml` with your credentials.

#### Update to Latest Version

```bash
# Update to latest version
npm update -g hs3180/disclaude

# Or reinstall for a clean update
npm install -g hs3180/disclaude
```

### Option B: Clone for Development

For development or customization, clone the repository:

```bash
git clone https://github.com/hs3180/disclaude.git
cd disclaude
npm install
```

The project includes an `.npmrc` file that ensures devDependencies are installed correctly. If you still encounter issues, try:

```bash
npm install --production=false
```

### Install Claude CLI (Required)

Make sure Claude CLI is installed (see [Requirements](#requirements) for installation instructions). Without it, you'll encounter errors like:

```
Error: Claude Code process exited with code 1
```

### 3. Configure

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

### 4. Run

```bash
# Development with auto-reload
npm run dev

# Production (after build)
npm run build && npm start
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

# Communication Node (handles Feishu WebSocket connection)
disclaude start --mode comm --port 3001

# Execution Node (handles Agent tasks)
disclaude start --mode exec --communication-url http://localhost:3001
```

### REST API Testing

Use the REST API endpoint for offline testing:

```bash
# Send message via REST API
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"chatId": "test", "prompt": "hello"}'
```

### Run Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `comm` | Communication Node | Handles Feishu WebSocket, forwards tasks to Execution Node |
| `exec` | Execution Node | Handles Pilot Agent, processes tasks from Communication Node |

### Local Development

For local development, run both nodes in separate terminals:

```bash
# Terminal 1: Communication Node (handles Feishu)
disclaude start --mode comm --port 3001

# Terminal 2: Execution Node (handles Agent)
disclaude start --mode exec --communication-url http://localhost:3001
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

### REST API for Rapid Development

**Recommended approach:**

```bash
# 1. Start Communication Node
disclaude start --mode comm

# 2. Make code changes
vim src/agent/client.ts

# 3. Build and restart
npm run build && npm run pm2:restart

# 4. Test with REST API (instant feedback)
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"chatId": "test", "prompt": "Test the new feature"}'

# 5. Deploy when ready
npm run pm2:restart
```

### Mode Comparison

| Feature | REST API | Feishu Mode |
|---------|----------|-------------|
| **Startup** | ⚡ HTTP server | 🔄 Requires WebSocket connection |
| **Output** | 📺 JSON response | 💬 Chat messages (throttled) |
| **Session** | ✅ Per-chatId persistent | ✅ Persistent (in-memory) |
| **Permissions** | ✅ Auto-approves | ✅ Auto-approves |
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

This architecture enables:
- Independent scaling of Feishu handling and Agent processing
- Multiple Execution Nodes for load balancing
- Zero-downtime deployments
- Clear separation of concerns

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
