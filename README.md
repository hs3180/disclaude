# Disclaude 🤖

A multi-platform agent bot that connects to Claude Agent SDK - supporting Feishu/Lark and CLI modes. Written in TypeScript.

## Features

- 💬 Chat with AI agent via Feishu/Lark
- 🤖 Uses Claude Agent SDK with streaming responses
- 🔄 Persistent conversations (per-user sessions)
- 🎯 Easy commands for interaction
- 🌐 Support for both Anthropic Claude and GLM (Zhipu AI)
- ✅ Message deduplication to prevent duplicate responses
- 📝 Proper text formatting with newline support
- 🌐 **Browser automation** via Playwright MCP tools
- 🎨 **Rich message types** with colored output (CLI) and smart throttling (Feishu)
- 🛠️ **Extensible tool system** with MCP server support

## Supported Platforms

| Platform | Status | Commands | Usage |
|----------|--------|----------|-------|
| Feishu/Lark | ✅ | `/reset`, `/status`, `/help` | Direct message via WebSocket |
| CLI | ✅ | `--prompt "<query>"` | Command line |

## Supported Models

- **Anthropic Claude**: `claude-3-5-sonnet-20241022`, etc.
- **GLM (Zhipu AI)**: `glm-4.7`, `glm-4`, etc.

## Available Tools

### MCP (Model Context Protocol) Tools

The agent supports extensible tools through MCP servers:

**🌐 Playwright MCP** (Browser Automation)
- `browser_navigate` - Navigate to URLs
- `browser_click` - Click elements on pages
- `browser_type` - Type text into inputs
- `browser_snapshot` - Capture page structure
- `browser_take_screenshot` - Take screenshots
- `browser_evaluate` - Run JavaScript in pages
- `browser_run_code` - Execute Playwright code
- And 10+ more browser automation tools

**🔧 Built-in Tools**
- `Skill` - Execute custom skills from `.claude/skills/`
- `Bash` - Execute shell commands
- `Edit` - Edit files
- `Read` - Read files
- `Write` - Write files

### Adding Custom Tools

