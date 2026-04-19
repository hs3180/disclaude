---
name: context-offload
description: Create a Feishu side group and deliver long-form content there, keeping the main conversation clean. Use when user says "发到新群聊", "单独发", "创建群聊发内容", or when content exceeds comfortable reading length (especially in voice mode). Also use when user wants code, reports, or documents delivered to a separate group. Keywords: "offload", "side group", "内容分流", "新群发送", "context offload".
allowed-tools: [Bash, Read]
---

# Context Offload

Create a Feishu side group chat and deliver long-form content there, keeping the main conversation clean.

## Single Responsibility

- ✅ Create a Feishu group via lark-cli
- ✅ Invite specified members to the group
- ✅ Send text content to the newly created group
- ✅ Return group info (chatId) for main-chat notification
- ❌ DO NOT determine what content to offload (the agent decides)
- ❌ DO NOT manage group lifecycle (handled by `chat-timeout` skill if needed)
- ❌ DO NOT use IPC Channel for group operations

## When to Offload

### Explicit Intent (User Requested)

The user explicitly asks for content to be sent to a new/separate group:
- "发到新群聊里" (send to a new group)
- "单独拉一个群" (create a separate group)
- "创建群聊发给我" (create a group and send it to me)
- "offload this to a side group"

### Implicit Intent (Agent Decision)

In **voice mode** or when the response contains:
- **Long code blocks** (>100 lines): Complete scripts, config files, multi-file outputs
- **Multiple files**: When presenting 3+ separate code/config files
- **Very long text** (>3000 chars): Detailed reports, documentation, analysis
- **Structured artifacts**: Tables, schemas, architecture docs that benefit from persistent storage

In these cases, the agent should proactively suggest offloading:
> "内容较长，是否要创建单独的群聊来发送完整内容？"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

Use the **Sender Open ID** as the member to invite to the new group.

## Usage

### Step 1: Create group and send content

```bash
OFFLOAD_GROUP_NAME="LiteLLM 配置方案 - 04/14" \
OFFLOAD_MEMBERS='["ou_sender123"]' \
OFFLOAD_CONTENT='Here is the complete configuration...' \
npx tsx skills/context-offload/context-offload.ts
```

### Step 2: Notify user in main chat

After successful execution, the script outputs a JSON result with the group chatId. Use it to notify the user:

> "✅ 已创建群聊「LiteLLM 配置方案」并拉你入群，完整内容已发送到新群聊。"

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OFFLOAD_GROUP_NAME` | Yes | Name for the new group (max 64 chars, auto-truncated) |
| `OFFLOAD_MEMBERS` | Yes | JSON array of open IDs to invite (e.g. `["ou_xxx"]`) |
| `OFFLOAD_CONTENT` | No* | Text content to send (can be multi-line) |
| `OFFLOAD_CONTENT_FILE` | No* | Path to file with content (alternative to `OFFLOAD_CONTENT`) |
| `OFFLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli calls (testing only) |

*At least one of `OFFLOAD_CONTENT` or `OFFLOAD_CONTENT_FILE` should be provided. If neither is provided, the group is created without sending any content.

## Execution Flow

```
1. Validate inputs (group name, members, content)
2. Create Feishu group via lark-cli im +chat-create
3. Parse response to get new chatId
4. If content provided:
   a. Split content into chunks if >4000 chars (Feishu message limit)
   b. Send each chunk via lark-cli api POST /open-apis/im/v1/messages
5. Output JSON result: { chatId, groupName, messageCount }
```

## Content Splitting

Feishu has a message content limit. If the content exceeds 4000 characters:
- Split at paragraph boundaries (`\n\n`) when possible
- Each chunk is sent as a separate message
- Numbered for clarity: "[1/3]", "[2/3]", "[3/3]"

## Group Naming Guidelines

- Keep concise (max 64 chars, auto-truncated)
- Include topic and date: "[Topic] - MM/DD"
- Examples:
  - "LiteLLM 配置方案 - 04/14"
  - "PR #123 Code Review - 04/15"
  - "周报分析结果 - 04/20"
  - "项目架构文档 - 04/20"

## Architecture

Group operations use **lark-cli** to call Feishu API directly — NOT through IPC Channel. This follows the same pattern as:
- `chats-activation.ts` (group creation via `lark-cli im +chat-create`)
- `chat-timeout.ts` (group dissolution via `lark-cli api DELETE`)
- `rename-group.ts` (group rename via `lark-cli api PUT`)

## Safety Guarantees

- **Input validation**: Group name must be non-empty, members must be `ou_xxx` format
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **Idempotent group creation**: Each invocation creates a new group (no deduplication needed)
- **Atomic output**: Script outputs JSON result only after all operations complete
- **Error recovery**: Partial failures (e.g., group created but message failed) are reported with details
- **No IPC**: Direct lark-cli call, no worker→primary message passing

## Related Components

| Component | Role |
|-----------|------|
| `chat` skill | Creates managed temporary chats with full lifecycle |
| `rename-group` skill | Renames existing groups |
| `chat-timeout` skill | Dissolves expired temporary groups |
| **This skill** | Creates ad-hoc side groups for content delivery |
