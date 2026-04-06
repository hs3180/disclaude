---
name: start-discussion
description: Non-blocking discussion initiator - creates Feishu group chats via lark-cli and sends discussion context. Use when agent needs to start a discussion without blocking current work, or says keywords like "发起讨论", "离线提问", "start discussion", "offline question".
allowed-tools: [send_text, send_interactive, Bash, Read, Glob, Grep, Write]
---

# Start Discussion

Start a **non-blocking** discussion by creating a Feishu group chat and sending discussion context, then returning immediately.

## Architecture

```
Agent → this Skill → Bash (lark-cli: create group) → MCP (send context) → Return
```

- **Group operations** (create / dissolve / members): via `lark-cli` (official `@larksuite/cli`) through Bash
- **Message sending**: via MCP tools (`send_text` / `send_interactive`)
- **Non-blocking**: Skill returns immediately after setup

## When to Use

**Trigger this skill when:**
- You identify a topic that needs user discussion
- Users have repeated commands, implicit complaints, or costly decisions
- A task produces results that need human review or approval
- You want to delegate a question to users without blocking current work

**Keywords**: "发起讨论", "离线提问", "start discussion", "offline question", "need user input"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Operations

### Operation 1: Start Discussion (Primary)

#### Step 1: Validate Environment

```bash
lark-cli --version
```

If `lark-cli` is not available, report the error and suggest installation:
```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

#### Step 2: Create Group Chat

Use `lark-cli` to create a new group chat:

```bash
timeout 30 lark-cli im +chat-create \
  --name "讨论: {topic_summary}" \
  --users "ou_xxx,ou_yyy" 2>/tmp/lark-cli-err
```

**Important**:
- Group name: prefix with "讨论:" for clarity, max 64 characters
- Users: comma-separated open IDs (`ou_xxxxx` format)
- Timeout: 30 seconds to prevent hanging
- Parse the chat ID from the output:

```bash
# Extract chat_id from lark-cli response
CHAT_ID=$(echo "$result" | jq -r '.data.chat_id // empty')
```

If group creation fails:
- Check the error output (`/tmp/lark-cli-err`)
- If the error indicates the user is not a valid member, report and stop
- If the error is transient, report and suggest retry

#### Step 3: Send Discussion Context

Use MCP `send_text` to send the discussion context to the new group:

```
send_text({
  chatId: "{new_chat_id}",
  text: "{discussion_context}"
})
```

For rich formatting, use `send_interactive`:

```
send_interactive({
  chatId: "{new_chat_id}",
  card: {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "讨论: {topic}", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "{context_markdown}"},
      {"tag": "hr"},
      {"tag": "note", "elements": [{"tag": "plain_text", "content": "由 Agent 发起的讨论 · 非阻塞"}]}
    ]
  }
})
```

**Context format** — include these elements:
1. **Topic**: Clear description of what needs discussion
2. **Background**: Why this topic needs attention
3. **Questions**: Specific questions for participants
4. **Expected outcome**: What action should be taken after discussion
5. **Source**: Reference to the original task/issue that triggered this discussion

#### Step 4: Record Discussion

Write a minimal record to `workspace/discussions/` for tracking:

```bash
mkdir -p workspace/discussions
```

Create a JSON file `workspace/discussions/{discussion_id}.json`:

```json
{
  "id": "{discussion_id}",
  "chatId": "oc_xxx",
  "status": "active",
  "topic": "讨论主题",
  "createdAt": "2026-04-06T12:00:00Z",
  "context": {
    "source": "描述触发讨论的原因",
    "sourceChatId": "oc_origin_chat"
  }
}
```

**Discussion ID format**: `{source}-{timestamp}` (e.g. `pr-review-1712390400`)

#### Step 5: Return Immediately

After sending the context and recording the discussion, **return immediately**. Do NOT wait for user responses. The Chat Agent running in the new group will handle the discussion independently.

Report back to the original chat:
```
> **讨论已发起**: {topic}
> **群聊 ID**: `oc_xxx`
> **状态**: 非阻塞 — 讨论将在群内独立进行
```

---

### Operation 2: Dissolve Discussion Group

When a discussion is complete or no longer needed:

```bash
timeout 30 lark-cli api DELETE "/open-apis/im/v1/chats/{chat_id}"
```

After dissolution:
1. Update the discussion record status to `dissolved`
2. Report back: `> **讨论已结束**: {topic} (群聊已解散)`

### Operation 3: Add/Remove Members

```bash
# Add members
lark-cli im chat.members create \
  --params '{"chat_id":"oc_xxx","member_id_type":"open_id","succeed_type":1}' \
  --data '{"id_list":["ou_aaa","ou_bbb"]}' --as user

# Query members
lark-cli im chat.members get \
  --params '{"chat_id":"oc_xxx","member_id_type":"open_id"}'
```

---

## Input Format

When invoked, the Skill receives parameters via the prompt:

```
/start-discussion --topic "PR #123 是否应该合并？" \
  --members "ou_developer1,ou_developer2" \
  --context "这个 PR 修改了认证模块..."
```

Or invoked directly by the Agent with:

```
发起讨论:
- 主题: {topic}
- 参与者: {member open IDs}
- 背景: {why this needs discussion}
- 期望结果: {what should happen after discussion}
```

---

## lark-cli Command Reference

| Operation | Command |
|-----------|---------|
| Create group | `lark-cli im +chat-create --name "..." --users "ou_xxx,ou_yyy"` |
| Dissolve group | `lark-cli api DELETE /open-apis/im/v1/chats/{chat_id}` |
| Add members | `lark-cli im chat.members create --params '{...}' --data '{...}' --as user` |
| Query members | `lark-cli im chat.members get --params '{"chat_id":"oc_xxx"}'` |
| Send message | `lark-cli im +messages-send --chat-id oc_xxx --text "..."` |

> **Note**: Prefer MCP tools (`send_text` / `send_interactive`) for message sending. Only use `lark-cli` for group lifecycle operations (create / dissolve / members).

---

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not installed | Report error, suggest `npm install -g @larksuite/cli` |
| Group creation fails | Check error output, report to user, suggest retry |
| Group creation times out (>30s) | Report timeout, suggest retry later |
| Invalid member ID format | Reject immediately, do not call lark-cli |
| MCP send fails | Retry once, then report error |
| Discussion record write fails | Continue anyway (non-critical) |

---

## Security

- **Member ID validation**: Always validate `ou_xxxxx` format before passing to lark-cli
- **Group name sanitization**: Only allow safe characters, max 64 chars
- **Timeout protection**: All lark-cli calls must have `timeout 30`
- **No sensitive data**: Discussion context should not contain secrets or credentials

---

## Integration

### Downstream Actions

After a discussion concludes, the Agent can:
- **Create a new Skill** based on discussion outcomes (via `skill-creator`)
- **Create a scheduled task** based on agreed-upon actions (via `schedule`)
- **Create a GitHub issue** for follow-up work
- **Modify code** based on approved changes

### Related Issues

- #1228 — Discussion focus keeping (回归初始问题)
- #1229 — Smart discussion ending (智能会话结束)
- #1912 — Remove MCP group tools (lark-cli replacement)

---

## DO NOT

- Wait for user responses in the discussion group (non-blocking)
- Send messages through lark-cli (use MCP tools instead)
- Create groups without timeout protection
- Use invalid member ID formats
- Store sensitive data in discussion records
- Block the current workflow while the discussion is ongoing