Create custom skills by adding files to `.claude/skills/` directory. See [Claude Code Skills documentation](https://docs.anthropic.com/en/docs/build-with-claude/claude-for-developers) for details.

## Quick Start

### 1. Setup

```bash
cd disclaude
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and configure:

```env
# Feishu/Lark
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_secret

# Claude Agent SDK (choose one)
# Option 1: Anthropic Claude
ANTHROPIC_API_KEY=your_anthropic_key
CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Option 2: GLM (Zhipu AI)
GLM_API_KEY=your_glm_key
GLM_MODEL=glm-4.7
GLM_API_BASE_URL=https://open.bigmodel.cn/api/anthropic

# Agent workspace
AGENT_WORKSPACE=./workspace
```

### 3. Run

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

**Background service with PM2 (recommended for production):**
```bash
npm run pm2:start      # Start
npm run pm2:restart    # Restart (after code changes)
npm run pm2:logs       # View logs
```

**Using the CLI:**
```bash
disclaude --prompt "your question"
```

## Platform Setup

### Feishu/Lark Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/) or [Lark Developer](https://open.larksuite.com/)
2. Create app → Get App ID & App Secret
3. Enable "Robot" → Create Bot
4. **Enable WebSocket mode**: Events and Callbacks → Mode of event/callback subscription → Select "Receive events/callbacks through persistent connection"
5. Configure events: `im.message.receive_v1`

## Usage

### Starting the Bot

```bash
# Feishu/Lark
npm run dev

# Or after build
disclaude feishu

# CLI (one-shot query)
disclaude --prompt "your question"
```

### Feishu/Lark Commands

```
/reset             - Clear conversation
/status            - Show current status
/help              - Show help
```

### CLI Mode

```bash
# Using the CLI command
disclaude --prompt "your question"

# Or via npm
npm start -- --prompt "your question"
```

## Model Configuration

### Using Anthropic Claude

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
CLAUDE_MODEL=claude-3-5-sonnet-20241022
```

### Using GLM (Zhipu AI)

```env
GLM_API_KEY=your_glm_api_key
GLM_MODEL=glm-4.7
GLM_API_BASE_URL=https://open.bigmodel.cn/api/anthropic
```

**Priority**: GLM takes precedence if both are configured.

## Project Structure

```
disclaude/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli-entry.ts          # CLI entry point
│   ├── cli/                  # CLI mode
│   ├── config/               # Configuration
│   ├── agent/                # Claude Agent SDK wrapper
│   ├── feishu/               # Feishu/Lark WebSocket bot
│   ├── types/                # TypeScript type definitions
│   └── utils/                # Utility functions
│       ├── output-adapter.ts # Output abstraction layer
│       └── sdk.ts            # SDK message parsing utilities
├── .claude/                  # Claude Code configuration
│   └── skills/               # Custom skills (optional)
├── logs/                     # PM2 log directory
├── workspace/                # Agent working directory
├── package.json              # Dependencies
├── ecosystem.config.cjs      # PM2 configuration
├── tsconfig.json             # TypeScript config
├── CLAUDE.md                 # Claude Code project guide
├── .env.example              # Environment template
└── README.md                 # This file
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Agent SDK                        │
│  (Anthropic Claude or GLM with MCP Servers)                │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │  Output Adapter Layer   │
        │  (CLI / Feishu)         │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼──────┐         ┌────────▼────────┐
│  Feishu/Lark │         │     CLI         │
│  Bot (WS)     │         │   Mode          │
│  + Throttling │         │  + Colors       │
└──────────────┘         └─────────────────┘
```

## Running as a Background Service (PM2)

For running the bot as a persistent background service with automatic restarts.

### Quick Start

```bash
# First time: build and start
npm run pm2:start

# After code changes: restart
npm run pm2:restart
```

### PM2 Commands

| Command | Description |
|---------|-------------|
| `npm run pm2:start` | Build and start the bot |
| `npm run pm2:stop` | Stop the bot |
| `npm run pm2:restart` | Restart the bot (use after code changes) |
| `npm run pm2:reload` | Zero-downtime reload (graceful restart) |
| `npm run pm2:logs` | View real-time logs |
| `npm run pm2:status` | Check bot status |
| `npm run pm2:monit` | Real-time monitoring dashboard |
| `npm run pm2:delete` | Remove bot from PM2 |

### Log Management

```bash
# View logs
npm run pm2:logs

# Clear logs
pm2 flush

# View specific log files
cat ./logs/pm2-out.log    # Standard output
cat ./logs/pm2-error.log  # Errors
```

### PM2 Configuration

Edit `ecosystem.config.cjs` to customize:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_memory_restart` | `500M` | Restart if memory exceeds this |
| `instances` | `1` | Number of instances to run |
| `error_file` | `./logs/pm2-error.log` | Error log path |
| `out_file` | `./logs/pm2-out.log` | Output log path |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | Feishu | Feishu app ID |
| `FEISHU_APP_SECRET` | Feishu | Feishu app secret |
| `ANTHROPIC_API_KEY` | Claude | Anthropic API key |
| `CLAUDE_MODEL` | Claude | Model name |
| `GLM_API_KEY` | GLM | Zhipu AI API key |
| `GLM_MODEL` | GLM | GLM model name |
| `GLM_API_BASE_URL` | GLM | GLM API endpoint |

**Note**: Workspace directory is automatically set to the current working directory.

## Troubleshooting

### Feishu/Lark Issues

**Bot doesn't start:**
- Verify App ID and App Secret
- Check bot has permissions
- Ensure events are configured

**Messages not sending:**
- Check WebSocket connection status
- Verify bot is not blocked by user
- Check PM2 logs: `npm run pm2:logs`

### Agent Issues

**Claude API errors:**
- Verify ANTHROPIC_API_KEY
- Check billing/credits
- Ensure model name is correct

**GLM API errors:**
- Verify GLM_API_KEY
- Check GLM_API_BASE_URL
- Ensure API quota

**MCP Tools not working:**
- Ensure `@playwright/mcp` is installed: `npm install`
- Check MCP server configuration in `src/agent/client.ts`
- Verify tool is in `allowedTools` list

**Permission errors:**
- Check `permissionMode` setting in agent config
- For development, use `bypassPermissions: true`
- Ensure file system permissions are correct

## Development

### Adding Commands

Edit `src/feishu/bot.ts` to add custom slash commands.

### Customizing Agent Behavior

Edit `src/agent/client.ts` to customize SDK options:
- `permissionMode`: Control permission behavior (`default`, `acceptEdits`, `bypassPermissions`, `plan`)
- `allowedTools`: Specify which tools the agent can use
- `mcpServers`: Add or configure MCP servers

### Adding Custom Skills

1. Create `.claude/skills/` directory
2. Add skill files (e.g., `my-skill.md`)
3. Skills are automatically loaded via `settingSources: ['project']`

### Output Adapters

The project uses an **Output Adapter** pattern for unified message handling:

- **CLIOutputAdapter**: Formats messages with ANSI colors for terminal
- **FeishuOutputAdapter**: Sends messages via WebSocket with smart throttling

To add a new platform:
1. Implement the `OutputAdapter` interface
2. Add platform-specific message formatting
3. Integrate with your message handler

## Milestones

- [ ] 实现聊天驱动的自我迭代
- [ ] 完成一小时的长任务（自动测试）
- [ ] 完成一天的长任务（多个 commit）
- [ ] 完成一周的长任务（人类延迟反馈）
- [ ] 与 Claude Code 解耦（工作量≈一周）

## License

MIT License - feel free to use and modify!

---

Made with ❤️ and Claude Agent SDK
