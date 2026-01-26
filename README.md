# Disclaude 🤖

A multi-platform agent bot that connects to Claude Agent SDK - supporting Discord or Feishu/Lark (one at a time). Written in TypeScript.

## Features

- 💬 Chat with AI agent via Discord or Feishu/Lark
- 🤖 Uses Claude Agent SDK with streaming responses
- 🔄 Persistent conversations (per-user sessions)
- 🎯 Easy commands for interaction
- 🌐 Support for both Anthropic Claude and GLM (Zhipu AI)

## Supported Platforms

Choose ONE platform at a time via `PLATFORM` environment variable:

| Platform | Status | Commands | Usage |
|----------|--------|----------|-------|
| Discord | ✅ | `/ask`, `/reset`, `/ping`, `/info` | `@BotName` |
| Feishu/Lark | ✅ | `/reset`, `/status`, `/help` | Direct message |
| CLI | ✅ | `--prompt "<query>"` | Command line |

## Supported Models

- **Anthropic Claude**: `claude-3-5-sonnet-20241022`, etc.
- **GLM (Zhipu AI)**: `glm-4.7`, `glm-4`, etc.

## Quick Start

### 1. Setup

```bash
cd disclaude
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and configure:

```env
# Choose platform (discord or feishu)
PLATFORM=feishu

# Discord (if PLATFORM=discord)
DISCORD_BOT_TOKEN=your_token_here

# Feishu/Lark (if PLATFORM=feishu)
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

## Platform Setup

### Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create application → Bot → Add Bot
3. Copy token to `.env`
4. **Enable "Message Content Intent"**
5. Invite bot to server via OAuth2 URL Generator

### Feishu/Lark Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/) or [Lark Developer](https://open.larksuite.com/)
2. Create app → Get App ID & App Secret
3. Enable "Robot" → Create Bot
4. **Enable WebSocket mode**: Events and Callbacks → Mode of event/callback subscription → Select "Receive events/callbacks through persistent connection"
5. Configure events: `im.message.receive_v1`

## Usage

### Starting the Bot

```bash
# Discord
PLATFORM=discord npm run dev

# Feishu/Lark
PLATFORM=feishu npm run dev

# CLI (one-shot query)
npm start -- --prompt "your question"
```

### Discord Commands

```
/ask <question>    - Ask the agent
/reset             - Clear conversation
/ping              - Check latency
/info              - Bot info
@BotName <msg>     - Direct mention
```

### Feishu/Lark Commands

```
/reset             - Clear conversation
/status            - Show current status
/help              - Show help
```

### CLI Mode

```bash
# Direct usage
npm start -- --prompt "your question"

# Or with arguments
npm start -- your question here
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
│   ├── cli/                  # CLI mode
│   ├── config/               # Configuration
│   ├── agent/                # Claude Agent SDK wrapper
│   ├── discord/              # Discord bot implementation
│   ├── feishu/               # Feishu/Lark WebSocket bot
│   ├── types/                # TypeScript type definitions
│   └── utils/                # Utility functions
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
├── .env.example              # Environment template
└── README.md                 # This file
```

## Architecture

```
┌─────────────────────────┐
│  Claude Agent SDK      │
│  (or GLM API)          │
└───────────┬───────────┘
            │
    ┌───────┴────────┐
    │                │
┌───▼────┐     ┌────▼──────┐
│ Discord│     │ Feishu/Lark│
│  Bot   │     │  Bot       │
└────────┘     └───────────┘
```

**Single Platform**: Only one platform runs at a time (set via `PLATFORM`).

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLATFORM` | Yes | `discord` or `feishu` |
| `DISCORD_BOT_TOKEN` | Discord | Discord bot token |
| `FEISHU_APP_ID` | Feishu | Feishu app ID |
| `FEISHU_APP_SECRET` | Feishu | Feishu app secret |
| `ANTHROPIC_API_KEY` | Claude | Anthropic API key |
| `CLAUDE_MODEL` | Claude | Model name |
| `GLM_API_KEY` | GLM | Zhipu AI API key |
| `GLM_MODEL` | GLM | GLM model name |
| `GLM_API_BASE_URL` | GLM | GLM API endpoint |
| `AGENT_WORKSPACE` | No | Workspace directory |

## Troubleshooting

### Discord Issues

**Bot doesn't respond:**
- Check "Message Content Intent" is enabled
- Verify bot is in the server
- Check console for errors

### Feishu/Lark Issues

**Bot doesn't start:**
- Verify App ID and App Secret
- Check bot has permissions
- Ensure events are configured

### Agent Issues

**Claude API errors:**
- Verify ANTHROPIC_API_KEY
- Check billing/credits

**GLM API errors:**
- Verify GLM_API_KEY
- Check GLM_API_BASE_URL
- Ensure API quota

## Development

### Adding Commands

**Discord**: Edit `src/discord/commands.ts` and add new command handlers.

**Feishu**: Edit `src/feishu/bot.ts` in `handleCommand` method.

### Customizing Agent Behavior

Edit `src/agent/client.ts` to customize SDK options:
- `permissionMode`: Control permission behavior (`default`, `acceptEdits`, `bypassPermissions`, `plan`)
- `systemPrompt`: Change the system prompt preset
- Adjust workspace and other settings

### CLI Mode

Run the agent directly from command line:

```bash
npm start -- --prompt "your question here"
```

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
