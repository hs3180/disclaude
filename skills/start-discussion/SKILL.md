---
name: start-discussion
description: "Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'."
allowed-tools: [Bash, Read, Write, Glob, send_text, send_interactive, send_card]
---

# Start Discussion — Non-blocking Discussion Initiation

Agent 识别到需要深入讨论的话题后，创建飞书讨论群、发送上下文、立即返回（不阻塞当前工作）。

**适用于**: 发起讨论、离线提问、非阻塞交互 | **不适用于**: 解散群（用 `/chat dissolve`）、PR 审查群（用 PR Scanner）

## When to Use

- Agent 在工作中发现需要与用户深入讨论的话题（用户重复指令、多步反复修正、隐式抱怨、花费较大的工作存疑等）
- Agent 需要用户输入但不想阻塞当前任务
- Agent 想要委派一个问题让用户在独立群中讨论
- 定时任务分析发现需要讨论的问题

## Single Responsibility

- ✅ Create a Feishu discussion group via `lark-cli`
- ✅ Send discussion context and instructions to the group via MCP
- ✅ Record mapping in `workspace/bot-chat-mapping.json`
- ✅ Return immediately — non-blocking by design
- ✅ Report group creation result to source chat
- ❌ DO NOT wait for user response in the discussion group
- ❌ DO NOT dissolve groups (use `/chat dissolve` or `chat-timeout` skill)
- ❌ DO NOT use IPC Channel for group operations — use `lark-cli` via Bash
- ❌ DO NOT create PR review groups (use PR Scanner skill)

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the discussion topic was identified (from `**Chat ID:** xxx` in message header)
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who triggered the discussion

## Workflow

### Step 1: Determine Discussion Topic and Context

Analyze the current conversation and determine:

1. **Topic**: A concise title for the discussion (max 64 chars for group name)
2. **Question**: The specific question or issue to discuss
3. **Background**: Relevant context — chat history excerpts, file references, error logs, etc.
4. **Participants**: Open IDs of users to include (optional — bot-only group if omitted)

### Step 2: Create Discussion Group

Use `lark-cli` to create a new Feishu group:

```bash
# Create group (bot-only or with specific users)
lark-cli im +chat-create --name "讨论: {topic}" --description "Agent 发起的讨论: {topic}"
```

If specific users need to be included:

```bash
lark-cli im +chat-create --name "讨论: {topic}" --users "ou_xxx,ou_yyy"
```

**Parse the response** to extract the new group's `chatId` (format: `oc_xxx`).

If `lark-cli` is not available, report the error and stop:

```bash
lark-cli --version || echo "ERROR: lark-cli not found in PATH"
```

### Step 3: Send Discussion Context

Use MCP messaging tools to send the discussion context to the new group.

**Recommended: Use `send_interactive`** for a structured discussion kickoff card:

```
Title: "{topic} — 讨论"
Context: "由 Agent 从群 {sourceChatId} 发起"
Question: "{the specific question}"
Options: ["开始讨论", "稍后讨论", "不需要"]
```

**Alternative: Use `send_text`** for simple text context:

Send a message to the new group's `chatId` containing:
- Discussion topic and question
- Background materials / context summary
- Instructions for the user (e.g., "请在此群中讨论以上问题")

### Step 4: Record Mapping

Append the new group to `workspace/bot-chat-mapping.json`:

```bash
# Read current mapping
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Add an entry with key `discussion-{timestamp}`:

```json
{
  "discussion-{unixTimestamp}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

Write the updated mapping atomically (write to temp file, then move):

```bash
# Write updated mapping
echo '{ ... updated JSON ... }' > workspace/bot-chat-mapping.json.tmp \
  && mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

### Step 5: Confirm and Return

Report to the **source chat** (not the discussion group) that the discussion has been initiated:

Use `send_text` or `send_interactive` to the source chat:

> 已创建讨论群「{topic}」，上下文已发送。我将继续当前工作，讨论结果稍后会处理。

**Do NOT wait for any response** — return immediately.

## lark-cli Command Reference

| Operation | Command |
|-----------|---------|
| Create group | `lark-cli im +chat-create --name "..." --description "..."` |
| Create group with users | `lark-cli im +chat-create --name "..." --users "ou_xxx,ou_yyy"` |
| Send message | `lark-cli im +messages-send --chat-id oc_xxx --text "..."` |
| Add members | `lark-cli im chat.members create --params '{"chat_id":"oc_xxx","member_id_type":"open_id","succeed_type":1}' --data '{"id_list":["ou_aaa"]}'` |
| Query members | `lark-cli im chat.members get --params '{"chat_id":"oc_xxx","member_id_type":"open_id"}'` |
| Dissolve group | `lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx` |

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report to source chat: "无法创建讨论群，lark-cli 未安装" |
| Group creation fails | Report error, do not create mapping entry |
| Mapping file write fails | Report warning (group was created, mapping is a cache) |
| MCP send fails | Retry once; if still fails, report to source chat |
| Mapping file corrupted | Rebuild from `lark-cli im chats list --as bot` |

## Design Principles

1. **Non-blocking**: Return to source chat immediately after sending context
2. **Idempotent**: Check mapping table before creating (avoid duplicates)
3. **Cache is rebuildable**: `bot-chat-mapping.json` can be reconstructed from Feishu API
4. **No IPC**: Direct `lark-cli` calls via Bash — no MCP/IPC indirection for group ops
5. **Single responsibility**: Only initiate discussions; lifecycle managed by `chat` skill

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| `chat` (`/chat dissolve`) | Use to dissolve discussion groups when done |
| `chat-timeout` | Automatic dissolution of expired inactive groups |
| `pr-scanner` | Separate system for PR review groups (purpose: `pr-review`) |
| `daily-chat-review` | May trigger `start-discussion` when repetitive issues detected |
| `daily-soul-question` | May trigger `start-discussion` for deep reflection topics |

## DO NOT

- DO NOT wait for user response in the discussion group — this is non-blocking
- DO NOT create MCP tools for group operations — use `lark-cli` via Bash
- DO NOT store discussion state in a separate mechanism — use `bot-chat-mapping.json`
- DO NOT auto-dissolve groups — let users or `chat-timeout` handle lifecycle
