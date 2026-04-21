---
name: context-offload
description: Context Offloading - Auto-create side group for long-form content delivery. Keeps the main conversation clean by offloading lengthy content to a dedicated side group. Use when user says keywords like "发到新群聊", "单独发", "创建群聊", "side group", "offload", "太长了发群里", or when the agent detects that generated content exceeds 2000 characters and would clutter the main chat (especially in voice mode).
allowed-tools: [Bash, Read, Write]
---

# Context Offload

Create a side group chat, deliver long-form content there, and notify the user in the main chat with a brief summary and group link.

## Single Responsibility

- ✅ Detect when content should be offloaded to a side group
- ✅ Create a side group via `lark-cli` (synchronous, no schedule wait)
- ✅ Register the side group for lifecycle management (auto-dissolution)
- ✅ Deliver content to the side group via MCP tools (`send_text`, `send_card`, `send_file`)
- ✅ Notify the user in the main chat with a brief summary + group link
- ❌ DO NOT use the `chat create` command (it creates pending chats that require schedule activation)
- ❌ DO NOT create groups for short responses (< 2000 chars)
- ❌ DO NOT offload when the user explicitly asks for in-chat delivery

## When to Use This Skill

### Explicit User Intent (Always trigger)
- User says: "发到新群聊", "单独拉一个群", "创建群聊", "单独发", "发群里"
- User says: "side group", "offload", "新群"
- User says: "太长了" + implies wanting separate delivery

### Implicit Detection (Agent discretion)
- **Long content**: Generated response exceeds ~2000 characters (code blocks, reports, configs)
- **Voice mode**: User is interacting via voice and content is unsuitable for TTS readout
- **Multi-file output**: Delivering 3+ files (configs, scripts, docs)
- **Structured artifacts**: Research reports, analysis docs, architecture docs

### Do NOT Trigger
- Short responses (< 2000 chars)
- User explicitly asks for in-chat delivery
- Content is a direct answer to a simple question
- The main chat is already a dedicated group for the topic

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Create Side Group

Use the `create-side-group.ts` script to synchronously create a group and register it for lifecycle management:

```bash
SIDE_GROUP_NAME="LiteLLM 配置方案" \
SIDE_GROUP_MEMBERS='["ou_sender_open_id"]' \
SIDE_GROUP_PARENT_CHAT_ID="oc_main_chat_id" \
SIDE_GROUP_TOPIC="LiteLLM configuration" \
npx tsx skills/context-offload/create-side-group.ts
```

**Environment Variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `SIDE_GROUP_NAME` | Yes | Group display name (max 64 chars, auto-truncated) |
| `SIDE_GROUP_MEMBERS` | Yes | JSON array of member open IDs (e.g. `["ou_xxx"]`) |
| `SIDE_GROUP_PARENT_CHAT_ID` | Yes | Parent chat ID for reference |
| `SIDE_GROUP_TOPIC` | No | Topic description stored in chat context |

**Output**: JSON with `chatId` (the new group's chat ID) and `chatFilePath`.

### Step 2: Acknowledge in Main Chat

Reply in the main chat with a brief confirmation:

```
✅ 已创建群聊「{group_name}」，内容已发送到新群。
```

Use `send_card` MCP tool to send a card with a link to the group if available.

### Step 3: Deliver Content to Side Group

Use MCP tools to send the long-form content to the **new group's chat ID**:

- **Plain text / Markdown**: Use `send_text` with `chatId` set to the new group's chat ID
- **Structured content (code blocks, tables)**: Use `send_card` with `chatId` set to the new group's chat ID
- **Files**: Use `send_file` with `chatId` set to the new group's chat ID

**Content formatting guidelines:**
- Separate each file/section into its own message for readability
- Use code blocks with language hints for code content
- Use Markdown headers and tables for structured content
- Add a brief introduction message before the content

### Step 4: Verify Delivery

Confirm that content was sent successfully. If any send fails, retry once. If still failing, notify the user in the main chat.

## Group Naming Conventions

Generate concise, descriptive group names:

| Scenario | Name Format | Example |
|----------|-------------|---------|
| Code generation | `{topic} 配置方案` | `LiteLLM 配置方案` |
| Report | `{topic} 分析报告` | `Q1 数据分析报告` |
| Research | `{topic} 研究笔记` | `MCP 协议研究笔记` |
| Multi-file | `{topic} 文件集` | `Docker 部署文件集` |
| Generic | `{topic} - {date}` | `架构设计 - 04/21` |

Keep names under 64 characters. Include date suffix for disambiguation when needed.

## Lifecycle Management

Side groups created by this skill are automatically managed:

- **Creation**: Synchronous via `lark-cli` (no schedule wait)
- **Registration**: Chat file created in `active` state in `workspace/chats/`
- **Expiration**: Default 24 hours (configurable via `SIDE_GROUP_EXPIRES_AT`)
- **Dissolution**: Handled by `chat-timeout` skill (dissolves group when expired)
- **Cleanup**: Handled by `chats-cleanup` schedule (removes old files)

## Architecture

This skill follows the same pattern as other group operations in the codebase:

| Component | Role |
|-----------|------|
| **This skill** | Detects intent + creates group + delivers content |
| `lark-cli` | Group creation API (`im +chat-create`) |
| `chat-timeout` skill | Expires active chats (dissolves groups) |
| `chats-cleanup` schedule | Cleans up orphaned lock/tmp files |
| MCP tools (`send_text`, `send_card`, `send_file`) | Content delivery |

**Key difference from `chat` skill**: The `chat` skill creates **pending** chats that require the `chats-activation` schedule (runs every 1 minute) to create groups. This skill creates groups **synchronously** for immediate content delivery, bypassing the schedule wait.

## Example: Complete Flow

### User Request
```
User: "生成 LiteLLM 配置方案，发到新群聊里"
```

### Agent Execution
```bash
# Step 1: Create side group
SIDE_GROUP_NAME="LiteLLM 配置方案" \
SIDE_GROUP_MEMBERS='["ou_abc123"]' \
SIDE_GROUP_PARENT_CHAT_ID="oc_main_chat" \
SIDE_GROUP_TOPIC="LiteLLM configuration" \
npx tsx skills/context-offload/create-side-group.ts
# Output: {"chatId":"oc_new_group","chatFilePath":"workspace/chats/side-xxx.json"}
```

```
# Step 2: Send brief confirmation in main chat
Agent replies: "✅ 已创建群聊「LiteLLM 配置方案」，内容已发送到新群。"
```

```
# Step 3: Send content to new group via MCP tools
send_text(chatId="oc_new_group", text="# LiteLLM 配置方案\n\n## custom_callbacks.py\n```python\n...")
send_text(chatId="oc_new_group", text="## config.yaml\n```yaml\n...")
send_text(chatId="oc_new_group", text="## .env\n```env\n...")
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Group creation fails | Report error to user in main chat, suggest retrying |
| Content send fails | Retry once, then notify user |
| `lark-cli` not available | Report error, content stays in main chat |
| Invalid member ID | Report validation error |
| Duplicate group name | Feishu handles this gracefully (appends suffix) |

## DO NOT

- ❌ Create groups for short content (< 2000 chars)
- ❌ Use `chat create` (creates pending chats with schedule delay)
- ❌ Send the full content to the main chat (defeats the purpose)
- ❌ Forget to set `SIDE_GROUP_PARENT_CHAT_ID` (needed for lifecycle tracking)
- ❌ Create groups without members (at least the sender must be included)
- ❌ Hardcode member IDs (always use the Sender Open ID from context)
