---
name: context-offload
description: Create a side group for long-form content delivery. Keeps the main conversation clean by offloading generated content (code, configs, reports) to a dedicated Feishu group. Use when user says keywords like "发到新群聊", "单独发", "创建群聊", "offload", "side group", or when generating content too long for voice mode.
allowed-tools: [Bash]
---

# Context Offload — Side Group Creation

Create a dedicated Feishu group for delivering long-form content, keeping the main conversation clean.

## Single Responsibility

- ✅ Create a Feishu group via lark-cli
- ✅ Invite specified members to the group
- ✅ Return the new chat ID for content delivery
- ❌ DO NOT send content to the side group (use MCP tools `send_text`/`send_card` after group creation)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill if needed)
- ❌ DO NOT manage group lifecycle beyond creation
- ❌ DO NOT use IPC Channel for group operations

## When to Use

### Explicit Request
User explicitly asks to send content to a new group:
- "发到新群聊里"
- "单独拉一个群"
- "创建群聊发给我"
- "offload this to a side group"

### Voice Mode (Implicit)
When generating content that exceeds comfortable voice-mode consumption:
- Complete configuration files (multiple files)
- Long code blocks (>50 lines)
- Detailed reports or analysis
- Architecture documentation

### Decision Criteria

| Content Type | Deliver Via | Reason |
|---|---|---|
| Brief answer (<500 chars) | Main chat | Quick consumption |
| Code snippet (1-2 files) | Main chat with code block | Manageable inline |
| Multi-file output (3+ files) | **Side group** | Too long for inline |
| Voice mode + any code | **Side group** | Code is not consumable via TTS |
| User requests separate group | **Side group** | Explicit preference |

## Execution Flow

```
1. Agent determines content should go to a side group
2. Agent calls this skill to create the group
3. Skill creates group via lark-cli and returns chat ID
4. Agent sends content to new group via send_text / send_card MCP tools
5. Agent replies in main chat with brief summary + group name
```

### Complete Example

```
Agent: (determines content should be offloaded)
  → Calls: SIDE_GROUP_NAME="LiteLLM 配置方案" \
            SIDE_GROUP_MEMBERS="ou_developer1" \
            npx tsx skills/context-offload/create-side-group.ts

Skill output: OK: oc_abc123def456

Agent: (sends content to new group)
  → send_text to oc_abc123def456 with full content

Agent: (replies in main chat)
  → "✅ 已创建群聊「LiteLLM 配置方案」，完整内容已发送到新群。"
```

## Usage

### Basic

```bash
SIDE_GROUP_NAME="LiteLLM 配置方案" \
SIDE_GROUP_MEMBERS='["ou_developer1"]' \
npx tsx skills/context-offload/create-side-group.ts
```

### With Description

```bash
SIDE_GROUP_NAME="API 设计文档" \
SIDE_GROUP_MEMBERS='["ou_developer1", "ou_developer2"]' \
SIDE_GROUP_DESCRIPTION="API 接口设计讨论及文档交付" \
npx tsx skills/context-offload/create-side-group.ts
```

### Dry Run (Testing)

```bash
SIDE_GROUP_NAME="Test Group" \
SIDE_GROUP_MEMBERS='["ou_test"]' \
SIDE_GROUP_SKIP_LARK=1 \
npx tsx skills/context-offload/create-side-group.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIDE_GROUP_NAME` | Yes | Group display name (max 64 chars, auto-truncated) |
| `SIDE_GROUP_MEMBERS` | Yes | JSON array of open IDs (e.g. `["ou_xxx","ou_yyy"]`) |
| `SIDE_GROUP_DESCRIPTION` | No | Group description |
| `SIDE_GROUP_SKIP_LARK` | No | Set to `1` to skip lark-cli calls (testing only) |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in message header)
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx" in message header)

Use the **Sender Open ID** as the member to invite.

## Output Format

### Success
```
OK: oc_abc123def456
```
The `oc_` prefixed string is the new group's chat ID. Use this with MCP tools to send content.

### Failure
```
ERROR: Failed to create group: <error details>
```

## Architecture

Group creation uses **lark-cli** to call Feishu API directly — NOT through IPC Channel. This follows the same pattern as:
- `chats-activation.ts` (group creation via lark-cli)
- `rename-group.ts` (group rename via lark-cli)
- `chat-timeout.ts` (group dissolution via lark-cli)

## Safety Guarantees

- **Input validation**: Group name must be non-empty with safe characters; members must be `ou_xxx` format
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **Idempotent**: Creating a group with the same name creates a new group (Feishu allows duplicate names)
- **No IPC**: Direct lark-cli call, no primary node message passing
- **Timeout**: lark-cli calls have a 30-second timeout to prevent hanging

## Content Delivery Best Practices

After group creation, use MCP tools to send content:

| Content Type | Recommended Tool | Notes |
|---|---|---|
| Plain text / Markdown | `send_text` | Good for code blocks |
| Rich card with sections | `send_card` | Better for structured docs |
| File attachment | `send_file` | For actual files |

### Splitting Long Content

If content exceeds Feishu message limits (~4000 chars):
1. Split into multiple `send_text` calls
2. Group by topic (e.g., one message per file)
3. Use `send_card` for structured sections

## Related Components

| Component | Role |
|-----------|------|
| `chat` skill | Temporary chat lifecycle (pending → active → expired) |
| `chats-activation` schedule | Activates pending temporary chats |
| `chat-timeout` skill | Expires and dissolves temporary chats |
| `rename-group` skill | Renames existing groups |
| **This skill** | Creates side groups for content offloading |
