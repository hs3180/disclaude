---
name: context-offload
description: Context Offloading - Auto-create side group for long-form content delivery. Detects when generated content is too long for the main chat (especially voice mode) and creates a dedicated side group. Use when user says "发到新群聊", "单独发", "创建群聊", "context offload", "side group", or when content exceeds threshold.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Context Offload

Automatically create a side group for long-form content delivery, keeping the main conversation clean.

## When to Offload

Offload content to a side group when **any** of these conditions are met:

| Condition | Threshold | Example |
|-----------|-----------|---------|
| Explicit request | User says "新群聊", "单独发", "side group" | "把配置发到新群聊里" |
| Content length | Generated content > 2000 chars | Full config files, architecture docs |
| Voice mode | Any long-form content in voice mode | Code blocks, tables, reports |
| Multiple files | 3+ code files or structured content | Multi-file project scaffolding |

## How It Works

```
Main Chat                          Side Group
─────────                          ──────────
User: "生成 LiteLLM 配置"     ──>  Bot creates group
Bot: "✅ 已创建群聊"               Bot sends full content
       [summary + link]            (code, configs, docs)
```

## Execution Steps

### Step 1: Create Side Group

```bash
OFFLOAD_PARENT_CHAT_ID="oc_current_chat_id" \
OFFLOAD_NAME="LiteLLM 配置方案" \
OFFLOAD_MEMBERS='["ou_user1"]' \
OFFLOAD_CONTENT_SUMMARY="3 files: custom_callbacks.py, config.yaml, .env" \
npx tsx skills/context-offload/create-side-group.ts
```

This creates a pending chat file. The `chats-activation` schedule will automatically create the group via lark-cli.

### Step 2: Reply in Main Chat

After creating the side group, reply in the **main chat** with a brief summary:

```
✅ 已创建群聊「{name}」并拉你入群，完整内容已发送。

📋 内容概览:
{content_summary}

请在新群聊中查看完整内容。
```

### Step 3: Wait for Activation and Send Content

The side group will be activated by the `chats-activation` schedule (typically within 1-2 minutes). Once activated, use `send_text` or `send_card` MCP tools to send the full content to the side group chat.

**Content Formatting Guidelines for Side Group:**
- Use `send_card` for well-structured content (code blocks, tables, headers)
- Split very long content into multiple messages (one per file/section)
- Include file names as headers for each code block
- Use `send_text` for plain text content

### Step 4: Register for Lifecycle Management

After sending content, register the side group for automatic cleanup:

```json
{
  "chatId": "oc_side_group_id",
  "expiresAt": "2026-04-22T10:00:00Z",
  "creatorChatId": "oc_parent_chat_id",
  "context": { "type": "context-offload", "parentChatId": "oc_parent_chat_id" }
}
```

Use the `register_temp_chat` MCP tool for this.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

Use the Chat ID as `OFFLOAD_PARENT_CHAT_ID` and the Sender Open ID in `OFFLOAD_MEMBERS`.

## Example Scenarios

### Scenario 1: Explicit Request

```
User: "生成 LiteLLM 配置方案，发到新群聊里"

1. Create side group:
   OFFLOAD_PARENT_CHAT_ID="oc_xxx" \
   OFFLOAD_NAME="LiteLLM 配置方案" \
   OFFLOAD_MEMBERS='["ou_user1"]' \
   OFFLOAD_CONTENT_SUMMARY="3 files" \
   npx tsx skills/context-offload/create-side-group.ts

2. Reply in main: "✅ 已创建群聊「LiteLLM 配置方案」，完整内容已发送"

3. After activation, send full config files to side group via send_card
```

### Scenario 2: Auto-Detection (Voice Mode)

```
User (voice): "帮我写一个 Express 服务器"

Agent detects: response will contain multiple files > 2000 chars

1. Create side group (auto-triggered)
2. Reply in main: "✅ Express 服务器代码已生成，发送到新群聊「Express 服务器 - 04/20」"
3. Send code files to side group
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OFFLOAD_PARENT_CHAT_ID` | Yes | The originating chat ID |
| `OFFLOAD_NAME` | Yes | Display name for the side group |
| `OFFLOAD_MEMBERS` | Yes | JSON array of member open IDs |
| `OFFLOAD_CONTENT_SUMMARY` | No | Brief summary of content (stored in context) |
| `OFFLOAD_EXPIRES_HOURS` | No | Hours until expiry (default: 48) |

## Output

The script outputs JSON on success:

```json
{
  "ok": true,
  "chatId": "offload-1713609600000",
  "message": "Side group chat created, waiting for activation"
}
```

## Side Group Naming Convention

Auto-generate names in the format: `{topic} - {date}`

Examples:
- "LiteLLM 配置方案 - 04/20"
- "Express 服务器代码 - 04/20"
- "研究报告 - 04/20"

## DO NOT

- Do NOT send long-form content directly in the main chat when offloading
- Do NOT create side groups for short responses (< 2000 chars)
- Do NOT forget to reply in the main chat with a summary
- Do NOT create multiple side groups for the same request
- Do NOT delete chat files manually (handled by `chat-timeout` skill)

## Related

- `chat` skill — Creates/manages temporary chat lifecycle
- `chat-timeout` skill — Handles expired chat cleanup
- `chats-activation` schedule — Activates pending chats (creates groups)
- Issue #2351 — Context Offloading feature
